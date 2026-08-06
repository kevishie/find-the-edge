import {
  americanToDecimal,
  calculateWeightedConsensus,
  consensusProvenanceInput,
  impliedProbability,
  type ConsensusInput,
  type ConsensusResult,
} from "./index";
import type { CalculationProvenance } from "@find-the-edge/domain";
import {
  displayAmericanOdds,
  displayDecimalOdds,
  displayPercentage,
} from "./precision";
import { calculationProvenance, safeCalculationProvenance } from "./provenance";
import {
  CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
  CLOSING_LINE_VALUE_CALCULATION_VERSION,
} from "./versions";

export {
  CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
  CLOSING_LINE_VALUE_CALCULATION_VERSION,
};

export interface ClosingLineValue {
  readonly calculationVersion: typeof CLOSING_LINE_VALUE_CALCULATION_VERSION;
  readonly placedAmericanOdds: number;
  readonly placedDecimalOdds: number;
  readonly placedImpliedProbability: number;
  readonly closingFairProbability: number;
  readonly priceClv: number;
  readonly probabilityClv: number;
  readonly provenance: Readonly<CalculationProvenance>;
  readonly display: Readonly<{
    readonly placedAmericanOdds: string;
    readonly placedDecimalOdds: string;
    readonly closingFairProbability: string;
    readonly priceClv: string;
    readonly probabilityClv: string;
  }>;
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
  readonly provenance: Readonly<CalculationProvenance> | null;
  readonly display: ClosingLineValue["display"] | null;
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
  const provenance = calculationProvenance("closingLineValue", {
    placedAmericanOdds,
    closingFairProbability,
  });
  return Object.freeze({
    calculationVersion: CLOSING_LINE_VALUE_CALCULATION_VERSION,
    placedAmericanOdds,
    placedDecimalOdds,
    placedImpliedProbability,
    closingFairProbability,
    priceClv: normalizeNegativeZero(priceClv),
    probabilityClv: normalizeNegativeZero(probabilityClv),
    provenance,
    display: Object.freeze({
      placedAmericanOdds: displayAmericanOdds(placedAmericanOdds).text,
      placedDecimalOdds: displayDecimalOdds(placedDecimalOdds).text,
      closingFairProbability: displayPercentage(closingFairProbability).text,
      priceClv: displayPercentage(normalizeNegativeZero(priceClv)).text,
      probabilityClv: displayPercentage(normalizeNegativeZero(probabilityClv))
        .text,
    }),
  });
}

function freezeClosingConsensusClvResult(
  result: Omit<ClosingConsensusClvResult, "calculationVersion">,
): ClosingConsensusClvResult {
  return Object.freeze({
    calculationVersion: CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
    ...result,
    issues: Object.freeze([...result.issues]),
    display:
      result.display === null ? null : Object.freeze({ ...result.display }),
  });
}

function closingConsensusEvidence(
  input: ClosingConsensusClvInput,
  result: Omit<
    ClosingConsensusClvResult,
    "calculationVersion" | "provenance" | "display"
  >,
): ClosingConsensusClvResult {
  let provenance: Readonly<CalculationProvenance> | null = null;
  try {
    provenance = safeCalculationProvenance(
      "closingConsensusClv",
      {
        placedAmericanOdds: input.placedAmericanOdds,
        selectionKey: input.selectionKey,
        closingConsensusInput: consensusProvenanceInput(
          input.closingConsensusInput,
        ),
      },
      [],
      [result.consensus?.provenance, result.values?.provenance].filter(
        (item): item is Readonly<CalculationProvenance> => item != null,
      ),
    );
  } catch {
    // Invalid callers still receive the typed invalid result. Optional
    // provenance must never turn fail-closed calculation handling into a throw.
  }
  return freezeClosingConsensusClvResult({
    ...result,
    provenance,
    display: result.values?.display ?? null,
  });
}

export function calculateClosingConsensusClv(
  input: ClosingConsensusClvInput,
): ClosingConsensusClvResult {
  try {
    if (americanToDecimal(input.placedAmericanOdds) <= 1) {
      return closingConsensusEvidence(input, {
        status: "invalid",
        issues: ["numeric-overflow"],
        selectionKey: input.selectionKey,
        values: null,
        consensus: null,
      });
    }
  } catch {
    return closingConsensusEvidence(input, {
      status: "invalid",
      issues: ["invalid-placed-odds"],
      selectionKey: input.selectionKey,
      values: null,
      consensus: null,
    });
  }
  let consensus: ConsensusResult;
  try {
    consensus = calculateWeightedConsensus(input.closingConsensusInput);
  } catch {
    return closingConsensusEvidence(input, {
      status: "invalid",
      issues: ["closing-consensus-invalid"],
      selectionKey: input.selectionKey,
      values: null,
      consensus: null,
    });
  }
  if (consensus.status === "invalid") {
    return closingConsensusEvidence(input, {
      status: "invalid",
      issues: ["closing-consensus-invalid"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }
  if (consensus.status === "unavailable") {
    return closingConsensusEvidence(input, {
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
    return closingConsensusEvidence(input, {
      status: "unavailable",
      issues: ["selection-not-found"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }

  try {
    return closingConsensusEvidence(input, {
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
    return closingConsensusEvidence(input, {
      status: "invalid",
      issues: ["numeric-overflow"],
      selectionKey: input.selectionKey,
      values: null,
      consensus,
    });
  }
}
