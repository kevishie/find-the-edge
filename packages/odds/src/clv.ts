import {
  americanToDecimal,
  calculateWeightedConsensus,
  impliedProbability,
  type ConsensusInput,
  type ConsensusResult,
} from "./index";

export const CLOSING_LINE_VALUE_CALCULATION_VERSION =
  "closing-line-value-v1" as const;
export const CLOSING_CONSENSUS_CLV_CALCULATION_VERSION =
  "closing-consensus-clv-v1" as const;

export interface ClosingLineValue {
  readonly calculationVersion: typeof CLOSING_LINE_VALUE_CALCULATION_VERSION;
  readonly placedAmericanOdds: number;
  readonly placedDecimalOdds: number;
  readonly placedImpliedProbability: number;
  readonly closingFairProbability: number;
  readonly priceClv: number;
  readonly probabilityClv: number;
}

export interface ClosingConsensusClvInput {
  readonly placedAmericanOdds: number;
  readonly selectionKey: string;
  readonly closingConsensusInput: ConsensusInput;
}

export type ClosingConsensusClvIssue =
  | "closing-consensus-invalid"
  | "closing-consensus-unavailable"
  | "invalid-placed-odds"
  | "numeric-overflow"
  | "selection-not-found";

export interface ClosingConsensusClvResult {
  readonly calculationVersion: typeof CLOSING_CONSENSUS_CLV_CALCULATION_VERSION;
  readonly status: "available" | "unavailable" | "invalid";
  readonly issues: readonly ClosingConsensusClvIssue[];
  readonly selectionKey: string;
  readonly values: Readonly<ClosingLineValue> | null;
  readonly consensus: ConsensusResult | null;
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function closingLineValue(
  placedAmericanOdds: number,
  closingFairProbability: number,
): ClosingLineValue {
  if (
    !Number.isFinite(closingFairProbability) ||
    closingFairProbability <= 0 ||
    closingFairProbability >= 1
  ) {
    throw new RangeError(
      "Closing fair probability must be greater than 0 and less than 1",
    );
  }
  const placedDecimalOdds = americanToDecimal(placedAmericanOdds);
  const placedImpliedProbability = impliedProbability(placedAmericanOdds);
  const priceClv = placedDecimalOdds * closingFairProbability - 1;
  const probabilityClv = closingFairProbability - placedImpliedProbability;
  if (
    !Number.isFinite(placedDecimalOdds) ||
    placedDecimalOdds <= 1 ||
    !Number.isFinite(placedImpliedProbability) ||
    !Number.isFinite(priceClv) ||
    !Number.isFinite(probabilityClv)
  ) {
    throw new RangeError("Closing line value exceeds numeric precision");
  }
  return Object.freeze({
    calculationVersion: CLOSING_LINE_VALUE_CALCULATION_VERSION,
    placedAmericanOdds,
    placedDecimalOdds,
    placedImpliedProbability,
    closingFairProbability,
    priceClv: normalizeNegativeZero(priceClv),
    probabilityClv: normalizeNegativeZero(probabilityClv),
  });
}

function freezeClosingConsensusClvResult(
  result: Omit<ClosingConsensusClvResult, "calculationVersion">,
): ClosingConsensusClvResult {
  return Object.freeze({
    calculationVersion: CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
    ...result,
    issues: Object.freeze([...result.issues]),
  });
}

export function calculateClosingConsensusClv(
  input: ClosingConsensusClvInput,
): ClosingConsensusClvResult {
  try {
    if (americanToDecimal(input.placedAmericanOdds) <= 1) {
      return freezeClosingConsensusClvResult({
        status: "invalid",
        issues: ["numeric-overflow"],
        selectionKey: input.selectionKey,
        values: null,
        consensus: null,
      });
    }
  } catch {
    return freezeClosingConsensusClvResult({
      status: "invalid",
      issues: ["invalid-placed-odds"],
      selectionKey: input.selectionKey,
      values: null,
      consensus: null,
    });
  }
  const consensus = calculateWeightedConsensus(input.closingConsensusInput);
  if (consensus.status === "invalid") {
    return freezeClosingConsensusClvResult({
      status: "invalid",
      issues: ["closing-consensus-invalid"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }
  if (consensus.status === "unavailable") {
    return freezeClosingConsensusClvResult({
      status: "unavailable",
      issues: ["closing-consensus-unavailable"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }

  const selectionIndex = input.closingConsensusInput.selectionKeys.indexOf(
    input.selectionKey,
  );
  const closingFairProbability = consensus.probabilities?.[selectionIndex];
  if (selectionIndex < 0 || closingFairProbability === undefined) {
    return freezeClosingConsensusClvResult({
      status: "unavailable",
      issues: ["selection-not-found"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }

  try {
    return freezeClosingConsensusClvResult({
      status: "available",
      issues: [],
      selectionKey: input.selectionKey,
      values: closingLineValue(
        input.placedAmericanOdds,
        closingFairProbability,
      ),
      consensus,
    });
  } catch {
    return freezeClosingConsensusClvResult({
      status: "invalid",
      issues: ["numeric-overflow"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }
}
