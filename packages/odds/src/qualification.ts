import {
  americanToDecimal,
  calculateWeightedConsensus,
  expectedValue as calculateExpectedValue,
  impliedProbability,
  removeVig,
} from "./index";
import { scoreMarketDisagreement } from "./market-quality";
import type { CalculationProvenance } from "@find-the-edge/domain";
import { displayDecimalOdds, displayPercentage } from "./precision";
import { safeCalculationProvenance } from "./provenance";
import { QUALIFICATION_VERSION } from "./versions";

export { QUALIFICATION_VERSION };

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
  readonly provenance: Readonly<CalculationProvenance> | null;
  readonly display: Readonly<{
    readonly conservativeProbability: string;
    readonly noVigProbability: string;
    readonly marketImpliedProbability: string;
    readonly decimalOdds: string;
    readonly expectedValue: string;
    readonly edge: string;
    readonly marketDisagreement: string;
  }>;
}

const canonicalText = (value: string) => value.trim().toLowerCase();

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareNumber = (left: number, right: number) => {
  if (Object.is(left, right) || (left === 0 && right === 0)) return 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return compareText(String(left), String(right));
};

const compareOdds = (left: readonly number[], right: readonly number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const comparison = compareNumber(left[index]!, right[index]!);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

function qualificationProvenanceInput(input: QualificationInput): unknown {
  return {
    targetSportsbookId: canonicalText(input.targetSportsbookId),
    offeredAmerican: input.offeredAmerican,
    offeredAgeMinutes: input.offeredAgeMinutes,
    candidateIndex: input.candidateIndex,
    modelProbability: {
      low: input.modelProbability.low,
      uncertainty: input.modelProbability.uncertainty,
    },
    outcomeCount: input.outcomeCount,
    analysisMaturity: input.analysisMaturity ?? "complete",
    books: [...input.books]
      .map((book) => ({
        sportsbookId: canonicalText(book.sportsbookId),
        ageMinutes: book.ageMinutes,
        americanOdds: [...book.americanOdds],
      }))
      .sort(
        (left, right) =>
          compareText(left.sportsbookId, right.sportsbookId) ||
          compareNumber(left.ageMinutes, right.ageMinutes) ||
          compareOdds(left.americanOdds, right.americanOdds),
      ),
    policy: {
      comparisonWeights: Object.entries(input.policy.comparisonWeights)
        .map(([sportsbookId, weight]) => [canonicalText(sportsbookId), weight])
        .sort(
          ([leftId, leftWeight], [rightId, rightWeight]) =>
            compareText(String(leftId), String(rightId)) ||
            compareNumber(Number(leftWeight), Number(rightWeight)),
        ),
      minimumComparisonBooks: input.policy.minimumComparisonBooks,
      maximumPriceAgeMinutes: input.policy.maximumPriceAgeMinutes,
      outlierThreshold: input.policy.outlierThreshold,
      disagreementWarningThreshold: input.policy.disagreementWarningThreshold,
      disagreementBlockThreshold: input.policy.disagreementBlockThreshold,
      maximumUncertainty: input.policy.maximumUncertainty,
      minimumEdge: input.policy.minimumEdge,
      minimumExpectedValue: input.policy.minimumExpectedValue,
    },
  };
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
  const consensusInput = {
    targetSportsbookId: input.targetSportsbookId,
    selectionKeys,
    policy: {
      comparisonWeights: input.policy.comparisonWeights,
      minimumBooks: input.policy.minimumComparisonBooks,
      maximumAgeMinutes: input.policy.maximumPriceAgeMinutes,
      outlierThreshold: input.policy.outlierThreshold,
    },
    books: input.books
      .map((book) => ({
        sportsbookId: book.sportsbookId,
        ageMinutes: book.ageMinutes,
        status: "active" as const,
        selections: selectionKeys.map((selectionKey, index) => ({
          selectionKey,
          americanOdds: book.americanOdds[index]!,
        })),
      }))
      .sort((left, right) =>
        canonicalText(left.sportsbookId) < canonicalText(right.sportsbookId)
          ? -1
          : canonicalText(left.sportsbookId) > canonicalText(right.sportsbookId)
            ? 1
            : 0,
      ),
  } as const;
  const consensus = calculateWeightedConsensus(consensusInput);
  const noVigProbability = consensus.probabilities?.[input.candidateIndex] ?? 0;
  const disagreementContributions =
    consensus.status === "available" ? consensus.contributions : [];
  const disagreementThresholdsValid =
    Number.isFinite(input.policy.disagreementWarningThreshold) &&
    Number.isFinite(input.policy.disagreementBlockThreshold) &&
    input.policy.disagreementWarningThreshold >= 0 &&
    input.policy.disagreementBlockThreshold <= 1 &&
    input.policy.disagreementWarningThreshold <=
      input.policy.disagreementBlockThreshold;
  let marketDisagreement: number;
  let disagreementInput:
    Parameters<typeof scoreMarketDisagreement>[0] | undefined;
  let disagreementProvenance: Readonly<CalculationProvenance> | null = null;
  if (disagreementThresholdsValid) {
    disagreementInput = {
      selectionKeys,
      contributions: disagreementContributions,
      warningThreshold: input.policy.disagreementWarningThreshold,
      blockThreshold: input.policy.disagreementBlockThreshold,
    };
    const disagreement = scoreMarketDisagreement(disagreementInput);
    disagreementProvenance = disagreement.provenance;
    marketDisagreement = disagreement.score ?? 0;
  } else {
    marketDisagreement = Array.from(
      { length: input.outcomeCount },
      (_, outcome) => {
        const values = disagreementContributions.map(
          ({ probabilities }) => probabilities[outcome]!,
        );
        if (values.length < 2) return 0;
        const range = values.reduce(
          ({ minimum, maximum }, value) => ({
            minimum: Math.min(minimum, value),
            maximum: Math.max(maximum, value),
          }),
          { minimum: Infinity, maximum: -Infinity },
        );
        return range.maximum - range.minimum;
      },
    ).reduce((maximum, value) => Math.max(maximum, value), 0);
  }
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
  const provenance = safeCalculationProvenance(
    "qualification",
    qualificationProvenanceInput(input),
    [],
    [consensus.provenance, disagreementProvenance].filter(
      (item): item is Readonly<CalculationProvenance> => item !== null,
    ),
  );
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
          .sort(([left], [right]) => compareText(left, right)),
      ),
    ),
    provenance,
    display: Object.freeze({
      conservativeProbability: displayPercentage(conservativeProbability).text,
      noVigProbability: displayPercentage(noVigProbability).text,
      marketImpliedProbability: displayPercentage(marketImpliedProbability)
        .text,
      decimalOdds: displayDecimalOdds(decimalOdds).text,
      expectedValue: displayPercentage(expectedValue).text,
      edge: displayPercentage(edge).text,
      marketDisagreement: displayPercentage(marketDisagreement).text,
    }),
  });
}
