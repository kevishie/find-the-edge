import type { EventDisplayDto } from "../index.js";
import {
  normalizeOpportunityCandidate,
  opportunityWarningCodes,
  type OpportunityCandidate,
  type OpportunityWarningCode,
} from "../opportunity-candidate.js";
import {
  normalizeOpportunityLifecycleHead,
  type OpportunityLifecycleHead,
} from "./opportunity-lifecycle.js";

export const RANKED_OPPORTUNITY_PROJECTION_VERSION =
  "ranked-opportunity-projection-v1" as const;
export const RANKED_OPPORTUNITY_DTO_VERSION =
  "ranked-opportunity-dto-v1" as const;
export const OPPORTUNITY_RANK_INDEX = "opportunity-rank-v1" as const;
export type OpportunityConfidenceBucket = "low" | "medium" | "high";
export type OpportunityConfidenceComponent =
  "freshness" | "coverage" | "agreement";

export interface OpportunityRankingPolicyContract {
  readonly id: string;
  readonly version: string;
  readonly maximumFilterAgeMinutes: number;
}

export interface OpportunityRankSignals {
  readonly expectedValue: number;
  readonly confidence: number;
  readonly freshness: number;
  readonly sportsbookCoverage: number;
  readonly logicalOpportunityId: string;
}

export interface RankedOpportunityProjection {
  readonly schemaVersion: typeof RANKED_OPPORTUNITY_PROJECTION_VERSION;
  readonly rankingPolicy: { readonly id: string; readonly version: string };
  readonly logicalOpportunityId: string;
  readonly candidateOccurrenceId: string;
  readonly lifecycleStateVersion: number;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly point: number | null;
  readonly targetSportsbookId: string;
  readonly scoredAt: string;
  readonly expiresAt: string;
  readonly expectedValue: number;
  readonly confidence: {
    readonly score: number;
    readonly bucket: OpportunityConfidenceBucket;
    readonly weakestComponent: OpportunityConfidenceComponent;
    readonly components: Readonly<
      Record<OpportunityConfidenceComponent, number>
    >;
  };
  readonly inputs: {
    readonly oldestRequiredEvidenceAt: string;
    readonly maximumPriceAgeMinutes: number;
    readonly includedComparisonBooks: number;
    readonly uniqueNonTargetComparisonBooksWithEvidence: number;
    readonly marketDisagreement: number;
    readonly disagreementBlockThreshold: number;
  };
  readonly warningCodes: readonly OpportunityWarningCode[];
  readonly rankPartition: string;
  readonly rankKey: string;
}

export interface RankedOpportunityDto {
  readonly schemaVersion: typeof RANKED_OPPORTUNITY_DTO_VERSION;
  readonly opportunityId: string;
  readonly sportKey: string;
  readonly event: {
    readonly id: string;
    readonly version: number;
    readonly competitionKey: string;
    readonly participants: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly startsAt: string;
    readonly eastern: EventDisplayDto["eastern"];
    readonly status: "scheduled";
  };
  readonly market: {
    readonly key: string;
    readonly selectionKey: string;
    readonly point: number | null;
  };
  readonly target: {
    readonly sportsbookId: string;
    readonly americanOdds: number;
    readonly impliedProbability: number;
    readonly observedAt: string;
    readonly retrievedAt: string;
  };
  readonly bestComparison: {
    readonly sportsbookId: string;
    readonly americanOdds: number;
    readonly observedAt: string;
    readonly retrievedAt: string;
  } | null;
  readonly consensus: {
    readonly probability: number;
    readonly fairAmericanOdds: number;
  };
  readonly expectedValue: number;
  readonly confidence: RankedOpportunityProjection["confidence"];
  readonly dataQuality: {
    readonly score: number;
    readonly bucket: OpportunityConfidenceBucket;
    readonly weakestComponent: OpportunityConfidenceComponent;
  };
  readonly contributingBooks: readonly string[];
  readonly warningCodes: readonly OpportunityWarningCode[];
  readonly liveFreshness: {
    readonly scoredAt: string;
    readonly oldestRequiredEvidenceAt: string;
    readonly ageMinutes: number;
    readonly maximumAgeMinutes: number;
    readonly expiresAt: string;
  };
  readonly versions: {
    readonly ranking: { readonly id: string; readonly version: string };
    readonly evaluationPolicy: {
      readonly id: string;
      readonly version: string;
    };
    readonly strategy: { readonly id: string; readonly version: string };
    readonly sportModule: { readonly id: string; readonly version: string };
    readonly calculation: { readonly id: string; readonly version: string };
  };
}

const SAFE = /^[\x21-\x7e]{1,512}$/;
const HASHED_ID = /^opportunity:[a-f0-9]{64}$/;
const warningSet = new Set<string>(opportunityWarningCodes);
const MASK_64 = (1n << 64n) - 1n;
const SIGN_64 = 1n << 63n;
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const canonicalIso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const boundedId = (value: unknown) =>
  typeof value === "string" && SAFE.test(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const freeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child);
  }
  return value;
};

const validatePolicy = (
  policy: OpportunityRankingPolicyContract,
): OpportunityRankingPolicyContract => {
  if (
    !policy ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(policy.id) ||
    !/^\d+\.\d+\.\d+$/.test(policy.version) ||
    !finite(policy.maximumFilterAgeMinutes) ||
    policy.maximumFilterAgeMinutes < 0 ||
    policy.maximumFilterAgeMinutes > 24 * 60
  )
    throw new Error("opportunity-ranking-policy-invalid");
  return policy;
};

export const opportunityRankPartition = (
  policy: OpportunityRankingPolicyContract,
  sportKey: string,
) => {
  validatePolicy(policy);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sportKey))
    throw new Error("opportunity-rank-input-invalid");
  return `ACTIVE_OPPORTUNITY_RANK#${policy.id}@${policy.version}#${sportKey}`;
};

const descendingFloat = (value: number) => {
  if (!finite(value)) throw new Error("opportunity-rank-input-invalid");
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  const bits = view.getBigUint64(0, false);
  const ordered = bits & SIGN_64 ? ~bits & MASK_64 : (bits ^ SIGN_64) & MASK_64;
  return (MASK_64 - ordered).toString(16).padStart(16, "0");
};

export function opportunityRankKey(signals: OpportunityRankSignals): string {
  if (
    !finite(signals.expectedValue) ||
    signals.expectedValue < 0 ||
    !Number.isSafeInteger(signals.confidence) ||
    signals.confidence < 0 ||
    signals.confidence > 100 ||
    !Number.isSafeInteger(signals.freshness) ||
    signals.freshness < 0 ||
    signals.freshness > 100 ||
    !Number.isSafeInteger(signals.sportsbookCoverage) ||
    signals.sportsbookCoverage < 0 ||
    signals.sportsbookCoverage > 100 ||
    !HASHED_ID.test(signals.logicalOpportunityId)
  )
    throw new Error("opportunity-rank-input-invalid");
  return [
    "R1",
    descendingFloat(signals.expectedValue),
    String(100 - signals.confidence).padStart(3, "0"),
    String(100 - signals.freshness).padStart(3, "0"),
    String(100 - signals.sportsbookCoverage).padStart(3, "0"),
    signals.logicalOpportunityId,
  ].join("#");
}

const bucket = (score: number): OpportunityConfidenceBucket =>
  score >= 80 ? "high" : score >= 60 ? "medium" : "low";

const confidenceFromInputs = (
  inputs: RankedOpportunityProjection["inputs"],
  scoredAt: string,
) => {
  const ageMs = Math.max(
    0,
    Date.parse(scoredAt) - Date.parse(inputs.oldestRequiredEvidenceAt),
  );
  const maximumAgeMs = inputs.maximumPriceAgeMinutes * 60_000;
  const freshness = Math.floor(
    100 *
      (maximumAgeMs === 0
        ? ageMs === 0
          ? 1
          : 0
        : clamp(1 - ageMs / maximumAgeMs)),
  );
  const coverage = Math.floor(
    100 *
      (inputs.uniqueNonTargetComparisonBooksWithEvidence === 0
        ? 0
        : inputs.includedComparisonBooks /
          inputs.uniqueNonTargetComparisonBooksWithEvidence),
  );
  const agreement = Math.floor(
    100 *
      clamp(1 - inputs.marketDisagreement / inputs.disagreementBlockThreshold),
  );
  const components = { freshness, coverage, agreement } as const;
  const score = Math.min(freshness, coverage, agreement);
  const weakestComponent = (
    ["freshness", "coverage", "agreement"] as const
  ).find((key) => components[key] === score)!;
  return freeze({ score, bucket: bucket(score), weakestComponent, components });
};

const projectionInputs = (candidate: OpportunityCandidate) => {
  const included = new Set(candidate.includedComparisonSportsbookIds);
  const requiredSnapshots = [
    ...candidate.targetEvidence.filter(
      ({ sportsbookId }) =>
        sportsbookId === candidate.logicalIdentity.targetSportsbookId,
    ),
    ...candidate.comparisonEvidence.filter(({ sportsbookId }) =>
      included.has(sportsbookId),
    ),
  ];
  const requiredBooks = new Set([
    candidate.logicalIdentity.targetSportsbookId,
    ...candidate.includedComparisonSportsbookIds,
  ]);
  const requiredHealth = candidate.providerHealth.filter(({ sportsbookId }) =>
    requiredBooks.has(sportsbookId),
  );
  if (
    requiredSnapshots.length === 0 ||
    new Set(requiredHealth.map(({ sportsbookId }) => sportsbookId)).size !==
      requiredBooks.size
  )
    throw new Error("opportunity-rank-source-invalid");
  const oldest = Math.min(
    ...requiredSnapshots.flatMap(
      ({ observedAt, selectionAvailability, groupAvailability }) => [
        Date.parse(observedAt),
        ...(selectionAvailability
          ? [Date.parse(selectionAvailability.observedAt)]
          : []),
        ...(groupAvailability
          ? [Date.parse(groupAvailability.observedAt)]
          : []),
      ],
    ),
    ...requiredHealth.map(({ checkedAt }) => Date.parse(checkedAt)),
  );
  const marketDisagreement = candidate.values.marketDisagreement;
  if (marketDisagreement === null)
    throw new Error("opportunity-rank-source-invalid");
  return freeze({
    oldestRequiredEvidenceAt: new Date(oldest).toISOString(),
    maximumPriceAgeMinutes: candidate.qualificationGates.maximumPriceAgeMinutes,
    includedComparisonBooks: candidate.includedComparisonSportsbookIds.length,
    uniqueNonTargetComparisonBooksWithEvidence: new Set(
      [
        ...candidate.includedComparisonSportsbookIds,
        ...candidate.excludedComparisonBooks
          .filter(({ snapshots }) => snapshots.length > 0)
          .map(({ sportsbookId }) => sportsbookId),
      ].filter(
        (sportsbookId) =>
          sportsbookId !== candidate.logicalIdentity.targetSportsbookId,
      ),
    ).size,
    marketDisagreement,
    disagreementBlockThreshold:
      candidate.qualificationGates.disagreementBlockThreshold,
  });
};

export function createRankedOpportunityProjection(
  candidateValue: OpportunityCandidate,
  headValue: OpportunityLifecycleHead,
  policyValue: OpportunityRankingPolicyContract,
): RankedOpportunityProjection {
  const candidate = normalizeOpportunityCandidate(candidateValue);
  const head = normalizeOpportunityLifecycleHead(headValue);
  const policy = validatePolicy(policyValue);
  const expectedValue = candidate.values.expectedValue;
  if (
    candidate.status !== "qualified" ||
    expectedValue === null ||
    expectedValue < 0 ||
    head.state !== "active" ||
    head.expiresAt === null ||
    head.logicalOpportunityId !== candidate.logicalOpportunityId ||
    head.latestCandidateOccurrenceId !== candidate.occurrenceId ||
    head.latestCandidateEvaluatedAt !== candidate.evaluatedAt ||
    head.canonicalEventId !== candidate.logicalIdentity.canonicalEventId ||
    head.canonicalEventVersion !==
      candidate.logicalIdentity.canonicalEventVersion ||
    head.sportKey !== candidate.logicalIdentity.sportKey ||
    head.eventEvidence.availability !== "current" ||
    head.eventEvidence.status !== "scheduled"
  )
    throw new Error("opportunity-rank-source-invalid");
  const inputs = projectionInputs(candidate);
  const confidence = confidenceFromInputs(inputs, candidate.evaluatedAt);
  const rankPartition = opportunityRankPartition(policy, head.sportKey);
  const rankKey = opportunityRankKey({
    expectedValue,
    confidence: confidence.score,
    freshness: confidence.components.freshness,
    sportsbookCoverage: confidence.components.coverage,
    logicalOpportunityId: candidate.logicalOpportunityId,
  });
  return freeze({
    schemaVersion: RANKED_OPPORTUNITY_PROJECTION_VERSION,
    rankingPolicy: { id: policy.id, version: policy.version },
    logicalOpportunityId: candidate.logicalOpportunityId,
    candidateOccurrenceId: candidate.occurrenceId,
    lifecycleStateVersion: head.stateVersion,
    canonicalEventId: candidate.logicalIdentity.canonicalEventId,
    canonicalEventVersion: candidate.logicalIdentity.canonicalEventVersion,
    sportKey: candidate.logicalIdentity.sportKey,
    marketKey: candidate.logicalIdentity.marketKey,
    selectionKey: candidate.logicalIdentity.selectionKey,
    point: candidate.logicalIdentity.point,
    targetSportsbookId: candidate.logicalIdentity.targetSportsbookId,
    scoredAt: candidate.evaluatedAt,
    expiresAt: head.expiresAt,
    expectedValue,
    confidence,
    inputs,
    warningCodes: candidate.warningCodes,
    rankPartition,
    rankKey,
  });
}

export function normalizeRankedOpportunityProjection(
  value: RankedOpportunityProjection,
): RankedOpportunityProjection {
  if (
    !record(value) ||
    !exact(value, [
      "schemaVersion",
      "rankingPolicy",
      "logicalOpportunityId",
      "candidateOccurrenceId",
      "lifecycleStateVersion",
      "canonicalEventId",
      "canonicalEventVersion",
      "sportKey",
      "marketKey",
      "selectionKey",
      "point",
      "targetSportsbookId",
      "scoredAt",
      "expiresAt",
      "expectedValue",
      "confidence",
      "inputs",
      "warningCodes",
      "rankPartition",
      "rankKey",
    ]) ||
    value.schemaVersion !== RANKED_OPPORTUNITY_PROJECTION_VERSION ||
    !record(value.rankingPolicy) ||
    !exact(value.rankingPolicy, ["id", "version"]) ||
    !HASHED_ID.test(value.logicalOpportunityId) ||
    !/^opportunity-occurrence:[a-f0-9]{64}$/.test(
      value.candidateOccurrenceId,
    ) ||
    !Number.isSafeInteger(value.lifecycleStateVersion) ||
    value.lifecycleStateVersion < 1 ||
    !boundedId(value.canonicalEventId) ||
    !Number.isSafeInteger(value.canonicalEventVersion) ||
    value.canonicalEventVersion < 1 ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.sportKey) ||
    !boundedId(value.marketKey) ||
    !boundedId(value.selectionKey) ||
    (value.point !== null && !finite(value.point)) ||
    !boundedId(value.targetSportsbookId) ||
    !canonicalIso(value.scoredAt) ||
    !canonicalIso(value.expiresAt) ||
    Date.parse(value.scoredAt) >= Date.parse(value.expiresAt) ||
    !finite(value.expectedValue) ||
    value.expectedValue < 0 ||
    !record(value.inputs) ||
    !exact(value.inputs, [
      "oldestRequiredEvidenceAt",
      "maximumPriceAgeMinutes",
      "includedComparisonBooks",
      "uniqueNonTargetComparisonBooksWithEvidence",
      "marketDisagreement",
      "disagreementBlockThreshold",
    ]) ||
    !canonicalIso(value.inputs.oldestRequiredEvidenceAt) ||
    Date.parse(value.inputs.oldestRequiredEvidenceAt) >
      Date.parse(value.scoredAt) ||
    !finite(value.inputs.maximumPriceAgeMinutes) ||
    value.inputs.maximumPriceAgeMinutes < 0 ||
    !Number.isSafeInteger(value.inputs.includedComparisonBooks) ||
    value.inputs.includedComparisonBooks < 1 ||
    value.inputs.includedComparisonBooks > 100 ||
    !Number.isSafeInteger(
      value.inputs.uniqueNonTargetComparisonBooksWithEvidence,
    ) ||
    value.inputs.uniqueNonTargetComparisonBooksWithEvidence <
      value.inputs.includedComparisonBooks ||
    value.inputs.uniqueNonTargetComparisonBooksWithEvidence > 100 ||
    !finite(value.inputs.marketDisagreement) ||
    value.inputs.marketDisagreement < 0 ||
    !finite(value.inputs.disagreementBlockThreshold) ||
    value.inputs.disagreementBlockThreshold <= 0 ||
    !Array.isArray(value.warningCodes) ||
    new Set(value.warningCodes).size !== value.warningCodes.length ||
    value.warningCodes.some(
      (warning: unknown) =>
        typeof warning !== "string" || !warningSet.has(warning),
    )
  )
    throw new Error("stored-ranked-opportunity-invalid");
  const policy = validatePolicy({
    id: value.rankingPolicy.id,
    version: value.rankingPolicy.version,
    maximumFilterAgeMinutes: value.inputs.maximumPriceAgeMinutes,
  });
  const expectedConfidence = confidenceFromInputs(value.inputs, value.scoredAt);
  const expectedRankPartition = opportunityRankPartition(
    policy,
    value.sportKey,
  );
  const expectedRankKey = opportunityRankKey({
    expectedValue: value.expectedValue,
    confidence: expectedConfidence.score,
    freshness: expectedConfidence.components.freshness,
    sportsbookCoverage: expectedConfidence.components.coverage,
    logicalOpportunityId: value.logicalOpportunityId,
  });
  if (
    JSON.stringify(value.confidence) !== JSON.stringify(expectedConfidence) ||
    value.rankPartition !== expectedRankPartition ||
    value.rankKey !== expectedRankKey
  )
    throw new Error("stored-ranked-opportunity-invalid");
  return freeze(structuredClone(value));
}

const selectedEvidence = (
  candidate: OpportunityCandidate,
  sportsbookId: string,
  role: "target" | "comparison",
) =>
  (role === "target" ? candidate.targetEvidence : candidate.comparisonEvidence)
    .filter(
      (evidence) =>
        evidence.sportsbookId === sportsbookId &&
        evidence.selectionKey === candidate.logicalIdentity.selectionKey &&
        evidence.point === candidate.logicalIdentity.point,
    )
    .at(0);

export function toRankedOpportunityDto(
  projectionValue: RankedOpportunityProjection,
  candidateValue: OpportunityCandidate,
  event: EventDisplayDto,
  asOf: string,
): RankedOpportunityDto {
  const projection = normalizeRankedOpportunityProjection(projectionValue);
  const candidate = normalizeOpportunityCandidate(candidateValue);
  if (
    !canonicalIso(asOf) ||
    event.id !== projection.canonicalEventId ||
    event.version !== projection.canonicalEventVersion ||
    event.sportKey !== projection.sportKey ||
    event.status !== "scheduled" ||
    !canonicalIso(event.startsAt) ||
    candidate.logicalOpportunityId !== projection.logicalOpportunityId ||
    candidate.occurrenceId !== projection.candidateOccurrenceId ||
    Date.parse(asOf) >= Date.parse(projection.expiresAt)
  )
    throw new Error("ranked-opportunity-join-invalid");
  const target = selectedEvidence(
    candidate,
    projection.targetSportsbookId,
    "target",
  );
  const comparisons = candidate.includedComparisonSportsbookIds.map(
    (sportsbookId) => selectedEvidence(candidate, sportsbookId, "comparison"),
  );
  if (!target || comparisons.some((value) => value === undefined))
    throw new Error("ranked-opportunity-join-invalid");
  const best =
    comparisons
      .filter((value): value is NonNullable<typeof value> => !!value)
      .sort(
        (left, right) =>
          right.americanOdds - left.americanOdds ||
          left.sportsbookId.localeCompare(right.sportsbookId),
      )[0] ?? null;
  const calculation = candidate.versions.calculation.root.algorithm;
  const dto: RankedOpportunityDto = {
    schemaVersion: RANKED_OPPORTUNITY_DTO_VERSION,
    opportunityId: projection.logicalOpportunityId,
    sportKey: projection.sportKey,
    event: {
      id: event.id,
      version: event.version,
      competitionKey: event.competition.key,
      participants: event.participants.map(({ id, label }) => ({ id, label })),
      startsAt: event.startsAt,
      eastern: { ...event.eastern },
      status: "scheduled",
    },
    market: {
      key: projection.marketKey,
      selectionKey: projection.selectionKey,
      point: projection.point,
    },
    target: {
      sportsbookId: projection.targetSportsbookId,
      americanOdds: target.americanOdds,
      impliedProbability: candidate.values.targetImpliedProbability!,
      observedAt: target.observedAt,
      retrievedAt: target.retrievedAt,
    },
    bestComparison: best
      ? {
          sportsbookId: best.sportsbookId,
          americanOdds: best.americanOdds,
          observedAt: best.observedAt,
          retrievedAt: best.retrievedAt,
        }
      : null,
    consensus: {
      probability: candidate.values.consensusProbability!,
      fairAmericanOdds: candidate.values.fairAmericanOdds!,
    },
    expectedValue: projection.expectedValue,
    confidence: projection.confidence,
    dataQuality: {
      score: projection.confidence.score,
      bucket: projection.confidence.bucket,
      weakestComponent: projection.confidence.weakestComponent,
    },
    contributingBooks: [...candidate.includedComparisonSportsbookIds],
    warningCodes: [...projection.warningCodes],
    liveFreshness: {
      scoredAt: projection.scoredAt,
      oldestRequiredEvidenceAt: projection.inputs.oldestRequiredEvidenceAt,
      ageMinutes: Math.max(
        0,
        (Date.parse(asOf) -
          Date.parse(projection.inputs.oldestRequiredEvidenceAt)) /
          60_000,
      ),
      maximumAgeMinutes: projection.inputs.maximumPriceAgeMinutes,
      expiresAt: projection.expiresAt,
    },
    versions: {
      ranking: projection.rankingPolicy,
      evaluationPolicy: candidate.versions.evaluationPolicy,
      strategy: candidate.versions.strategy,
      sportModule: candidate.versions.sportModule,
      calculation: {
        id: calculation.id,
        version: calculation.version,
      },
    },
  };
  return normalizeRankedOpportunityDto(dto);
}

const exactObject = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => record(value) && exact(value, keys);

export function normalizeRankedOpportunityDto(
  value: RankedOpportunityDto,
): RankedOpportunityDto {
  const confidenceComponents = record(value?.confidence?.components)
    ? (value.confidence.components as Record<string, unknown>)
    : null;
  const minimumConfidence = confidenceComponents
    ? Math.min(
        ...["freshness", "coverage", "agreement"].map((component) => {
          const score = confidenceComponents[component];
          return typeof score === "number" ? score : Number.NaN;
        }),
      )
    : Number.NaN;
  const expectedWeakest = confidenceComponents
    ? (["freshness", "coverage", "agreement"] as const).find(
        (component) => confidenceComponents[component] === minimumConfidence,
      )
    : undefined;
  const minimumScoredAgeMinutes =
    canonicalIso(value?.liveFreshness?.scoredAt) &&
    canonicalIso(value?.liveFreshness?.oldestRequiredEvidenceAt)
      ? Math.max(
          0,
          (Date.parse(value.liveFreshness.scoredAt) -
            Date.parse(value.liveFreshness.oldestRequiredEvidenceAt)) /
            60_000,
        )
      : Number.NaN;
  if (
    !exactObject(value, [
      "schemaVersion",
      "opportunityId",
      "sportKey",
      "event",
      "market",
      "target",
      "bestComparison",
      "consensus",
      "expectedValue",
      "confidence",
      "dataQuality",
      "contributingBooks",
      "warningCodes",
      "liveFreshness",
      "versions",
    ]) ||
    value.schemaVersion !== RANKED_OPPORTUNITY_DTO_VERSION ||
    !HASHED_ID.test(value.opportunityId) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.sportKey) ||
    !exactObject(value.event, [
      "id",
      "version",
      "competitionKey",
      "participants",
      "startsAt",
      "eastern",
      "status",
    ]) ||
    !boundedId(value.event.id) ||
    !Number.isSafeInteger(value.event.version) ||
    value.event.version < 1 ||
    !boundedId(value.event.competitionKey) ||
    !Array.isArray(value.event.participants) ||
    value.event.participants.length !== 2 ||
    value.event.participants.some(
      (participant) =>
        !exactObject(participant, ["id", "label"]) ||
        !boundedId(participant.id) ||
        typeof participant.label !== "string" ||
        participant.label.length < 1 ||
        participant.label.length > 256,
    ) ||
    !canonicalIso(value.event.startsAt) ||
    !exactObject(value.event.eastern, ["timeZone", "calendarDay", "display"]) ||
    value.event.eastern.timeZone !== "America/New_York" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.event.eastern.calendarDay) ||
    typeof value.event.eastern.display !== "string" ||
    value.event.status !== "scheduled" ||
    !exactObject(value.market, ["key", "selectionKey", "point"]) ||
    !boundedId(value.market.key) ||
    !boundedId(value.market.selectionKey) ||
    (value.market.point !== null && !finite(value.market.point)) ||
    !exactObject(value.target, [
      "sportsbookId",
      "americanOdds",
      "impliedProbability",
      "observedAt",
      "retrievedAt",
    ]) ||
    !boundedId(value.target.sportsbookId) ||
    !Number.isSafeInteger(value.target.americanOdds) ||
    !finite(value.target.impliedProbability) ||
    value.target.impliedProbability <= 0 ||
    value.target.impliedProbability >= 1 ||
    !canonicalIso(value.target.observedAt) ||
    !canonicalIso(value.target.retrievedAt) ||
    (value.bestComparison !== null &&
      (!exactObject(value.bestComparison, [
        "sportsbookId",
        "americanOdds",
        "observedAt",
        "retrievedAt",
      ]) ||
        !boundedId(value.bestComparison.sportsbookId) ||
        !Number.isSafeInteger(value.bestComparison.americanOdds) ||
        !canonicalIso(value.bestComparison.observedAt) ||
        !canonicalIso(value.bestComparison.retrievedAt))) ||
    !exactObject(value.consensus, ["probability", "fairAmericanOdds"]) ||
    !finite(value.consensus.probability) ||
    value.consensus.probability <= 0 ||
    value.consensus.probability >= 1 ||
    !Number.isSafeInteger(value.consensus.fairAmericanOdds) ||
    !finite(value.expectedValue) ||
    value.expectedValue < 0 ||
    !exactObject(value.confidence, [
      "score",
      "bucket",
      "weakestComponent",
      "components",
    ]) ||
    !Number.isSafeInteger(value.confidence.score) ||
    value.confidence.score < 0 ||
    value.confidence.score > 100 ||
    !["low", "medium", "high"].includes(value.confidence.bucket) ||
    !["freshness", "coverage", "agreement"].includes(
      value.confidence.weakestComponent,
    ) ||
    !exactObject(value.confidence.components, [
      "freshness",
      "coverage",
      "agreement",
    ]) ||
    Object.values(value.confidence.components).some(
      (score) => !Number.isSafeInteger(score) || score < 0 || score > 100,
    ) ||
    value.confidence.score !== minimumConfidence ||
    value.confidence.bucket !== bucket(value.confidence.score) ||
    value.confidence.weakestComponent !== expectedWeakest ||
    !exactObject(value.dataQuality, ["score", "bucket", "weakestComponent"]) ||
    value.dataQuality.score !== value.confidence.score ||
    value.dataQuality.bucket !== value.confidence.bucket ||
    value.dataQuality.weakestComponent !== value.confidence.weakestComponent ||
    !Array.isArray(value.contributingBooks) ||
    value.contributingBooks.length < 1 ||
    value.contributingBooks.length > 100 ||
    new Set(value.contributingBooks).size !== value.contributingBooks.length ||
    value.contributingBooks.some((book) => !boundedId(book)) ||
    !Array.isArray(value.warningCodes) ||
    value.warningCodes.some(
      (warning: unknown) =>
        typeof warning !== "string" || !warningSet.has(warning),
    ) ||
    !exactObject(value.liveFreshness, [
      "scoredAt",
      "oldestRequiredEvidenceAt",
      "ageMinutes",
      "maximumAgeMinutes",
      "expiresAt",
    ]) ||
    !canonicalIso(value.liveFreshness.scoredAt) ||
    !canonicalIso(value.liveFreshness.oldestRequiredEvidenceAt) ||
    Date.parse(value.liveFreshness.oldestRequiredEvidenceAt) >
      Date.parse(value.liveFreshness.scoredAt) ||
    !finite(value.liveFreshness.ageMinutes) ||
    value.liveFreshness.ageMinutes < 0 ||
    value.liveFreshness.ageMinutes < minimumScoredAgeMinutes ||
    !finite(value.liveFreshness.maximumAgeMinutes) ||
    value.liveFreshness.maximumAgeMinutes < 0 ||
    !canonicalIso(value.liveFreshness.expiresAt) ||
    Date.parse(value.liveFreshness.scoredAt) >=
      Date.parse(value.liveFreshness.expiresAt) ||
    !exactObject(value.versions, [
      "ranking",
      "evaluationPolicy",
      "strategy",
      "sportModule",
      "calculation",
    ]) ||
    Object.values(value.versions).some(
      (version) =>
        !exactObject(version, ["id", "version"]) ||
        !boundedId(version.id) ||
        !boundedId(version.version),
    )
  )
    throw new Error("ranked-opportunity-dto-invalid");
  return freeze(structuredClone(value));
}
