export const CALCULATION_VERSION = "edge-calculation-v1" as const;

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
  market: "mlb-moneyline" | "mlb-pitcher-k" | "soccer-three-way";
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

  if (input.market !== "mlb-moneyline" && input.market !== "mlb-pitcher-k") {
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
