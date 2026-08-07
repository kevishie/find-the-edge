import { canonicalCalculationJson } from "../calculation-provenance.js";
import {
  normalizeOpportunityCandidate,
  opportunityBlockingReasonCodes,
  type OpportunityCandidate,
  type OpportunityBlockingReasonCode,
} from "../opportunity-candidate.js";
import { sha256Hex } from "../fixture-odds.js";
import type { EventStatus } from "../index.js";

export const OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION =
  "opportunity-lifecycle-v1" as const;
export const opportunityLifecycleStates = [
  "active",
  "stale",
  "suspended",
  "disqualified",
  "closed",
] as const;
export type OpportunityLifecycleState =
  (typeof opportunityLifecycleStates)[number];

export const opportunityLifecycleReasonCodes = [
  "candidate-disqualified",
  "candidate-evidence-stale",
  "candidate-suspended",
  "event-cancelled",
  "event-completed",
  "event-evidence-indeterminate",
  "event-evidence-missing",
  "event-postponed",
  "event-start-reached",
  "event-started",
  "event-status-unknown",
  "event-version-superseded",
] as const;
export type OpportunityLifecycleReasonCode =
  (typeof opportunityLifecycleReasonCodes)[number];
export type OpportunityLifecycleCause = "candidate" | "sweep";

export interface OpportunityLifecycleEventEvidence {
  readonly availability: "current" | "missing" | "indeterminate";
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number | null;
  readonly sportKey: string | null;
  readonly status: EventStatus | null;
  readonly startsAt: string | null;
  readonly observedAt: string | null;
  readonly identity: string;
  readonly evidenceId: string;
}

export interface OpportunityLifecycleHead {
  readonly schemaVersion: typeof OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION;
  readonly logicalOpportunityId: string;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly state: OpportunityLifecycleState;
  readonly stateVersion: number;
  readonly latestCandidateOccurrenceId: string;
  readonly latestCandidateEvaluatedAt: string;
  readonly reasonCodes: readonly OpportunityLifecycleReasonCode[];
  readonly candidateReasonCodes: readonly OpportunityBlockingReasonCode[];
  readonly expiresAt: string | null;
  readonly eventEvidence: OpportunityLifecycleEventEvidence;
  readonly transitionedAt: string;
  readonly lastTransitionId: string;
  readonly lastCommandId: string;
  readonly activePk?: string;
  readonly activeSk?: string;
}

export interface OpportunityLifecycleTransition {
  readonly schemaVersion: typeof OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION;
  readonly transitionId: string;
  readonly commandId: string;
  readonly logicalOpportunityId: string;
  readonly sourceCandidateOccurrenceId: string;
  readonly cause: OpportunityLifecycleCause;
  readonly fromState: OpportunityLifecycleState | null;
  readonly toState: OpportunityLifecycleState;
  readonly previousStateVersion: number;
  readonly stateVersion: number;
  readonly reasonCodes: readonly OpportunityLifecycleReasonCode[];
  readonly candidateReasonCodes: readonly OpportunityBlockingReasonCode[];
  readonly previousExpiresAt: string | null;
  readonly expiresAt: string | null;
  readonly eventEvidence: OpportunityLifecycleEventEvidence;
  readonly transitionedAt: string;
}

export interface OpportunityLifecycleCommand {
  readonly commandId: string;
  readonly cause: OpportunityLifecycleCause;
  readonly candidate: OpportunityCandidate;
  readonly eventEvidence: OpportunityLifecycleEventEvidence;
  readonly occurredAt: string;
}

export type OpportunityLifecycleDecision =
  | {
      readonly outcome: "applied";
      readonly head: OpportunityLifecycleHead;
      readonly transition: OpportunityLifecycleTransition;
    }
  | {
      readonly outcome: "duplicate" | "ignored-older" | "closed" | "noop";
      readonly head: OpportunityLifecycleHead;
    };

const SAFE = /^[\x21-\x7e]{1,512}$/;
const states = new Set<string>(opportunityLifecycleStates);
const reasons = new Set<string>(opportunityLifecycleReasonCodes);
const candidateReasons = new Set<string>(opportunityBlockingReasonCodes);
const iso = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`${label}-invalid`);
  return value;
};
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SAFE.test(value))
    throw new Error(`${label}-invalid`);
  return value;
};
const sorted = <T extends string>(values: readonly T[]): readonly T[] =>
  Object.freeze([...new Set(values)].sort());

export function normalizeOpportunityLifecycleEventEvidence(
  value: OpportunityLifecycleEventEvidence,
): OpportunityLifecycleEventEvidence {
  if (!["current", "missing", "indeterminate"].includes(value.availability))
    throw new Error("opportunity-event-evidence-invalid");
  const canonicalEventId = id(value.canonicalEventId, "opportunity-event-id");
  const identity = id(value.identity, "opportunity-event-evidence-identity");
  const evidenceId = id(value.evidenceId, "opportunity-event-evidence-id");
  if (value.availability !== "current") {
    if (
      value.canonicalEventVersion !== null ||
      value.sportKey !== null ||
      value.status !== null ||
      value.startsAt !== null ||
      value.observedAt !== null
    )
      throw new Error("opportunity-event-evidence-invalid");
    return Object.freeze({ ...value, canonicalEventId, identity, evidenceId });
  }
  if (
    !Number.isSafeInteger(value.canonicalEventVersion) ||
    (value.canonicalEventVersion ?? 0) < 1 ||
    typeof value.sportKey !== "string" ||
    !SAFE.test(value.sportKey) ||
    value.status === null ||
    ![
      "scheduled",
      "postponed",
      "cancelled",
      "started",
      "completed",
      "unknown",
    ].includes(value.status) ||
    value.startsAt === null ||
    value.observedAt === null
  )
    throw new Error("opportunity-event-evidence-invalid");
  return Object.freeze({
    ...value,
    canonicalEventId,
    identity,
    evidenceId,
    startsAt: iso(value.startsAt, "opportunity-event-start"),
    observedAt: iso(value.observedAt, "opportunity-event-observed-at"),
  });
}

export function opportunityCandidateExpiresAt(
  candidateValue: OpportunityCandidate,
  event: OpportunityLifecycleEventEvidence,
): string | null {
  const candidate = normalizeOpportunityCandidate(candidateValue);
  const normalizedEvent = normalizeOpportunityLifecycleEventEvidence(event);
  if (
    candidate.status !== "qualified" ||
    normalizedEvent.availability !== "current"
  )
    return null;
  const requiredBooks = [
    candidate.logicalIdentity.targetSportsbookId,
    ...candidate.includedComparisonSportsbookIds,
  ];
  const requiredSnapshots = requiredBooks.flatMap((sportsbookId) => {
    const snapshots =
      sportsbookId === candidate.logicalIdentity.targetSportsbookId
        ? candidate.targetEvidence.filter(
            (snapshot) => snapshot.sportsbookId === sportsbookId,
          )
        : candidate.comparisonEvidence.filter(
            (snapshot) => snapshot.sportsbookId === sportsbookId,
          );
    if (snapshots.length === 0)
      throw new Error("opportunity-expiration-evidence-incomplete");
    return snapshots;
  });
  const requiredHealth = requiredBooks.map((sportsbookId) => {
    const records = candidate.providerHealth.filter(
      (health) => health.sportsbookId === sportsbookId,
    );
    if (records.length !== 1)
      throw new Error("opportunity-expiration-health-ambiguous");
    const record = records[0]!;
    if (!record.healthy)
      throw new Error("opportunity-expiration-evidence-incomplete");
    return record;
  });
  const oldest = Math.min(
    ...requiredSnapshots.map(({ observedAt }) => Date.parse(observedAt)),
    ...requiredHealth.map(({ checkedAt }) => Date.parse(checkedAt)),
  );
  const firstStale =
    Math.floor(
      oldest + candidate.qualificationGates.maximumPriceAgeMinutes * 60_000,
    ) + 1;
  return new Date(
    Math.min(firstStale, Date.parse(normalizedEvent.startsAt!)),
  ).toISOString();
}

function requiredProviderHealth(candidate: OpportunityCandidate) {
  const requiredBooks = [
    candidate.logicalIdentity.targetSportsbookId,
    ...candidate.includedComparisonSportsbookIds,
  ];
  return requiredBooks.map((sportsbookId) => {
    const records = candidate.providerHealth.filter(
      (record) => record.sportsbookId === sportsbookId,
    );
    if (records.length > 1)
      throw new Error("opportunity-lifecycle-health-ambiguous");
    return records[0] ?? null;
  });
}

function candidateSuspended(candidate: OpportunityCandidate): boolean {
  const health = requiredProviderHealth(candidate);
  if (
    candidate.reasonCodes.some((reason) =>
      [
        "event-not-scheduled",
        "target-missing",
        "target-provider-unhealthy",
        "target-unavailable",
      ].includes(reason),
    )
  )
    return true;
  return health.some(
    (record) =>
      record === null ||
      ["degraded", "unhealthy", "missing"].includes(record.status),
  );
}

function candidateStale(candidate: OpportunityCandidate): boolean {
  const health = requiredProviderHealth(candidate);
  if (candidate.reasonCodes.includes("target-stale")) return true;
  return health.some((record) => record?.status === "stale");
}

function classify(
  candidate: OpportunityCandidate,
  event: OpportunityLifecycleEventEvidence,
  occurredAt: string,
): {
  readonly state: OpportunityLifecycleState;
  readonly reasonCodes: readonly OpportunityLifecycleReasonCode[];
  readonly expiresAt: string | null;
} {
  if (event.availability === "current") {
    if (
      event.canonicalEventVersion! <
      candidate.logicalIdentity.canonicalEventVersion
    )
      return {
        state: "suspended",
        reasonCodes: ["event-evidence-indeterminate"],
        expiresAt: null,
      };
    if (
      event.canonicalEventVersion! >
      candidate.logicalIdentity.canonicalEventVersion
    )
      return {
        state: "closed",
        reasonCodes: ["event-version-superseded"],
        expiresAt: null,
      };
    if (event.status === "cancelled")
      return {
        state: "closed",
        reasonCodes: ["event-cancelled"],
        expiresAt: null,
      };
    if (event.status === "completed")
      return {
        state: "closed",
        reasonCodes: ["event-completed"],
        expiresAt: null,
      };
    if (event.status === "started")
      return {
        state: "closed",
        reasonCodes: ["event-started"],
        expiresAt: null,
      };
    if (Date.parse(occurredAt) >= Date.parse(event.startsAt!))
      return {
        state: "closed",
        reasonCodes: ["event-start-reached"],
        expiresAt: null,
      };
  }
  if (event.availability === "missing")
    return {
      state: "suspended",
      reasonCodes: ["event-evidence-missing"],
      expiresAt: null,
    };
  if (event.availability === "indeterminate")
    return {
      state: "suspended",
      reasonCodes: ["event-evidence-indeterminate"],
      expiresAt: null,
    };
  if (event.status === "postponed")
    return {
      state: "suspended",
      reasonCodes: ["event-postponed"],
      expiresAt: null,
    };
  if (event.status === "unknown")
    return {
      state: "suspended",
      reasonCodes: ["event-status-unknown"],
      expiresAt: null,
    };
  if (candidateSuspended(candidate))
    return {
      state: "suspended",
      reasonCodes: ["candidate-suspended"],
      expiresAt: null,
    };
  if (candidateStale(candidate))
    return {
      state: "stale",
      reasonCodes: ["candidate-evidence-stale"],
      expiresAt: null,
    };
  if (candidate.status === "disqualified")
    return {
      state: "disqualified",
      reasonCodes: ["candidate-disqualified"],
      expiresAt: null,
    };
  const expiresAt = opportunityCandidateExpiresAt(candidate, event);
  if (expiresAt === null || Date.parse(occurredAt) >= Date.parse(expiresAt))
    return {
      state: "stale",
      reasonCodes: ["candidate-evidence-stale"],
      expiresAt: null,
    };
  return { state: "active", reasonCodes: [], expiresAt };
}

const activeKeys = (
  state: OpportunityLifecycleState,
  sportKey: string,
  expiresAt: string | null,
  logicalOpportunityId: string,
) =>
  state === "active" && expiresAt
    ? {
        activePk: `ACTIVE_OPPORTUNITY#${sportKey}`,
        activeSk: `${expiresAt}#${logicalOpportunityId}`,
      }
    : {};

export function reduceOpportunityLifecycle(
  existing: OpportunityLifecycleHead | null,
  input: OpportunityLifecycleCommand,
): OpportunityLifecycleDecision {
  const candidate = normalizeOpportunityCandidate(input.candidate);
  const eventEvidence = normalizeOpportunityLifecycleEventEvidence(
    input.eventEvidence,
  );
  const occurredAt = iso(input.occurredAt, "opportunity-transition-time");
  const commandId = id(input.commandId, "opportunity-lifecycle-command");
  if (
    eventEvidence.canonicalEventId !==
      candidate.logicalIdentity.canonicalEventId ||
    eventEvidence.identity.length === 0 ||
    occurredAt < candidate.evaluatedAt ||
    (eventEvidence.availability === "current" &&
      (eventEvidence.sportKey !== candidate.logicalIdentity.sportKey ||
        Date.parse(eventEvidence.observedAt!) > Date.parse(occurredAt))) ||
    !["candidate", "sweep"].includes(input.cause)
  )
    throw new Error("opportunity-lifecycle-command-invalid");
  if (existing) {
    const head = normalizeOpportunityLifecycleHead(existing);
    if (
      head.logicalOpportunityId !== candidate.logicalOpportunityId ||
      head.canonicalEventId !== candidate.logicalIdentity.canonicalEventId
    )
      throw new Error("opportunity-lifecycle-binding-invalid");
    if (head.lastCommandId === commandId) return { outcome: "duplicate", head };
    if (head.state === "closed") return { outcome: "closed", head };
    if (occurredAt < head.transitionedAt)
      return { outcome: "ignored-older", head };
    if (candidate.evaluatedAt < head.latestCandidateEvaluatedAt)
      return { outcome: "ignored-older", head };
    if (
      candidate.evaluatedAt === head.latestCandidateEvaluatedAt &&
      candidate.occurrenceId !== head.latestCandidateOccurrenceId
    )
      throw new Error("opportunity-lifecycle-equal-time-conflict");
    if (
      input.cause === "candidate" &&
      candidate.occurrenceId === head.latestCandidateOccurrenceId
    )
      return { outcome: "noop", head };
  }
  const classified = classify(candidate, eventEvidence, occurredAt);
  const candidateReasonCodes = sorted(candidate.reasonCodes);
  const reasonCodes = sorted(classified.reasonCodes);
  if (
    existing &&
    existing.latestCandidateOccurrenceId === candidate.occurrenceId &&
    existing.state === classified.state &&
    existing.expiresAt === classified.expiresAt &&
    canonicalCalculationJson(existing.reasonCodes) ===
      canonicalCalculationJson(reasonCodes) &&
    canonicalCalculationJson(existing.eventEvidence) ===
      canonicalCalculationJson(eventEvidence)
  )
    return { outcome: "noop", head: existing };
  const previousStateVersion = existing?.stateVersion ?? 0;
  if (previousStateVersion >= Number.MAX_SAFE_INTEGER)
    throw new Error("opportunity-lifecycle-version-overflow");
  const material = {
    commandId,
    logicalOpportunityId: candidate.logicalOpportunityId,
    sourceCandidateOccurrenceId: candidate.occurrenceId,
    cause: input.cause,
    fromState: existing?.state ?? null,
    toState: classified.state,
    previousStateVersion,
    stateVersion: previousStateVersion + 1,
    reasonCodes,
    candidateReasonCodes,
    previousExpiresAt: existing?.expiresAt ?? null,
    expiresAt: classified.expiresAt,
    eventEvidence,
    transitionedAt: occurredAt,
  } as const;
  const transitionId = `opportunity-transition:${sha256Hex(
    canonicalCalculationJson(material),
  )}`;
  const transition = Object.freeze({
    schemaVersion: OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION,
    transitionId,
    ...material,
  });
  const head = Object.freeze({
    schemaVersion: OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION,
    logicalOpportunityId: candidate.logicalOpportunityId,
    canonicalEventId: candidate.logicalIdentity.canonicalEventId,
    canonicalEventVersion: candidate.logicalIdentity.canonicalEventVersion,
    sportKey: candidate.logicalIdentity.sportKey,
    state: classified.state,
    stateVersion: previousStateVersion + 1,
    latestCandidateOccurrenceId: candidate.occurrenceId,
    latestCandidateEvaluatedAt: candidate.evaluatedAt,
    reasonCodes,
    candidateReasonCodes,
    expiresAt: classified.expiresAt,
    eventEvidence,
    transitionedAt: occurredAt,
    lastTransitionId: transitionId,
    lastCommandId: commandId,
    ...activeKeys(
      classified.state,
      candidate.logicalIdentity.sportKey,
      classified.expiresAt,
      candidate.logicalOpportunityId,
    ),
  });
  return { outcome: "applied", head, transition };
}

export function normalizeOpportunityLifecycleHead(
  value: OpportunityLifecycleHead,
): OpportunityLifecycleHead {
  if (
    value.schemaVersion !== OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION ||
    !states.has(value.state) ||
    !Number.isSafeInteger(value.stateVersion) ||
    value.stateVersion < 1 ||
    !SAFE.test(value.logicalOpportunityId) ||
    !SAFE.test(value.canonicalEventId) ||
    !SAFE.test(value.sportKey) ||
    !SAFE.test(value.latestCandidateOccurrenceId) ||
    !SAFE.test(value.lastTransitionId) ||
    !SAFE.test(value.lastCommandId) ||
    !Number.isSafeInteger(value.canonicalEventVersion) ||
    value.canonicalEventVersion < 1 ||
    !value.reasonCodes.every((reason) => reasons.has(reason)) ||
    canonicalCalculationJson(value.reasonCodes) !==
      canonicalCalculationJson(sorted(value.reasonCodes)) ||
    !value.candidateReasonCodes.every((reason) =>
      candidateReasons.has(reason),
    ) ||
    canonicalCalculationJson(value.candidateReasonCodes) !==
      canonicalCalculationJson(sorted(value.candidateReasonCodes)) ||
    (value.state === "active"
      ? !value.expiresAt || !value.activePk || !value.activeSk
      : value.expiresAt !== null ||
        value.activePk !== undefined ||
        value.activeSk !== undefined) ||
    (value.state === "active" &&
      (value.activePk !== `ACTIVE_OPPORTUNITY#${value.sportKey}` ||
        value.activeSk !==
          `${value.expiresAt}#${value.logicalOpportunityId}`)) ||
    (value.expiresAt !== null &&
      iso(value.expiresAt, "opportunity-expiration") !== value.expiresAt)
  )
    throw new Error("stored-opportunity-lifecycle-invalid");
  const normalizedEvidence = normalizeOpportunityLifecycleEventEvidence(
    value.eventEvidence,
  );
  if (
    normalizedEvidence.canonicalEventId !== value.canonicalEventId ||
    (normalizedEvidence.availability === "current" &&
      (normalizedEvidence.sportKey !== value.sportKey ||
        (normalizedEvidence.canonicalEventVersion! < value.canonicalEventVersion
          ? value.state !== "suspended" ||
            !value.reasonCodes.includes("event-evidence-indeterminate")
          : normalizedEvidence.canonicalEventVersion! >
              value.canonicalEventVersion &&
            (value.state !== "closed" ||
              !value.reasonCodes.includes("event-version-superseded")))))
  )
    throw new Error("stored-opportunity-lifecycle-invalid");
  iso(value.latestCandidateEvaluatedAt, "opportunity-candidate-time");
  iso(value.transitionedAt, "opportunity-transition-time");
  return Object.freeze(structuredClone(value));
}

export function normalizeOpportunityLifecycleTransition(
  value: OpportunityLifecycleTransition,
): OpportunityLifecycleTransition {
  if (
    value.schemaVersion !== OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION ||
    !SAFE.test(value.transitionId) ||
    !SAFE.test(value.commandId) ||
    !SAFE.test(value.logicalOpportunityId) ||
    !SAFE.test(value.sourceCandidateOccurrenceId) ||
    !["candidate", "sweep"].includes(value.cause) ||
    (value.fromState !== null && !states.has(value.fromState)) ||
    !states.has(value.toState) ||
    !Number.isSafeInteger(value.previousStateVersion) ||
    value.previousStateVersion < 0 ||
    (value.previousStateVersion === 0) !== (value.fromState === null) ||
    value.stateVersion !== value.previousStateVersion + 1 ||
    !value.reasonCodes.every((reason) => reasons.has(reason)) ||
    !value.candidateReasonCodes.every((reason) =>
      candidateReasons.has(reason),
    ) ||
    (value.previousExpiresAt !== null &&
      iso(value.previousExpiresAt, "opportunity-previous-expiration") !==
        value.previousExpiresAt) ||
    (value.expiresAt !== null &&
      iso(value.expiresAt, "opportunity-expiration") !== value.expiresAt)
  )
    throw new Error("stored-opportunity-lifecycle-transition-invalid");
  normalizeOpportunityLifecycleEventEvidence(value.eventEvidence);
  iso(value.transitionedAt, "opportunity-transition-time");
  const material = {
    commandId: value.commandId,
    logicalOpportunityId: value.logicalOpportunityId,
    sourceCandidateOccurrenceId: value.sourceCandidateOccurrenceId,
    cause: value.cause,
    fromState: value.fromState,
    toState: value.toState,
    previousStateVersion: value.previousStateVersion,
    stateVersion: value.stateVersion,
    reasonCodes: sorted(value.reasonCodes),
    candidateReasonCodes: sorted(value.candidateReasonCodes),
    previousExpiresAt: value.previousExpiresAt,
    expiresAt: value.expiresAt,
    eventEvidence: normalizeOpportunityLifecycleEventEvidence(
      value.eventEvidence,
    ),
    transitionedAt: value.transitionedAt,
  };
  const transitionId = `opportunity-transition:${sha256Hex(
    canonicalCalculationJson(material),
  )}`;
  if (value.transitionId !== transitionId)
    throw new Error("stored-opportunity-lifecycle-transition-invalid");
  return Object.freeze({
    schemaVersion: OPPORTUNITY_LIFECYCLE_SCHEMA_VERSION,
    transitionId,
    ...material,
  });
}

export function isOpportunityLifecycleHeadActive(
  value: OpportunityLifecycleHead,
  asOf: string,
): boolean {
  const head = normalizeOpportunityLifecycleHead(value);
  return (
    head.state === "active" &&
    head.expiresAt !== null &&
    Date.parse(iso(asOf, "opportunity-active-as-of")) <
      Date.parse(head.expiresAt)
  );
}
