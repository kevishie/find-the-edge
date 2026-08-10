import {
  canonicalCalculationJson,
  normalizeCalculationProvenance,
  type CalculationProvenance,
} from "./calculation-provenance.js";
import {
  fixtureOddsGroupAvailabilityIdentity,
  fixtureOddsPartition,
  isFixtureOddsSnapshotActionable,
  sha256Hex,
} from "./fixture-odds.js";

export const OPPORTUNITY_CANDIDATE_SCHEMA_VERSION =
  "opportunity-candidate-v1" as const;
export const OPPORTUNITY_QUALIFICATION_ALGORITHM_ID =
  "opportunity-qualification" as const;
export const OPPORTUNITY_QUALIFICATION_VERSION =
  "opportunity-qualification-v1" as const;
/** How far a provider-health observation may lead the evaluation instant.
 * Health rows are rewritten continuously by the ingestion control plane, so
 * an observation moments ahead of evaluatedAt is concurrency, not skew. */
export const PROVIDER_HEALTH_SKEW_TOLERANCE_MS = 5 * 60_000;

export const opportunityBlockingReasonCodes = [
  "calculation-provenance-unavailable",
  "comparison-incoherent",
  "comparison-incomplete",
  "comparison-provider-unhealthy",
  "comparison-stale",
  "event-not-scheduled",
  "ev-below-threshold",
  "insufficient-comparison-books",
  "market-disagreement-blocked",
  "market-not-approved",
  "target-incoherent",
  "target-incomplete",
  "target-missing",
  "target-provider-unhealthy",
  "target-stale",
  "target-unavailable",
] as const;
export type OpportunityBlockingReasonCode =
  (typeof opportunityBlockingReasonCodes)[number];

export const opportunityWarningCodes = [
  "comparison-outlier-excluded",
  "market-disagreement-warning",
] as const;
export type OpportunityWarningCode = (typeof opportunityWarningCodes)[number];

export const opportunityComparisonExclusionReasonCodes = [
  "closed",
  "duplicate-sportsbook",
  "incoherent",
  "incomplete",
  "invalid-odds",
  "outlier",
  "provider-unhealthy",
  "stale",
  "suspended",
  "target-sportsbook",
  "unavailable",
  "unconfigured-weight",
] as const;
export type OpportunityComparisonExclusionReasonCode =
  (typeof opportunityComparisonExclusionReasonCodes)[number];

export interface OpportunityLogicalIdentityInput {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly point: number | null;
  readonly targetSportsbookId: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
}

export interface OpportunityAvailabilityEvidence {
  readonly identity: string;
  readonly evidenceId: string;
  readonly state:
    | "active"
    | "suspended"
    | "closed"
    | "stale"
    | "missing"
    | "malformed"
    | "incomplete"
    | "unavailable";
  readonly observedAt: string;
}

export interface OpportunitySnapshotEvidence {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly sportsbookId: string;
  readonly point: number | null;
  readonly americanOdds: number;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly partitionKey: string;
  readonly sortKey: string;
  readonly snapshotId: string;
  readonly selectionAvailability: OpportunityAvailabilityEvidence | null;
  readonly groupAvailability: OpportunityAvailabilityEvidence | null;
}

export interface OpportunityExcludedBookEvidence {
  readonly sportsbookId: string;
  readonly reasonCodes: readonly OpportunityComparisonExclusionReasonCode[];
  readonly snapshots: readonly OpportunitySnapshotEvidence[];
}

export interface OpportunityCandidateValues {
  readonly targetAmericanOdds: number | null;
  readonly targetImpliedProbability: number | null;
  readonly consensusProbability: number | null;
  readonly fairAmericanOdds: number | null;
  readonly expectedValue: number | null;
  readonly marketDisagreement: number | null;
}

export interface OpportunityCandidateVersions {
  readonly sportModule: { readonly id: string; readonly version: string };
  readonly strategy: { readonly id: string; readonly version: string };
  readonly evaluationPolicy: {
    readonly id: string;
    readonly version: string;
  };
  readonly calculation: Readonly<CalculationProvenance>;
}

export interface OpportunityCandidateInput {
  readonly logicalIdentity: OpportunityLogicalIdentityInput;
  readonly evaluatedAt: string;
  readonly qualificationGates: {
    readonly eventStatus: "scheduled" | "not-scheduled";
    readonly marketApproved: boolean;
    readonly minimumComparisonBooks: number;
    readonly maximumPriceAgeMinutes: number;
    readonly minimumExpectedValue: number;
    readonly disagreementWarningThreshold: number;
    readonly disagreementBlockThreshold: number;
  };
  readonly status: "qualified" | "disqualified";
  readonly reasonCodes: readonly OpportunityBlockingReasonCode[];
  readonly warningCodes: readonly OpportunityWarningCode[];
  readonly values: OpportunityCandidateValues;
  readonly targetEvidence: readonly OpportunitySnapshotEvidence[];
  readonly comparisonEvidence: readonly OpportunitySnapshotEvidence[];
  readonly includedComparisonSportsbookIds: readonly string[];
  readonly excludedComparisonBooks: readonly OpportunityExcludedBookEvidence[];
  readonly providerHealth: readonly {
    readonly providerId: string;
    readonly sportsbookId: string;
    readonly healthy: boolean;
    readonly checkedAt: string;
    readonly healthKey: string;
    readonly evidenceId: string;
    readonly leagueKey: string;
    readonly capability: "odds";
    readonly recordVersion: number;
    readonly status: "healthy" | "degraded" | "unhealthy" | "missing" | "stale";
  }[];
  readonly versions: OpportunityCandidateVersions;
}

export interface OpportunityCandidate extends OpportunityCandidateInput {
  readonly schemaVersion: typeof OPPORTUNITY_CANDIDATE_SCHEMA_VERSION;
  readonly logicalOpportunityId: string;
  readonly occurrenceId: string;
}

const SAFE = /^[\x21-\x7e]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const blockingReasons = new Set<string>(opportunityBlockingReasonCodes);
const warningCodes = new Set<string>(opportunityWarningCodes);
const exclusionReasons = new Set<string>(
  opportunityComparisonExclusionReasonCodes,
);
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE.test(value))
    throw new Error(`${label}-invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value)
    throw new Error(`${label}-invalid`);
  return value;
}

function finiteOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label}-invalid`);
  return Object.is(value, -0) ? 0 : value;
}

function uniqueSorted<T extends string>(
  values: readonly T[],
  allowed: ReadonlySet<string> | null,
  label: string,
): readonly T[] {
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        !SAFE.test(value) ||
        (allowed !== null && !allowed.has(value)),
    )
  )
    throw new Error(`${label}-invalid`);
  return Object.freeze([...new Set(values)].sort(compareText));
}

function normalizeAvailability(
  value: OpportunityAvailabilityEvidence | null,
): OpportunityAvailabilityEvidence | null {
  if (value === null) return null;
  if (
    ![
      "active",
      "suspended",
      "closed",
      "stale",
      "missing",
      "malformed",
      "incomplete",
      "unavailable",
    ].includes(value.state)
  )
    throw new Error("opportunity-availability-state-invalid");
  return Object.freeze({
    identity: id(value.identity, "opportunity-availability-identity"),
    evidenceId: id(value.evidenceId, "opportunity-availability-evidence"),
    state: value.state,
    observedAt: timestamp(
      value.observedAt,
      "opportunity-availability-observed-at",
    ),
  });
}

function normalizeSnapshot(
  value: OpportunitySnapshotEvidence,
): OpportunitySnapshotEvidence {
  if (
    !Number.isSafeInteger(value.canonicalEventVersion) ||
    value.canonicalEventVersion < 1 ||
    !Number.isSafeInteger(value.americanOdds) ||
    value.americanOdds === 0 ||
    Math.abs(value.americanOdds) < 100 ||
    Math.abs(value.americanOdds) > 100_000
  )
    throw new Error("opportunity-snapshot-value-invalid");
  const point = finiteOrNull(value.point, "opportunity-snapshot-point");
  return Object.freeze({
    canonicalEventId: id(value.canonicalEventId, "opportunity-event-id"),
    canonicalEventVersion: value.canonicalEventVersion,
    sportKey: id(value.sportKey, "opportunity-sport-key"),
    marketKey: id(value.marketKey, "opportunity-market-key"),
    selectionKey: id(value.selectionKey, "opportunity-selection-key"),
    sportsbookId: id(value.sportsbookId, "opportunity-sportsbook-id"),
    point,
    americanOdds: value.americanOdds,
    observedAt: timestamp(value.observedAt, "opportunity-observed-at"),
    retrievedAt: timestamp(value.retrievedAt, "opportunity-retrieved-at"),
    partitionKey: id(value.partitionKey, "opportunity-partition-key"),
    sortKey: id(value.sortKey, "opportunity-sort-key"),
    snapshotId: id(value.snapshotId, "opportunity-snapshot-id"),
    selectionAvailability: normalizeAvailability(value.selectionAvailability),
    groupAvailability: normalizeAvailability(value.groupAvailability),
  });
}

function snapshotOrder(
  left: OpportunitySnapshotEvidence,
  right: OpportunitySnapshotEvidence,
): number {
  return (
    compareText(left.sportsbookId, right.sportsbookId) ||
    compareText(left.selectionKey, right.selectionKey) ||
    compareText(left.snapshotId, right.snapshotId)
  );
}

export function isOpportunityPointVectorCoherent(
  marketKey: string,
  evidence: readonly Pick<
    OpportunitySnapshotEvidence,
    "selectionKey" | "point"
  >[],
): boolean {
  if (evidence.length !== 2 && evidence.length !== 3) return false;
  if (
    new Set(evidence.map(({ selectionKey }) => selectionKey)).size !==
    evidence.length
  )
    return false;
  const points = evidence.map(({ point }) => point);
  if (evidence.length === 3) return points.every((point) => point === null);
  const key = marketKey.toLowerCase();
  if (key.includes("moneyline") || key === "ml" || key.includes("both-teams"))
    return points.every((point) => point === null);
  if (key.includes("spread") || key.includes("handicap"))
    return (
      points.every((point) => point !== null) &&
      Math.abs((points[0] ?? 0) + (points[1] ?? 0)) < 1e-9
    );
  if (key.includes("total"))
    return points.every((point) => point !== null) && points[0] === points[1];
  return (
    points.every((point) => point === null) ||
    (points.every((point) => point !== null) && points[0] === points[1])
  );
}

function snapshotIdentityValid(snapshot: OpportunitySnapshotEvidence): boolean {
  const partition = fixtureOddsPartition(snapshot);
  return (
    snapshot.partitionKey === partition.key &&
    snapshot.sortKey ===
      `SNAPSHOT#${snapshot.observedAt}#${snapshot.snapshotId}` &&
    Date.parse(snapshot.observedAt) <= Date.parse(snapshot.retrievedAt) &&
    snapshot.selectionAvailability?.identity === snapshot.partitionKey &&
    snapshot.groupAvailability?.identity ===
      fixtureOddsGroupAvailabilityIdentity(snapshot)
  );
}

function sameSnapshot(
  left: OpportunitySnapshotEvidence,
  right: OpportunitySnapshotEvidence,
) {
  return canonicalCalculationJson(left) === canonicalCalculationJson(right);
}

function normalizedLogicalIdentity(
  value: OpportunityLogicalIdentityInput,
): OpportunityLogicalIdentityInput {
  if (
    !Number.isSafeInteger(value.canonicalEventVersion) ||
    value.canonicalEventVersion < 1
  )
    throw new Error("opportunity-event-version-invalid");
  return Object.freeze({
    canonicalEventId: id(value.canonicalEventId, "opportunity-event-id"),
    canonicalEventVersion: value.canonicalEventVersion,
    sportKey: id(value.sportKey, "opportunity-sport-key"),
    marketKey: id(value.marketKey, "opportunity-market-key"),
    selectionKey: id(value.selectionKey, "opportunity-selection-key"),
    point: finiteOrNull(value.point, "opportunity-point"),
    targetSportsbookId: id(
      value.targetSportsbookId,
      "opportunity-target-sportsbook",
    ),
    strategyId: id(value.strategyId, "opportunity-strategy-id"),
    strategyVersion: id(value.strategyVersion, "opportunity-strategy-version"),
  });
}

function frozenRef(value: { readonly id: string; readonly version: string }) {
  return Object.freeze({
    id: id(value.id, "opportunity-version-id"),
    version: id(value.version, "opportunity-version"),
  });
}

export function createOpportunityCandidate(
  input: OpportunityCandidateInput,
): OpportunityCandidate {
  if (input.status !== "qualified" && input.status !== "disqualified")
    throw new Error("opportunity-status-invalid");
  const logicalIdentity = normalizedLogicalIdentity(input.logicalIdentity);
  const reasonCodes = uniqueSorted(
    input.reasonCodes,
    blockingReasons,
    "opportunity-reasons",
  );
  const warnings = uniqueSorted(
    input.warningCodes,
    warningCodes,
    "opportunity-warnings",
  );
  if (
    (input.status === "qualified" && reasonCodes.length > 0) ||
    (input.status === "disqualified" && reasonCodes.length === 0)
  )
    throw new Error("opportunity-status-reasons-invalid");
  if (
    reasonCodes.includes("event-not-scheduled") !==
      (input.qualificationGates.eventStatus === "not-scheduled") ||
    reasonCodes.includes("market-not-approved") !==
      !input.qualificationGates.marketApproved
  )
    throw new Error("opportunity-gate-reasons-invalid");
  const targetEvidence = Object.freeze(
    input.targetEvidence.map(normalizeSnapshot).sort(snapshotOrder),
  );
  const comparisonEvidence = Object.freeze(
    input.comparisonEvidence.map(normalizeSnapshot).sort(snapshotOrder),
  );
  const allEvidence = [...targetEvidence, ...comparisonEvidence];
  if (
    new Set(allEvidence.map((item) => item.snapshotId)).size !==
    allEvidence.length
  )
    throw new Error("opportunity-evidence-duplicate");
  for (const evidence of allEvidence)
    if (
      evidence.canonicalEventId !== logicalIdentity.canonicalEventId ||
      evidence.canonicalEventVersion !==
        logicalIdentity.canonicalEventVersion ||
      evidence.sportKey !== logicalIdentity.sportKey ||
      evidence.marketKey !== logicalIdentity.marketKey
    )
      throw new Error("opportunity-evidence-binding-invalid");
  const evaluatedAt = timestamp(input.evaluatedAt, "opportunity-evaluated-at");
  for (const evidence of allEvidence) {
    if (!snapshotIdentityValid(evidence))
      throw new Error("opportunity-evidence-identity-invalid");
    if (Date.parse(evidence.retrievedAt) > Date.parse(evaluatedAt))
      throw new Error("opportunity-evidence-from-future");
    if (
      (evidence.selectionAvailability !== null &&
        Date.parse(evidence.selectionAvailability.observedAt) >
          Date.parse(evaluatedAt)) ||
      (evidence.groupAvailability !== null &&
        Date.parse(evidence.groupAvailability.observedAt) >
          Date.parse(evaluatedAt))
    )
      throw new Error("opportunity-availability-from-future");
  }
  if (
    targetEvidence.some(
      ({ sportsbookId }) => sportsbookId !== logicalIdentity.targetSportsbookId,
    ) ||
    comparisonEvidence.some(
      ({ sportsbookId }) => sportsbookId === logicalIdentity.targetSportsbookId,
    )
  )
    throw new Error("opportunity-target-exclusion-invalid");
  const selectedTargetEvidence = targetEvidence.find(
    ({ selectionKey }) => selectionKey === logicalIdentity.selectionKey,
  );
  if (
    selectedTargetEvidence &&
    selectedTargetEvidence.point !== logicalIdentity.point
  )
    throw new Error("opportunity-selection-point-binding-invalid");
  const includedComparisonSportsbookIds = uniqueSorted(
    input.includedComparisonSportsbookIds,
    null,
    "opportunity-included-books",
  );
  if (
    includedComparisonSportsbookIds.includes(logicalIdentity.targetSportsbookId)
  )
    throw new Error("opportunity-target-exclusion-invalid");
  const excludedComparisonBooks = Object.freeze(
    input.excludedComparisonBooks
      .map((book) =>
        Object.freeze({
          sportsbookId: id(
            book.sportsbookId,
            "opportunity-excluded-sportsbook",
          ),
          reasonCodes: uniqueSorted(
            book.reasonCodes,
            exclusionReasons,
            "opportunity-excluded-reasons",
          ),
          snapshots: Object.freeze(
            book.snapshots.map(normalizeSnapshot).sort(snapshotOrder),
          ),
        }),
      )
      .sort((left, right) =>
        compareText(left.sportsbookId, right.sportsbookId),
      ),
  );
  if (
    new Set(excludedComparisonBooks.map(({ sportsbookId }) => sportsbookId))
      .size !== excludedComparisonBooks.length ||
    excludedComparisonBooks.some(
      ({ sportsbookId, reasonCodes: excludedReasons, snapshots }) =>
        sportsbookId === logicalIdentity.targetSportsbookId ||
        excludedReasons.length === 0 ||
        snapshots.some(
          (snapshot) =>
            snapshot.sportsbookId !== sportsbookId ||
            snapshot.canonicalEventId !== logicalIdentity.canonicalEventId ||
            snapshot.canonicalEventVersion !==
              logicalIdentity.canonicalEventVersion ||
            snapshot.sportKey !== logicalIdentity.sportKey ||
            snapshot.marketKey !== logicalIdentity.marketKey ||
            !comparisonEvidence.some((evidence) =>
              sameSnapshot(evidence, snapshot),
            ),
        ),
    ) ||
    excludedComparisonBooks.some(({ sportsbookId }) =>
      includedComparisonSportsbookIds.includes(sportsbookId),
    )
  )
    throw new Error("opportunity-excluded-books-invalid");
  const excludedSnapshots = excludedComparisonBooks.flatMap(
    ({ snapshots }) => snapshots,
  );
  if (
    new Set(excludedSnapshots.map(({ snapshotId }) => snapshotId)).size !==
    excludedSnapshots.length
  )
    throw new Error("opportunity-excluded-evidence-duplicate");
  const providerHealth = Object.freeze(
    input.providerHealth
      .map((health) =>
        Object.freeze({
          providerId: id(health.providerId, "opportunity-provider-id"),
          sportsbookId: id(
            health.sportsbookId,
            "opportunity-provider-sportsbook",
          ),
          healthy: health.healthy,
          checkedAt: timestamp(
            health.checkedAt,
            "opportunity-provider-checked-at",
          ),
          healthKey: id(health.healthKey, "opportunity-provider-health-key"),
          evidenceId: id(
            health.evidenceId,
            "opportunity-provider-health-evidence",
          ),
          leagueKey: id(health.leagueKey, "opportunity-provider-health-league"),
          capability: health.capability,
          recordVersion: health.recordVersion,
          status: health.status,
        }),
      )
      .sort(
        (left, right) =>
          compareText(left.sportsbookId, right.sportsbookId) ||
          compareText(left.providerId, right.providerId),
      ),
  );
  if (
    providerHealth.some(
      ({ healthy, capability, recordVersion, status, checkedAt }) =>
        typeof healthy !== "boolean" ||
        capability !== "odds" ||
        !Number.isSafeInteger(recordVersion) ||
        recordVersion < 0 ||
        !["healthy", "degraded", "unhealthy", "missing", "stale"].includes(
          status,
        ) ||
        healthy !== (status === "healthy") ||
        // The control plane rewrites health rows continuously, so a row
        // observed moments after the evaluation instant is the same evidence
        // source, not future-dated data; only unbounded skew is rejected.
        Date.parse(checkedAt) >
          Date.parse(evaluatedAt) + PROVIDER_HEALTH_SKEW_TOLERANCE_MS,
    ) ||
    new Set(
      providerHealth.map(
        ({ providerId, sportsbookId }) => `${providerId}\0${sportsbookId}`,
      ),
    ).size !== providerHealth.length
  )
    throw new Error("opportunity-provider-health-invalid");
  const calculation = normalizeCalculationProvenance(
    input.versions.calculation,
  );
  const normalized = {
    schemaVersion: OPPORTUNITY_CANDIDATE_SCHEMA_VERSION,
    logicalIdentity,
    evaluatedAt,
    qualificationGates: Object.freeze({
      eventStatus: input.qualificationGates.eventStatus,
      marketApproved: input.qualificationGates.marketApproved,
      minimumComparisonBooks: input.qualificationGates.minimumComparisonBooks,
      maximumPriceAgeMinutes: input.qualificationGates.maximumPriceAgeMinutes,
      minimumExpectedValue: input.qualificationGates.minimumExpectedValue,
      disagreementWarningThreshold:
        input.qualificationGates.disagreementWarningThreshold,
      disagreementBlockThreshold:
        input.qualificationGates.disagreementBlockThreshold,
    }),
    status: input.status,
    reasonCodes,
    warningCodes: warnings,
    values: Object.freeze({
      targetAmericanOdds: finiteOrNull(
        input.values.targetAmericanOdds,
        "opportunity-target-odds",
      ),
      targetImpliedProbability: finiteOrNull(
        input.values.targetImpliedProbability,
        "opportunity-target-probability",
      ),
      consensusProbability: finiteOrNull(
        input.values.consensusProbability,
        "opportunity-consensus-probability",
      ),
      fairAmericanOdds: finiteOrNull(
        input.values.fairAmericanOdds,
        "opportunity-fair-odds",
      ),
      expectedValue: finiteOrNull(
        input.values.expectedValue,
        "opportunity-expected-value",
      ),
      marketDisagreement: finiteOrNull(
        input.values.marketDisagreement,
        "opportunity-market-disagreement",
      ),
    }),
    targetEvidence,
    comparisonEvidence,
    includedComparisonSportsbookIds,
    excludedComparisonBooks,
    providerHealth,
    versions: Object.freeze({
      sportModule: frozenRef(input.versions.sportModule),
      strategy: frozenRef(input.versions.strategy),
      evaluationPolicy: frozenRef(input.versions.evaluationPolicy),
      calculation,
    }),
  } as const;
  if (
    !["scheduled", "not-scheduled"].includes(
      normalized.qualificationGates.eventStatus,
    ) ||
    typeof normalized.qualificationGates.marketApproved !== "boolean" ||
    !Number.isSafeInteger(
      normalized.qualificationGates.minimumComparisonBooks,
    ) ||
    normalized.qualificationGates.minimumComparisonBooks < 3 ||
    !Number.isFinite(normalized.qualificationGates.maximumPriceAgeMinutes) ||
    normalized.qualificationGates.maximumPriceAgeMinutes < 0 ||
    !Number.isFinite(normalized.qualificationGates.minimumExpectedValue) ||
    normalized.qualificationGates.minimumExpectedValue < 0 ||
    !Number.isFinite(
      normalized.qualificationGates.disagreementWarningThreshold,
    ) ||
    normalized.qualificationGates.disagreementWarningThreshold < 0 ||
    !Number.isFinite(
      normalized.qualificationGates.disagreementBlockThreshold,
    ) ||
    normalized.qualificationGates.disagreementBlockThreshold <
      normalized.qualificationGates.disagreementWarningThreshold ||
    normalized.qualificationGates.disagreementBlockThreshold > 1
  )
    throw new Error("opportunity-qualification-gates-invalid");
  const targetSelectionKeys = new Set(
    targetEvidence.map(({ selectionKey }) => selectionKey),
  );
  const targetVector = targetEvidence.filter(
    ({ sportsbookId }) => sportsbookId === logicalIdentity.targetSportsbookId,
  );
  const includedVectors = normalized.includedComparisonSportsbookIds.map(
    (sportsbookId) =>
      normalized.comparisonEvidence.filter(
        (evidence) => evidence.sportsbookId === sportsbookId,
      ),
  );
  const targetOddsBound =
    selectedTargetEvidence !== undefined &&
    normalized.values.targetAmericanOdds ===
      selectedTargetEvidence.americanOdds;
  const hasInsufficientComparisons = reasonCodes.includes(
    "insufficient-comparison-books",
  );
  const excludedHas = (reason: OpportunityComparisonExclusionReasonCode) =>
    normalized.excludedComparisonBooks.some(({ reasonCodes }) =>
      reasonCodes.includes(reason),
    );
  const targetProviderHealthy = normalized.providerHealth.some(
    ({ sportsbookId, healthy }) =>
      sportsbookId === logicalIdentity.targetSportsbookId && healthy,
  );
  const expectedInsufficientComparisons =
    normalized.includedComparisonSportsbookIds.length <
    normalized.qualificationGates.minimumComparisonBooks;
  const expectedEvBelowThreshold =
    normalized.values.expectedValue !== null &&
    normalized.values.expectedValue <
      normalized.qualificationGates.minimumExpectedValue;
  const expectedDisagreementBlocked =
    normalized.values.marketDisagreement !== null &&
    normalized.values.marketDisagreement >=
      normalized.qualificationGates.disagreementBlockThreshold;
  const expectedDisagreementWarning =
    normalized.values.marketDisagreement !== null &&
    normalized.values.marketDisagreement >=
      normalized.qualificationGates.disagreementWarningThreshold &&
    !expectedDisagreementBlocked;
  if (
    reasonCodes.includes("calculation-provenance-unavailable") ||
    reasonCodes.includes("target-provider-unhealthy") ===
      targetProviderHealthy ||
    reasonCodes.includes("target-missing") !== (targetVector.length === 0) ||
    hasInsufficientComparisons !== expectedInsufficientComparisons ||
    reasonCodes.includes("ev-below-threshold") !== expectedEvBelowThreshold ||
    reasonCodes.includes("market-disagreement-blocked") !==
      expectedDisagreementBlocked ||
    reasonCodes.includes("comparison-provider-unhealthy") !==
      (hasInsufficientComparisons && excludedHas("provider-unhealthy")) ||
    reasonCodes.includes("comparison-stale") !==
      (hasInsufficientComparisons && excludedHas("stale")) ||
    reasonCodes.includes("comparison-incomplete") !==
      (hasInsufficientComparisons && excludedHas("incomplete")) ||
    reasonCodes.includes("comparison-incoherent") !==
      (hasInsufficientComparisons && excludedHas("incoherent")) ||
    warnings.includes("comparison-outlier-excluded") !==
      excludedHas("outlier") ||
    warnings.includes("market-disagreement-warning") !==
      expectedDisagreementWarning ||
    (normalized.values.targetAmericanOdds !== null && !targetOddsBound)
  )
    throw new Error("opportunity-decision-evidence-invalid");
  const probabilitiesValid = [
    normalized.values.targetImpliedProbability,
    normalized.values.consensusProbability,
  ].every((value) => value === null || (value > 0 && value < 1));
  const vectorsComplete =
    (targetVector.length === 2 || targetVector.length === 3) &&
    targetSelectionKeys.size === targetVector.length &&
    isOpportunityPointVectorCoherent(logicalIdentity.marketKey, targetVector) &&
    includedVectors.every(
      (vector) =>
        vector.length === targetVector.length &&
        new Set(vector.map(({ selectionKey }) => selectionKey)).size ===
          targetVector.length &&
        vector.every(
          (snapshot) =>
            targetSelectionKeys.has(snapshot.selectionKey) &&
            targetVector.some(
              (target) =>
                target.selectionKey === snapshot.selectionKey &&
                target.point === snapshot.point,
            ) &&
            isFixtureOddsSnapshotActionable(
              snapshot,
              snapshot.selectionAvailability as never,
              snapshot.groupAvailability as never,
            ),
        ) &&
        isOpportunityPointVectorCoherent(logicalIdentity.marketKey, vector),
    );
  if (
    input.status === "qualified" &&
    (normalized.qualificationGates.eventStatus !== "scheduled" ||
      !normalized.qualificationGates.marketApproved ||
      Object.values(normalized.values).some((value) => value === null) ||
      !targetOddsBound ||
      !probabilitiesValid ||
      !vectorsComplete ||
      selectedTargetEvidence === undefined ||
      normalized.includedComparisonSportsbookIds.length < 3 ||
      normalized.targetEvidence.some(
        ({ selectionAvailability, groupAvailability }) =>
          selectionAvailability?.state !== "active" ||
          groupAvailability?.state !== "active",
      ) ||
      normalized.includedComparisonSportsbookIds.some(
        (sportsbookId) =>
          !normalized.comparisonEvidence.some(
            (evidence) =>
              evidence.sportsbookId === sportsbookId &&
              evidence.selectionAvailability?.state === "active" &&
              evidence.groupAvailability?.state === "active",
          ) ||
          !normalized.providerHealth.some(
            (health) => health.sportsbookId === sportsbookId && health.healthy,
          ),
      ) ||
      !normalized.providerHealth.some(
        (health) =>
          health.sportsbookId === logicalIdentity.targetSportsbookId &&
          health.healthy,
      ) ||
      targetVector.some(
        (snapshot) =>
          !isFixtureOddsSnapshotActionable(
            snapshot,
            snapshot.selectionAvailability as never,
            snapshot.groupAvailability as never,
          ),
      ))
  )
    throw new Error("opportunity-qualified-evidence-invalid");
  if (
    logicalIdentity.strategyId !== normalized.versions.strategy.id ||
    logicalIdentity.strategyVersion !== normalized.versions.strategy.version
  )
    throw new Error("opportunity-strategy-binding-invalid");
  if (normalized.versions.sportModule.id !== logicalIdentity.sportKey)
    throw new Error("opportunity-sport-module-binding-invalid");
  if (
    calculation.root.algorithm.id !== OPPORTUNITY_QUALIFICATION_ALGORITHM_ID ||
    calculation.root.algorithm.version !== OPPORTUNITY_QUALIFICATION_VERSION
  )
    throw new Error("opportunity-calculation-version-invalid");
  if (!HASH.test(calculation.root.inputHash))
    throw new Error("opportunity-calculation-hash-invalid");
  const logicalOpportunityId = `opportunity:${sha256Hex(
    canonicalCalculationJson(logicalIdentity),
  )}`;
  const occurrenceId = `opportunity-occurrence:${sha256Hex(
    canonicalCalculationJson({
      ...normalized,
      logicalOpportunityId,
    }),
  )}`;
  return Object.freeze({
    ...normalized,
    logicalOpportunityId,
    occurrenceId,
  });
}

export function normalizeOpportunityCandidate(
  value: OpportunityCandidate,
): OpportunityCandidate {
  if (value.schemaVersion !== OPPORTUNITY_CANDIDATE_SCHEMA_VERSION)
    throw new Error("stored-opportunity-candidate-invalid");
  const rebuilt = createOpportunityCandidate(value);
  if (
    canonicalCalculationJson(value) !== canonicalCalculationJson(rebuilt) ||
    rebuilt.logicalOpportunityId !== value.logicalOpportunityId ||
    rebuilt.occurrenceId !== value.occurrenceId
  )
    throw new Error("stored-opportunity-candidate-invalid");
  return rebuilt;
}
