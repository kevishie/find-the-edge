import {
  canonicalCalculationJson,
  createCalculationProvenance,
  normalizeCalculationProvenance,
  type CalculationProvenance,
} from "../calculation-provenance.js";
import { sha256Hex } from "../fixture-odds.js";
import {
  isOpportunityPointVectorCoherent,
  type OpportunityComparisonExclusionReasonCode,
  type OpportunitySnapshotEvidence,
} from "../opportunity-candidate.js";

export const ARBITRAGE_FINDING_SCHEMA_VERSION = "arbitrage-finding-v1" as const;
export const ARBITRAGE_DETECTION_ALGORITHM_ID = "arbitrage-detection" as const;
export const ARBITRAGE_DETECTION_VERSION = "arbitrage-detection-v1" as const;

/** How far a quote may lead the evaluation instant before it is future-dated
 * rather than a concurrent write. Mirrors the provider-health tolerance. */
const QUOTE_SKEW_TOLERANCE_MS = 5 * 60_000;

export type ArbitrageClassification = "arbitrage" | "low-hold";

export interface ArbitrageLeg {
  readonly selectionKey: string;
  readonly point: number | null;
  /** The best actionable price for this outcome. */
  readonly best: OpportunitySnapshotEvidence;
  /** Every other actionable quote considered, proving "best" offline. */
  readonly competing: readonly OpportunitySnapshotEvidence[];
}

export interface ArbitrageExcludedBook {
  readonly sportsbookId: string;
  readonly reasonCodes: readonly OpportunityComparisonExclusionReasonCode[];
}

export interface ArbitrageFindingInput {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly marketKey: string;
  readonly startsAt: string;
  readonly evaluatedAt: string;
  readonly legs: readonly ArbitrageLeg[];
  readonly excludedBooks: readonly ArbitrageExcludedBook[];
  readonly policy: {
    readonly id: string;
    readonly version: string;
    readonly lowHoldThreshold: number;
    readonly maximumPriceAgeMinutes: number;
  };
}

export interface ArbitrageFinding extends ArbitrageFindingInput {
  readonly schemaVersion: typeof ARBITRAGE_FINDING_SCHEMA_VERSION;
  readonly findingId: string;
  readonly occurrenceId: string;
  readonly sumInverseDecimal: number;
  readonly holdPercentage: number;
  readonly classification: ArbitrageClassification;
  readonly expiresAt: string;
  readonly calculation: Readonly<CalculationProvenance>;
}

export function americanToDecimalOdds(americanOdds: number): number {
  if (
    !Number.isInteger(americanOdds) ||
    Math.abs(americanOdds) < 100 ||
    Math.abs(americanOdds) > 100_000
  )
    throw new Error("arbitrage-american-odds-invalid");
  return americanOdds > 0 ? americanOdds / 100 + 1 : 100 / -americanOdds + 1;
}

export interface MarketArbitrageComputation {
  readonly bestPerOutcome: readonly OpportunitySnapshotEvidence[];
  readonly sumInverseDecimal: number;
  readonly holdPercentage: number;
  readonly classification: ArbitrageClassification | null;
}

/** Best price per outcome across books, the market's total inverse-decimal
 * sum, and its classification under the policy threshold; null when the
 * market holds too much to matter. Pure — callers decide persistence. */
export function computeMarketArbitrage(
  quotesPerOutcome: readonly (readonly OpportunitySnapshotEvidence[])[],
  lowHoldThreshold: number,
): MarketArbitrageComputation | null {
  if (
    quotesPerOutcome.length < 2 ||
    quotesPerOutcome.length > 3 ||
    quotesPerOutcome.some((quotes) => quotes.length === 0)
  )
    return null;
  const bestPerOutcome = quotesPerOutcome.map((quotes) =>
    [...quotes].sort(
      (left, right) =>
        americanToDecimalOdds(right.americanOdds) -
          americanToDecimalOdds(left.americanOdds) ||
        left.sportsbookId.localeCompare(right.sportsbookId),
    ),
  );
  const sumInverseDecimal = bestPerOutcome.reduce(
    (sum, quotes) => sum + 1 / americanToDecimalOdds(quotes[0]!.americanOdds),
    0,
  );
  const classification: ArbitrageClassification | null =
    sumInverseDecimal < 1
      ? "arbitrage"
      : sumInverseDecimal < lowHoldThreshold
        ? "low-hold"
        : null;
  return {
    bestPerOutcome: bestPerOutcome.map((quotes) => quotes[0]!),
    sumInverseDecimal,
    holdPercentage: (sumInverseDecimal - 1) * 100,
    classification,
  };
}

const SAFE = /^[\x21-\x7e]{1,256}$/;
const identity = (value: string, reason: string): string => {
  if (typeof value !== "string" || !SAFE.test(value)) throw new Error(reason);
  return value;
};
const instant = (value: string, reason: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(reason);
  return value;
};

function validatedQuote(
  quote: OpportunitySnapshotEvidence,
  input: ArbitrageFindingInput,
  leg: ArbitrageLeg,
): OpportunitySnapshotEvidence {
  if (
    quote.canonicalEventId !== input.canonicalEventId ||
    quote.canonicalEventVersion !== input.canonicalEventVersion ||
    quote.sportKey !== input.sportKey ||
    quote.marketKey !== input.marketKey ||
    quote.selectionKey !== leg.selectionKey ||
    (quote.point ?? null) !== leg.point
  )
    throw new Error("arbitrage-quote-binding-invalid");
  if (
    quote.selectionAvailability?.state !== "active" ||
    quote.groupAvailability?.state !== "active"
  )
    throw new Error("arbitrage-quote-availability-invalid");
  const observed = Date.parse(quote.observedAt);
  const evaluated = Date.parse(input.evaluatedAt);
  if (
    !Number.isFinite(observed) ||
    observed > evaluated + QUOTE_SKEW_TOLERANCE_MS ||
    evaluated - observed > input.policy.maximumPriceAgeMinutes * 60_000
  )
    throw new Error("arbitrage-quote-time-invalid");
  americanToDecimalOdds(quote.americanOdds);
  identity(quote.sportsbookId, "arbitrage-quote-sportsbook-invalid");
  identity(quote.partitionKey, "arbitrage-quote-partition-invalid");
  identity(quote.snapshotId, "arbitrage-quote-snapshot-invalid");
  return quote;
}

export function createArbitrageFinding(
  input: ArbitrageFindingInput,
): ArbitrageFinding {
  identity(input.canonicalEventId, "arbitrage-event-id-invalid");
  identity(input.sportKey, "arbitrage-sport-key-invalid");
  identity(input.leagueKey, "arbitrage-league-key-invalid");
  identity(input.marketKey, "arbitrage-market-key-invalid");
  identity(input.policy.id, "arbitrage-policy-id-invalid");
  identity(input.policy.version, "arbitrage-policy-version-invalid");
  instant(input.startsAt, "arbitrage-starts-at-invalid");
  instant(input.evaluatedAt, "arbitrage-evaluated-at-invalid");
  if (
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1
  )
    throw new Error("arbitrage-event-version-invalid");
  if (
    !Number.isFinite(input.policy.lowHoldThreshold) ||
    input.policy.lowHoldThreshold <= 1 ||
    !Number.isFinite(input.policy.maximumPriceAgeMinutes) ||
    input.policy.maximumPriceAgeMinutes <= 0
  )
    throw new Error("arbitrage-policy-invalid");
  if (
    !isOpportunityPointVectorCoherent(
      input.marketKey,
      input.legs.map(({ selectionKey, point }) => ({ selectionKey, point })),
    )
  )
    throw new Error("arbitrage-point-vector-invalid");
  const legs = input.legs.map((leg) => {
    const best = validatedQuote(leg.best, input, leg);
    const competing = leg.competing.map((quote) =>
      validatedQuote(quote, input, leg),
    );
    const books = [best, ...competing].map(({ sportsbookId }) => sportsbookId);
    if (new Set(books).size !== books.length)
      throw new Error("arbitrage-leg-duplicate-book");
    if (
      competing.some(
        (quote) =>
          americanToDecimalOdds(quote.americanOdds) >
          americanToDecimalOdds(best.americanOdds),
      )
    )
      throw new Error("arbitrage-leg-best-price-contradicted");
    return Object.freeze({
      selectionKey: leg.selectionKey,
      point: leg.point,
      best,
      competing: Object.freeze(
        [...competing].sort((left, right) =>
          left.sportsbookId.localeCompare(right.sportsbookId),
        ),
      ),
    });
  });
  const excludedBooks = Object.freeze(
    [...input.excludedBooks]
      .map((book) =>
        Object.freeze({
          sportsbookId: identity(
            book.sportsbookId,
            "arbitrage-excluded-book-invalid",
          ),
          reasonCodes: Object.freeze([...book.reasonCodes].sort()),
        }),
      )
      .sort((left, right) =>
        left.sportsbookId.localeCompare(right.sportsbookId),
      ),
  );
  const sumInverseDecimal = legs.reduce(
    (sum, leg) => sum + 1 / americanToDecimalOdds(leg.best.americanOdds),
    0,
  );
  if (sumInverseDecimal >= input.policy.lowHoldThreshold)
    throw new Error("arbitrage-not-material");
  const classification: ArbitrageClassification =
    sumInverseDecimal < 1 ? "arbitrage" : "low-hold";
  const quotesInput = legs.map((leg) => ({
    selectionKey: leg.selectionKey,
    point: leg.point,
    quotes: [leg.best, ...leg.competing].map(
      ({ sportsbookId, americanOdds, snapshotId }) => ({
        sportsbookId,
        americanOdds,
        snapshotId,
      }),
    ),
  }));
  const calculation = createCalculationProvenance({
    algorithm: {
      id: ARBITRAGE_DETECTION_ALGORITHM_ID,
      version: ARBITRAGE_DETECTION_VERSION,
    },
    precisionPolicyVersion: "display-precision-v1",
    input: {
      canonicalEventId: input.canonicalEventId,
      canonicalEventVersion: input.canonicalEventVersion,
      marketKey: input.marketKey,
      evaluatedAt: input.evaluatedAt,
      policy: input.policy,
      legs: quotesInput,
    },
  });
  const normalized: ArbitrageFindingInput = {
    canonicalEventId: input.canonicalEventId,
    canonicalEventVersion: input.canonicalEventVersion,
    sportKey: input.sportKey,
    leagueKey: input.leagueKey,
    marketKey: input.marketKey,
    startsAt: input.startsAt,
    evaluatedAt: input.evaluatedAt,
    legs,
    excludedBooks,
    policy: Object.freeze({ ...input.policy }),
  };
  const findingId = `arb:${sha256Hex(
    canonicalCalculationJson({
      canonicalEventId: input.canonicalEventId,
      sportKey: input.sportKey,
      marketKey: input.marketKey,
      vector: legs.map(({ selectionKey, point }) => ({ selectionKey, point })),
    }),
  )}`;
  const occurrenceId = `arb-occurrence:${sha256Hex(
    canonicalCalculationJson({ ...normalized, calculation: null }),
  )}`;
  return Object.freeze({
    ...normalized,
    schemaVersion: ARBITRAGE_FINDING_SCHEMA_VERSION,
    findingId,
    occurrenceId,
    sumInverseDecimal,
    holdPercentage: (sumInverseDecimal - 1) * 100,
    classification,
    expiresAt: new Date(
      Date.parse(input.evaluatedAt) +
        input.policy.maximumPriceAgeMinutes * 60_000,
    ).toISOString(),
    calculation,
  });
}

/** Stored findings are re-derived, never trusted. */
export function normalizeArbitrageFinding(
  stored: ArbitrageFinding,
): ArbitrageFinding {
  if (stored.schemaVersion !== ARBITRAGE_FINDING_SCHEMA_VERSION)
    throw new Error("stored-arbitrage-finding-invalid");
  const rebuilt = createArbitrageFinding({
    canonicalEventId: stored.canonicalEventId,
    canonicalEventVersion: stored.canonicalEventVersion,
    sportKey: stored.sportKey,
    leagueKey: stored.leagueKey,
    marketKey: stored.marketKey,
    startsAt: stored.startsAt,
    evaluatedAt: stored.evaluatedAt,
    legs: stored.legs,
    excludedBooks: stored.excludedBooks,
    policy: stored.policy,
  });
  const storedCalculation = normalizeCalculationProvenance(stored.calculation);
  if (
    canonicalCalculationJson({ ...rebuilt, calculation: null }) !==
      canonicalCalculationJson({ ...stored, calculation: null }) ||
    canonicalCalculationJson(storedCalculation.root.inputHash) !==
      canonicalCalculationJson(rebuilt.calculation.root.inputHash)
  )
    throw new Error("stored-arbitrage-finding-invalid");
  return rebuilt;
}
