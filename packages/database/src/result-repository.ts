import { createHash } from "node:crypto";
import type {
  CompletedEventResultObservation,
  UnresolvedResultObservation,
} from "@find-the-edge/domain";
export class ResultValidationError extends Error {
  override readonly name = "ResultValidationError";
}
export class ResultReplayConflictError extends Error {
  override readonly name = "ResultReplayConflictError";
}
const text = (v: unknown, max = 256): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && v === v.trim();
const iso = (v: unknown): v is string =>
  text(v, 40) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareBytes(a, b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  return value;
};
export const stableResultValue = (value: unknown) =>
  JSON.stringify(canonicalize(value));
const digest = (v: unknown) =>
  createHash("sha256").update(stableResultValue(v)).digest("hex");
const stable = stableResultValue;
const withoutRetrievedAt = <T extends { readonly retrievedAt: string }>(
  value: T,
) => {
  const material: Record<string, unknown> = { ...value };
  delete material["retrievedAt"];
  return material;
};
const states = new Set(["final", "postponed", "cancelled", "no-contest"]);
const scopes = new Set(["regulation", "overtime", "extra-innings", "unknown"]);
const compareBytes = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const validDetail = (value: unknown, sportKey: string) => {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  let encoded: string;
  try {
    encoded = JSON.stringify(v["value"]);
  } catch {
    return false;
  }
  return (
    Object.keys(v).every((key) =>
      ["schemaId", "schemaVersion", "value"].includes(key),
    ) &&
    text(v["schemaId"], 128) &&
    String(v["schemaId"]).startsWith(`${sportKey}.result.`) &&
    text(v["schemaVersion"], 32) &&
    encoded !== undefined &&
    encoded.length <= 32_768
  );
};
const validRevision = (v: unknown, providerId: string) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).length === 5 &&
    Object.keys(r).every((key) =>
      [
        "providerId",
        "updatedAt",
        "authorityRank",
        "sequence",
        "token",
      ].includes(key),
    ) &&
    r["providerId"] === providerId &&
    iso(r["updatedAt"]) &&
    Number.isSafeInteger(r["authorityRank"]) &&
    Number(r["authorityRank"]) >= 0 &&
    Number(r["authorityRank"]) <= 999_999 &&
    Number.isSafeInteger(r["sequence"]) &&
    Number(r["sequence"]) >= 0 &&
    Number(r["sequence"]) <= 999_999_999_999 &&
    text(r["token"], 128) &&
    /^[\x20-\x7e]+$/.test(String(r["token"]))
  );
};
const validScores = (scores: unknown, participantKey: string) =>
  scores === undefined ||
  (Array.isArray(scores) &&
    scores.length > 0 &&
    scores.length <= 64 &&
    scores.every(
      (s) =>
        s &&
        typeof s === "object" &&
        !Array.isArray(s) &&
        Object.keys(s as Record<string, unknown>).length === 2 &&
        Object.keys(s as Record<string, unknown>).every((key) =>
          [participantKey, "score"].includes(key),
        ) &&
        text((s as Record<string, unknown>)[participantKey]) &&
        Number.isSafeInteger((s as Record<string, unknown>)["score"]) &&
        Number((s as Record<string, unknown>)["score"]) >= 0,
    ) &&
    new Set(scores.map((s) => (s as Record<string, unknown>)[participantKey]))
      .size === scores.length);
export function compareResultAuthority(
  a: CompletedEventResultObservation,
  b: CompletedEventResultObservation,
) {
  return (
    a.providerRevision.authorityRank - b.providerRevision.authorityRank ||
    Date.parse(a.providerRevision.updatedAt) -
      Date.parse(b.providerRevision.updatedAt) ||
    a.providerRevision.sequence - b.providerRevision.sequence ||
    compareBytes(a.providerRevision.token, b.providerRevision.token) ||
    Date.parse(a.providerTimestamp) - Date.parse(b.providerTimestamp) ||
    compareBytes(a.id, b.id)
  );
}
export const compareProviderAuthorityTuple = (
  a: CompletedEventResultObservation,
  b: CompletedEventResultObservation,
) =>
  a.providerRevision.authorityRank - b.providerRevision.authorityRank ||
  Date.parse(a.providerRevision.updatedAt) -
    Date.parse(b.providerRevision.updatedAt) ||
  a.providerRevision.sequence - b.providerRevision.sequence ||
  compareBytes(a.providerRevision.token, b.providerRevision.token) ||
  Date.parse(a.providerTimestamp) - Date.parse(b.providerTimestamp);
export const stableResolvedReplay = (
  value: CompletedEventResultObservation,
) => {
  const material = withoutRetrievedAt(value);
  delete material["canonicalEventVersion"];
  return stable(material);
};
export const resultAuthoritySortKey = (o: CompletedEventResultObservation) =>
  [
    String(o.providerRevision.authorityRank).padStart(6, "0"),
    o.providerRevision.updatedAt,
    String(o.providerRevision.sequence).padStart(12, "0"),
    Buffer.from(o.providerRevision.token, "utf8").toString("hex"),
    o.providerTimestamp,
    o.id,
  ].join("#");
export function normalizeCompletedResult(
  input: Omit<CompletedEventResultObservation, "id"> & { readonly id?: string },
): CompletedEventResultObservation {
  const allowed = [
    "id",
    "providerId",
    "providerEventId",
    "canonicalEventId",
    "canonicalEventVersion",
    "sportKey",
    "leagueKey",
    "state",
    "scoreScope",
    "scores",
    "detail",
    "providerRevision",
    "providerTimestamp",
    "retrievedAt",
    "sourceProvenance",
  ];
  if (!Object.keys(input).every((key) => allowed.includes(key)))
    throw new ResultValidationError("result-observation-fields-invalid");
  for (const v of [
    input.providerId,
    input.providerEventId,
    input.canonicalEventId,
    input.sportKey,
    input.leagueKey,
    input.sourceProvenance,
  ])
    if (!text(v)) throw new ResultValidationError("result-identity-invalid");
  if (
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1
  )
    throw new ResultValidationError("result-version-invalid");
  if (
    !iso(input.providerTimestamp) ||
    !iso(input.retrievedAt) ||
    !iso(input.providerRevision.updatedAt) ||
    Date.parse(input.providerTimestamp) > Date.parse(input.retrievedAt) ||
    Date.parse(input.providerRevision.updatedAt) > Date.parse(input.retrievedAt)
  )
    throw new ResultValidationError("result-timestamp-invalid");
  if (!validRevision(input.providerRevision, input.providerId))
    throw new ResultValidationError("result-revision-invalid");
  if (
    !states.has(input.state) ||
    !scopes.has(input.scoreScope) ||
    (input.state !== "final" && input.scoreScope !== "unknown") ||
    (input.state === "final"
      ? !input.scores?.length
      : input.scores !== undefined) ||
    !validScores(input.scores, "participantId") ||
    !validDetail(input.detail, input.sportKey)
  )
    throw new ResultValidationError("result-score-state-contradiction");
  const scores = input.scores
    ? [...input.scores].sort((a, b) =>
        compareBytes(String(a.participantId), String(b.participantId)),
      )
    : undefined;
  if (
    scores &&
    new Set(scores.map((s) => s.participantId)).size !== scores.length
  )
    throw new ResultValidationError("result-participant-duplicate");
  const material = [
    input.providerId,
    input.providerEventId,
    input.canonicalEventId,
    input.state,
    input.scoreScope,
    scores ?? null,
    input.detail ?? null,
    input.providerRevision,
    input.providerTimestamp,
    input.sourceProvenance,
  ];
  const id = `result:${digest(material)}`;
  if (input.id !== undefined && input.id !== id)
    throw new ResultValidationError("result-id-invalid");
  return { ...input, ...(scores ? { scores } : {}), id };
}
export function normalizeUnresolvedResult(
  input: Omit<UnresolvedResultObservation, "id"> & { readonly id?: string },
): UnresolvedResultObservation {
  const allowed = [
    "id",
    "providerId",
    "providerEventId",
    "sportKey",
    "leagueKey",
    "state",
    "scoreScope",
    "scores",
    "detail",
    "providerRevision",
    "providerTimestamp",
    "retrievedAt",
    "sourceProvenance",
    "reason",
  ];
  if (!Object.keys(input).every((key) => allowed.includes(key)))
    throw new ResultValidationError("unresolved-result-fields-invalid");
  for (const v of [
    input.providerId,
    input.providerEventId,
    input.sportKey,
    input.leagueKey,
  ])
    if (!text(v))
      throw new ResultValidationError("unresolved-result-identity-invalid");
  if (
    !states.has(input.state) ||
    !scopes.has(input.scoreScope) ||
    (input.state !== "final" && input.scoreScope !== "unknown") ||
    !iso(input.providerTimestamp) ||
    !iso(input.retrievedAt) ||
    Date.parse(input.providerTimestamp) > Date.parse(input.retrievedAt) ||
    !validRevision(input.providerRevision, input.providerId) ||
    Date.parse(input.providerRevision.updatedAt) >
      Date.parse(input.retrievedAt) ||
    (input.state === "final"
      ? !input.scores?.length
      : input.scores !== undefined) ||
    !validScores(input.scores, "providerParticipantId") ||
    !validDetail(input.detail, input.sportKey) ||
    !text(input.sourceProvenance) ||
    !["event-unmapped", "scope-mismatch"].includes(input.reason)
  )
    throw new ResultValidationError("unresolved-result-invalid");
  const scores = input.scores
    ? [...input.scores].sort((a, b) =>
        compareBytes(a.providerParticipantId, b.providerParticipantId),
      )
    : undefined;
  const { id: suppliedId, ...withoutId } = input;
  const material = { ...withoutId, ...(scores ? { scores } : {}) };
  const id = `unresolved-result:${digest(withoutRetrievedAt(material))}`;
  if (suppliedId && suppliedId !== id)
    throw new ResultValidationError("unresolved-result-id-invalid");
  return { ...material, id };
}
export interface ResultPersistOutcome {
  readonly history: "inserted" | "duplicate";
  readonly current: "finalized" | "corrected" | "stale";
  readonly observation: CompletedEventResultObservation;
}
export interface ResultPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
export interface ResultRunRecord {
  readonly id: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly status: "succeeded" | "continuation" | "failed";
  readonly counters: Readonly<object>;
  readonly failureCode?: string;
  readonly updatedAt: string;
}
export interface ResultRepository {
  persist(
    input: Omit<CompletedEventResultObservation, "id"> & {
      readonly id?: string;
    },
  ): Promise<ResultPersistOutcome>;
  current(
    canonicalEventId: string,
  ): Promise<CompletedEventResultObservation | null>;
  exact(
    canonicalEventId: string,
    resultObservationId: string,
  ): Promise<CompletedEventResultObservation | null>;
  historyPage(
    canonicalEventId: string,
    limit: number,
    cursor?: string,
  ): Promise<ResultPage<CompletedEventResultObservation>>;
  persistUnresolved(
    input: Omit<UnresolvedResultObservation, "id"> & { readonly id?: string },
  ): Promise<UnresolvedResultObservation>;
  unresolvedPage(
    providerId: string,
    limit: number,
    cursor?: string,
  ): Promise<ResultPage<UnresolvedResultObservation>>;
  checkpoint(key: string): Promise<string | undefined>;
  saveCheckpoint(key: string, cursor?: string): Promise<void>;
  saveRun(run: ResultRunRecord): Promise<void>;
}
export const validateResultPageRequest = (
  limit: number,
  kind: "history" | "unresolved",
  identity: string,
  cursor?: string,
): string | undefined => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ResultValidationError("result-page-limit-invalid");
  if (cursor === undefined) return undefined;
  if (!text(cursor, 2048) || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new ResultValidationError("result-page-cursor-invalid");
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    const record = parsed as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 4 ||
      record["v"] !== 1 ||
      record["kind"] !== kind ||
      record["identity"] !== identity ||
      !text(record["k"], 1024)
    )
      throw new Error();
    return record["k"];
  } catch {
    throw new ResultValidationError("result-page-cursor-invalid");
  }
};
export const resultPageCursor = (
  kind: "history" | "unresolved",
  identity: string,
  key: string,
) =>
  Buffer.from(JSON.stringify({ v: 1, kind, identity, k: key })).toString(
    "base64url",
  );
const page = <T>(
  values: readonly T[],
  limit: number,
  kind: "history" | "unresolved",
  identity: string,
  keyOf: (value: T) => string,
  cursor?: string,
): ResultPage<T> => {
  const decoded = validateResultPageRequest(limit, kind, identity, cursor);
  const offset =
    decoded === undefined
      ? 0
      : values.findIndex((value) => compareBytes(keyOf(value), decoded) > 0);
  const start = offset < 0 ? values.length : offset;
  const items = values.slice(start, start + limit);
  return {
    items,
    ...(start + items.length < values.length && items.length
      ? {
          nextCursor: resultPageCursor(
            kind,
            identity,
            keyOf(items[items.length - 1]!),
          ),
        }
      : {}),
  };
};
export class MemoryResultRepository implements ResultRepository {
  readonly #history = new Map<string, CompletedEventResultObservation>();
  readonly #current = new Map<string, CompletedEventResultObservation>();
  readonly #unresolved = new Map<string, UnresolvedResultObservation>();
  readonly #checkpoints = new Map<string, string>();
  readonly runs: ResultRunRecord[] = [];
  async persist(
    input: Omit<CompletedEventResultObservation, "id"> & {
      readonly id?: string;
    },
  ) {
    await Promise.resolve();
    const o = normalizeCompletedResult(input),
      existing = this.#history.get(o.id);
    if (existing && stableResolvedReplay(existing) !== stableResolvedReplay(o))
      throw new ResultReplayConflictError("result-replay-conflict");
    const observation = existing ?? o;
    const current = this.#current.get(o.canonicalEventId);
    if (
      current &&
      compareProviderAuthorityTuple(observation, current) === 0 &&
      current.id !== observation.id
    )
      throw new ResultReplayConflictError("result-authority-conflict");
    const advance =
      !current || compareResultAuthority(observation, current) > 0;
    if (!existing) this.#history.set(o.id, structuredClone(o));
    if (advance)
      this.#current.set(o.canonicalEventId, structuredClone(observation));
    return {
      history: existing ? ("duplicate" as const) : ("inserted" as const),
      current: advance
        ? current
          ? ("corrected" as const)
          : ("finalized" as const)
        : ("stale" as const),
      observation: structuredClone(observation),
    };
  }
  current(eventId: string) {
    const v = this.#current.get(eventId);
    return Promise.resolve(v ? structuredClone(v) : null);
  }
  exact(eventId: string, resultObservationId: string) {
    if (!/^result:[a-f0-9]{64}$/.test(resultObservationId))
      return Promise.reject(new ResultValidationError("result-id-invalid"));
    const value = this.#history.get(resultObservationId);
    return Promise.resolve(
      value?.canonicalEventId === eventId ? structuredClone(value) : null,
    );
  }
  async historyPage(eventId: string, limit: number, cursor?: string) {
    await Promise.resolve();
    return page(
      [...this.#history.values()]
        .filter((v) => v.canonicalEventId === eventId)
        .sort(compareResultAuthority),
      limit,
      "history",
      eventId,
      resultAuthoritySortKey,
      cursor,
    );
  }
  async persistUnresolved(
    input: Omit<UnresolvedResultObservation, "id"> & { readonly id?: string },
  ) {
    await Promise.resolve();
    const v = normalizeUnresolvedResult(input),
      existing = this.#unresolved.get(v.id);
    if (
      existing &&
      stable(withoutRetrievedAt(existing)) !== stable(withoutRetrievedAt(v))
    )
      throw new ResultReplayConflictError("unresolved-result-replay-conflict");
    if (!existing) this.#unresolved.set(v.id, structuredClone(v));
    return structuredClone(existing ?? v);
  }
  async unresolvedPage(providerId: string, limit: number, cursor?: string) {
    await Promise.resolve();
    return page(
      [...this.#unresolved.values()]
        .filter((v) => v.providerId === providerId)
        .sort((a, b) => compareBytes(a.id, b.id)),
      limit,
      "unresolved",
      providerId,
      (value) => value.id,
      cursor,
    );
  }
  checkpoint(key: string) {
    return Promise.resolve(this.#checkpoints.get(key));
  }
  saveCheckpoint(key: string, cursor?: string) {
    if (cursor === undefined) this.#checkpoints.delete(key);
    else this.#checkpoints.set(key, cursor);
    return Promise.resolve();
  }
  saveRun(run: ResultRunRecord) {
    this.runs.push(structuredClone(run));
    return Promise.resolve();
  }
}
