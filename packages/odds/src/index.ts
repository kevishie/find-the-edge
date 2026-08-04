export const CALCULATION_VERSION = "edge-calculation-v1" as const;
export const CONSENSUS_CALCULATION_VERSION = "weighted-consensus-v1" as const;

export type ConsensusIssue = "stale" | "suspended" | "sparse" | "outlier";

export interface ConsensusBookInput {
  sportsbookId: string;
  americanOdds: readonly number[];
  weight: number;
  ageMinutes: number;
  status: "active" | "suspended";
}

export interface ConsensusExclusion {
  sportsbookId: string;
  reason:
    "offered-sportsbook" | "stale" | "suspended" | "outlier" | "invalid-market";
}

export interface ConsensusInput {
  books: readonly ConsensusBookInput[];
  offeredSportsbookId: string;
  outcomeCount: 2 | 3;
  minimumBooks?: number;
  maximumAgeMinutes?: number;
  outlierThreshold?: number;
}

export interface ConsensusResult {
  calculationVersion: typeof CONSENSUS_CALCULATION_VERSION;
  status: "available" | "unavailable";
  issues: ConsensusIssue[];
  probabilities: number[] | null;
  includedSportsbookIds: string[];
  exclusions: ConsensusExclusion[];
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
  const lower = ordered[middle - 1];
  return ordered.length % 2 === 0 && lower !== undefined
    ? (lower + upper) / 2
    : upper;
}

export function calculateWeightedConsensus(
  input: ConsensusInput,
): ConsensusResult {
  const minimumBooks = input.minimumBooks ?? 3;
  const maximumAge = input.maximumAgeMinutes ?? 15;
  const outlierThreshold = input.outlierThreshold ?? 0.08;
  const exclusions: ConsensusExclusion[] = [];
  const issues = new Set<ConsensusIssue>();

  const eligible = input.books.flatMap((book) => {
    let reason: ConsensusExclusion["reason"] | undefined;
    if (book.sportsbookId === input.offeredSportsbookId) {
      reason = "offered-sportsbook";
    } else if (book.status === "suspended") {
      reason = "suspended";
      issues.add("suspended");
    } else if (book.ageMinutes > maximumAge) {
      reason = "stale";
      issues.add("stale");
    } else if (
      book.americanOdds.length !== input.outcomeCount ||
      !Number.isFinite(book.weight) ||
      book.weight <= 0
    ) {
      reason = "invalid-market";
    }

    if (reason) {
      exclusions.push({ sportsbookId: book.sportsbookId, reason });
      return [];
    }
    return [{ ...book, probabilities: removeVig(book.americanOdds) }];
  });

  const centers =
    eligible.length === 0
      ? []
      : Array.from({ length: input.outcomeCount }, (_, index) =>
          median(eligible.map((book) => book.probabilities[index] ?? 0)),
        );
  const included = eligible.filter((book) => {
    const outlier = book.probabilities.some(
      (probability, index) =>
        Math.abs(probability - (centers[index] ?? probability)) >
        outlierThreshold,
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

  if (included.length < minimumBooks) issues.add("sparse");
  const totalWeight = included.reduce((sum, book) => sum + book.weight, 0);
  const probabilities =
    included.length === 0
      ? null
      : Array.from(
          { length: input.outcomeCount },
          (_, index) =>
            included.reduce(
              (sum, book) =>
                sum + (book.probabilities[index] ?? 0) * book.weight,
              0,
            ) / totalWeight,
        );

  return {
    calculationVersion: CONSENSUS_CALCULATION_VERSION,
    status:
      probabilities !== null && included.length >= minimumBooks
        ? "available"
        : "unavailable",
    issues: [...issues],
    probabilities,
    includedSportsbookIds: included.map((book) => book.sportsbookId),
    exclusions,
  };
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
