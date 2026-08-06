export const CALCULATION_VERSION = "edge-calculation-v1" as const;
export const CONSENSUS_CALCULATION_VERSION = "weighted-consensus-v1" as const;

export type ConsensusExclusionReason =
  | "target-sportsbook"
  | "unconfigured"
  | "zero-weight"
  | "stale"
  | "suspended"
  | "closed"
  | "unavailable"
  | "missing-selection"
  | "duplicate-selection"
  | "invalid-odds"
  | "invalid-age"
  | "outlier"
  | "duplicate-sportsbook"
  | "invalid-sportsbook"
  | "invalid-status";

export type ConsensusIssue =
  ConsensusExclusionReason | "invalid-market" | "insufficient-books";

export interface ConsensusSelectionInput {
  readonly selectionKey: string;
  readonly americanOdds: number;
}

export interface ConsensusBookInput {
  readonly sportsbookId: string;
  readonly selections: readonly ConsensusSelectionInput[];
  readonly ageMinutes: number;
  readonly status: "active" | "suspended" | "closed" | "unavailable";
}

export interface ConsensusExclusion {
  readonly sportsbookId: string;
  readonly reason: ConsensusExclusionReason;
}

export interface ConsensusPolicy {
  readonly comparisonWeights: Readonly<Record<string, number>>;
  readonly minimumBooks: number;
  readonly maximumAgeMinutes: number;
  readonly outlierThreshold: number;
}

export interface ConsensusInput {
  books: readonly ConsensusBookInput[];
  targetSportsbookId: string;
  selectionKeys: readonly string[];
  policy: ConsensusPolicy;
}

export interface ConsensusContribution {
  readonly sportsbookId: string;
  readonly weight: number;
  readonly probabilities: readonly number[];
}

export interface ConsensusResult {
  readonly calculationVersion: typeof CONSENSUS_CALCULATION_VERSION;
  readonly status: "available" | "unavailable" | "invalid";
  readonly issues: readonly ConsensusIssue[];
  readonly probabilities: readonly number[] | null;
  readonly requiredBookCount: number;
  readonly eligibleBookCount: number;
  readonly includedSportsbookIds: readonly string[];
  readonly contributions: readonly ConsensusContribution[];
  readonly exclusions: readonly ConsensusExclusion[];
}

export type QualificationReason =
  | "positive-ev"
  | "ev-below-threshold"
  | "insufficient-books"
  | "stale-price"
  | "lineup-unconfirmed"
  | "public-fade"
  | "unsupported-market";

export interface EdgeInput {
  offeredAmerican: number;
  fairProbability: number;
  marketKey: string;
  approvedMarketKeys: readonly string[];
  comparisonBooks: number;
  priceAgeMinutes: number;
  lineupConfirmed: boolean;
  minutesToStart: number;
  publicTicketPercent?: number;
  overwhelmingAnalyticalEdge?: boolean;
  minimumEv?: number;
  minimumBooks?: number;
  maximumPriceAgeMinutes?: number;
}

export interface EdgeEvaluation {
  calculationVersion: typeof CALCULATION_VERSION;
  decision: "play" | "no-bet";
  decimalOdds: number;
  marketImpliedProbability: number;
  fairProbability: number;
  fairAmerican: number;
  expectedValue: number;
  reasons: QualificationReason[];
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

export function americanToDecimal(american: number): number {
  assertFinite(american, "American odds");
  if (american === 0 || Math.abs(american) < 100) {
    throw new RangeError(
      "American odds must be +100 or greater, or -100 or lower",
    );
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function decimalToAmerican(decimal: number): number {
  assertFinite(decimal, "Decimal odds");
  if (decimal <= 1) {
    throw new RangeError("Decimal odds must be greater than 1");
  }
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

export function impliedProbability(american: number): number {
  return 1 / americanToDecimal(american);
}

export function probabilityToAmerican(probability: number): number {
  assertFinite(probability, "Probability");
  if (probability <= 0 || probability >= 1) {
    throw new RangeError("Probability must be greater than 0 and less than 1");
  }
  return decimalToAmerican(1 / probability);
}

export function removeVig(americanOdds: readonly number[]): number[] {
  if (americanOdds.length < 2) {
    throw new RangeError("At least two outcomes are required to remove vig");
  }
  const raw = americanOdds.map(impliedProbability);
  const overround = raw.reduce((total, probability) => total + probability, 0);
  return raw.map((probability) => probability / overround);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  if (upper === undefined) throw new RangeError("Median requires values");
  return upper;
}

function canonicalSportsbookId(value: string): string {
  return value.trim().toLowerCase();
}

function freezeConsensusResult(
  result: Omit<ConsensusResult, "calculationVersion">,
): ConsensusResult {
  return Object.freeze({
    calculationVersion: CONSENSUS_CALCULATION_VERSION,
    ...result,
    issues: Object.freeze([...result.issues]),
    probabilities:
      result.probabilities === null
        ? null
        : Object.freeze([...result.probabilities]),
    includedSportsbookIds: Object.freeze([...result.includedSportsbookIds]),
    contributions: Object.freeze(
      result.contributions.map((contribution) =>
        Object.freeze({
          ...contribution,
          probabilities: Object.freeze([...contribution.probabilities]),
        }),
      ),
    ),
    exclusions: Object.freeze(
      result.exclusions.map((exclusion) => Object.freeze({ ...exclusion })),
    ),
  });
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateConsensusPolicy(
  policy: ConsensusPolicy,
  targetSportsbookId: string,
): void {
  if (
    typeof policy.comparisonWeights !== "object" ||
    policy.comparisonWeights === null ||
    Array.isArray(policy.comparisonWeights)
  ) {
    throw new RangeError("Consensus comparison weights must be a record");
  }
  if (!Number.isSafeInteger(policy.minimumBooks) || policy.minimumBooks < 1) {
    throw new RangeError("Consensus minimum books must be a positive integer");
  }
  if (
    !Number.isFinite(policy.maximumAgeMinutes) ||
    policy.maximumAgeMinutes < 0
  ) {
    throw new RangeError(
      "Consensus maximum age must be finite and nonnegative",
    );
  }
  if (
    !Number.isFinite(policy.outlierThreshold) ||
    policy.outlierThreshold < 0 ||
    policy.outlierThreshold >= 1
  ) {
    throw new RangeError(
      "Consensus outlier threshold must be finite and in [0, 1)",
    );
  }

  const configuredIds = new Set<string>();
  let positiveComparisonBooks = 0;
  for (const [sportsbookId, weight] of Object.entries(
    policy.comparisonWeights,
  )) {
    const canonicalId = canonicalSportsbookId(sportsbookId);
    if (!canonicalId || configuredIds.has(canonicalId)) {
      throw new RangeError(
        "Consensus comparison sportsbook IDs must be unique",
      );
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(
        "Consensus comparison weights must be finite and nonnegative",
      );
    }
    if (canonicalId !== targetSportsbookId && weight > 0)
      positiveComparisonBooks += 1;
    configuredIds.add(canonicalId);
  }
  if (positiveComparisonBooks < policy.minimumBooks) {
    throw new RangeError(
      "Consensus policy cannot satisfy its minimum comparison books",
    );
  }
}

function sortedUniqueIssues(
  issues: Iterable<ConsensusIssue>,
): ConsensusIssue[] {
  return [...new Set(issues)].sort();
}

export function calculateWeightedConsensus(
  input: ConsensusInput,
): ConsensusResult {
  const selectionKeys = [...input.selectionKeys];
  const targetSportsbookId = canonicalSportsbookId(input.targetSportsbookId);
  if (!targetSportsbookId) {
    throw new RangeError("Consensus target sportsbook is required");
  }
  validateConsensusPolicy(input.policy, targetSportsbookId);
  const invalidMarket =
    (selectionKeys.length !== 2 && selectionKeys.length !== 3) ||
    selectionKeys.some((selectionKey) => !selectionKey.trim()) ||
    new Set(selectionKeys).size !== selectionKeys.length;

  const canonicalBookIds = input.books.map(({ sportsbookId }) =>
    canonicalSportsbookId(sportsbookId),
  );
  const duplicateBookIds = new Set(
    canonicalBookIds.filter(
      (sportsbookId, index) =>
        sportsbookId && canonicalBookIds.indexOf(sportsbookId) !== index,
    ),
  );
  if (invalidMarket || duplicateBookIds.size > 0) {
    const exclusions = canonicalBookIds
      .filter((sportsbookId) => duplicateBookIds.has(sportsbookId))
      .sort(compareCanonicalText)
      .map((sportsbookId) => ({
        sportsbookId,
        reason: "duplicate-sportsbook" as const,
      }));
    return freezeConsensusResult({
      status: "invalid",
      issues: sortedUniqueIssues([
        ...(invalidMarket ? (["invalid-market"] as const) : []),
        ...(duplicateBookIds.size > 0
          ? (["duplicate-sportsbook"] as const)
          : []),
      ]),
      probabilities: null,
      requiredBookCount: input.policy.minimumBooks,
      eligibleBookCount: 0,
      includedSportsbookIds: [],
      contributions: [],
      exclusions,
    });
  }

  const configuredWeights = new Map(
    Object.entries(input.policy.comparisonWeights).map(
      ([sportsbookId, weight]) => [canonicalSportsbookId(sportsbookId), weight],
    ),
  );
  const exclusions: ConsensusExclusion[] = [];
  const issues = new Set<ConsensusIssue>();

  const eligible = input.books.flatMap((book) => {
    const sportsbookId = canonicalSportsbookId(book.sportsbookId);
    const weight = configuredWeights.get(sportsbookId);
    const keyedSelections = new Map<string, number>();
    let duplicateSelection = false;
    for (const selection of book.selections) {
      if (keyedSelections.has(selection.selectionKey))
        duplicateSelection = true;
      keyedSelections.set(selection.selectionKey, selection.americanOdds);
    }

    let reason: ConsensusExclusionReason | undefined;
    if (!sportsbookId) {
      reason = "invalid-sportsbook";
    } else if (sportsbookId === targetSportsbookId) {
      reason = "target-sportsbook";
    } else if (
      book.status !== "active" &&
      book.status !== "suspended" &&
      book.status !== "closed" &&
      book.status !== "unavailable"
    ) {
      reason = "invalid-status";
    } else if (book.status !== "active") {
      reason = book.status;
    } else if (!Number.isFinite(book.ageMinutes) || book.ageMinutes < 0) {
      reason = "invalid-age";
    } else if (book.ageMinutes > input.policy.maximumAgeMinutes) {
      reason = "stale";
    } else if (duplicateSelection) {
      reason = "duplicate-selection";
    } else if (
      book.selections.length !== selectionKeys.length ||
      selectionKeys.some((selectionKey) => !keyedSelections.has(selectionKey))
    ) {
      reason = "missing-selection";
    } else if (weight === undefined) {
      reason = "unconfigured";
    } else if (weight === 0) {
      reason = "zero-weight";
    }

    if (reason) {
      issues.add(reason);
      exclusions.push({ sportsbookId, reason });
      return [];
    }

    let probabilities: number[];
    try {
      probabilities = removeVig(
        selectionKeys.map((selectionKey) => keyedSelections.get(selectionKey)!),
      );
    } catch {
      issues.add("invalid-odds");
      exclusions.push({ sportsbookId, reason: "invalid-odds" });
      return [];
    }
    return [{ sportsbookId, probabilities, weight: weight! }];
  });

  const centers =
    eligible.length === 0
      ? []
      : Array.from({ length: selectionKeys.length }, (_, index) =>
          median(eligible.map((book) => book.probabilities[index]!)),
        );
  const included = eligible.filter((book) => {
    const outlier = book.probabilities.some(
      (probability, index) =>
        Math.abs(probability - (centers[index] ?? probability)) >
        input.policy.outlierThreshold,
    );
    if (outlier) {
      issues.add("outlier");
      exclusions.push({
        sportsbookId: book.sportsbookId,
        reason: "outlier",
      });
    }
    return !outlier;
  });

  included.sort((left, right) =>
    compareCanonicalText(left.sportsbookId, right.sportsbookId),
  );
  exclusions.sort(
    (left, right) =>
      compareCanonicalText(left.sportsbookId, right.sportsbookId) ||
      compareCanonicalText(left.reason, right.reason),
  );

  if (included.length < input.policy.minimumBooks)
    issues.add("insufficient-books");
  const available = included.length >= input.policy.minimumBooks;
  const maximumWeight = available
    ? included.reduce((maximum, { weight }) => Math.max(maximum, weight), 0)
    : 0;
  const scaledTotalWeight = available
    ? included.reduce((sum, book) => sum + book.weight / maximumWeight, 0)
    : 0;
  const weighted = available
    ? selectionKeys.map(
        (_, index) =>
          included.reduce(
            (sum, book) =>
              sum + book.probabilities[index]! * (book.weight / maximumWeight),
            0,
          ) / scaledTotalWeight,
      )
    : null;
  const probabilityTotal = weighted?.reduce((sum, value) => sum + value, 0);
  const probabilities =
    weighted && probabilityTotal
      ? weighted.map((probability) => probability / probabilityTotal)
      : null;

  return freezeConsensusResult({
    status: available ? "available" : "unavailable",
    issues: sortedUniqueIssues(issues),
    probabilities,
    requiredBookCount: input.policy.minimumBooks,
    eligibleBookCount: included.length,
    includedSportsbookIds: included.map((book) => book.sportsbookId),
    contributions: included.map((book) => ({
      sportsbookId: book.sportsbookId,
      weight: book.weight,
      probabilities: book.probabilities,
    })),
    exclusions,
  });
}

export function expectedValue(
  fairProbability: number,
  offeredAmerican: number,
): number {
  assertFinite(fairProbability, "Fair probability");
  if (fairProbability <= 0 || fairProbability >= 1) {
    throw new RangeError(
      "Fair probability must be greater than 0 and less than 1",
    );
  }
  return fairProbability * americanToDecimal(offeredAmerican) - 1;
}

export function evaluateEdge(input: EdgeInput): EdgeEvaluation {
  const minimumEv = input.minimumEv ?? 0.02;
  const minimumBooks = input.minimumBooks ?? 3;
  const maximumAge = input.maximumPriceAgeMinutes ?? 15;
  const ev = expectedValue(input.fairProbability, input.offeredAmerican);
  const reasons: QualificationReason[] = [];

  if (!input.approvedMarketKeys.includes(input.marketKey)) {
    reasons.push("unsupported-market");
  }
  if (ev < minimumEv) reasons.push("ev-below-threshold");
  if (input.comparisonBooks < minimumBooks) reasons.push("insufficient-books");
  if (input.priceAgeMinutes > maximumAge) reasons.push("stale-price");
  if (input.minutesToStart <= 60 && !input.lineupConfirmed)
    reasons.push("lineup-unconfirmed");
  if (
    (input.publicTicketPercent ?? 0) >= 80 &&
    !(input.overwhelmingAnalyticalEdge ?? false)
  ) {
    reasons.push("public-fade");
  }

  const decision = reasons.length === 0 ? "play" : "no-bet";
  if (decision === "play") reasons.push("positive-ev");

  return {
    calculationVersion: CALCULATION_VERSION,
    decision,
    decimalOdds: americanToDecimal(input.offeredAmerican),
    marketImpliedProbability: impliedProbability(input.offeredAmerican),
    fairProbability: input.fairProbability,
    fairAmerican: probabilityToAmerican(input.fairProbability),
    expectedValue: ev,
    reasons,
  };
}

export * from "./qualification";
export * from "./grading";
export * from "./performance";
