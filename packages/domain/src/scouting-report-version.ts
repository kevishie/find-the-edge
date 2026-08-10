import { sha256Hex } from "./fixture-odds.js";
import {
  SCOUTING_MAX_ATTEMPTS,
  assertScoutingEventId,
  assertScoutingRequesterId,
  assertScoutingTimestamp,
  createScoutingAttemptId,
  type ScoutingReportBinding,
} from "./scouting-job.js";

/**
 * Storage-neutral contracts for FTE-042 scouting report persistence: report
 * identity, CAS-ready head, immutable version records with sorted provenance,
 * persistence fingerprints, completion pointers, canonical envelopes, and a
 * stable failure taxonomy. This module never imports from packages/scouting;
 * the FTE-041 canonical report shape is mirrored structurally.
 */

export const SCOUTING_REPORT_SCHEMA_VERSION = 1 as const;
export const SCOUTING_REPORT_HEAD_SCHEMA_VERSION = 1 as const;
export const SCOUTING_REPORT_COMPLETION_POINTER_SCHEMA_VERSION = 1 as const;
/** Hard cap on the canonical serialized version envelope, in UTF-8 bytes. */
export const SCOUTING_REPORT_ENVELOPE_MAX_BYTES = 196_608 as const;
export const SCOUTING_REPORT_PROVENANCE_MAX_ITEMS = 256 as const;

export const SCOUTING_REPORT_FAILURE_CODES = [
  "report-validation-invalid",
  "report-replay-conflict",
  "report-stale-attempt",
  "report-event-version-changed",
  "report-head-cas-conflict",
  "report-storage-corrupt",
  "report-envelope-oversized",
] as const;
export type ScoutingReportFailureCode =
  (typeof SCOUTING_REPORT_FAILURE_CODES)[number];

const RETRYABLE_REPORT_FAILURE_CODES: ReadonlySet<ScoutingReportFailureCode> =
  new Set(["report-head-cas-conflict"]);

export const isScoutingReportFailureCode = (
  value: unknown,
): value is ScoutingReportFailureCode =>
  SCOUTING_REPORT_FAILURE_CODES.includes(value as ScoutingReportFailureCode);

export const isRetryableScoutingReportFailure = (
  code: ScoutingReportFailureCode,
): boolean => RETRYABLE_REPORT_FAILURE_CODES.has(code);

export const SCOUTING_REPORT_STATUSES = [
  "complete",
  "reduced",
  "abstain",
] as const;
export type ScoutingReportStatus = (typeof SCOUTING_REPORT_STATUSES)[number];

export const SCOUTING_REPORT_EVIDENCE_STATUSES = [
  "conflicting",
  "inference",
  "stale",
  "unavailable",
  "verified",
] as const;
export type ScoutingReportEvidenceStatus =
  (typeof SCOUTING_REPORT_EVIDENCE_STATUSES)[number];

export const SCOUTING_REPORT_ASSERTION_CLASSIFICATIONS = [
  "conflicting",
  "factual",
  "inference",
  "stale",
  "unavailable",
] as const;
export type ScoutingReportAssertionClassification =
  (typeof SCOUTING_REPORT_ASSERTION_CLASSIFICATIONS)[number];

export interface ScoutingReportVersionRef {
  readonly id: string;
  readonly version: string;
}

/** Structural mirror of the FTE-041 canonical version manifest. */
export interface ScoutingReportPayloadVersions {
  readonly contractVersion: string;
  readonly promptBundleId: string;
  readonly promptBundleVersion: string;
  readonly promptSections: Readonly<
    Record<
      "shared" | "sport" | "strategy" | "analysis",
      ScoutingReportVersionRef
    >
  >;
  readonly inputSchemaId: string;
  readonly inputSchemaVersion: string;
  readonly outputSchemaId: string;
  readonly outputSchemaVersion: string;
  readonly modelId: string;
  readonly modelVersion: string;
}

export interface ScoutingReportCandidate {
  readonly marketKey: "moneyline" | "spread";
  readonly outcomeStructure: "two-way" | "three-way";
  readonly selection: Readonly<{
    kind: "participant" | "draw";
    participantId?: string;
  }>;
  readonly point?: number;
}

export interface ScoutingReportAssertion {
  readonly text: string;
  readonly classification: ScoutingReportAssertionClassification;
  readonly citationIds: readonly string[];
}

/**
 * Bounded inline canonical payload — a structural mirror of the validated
 * FTE-041 report. Semantic revalidation against policy stays in
 * packages/scouting; this layer enforces exact shape, bounds, and canonical
 * ordering only.
 */
export interface ScoutingReportInlinePayload {
  readonly candidate: ScoutingReportCandidate;
  readonly versions: ScoutingReportPayloadVersions;
  readonly probability: Readonly<{
    estimate: number;
    low: number;
    high: number;
    uncertainty: number;
  }>;
  readonly status: ScoutingReportStatus;
  readonly abstentionCodes: readonly string[];
  readonly summary: string;
  readonly assertions: readonly ScoutingReportAssertion[];
}

export interface ScoutingReportCitedObservation {
  readonly observationId: string;
  readonly category: string;
  readonly status: ScoutingReportEvidenceStatus;
  readonly observedAt: string;
}

export interface ScoutingReportProviderObservation {
  readonly providerId: string;
  readonly observationId: string;
  readonly observedAt: string;
}

export interface ScoutingReportEvidenceReference {
  readonly sourceId: string;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly verification: ScoutingReportEvidenceStatus;
}

/** Directly queryable, deterministically sorted provenance metadata. */
export interface ScoutingReportProvenance {
  readonly citedSourceObservations: readonly ScoutingReportCitedObservation[];
  readonly providerObservations: readonly ScoutingReportProviderObservation[];
  readonly evidenceReferences: readonly ScoutingReportEvidenceReference[];
  readonly calculationVersions: readonly ScoutingReportVersionRef[];
  readonly referenceHashes: readonly string[];
  readonly oddsSnapshotIds: readonly string[];
  readonly inputHash: string;
  readonly inputSchema: ScoutingReportVersionRef;
  readonly promptBundle: ScoutingReportVersionRef;
  readonly model: ScoutingReportVersionRef;
  readonly sportModule: ScoutingReportVersionRef;
  readonly strategy: ScoutingReportVersionRef;
  readonly reportSchema: ScoutingReportVersionRef;
}

export interface ScoutingReportPredecessorFence {
  readonly reportVersionId: string;
  readonly versionNumber: number;
  readonly draftHash: string;
}

export const SCOUTING_REPORT_CHANGE_FIELDS = [
  "abstentionCodes",
  "assertions",
  "candidate",
  "probability",
  "status",
  "summary",
  "versions",
] as const;
export type ScoutingReportChangeField =
  (typeof SCOUTING_REPORT_CHANGE_FIELDS)[number];

export interface ScoutingReportChangeSummary {
  readonly kind: "initial" | "unchanged" | "changed";
  readonly changedFields: readonly ScoutingReportChangeField[];
}

/** Immutable, append-only report version record. */
export interface ScoutingReportVersionRecord {
  readonly schemaVersion: typeof SCOUTING_REPORT_SCHEMA_VERSION;
  readonly reportVersionId: string;
  readonly reportId: string;
  readonly requesterId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly jobId: string;
  readonly attemptId: string;
  readonly versionNumber: number;
  readonly draftHash: string;
  readonly payload: ScoutingReportInlinePayload;
  readonly provenance: ScoutingReportProvenance;
  readonly validationOutcome: ScoutingReportStatus;
  readonly generatedAt: string;
  readonly predecessor: ScoutingReportPredecessorFence | null;
  readonly changeSummary: ScoutingReportChangeSummary;
  readonly persistenceFingerprint: string;
}

/** Latest-version pointer; repositories compare-and-swap on stateVersion. */
export interface ScoutingReportHead {
  readonly schemaVersion: typeof SCOUTING_REPORT_HEAD_SCHEMA_VERSION;
  readonly reportId: string;
  readonly requesterId: string;
  readonly eventId: string;
  readonly latestVersionNumber: number;
  readonly latestVersionId: string;
  readonly latestDraftHash: string;
  readonly stateVersion: number;
  readonly updatedAt: string;
}

/** Binds a job and its successful attempt to exactly one report version. */
export interface ScoutingReportCompletionPointer extends ScoutingReportBinding {
  readonly schemaVersion: typeof SCOUTING_REPORT_COMPLETION_POINTER_SCHEMA_VERSION;
  readonly jobId: string;
  readonly attemptId: string;
  readonly draftHash: string;
}

/**
 * Authoritative replay material. `usage` and `latencyMs` are accepted so
 * callers can pass raw attempt telemetry, but they are explicitly excluded
 * from the fingerprint: first-write telemetry wins on exact replay.
 */
export interface ScoutingReportPersistenceMaterial {
  readonly reportId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly draftHash: string;
  readonly provenance: ScoutingReportProvenance;
  readonly usage?: Readonly<Record<string, number>>;
  readonly latencyMs?: number;
}

const HEX64 = /^[a-f0-9]{64}$/;
const REPORT_ID = /^scout-report:[a-f0-9]{64}$/;
const REPORT_VERSION_ID = /^scout-report-version:[a-f0-9]{64}$/;
const JOB_ID = /^scout-job:[a-f0-9]{64}$/;
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/;

const invalid = (code: string): never => {
  throw new Error(code);
};

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

const boundedText = (value: unknown, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    containsUnpairedSurrogate(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  )
    invalid("report-validation-invalid");
  return value as string;
};

const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    invalid("report-validation-invalid");
  return value as string;
};

const hex64 = (value: unknown): string => {
  if (typeof value !== "string" || !HEX64.test(value))
    invalid("report-validation-invalid");
  return value as string;
};

const finiteNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    invalid("report-validation-invalid");
  return Object.is(value, -0) ? 0 : (value as number);
};

const isPlainRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isPlainRecord(value)) invalid("report-validation-invalid");
  return value as Readonly<Record<string, unknown>>;
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const keys = Object.keys(value);
  if (
    !required.every((key) => keys.includes(key)) ||
    !keys.every((key) => required.includes(key) || optional.includes(key))
  )
    invalid("report-validation-invalid");
};

const boundedArray = (value: unknown, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximum)
    invalid("report-validation-invalid");
  return value as readonly unknown[];
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Canonical JSON for report material: recursively key-sorted, cycle-safe.
 * The byte length of this serialization is what the envelope cap measures.
 */
export function canonicalScoutingReportJson(value: unknown): string {
  const seen = new Set<object>();
  const serialize = (item: unknown): string => {
    if (item === null || typeof item !== "object") {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) return invalid("report-validation-invalid");
      return encoded;
    }
    if (seen.has(item)) invalid("report-validation-invalid");
    seen.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map(serialize).join(",")}]`;
      const record = item as Readonly<Record<string, unknown>>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
        .join(",")}}`;
    } finally {
      seen.delete(item);
    }
  };
  return serialize(value);
}

export const createScoutingReportId = (
  requesterId: string,
  eventId: string,
): string =>
  `scout-report:${sha256Hex(
    `fte:scouting-report:v1:${canonicalScoutingReportJson({
      eventId: assertScoutingEventId(eventId),
      requesterId: assertScoutingRequesterId(requesterId),
    })}`,
  )}`;

export const createScoutingReportDraftHash = (
  payload: ScoutingReportInlinePayload,
): string =>
  sha256Hex(
    `fte:scouting-report-draft:v1:${canonicalScoutingReportJson(
      normalizeScoutingReportInlinePayload(payload),
    )}`,
  );

export const createScoutingReportVersionId = (
  reportId: string,
  jobId: string,
  draftHash: string,
): string => {
  if (
    !REPORT_ID.test(reportId) ||
    !JOB_ID.test(jobId) ||
    !HEX64.test(draftHash)
  )
    invalid("report-validation-invalid");
  return `scout-report-version:${sha256Hex(
    `fte:scouting-report-version:v1:${canonicalScoutingReportJson({
      draftHash,
      jobId,
      reportId,
    })}`,
  )}`;
};

const normalizeVersionRef = (value: unknown): ScoutingReportVersionRef => {
  const record = plainRecord(value);
  exactKeys(record, ["id", "version"]);
  return Object.freeze({
    id: identifier(record["id"]),
    version: identifier(record["version"]),
  });
};

const compareVersionRefs = (
  left: ScoutingReportVersionRef,
  right: ScoutingReportVersionRef,
): number =>
  compareStrings(left.id, right.id) ||
  compareStrings(left.version, right.version);

const normalizeCandidate = (value: unknown): ScoutingReportCandidate => {
  const record = plainRecord(value);
  exactKeys(record, ["marketKey", "outcomeStructure", "selection"], ["point"]);
  const marketKey = record["marketKey"];
  if (marketKey !== "moneyline" && marketKey !== "spread")
    invalid("report-validation-invalid");
  const outcomeStructure = record["outcomeStructure"];
  if (outcomeStructure !== "two-way" && outcomeStructure !== "three-way")
    invalid("report-validation-invalid");
  const selection = plainRecord(record["selection"]);
  exactKeys(selection, ["kind"], ["participantId"]);
  const kind = selection["kind"];
  if (kind !== "participant" && kind !== "draw")
    invalid("report-validation-invalid");
  if ((kind === "participant") !== (selection["participantId"] !== undefined))
    invalid("report-validation-invalid");
  if ((marketKey === "spread") !== (record["point"] !== undefined))
    invalid("report-validation-invalid");
  return Object.freeze({
    marketKey: marketKey as "moneyline" | "spread",
    outcomeStructure: outcomeStructure as "two-way" | "three-way",
    selection: Object.freeze({
      kind: kind as "participant" | "draw",
      ...(selection["participantId"] !== undefined
        ? { participantId: boundedText(selection["participantId"], 256) }
        : {}),
    }),
    ...(record["point"] !== undefined
      ? { point: finiteNumber(record["point"]) }
      : {}),
  });
};

const normalizePayloadVersions = (
  value: unknown,
): ScoutingReportPayloadVersions => {
  const record = plainRecord(value);
  exactKeys(record, [
    "contractVersion",
    "promptBundleId",
    "promptBundleVersion",
    "promptSections",
    "inputSchemaId",
    "inputSchemaVersion",
    "outputSchemaId",
    "outputSchemaVersion",
    "modelId",
    "modelVersion",
  ]);
  const sections = plainRecord(record["promptSections"]);
  exactKeys(sections, ["shared", "sport", "strategy", "analysis"]);
  return Object.freeze({
    contractVersion: identifier(record["contractVersion"]),
    promptBundleId: identifier(record["promptBundleId"]),
    promptBundleVersion: identifier(record["promptBundleVersion"]),
    promptSections: Object.freeze({
      shared: normalizeVersionRef(sections["shared"]),
      sport: normalizeVersionRef(sections["sport"]),
      strategy: normalizeVersionRef(sections["strategy"]),
      analysis: normalizeVersionRef(sections["analysis"]),
    }),
    inputSchemaId: identifier(record["inputSchemaId"]),
    inputSchemaVersion: identifier(record["inputSchemaVersion"]),
    outputSchemaId: identifier(record["outputSchemaId"]),
    outputSchemaVersion: identifier(record["outputSchemaVersion"]),
    modelId: identifier(record["modelId"]),
    modelVersion: identifier(record["modelVersion"]),
  });
};

const strictlyAscendingText = (
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] => {
  const items = boundedArray(value, maximumItems).map((item) =>
    boundedText(item, maximumLength),
  );
  for (let index = 1; index < items.length; index += 1) {
    if (compareStrings(items[index - 1] as string, items[index] as string) >= 0)
      invalid("report-validation-invalid");
  }
  return Object.freeze(items);
};

export function normalizeScoutingReportInlinePayload(
  input: unknown,
): ScoutingReportInlinePayload {
  const record = plainRecord(input);
  exactKeys(record, [
    "candidate",
    "versions",
    "probability",
    "status",
    "abstentionCodes",
    "summary",
    "assertions",
  ]);
  const status = record["status"];
  if (!SCOUTING_REPORT_STATUSES.includes(status as ScoutingReportStatus))
    invalid("report-validation-invalid");
  const probability = plainRecord(record["probability"]);
  exactKeys(probability, ["estimate", "low", "high", "uncertainty"]);
  const estimate = finiteNumber(probability["estimate"]);
  const low = finiteNumber(probability["low"]);
  const high = finiteNumber(probability["high"]);
  const uncertainty = finiteNumber(probability["uncertainty"]);
  if (
    low < 0 ||
    high > 1 ||
    low > high ||
    estimate < low ||
    estimate > high ||
    uncertainty < 0 ||
    uncertainty > 1
  )
    invalid("report-validation-invalid");
  const abstentionCodes = strictlyAscendingText(
    record["abstentionCodes"],
    32,
    128,
  );
  if ((status === "abstain") !== abstentionCodes.length > 0)
    invalid("report-validation-invalid");
  const rawAssertions = boundedArray(record["assertions"], 64);
  if (rawAssertions.length < 1) invalid("report-validation-invalid");
  const assertions = Object.freeze(
    rawAssertions.map((item): ScoutingReportAssertion => {
      const assertion = plainRecord(item);
      exactKeys(assertion, ["text", "classification", "citationIds"]);
      const classification = assertion["classification"];
      if (
        !SCOUTING_REPORT_ASSERTION_CLASSIFICATIONS.includes(
          classification as ScoutingReportAssertionClassification,
        )
      )
        invalid("report-validation-invalid");
      return Object.freeze({
        text: boundedText(assertion["text"], 2000),
        classification: classification as ScoutingReportAssertionClassification,
        citationIds: strictlyAscendingText(assertion["citationIds"], 16, 128),
      });
    }),
  );
  return deepFreeze({
    candidate: normalizeCandidate(record["candidate"]),
    versions: normalizePayloadVersions(record["versions"]),
    probability: Object.freeze({ estimate, low, high, uncertainty }),
    status: status as ScoutingReportStatus,
    abstentionCodes,
    summary: boundedText(record["summary"], 4000),
    assertions,
  });
}

const evidenceStatus = (value: unknown): ScoutingReportEvidenceStatus => {
  if (
    !SCOUTING_REPORT_EVIDENCE_STATUSES.includes(
      value as ScoutingReportEvidenceStatus,
    )
  )
    invalid("report-validation-invalid");
  return value as ScoutingReportEvidenceStatus;
};

const sortedUnique = <T>(
  items: readonly T[],
  compare: (left: T, right: T) => number,
): readonly T[] => {
  const sorted = [...items].sort(compare);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compare(sorted[index - 1] as T, sorted[index] as T) === 0)
      invalid("report-validation-invalid");
  }
  return Object.freeze(sorted);
};

export function normalizeScoutingReportProvenance(
  input: unknown,
): ScoutingReportProvenance {
  const record = plainRecord(input);
  exactKeys(record, [
    "citedSourceObservations",
    "providerObservations",
    "evidenceReferences",
    "calculationVersions",
    "referenceHashes",
    "oddsSnapshotIds",
    "inputHash",
    "inputSchema",
    "promptBundle",
    "model",
    "sportModule",
    "strategy",
    "reportSchema",
  ]);
  const cited = sortedUnique(
    boundedArray(
      record["citedSourceObservations"],
      SCOUTING_REPORT_PROVENANCE_MAX_ITEMS,
    ).map((item): ScoutingReportCitedObservation => {
      const observation = plainRecord(item);
      exactKeys(observation, [
        "observationId",
        "category",
        "status",
        "observedAt",
      ]);
      return Object.freeze({
        observationId: identifier(observation["observationId"]),
        category: boundedText(observation["category"], 128),
        status: evidenceStatus(observation["status"]),
        observedAt: assertScoutingTimestamp(
          boundedText(observation["observedAt"], 64),
        ),
      });
    }),
    (left, right) => compareStrings(left.observationId, right.observationId),
  );
  const providerObservations = sortedUnique(
    boundedArray(
      record["providerObservations"],
      SCOUTING_REPORT_PROVENANCE_MAX_ITEMS,
    ).map((item): ScoutingReportProviderObservation => {
      const observation = plainRecord(item);
      exactKeys(observation, ["providerId", "observationId", "observedAt"]);
      return Object.freeze({
        providerId: identifier(observation["providerId"]),
        observationId: identifier(observation["observationId"]),
        observedAt: assertScoutingTimestamp(
          boundedText(observation["observedAt"], 64),
        ),
      });
    }),
    (left, right) =>
      compareStrings(left.providerId, right.providerId) ||
      compareStrings(left.observationId, right.observationId),
  );
  const evidenceReferences = sortedUnique(
    boundedArray(
      record["evidenceReferences"],
      SCOUTING_REPORT_PROVENANCE_MAX_ITEMS,
    ).map((item): ScoutingReportEvidenceReference => {
      const reference = plainRecord(item);
      exactKeys(reference, [
        "sourceId",
        "observedAt",
        "retrievedAt",
        "verification",
      ]);
      return Object.freeze({
        sourceId: identifier(reference["sourceId"]),
        observedAt: assertScoutingTimestamp(
          boundedText(reference["observedAt"], 64),
        ),
        retrievedAt: assertScoutingTimestamp(
          boundedText(reference["retrievedAt"], 64),
        ),
        verification: evidenceStatus(reference["verification"]),
      });
    }),
    (left, right) =>
      compareStrings(left.sourceId, right.sourceId) ||
      compareStrings(left.observedAt, right.observedAt) ||
      compareStrings(left.retrievedAt, right.retrievedAt) ||
      compareStrings(left.verification, right.verification),
  );
  const calculationVersions = sortedUnique(
    boundedArray(
      record["calculationVersions"],
      SCOUTING_REPORT_PROVENANCE_MAX_ITEMS,
    ).map(normalizeVersionRef),
    compareVersionRefs,
  );
  const referenceHashes = sortedUnique(
    boundedArray(
      record["referenceHashes"],
      SCOUTING_REPORT_PROVENANCE_MAX_ITEMS,
    ).map(hex64),
    compareStrings,
  );
  const oddsSnapshotIds = sortedUnique(
    boundedArray(
      record["oddsSnapshotIds"],
      SCOUTING_REPORT_PROVENANCE_MAX_ITEMS,
    ).map(identifier),
    compareStrings,
  );
  return deepFreeze({
    citedSourceObservations: cited,
    providerObservations,
    evidenceReferences,
    calculationVersions,
    referenceHashes,
    oddsSnapshotIds,
    inputHash: hex64(record["inputHash"]),
    inputSchema: normalizeVersionRef(record["inputSchema"]),
    promptBundle: normalizeVersionRef(record["promptBundle"]),
    model: normalizeVersionRef(record["model"]),
    sportModule: normalizeVersionRef(record["sportModule"]),
    strategy: normalizeVersionRef(record["strategy"]),
    reportSchema: normalizeVersionRef(record["reportSchema"]),
  });
}

const versionRefEquals = (
  left: ScoutingReportVersionRef,
  right: ScoutingReportVersionRef,
): boolean => left.id === right.id && left.version === right.version;

/** Provenance version pointers must re-state the payload manifest exactly. */
const assertProvenanceCoherent = (
  payload: ScoutingReportInlinePayload,
  provenance: ScoutingReportProvenance,
): void => {
  const versions = payload.versions;
  if (
    !versionRefEquals(provenance.inputSchema, {
      id: versions.inputSchemaId,
      version: versions.inputSchemaVersion,
    }) ||
    !versionRefEquals(provenance.promptBundle, {
      id: versions.promptBundleId,
      version: versions.promptBundleVersion,
    }) ||
    !versionRefEquals(provenance.model, {
      id: versions.modelId,
      version: versions.modelVersion,
    }) ||
    !versionRefEquals(provenance.sportModule, versions.promptSections.sport) ||
    !versionRefEquals(provenance.strategy, versions.promptSections.strategy) ||
    !versionRefEquals(provenance.reportSchema, {
      id: versions.outputSchemaId,
      version: versions.outputSchemaVersion,
    })
  )
    invalid("report-validation-invalid");
};

export function createScoutingReportPersistenceFingerprint(
  material: ScoutingReportPersistenceMaterial,
): string {
  if (!REPORT_ID.test(material.reportId)) invalid("report-validation-invalid");
  assertScoutingEventId(material.eventId);
  if (!Number.isSafeInteger(material.eventVersion) || material.eventVersion < 1)
    invalid("report-validation-invalid");
  // usage and latencyMs are deliberately excluded: replay compares only the
  // authoritative report/event/input/prompt/model/provenance/calculation
  // material, so first-write telemetry always wins.
  return sha256Hex(
    `fte:scouting-report-fingerprint:v1:${canonicalScoutingReportJson({
      draftHash: hex64(material.draftHash),
      eventId: material.eventId,
      eventVersion: material.eventVersion,
      provenance: normalizeScoutingReportProvenance(material.provenance),
      reportId: material.reportId,
    })}`,
  );
}

export function deriveScoutingReportChangeSummary(
  previousPayload: ScoutingReportInlinePayload | null,
  nextPayload: ScoutingReportInlinePayload,
): ScoutingReportChangeSummary {
  const next = normalizeScoutingReportInlinePayload(nextPayload);
  if (previousPayload === null)
    return deepFreeze({ kind: "initial", changedFields: [] });
  const previous = normalizeScoutingReportInlinePayload(previousPayload);
  const changedFields = SCOUTING_REPORT_CHANGE_FIELDS.filter(
    (field) =>
      canonicalScoutingReportJson(previous[field]) !==
      canonicalScoutingReportJson(next[field]),
  );
  return deepFreeze({
    kind: changedFields.length > 0 ? "changed" : "unchanged",
    changedFields,
  });
}

const normalizeChangeSummary = (
  value: unknown,
): ScoutingReportChangeSummary => {
  const record = plainRecord(value);
  exactKeys(record, ["kind", "changedFields"]);
  const kind = record["kind"];
  if (kind !== "initial" && kind !== "unchanged" && kind !== "changed")
    invalid("report-validation-invalid");
  const changedFields = boundedArray(
    record["changedFields"],
    SCOUTING_REPORT_CHANGE_FIELDS.length,
  ).map((item) => {
    if (
      !SCOUTING_REPORT_CHANGE_FIELDS.includes(item as ScoutingReportChangeField)
    )
      invalid("report-validation-invalid");
    return item as ScoutingReportChangeField;
  });
  for (let index = 1; index < changedFields.length; index += 1) {
    if (
      compareStrings(
        changedFields[index - 1] as string,
        changedFields[index] as string,
      ) >= 0
    )
      invalid("report-validation-invalid");
  }
  return deepFreeze({
    kind: kind as ScoutingReportChangeSummary["kind"],
    changedFields,
  });
};

const validAttemptIdForJob = (jobId: string, attemptId: unknown): string => {
  if (
    typeof attemptId !== "string" ||
    !Array.from({ length: SCOUTING_MAX_ATTEMPTS }, (_, index) =>
      createScoutingAttemptId(jobId, index + 1),
    ).includes(attemptId)
  )
    invalid("report-validation-invalid");
  return attemptId as string;
};

/**
 * Stored version records are re-derived, never trusted: every identity, hash,
 * sort order, fence, and the fingerprint are recomputed, and the rebuilt
 * record must byte-compare equal to the input's canonical serialization.
 */
export function normalizeScoutingReportVersion(
  input: unknown,
): ScoutingReportVersionRecord {
  const value = plainRecord(input);
  exactKeys(value, [
    "schemaVersion",
    "reportVersionId",
    "reportId",
    "requesterId",
    "eventId",
    "eventVersion",
    "jobId",
    "attemptId",
    "versionNumber",
    "draftHash",
    "payload",
    "provenance",
    "validationOutcome",
    "generatedAt",
    "predecessor",
    "changeSummary",
    "persistenceFingerprint",
  ]);
  if (value["schemaVersion"] !== SCOUTING_REPORT_SCHEMA_VERSION)
    invalid("report-validation-invalid");
  const requesterId = assertScoutingRequesterId(
    boundedText(value["requesterId"], 256),
  );
  const eventId = assertScoutingEventId(boundedText(value["eventId"], 512));
  if (
    !Number.isSafeInteger(value["eventVersion"]) ||
    Number(value["eventVersion"]) < 1 ||
    typeof value["jobId"] !== "string" ||
    !JOB_ID.test(value["jobId"]) ||
    !Number.isSafeInteger(value["versionNumber"]) ||
    Number(value["versionNumber"]) < 1
  )
    invalid("report-validation-invalid");
  const jobId = value["jobId"] as string;
  const attemptId = validAttemptIdForJob(jobId, value["attemptId"]);
  const versionNumber = Number(value["versionNumber"]);
  const payload = normalizeScoutingReportInlinePayload(value["payload"]);
  const provenance = normalizeScoutingReportProvenance(value["provenance"]);
  assertProvenanceCoherent(payload, provenance);
  const draftHash = createScoutingReportDraftHash(payload);
  const reportId = createScoutingReportId(requesterId, eventId);
  const reportVersionId = createScoutingReportVersionId(
    reportId,
    jobId,
    draftHash,
  );
  const generatedAt = assertScoutingTimestamp(
    boundedText(value["generatedAt"], 64),
  );
  let predecessor: ScoutingReportPredecessorFence | null = null;
  if (value["predecessor"] !== null) {
    const fence = plainRecord(value["predecessor"]);
    exactKeys(fence, ["reportVersionId", "versionNumber", "draftHash"]);
    if (
      typeof fence["reportVersionId"] !== "string" ||
      !REPORT_VERSION_ID.test(fence["reportVersionId"]) ||
      fence["reportVersionId"] === reportVersionId ||
      fence["versionNumber"] !== versionNumber - 1
    )
      invalid("report-validation-invalid");
    predecessor = Object.freeze({
      reportVersionId: fence["reportVersionId"] as string,
      versionNumber: versionNumber - 1,
      draftHash: hex64(fence["draftHash"]),
    });
  }
  if ((versionNumber === 1) !== (predecessor === null))
    invalid("report-validation-invalid");
  const changeSummary = normalizeChangeSummary(value["changeSummary"]);
  if (
    (predecessor === null) !== (changeSummary.kind === "initial") ||
    (predecessor !== null &&
      (predecessor.draftHash === draftHash) !==
        (changeSummary.kind === "unchanged")) ||
    (changeSummary.kind === "changed") !==
      changeSummary.changedFields.length > 0
  )
    invalid("report-validation-invalid");
  const rebuilt = deepFreeze({
    schemaVersion: SCOUTING_REPORT_SCHEMA_VERSION,
    reportVersionId,
    reportId,
    requesterId,
    eventId,
    eventVersion: Number(value["eventVersion"]),
    jobId,
    attemptId,
    versionNumber,
    draftHash,
    payload,
    provenance,
    validationOutcome: payload.status,
    generatedAt,
    predecessor,
    changeSummary,
    persistenceFingerprint: createScoutingReportPersistenceFingerprint({
      reportId,
      eventId,
      eventVersion: Number(value["eventVersion"]),
      draftHash,
      provenance,
    }),
  });
  const canonical = canonicalScoutingReportJson(rebuilt);
  if (utf8ByteLength(canonical) > SCOUTING_REPORT_ENVELOPE_MAX_BYTES)
    invalid("report-envelope-oversized");
  if (canonicalScoutingReportJson(value) !== canonical)
    invalid("report-storage-corrupt");
  return rebuilt;
}

export interface CreateScoutingReportVersionInput {
  readonly requesterId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly jobId: string;
  readonly attemptId: string;
  readonly versionNumber: number;
  readonly payload: ScoutingReportInlinePayload;
  readonly provenance: ScoutingReportProvenance;
  readonly generatedAt: string;
  readonly predecessor:
    | (ScoutingReportPredecessorFence & {
        readonly payload: ScoutingReportInlinePayload;
      })
    | null;
}

export function createScoutingReportVersion(
  input: CreateScoutingReportVersionInput,
): ScoutingReportVersionRecord {
  const payload = normalizeScoutingReportInlinePayload(input.payload);
  const provenance = normalizeScoutingReportProvenance(input.provenance);
  const draftHash = createScoutingReportDraftHash(payload);
  const reportId = createScoutingReportId(input.requesterId, input.eventId);
  const reportVersionId = createScoutingReportVersionId(
    reportId,
    input.jobId,
    draftHash,
  );
  let predecessor: ScoutingReportPredecessorFence | null = null;
  let previousPayload: ScoutingReportInlinePayload | null = null;
  if (input.predecessor !== null) {
    previousPayload = normalizeScoutingReportInlinePayload(
      input.predecessor.payload,
    );
    if (
      createScoutingReportDraftHash(previousPayload) !==
      input.predecessor.draftHash
    )
      invalid("report-validation-invalid");
    predecessor = Object.freeze({
      reportVersionId: input.predecessor.reportVersionId,
      versionNumber: input.predecessor.versionNumber,
      draftHash: input.predecessor.draftHash,
    });
  }
  return normalizeScoutingReportVersion({
    schemaVersion: SCOUTING_REPORT_SCHEMA_VERSION,
    reportVersionId,
    reportId,
    requesterId: input.requesterId,
    eventId: input.eventId,
    eventVersion: input.eventVersion,
    jobId: input.jobId,
    attemptId: input.attemptId,
    versionNumber: input.versionNumber,
    draftHash,
    payload,
    provenance,
    validationOutcome: payload.status,
    generatedAt: input.generatedAt,
    predecessor,
    changeSummary: deriveScoutingReportChangeSummary(previousPayload, payload),
    persistenceFingerprint: createScoutingReportPersistenceFingerprint({
      reportId,
      eventId: input.eventId,
      eventVersion: input.eventVersion,
      draftHash,
      provenance,
    }),
  });
}

export function normalizeScoutingReportHead(
  input: unknown,
): ScoutingReportHead {
  const value = plainRecord(input);
  exactKeys(value, [
    "schemaVersion",
    "reportId",
    "requesterId",
    "eventId",
    "latestVersionNumber",
    "latestVersionId",
    "latestDraftHash",
    "stateVersion",
    "updatedAt",
  ]);
  if (value["schemaVersion"] !== SCOUTING_REPORT_HEAD_SCHEMA_VERSION)
    invalid("report-head-invalid");
  const requesterId = assertScoutingRequesterId(
    boundedText(value["requesterId"], 256),
  );
  const eventId = assertScoutingEventId(boundedText(value["eventId"], 512));
  const reportId = createScoutingReportId(requesterId, eventId);
  if (
    value["reportId"] !== reportId ||
    typeof value["latestVersionId"] !== "string" ||
    !REPORT_VERSION_ID.test(value["latestVersionId"]) ||
    typeof value["latestDraftHash"] !== "string" ||
    !HEX64.test(value["latestDraftHash"]) ||
    !Number.isSafeInteger(value["latestVersionNumber"]) ||
    Number(value["latestVersionNumber"]) < 1 ||
    !Number.isSafeInteger(value["stateVersion"]) ||
    Number(value["stateVersion"]) < Number(value["latestVersionNumber"])
  )
    invalid("report-head-invalid");
  return Object.freeze({
    schemaVersion: SCOUTING_REPORT_HEAD_SCHEMA_VERSION,
    reportId,
    requesterId,
    eventId,
    latestVersionNumber: Number(value["latestVersionNumber"]),
    latestVersionId: value["latestVersionId"] as string,
    latestDraftHash: value["latestDraftHash"] as string,
    stateVersion: Number(value["stateVersion"]),
    updatedAt: assertScoutingTimestamp(boundedText(value["updatedAt"], 64)),
  });
}

/** Creates the head for the first version of a report history. */
export function createScoutingReportHead(
  version: ScoutingReportVersionRecord,
): ScoutingReportHead {
  const record = normalizeScoutingReportVersion(version);
  if (record.versionNumber !== 1 || record.predecessor !== null)
    invalid("report-head-cas-conflict");
  return normalizeScoutingReportHead({
    schemaVersion: SCOUTING_REPORT_HEAD_SCHEMA_VERSION,
    reportId: record.reportId,
    requesterId: record.requesterId,
    eventId: record.eventId,
    latestVersionNumber: 1,
    latestVersionId: record.reportVersionId,
    latestDraftHash: record.draftHash,
    stateVersion: 1,
    updatedAt: record.generatedAt,
  });
}

/**
 * Compare-and-swap advance: the incoming version must fence on the exact
 * current head (predecessor id, number, and draft hash) and allocate the next
 * contiguous version number, else the caller must reload and retry boundedly.
 */
export function advanceScoutingReportHead(
  head: ScoutingReportHead,
  version: ScoutingReportVersionRecord,
): ScoutingReportHead {
  const current = normalizeScoutingReportHead(head);
  const record = normalizeScoutingReportVersion(version);
  if (
    record.reportId !== current.reportId ||
    record.predecessor === null ||
    record.predecessor.reportVersionId !== current.latestVersionId ||
    record.predecessor.versionNumber !== current.latestVersionNumber ||
    record.predecessor.draftHash !== current.latestDraftHash ||
    record.versionNumber !== current.latestVersionNumber + 1
  )
    invalid("report-head-cas-conflict");
  return normalizeScoutingReportHead({
    schemaVersion: SCOUTING_REPORT_HEAD_SCHEMA_VERSION,
    reportId: current.reportId,
    requesterId: current.requesterId,
    eventId: current.eventId,
    latestVersionNumber: record.versionNumber,
    latestVersionId: record.reportVersionId,
    latestDraftHash: record.draftHash,
    stateVersion: current.stateVersion + 1,
    updatedAt: record.generatedAt,
  });
}

export function createScoutingReportCompletionPointer(
  version: ScoutingReportVersionRecord,
): ScoutingReportCompletionPointer {
  const record = normalizeScoutingReportVersion(version);
  return Object.freeze({
    schemaVersion: SCOUTING_REPORT_COMPLETION_POINTER_SCHEMA_VERSION,
    jobId: record.jobId,
    attemptId: record.attemptId,
    reportId: record.reportId,
    reportVersionId: record.reportVersionId,
    reportVersionNumber: record.versionNumber,
    draftHash: record.draftHash,
  });
}

export function normalizeScoutingReportCompletionPointer(
  input: unknown,
): ScoutingReportCompletionPointer {
  const value = plainRecord(input);
  exactKeys(value, [
    "schemaVersion",
    "jobId",
    "attemptId",
    "reportId",
    "reportVersionId",
    "reportVersionNumber",
    "draftHash",
  ]);
  if (
    value["schemaVersion"] !==
      SCOUTING_REPORT_COMPLETION_POINTER_SCHEMA_VERSION ||
    typeof value["jobId"] !== "string" ||
    !JOB_ID.test(value["jobId"]) ||
    typeof value["reportId"] !== "string" ||
    !REPORT_ID.test(value["reportId"]) ||
    typeof value["reportVersionId"] !== "string" ||
    !REPORT_VERSION_ID.test(value["reportVersionId"]) ||
    typeof value["draftHash"] !== "string" ||
    !HEX64.test(value["draftHash"]) ||
    !Number.isSafeInteger(value["reportVersionNumber"]) ||
    Number(value["reportVersionNumber"]) < 1
  )
    invalid("report-completion-pointer-invalid");
  const jobId = value["jobId"] as string;
  let attemptId: string;
  try {
    attemptId = validAttemptIdForJob(jobId, value["attemptId"]);
  } catch {
    return invalid("report-completion-pointer-invalid");
  }
  if (
    createScoutingReportVersionId(
      value["reportId"] as string,
      jobId,
      value["draftHash"] as string,
    ) !== value["reportVersionId"]
  )
    invalid("report-completion-pointer-invalid");
  return Object.freeze({
    schemaVersion: SCOUTING_REPORT_COMPLETION_POINTER_SCHEMA_VERSION,
    jobId,
    attemptId,
    reportId: value["reportId"] as string,
    reportVersionId: value["reportVersionId"] as string,
    reportVersionNumber: Number(value["reportVersionNumber"]),
    draftHash: value["draftHash"] as string,
  });
}

/** Projects the completion pointer into the minimal schema-v2 job binding. */
export const toScoutingReportBinding = (
  pointer: ScoutingReportCompletionPointer,
): ScoutingReportBinding =>
  Object.freeze({
    reportId: pointer.reportId,
    reportVersionId: pointer.reportVersionId,
    reportVersionNumber: pointer.reportVersionNumber,
  });

/** Enforces the 196,608 UTF-8 byte cap on an already-serialized envelope. */
export function assertScoutingReportEnvelopeBytes(serialized: string): string {
  if (
    typeof serialized !== "string" ||
    utf8ByteLength(serialized) > SCOUTING_REPORT_ENVELOPE_MAX_BYTES
  )
    invalid("report-envelope-oversized");
  return serialized;
}

/** Canonical serialized version envelope: normalized record, canonical JSON. */
export function createScoutingReportVersionEnvelope(
  version: ScoutingReportVersionRecord,
): string {
  return assertScoutingReportEnvelopeBytes(
    canonicalScoutingReportJson(normalizeScoutingReportVersion(version)),
  );
}

/** Reads an envelope back; anything non-canonical is rejected as corrupt. */
export function parseScoutingReportVersionEnvelope(
  serialized: string,
): ScoutingReportVersionRecord {
  assertScoutingReportEnvelopeBytes(serialized);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid("report-storage-corrupt");
  }
  const record = normalizeScoutingReportVersion(parsed);
  if (canonicalScoutingReportJson(record) !== serialized)
    invalid("report-storage-corrupt");
  return record;
}
