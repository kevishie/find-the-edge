import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

export const PROVIDER_LANDING_SCHEMA_VERSION = "provider-landing-v1" as const;
export const PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION =
  "provider-landing-checkpoint-v1" as const;
export const PROVIDER_LANDING_POSITION_CLAIM_SCHEMA_VERSION =
  "provider-landing-position-claim-v1" as const;

export type ProviderLandingRecordType =
  "catalog-sport" | "catalog-league" | "event" | "odds" | "quarantine";
export type ProviderLandingSlot = 0 | 1;

export interface ProviderLandingRecord {
  readonly schemaVersion: typeof PROVIDER_LANDING_SCHEMA_VERSION;
  readonly providerId: "sharpapi";
  readonly recordType: ProviderLandingRecordType;
  readonly recordId: string;
  readonly sport?: string;
  readonly endpoint?: "sports" | "leagues" | "events" | "odds";
  readonly sweepId: string;
  readonly slot: ProviderLandingSlot;
  readonly pageNumber: number;
  readonly retrievedAt: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export type ProviderLandingStream = "catalog" | "events" | "odds";
export type ProviderLandingPauseScope = "account" | "stream";

export interface ProviderLandingCounts {
  readonly pages: number;
  readonly sourceRows: number;
  readonly landedRows: number;
  readonly quarantinedRows: number;
  readonly warningRows?: number;
}

/** A frozen SharpAPI Events request partition. Every request is scoped by the
 * provider's canonical sport ID; large sports are additionally narrowed by
 * exact league slugs from the reference catalog. */
export interface ProviderLandingEventPartition {
  readonly sport: string;
  readonly leagues?: readonly string[];
}

export interface ProviderLandingCheckpoint {
  readonly schemaVersion: typeof PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION;
  readonly providerId: "sharpapi";
  readonly stream: ProviderLandingStream;
  readonly version: number;
  readonly status: "running" | "complete";
  readonly sweepId: string;
  readonly slot: ProviderLandingSlot;
  readonly position:
    | { readonly offset: number }
    | { readonly partition: number; readonly offset: number }
    | { readonly cursor: string }
    | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly counts: ProviderLandingCounts;
  readonly providerTotal?: number;
  readonly providerUpdatedAt?: string;
  /** Frozen, catalog-derived SharpAPI sport/league filters. */
  readonly eventPartitions?: readonly ProviderLandingEventPartition[];
  /** Rows committed inside the currently active event partition. */
  readonly eventPartitionSourceRows?: number;
  readonly visitedPositionHashes?: readonly string[];
  readonly resumeAfter?: string;
  readonly pauseScope?: ProviderLandingPauseScope;
  readonly pendingPage?: {
    readonly positionHash: string;
    readonly pageHash: string;
  };
  readonly lastCompletedSlot?: ProviderLandingSlot;
  readonly lastCompletedSweepId?: string;
  readonly lastCompletedAt?: string;
  readonly lastCompletedCounts?: ProviderLandingCounts;
}

export interface ProviderLandingPositionClaim {
  readonly stream: Extract<ProviderLandingStream, "events" | "odds">;
  readonly sweepId: string;
  readonly slot: ProviderLandingSlot;
  readonly positionHash: string;
  readonly pageNumber: number;
  readonly claimedAt: string;
}

export type ProviderLandingPositionClaimResult = "claimed" | "replay" | "cycle";

export interface ProviderLandingPositionClaimStore {
  claimPosition(
    claim: ProviderLandingPositionClaim,
  ): Promise<ProviderLandingPositionClaimResult>;
}

export interface ProviderLandingPutRecordsResult {
  readonly crossPageDuplicateCount: number;
  readonly crossPageDuplicateRecordIds: readonly string[];
}

export interface ProviderLandingRepositoryOptions {
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
}

export const isProviderLandingRecordCurrent = (
  record: Pick<
    ProviderLandingRecord,
    "providerId" | "recordType" | "sweepId" | "slot"
  >,
  checkpoint: ProviderLandingCheckpoint | null,
) => {
  if (
    !checkpoint ||
    record.providerId !== "sharpapi" ||
    checkpoint.providerId !== record.providerId ||
    !validSlot(record.slot) ||
    !validSlot(checkpoint.slot) ||
    (checkpoint.status !== "running" && checkpoint.status !== "complete") ||
    !checkpoint.lastCompletedAt ||
    !checkpoint.lastCompletedCounts ||
    (checkpoint.status === "complete" &&
      (checkpoint.position !== null ||
        checkpoint.lastCompletedSweepId !== checkpoint.sweepId ||
        checkpoint.lastCompletedSlot !== checkpoint.slot)) ||
    (checkpoint.status === "running" &&
      (checkpoint.lastCompletedSweepId === checkpoint.sweepId ||
        checkpoint.lastCompletedSlot === checkpoint.slot))
  )
    return false;
  const currentSweepId =
    checkpoint.status === "complete"
      ? checkpoint.sweepId
      : checkpoint.lastCompletedSweepId;
  const currentSlot =
    checkpoint.status === "complete"
      ? checkpoint.slot
      : checkpoint.lastCompletedSlot;
  if (
    !currentSweepId ||
    currentSweepId !== record.sweepId ||
    currentSlot !== record.slot
  )
    return false;
  if (
    record.recordType === "catalog-sport" ||
    record.recordType === "catalog-league"
  )
    return checkpoint.stream === "catalog";
  if (record.recordType === "event") return checkpoint.stream === "events";
  if (record.recordType === "odds") return checkpoint.stream === "odds";
  return false;
};

const DYNAMO_PARTITION_KEY_MAX_BYTES = 2_048;
const DYNAMO_SORT_KEY_MAX_BYTES = 1_024;
const QUARANTINE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SNAPSHOT_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Lifecycle timestamps may lead the repository clock only by ordinary host
 * skew. Intentional future scheduling belongs in resumeAfter and is excluded. */
export const PROVIDER_LANDING_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_BATCH_ATTEMPTS = 5;
const MAX_DUPLICATE_IDS = 100;
const BASE_BACKOFF_MS = 125;
const MAX_BACKOFF_MS = 1_000;
const MAX_RECORD_VALUE_NODES = 100_000;
const MAX_DYNAMO_DOCUMENT_DEPTH = 32;
const HEX_32 = /^[a-f0-9]{32}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const RECORD_TYPES = new Set<ProviderLandingRecordType>([
  "catalog-sport",
  "catalog-league",
  "event",
  "odds",
  "quarantine",
]);
const ENDPOINTS = new Set<NonNullable<ProviderLandingRecord["endpoint"]>>([
  "sports",
  "leagues",
  "events",
  "odds",
]);

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const canonical = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim() &&
  wellFormed(value) &&
  !CONTROL_CHARACTER.test(value);
const instant = (value: unknown): value is string => {
  if (!canonical(value, 40)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};
/** SharpAPI's snapshot generation uses up to nanosecond precision. It is a
 * comparison token, not a JavaScript clock value, so retain the exact token
 * while applying the same calendar and offset bounds as provider parsing. */
const providerGenerationInstant = (value: unknown): value is string => {
  if (!canonical(value, 48)) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] =
    match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const offsetHour = zoneHour === undefined ? 0 : Number(zoneHour);
  const offsetMinute = zoneMinute === undefined ? 0 : Number(zoneMinute);
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= daysInMonth[m - 1]! &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    Number.isFinite(Date.parse(value))
  );
};
const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value: unknown): value is number =>
  nonNegativeInteger(value) && value > 0;
const validSlot = (value: unknown): value is ProviderLandingSlot =>
  value === 0 || value === 1;

function wellFormed(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

const dynamoDocumentValueSafe = (input: unknown) => {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly exit?: boolean;
  }[] = [{ value: input, depth: 0 }];
  const active = new Set<object>();
  let visitedValues = 0;
  try {
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (entry.exit) {
        active.delete(entry.value as object);
        continue;
      }
      visitedValues += 1;
      if (
        visitedValues > MAX_RECORD_VALUE_NODES ||
        entry.depth > MAX_DYNAMO_DOCUMENT_DEPTH
      )
        return false;
      const value = entry.value;
      if (typeof value === "string") {
        if (!wellFormed(value)) return false;
        continue;
      }
      if (typeof value === "number") {
        if (
          !Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value))
        )
          return false;
        continue;
      }
      if (value === null || typeof value === "boolean") continue;
      if (typeof value === "object" && isProxy(value)) return false;
      if (!Array.isArray(value) && !plainObject(value)) return false;
      if (active.has(value)) return false;
      active.add(value);
      pending.push({ value, depth: entry.depth, exit: true });
      if (Array.isArray(value)) {
        if (value.length > MAX_RECORD_VALUE_NODES) return false;
        const keys = Reflect.ownKeys(value);
        if (
          keys.length !== value.length + 1 ||
          keys.some(
            (key) =>
              typeof key !== "string" ||
              (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
          )
        )
          return false;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !("value" in descriptor)) return false;
          pending.push({ value: descriptor.value, depth: entry.depth + 1 });
        }
        continue;
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || !wellFormed(key)))
        return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index] as string;
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !("value" in descriptor)) return false;
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return true;
};

const encoded = (value: string) => encodeURIComponent(value);

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

const boundedKey = (pk: string, sk: string) => {
  if (utf8Bytes(pk) > DYNAMO_PARTITION_KEY_MAX_BYTES)
    throw new Error("provider-landing-partition-key-too-large");
  if (utf8Bytes(sk) > DYNAMO_SORT_KEY_MAX_BYTES)
    throw new Error("provider-landing-sort-key-too-large");
  return { pk, sk };
};

const storedKeyPart = (value: unknown, maximumBytes: number) =>
  canonical(value, maximumBytes) && utf8Bytes(value) <= maximumBytes;

const shard = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 1);
};

const sweepStartedAt = (sweepId: string) => {
  const candidate = sweepId.slice(-24);
  if (!instant(candidate)) throw new Error("provider-landing-sweep-id-invalid");
  return candidate;
};

const validSweepId = (value: unknown): value is string =>
  canonical(value, 128) && instant(value.slice(-24));

const expiresAt = (retrievedAt: string, retentionSeconds: number) =>
  Math.floor(Date.parse(retrievedAt) / 1_000) + retentionSeconds;

export const providerLandingKey = (
  record: Pick<
    ProviderLandingRecord,
    | "recordType"
    | "recordId"
    | "sport"
    | "endpoint"
    | "sweepId"
    | "slot"
    | "retrievedAt"
  >,
) => {
  if (!RECORD_TYPES.has(record.recordType))
    throw new Error("provider-landing-record-type-invalid");
  if (!canonical(record.recordId, 512))
    throw new Error("provider-landing-record-id-invalid");
  if (!validSweepId(record.sweepId))
    throw new Error("provider-landing-sweep-id-invalid");
  if (!validSlot(record.slot)) throw new Error("provider-landing-slot-invalid");
  const generation = `SLOT#${record.slot}#`;
  if (record.recordType === "catalog-sport")
    return boundedKey(
      "PROVIDER_LANDING#SHARPAPI#CATALOG#SPORT",
      `${generation}SPORT#${encoded(record.recordId)}`,
    );
  if (record.recordType === "catalog-league") {
    if (!canonical(record.sport, 64))
      throw new Error("provider-landing-sport-invalid");
    return boundedKey(
      "PROVIDER_LANDING#SHARPAPI#CATALOG#LEAGUE",
      `${generation}LEAGUE#${encoded(record.sport)}#${encoded(record.recordId)}`,
    );
  }
  if (record.recordType === "event") {
    if (!canonical(record.sport, 64))
      throw new Error("provider-landing-sport-invalid");
    return boundedKey(
      `PROVIDER_LANDING#SHARPAPI#EVENT#${encoded(record.sport)}`,
      `${generation}EVENT#${encoded(record.recordId)}`,
    );
  }
  if (record.recordType === "odds") {
    if (!canonical(record.sport, 64))
      throw new Error("provider-landing-sport-invalid");
    return boundedKey(
      `PROVIDER_LANDING#SHARPAPI#ODDS#${encoded(record.sport)}#${shard(record.recordId)}`,
      `${generation}PRICE#${encoded(record.recordId)}`,
    );
  }
  if (record.recordType !== "quarantine")
    throw new Error("provider-landing-record-type-invalid");
  if (
    !record.endpoint ||
    !ENDPOINTS.has(record.endpoint) ||
    !instant(record.retrievedAt)
  )
    throw new Error("provider-landing-quarantine-invalid");
  const startedAt = sweepStartedAt(record.sweepId);
  return boundedKey(
    `PROVIDER_LANDING#SHARPAPI#QUARANTINE#${record.endpoint}#${startedAt.slice(0, 10)}#${shard(record.recordId)}`,
    `ROW#${encoded(record.recordId)}`,
  );
};

export const providerLandingCheckpointKey = (
  stream: ProviderLandingStream,
) => ({
  pk: "PROVIDER_LANDING#SHARPAPI#CONTROL",
  sk: `CHECKPOINT#${stream}`,
});

const providerLandingPositionClaimKey = (
  claim: Pick<
    ProviderLandingPositionClaim,
    "stream" | "sweepId" | "slot" | "positionHash"
  >,
) =>
  boundedKey(
    `PROVIDER_LANDING#SHARPAPI#POSITION#${claim.stream}#${shard(claim.positionHash)}`,
    `SLOT#${claim.slot}#SWEEP#${encoded(claim.sweepId)}#POSITION#${claim.positionHash}`,
  );

const validateCounts = (value: unknown): value is ProviderLandingCounts => {
  if (!plainObject(value)) return false;
  const pages = value["pages"];
  const sourceRows = value["sourceRows"];
  const landedRows = value["landedRows"];
  const quarantinedRows = value["quarantinedRows"];
  const warningRows = value["warningRows"];
  return (
    nonNegativeInteger(pages) &&
    nonNegativeInteger(sourceRows) &&
    nonNegativeInteger(landedRows) &&
    nonNegativeInteger(quarantinedRows) &&
    sourceRows === landedRows + quarantinedRows &&
    (warningRows === undefined ||
      (nonNegativeInteger(warningRows) && warningRows <= sourceRows))
  );
};

const countsEqual = (
  left: ProviderLandingCounts | undefined,
  right: ProviderLandingCounts,
) =>
  left?.pages === right.pages &&
  left.sourceRows === right.sourceRows &&
  left.landedRows === right.landedRows &&
  left.quarantinedRows === right.quarantinedRows &&
  (left.warningRows ?? 0) === (right.warningRows ?? 0);

const validPendingPage = (value: unknown) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 2 &&
  "positionHash" in value &&
  typeof value.positionHash === "string" &&
  HEX_64.test(value.positionHash) &&
  "pageHash" in value &&
  typeof value.pageHash === "string" &&
  HEX_64.test(value.pageHash);

const validateRecord = (record: ProviderLandingRecord) => {
  if (
    record.schemaVersion !== PROVIDER_LANDING_SCHEMA_VERSION ||
    record.providerId !== "sharpapi" ||
    !RECORD_TYPES.has(record.recordType) ||
    (record.endpoint !== undefined && !ENDPOINTS.has(record.endpoint)) ||
    !validSweepId(record.sweepId) ||
    !validSlot(record.slot) ||
    !positiveInteger(record.pageNumber) ||
    !instant(record.retrievedAt) ||
    !dynamoDocumentValueSafe(record.value) ||
    !plainObject(record.value)
  )
    throw new Error("provider-landing-record-invalid");
  providerLandingKey(record);
  const serialized = JSON.stringify(record.value);
  if (new TextEncoder().encode(serialized).byteLength > 300_000)
    throw new Error("provider-landing-record-too-large");
};

function validateCheckpoint(
  value: unknown,
  observedAt = Date.now(),
): asserts value is ProviderLandingCheckpoint {
  if (!plainObject(value))
    throw new Error("provider-landing-checkpoint-invalid");
  const checkpoint = value as unknown as ProviderLandingCheckpoint;
  if (
    checkpoint.schemaVersion !== PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.providerId !== "sharpapi" ||
    !["catalog", "events", "odds"].includes(checkpoint.stream) ||
    !["running", "complete"].includes(checkpoint.status) ||
    !nonNegativeInteger(checkpoint.version) ||
    !validSweepId(checkpoint.sweepId) ||
    !validSlot(checkpoint.slot) ||
    !instant(checkpoint.startedAt) ||
    !instant(checkpoint.updatedAt) ||
    !validateCounts(checkpoint.counts) ||
    (checkpoint.providerTotal !== undefined &&
      !nonNegativeInteger(checkpoint.providerTotal)) ||
    (checkpoint.providerUpdatedAt !== undefined &&
      !providerGenerationInstant(checkpoint.providerUpdatedAt)) ||
    (checkpoint.eventPartitions !== undefined &&
      !validEventPartitions(checkpoint.eventPartitions)) ||
    (checkpoint.eventPartitionSourceRows !== undefined &&
      !nonNegativeInteger(checkpoint.eventPartitionSourceRows)) ||
    (checkpoint.resumeAfter !== undefined &&
      !instant(checkpoint.resumeAfter)) ||
    (checkpoint.pauseScope !== undefined &&
      !["account", "stream"].includes(checkpoint.pauseScope)) ||
    (checkpoint.resumeAfter === undefined) !==
      (checkpoint.pauseScope === undefined) ||
    (checkpoint.visitedPositionHashes !== undefined &&
      (!Array.isArray(checkpoint.visitedPositionHashes) ||
        checkpoint.visitedPositionHashes.length > 4_096 ||
        new Set(checkpoint.visitedPositionHashes).size !==
          checkpoint.visitedPositionHashes.length ||
        checkpoint.visitedPositionHashes.some(
          (value) => typeof value !== "string" || !HEX_32.test(value),
        ))) ||
    (checkpoint.pendingPage !== undefined &&
      (checkpoint.status !== "running" ||
        !validPendingPage(checkpoint.pendingPage))) ||
    (checkpoint.lastCompletedSweepId !== undefined &&
      !validSweepId(checkpoint.lastCompletedSweepId)) ||
    (checkpoint.lastCompletedSlot !== undefined &&
      !validSlot(checkpoint.lastCompletedSlot)) ||
    (checkpoint.lastCompletedAt !== undefined &&
      !instant(checkpoint.lastCompletedAt)) ||
    (checkpoint.lastCompletedCounts !== undefined &&
      !validateCounts(checkpoint.lastCompletedCounts))
  )
    throw new Error("provider-landing-checkpoint-invalid");
  const hasLastCompletedAt = checkpoint.lastCompletedAt !== undefined;
  const hasLastCompletedCounts = checkpoint.lastCompletedCounts !== undefined;
  const hasLastCompletedSweepId = checkpoint.lastCompletedSweepId !== undefined;
  const hasLastCompletedSlot = checkpoint.lastCompletedSlot !== undefined;
  const startedAt = Date.parse(checkpoint.startedAt);
  const updatedAt = Date.parse(checkpoint.updatedAt);
  const lastCompletedAt = checkpoint.lastCompletedAt
    ? Date.parse(checkpoint.lastCompletedAt)
    : undefined;
  const latestAcceptedAt = observedAt + PROVIDER_LANDING_MAX_CLOCK_SKEW_MS;
  if (
    startedAt > updatedAt ||
    startedAt > latestAcceptedAt ||
    updatedAt > latestAcceptedAt ||
    (lastCompletedAt !== undefined && lastCompletedAt > latestAcceptedAt) ||
    (lastCompletedAt !== undefined && lastCompletedAt > updatedAt) ||
    new Set([
      hasLastCompletedSlot,
      hasLastCompletedSweepId,
      hasLastCompletedAt,
      hasLastCompletedCounts,
    ]).size !== 1 ||
    (checkpoint.status === "complete" &&
      (!hasLastCompletedSweepId ||
        checkpoint.lastCompletedSweepId !== checkpoint.sweepId ||
        checkpoint.lastCompletedSlot !== checkpoint.slot ||
        checkpoint.lastCompletedAt !== checkpoint.updatedAt ||
        !countsEqual(checkpoint.lastCompletedCounts, checkpoint.counts))) ||
    (checkpoint.status === "running" &&
      hasLastCompletedSweepId &&
      (checkpoint.lastCompletedSweepId === checkpoint.sweepId ||
        checkpoint.lastCompletedSlot === checkpoint.slot ||
        lastCompletedAt! > startedAt))
  )
    throw new Error("provider-landing-checkpoint-invalid");
  if (checkpoint.status === "complete" && checkpoint.position !== null)
    throw new Error("provider-landing-checkpoint-invalid");
  if (checkpoint.stream === "catalog" && checkpoint.position !== null)
    throw new Error("provider-landing-checkpoint-invalid");
  if (
    checkpoint.status === "running" &&
    checkpoint.stream === "events" &&
    !(
      (offsetPosition(checkpoint.position) &&
        checkpoint.position.offset % 200 === 0 &&
        checkpoint.eventPartitions === undefined &&
        checkpoint.eventPartitionSourceRows === undefined) ||
      (eventPartitionPosition(checkpoint.position) &&
        checkpoint.position.offset % 200 === 0 &&
        checkpoint.eventPartitions !== undefined &&
        checkpoint.position.partition < checkpoint.eventPartitions.length &&
        checkpoint.eventPartitionSourceRows !== undefined)
    )
  )
    throw new Error("provider-landing-checkpoint-invalid");
  if (
    checkpoint.status === "running" &&
    checkpoint.stream === "odds" &&
    !cursorPosition(checkpoint.position)
  )
    throw new Error("provider-landing-checkpoint-invalid");
  if (
    (checkpoint.stream === "odds" &&
      checkpoint.eventPartitions !== undefined) ||
    (checkpoint.stream !== "events" &&
      checkpoint.eventPartitionSourceRows !== undefined)
  )
    throw new Error("provider-landing-checkpoint-invalid");
  if (
    checkpoint.status === "complete" &&
    checkpoint.eventPartitionSourceRows !== undefined
  )
    throw new Error("provider-landing-checkpoint-invalid");
  if (
    checkpoint.status === "running" &&
    (checkpoint.stream === "events" || checkpoint.stream === "odds")
  ) {
    const currentPositionHash = providerLandingPositionHash(checkpoint);
    if (!checkpoint.visitedPositionHashes?.includes(currentPositionHash))
      throw new Error("provider-landing-checkpoint-invalid");
  }
  if (
    checkpoint.pendingPage &&
    checkpoint.pendingPage.positionHash !==
      providerLandingPositionHash(checkpoint, 64)
  )
    throw new Error("provider-landing-checkpoint-invalid");
}

const validatePositionClaim = (
  claim: ProviderLandingPositionClaim,
  observedAt = Date.now(),
) => {
  if (
    !["events", "odds"].includes(claim.stream) ||
    !validSweepId(claim.sweepId) ||
    !claim.sweepId.startsWith(`${claim.stream}:`) ||
    !validSlot(claim.slot) ||
    !HEX_32.test(claim.positionHash) ||
    !positiveInteger(claim.pageNumber) ||
    !instant(claim.claimedAt) ||
    Date.parse(claim.claimedAt) < Date.parse(sweepStartedAt(claim.sweepId)) ||
    Date.parse(claim.claimedAt) >
      observedAt + PROVIDER_LANDING_MAX_CLOCK_SKEW_MS
  )
    throw new Error("provider-landing-position-claim-invalid");
};

const offsetPosition = (
  value: ProviderLandingCheckpoint["position"],
): value is { readonly offset: number } =>
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).length === 1 &&
  "offset" in value &&
  nonNegativeInteger(value.offset);

const eventPartitionPosition = (
  value: ProviderLandingCheckpoint["position"],
): value is { readonly partition: number; readonly offset: number } =>
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).length === 2 &&
  "partition" in value &&
  "offset" in value &&
  nonNegativeInteger(value.partition) &&
  nonNegativeInteger(value.offset);

const validEventPartitions = (
  value: unknown,
): value is readonly ProviderLandingEventPartition[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_048)
    return false;
  const completeSports = new Set<string>();
  const partitionKeys = new Set<string>();
  const sportLeagues = new Set<string>();
  let encodedBytes = 0;
  for (const candidate of value as unknown[]) {
    if (!plainObject(candidate)) return false;
    const partition = candidate;
    const keys = Object.keys(partition).sort();
    const sport = partition["sport"];
    const rawMembers = partition["leagues"];
    const hasLeagues = rawMembers !== undefined;
    if (
      (hasLeagues
        ? keys.length !== 2 || keys[0] !== "leagues" || keys[1] !== "sport"
        : keys.length !== 1 || keys[0] !== "sport") ||
      !canonical(sport, 64) ||
      sport.includes(",")
    )
      return false;
    let members: string[] | undefined;
    if (hasLeagues) {
      if (
        !Array.isArray(rawMembers) ||
        rawMembers.length === 0 ||
        rawMembers.length > 50
      )
        return false;
      members = [];
      for (const member of rawMembers as unknown[]) {
        if (!canonical(member, 128) || member.includes(",")) return false;
        members.push(member);
      }
      if (new Set(members).size !== members.length) return false;
    }
    const partitionKey = `${sport}\u0000${members?.join("\u0000") ?? "*"}`;
    if (partitionKeys.has(partitionKey)) return false;
    if (!members) {
      if (
        completeSports.has(sport) ||
        [...sportLeagues].some((key) => key.startsWith(`${sport}\u0000`))
      )
        return false;
      completeSports.add(sport);
    } else if (completeSports.has(sport)) return false;
    for (const member of members ?? []) {
      const compound = `${sport}\u0000${member}`;
      if (sportLeagues.has(compound)) return false;
      sportLeagues.add(compound);
    }
    const query = new URLSearchParams({ sport });
    if (members) query.set("league", members.join(","));
    if (query.toString().length > 4_096) return false;
    partitionKeys.add(partitionKey);
    encodedBytes += new TextEncoder().encode(
      JSON.stringify(partition),
    ).byteLength;
    if (encodedBytes > 300_000) return false;
  }
  return true;
};

const cursorPosition = (
  value: ProviderLandingCheckpoint["position"],
): value is { readonly cursor: string } =>
  value !== null &&
  typeof value === "object" &&
  Object.keys(value).length === 1 &&
  "cursor" in value &&
  canonical(value.cursor, 4096);

/** Hash by position meaning rather than map insertion order. DynamoDB may read
 * `{ partition, offset }` back as `{ offset, partition }`. */
export const providerLandingPositionHash = (
  checkpoint: Pick<ProviderLandingCheckpoint, "stream" | "position">,
  length: 32 | 64 = 32,
) => {
  const position = checkpoint.position;
  const canonicalPosition =
    position === null
      ? null
      : "partition" in position
        ? { partition: position.partition, offset: position.offset }
        : "cursor" in position
          ? { cursor: position.cursor }
          : { offset: position.offset };
  return createHash("sha256")
    .update(
      JSON.stringify({
        stream: checkpoint.stream,
        position: canonicalPosition,
      }),
    )
    .digest("hex")
    .slice(0, length);
};

const storageKey = (record: ProviderLandingRecord) => {
  const key = providerLandingKey(record);
  return `${key.pk}\u0000${key.sk}`;
};

const providerLandingIdentityKey = (record: ProviderLandingRecord) => {
  if (record.recordType !== "event" && record.recordType !== "odds")
    return null;
  return boundedKey(
    `PROVIDER_LANDING#SHARPAPI#IDENTITY#${record.recordType.toUpperCase()}#${shard(record.recordId)}`,
    `SLOT#${record.slot}#ID#${encoded(record.recordId)}`,
  );
};

const joinedKey = (key: { readonly pk: string; readonly sk: string }) =>
  `${key.pk}\u0000${key.sk}`;

const duplicateQuarantineRecord = (
  record: ProviderLandingRecord,
  originalPageNumber: number | undefined,
): ProviderLandingRecord => {
  const endpoint = record.recordType === "event" ? "events" : "odds";
  const digest = createHash("sha256")
    .update(storageKey(record))
    .digest("hex")
    .slice(0, 32);
  return {
    schemaVersion: PROVIDER_LANDING_SCHEMA_VERSION,
    providerId: "sharpapi",
    recordType: "quarantine",
    recordId: `${record.sweepId}:${endpoint}:${record.pageNumber}:${digest}`,
    endpoint,
    sweepId: record.sweepId,
    slot: record.slot,
    pageNumber: record.pageNumber,
    retrievedAt: record.retrievedAt,
    value: {
      reason: "duplicate-provider-id-across-pages",
      providerRecordId: record.recordId,
      duplicatePageNumber: record.pageNumber,
      ...(positiveInteger(originalPageNumber) ? { originalPageNumber } : {}),
      sourceFields: Object.keys(record.value).sort().slice(0, 64),
    },
  };
};

export class DynamoProviderLandingRepository implements ProviderLandingPositionClaimStore {
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    options: ProviderLandingRepositoryOptions = {},
  ) {
    if (!canonical(tableName, 256))
      throw new Error("provider-landing-table-invalid");
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.random = options.random ?? Math.random;
  }

  private async backoff(attempt: number) {
    const maximum = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    const sampled = this.random();
    const ratio = Number.isFinite(sampled)
      ? Math.max(0, Math.min(1, sampled))
      : 0;
    await this.sleep(Math.max(1, Math.floor(maximum * ratio)));
  }

  private async getCurrentItems(records: readonly ProviderLandingRecord[]) {
    const keys = [
      ...new Map(
        records
          .filter(
            ({ recordType }) => recordType === "event" || recordType === "odds",
          )
          .flatMap((record) => {
            const currentKey = providerLandingKey(record);
            const identityKey = providerLandingIdentityKey(record);
            return [currentKey, ...(identityKey ? [identityKey] : [])].map(
              (key) => [joinedKey(key), key] as const,
            );
          }),
      ).values(),
    ];
    const items = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < keys.length; index += 100) {
      let pending = keys.slice(index, index + 100);
      for (
        let attempt = 0;
        pending.length > 0 && attempt < MAX_BATCH_ATTEMPTS;
        attempt += 1
      ) {
        const result = await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: {
                Keys: pending,
                ConsistentRead: true,
                ProjectionExpression:
                  "#pk, #sk, #sweepId, #slot, #pageNumber, #currentPk, #currentSk",
                ExpressionAttributeNames: {
                  "#pk": "pk",
                  "#sk": "sk",
                  "#sweepId": "sweepId",
                  "#slot": "slot",
                  "#pageNumber": "pageNumber",
                  "#currentPk": "currentPk",
                  "#currentSk": "currentSk",
                },
              },
            },
          }),
        );
        for (const item of result.Responses?.[this.tableName] ?? []) {
          if (
            typeof item["pk"] !== "string" ||
            typeof item["sk"] !== "string" ||
            !validSweepId(item["sweepId"]) ||
            !validSlot(item["slot"]) ||
            !item["sk"].startsWith(`SLOT#${item["slot"]}#`) ||
            !positiveInteger(item["pageNumber"])
          )
            throw new Error("provider-landing-current-record-corrupt");
          if (
            item["pk"].startsWith("PROVIDER_LANDING#SHARPAPI#IDENTITY#") &&
            (typeof item["currentPk"] !== "string" ||
              typeof item["currentSk"] !== "string" ||
              !storedKeyPart(
                item["currentPk"],
                DYNAMO_PARTITION_KEY_MAX_BYTES,
              ) ||
              !storedKeyPart(item["currentSk"], DYNAMO_SORT_KEY_MAX_BYTES) ||
              !item["currentSk"].startsWith(`SLOT#${item["slot"]}#`))
          )
            throw new Error("provider-landing-current-record-corrupt");
          items.set(`${item["pk"]}\u0000${item["sk"]}`, item);
        }
        pending = (result.UnprocessedKeys?.[this.tableName]?.Keys ?? []) as {
          pk: string;
          sk: string;
        }[];
        if (pending.length > 0 && attempt + 1 < MAX_BATCH_ATTEMPTS)
          await this.backoff(attempt);
      }
      if (pending.length > 0)
        throw new Error("provider-landing-read-exhausted");
    }
    return items;
  }

  async putRecords(
    records: readonly ProviderLandingRecord[],
  ): Promise<ProviderLandingPutRecordsResult> {
    for (const record of records) validateRecord(record);
    const batchSweepId = records[0]?.sweepId;
    const batchSlot = records[0]?.slot;
    const batchPageNumber = records[0]?.pageNumber;
    if (
      records.some(
        (record) =>
          record.sweepId !== batchSweepId ||
          record.slot !== batchSlot ||
          record.pageNumber !== batchPageNumber,
      )
    )
      throw new Error("provider-landing-record-batch-mixed");
    const unique = new Map<string, ProviderLandingRecord>();
    const pageIdentities = new Map<string, string>();
    for (const record of records) {
      const key = storageKey(record);
      if (record.recordType === "event" || record.recordType === "odds") {
        const identity = `${record.recordType}\u0000${record.recordId}`;
        const priorKey = pageIdentities.get(identity);
        if (priorKey && priorKey !== key)
          throw new Error("provider-landing-record-batch-identity-conflict");
        pageIdentities.set(identity, key);
      }
      unique.set(key, record);
    }
    const current = await this.getCurrentItems([...unique.values()]);
    const writable: ProviderLandingRecord[] = [];
    const crossPageDuplicateRecordIds: string[] = [];
    let crossPageDuplicateCount = 0;
    for (const record of unique.values()) {
      const exactKey = providerLandingKey(record);
      const identityKey = providerLandingIdentityKey(record);
      const existing = current.get(joinedKey(exactKey));
      const existingIdentity = identityKey
        ? current.get(joinedKey(identityKey))
        : undefined;
      const identityPointsElsewhere =
        existingIdentity &&
        (existingIdentity["currentPk"] !== exactKey.pk ||
          existingIdentity["currentSk"] !== exactKey.sk);
      const duplicateEvidence = [existing, existingIdentity].find(
        (item) =>
          item?.["sweepId"] === record.sweepId &&
          (item["pageNumber"] !== record.pageNumber ||
            (item === existingIdentity && identityPointsElsewhere)),
      );
      if (
        duplicateEvidence &&
        (record.recordType === "event" || record.recordType === "odds") &&
        duplicateEvidence["sweepId"] === record.sweepId
      ) {
        crossPageDuplicateCount += 1;
        if (crossPageDuplicateRecordIds.length < MAX_DUPLICATE_IDS)
          crossPageDuplicateRecordIds.push(record.recordId);
        writable.push(
          duplicateQuarantineRecord(
            record,
            typeof duplicateEvidence["pageNumber"] === "number"
              ? duplicateEvidence["pageNumber"]
              : undefined,
          ),
        );
      } else writable.push(record);
    }
    for (const record of writable) validateRecord(record);
    const finalRecords = new Map<string, ProviderLandingRecord>();
    for (const record of writable) finalRecords.set(storageKey(record), record);
    const writes: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] =
      [...finalRecords.values()].flatMap((record) => {
        const key = providerLandingKey(record);
        const identityKey = providerLandingIdentityKey(record);
        return [
          {
            PutRequest: {
              Item: {
                ...key,
                schemaVersion: record.schemaVersion,
                providerId: record.providerId,
                recordType: record.recordType,
                recordId: record.recordId,
                ...(record.sport ? { sport: record.sport } : {}),
                ...(record.endpoint ? { endpoint: record.endpoint } : {}),
                sweepId: record.sweepId,
                slot: record.slot,
                pageNumber: record.pageNumber,
                retrievedAt: record.retrievedAt,
                value: record.value,
                expiresAt: expiresAt(
                  record.retrievedAt,
                  record.recordType === "quarantine"
                    ? QUARANTINE_TTL_SECONDS
                    : SNAPSHOT_TTL_SECONDS,
                ),
              },
            },
          },
          ...(identityKey
            ? [
                {
                  PutRequest: {
                    Item: {
                      ...identityKey,
                      schemaVersion: record.schemaVersion,
                      providerId: record.providerId,
                      recordType: "provider-landing-identity",
                      identityType: record.recordType,
                      recordId: record.recordId,
                      sport: record.sport,
                      sweepId: record.sweepId,
                      slot: record.slot,
                      pageNumber: record.pageNumber,
                      retrievedAt: record.retrievedAt,
                      currentPk: key.pk,
                      currentSk: key.sk,
                      expiresAt: expiresAt(
                        record.retrievedAt,
                        SNAPSHOT_TTL_SECONDS,
                      ),
                    },
                  },
                },
              ]
            : []),
        ];
      });
    for (let index = 0; index < writes.length; index += 25) {
      let pending = writes.slice(index, index + 25);
      for (
        let attempt = 0;
        pending.length > 0 && attempt < MAX_BATCH_ATTEMPTS;
        attempt += 1
      ) {
        const result = await this.client.send(
          new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }),
        );
        pending = result.UnprocessedItems?.[this.tableName] ?? [];
        if (pending.length > 0 && attempt + 1 < MAX_BATCH_ATTEMPTS)
          await this.backoff(attempt);
      }
      if (pending.length > 0)
        throw new Error("provider-landing-write-exhausted");
    }
    return { crossPageDuplicateCount, crossPageDuplicateRecordIds };
  }

  async claimPosition(
    claim: ProviderLandingPositionClaim,
  ): Promise<ProviderLandingPositionClaimResult> {
    validatePositionClaim(claim);
    const key = providerLandingPositionClaimKey(claim);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: {
              ...key,
              schemaVersion: PROVIDER_LANDING_POSITION_CLAIM_SCHEMA_VERSION,
              providerId: "sharpapi",
              recordType: "provider-landing-position-claim",
              ...claim,
              expiresAt: expiresAt(claim.claimedAt, SNAPSHOT_TTL_SECONDS),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return "claimed";
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
      }
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (!result.Item) continue;
      const stored = result.Item;
      if (
        stored["schemaVersion"] !==
          PROVIDER_LANDING_POSITION_CLAIM_SCHEMA_VERSION ||
        stored["providerId"] !== "sharpapi" ||
        stored["recordType"] !== "provider-landing-position-claim" ||
        stored["stream"] !== claim.stream ||
        stored["sweepId"] !== claim.sweepId ||
        stored["slot"] !== claim.slot ||
        stored["positionHash"] !== claim.positionHash ||
        !positiveInteger(stored["pageNumber"]) ||
        !instant(stored["claimedAt"]) ||
        stored["expiresAt"] !==
          expiresAt(stored["claimedAt"], SNAPSHOT_TTL_SECONDS)
      )
        throw new Error("provider-landing-position-claim-corrupt");
      return stored["pageNumber"] === claim.pageNumber ? "replay" : "cycle";
    }
    throw new Error("provider-landing-position-claim-race");
  }

  async getCheckpoint(
    stream: ProviderLandingStream,
  ): Promise<ProviderLandingCheckpoint | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: providerLandingCheckpointKey(stream),
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const value = result.Item["value"] as ProviderLandingCheckpoint;
    validateCheckpoint(value);
    if (value.stream !== stream || result.Item["version"] !== value.version)
      throw new Error("provider-landing-checkpoint-corrupt");
    return value;
  }

  async putCheckpoint(
    checkpoint: ProviderLandingCheckpoint,
    expectedVersion: number | null,
  ) {
    validateCheckpoint(checkpoint);
    if (checkpoint.version !== (expectedVersion ?? -1) + 1)
      throw new Error("provider-landing-checkpoint-version-invalid");
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...providerLandingCheckpointKey(checkpoint.stream),
          version: checkpoint.version,
          value: checkpoint,
        },
        ConditionExpression:
          expectedVersion === null
            ? "attribute_not_exists(pk)"
            : "#version = :expectedVersion",
        ...(expectedVersion === null
          ? {}
          : {
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: {
                ":expectedVersion": expectedVersion,
              },
            }),
      }),
    );
  }
}
