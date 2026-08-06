export const MARKET_OUTLIER_CALCULATION_VERSION = "market-outlier-v1" as const;
export const MARKET_DISAGREEMENT_CALCULATION_VERSION =
  "market-disagreement-v1" as const;

export interface MarketProbabilityContribution {
  readonly sportsbookId: string;
  readonly probabilities: readonly number[];
}

export type MarketQualityIssue =
  | "duplicate-sportsbook"
  | "insufficient-vectors"
  | "invalid-contribution"
  | "invalid-market";

export interface MarketOutlierInput {
  readonly selectionKeys: readonly string[];
  readonly contributions: readonly MarketProbabilityContribution[];
  readonly threshold: number;
}

export interface MarketOutlierBookAudit {
  readonly sportsbookId: string;
  readonly probabilities: readonly number[];
  readonly deviations: readonly number[];
  readonly maximumDeviation: number;
  readonly outlyingSelectionKeys: readonly string[];
  readonly isOutlier: boolean;
}

export interface MarketOutlierResult {
  readonly calculationVersion: typeof MARKET_OUTLIER_CALCULATION_VERSION;
  readonly status: "available" | "insufficient-data" | "invalid";
  readonly issues: readonly MarketQualityIssue[];
  readonly threshold: number;
  readonly selectionKeys: readonly string[];
  readonly centers: readonly number[] | null;
  readonly books: readonly Readonly<MarketOutlierBookAudit>[];
  readonly outlierSportsbookIds: readonly string[];
}

export type MarketDisagreementClassification = "none" | "warning" | "block";

export interface MarketDisagreementInput {
  readonly selectionKeys: readonly string[];
  readonly contributions: readonly MarketProbabilityContribution[];
  readonly warningThreshold: number;
  readonly blockThreshold: number;
}

export interface MarketDisagreementRange {
  readonly selectionKey: string;
  readonly minimumProbability: number;
  readonly maximumProbability: number;
  readonly range: number;
}

export interface MarketDisagreementResult {
  readonly calculationVersion: typeof MARKET_DISAGREEMENT_CALCULATION_VERSION;
  readonly status: "available" | "insufficient-data" | "invalid";
  readonly issues: readonly MarketQualityIssue[];
  readonly warningThreshold: number;
  readonly blockThreshold: number;
  readonly score: number | null;
  readonly decisiveSelectionKey: string | null;
  readonly classification: MarketDisagreementClassification | null;
  readonly ranges: readonly Readonly<MarketDisagreementRange>[];
  readonly contributingSportsbookIds: readonly string[];
}

interface NormalizedMarketQualityInput {
  readonly selectionKeys: readonly string[];
  readonly contributions: readonly MarketProbabilityContribution[];
  readonly issues: readonly MarketQualityIssue[];
}

const PROBABILITY_TOTAL_TOLERANCE = Number.EPSILON * 32;
function thresholdTolerance(threshold: number): number {
  return Math.abs(threshold) * Number.EPSILON * 2;
}

function canonicalSportsbookId(value: string): string {
  return value.trim().toLowerCase();
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function upperMedian(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new RangeError("Median requires values");
  return value;
}

function validateSelectionKeys(selectionKeys: readonly string[]): boolean {
  return (
    (selectionKeys.length === 2 || selectionKeys.length === 3) &&
    selectionKeys.every((selectionKey) => selectionKey.trim()) &&
    new Set(selectionKeys).size === selectionKeys.length
  );
}

function normalizeMarketQualityInput(
  selectionKeys: readonly string[],
  contributions: readonly MarketProbabilityContribution[],
): NormalizedMarketQualityInput {
  const issues = new Set<MarketQualityIssue>();
  if (!validateSelectionKeys(selectionKeys)) issues.add("invalid-market");

  const canonicalIds = contributions.map(({ sportsbookId }) =>
    canonicalSportsbookId(sportsbookId),
  );
  if (
    canonicalIds.some(
      (sportsbookId, index) =>
        sportsbookId && canonicalIds.indexOf(sportsbookId) !== index,
    )
  ) {
    issues.add("duplicate-sportsbook");
  }
  const normalized = contributions.map((contribution, index) => {
    const sportsbookId = canonicalIds[index] ?? "";
    const probabilityTotal = contribution.probabilities.reduce(
      (total, probability) => total + probability,
      0,
    );
    if (
      !sportsbookId ||
      contribution.probabilities.length !== selectionKeys.length ||
      contribution.probabilities.some(
        (probability) =>
          !Number.isFinite(probability) || probability < 0 || probability > 1,
      ) ||
      !Number.isFinite(probabilityTotal) ||
      Math.abs(probabilityTotal - 1) > PROBABILITY_TOTAL_TOLERANCE
    ) {
      issues.add("invalid-contribution");
    }
    return {
      sportsbookId,
      probabilities: Object.freeze([...contribution.probabilities]),
    };
  });
  normalized.sort((left, right) =>
    compareCanonicalText(left.sportsbookId, right.sportsbookId),
  );
  return {
    selectionKeys: Object.freeze([...selectionKeys]),
    contributions: Object.freeze(
      normalized.map((contribution) => Object.freeze(contribution)),
    ),
    issues: Object.freeze([...issues].sort()),
  };
}

function assertOutlierThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 1) {
    throw new RangeError("Outlier threshold must be finite and in [0, 1)");
  }
}

function assertDisagreementThresholds(
  warningThreshold: number,
  blockThreshold: number,
): void {
  if (
    !Number.isFinite(warningThreshold) ||
    !Number.isFinite(blockThreshold) ||
    warningThreshold < 0 ||
    blockThreshold > 1 ||
    warningThreshold > blockThreshold
  ) {
    throw new RangeError(
      "Disagreement thresholds must be finite, ordered, and in [0, 1]",
    );
  }
}

function freezeOutlierResult(
  result: Omit<MarketOutlierResult, "calculationVersion">,
): MarketOutlierResult {
  return Object.freeze({
    calculationVersion: MARKET_OUTLIER_CALCULATION_VERSION,
    ...result,
    issues: Object.freeze([...result.issues]),
    selectionKeys: Object.freeze([...result.selectionKeys]),
    centers:
      result.centers === null ? null : Object.freeze([...result.centers]),
    books: Object.freeze(
      result.books.map((book) =>
        Object.freeze({
          ...book,
          probabilities: Object.freeze([...book.probabilities]),
          deviations: Object.freeze([...book.deviations]),
          outlyingSelectionKeys: Object.freeze([...book.outlyingSelectionKeys]),
        }),
      ),
    ),
    outlierSportsbookIds: Object.freeze([...result.outlierSportsbookIds]),
  });
}

export function detectMarketOutliers(
  input: MarketOutlierInput,
): MarketOutlierResult {
  assertOutlierThreshold(input.threshold);
  const normalized = normalizeMarketQualityInput(
    input.selectionKeys,
    input.contributions,
  );
  if (normalized.issues.length > 0) {
    return freezeOutlierResult({
      status: "invalid",
      issues: normalized.issues,
      threshold: input.threshold,
      selectionKeys: normalized.selectionKeys,
      centers: null,
      books: [],
      outlierSportsbookIds: [],
    });
  }
  if (normalized.contributions.length === 0) {
    return freezeOutlierResult({
      status: "insufficient-data",
      issues: ["insufficient-vectors"],
      threshold: input.threshold,
      selectionKeys: normalized.selectionKeys,
      centers: null,
      books: [],
      outlierSportsbookIds: [],
    });
  }

  const centers = normalized.selectionKeys.map((_, index) =>
    upperMedian(
      normalized.contributions.map(
        ({ probabilities }) => probabilities[index]!,
      ),
    ),
  );
  const books = normalized.contributions.map((contribution) => {
    const deviations = contribution.probabilities.map((probability, index) =>
      Math.abs(probability - centers[index]!),
    );
    const outlyingSelectionKeys = normalized.selectionKeys.filter(
      (_, index) =>
        deviations[index]! - input.threshold >
        thresholdTolerance(input.threshold),
    );
    return {
      sportsbookId: contribution.sportsbookId,
      probabilities: contribution.probabilities,
      deviations,
      maximumDeviation: Math.max(...deviations),
      outlyingSelectionKeys,
      isOutlier: outlyingSelectionKeys.length > 0,
    } satisfies MarketOutlierBookAudit;
  });
  return freezeOutlierResult({
    status: "available",
    issues: [],
    threshold: input.threshold,
    selectionKeys: normalized.selectionKeys,
    centers,
    books,
    outlierSportsbookIds: books
      .filter(({ isOutlier }) => isOutlier)
      .map(({ sportsbookId }) => sportsbookId),
  });
}

function freezeDisagreementResult(
  result: Omit<MarketDisagreementResult, "calculationVersion">,
): MarketDisagreementResult {
  return Object.freeze({
    calculationVersion: MARKET_DISAGREEMENT_CALCULATION_VERSION,
    ...result,
    issues: Object.freeze([...result.issues]),
    ranges: Object.freeze(
      result.ranges.map((range) => Object.freeze({ ...range })),
    ),
    contributingSportsbookIds: Object.freeze([
      ...result.contributingSportsbookIds,
    ]),
  });
}

export function scoreMarketDisagreement(
  input: MarketDisagreementInput,
): MarketDisagreementResult {
  assertDisagreementThresholds(input.warningThreshold, input.blockThreshold);
  const normalized = normalizeMarketQualityInput(
    input.selectionKeys,
    input.contributions,
  );
  if (normalized.issues.length > 0) {
    return freezeDisagreementResult({
      status: "invalid",
      issues: normalized.issues,
      warningThreshold: input.warningThreshold,
      blockThreshold: input.blockThreshold,
      score: null,
      decisiveSelectionKey: null,
      classification: null,
      ranges: [],
      contributingSportsbookIds: [],
    });
  }
  if (normalized.contributions.length < 2) {
    return freezeDisagreementResult({
      status: "insufficient-data",
      issues: ["insufficient-vectors"],
      warningThreshold: input.warningThreshold,
      blockThreshold: input.blockThreshold,
      score: null,
      decisiveSelectionKey: null,
      classification: null,
      ranges: [],
      contributingSportsbookIds: normalized.contributions.map(
        ({ sportsbookId }) => sportsbookId,
      ),
    });
  }

  const ranges = normalized.selectionKeys.map((selectionKey, index) => {
    const values = normalized.contributions.map(
      ({ probabilities }) => probabilities[index]!,
    );
    const { minimumProbability, maximumProbability } = values.reduce(
      (range, probability) => ({
        minimumProbability: Math.min(range.minimumProbability, probability),
        maximumProbability: Math.max(range.maximumProbability, probability),
      }),
      { minimumProbability: Infinity, maximumProbability: -Infinity },
    );
    return {
      selectionKey,
      minimumProbability,
      maximumProbability,
      range: maximumProbability - minimumProbability,
    } satisfies MarketDisagreementRange;
  });
  const decisive = ranges.reduce((current, candidate) =>
    candidate.range > current.range ? candidate : current,
  );
  const classification: MarketDisagreementClassification =
    decisive.range + thresholdTolerance(input.blockThreshold) >=
    input.blockThreshold
      ? "block"
      : decisive.range + thresholdTolerance(input.warningThreshold) >=
          input.warningThreshold
        ? "warning"
        : "none";
  return freezeDisagreementResult({
    status: "available",
    issues: [],
    warningThreshold: input.warningThreshold,
    blockThreshold: input.blockThreshold,
    score: decisive.range,
    decisiveSelectionKey: decisive.selectionKey,
    classification,
    ranges,
    contributingSportsbookIds: normalized.contributions.map(
      ({ sportsbookId }) => sportsbookId,
    ),
  });
}
