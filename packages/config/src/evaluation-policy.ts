export interface EvaluationPolicy {
  readonly id: string;
  readonly version: string;
  readonly targetSportsbookId: string;
  readonly comparisonWeights: Readonly<Record<string, number>>;
  readonly minimumComparisonBooks: number;
  readonly maximumPriceAgeMinutes: number;
  readonly outlierThreshold: number;
  readonly outlierPolicy: "exclude-book-any-outcome-median-deviation";
  readonly disagreementWarningThreshold: number;
  readonly disagreementBlockThreshold: number;
  readonly maximumUncertainty: number;
  readonly minimumEdge: number;
  readonly minimumExpectedValue: number;
  readonly fractionalKelly: number;
  readonly clvBenchmark: "closing-comparison-consensus";
  readonly snapshotRetention: {
    readonly mode: "indefinite-no-ttl";
    readonly ttlDays: null;
  };
  readonly conservativeProbability: "interval-low";
}

export const defaultEvaluationPolicy: EvaluationPolicy = Object.freeze({
  id: "find-the-edge-evaluation",
  version: "2.0.0-provisional",
  targetSportsbookId: "hardrock",
  comparisonWeights: Object.freeze({
    draftkings: 1,
    fanduel: 1,
    betmgm: 1,
    caesars: 1,
  }),
  minimumComparisonBooks: 3,
  maximumPriceAgeMinutes: 15,
  outlierThreshold: 0.08,
  outlierPolicy: "exclude-book-any-outcome-median-deviation",
  disagreementWarningThreshold: 0.05,
  disagreementBlockThreshold: 0.1,
  maximumUncertainty: 0.1,
  minimumEdge: 0.015,
  minimumExpectedValue: 0.02,
  fractionalKelly: 0.25,
  clvBenchmark: "closing-comparison-consensus",
  snapshotRetention: Object.freeze({
    mode: "indefinite-no-ttl",
    ttlDays: null,
  }),
  conservativeProbability: "interval-low",
});

export function validateEvaluationPolicy(
  policy: EvaluationPolicy,
): EvaluationPolicy {
  if (
    !policy ||
    typeof policy !== "object" ||
    !policy.id ||
    !policy.version ||
    !policy.targetSportsbookId ||
    policy.targetSportsbookId !== policy.targetSportsbookId.trim().toLowerCase()
  )
    throw new Error("evaluation-policy-identity-invalid");
  if (
    !policy.comparisonWeights ||
    typeof policy.comparisonWeights !== "object" ||
    Array.isArray(policy.comparisonWeights)
  )
    throw new Error("evaluation-policy-roster-invalid");
  const comparisonBooks = Object.keys(policy.comparisonWeights);
  const normalizedComparisonBooks = comparisonBooks.map((book) =>
    book.trim().toLowerCase(),
  );
  if (
    normalizedComparisonBooks.includes(policy.targetSportsbookId) ||
    new Set(normalizedComparisonBooks).size !== comparisonBooks.length ||
    comparisonBooks.some(
      (book, index) => book !== normalizedComparisonBooks[index],
    ) ||
    comparisonBooks.length < policy.minimumComparisonBooks ||
    comparisonBooks.length < 3
  )
    throw new Error("evaluation-policy-roster-invalid");
  if (
    !Number.isInteger(policy.minimumComparisonBooks) ||
    policy.minimumComparisonBooks < 1 ||
    !Number.isFinite(policy.maximumPriceAgeMinutes) ||
    policy.maximumPriceAgeMinutes < 0 ||
    !Number.isFinite(policy.outlierThreshold) ||
    policy.outlierThreshold <= 0 ||
    policy.outlierThreshold > 1 ||
    policy.outlierPolicy !== "exclude-book-any-outcome-median-deviation" ||
    !Number.isFinite(policy.disagreementWarningThreshold) ||
    policy.disagreementWarningThreshold <= 0 ||
    !Number.isFinite(policy.disagreementBlockThreshold) ||
    policy.disagreementBlockThreshold <= policy.disagreementWarningThreshold ||
    policy.disagreementBlockThreshold > 1 ||
    !Number.isFinite(policy.maximumUncertainty) ||
    policy.maximumUncertainty < 0 ||
    policy.maximumUncertainty > 1 ||
    !Number.isFinite(policy.minimumEdge) ||
    policy.minimumEdge < -1 ||
    policy.minimumEdge > 1 ||
    !Number.isFinite(policy.minimumExpectedValue) ||
    policy.minimumExpectedValue < 0 ||
    !Number.isFinite(policy.fractionalKelly) ||
    policy.fractionalKelly <= 0 ||
    policy.fractionalKelly > 1 ||
    policy.clvBenchmark !== "closing-comparison-consensus" ||
    !policy.snapshotRetention ||
    typeof policy.snapshotRetention !== "object" ||
    policy.snapshotRetention.mode !== "indefinite-no-ttl" ||
    policy.snapshotRetention.ttlDays !== null ||
    policy.conservativeProbability !== "interval-low"
  )
    throw new Error("evaluation-policy-threshold-invalid");
  for (const [book, weight] of Object.entries(policy.comparisonWeights))
    if (!book || !Number.isFinite(weight) || weight <= 0)
      throw new Error("evaluation-policy-weight-invalid");
  return policy;
}
