import type {
  CalculationProvenance,
  OpportunityBlockingReasonCode,
  OpportunityComparisonExclusionReasonCode,
  OpportunityWarningCode,
} from "@find-the-edge/domain";
import {
  americanToDecimal,
  calculateWeightedConsensus,
  impliedProbability,
  probabilityToAmerican,
  type ConsensusExclusionReason,
} from "./index";
import { scoreMarketDisagreement } from "./market-quality";
import { safeCalculationProvenance } from "./provenance";
import { OPPORTUNITY_QUALIFICATION_VERSION } from "./versions";

export { OPPORTUNITY_QUALIFICATION_VERSION };

export type OpportunityMarketBookState =
  | "active"
  | "missing"
  | "stale"
  | "suspended"
  | "closed"
  | "incomplete"
  | "incoherent"
  | "unavailable";

export interface OpportunityMarketBook {
  readonly sportsbookId: string;
  readonly state: OpportunityMarketBookState;
  readonly ageMinutes: number | null;
  readonly americanOdds: readonly number[];
}

export interface OpportunityQualificationPolicy {
  readonly comparisonWeights: Readonly<Record<string, number>>;
  readonly minimumComparisonBooks: number;
  readonly maximumPriceAgeMinutes: number;
  readonly outlierThreshold: number;
  readonly disagreementWarningThreshold: number;
  readonly disagreementBlockThreshold: number;
  readonly minimumExpectedValue: number;
}

export interface OpportunityQualificationInput {
  readonly eventStatus: "scheduled" | "not-scheduled";
  readonly marketApproved: boolean;
  readonly targetSportsbookId: string;
  readonly targetProviderHealthy: boolean;
  readonly comparisonProviderHealth: Readonly<Record<string, boolean>>;
  readonly selectionKeys: readonly string[];
  readonly candidateIndex: number;
  readonly target: OpportunityMarketBook | null;
  readonly comparisons: readonly OpportunityMarketBook[];
  readonly policy: OpportunityQualificationPolicy;
}

export interface OpportunityQualificationResult {
  readonly calculationVersion: typeof OPPORTUNITY_QUALIFICATION_VERSION;
  readonly status: "qualified" | "disqualified";
  readonly reasonCodes: readonly OpportunityBlockingReasonCode[];
  readonly warningCodes: readonly OpportunityWarningCode[];
  readonly values: Readonly<{
    readonly targetAmericanOdds: number | null;
    readonly targetImpliedProbability: number | null;
    readonly consensusProbability: number | null;
    readonly fairAmericanOdds: number | null;
    readonly expectedValue: number | null;
    readonly marketDisagreement: number | null;
  }>;
  readonly includedComparisonSportsbookIds: readonly string[];
  readonly excludedComparisonBooks: readonly Readonly<{
    readonly sportsbookId: string;
    readonly reasonCodes: readonly OpportunityComparisonExclusionReasonCode[];
  }>[];
  readonly provenance: Readonly<CalculationProvenance> | null;
}

const canonical = (value: string) => value.trim().toLowerCase();
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const validAmerican = (value: number) =>
  Number.isSafeInteger(value) &&
  value !== 0 &&
  Math.abs(value) >= 100 &&
  Math.abs(value) <= 100_000;

function stateReason(
  role: "target" | "comparison",
  state: OpportunityMarketBookState,
): OpportunityBlockingReasonCode | null {
  if (state === "active") return null;
  if (role === "target") {
    if (state === "missing") return "target-missing";
    if (state === "stale") return "target-stale";
    if (state === "incomplete") return "target-incomplete";
    if (state === "incoherent") return "target-incoherent";
    return "target-unavailable";
  }
  if (state === "stale") return "comparison-stale";
  if (state === "incomplete" || state === "missing")
    return "comparison-incomplete";
  if (state === "incoherent") return "comparison-incoherent";
  return "comparison-incomplete";
}

function consensusExclusionReason(
  reason: ConsensusExclusionReason,
): OpportunityComparisonExclusionReasonCode {
  if (reason === "outlier") return "outlier";
  if (reason === "target-sportsbook") return "target-sportsbook";
  if (reason === "stale") return "stale";
  if (reason === "suspended") return "suspended";
  if (reason === "closed") return "closed";
  if (reason === "unavailable") return "unavailable";
  if (reason === "duplicate-sportsbook") return "duplicate-sportsbook";
  if (reason === "unconfigured" || reason === "zero-weight")
    return "unconfigured-weight";
  return "invalid-odds";
}

function provenanceInput(input: OpportunityQualificationInput) {
  return {
    eventStatus: input.eventStatus,
    marketApproved: input.marketApproved,
    targetSportsbookId: canonical(input.targetSportsbookId),
    targetProviderHealthy: input.targetProviderHealthy,
    comparisonProviderHealth: Object.entries(input.comparisonProviderHealth)
      .map(([sportsbookId, healthy]) => [canonical(sportsbookId), healthy])
      .sort(([left], [right]) => compareText(String(left), String(right))),
    selectionKeys: [...input.selectionKeys],
    candidateIndex: input.candidateIndex,
    target: input.target
      ? {
          sportsbookId: canonical(input.target.sportsbookId),
          state: input.target.state,
          ageMinutes: input.target.ageMinutes,
          americanOdds: [...input.target.americanOdds],
        }
      : null,
    comparisons: input.comparisons
      .map((book) => ({
        sportsbookId: canonical(book.sportsbookId),
        state: book.state,
        ageMinutes: book.ageMinutes,
        americanOdds: [...book.americanOdds],
      }))
      .sort((left, right) =>
        compareText(left.sportsbookId, right.sportsbookId),
      ),
    policy: {
      comparisonWeights: Object.entries(input.policy.comparisonWeights)
        .map(([sportsbookId, weight]) => [canonical(sportsbookId), weight])
        .sort(([left], [right]) => compareText(String(left), String(right))),
      minimumComparisonBooks: input.policy.minimumComparisonBooks,
      maximumPriceAgeMinutes: input.policy.maximumPriceAgeMinutes,
      outlierThreshold: input.policy.outlierThreshold,
      disagreementWarningThreshold: input.policy.disagreementWarningThreshold,
      disagreementBlockThreshold: input.policy.disagreementBlockThreshold,
      minimumExpectedValue: input.policy.minimumExpectedValue,
    },
  };
}

export function qualifyOpportunity(
  input: OpportunityQualificationInput,
): OpportunityQualificationResult {
  if (
    !Number.isSafeInteger(input.policy.minimumComparisonBooks) ||
    input.policy.minimumComparisonBooks < 3 ||
    !Number.isFinite(input.policy.maximumPriceAgeMinutes) ||
    input.policy.maximumPriceAgeMinutes < 0 ||
    !Number.isFinite(input.policy.outlierThreshold) ||
    input.policy.outlierThreshold < 0 ||
    input.policy.outlierThreshold >= 1 ||
    !Number.isFinite(input.policy.disagreementWarningThreshold) ||
    input.policy.disagreementWarningThreshold < 0 ||
    !Number.isFinite(input.policy.disagreementBlockThreshold) ||
    input.policy.disagreementBlockThreshold <
      input.policy.disagreementWarningThreshold ||
    input.policy.disagreementBlockThreshold > 1 ||
    !Number.isFinite(input.policy.minimumExpectedValue) ||
    input.policy.minimumExpectedValue < 0
  )
    throw new RangeError("opportunity-policy-invalid");
  if (
    (input.selectionKeys.length !== 2 && input.selectionKeys.length !== 3) ||
    new Set(input.selectionKeys).size !== input.selectionKeys.length ||
    input.selectionKeys.some((key) => !key.trim()) ||
    !Number.isSafeInteger(input.candidateIndex) ||
    input.candidateIndex < 0 ||
    input.candidateIndex >= input.selectionKeys.length
  )
    throw new RangeError("opportunity-selection-vector-invalid");
  const targetId = canonical(input.targetSportsbookId);
  const comparisonIds = input.comparisons.map(({ sportsbookId }) =>
    canonical(sportsbookId),
  );
  if (
    !targetId ||
    comparisonIds.includes(targetId) ||
    new Set(comparisonIds).size !== comparisonIds.length
  )
    throw new RangeError("opportunity-comparison-books-invalid");

  const reasons = new Set<OpportunityBlockingReasonCode>();
  const warnings = new Set<OpportunityWarningCode>();
  if (input.eventStatus !== "scheduled") reasons.add("event-not-scheduled");
  if (!input.marketApproved) reasons.add("market-not-approved");
  if (!input.targetProviderHealthy) reasons.add("target-provider-unhealthy");
  if (!input.target) reasons.add("target-missing");
  else {
    if (canonical(input.target.sportsbookId) !== targetId)
      throw new RangeError("opportunity-target-book-invalid");
    const targetStateReason = stateReason("target", input.target.state);
    if (targetStateReason) reasons.add(targetStateReason);
    if (
      input.target.ageMinutes === null ||
      !Number.isFinite(input.target.ageMinutes) ||
      input.target.ageMinutes < 0
    )
      reasons.add("target-incoherent");
    else if (input.target.ageMinutes > input.policy.maximumPriceAgeMinutes)
      reasons.add("target-stale");
    if (
      input.target.americanOdds.length !== input.selectionKeys.length ||
      input.target.americanOdds.some((odds) => !validAmerican(odds))
    )
      reasons.add("target-incomplete");
  }

  const excluded = new Map<
    string,
    Set<OpportunityComparisonExclusionReasonCode>
  >();
  const activeComparisons = input.comparisons.filter((book) => {
    const sportsbookId = canonical(book.sportsbookId);
    const bookReasons = new Set<OpportunityComparisonExclusionReasonCode>();
    if (input.comparisonProviderHealth[sportsbookId] !== true)
      bookReasons.add("provider-unhealthy");
    const bookStateReason = stateReason("comparison", book.state);
    if (bookStateReason)
      bookReasons.add(
        book.state === "stale"
          ? "stale"
          : book.state === "incoherent"
            ? "incoherent"
            : book.state === "suspended"
              ? "suspended"
              : book.state === "closed"
                ? "closed"
                : book.state === "unavailable"
                  ? "unavailable"
                  : "incomplete",
      );
    if (
      book.ageMinutes === null ||
      !Number.isFinite(book.ageMinutes) ||
      book.ageMinutes < 0 ||
      book.ageMinutes > input.policy.maximumPriceAgeMinutes
    )
      bookReasons.add(
        book.ageMinutes === null ||
          !Number.isFinite(book.ageMinutes) ||
          book.ageMinutes < 0
          ? "incomplete"
          : "stale",
      );
    if (
      book.americanOdds.length !== input.selectionKeys.length ||
      book.americanOdds.some((odds) => !validAmerican(odds))
    )
      bookReasons.add("incomplete");
    if (bookReasons.size) excluded.set(sportsbookId, bookReasons);
    return bookReasons.size === 0;
  });

  let consensus: ReturnType<typeof calculateWeightedConsensus> | null = null;
  let disagreementProvenance: Readonly<CalculationProvenance> | null = null;
  let marketDisagreement: number | null = null;
  if (activeComparisons.length) {
    consensus = calculateWeightedConsensus({
      targetSportsbookId: targetId,
      selectionKeys: input.selectionKeys,
      books: activeComparisons.map((book) => ({
        sportsbookId: canonical(book.sportsbookId),
        ageMinutes: book.ageMinutes!,
        status: "active" as const,
        selections: input.selectionKeys.map((selectionKey, index) => ({
          selectionKey,
          americanOdds: book.americanOdds[index]!,
        })),
      })),
      policy: {
        comparisonWeights: input.policy.comparisonWeights,
        minimumBooks: input.policy.minimumComparisonBooks,
        maximumAgeMinutes: input.policy.maximumPriceAgeMinutes,
        outlierThreshold: input.policy.outlierThreshold,
      },
    });
    for (const exclusion of consensus.exclusions) {
      const bookReasons =
        excluded.get(exclusion.sportsbookId) ??
        new Set<OpportunityComparisonExclusionReasonCode>();
      bookReasons.add(consensusExclusionReason(exclusion.reason));
      excluded.set(exclusion.sportsbookId, bookReasons);
      if (exclusion.reason === "outlier")
        warnings.add("comparison-outlier-excluded");
    }
    if (consensus.status === "available") {
      const disagreement = scoreMarketDisagreement({
        selectionKeys: input.selectionKeys,
        contributions: consensus.contributions,
        warningThreshold: input.policy.disagreementWarningThreshold,
        blockThreshold: input.policy.disagreementBlockThreshold,
      });
      marketDisagreement = disagreement.score;
      disagreementProvenance = disagreement.provenance;
      if (disagreement.classification === "block")
        reasons.add("market-disagreement-blocked");
      else if (disagreement.classification === "warning")
        warnings.add("market-disagreement-warning");
    }
  }
  if (consensus?.status !== "available") {
    reasons.add("insufficient-comparison-books");
    for (const bookReasons of excluded.values()) {
      if (bookReasons.has("provider-unhealthy"))
        reasons.add("comparison-provider-unhealthy");
      if (bookReasons.has("stale")) reasons.add("comparison-stale");
      if (bookReasons.has("incomplete")) reasons.add("comparison-incomplete");
      if (bookReasons.has("incoherent")) reasons.add("comparison-incoherent");
    }
  }
  const consensusProbability =
    consensus?.probabilities?.[input.candidateIndex] ?? null;
  const targetAmericanOdds =
    input.target?.americanOdds.length === input.selectionKeys.length
      ? (input.target.americanOdds[input.candidateIndex] ?? null)
      : null;
  let targetImpliedProbability: number | null = null;
  let fairAmericanOdds: number | null = null;
  let expectedValue: number | null = null;
  try {
    if (targetAmericanOdds !== null)
      targetImpliedProbability = impliedProbability(targetAmericanOdds);
    if (consensusProbability !== null) {
      fairAmericanOdds = probabilityToAmerican(consensusProbability);
      if (targetAmericanOdds !== null)
        expectedValue =
          consensusProbability * americanToDecimal(targetAmericanOdds) - 1;
    }
  } catch {
    if (input.target) reasons.add("target-incoherent");
  }
  if (
    expectedValue !== null &&
    expectedValue < input.policy.minimumExpectedValue
  )
    reasons.add("ev-below-threshold");
  if (expectedValue === null && consensusProbability !== null)
    reasons.add("target-incoherent");

  const provenance = safeCalculationProvenance(
    "opportunityQualification",
    provenanceInput(input),
    [],
    [consensus?.provenance, disagreementProvenance].filter(
      (item): item is Readonly<CalculationProvenance> => item != null,
    ),
  );
  if (provenance === null) reasons.add("calculation-provenance-unavailable");
  return Object.freeze({
    calculationVersion: OPPORTUNITY_QUALIFICATION_VERSION,
    status: reasons.size ? "disqualified" : "qualified",
    reasonCodes: Object.freeze([...reasons].sort(compareText)),
    warningCodes: Object.freeze([...warnings].sort(compareText)),
    values: Object.freeze({
      targetAmericanOdds,
      targetImpliedProbability,
      consensusProbability,
      fairAmericanOdds,
      expectedValue,
      marketDisagreement,
    }),
    includedComparisonSportsbookIds: Object.freeze(
      [...(consensus?.includedSportsbookIds ?? [])].sort(compareText),
    ),
    excludedComparisonBooks: Object.freeze(
      [...excluded]
        .map(([sportsbookId, reasonCodes]) =>
          Object.freeze({
            sportsbookId,
            reasonCodes: Object.freeze([...reasonCodes].sort(compareText)),
          }),
        )
        .sort((left, right) =>
          compareText(left.sportsbookId, right.sportsbookId),
        ),
    ),
    provenance,
  });
}
