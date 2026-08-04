import { americanToDecimal, impliedProbability, removeVig } from "./index";

export const QUALIFICATION_VERSION = "deterministic-qualification-v1";

export interface QualificationPolicy {
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
  readonly weight: number;
  readonly ageMinutes: number;
  readonly americanOdds: readonly number[];
}
export interface QualificationInput {
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
    new Set(input.books.map(({ sportsbookId }) => sportsbookId)).size !==
    input.books.length
  )
    throw new RangeError("duplicate-comparison-book");
  for (const book of input.books) {
    if (
      !book.sportsbookId ||
      book.americanOdds.length !== input.outcomeCount ||
      !Number.isFinite(book.weight) ||
      book.weight <= 0 ||
      !Number.isFinite(book.ageMinutes) ||
      book.ageMinutes < 0
    )
      throw new RangeError("comparison-vector-invalid");
    removeVig(book.americanOdds);
  }
  const eligible = input.books.filter(
    (book) =>
      book.ageMinutes <= input.policy.maximumPriceAgeMinutes && book.weight > 0,
  );
  const vectors = eligible.map((book) => removeVig(book.americanOdds));
  const medians = Array.from({ length: input.outcomeCount }, (_, outcome) => {
    const values = vectors
      .map((vector) => vector[outcome]!)
      .sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
  const included = eligible.filter((_, index) =>
    medians.every(
      (median, outcome) =>
        median === undefined ||
        Math.abs(vectors[index]![outcome]! - median) <=
          input.policy.outlierThreshold,
    ),
  );
  const includedVectors = included.map((book) => removeVig(book.americanOdds));
  const totalWeight = included.reduce((sum, book) => sum + book.weight, 0);
  const noVigProbability = totalWeight
    ? included.reduce(
        (sum, book, index) =>
          sum + includedVectors[index]![input.candidateIndex]! * book.weight,
        0,
      ) / totalWeight
    : 0;
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
  const expectedValue = conservativeProbability * decimalOdds - 1;
  const edge = conservativeProbability - noVigProbability;
  const reasons: string[] = [];
  if (input.offeredAgeMinutes > input.policy.maximumPriceAgeMinutes)
    reasons.push("stale-offered-price");
  if (input.analysisMaturity === "reduced") reasons.push("analysis-reduced");
  if (included.length < input.policy.minimumComparisonBooks)
    reasons.push("insufficient-comparison-books");
  if (included.length < eligible.length)
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
    includedSportsbookIds: Object.freeze(
      included.map((book) => book.sportsbookId).sort(),
    ),
    includedWeights: Object.freeze(
      Object.fromEntries(
        included
          .map((book) => [book.sportsbookId, book.weight] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    ),
  });
}
