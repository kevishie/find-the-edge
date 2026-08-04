export interface EvaluationPolicy {
  readonly id: string;
  readonly version: string;
  readonly targetSportsbookId: string;
  readonly comparisonWeights: Readonly<Record<string, number>>;
  readonly minimumComparisonBooks: number;
  readonly maximumPriceAgeMinutes: number;
  readonly outlierThreshold: number;
  readonly maximumUncertainty: number;
  readonly minimumEdge: number;
  readonly minimumExpectedValue: number;
  readonly conservativeProbability: "interval-low";
}

export const defaultEvaluationPolicy: EvaluationPolicy = Object.freeze({
  id: "find-the-edge-evaluation",
  version: "1.0.0",
  targetSportsbookId: "draftkings",
  comparisonWeights: Object.freeze({ circa: 1.25, pinnacle: 1.2, betmgm: 1 }),
  minimumComparisonBooks: 2,
  maximumPriceAgeMinutes: 15,
  outlierThreshold: 0.12,
  maximumUncertainty: 0.1,
  minimumEdge: 0.015,
  minimumExpectedValue: 0.02,
  conservativeProbability: "interval-low",
});

export function validateEvaluationPolicy(
  policy: EvaluationPolicy,
): EvaluationPolicy {
  if (!policy.id || !policy.version || !policy.targetSportsbookId)
    throw new Error("evaluation-policy-identity-invalid");
  if (
    !Number.isInteger(policy.minimumComparisonBooks) ||
    policy.minimumComparisonBooks < 1 ||
    !Number.isFinite(policy.maximumPriceAgeMinutes) ||
    policy.maximumPriceAgeMinutes < 0 ||
    !Number.isFinite(policy.outlierThreshold) ||
    policy.outlierThreshold <= 0 ||
    policy.outlierThreshold > 1 ||
    !Number.isFinite(policy.maximumUncertainty) ||
    policy.maximumUncertainty < 0 ||
    policy.maximumUncertainty > 1 ||
    !Number.isFinite(policy.minimumEdge) ||
    policy.minimumEdge < -1 ||
    policy.minimumEdge > 1 ||
    !Number.isFinite(policy.minimumExpectedValue) ||
    policy.minimumExpectedValue < 0 ||
    policy.conservativeProbability !== "interval-low"
  )
    throw new Error("evaluation-policy-threshold-invalid");
  for (const [book, weight] of Object.entries(policy.comparisonWeights))
    if (!book || !Number.isFinite(weight) || weight <= 0)
      throw new Error("evaluation-policy-weight-invalid");
  return policy;
}
