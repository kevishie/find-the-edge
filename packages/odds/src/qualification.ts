import {
  americanToDecimal,
  calculateWeightedConsensus,
  expectedValue as calculateExpectedValue,
  impliedProbability,
  removeVig,
} from "./index";

export const QUALIFICATION_VERSION = "deterministic-qualification-v1";

export interface QualificationPolicy {
  readonly comparisonWeights: Readonly<Record<string, number>>;
  readonly minimumComparisonBooks: number;
  readonly maximumPriceAgeMinutes: number;
  readonly outlierThreshold: number;
  readonly disagreementWarningThreshold: number;
  readonly disagreementBlockThreshold: number;
  readonly maximumUncertainty: number;
  readonly minimumEdge: number;
  readonly minimumExpectedValue: number;
}
export interface QualificationBook {
  readonly sportsbookId: string;
  readonly ageMinutes: number;
  readonly americanOdds: readonly number[];
}
export interface QualificationInput {
  readonly targetSportsbookId: string;
  readonly offeredAmerican: number;
  readonly offeredAgeMinutes: number;
  readonly candidateIndex: number;
  readonly modelProbability: {
    readonly estimate: number;
    readonly low: number;
    readonly high: number;
    readonly uncertainty: number;
  };
  readonly books: readonly QualificationBook[];
  readonly outcomeCount: 2 | 3;
  readonly analysisMaturity?: "complete" | "reduced";
  readonly policy: QualificationPolicy;
}
export interface QualificationResult {
  readonly calculationVersion: typeof QUALIFICATION_VERSION;
  readonly decision: "play" | "no-bet";
  readonly reasons: readonly string[];
  readonly conservativeProbability: number;
  readonly noVigProbability: number;
  readonly marketImpliedProbability: number;
  readonly decimalOdds: number;
  readonly expectedValue: number;
  readonly edge: number;
  readonly marketDisagreement: number;
  readonly includedSportsbookIds: readonly string[];
  readonly includedWeights: Readonly<Record<string, number>>;
}

export function qualifyEvaluation(
  input: QualificationInput,
): QualificationResult {
  if (input.candidateIndex < 0 || input.candidateIndex >= input.outcomeCount)
    throw new RangeError("candidate-index-invalid");
  if (
    new Set(
      input.books.map(({ sportsbookId }) => sportsbookId.trim().toLowerCase()),
    ).size !== input.books.length
  )
    throw new RangeError("duplicate-comparison-book");
  const canonicalTargetSportsbookId = input.targetSportsbookId
    .trim()
    .toLowerCase();
  for (const book of input.books) {
    const canonicalSportsbookId = book.sportsbookId.trim().toLowerCase();
    if (canonicalSportsbookId === canonicalTargetSportsbookId) continue;
    if (
      !book.sportsbookId ||
      book.americanOdds.length !== input.outcomeCount ||
      !Number.isFinite(input.policy.comparisonWeights[canonicalSportsbookId]) ||
      input.policy.comparisonWeights[canonicalSportsbookId]! <= 0 ||
      !Number.isFinite(book.ageMinutes) ||
      book.ageMinutes < 0
    )
      throw new RangeError("comparison-vector-invalid");
    removeVig(book.americanOdds);
  }
  const selectionKeys = Array.from(
    { length: input.outcomeCount },
    (_, index) => `outcome-${index}`,
  );
  const consensus = calculateWeightedConsensus({
    targetSportsbookId: input.targetSportsbookId,
    selectionKeys,
    policy: {
      comparisonWeights: input.policy.comparisonWeights,
      minimumBooks: input.policy.minimumComparisonBooks,
      maximumAgeMinutes: input.policy.maximumPriceAgeMinutes,
      outlierThreshold: input.policy.outlierThreshold,
    },
    books: input.books.map((book) => ({
      sportsbookId: book.sportsbookId,
      ageMinutes: book.ageMinutes,
      status: "active",
      selections: selectionKeys.map((selectionKey, index) => ({
        selectionKey,
        americanOdds: book.americanOdds[index]!,
      })),
    })),
  });
  const noVigProbability = consensus.probabilities?.[input.candidateIndex] ?? 0;
  const includedVectors =
    consensus.status === "available"
      ? consensus.contributions.map(({ probabilities }) => probabilities)
      : [];
  const marketDisagreement = Array.from(
    { length: input.outcomeCount },
    (_, outcome) => {
      const values = includedVectors.map((vector) => vector[outcome]!);
      return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);
    },
  ).reduce((maximum, value) => Math.max(maximum, value), 0);
  const conservativeProbability = input.modelProbability.low;
  const decimalOdds = americanToDecimal(input.offeredAmerican);
  const marketImpliedProbability = impliedProbability(input.offeredAmerican);
  const expectedValue =
    Number.isFinite(conservativeProbability) &&
    conservativeProbability > 0 &&
    conservativeProbability < 1
      ? calculateExpectedValue(conservativeProbability, input.offeredAmerican)
      : conservativeProbability * decimalOdds - 1;
  const edge = conservativeProbability - noVigProbability;
  const reasons: string[] = [];
  if (input.offeredAgeMinutes > input.policy.maximumPriceAgeMinutes)
    reasons.push("stale-offered-price");
  if (input.analysisMaturity === "reduced") reasons.push("analysis-reduced");
  if (consensus.status !== "available")
    reasons.push("insufficient-comparison-books");
  if (consensus.exclusions.some(({ reason }) => reason === "outlier"))
    reasons.push("comparison-outlier-excluded");
  if (input.modelProbability.uncertainty > input.policy.maximumUncertainty)
    reasons.push("uncertainty-above-threshold");
  if (marketDisagreement >= input.policy.disagreementBlockThreshold)
    reasons.push("market-disagreement-blocked");
  else if (marketDisagreement >= input.policy.disagreementWarningThreshold)
    reasons.push("market-disagreement-warning");
  if (edge < input.policy.minimumEdge) reasons.push("edge-below-threshold");
  if (expectedValue < input.policy.minimumExpectedValue)
    reasons.push("ev-below-threshold");
  const hasBlockingReason = reasons.some(
    (reason) =>
      reason !== "comparison-outlier-excluded" &&
      reason !== "market-disagreement-warning",
  );
  if (!hasBlockingReason) reasons.push("positive-ev-qualified");
  return Object.freeze({
    calculationVersion: QUALIFICATION_VERSION,
    decision: hasBlockingReason ? "no-bet" : "play",
    reasons: Object.freeze(reasons.sort()),
    conservativeProbability,
    noVigProbability,
    marketImpliedProbability,
    decimalOdds,
    expectedValue,
    edge,
    marketDisagreement,
    includedSportsbookIds: Object.freeze([...consensus.includedSportsbookIds]),
    includedWeights: Object.freeze(
      Object.fromEntries(
        consensus.contributions
          .map(({ sportsbookId, weight }) => [sportsbookId, weight] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  });
}
