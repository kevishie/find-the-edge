import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { EventDisplayDto, EventStatus } from "@find-the-edge/domain";
import { EventCursorError, EventInputError } from "./event-errors";
import {
  EVENT_STATUSES,
  assertIdentifier,
  leaguePartition,
  sportPartition,
} from "./event-read-projection";
export interface EventListFilter {
  readonly sportKey: string;
  readonly leagueKey?: string;
  /** "all" merges every lifecycle server-side; it has no physical partition. */
  readonly status: EventStatus | "all";
  readonly day: string;
}
export interface EventPage {
  readonly items: readonly EventDisplayDto[];
  readonly nextCursor: string | null;
  readonly projectionState: "ready" | "uninitialized";
  readonly evaluationState: "complete" | "partial";
  readonly hasMoreUnknown: boolean;
  readonly snapshotAt: string | null;
  readonly freshness: string | null;
  readonly unavailableReason: "projection-uninitialized" | null;
}
export interface EventDetailResult {
  readonly projectionState: "ready" | "uninitialized";
  readonly item: EventDisplayDto | null;
  readonly unavailableReason: "projection-uninitialized" | null;
}
export interface EventRepository {
  list(
    filter: EventListFilter,
    limit: number,
    cursor?: string,
  ): Promise<EventPage>;
  detail(eventId: string): Promise<EventDetailResult>;
}
export interface CursorSecret {
  readonly id: string;
  readonly secret: Uint8Array;
}
export interface CursorSecretRing {
  readonly current: CursorSecret;
  readonly previous?: CursorSecret & { readonly acceptUntil: string };
}
interface CursorPayload {
  readonly v: 1;
  readonly keyId: string;
  readonly pk: string;
  readonly lastSk: string;
  readonly issuedAt: string;
  readonly asOf: string;
  readonly exp: string;
}
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
export const filterPartition = (filter: EventListFilter): string => {
  try {
    assertIdentifier(filter.sportKey, "sport");
    if (filter.leagueKey) assertIdentifier(filter.leagueKey, "league");
  } catch {
    throw new EventInputError("invalid-event-filter");
  }
  if (
    !EVENT_STATUSES.includes(filter.status as EventStatus) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(filter.day)
  )
    throw new EventInputError("invalid-event-filter");
  const [year, month, day] = filter.day.split("-").map(Number) as [
      number,
      number,
      number,
    ],
    calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    throw new EventInputError("invalid-event-filter");
  // "all" is rejected above: the includes() check only passes real statuses.
  const status = filter.status as EventStatus;
  return filter.leagueKey
    ? leaguePartition(filter.sportKey, filter.leagueKey, status, filter.day)
    : sportPartition(filter.sportKey, status, filter.day);
};
const canonicalB64 = (value: string): Buffer => {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new EventCursorError("invalid-cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value)
    throw new EventCursorError("invalid-cursor");
  return bytes;
};
const key = (secret: Uint8Array) =>
  createHash("sha256").update("fte:event-cursor:v1").update(secret).digest();
export const validateSecretRing = (ring: CursorSecretRing): void => {
  const validate = (secret: CursorSecret): void => {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(secret.id) ||
      secret.secret.byteLength !== 32
    )
      throw new Error("invalid-cursor-secret");
  };
  validate(ring.current);
  if (ring.previous) {
    validate(ring.previous);
    if (
      ring.previous.id === ring.current.id ||
      new Date(ring.previous.acceptUntil).toISOString() !==
        ring.previous.acceptUntil
    )
      throw new Error("invalid-cursor-secret-ring");
  }
};
export class EventCursorCodec {
  constructor(
    readonly ring: CursorSecretRing,
    readonly maxTtlMs = 900_000,
    readonly skewMs = 30_000,
  ) {
    this.ring = ring;
    this.maxTtlMs = maxTtlMs;
    this.skewMs = skewMs;
    validateSecretRing(ring);
  }
  encode(pk: string, lastSk: string, asOf: string, now = new Date()): string {
    const payload = {
      v: 1,
      keyId: this.ring.current.id,
      pk,
      lastSk,
      issuedAt: now.toISOString(),
      asOf,
      exp: new Date(now.valueOf() + this.maxTtlMs).toISOString(),
    };
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key(this.ring.current.secret), iv);
    cipher.setAAD(Buffer.from("fte:event-cursor:v1"));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(payload)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }
  decode(token: string, expectedPk: string, now = new Date()): CursorPayload {
    if (!token || token.length > 4096)
      throw new EventCursorError("invalid-cursor");
    const packed = canonicalB64(token);
    if (packed.length < 29) throw new EventCursorError("invalid-cursor");
    for (const candidate of [this.ring.current, this.ring.previous].filter(
      (
        item,
      ): item is
        CursorSecret | (CursorSecret & { readonly acceptUntil: string }) =>
        !!item &&
        (!("acceptUntil" in item) ||
          (typeof item.acceptUntil === "string" &&
            Date.parse(item.acceptUntil) > now.valueOf())),
    ))
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key(candidate.secret),
          packed.subarray(0, 12),
        );
        decipher.setAAD(Buffer.from("fte:event-cursor:v1"));
        decipher.setAuthTag(packed.subarray(12, 28));
        const decoded: unknown = JSON.parse(
          Buffer.concat([
            decipher.update(packed.subarray(28)),
            decipher.final(),
          ]).toString(),
        );
        if (
          !decoded ||
          typeof decoded !== "object" ||
          Array.isArray(decoded) ||
          !exact(decoded, [
            "v",
            "keyId",
            "pk",
            "lastSk",
            "issuedAt",
            "asOf",
            "exp",
          ]) ||
          !("v" in decoded) ||
          decoded.v !== 1 ||
          !("keyId" in decoded) ||
          decoded.keyId !== candidate.id ||
          !("pk" in decoded) ||
          decoded.pk !== expectedPk ||
          !("lastSk" in decoded) ||
          typeof decoded.lastSk !== "string"
        )
          throw new EventCursorError("invalid-cursor");
        const payload = decoded as unknown as CursorPayload;
        const issued = Date.parse(String(payload["issuedAt"])),
          snapshot = Date.parse(String(payload["asOf"])),
          exp = Date.parse(String(payload["exp"])),
          current = now.valueOf();
        if (
          ![issued, snapshot, exp].every(Number.isFinite) ||
          new Date(issued).toISOString() !== payload["issuedAt"] ||
          new Date(snapshot).toISOString() !== payload["asOf"] ||
          new Date(exp).toISOString() !== payload["exp"] ||
          issued > current + this.skewMs ||
          snapshot > issued + this.skewMs ||
          exp <= issued ||
          exp - issued > this.maxTtlMs ||
          exp <= current
        )
          throw new EventCursorError("invalid-cursor");
        return payload;
      } catch (error) {
        if (error instanceof EventCursorError) throw error;
      }
    throw new EventCursorError("invalid-cursor");
  }
}
const secretCache = new Map<
  string,
  { loadedAt: number; promise: Promise<CursorSecretRing> }
>();
export const loadCursorSecretRingCached = async (
  cacheKey: string,
  loader: () => Promise<CursorSecretRing>,
  now = Date.now(),
  refreshMs = 60_000,
): Promise<CursorSecretRing> => {
  const cached = secretCache.get(cacheKey);
  if (cached && now - cached.loadedAt < refreshMs) return cached.promise;
  const promise = loader().then((ring) => {
    validateSecretRing(ring);
    return ring;
  });
  secretCache.set(cacheKey, { loadedAt: now, promise });
  void promise.catch(() => {
    if (secretCache.get(cacheKey)?.promise === promise)
      secretCache.delete(cacheKey);
  });
  return promise;
};
