import type { EventStatus } from "./index";

export const EVENT_METADATA_POLICY_VERSION = 1 as const;
export const EVENT_METADATA_FRESHNESS_THRESHOLD_SECONDS = 2 * 60 * 60;
export const EVENT_LIFECYCLE_STATES = [
  "scheduled",
  "postponed",
  "cancelled",
  "started",
  "completed",
  "unknown",
] as const satisfies readonly EventStatus[];

export type EventLifecycleState = EventStatus;
export type EventMetadataAvailability = "complete" | "partial" | "unavailable";
export type EventMetadataFreshnessState = "current" | "stale" | "unavailable";
export type EventMetadataReasonCode =
  | "lifecycle-known"
  | "lifecycle-unavailable"
  | "evidence-current"
  | "evidence-stale"
  | "evidence-time-missing"
  | "evidence-time-malformed"
  | "evidence-time-future";
export type EventMetadataMissingReason =
  "missing-evidence-time" | "malformed-evidence-time" | "future-evidence-time";

export interface EventMetadataAssessment {
  readonly policyVersion: 1;
  readonly evaluatedAt: string;
  readonly lifecycle: {
    readonly state: EventLifecycleState;
    readonly known: boolean;
  };
  readonly availability: EventMetadataAvailability;
  readonly freshness: {
    readonly state: EventMetadataFreshnessState;
    readonly evidenceAt: string | null;
    readonly ageSeconds: number | null;
    readonly thresholdSeconds: number;
    readonly missingReason: EventMetadataMissingReason | null;
  };
  readonly reasonCodes: readonly EventMetadataReasonCode[];
}

const canonicalIso = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export const assessEventMetadata = (
  status: EventStatus,
  evidenceAt: unknown,
  evaluatedAt: string,
): EventMetadataAssessment => {
  if (!EVENT_LIFECYCLE_STATES.includes(status))
    throw new Error("invalid-event-lifecycle");
  if (!canonicalIso(evaluatedAt)) throw new Error("invalid-evaluation-time");
  const evaluatedMs = Date.parse(evaluatedAt);
  const known = status !== "unknown";
  let freshness: EventMetadataAssessment["freshness"];
  let freshnessReason: EventMetadataReasonCode;
  if (evidenceAt === null || evidenceAt === undefined || evidenceAt === "") {
    freshness = {
      state: "unavailable",
      evidenceAt: null,
      ageSeconds: null,
      thresholdSeconds: EVENT_METADATA_FRESHNESS_THRESHOLD_SECONDS,
      missingReason: "missing-evidence-time",
    };
    freshnessReason = "evidence-time-missing";
  } else if (!canonicalIso(evidenceAt)) {
    freshness = {
      state: "unavailable",
      evidenceAt: null,
      ageSeconds: null,
      thresholdSeconds: EVENT_METADATA_FRESHNESS_THRESHOLD_SECONDS,
      missingReason: "malformed-evidence-time",
    };
    freshnessReason = "evidence-time-malformed";
  } else if (Date.parse(evidenceAt) > evaluatedMs) {
    freshness = {
      state: "unavailable",
      evidenceAt,
      ageSeconds: null,
      thresholdSeconds: EVENT_METADATA_FRESHNESS_THRESHOLD_SECONDS,
      missingReason: "future-evidence-time",
    };
    freshnessReason = "evidence-time-future";
  } else {
    const ageSeconds = (evaluatedMs - Date.parse(evidenceAt)) / 1000;
    const state =
      ageSeconds <= EVENT_METADATA_FRESHNESS_THRESHOLD_SECONDS
        ? "current"
        : "stale";
    freshness = {
      state,
      evidenceAt,
      ageSeconds,
      thresholdSeconds: EVENT_METADATA_FRESHNESS_THRESHOLD_SECONDS,
      missingReason: null,
    };
    freshnessReason =
      state === "current" ? "evidence-current" : "evidence-stale";
  }
  const availability: EventMetadataAvailability =
    freshness.state === "unavailable"
      ? "unavailable"
      : known
        ? "complete"
        : "partial";
  return {
    policyVersion: EVENT_METADATA_POLICY_VERSION,
    evaluatedAt,
    lifecycle: { state: status, known },
    availability,
    freshness,
    reasonCodes: [
      known ? "lifecycle-known" : "lifecycle-unavailable",
      freshnessReason,
    ],
  };
};

export const validateEventMetadataAssessment = (
  value: unknown,
  status: EventStatus,
  evidenceAt: unknown,
  evaluatedAt: string,
): EventMetadataAssessment => {
  const expected = assessEventMetadata(status, evidenceAt, evaluatedAt);
  const exactKeys = (candidate: object, keys: readonly string[]) =>
    Object.keys(candidate).length === keys.length &&
    keys.every((key) => Object.hasOwn(candidate, key));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "policyVersion",
      "evaluatedAt",
      "lifecycle",
      "availability",
      "freshness",
      "reasonCodes",
    ])
  )
    throw new Error("invalid-event-metadata-assessment");
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !candidate["lifecycle"] ||
    typeof candidate["lifecycle"] !== "object" ||
    Array.isArray(candidate["lifecycle"]) ||
    !candidate["freshness"] ||
    typeof candidate["freshness"] !== "object" ||
    Array.isArray(candidate["freshness"]) ||
    !Array.isArray(candidate["reasonCodes"])
  )
    throw new Error("invalid-event-metadata-assessment");
  const candidateLifecycle = candidate["lifecycle"] as Readonly<
      Record<string, unknown>
    >,
    candidateFreshness = candidate["freshness"] as Readonly<
      Record<string, unknown>
    >;
  if (
    !exactKeys(candidateLifecycle, ["state", "known"]) ||
    !exactKeys(candidateFreshness, [
      "state",
      "evidenceAt",
      "ageSeconds",
      "thresholdSeconds",
      "missingReason",
    ]) ||
    candidate["policyVersion"] !== expected.policyVersion ||
    candidate["evaluatedAt"] !== expected.evaluatedAt ||
    candidate["availability"] !== expected.availability ||
    candidateLifecycle["state"] !== expected.lifecycle.state ||
    candidateLifecycle["known"] !== expected.lifecycle.known ||
    candidateFreshness["state"] !== expected.freshness.state ||
    candidateFreshness["evidenceAt"] !== expected.freshness.evidenceAt ||
    candidateFreshness["ageSeconds"] !== expected.freshness.ageSeconds ||
    candidateFreshness["thresholdSeconds"] !==
      expected.freshness.thresholdSeconds ||
    candidateFreshness["missingReason"] !== expected.freshness.missingReason ||
    candidate["reasonCodes"].length !== expected.reasonCodes.length ||
    !candidate["reasonCodes"].every(
      (reason, index) => reason === expected.reasonCodes[index],
    )
  )
    throw new Error("invalid-event-metadata-assessment");
  return expected;
};
