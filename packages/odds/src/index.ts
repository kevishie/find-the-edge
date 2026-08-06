import { detectMarketOutliers } from "./market-quality";
import type { CalculationProvenance } from "@find-the-edge/domain";
import {
  displayAmericanOdds,
  displayDecimalOdds,
  displayMoney,
  displayPercentage,
  DISPLAY_SCALES,
} from "./precision";
import { calculationProvenance, safeCalculationProvenance } from "./provenance";
import {
  CALCULATION_VERSION,
  CONSENSUS_CALCULATION_VERSION,
  FAIR_VALUE_CALCULATION_VERSION,
  FAIR_VALUE_DISPLAY_VERSION,
} from "./versions";

export {
  CALCULATION_VERSION,
  CONSENSUS_CALCULATION_VERSION,
  FAIR_VALUE_CALCULATION_VERSION,
  FAIR_VALUE_DISPLAY_VERSION,
};

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
  readonly provenance: Readonly<CalculationProvenance> | null;
  readonly display: Readonly<{
    readonly probabilities: readonly string[] | null;
  }>;
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
  readonly provenance: Readonly<CalculationProvenance>;
  readonly display: Readonly<{
    readonly marketImpliedProbability: string;
    readonly fairProbability: string;
    readonly fairAmerican: string;
    readonly expectedValue: string;
  }>;
}

export type FairValueIssue =
  | "invalid-fair-probability"
  | "invalid-offered-odds"
  | "invalid-stake"
  | "invalid-fractional-kelly-multiplier"
  | "numeric-overflow";

export interface FairValueInput {
  readonly fairProbability: number;
  readonly offeredAmerican: number;
  readonly stake: number;
  readonly fractionalKellyMultiplier: number;
}

export interface FairOdds {
  readonly decimalOdds: number;
  readonly americanOdds: number;
}

export interface FairValueValues {
  readonly fairDecimalOdds: number;
  readonly fairAmericanOdds: number;
  readonly offeredDecimalOdds: number;
  readonly expectedValue: number;
  readonly expectedProfit: number;
  readonly rawKellyFraction: number;
  readonly informationalKellyFraction: number;
  readonly fractionalKellyFraction: number;
}

export interface FairValueDisplayValues {
  readonly fairDecimalOdds: string;
  readonly fairAmericanOdds: string;
  readonly expectedValuePercent: string;
  readonly expectedProfit: string;
  readonly rawKellyPercent: string;
  readonly informationalKellyPercent: string;
  readonly fractionalKellyPercent: string;
}

export interface FairValueLabels {
  readonly expectedProfit: "Expected profit, not guaranteed profit";
  readonly kelly: "Informational only";
}

interface FairValueResultBase {
  readonly calculationVersion: typeof FAIR_VALUE_CALCULATION_VERSION;
  readonly displayVersion: typeof FAIR_VALUE_DISPLAY_VERSION;
  readonly inputs: Readonly<FairValueInput>;
  readonly issues: readonly FairValueIssue[];
  readonly labels: Readonly<FairValueLabels>;
  readonly provenance: Readonly<CalculationProvenance> | null;
}

export interface AvailableFairValueResult extends FairValueResultBase {
  readonly status: "available";
  readonly values: Readonly<FairValueValues>;
  readonly display: Readonly<FairValueDisplayValues>;
}

export interface InvalidFairValueResult extends FairValueResultBase {
  readonly status: "invalid";
  readonly values: null;
  readonly display: null;
}

export type FairValueResult = AvailableFairValueResult | InvalidFairValueResult;

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
    display: Object.freeze({
      probabilities:
        result.display.probabilities === null
          ? null
          : Object.freeze([...result.display.probabilities]),
    }),
  });
}

export function consensusProvenanceInput(input: ConsensusInput): unknown {
  return {
    targetSportsbookId: canonicalSportsbookId(input.targetSportsbookId),
    selectionKeys: [...input.selectionKeys],
    policy: {
      comparisonWeights: Object.entries(input.policy.comparisonWeights)
        .map(([sportsbookId, weight]) => [
          canonicalSportsbookId(sportsbookId),
          weight,
        ])
        .sort(
          ([leftId, leftWeight], [rightId, rightWeight]) =>
            compareCanonicalText(String(leftId), String(rightId)) ||
            compareCanonicalNumber(Number(leftWeight), Number(rightWeight)),
        ),
      minimumBooks: input.policy.minimumBooks,
      maximumAgeMinutes: input.policy.maximumAgeMinutes,
      outlierThreshold: input.policy.outlierThreshold,
    },
    books: input.books
      .map((book) => ({
        sportsbookId: canonicalSportsbookId(book.sportsbookId),
        ageMinutes: book.ageMinutes,
        status: book.status,
        selections: [...book.selections]
          .map((selection) => ({
            selectionKey: selection.selectionKey,
            americanOdds: selection.americanOdds,
          }))
          .sort(
            (left, right) =>
              compareCanonicalText(left.selectionKey, right.selectionKey) ||
              compareCanonicalNumber(left.americanOdds, right.americanOdds),
          ),
      }))
      .sort(compareConsensusBookEvidence),
  };
}

function consensusEvidence(
  input: ConsensusInput,
  result: Omit<
    ConsensusResult,
    "calculationVersion" | "provenance" | "display"
  >,
  outlierProvenance?: Readonly<CalculationProvenance> | null,
): ConsensusResult {
  const provenance = safeCalculationProvenance(
    "consensus",
    consensusProvenanceInput(input),
    [],
    outlierProvenance ? [outlierProvenance] : [],
  );
  return freezeConsensusResult({
    ...result,
    provenance,
    display: {
      probabilities:
        result.probabilities === null
          ? null
          : result.probabilities.map(
              (probability) => displayPercentage(probability).text,
            ),
    },
  });
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalNumberIdentity(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "+infinity";
  if (value === -Infinity) return "-infinity";
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function compareCanonicalNumber(left: number, right: number): number {
  if (Object.is(left, right) || (left === 0 && right === 0)) return 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return compareCanonicalText(
    canonicalNumberIdentity(left),
    canonicalNumberIdentity(right),
  );
}

function compareConsensusBookEvidence(
  left: {
    sportsbookId: string;
    ageMinutes: number;
    status: string;
    selections: readonly ConsensusSelectionInput[];
  },
  right: {
    sportsbookId: string;
    ageMinutes: number;
    status: string;
    selections: readonly ConsensusSelectionInput[];
  },
): number {
  const base =
    compareCanonicalText(left.sportsbookId, right.sportsbookId) ||
    compareCanonicalNumber(left.ageMinutes, right.ageMinutes) ||
    compareCanonicalText(left.status, right.status);
  if (base !== 0) return base;
  for (
    let index = 0;
    index < Math.max(left.selections.length, right.selections.length);
    index += 1
  ) {
    const leftSelection = left.selections[index];
    const rightSelection = right.selections[index];
    if (leftSelection === undefined) return -1;
    if (rightSelection === undefined) return 1;
    const comparison =
      compareCanonicalText(
        leftSelection.selectionKey,
        rightSelection.selectionKey,
      ) ||
      compareCanonicalNumber(
        leftSelection.americanOdds,
        rightSelection.americanOdds,
      );
    if (comparison !== 0) return comparison;
  }
  return 0;
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
    return consensusEvidence(input, {
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

  const outlierInput = {
    selectionKeys,
    contributions: [...eligible].sort((left, right) =>
      compareCanonicalText(left.sportsbookId, right.sportsbookId),
    ),
    threshold: input.policy.outlierThreshold,
  } as const;
  const outlierAudit = detectMarketOutliers(outlierInput);
  const outlierSportsbookIds = new Set(outlierAudit.outlierSportsbookIds);
  const included = eligible.filter((book) => {
    const outlier = outlierSportsbookIds.has(book.sportsbookId);
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

  return consensusEvidence(
    input,
    {
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
    },
    outlierAudit.provenance,
  );
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

export function fairOdds(fairProbability: number): FairOdds {
  assertFinite(fairProbability, "Fair probability");
  if (fairProbability <= 0 || fairProbability >= 1) {
    throw new RangeError(
      "Fair probability must be greater than 0 and less than 1",
    );
  }
  const decimalOdds = 1 / fairProbability;
  const americanOdds = probabilityToAmerican(fairProbability);
  if (
    !Number.isFinite(decimalOdds) ||
    decimalOdds <= 1 ||
    !Number.isFinite(americanOdds)
  ) {
    throw new RangeError("Fair odds exceed numeric precision");
  }
  return Object.freeze({ decimalOdds, americanOdds });
}

export function expectedProfit(
  stake: number,
  fairProbability: number,
  offeredAmerican: number,
): number {
  assertFinite(stake, "Stake");
  if (stake < 0) throw new RangeError("Stake must be nonnegative");
  const ev = expectedValue(fairProbability, offeredAmerican);
  const profit = stake * ev;
  if (!Number.isFinite(profit)) {
    throw new RangeError("Expected profit exceeds numeric precision");
  }
  if (stake !== 0 && ev !== 0 && profit === 0) {
    throw new RangeError("Expected profit collapsed below numeric precision");
  }
  return Object.is(profit, -0) ? 0 : profit;
}

export function kellyFraction(
  fairProbability: number,
  offeredAmerican: number,
): number {
  const decimalOdds = americanToDecimal(offeredAmerican);
  const profitMultiple = decimalOdds - 1;
  if (!Number.isFinite(profitMultiple) || profitMultiple <= 0) {
    throw new RangeError("Offered odds exceed numeric precision");
  }
  const ev = expectedValue(fairProbability, offeredAmerican);
  const fraction = ev / profitMultiple;
  if (!Number.isFinite(fraction)) {
    throw new RangeError("Kelly fraction exceeds numeric precision");
  }
  if (fraction === 0 && ev !== 0) {
    throw new RangeError("Kelly fraction collapsed below numeric precision");
  }
  return Object.is(fraction, -0) ? 0 : fraction;
}

export function fractionalKelly(
  fairProbability: number,
  offeredAmerican: number,
  multiplier: number,
): number {
  assertFinite(multiplier, "Fractional Kelly multiplier");
  if (multiplier <= 0 || multiplier > 1) {
    throw new RangeError(
      "Fractional Kelly multiplier must be greater than 0 and at most 1",
    );
  }
  const fraction = Math.max(0, kellyFraction(fairProbability, offeredAmerican));
  const fractional = fraction * multiplier;
  if (!Number.isFinite(fractional)) {
    throw new RangeError("Fractional Kelly exceeds numeric precision");
  }
  if (fraction > 0 && fractional === 0) {
    throw new RangeError("Fractional Kelly collapsed below numeric precision");
  }
  return Object.is(fractional, -0) ? 0 : fractional;
}

const FAIR_VALUE_LABELS = Object.freeze({
  expectedProfit: "Expected profit, not guaranteed profit",
  kelly: "Informational only",
} as const satisfies FairValueLabels);

function breakEvenProbability(american: number): number {
  return american > 0
    ? 100 / (100 + american)
    : Math.abs(american) / (Math.abs(american) + 100);
}

function freezeFairValueInputs(
  input: FairValueInput,
): Readonly<FairValueInput> {
  return Object.freeze({
    fairProbability: input.fairProbability,
    offeredAmerican: input.offeredAmerican,
    stake: input.stake,
    fractionalKellyMultiplier: input.fractionalKellyMultiplier,
  });
}

function invalidFairValueResult(
  inputs: Readonly<FairValueInput>,
  issues: readonly FairValueIssue[],
): InvalidFairValueResult {
  return Object.freeze({
    calculationVersion: FAIR_VALUE_CALCULATION_VERSION,
    displayVersion: FAIR_VALUE_DISPLAY_VERSION,
    status: "invalid",
    inputs,
    issues: Object.freeze([...issues]),
    labels: FAIR_VALUE_LABELS,
    provenance: safeCalculationProvenance("fairValue", inputs),
    values: null,
    display: null,
  });
}

export function calculateFairValue(input: FairValueInput): FairValueResult {
  const inputs = freezeFairValueInputs(input);
  const issues: FairValueIssue[] = [];
  if (
    !Number.isFinite(input.fairProbability) ||
    input.fairProbability <= 0 ||
    input.fairProbability >= 1
  ) {
    issues.push("invalid-fair-probability");
  }
  if (
    !Number.isFinite(input.offeredAmerican) ||
    (input.offeredAmerican > -100 && input.offeredAmerican < 100)
  ) {
    issues.push("invalid-offered-odds");
  }
  if (!Number.isFinite(input.stake) || input.stake < 0) {
    issues.push("invalid-stake");
  }
  if (
    !Number.isFinite(input.fractionalKellyMultiplier) ||
    input.fractionalKellyMultiplier <= 0 ||
    input.fractionalKellyMultiplier > 1
  ) {
    issues.push("invalid-fractional-kelly-multiplier");
  }
  if (issues.length > 0) return invalidFairValueResult(inputs, issues);

  try {
    const fair = fairOdds(input.fairProbability);
    const offeredDecimalOdds = americanToDecimal(input.offeredAmerican);
    const ev = expectedValue(input.fairProbability, input.offeredAmerican);
    if (
      ev === 0 &&
      input.fairProbability !== breakEvenProbability(input.offeredAmerican) &&
      input.fairProbability !== impliedProbability(input.offeredAmerican)
    ) {
      return invalidFairValueResult(inputs, ["numeric-overflow"]);
    }
    const profit = expectedProfit(
      input.stake,
      input.fairProbability,
      input.offeredAmerican,
    );
    const rawKellyFraction = kellyFraction(
      input.fairProbability,
      input.offeredAmerican,
    );
    const informationalKellyFraction = Math.max(0, rawKellyFraction);
    const fractionalKellyFraction = fractionalKelly(
      input.fairProbability,
      input.offeredAmerican,
      input.fractionalKellyMultiplier,
    );
    const values = {
      fairDecimalOdds: fair.decimalOdds,
      fairAmericanOdds: fair.americanOdds,
      offeredDecimalOdds,
      expectedValue: ev,
      expectedProfit: profit,
      rawKellyFraction,
      informationalKellyFraction,
      fractionalKellyFraction,
    } satisfies FairValueValues;
    if (
      offeredDecimalOdds <= 1 ||
      !Object.values(values).every(Number.isFinite)
    ) {
      return invalidFairValueResult(inputs, ["numeric-overflow"]);
    }
    const display = Object.freeze({
      fairDecimalOdds: displayDecimalOdds(values.fairDecimalOdds).text,
      fairAmericanOdds: displayAmericanOdds(values.fairAmericanOdds).text,
      expectedValuePercent: displayPercentage(values.expectedValue).text,
      expectedProfit: displayMoney(values.expectedProfit).text,
      rawKellyPercent: displayPercentage(values.rawKellyFraction).text,
      informationalKellyPercent: displayPercentage(
        values.informationalKellyFraction,
      ).text,
      fractionalKellyPercent: displayPercentage(values.fractionalKellyFraction)
        .text,
    } satisfies FairValueDisplayValues);
    return Object.freeze({
      calculationVersion: FAIR_VALUE_CALCULATION_VERSION,
      displayVersion: FAIR_VALUE_DISPLAY_VERSION,
      status: "available",
      inputs,
      issues: Object.freeze([]),
      labels: FAIR_VALUE_LABELS,
      provenance: calculationProvenance("fairValue", inputs),
      values: Object.freeze(values),
      display,
    });
  } catch {
    return invalidFairValueResult(inputs, ["numeric-overflow"]);
  }
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

  const fairAmerican = probabilityToAmerican(input.fairProbability);
  const marketImpliedProbability = impliedProbability(input.offeredAmerican);
  const approvedMarketKeys = [...new Set(input.approvedMarketKeys)].sort(
    compareCanonicalText,
  );
  return Object.freeze({
    calculationVersion: CALCULATION_VERSION,
    decision,
    decimalOdds: americanToDecimal(input.offeredAmerican),
    marketImpliedProbability,
    fairProbability: input.fairProbability,
    fairAmerican,
    expectedValue: ev,
    reasons: Object.freeze(reasons) as QualificationReason[],
    provenance: calculationProvenance("edge", {
      offeredAmerican: input.offeredAmerican,
      fairProbability: input.fairProbability,
      marketKey: input.marketKey,
      approvedMarketKeys,
      comparisonBooks: input.comparisonBooks,
      priceAgeMinutes: input.priceAgeMinutes,
      lineupConfirmed: input.lineupConfirmed,
      minutesToStart: input.minutesToStart,
      publicTicketPercent: input.publicTicketPercent ?? 0,
      overwhelmingAnalyticalEdge: input.overwhelmingAnalyticalEdge ?? false,
      minimumEv,
      minimumBooks,
      maximumPriceAgeMinutes: maximumAge,
    }),
    display: Object.freeze({
      marketImpliedProbability: displayPercentage(
        marketImpliedProbability,
        DISPLAY_SCALES.edgeLabPercentage,
      ).text,
      fairProbability: displayPercentage(
        input.fairProbability,
        DISPLAY_SCALES.edgeLabPercentage,
      ).text,
      fairAmerican: displayAmericanOdds(fairAmerican).text,
      expectedValue: displayPercentage(ev, DISPLAY_SCALES.edgeLabPercentage)
        .text,
    }),
  });
}

export * from "./qualification";
export * from "./grading";
export * from "./performance";
export * from "./movement";
export * from "./market-quality";
export * from "./clv";
export * from "./versions";
export * from "./precision";
export * from "./provenance";
