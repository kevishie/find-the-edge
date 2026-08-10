import {
  calculationInputHash,
  canonicalCalculationJson,
  normalizeCalculationProvenance,
  readFixtureOddsSnapshotRecord,
  type CalculationProvenance,
  type NormalizedFixtureOddsSnapshot,
} from "@find-the-edge/domain";

import {
  CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
  CLOSING_LINE_VALUE_CALCULATION_VERSION,
  CONSENSUS_CALCULATION_VERSION,
  FAIR_VALUE_CALCULATION_VERSION,
  LINE_MOVEMENT_CALCULATION_VERSION,
  MARKET_DISAGREEMENT_CALCULATION_VERSION,
  QUALIFICATION_VERSION,
  FAIR_VALUE_DISPLAY_VERSION,
} from "./versions";
import {
  displayAmericanOdds,
  displayDecimalOdds,
  displayMoney,
  displayPercentage,
} from "./precision";
import {
  calculateFairValue,
  calculateWeightedConsensus,
  removeVig,
  type ConsensusInput,
  type FairValueInput,
} from "./index";
import { qualifyEvaluation, type QualificationInput } from "./qualification";
import { calculateLineMovement, type LineMovementInput } from "./movement";
import {
  scoreMarketDisagreement,
  type MarketDisagreementInput,
} from "./market-quality";
import {
  calculateClosingConsensusClv,
  closingLineValue,
  type ClosingConsensusClvInput,
} from "./clv";

export type ReportCalculationKind =
  | "consensus"
  | "fair-value"
  | "qualification"
  | "line-movement"
  | "market-disagreement"
  | "clv";

export type ReportOddsSnapshotIdentity = NormalizedFixtureOddsSnapshot;

export interface ReportCalculationReference {
  readonly id: string;
  readonly kind: ReportCalculationKind;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: string;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly snapshotIdentities: readonly Readonly<ReportOddsSnapshotIdentity>[];
  readonly calculationInput: unknown;
  readonly calculationVersion: string;
  readonly status: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly display: unknown;
  readonly provenance: Readonly<CalculationProvenance>;
  readonly referenceHash: string;
}

export interface CreateReportCalculationReferenceInput {
  readonly id: string;
  readonly kind: ReportCalculationKind;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: string | number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly snapshots: readonly NormalizedFixtureOddsSnapshot[];
  readonly calculationInput: unknown;
  readonly result: unknown;
}

export class ReportCalculationReferenceError extends Error {
  override readonly name = "ReportCalculationReferenceError";
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const expectedVersions: Readonly<
  Record<ReportCalculationKind, readonly string[]>
> = {
  consensus: [CONSENSUS_CALCULATION_VERSION],
  "fair-value": [FAIR_VALUE_CALCULATION_VERSION],
  qualification: [QUALIFICATION_VERSION],
  "line-movement": [LINE_MOVEMENT_CALCULATION_VERSION],
  "market-disagreement": [MARKET_DISAGREEMENT_CALCULATION_VERSION],
  clv: [
    CLOSING_LINE_VALUE_CALCULATION_VERSION,
    CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
  ],
};
const expectedAlgorithmIds: Readonly<
  Record<ReportCalculationKind, readonly string[]>
> = {
  consensus: ["weighted-consensus"],
  "fair-value": ["fair-value"],
  qualification: ["qualification"],
  "line-movement": ["line-movement"],
  "market-disagreement": ["market-disagreement"],
  clv: ["closing-line-value", "closing-consensus-clv"],
};

function fail(message: string): never {
  throw new ReportCalculationReferenceError(message);
}

function clonePlain(input: unknown): unknown {
  try {
    return JSON.parse(canonicalCalculationJson(input)) as unknown;
  } catch {
    return fail("report-calculation-reference-plain-data-invalid");
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("report-calculation-result-invalid");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    return fail("report-calculation-identity-invalid");
  }
  return value;
}

function exact(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    fail(`report-calculation-${label}-schema-invalid`);
  }
}

const SNAPSHOT_KEYS = [
  "canonicalEventId",
  "canonicalEventVersion",
  "sportKey",
  "marketKey",
  "selectionKey",
  "sportsbookId",
  "americanOdds",
  "observedAt",
  "retrievedAt",
  "partitionKey",
  "snapshotId",
  "sortKey",
] as const;
const SNAPSHOT_OPTIONAL_KEYS = [
  "selectionLabel",
  "sportsbookLabel",
  "point",
  "provenance",
] as const;
const REFERENCE_KEYS = [
  "id",
  "kind",
  "canonicalEventId",
  "canonicalEventVersion",
  "sportKey",
  "marketKey",
  "selectionKey",
  "snapshotIdentities",
  "calculationInput",
  "calculationVersion",
  "status",
  "raw",
  "display",
  "provenance",
  "referenceHash",
] as const;

const resultSchemas: Readonly<
  Record<ReportCalculationKind, readonly string[]>
> = {
  consensus: [
    "calculationVersion",
    "status",
    "issues",
    "probabilities",
    "requiredBookCount",
    "eligibleBookCount",
    "includedSportsbookIds",
    "contributions",
    "exclusions",
    "provenance",
    "display",
  ],
  "fair-value": [
    "calculationVersion",
    "displayVersion",
    "inputs",
    "issues",
    "labels",
    "provenance",
    "status",
    "values",
    "display",
  ],
  qualification: [
    "calculationVersion",
    "decision",
    "reasons",
    "conservativeProbability",
    "noVigProbability",
    "marketImpliedProbability",
    "decimalOdds",
    "expectedValue",
    "edge",
    "marketDisagreement",
    "includedSportsbookIds",
    "includedWeights",
    "provenance",
    "display",
  ],
  "line-movement": [
    "calculationVersion",
    "status",
    "issues",
    "currentState",
    "activeObservationCount",
    "openingObservationId",
    "latestObservationId",
    "pointMovement",
    "priceMovement",
    "gap",
    "provenance",
    "display",
  ],
  "market-disagreement": [
    "calculationVersion",
    "status",
    "issues",
    "warningThreshold",
    "blockThreshold",
    "score",
    "decisiveSelectionKey",
    "classification",
    "ranges",
    "contributingSportsbookIds",
    "provenance",
    "display",
  ],
  clv: [],
};

const displaySchemas: Readonly<
  Record<ReportCalculationKind, readonly string[]>
> = {
  consensus: ["probabilities"],
  "fair-value": [
    "fairDecimalOdds",
    "fairAmericanOdds",
    "expectedValuePercent",
    "expectedProfit",
    "rawKellyPercent",
    "informationalKellyPercent",
    "fractionalKellyPercent",
  ],
  qualification: [
    "conservativeProbability",
    "noVigProbability",
    "marketImpliedProbability",
    "decimalOdds",
    "expectedValue",
    "edge",
    "marketDisagreement",
  ],
  "line-movement": [
    "openingAmericanOdds",
    "latestAmericanOdds",
    "impliedProbabilityDelta",
  ],
  "market-disagreement": ["warningThreshold", "blockThreshold", "score"],
  clv: [
    "placedAmericanOdds",
    "placedDecimalOdds",
    "closingFairProbability",
    "priceClv",
    "probabilityClv",
  ],
};

function finite(
  value: unknown,
  label: string,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail(`report-calculation-${label}-invalid`);
  }
  return value;
}

function approximatelyEqual(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <=
    Number.EPSILON * 32 * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    return fail(`report-calculation-${label}-invalid`);
  return Number(value);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    return fail(`report-calculation-${label}-invalid`);
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  allowed?: readonly string[],
): readonly string[] {
  if (!Array.isArray(value) || value.length > 256)
    return fail(`report-calculation-${label}-invalid`);
  const output = value.map((item) => stringValue(item, label));
  if (
    new Set(output).size !== output.length ||
    (allowed !== undefined && output.some((item) => !allowed.includes(item)))
  ) {
    return fail(`report-calculation-${label}-invalid`);
  }
  return output;
}

function numberArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): readonly number[] {
  if (!Array.isArray(value) || value.length > 256)
    return fail(`report-calculation-${label}-invalid`);
  return value.map((item) => finite(item, label, minimum, maximum));
}

function exactDisplay(
  value: unknown,
  schema: readonly string[],
  expected: Readonly<Record<string, string | null | readonly string[]>>,
): void {
  const display = record(value);
  exact(display, schema, "display");
  for (const key of schema) {
    const actual = display[key];
    const wanted = expected[key];
    if (
      Array.isArray(wanted)
        ? !Array.isArray(actual) ||
          actual.length !== wanted.length ||
          actual.some((item, index) => item !== wanted[index])
        : actual !== wanted
    ) {
      fail("report-calculation-display-mismatch");
    }
  }
}

const CONSENSUS_ISSUES = [
  "target-sportsbook",
  "unconfigured",
  "zero-weight",
  "stale",
  "suspended",
  "closed",
  "unavailable",
  "missing-selection",
  "duplicate-selection",
  "invalid-odds",
  "invalid-age",
  "outlier",
  "duplicate-sportsbook",
  "invalid-sportsbook",
  "invalid-status",
  "invalid-market",
  "insufficient-books",
] as const;
const CONSENSUS_EXCLUSION_REASONS = CONSENSUS_ISSUES.filter(
  (reason) => reason !== "invalid-market" && reason !== "insufficient-books",
);
const FAIR_VALUE_ISSUES = [
  "invalid-fair-probability",
  "invalid-offered-odds",
  "invalid-stake",
  "invalid-fractional-kelly-multiplier",
  "numeric-overflow",
] as const;
const MOVEMENT_ISSUES = [
  "current-observation-inactive",
  "history-gap-exceeded",
  "insufficient-active-observations",
  "invalid-observation",
  "line-changed",
] as const;
const MARKET_ISSUES = [
  "duplicate-sportsbook",
  "insufficient-vectors",
  "invalid-contribution",
  "invalid-market",
] as const;
const CLV_ISSUES = [
  "closing-consensus-invalid",
  "closing-consensus-unavailable",
  "invalid-placed-odds",
  "numeric-overflow",
  "selection-not-found",
] as const;
const QUALIFICATION_REASONS = [
  "stale-offered-price",
  "analysis-reduced",
  "insufficient-comparison-books",
  "comparison-outlier-excluded",
  "uncertainty-above-threshold",
  "market-disagreement-blocked",
  "market-disagreement-warning",
  "edge-below-threshold",
  "ev-below-threshold",
  "positive-ev-qualified",
] as const;
const NON_BLOCKING_QUALIFICATION_REASONS = new Set([
  "comparison-outlier-excluded",
  "market-disagreement-warning",
  "positive-ev-qualified",
]);

function validateConsensusResult(result: Record<string, unknown>): string {
  const status = stringValue(result["status"], "status");
  if (!["available", "unavailable", "invalid"].includes(status))
    fail("report-calculation-status-invalid");
  const issues = stringArray(result["issues"], "issues", CONSENSUS_ISSUES);
  const required = safeInteger(
    result["requiredBookCount"],
    "required-books",
    1,
  );
  const eligible = safeInteger(result["eligibleBookCount"], "eligible-books");
  const included = stringArray(result["includedSportsbookIds"], "sportsbooks");
  if (included.length !== eligible || required > 256)
    fail("report-calculation-consensus-count-invalid");
  const probabilities =
    result["probabilities"] === null
      ? null
      : numberArray(result["probabilities"], "probability", 0, 1);
  if (
    (status === "available" &&
      (probabilities === null ||
        ![2, 3].includes(probabilities.length) ||
        Math.abs(probabilities.reduce((sum, item) => sum + item, 0) - 1) >
          Number.EPSILON * 32)) ||
    (status !== "available" && probabilities !== null)
  ) {
    fail("report-calculation-consensus-status-invalid");
  }
  if (!Array.isArray(result["contributions"]))
    fail("report-calculation-contributions-invalid");
  const contributionBooks: string[] = [];
  for (const item of result["contributions"]) {
    const contribution = record(item);
    exact(
      contribution,
      ["sportsbookId", "weight", "probabilities"],
      "contribution",
    );
    contributionBooks.push(identifier(contribution["sportsbookId"]));
    if (finite(contribution["weight"], "weight", 0) <= 0)
      fail("report-calculation-weight-invalid");
    const values = numberArray(
      contribution["probabilities"],
      "probability",
      0,
      1,
    );
    if (probabilities !== null && values.length !== probabilities.length)
      fail("report-calculation-contribution-shape-invalid");
    if (
      ![2, 3].includes(values.length) ||
      Math.abs(values.reduce((sum, item) => sum + item, 0) - 1) >
        Number.EPSILON * 32
    ) {
      fail("report-calculation-contribution-total-invalid");
    }
  }
  if (
    new Set(contributionBooks).size !== contributionBooks.length ||
    [...contributionBooks].sort().join("\u0000") !==
      [...included].sort().join("\u0000")
  ) {
    fail("report-calculation-contribution-books-invalid");
  }
  if (probabilities !== null) {
    const maximumWeight = Math.max(
      ...(result["contributions"] as Array<Record<string, unknown>>).map(
        (item) => Number(item["weight"]),
      ),
    );
    const scaledTotalWeight = (
      result["contributions"] as Array<Record<string, unknown>>
    ).reduce((sum, item) => sum + Number(item["weight"]) / maximumWeight, 0);
    const projected = probabilities.map(
      (_, index) =>
        (result["contributions"] as Array<Record<string, unknown>>).reduce(
          (sum, item) =>
            sum +
            Number((item["probabilities"] as number[])[index]) *
              (Number(item["weight"]) / maximumWeight),
          0,
        ) / scaledTotalWeight,
    );
    const total = projected.reduce((sum, value) => sum + value, 0);
    if (
      probabilities.some(
        (value, index) => !approximatelyEqual(value, projected[index]! / total),
      )
    ) {
      fail("report-calculation-consensus-probability-mismatch");
    }
  }
  if (!Array.isArray(result["exclusions"]))
    fail("report-calculation-exclusions-invalid");
  const excludedBooks: string[] = [];
  for (const item of result["exclusions"]) {
    const exclusion = record(item);
    exact(exclusion, ["sportsbookId", "reason"], "exclusion");
    const sportsbookId = identifier(exclusion["sportsbookId"]);
    const reason = stringArray(
      [exclusion["reason"]],
      "exclusion-reason",
      CONSENSUS_EXCLUSION_REASONS,
    )[0]!;
    excludedBooks.push(sportsbookId);
    if (!issues.includes(reason))
      fail("report-calculation-consensus-issue-mismatch");
  }
  if (
    (status !== "invalid" &&
      new Set(excludedBooks).size !== excludedBooks.length) ||
    excludedBooks.some((book) => included.includes(book))
  ) {
    fail("report-calculation-consensus-status-invalid");
  }
  const exclusionIssues = [
    ...new Set(
      (result["exclusions"] as Array<Record<string, unknown>>).map(
        (item) => item["reason"] as string,
      ),
    ),
  ];
  const expectedIssues =
    status === "invalid"
      ? [
          ...(issues.includes("invalid-market") ? ["invalid-market"] : []),
          ...exclusionIssues,
        ].sort()
      : [
          ...exclusionIssues,
          ...(included.length < required ? ["insufficient-books"] : []),
        ].sort();
  if (
    canonicalCalculationJson(issues) !==
      canonicalCalculationJson(expectedIssues) ||
    (status === "available") !== included.length >= required ||
    (status === "invalid" &&
      (eligible !== 0 ||
        included.length !== 0 ||
        result["contributions"].length !== 0 ||
        !issues.some((issue) =>
          ["invalid-market", "duplicate-sportsbook"].includes(issue),
        )))
  ) {
    fail("report-calculation-consensus-status-invalid");
  }
  exactDisplay(result["display"], displaySchemas.consensus, {
    probabilities:
      probabilities === null
        ? null
        : probabilities.map((value) => displayPercentage(value).text),
  });
  return status;
}

function validateFairValueResult(result: Record<string, unknown>): string {
  if (result["displayVersion"] !== FAIR_VALUE_DISPLAY_VERSION)
    fail("report-calculation-display-version-invalid");
  const status = stringValue(result["status"], "status");
  if (status !== "available" && status !== "invalid")
    fail("report-calculation-status-invalid");
  const issues = stringArray(result["issues"], "issues", FAIR_VALUE_ISSUES);
  const inputs = record(result["inputs"]);
  exact(
    inputs,
    [
      "fairProbability",
      "offeredAmerican",
      "stake",
      "fractionalKellyMultiplier",
    ],
    "fair-inputs",
  );
  const fairProbability = finite(inputs["fairProbability"], "fair-probability");
  finite(inputs["offeredAmerican"], "offered-american");
  finite(inputs["stake"], "stake");
  finite(inputs["fractionalKellyMultiplier"], "kelly-multiplier");
  const labels = record(result["labels"]);
  exact(labels, ["expectedProfit", "kelly"], "labels");
  if (
    labels["expectedProfit"] !== "Expected profit, not guaranteed profit" ||
    labels["kelly"] !== "Informational only"
  ) {
    fail("report-calculation-labels-invalid");
  }
  if (status === "invalid") {
    if (
      issues.length === 0 ||
      result["values"] !== null ||
      result["display"] !== null
    )
      fail("report-calculation-fair-status-invalid");
    return status;
  }
  if (issues.length > 0) fail("report-calculation-fair-status-invalid");
  const values = record(result["values"]);
  exact(
    values,
    [
      "fairDecimalOdds",
      "fairAmericanOdds",
      "offeredDecimalOdds",
      "expectedValue",
      "expectedProfit",
      "rawKellyFraction",
      "informationalKellyFraction",
      "fractionalKellyFraction",
    ],
    "fair-values",
  );
  const raw = Object.fromEntries(
    Object.keys(values).map((key) => [key, finite(values[key], key)]),
  ) as Record<string, number>;
  if (
    raw["fairDecimalOdds"]! <= 1 ||
    raw["offeredDecimalOdds"]! <= 1 ||
    fairProbability <= 0 ||
    fairProbability >= 1
  ) {
    fail("report-calculation-fair-values-invalid");
  }
  exactDisplay(result["display"], displaySchemas["fair-value"], {
    fairDecimalOdds: displayDecimalOdds(raw["fairDecimalOdds"]!).text,
    fairAmericanOdds: displayAmericanOdds(raw["fairAmericanOdds"]!).text,
    expectedValuePercent: displayPercentage(raw["expectedValue"]!).text,
    expectedProfit: displayMoney(raw["expectedProfit"]!).text,
    rawKellyPercent: displayPercentage(raw["rawKellyFraction"]!).text,
    informationalKellyPercent: displayPercentage(
      raw["informationalKellyFraction"]!,
    ).text,
    fractionalKellyPercent: displayPercentage(raw["fractionalKellyFraction"]!)
      .text,
  });
  return status;
}

function validateQualificationResult(result: Record<string, unknown>): string {
  const decision = result["decision"];
  if (decision !== "play" && decision !== "no-bet")
    fail("report-calculation-status-invalid");
  const reasons = stringArray(
    result["reasons"],
    "reasons",
    QUALIFICATION_REASONS,
  );
  const blocking = reasons.filter(
    (reason) => !NON_BLOCKING_QUALIFICATION_REASONS.has(reason),
  );
  if (
    (decision === "play" &&
      (!reasons.includes("positive-ev-qualified") || blocking.length > 0)) ||
    (decision === "no-bet" &&
      (reasons.includes("positive-ev-qualified") || blocking.length === 0))
  ) {
    fail("report-calculation-qualification-decision-invalid");
  }
  const values = {
    conservativeProbability: finite(
      result["conservativeProbability"],
      "conservative-probability",
      0,
      1,
    ),
    noVigProbability: finite(
      result["noVigProbability"],
      "no-vig-probability",
      0,
      1,
    ),
    marketImpliedProbability: finite(
      result["marketImpliedProbability"],
      "market-probability",
      0,
      1,
    ),
    decimalOdds: finite(result["decimalOdds"], "decimal-odds", 1),
    expectedValue: finite(result["expectedValue"], "expected-value"),
    edge: finite(result["edge"], "edge"),
    marketDisagreement: finite(
      result["marketDisagreement"],
      "market-disagreement",
      0,
      1,
    ),
  };
  if (values.decimalOdds <= 1)
    fail("report-calculation-qualification-odds-invalid");
  const books = stringArray(result["includedSportsbookIds"], "sportsbooks");
  const weights = record(result["includedWeights"]);
  if (
    Object.keys(weights).length !== books.length ||
    books.some((book) => !Object.hasOwn(weights, book))
  ) {
    fail("report-calculation-qualification-books-invalid");
  }
  for (const [book, weight] of Object.entries(weights)) {
    identifier(book);
    if (finite(weight, "weight", 0) <= 0)
      fail("report-calculation-weight-invalid");
  }
  exactDisplay(result["display"], displaySchemas.qualification, {
    conservativeProbability: displayPercentage(values.conservativeProbability)
      .text,
    noVigProbability: displayPercentage(values.noVigProbability).text,
    marketImpliedProbability: displayPercentage(values.marketImpliedProbability)
      .text,
    decimalOdds: displayDecimalOdds(values.decimalOdds).text,
    expectedValue: displayPercentage(values.expectedValue).text,
    edge: displayPercentage(values.edge).text,
    marketDisagreement: displayPercentage(values.marketDisagreement).text,
  });
  return decision;
}

function validateMovementResult(result: Record<string, unknown>): string {
  const status = stringValue(result["status"], "status");
  if (!["available", "unavailable", "invalid"].includes(status))
    fail("report-calculation-status-invalid");
  const issues = stringArray(result["issues"], "issues", MOVEMENT_ISSUES);
  const currentState = result["currentState"];
  if (
    currentState !== null &&
    (typeof currentState !== "string" ||
      !["active", "suspended", "unavailable"].includes(currentState))
  )
    fail("report-calculation-movement-state-invalid");
  const activeCount = safeInteger(
    result["activeObservationCount"],
    "active-observations",
  );
  for (const key of ["openingObservationId", "latestObservationId"] as const) {
    if (result[key] !== null) identifier(result[key]);
  }
  const point = result["pointMovement"];
  if (point !== null) {
    const item = record(point);
    exact(item, ["opening", "latest", "delta", "changed"], "point-movement");
    for (const key of ["opening", "latest", "delta"] as const)
      if (item[key] !== null) finite(item[key], `point-${key}`);
    if (typeof item["changed"] !== "boolean")
      fail("report-calculation-point-changed-invalid");
    const opening = item["opening"] as number | null;
    const latest = item["latest"] as number | null;
    const delta = item["delta"] as number | null;
    if (
      (opening === null || latest === null) !== (delta === null) ||
      (delta !== null && delta !== latest! - opening!) ||
      (item["changed"] === false && delta !== null && delta !== 0)
    ) {
      fail("report-calculation-point-relation-invalid");
    }
  }
  const price = result["priceMovement"];
  let priceValues: Record<string, number> | null = null;
  if (price !== null) {
    const item = record(price);
    exact(
      item,
      [
        "openingAmericanOdds",
        "latestAmericanOdds",
        "americanOddsDelta",
        "openingImpliedProbability",
        "latestImpliedProbability",
        "impliedProbabilityDelta",
        "direction",
        "significant",
      ],
      "price-movement",
    );
    priceValues = Object.fromEntries(
      [
        "openingAmericanOdds",
        "latestAmericanOdds",
        "americanOddsDelta",
        "openingImpliedProbability",
        "latestImpliedProbability",
        "impliedProbabilityDelta",
      ].map((key) => [key, finite(item[key], key)]),
    );
    if (
      !Number.isSafeInteger(priceValues["openingAmericanOdds"]) ||
      !Number.isSafeInteger(priceValues["latestAmericanOdds"]) ||
      Math.abs(priceValues["openingAmericanOdds"]!) < 100 ||
      Math.abs(priceValues["latestAmericanOdds"]!) < 100 ||
      Math.abs(priceValues["openingAmericanOdds"]!) > 100_000 ||
      Math.abs(priceValues["latestAmericanOdds"]!) > 100_000 ||
      priceValues["openingImpliedProbability"]! <= 0 ||
      priceValues["openingImpliedProbability"]! >= 1 ||
      priceValues["latestImpliedProbability"]! <= 0 ||
      priceValues["latestImpliedProbability"]! >= 1 ||
      typeof item["direction"] !== "string" ||
      !["shortened", "lengthened", "unchanged"].includes(item["direction"]) ||
      typeof item["significant"] !== "boolean"
    )
      fail("report-calculation-price-movement-invalid");
    const probabilityDelta = priceValues["impliedProbabilityDelta"]!;
    const expectedDirection =
      probabilityDelta > 0
        ? "shortened"
        : probabilityDelta < 0
          ? "lengthened"
          : "unchanged";
    if (
      priceValues["americanOddsDelta"] !==
        priceValues["latestAmericanOdds"]! -
          priceValues["openingAmericanOdds"]! ||
      !approximatelyEqual(
        probabilityDelta,
        priceValues["latestImpliedProbability"]! -
          priceValues["openingImpliedProbability"]!,
      ) ||
      item["direction"] !== expectedDirection
    ) {
      fail("report-calculation-price-relation-invalid");
    }
  }
  const gap = result["gap"];
  if (gap !== null) {
    const item = record(gap);
    exact(
      item,
      ["maximumMinutes", "thresholdMinutes", "exceedsThreshold"],
      "movement-gap",
    );
    finite(item["maximumMinutes"], "maximum-minutes", 0);
    finite(item["thresholdMinutes"], "threshold-minutes", 0);
    if (typeof item["exceedsThreshold"] !== "boolean")
      fail("report-calculation-gap-invalid");
    if (
      item["exceedsThreshold"] !==
      Number(item["maximumMinutes"]) > Number(item["thresholdMinutes"])
    ) {
      fail("report-calculation-gap-relation-invalid");
    }
  }
  const openingId = result["openingObservationId"];
  const latestId = result["latestObservationId"];
  const idsPresent = openingId !== null && latestId !== null;
  const issueSet = new Set(issues);
  const pointChanged =
    point === null ? false : record(point)["changed"] === true;
  const lineChangedUnavailable =
    status === "unavailable" && issueSet.has("line-changed");
  if (
    (openingId === null) !== (latestId === null) ||
    (activeCount === 0) !== !idsPresent ||
    issueSet.has("history-gap-exceeded") !==
      (gap !== null && record(gap)["exceedsThreshold"] === true) ||
    issueSet.has("line-changed") !== pointChanged ||
    issueSet.has("current-observation-inactive") !==
      (currentState !== null && currentState !== "active") ||
    issueSet.has("insufficient-active-observations") !== activeCount < 2 ||
    (status === "available" &&
      (currentState !== "active" ||
        activeCount < 2 ||
        !idsPresent ||
        point === null ||
        price === null ||
        gap === null)) ||
    (status === "unavailable" &&
      (lineChangedUnavailable
        ? currentState !== "active" ||
          activeCount < 2 ||
          point === null ||
          price !== null ||
          gap === null
        : point !== null || price !== null || gap !== null)) ||
    (status === "invalid" &&
      (currentState !== null ||
        activeCount !== 0 ||
        idsPresent ||
        point !== null ||
        price !== null ||
        gap !== null ||
        canonicalCalculationJson(issues) !==
          canonicalCalculationJson(["invalid-observation"])))
  )
    fail("report-calculation-movement-status-invalid");
  exactDisplay(result["display"], displaySchemas["line-movement"], {
    openingAmericanOdds:
      priceValues === null
        ? null
        : displayAmericanOdds(priceValues["openingAmericanOdds"]!).text,
    latestAmericanOdds:
      priceValues === null
        ? null
        : displayAmericanOdds(priceValues["latestAmericanOdds"]!).text,
    impliedProbabilityDelta:
      priceValues === null
        ? null
        : displayPercentage(priceValues["impliedProbabilityDelta"]!).text,
  });
  return status;
}

function validateMarketDisagreementResult(
  result: Record<string, unknown>,
): string {
  const status = stringValue(result["status"], "status");
  if (!["available", "insufficient-data", "invalid"].includes(status))
    fail("report-calculation-status-invalid");
  const issues = stringArray(result["issues"], "issues", MARKET_ISSUES);
  const warning = finite(result["warningThreshold"], "warning-threshold", 0, 1);
  const block = finite(result["blockThreshold"], "block-threshold", warning, 1);
  const score =
    result["score"] === null ? null : finite(result["score"], "score", 0, 1);
  const decisive = result["decisiveSelectionKey"];
  if (decisive !== null) identifier(decisive);
  const classification = result["classification"];
  if (
    classification !== null &&
    (typeof classification !== "string" ||
      !["none", "warning", "block"].includes(classification))
  )
    fail("report-calculation-classification-invalid");
  if (!Array.isArray(result["ranges"]))
    fail("report-calculation-ranges-invalid");
  const ranges: Array<{
    selectionKey: string;
    range: number;
  }> = [];
  for (const value of result["ranges"]) {
    const item = record(value);
    exact(
      item,
      ["selectionKey", "minimumProbability", "maximumProbability", "range"],
      "range",
    );
    const selectionKey = identifier(item["selectionKey"]);
    const min = finite(item["minimumProbability"], "minimum-probability", 0, 1);
    const max = finite(
      item["maximumProbability"],
      "maximum-probability",
      min,
      1,
    );
    const range = finite(item["range"], "range", 0, 1);
    if (Math.abs(range - (max - min)) > Number.EPSILON * 8)
      fail("report-calculation-range-relation-invalid");
    ranges.push({ selectionKey, range });
  }
  const books = stringArray(result["contributingSportsbookIds"], "sportsbooks");
  if (
    (status === "available" &&
      (score === null ||
        decisive === null ||
        classification === null ||
        issues.length !== 0 ||
        books.length < 2 ||
        ![2, 3].includes(ranges.length))) ||
    (status !== "available" &&
      (score !== null ||
        decisive !== null ||
        classification !== null ||
        ranges.length !== 0)) ||
    (status === "insufficient-data" &&
      canonicalCalculationJson(issues) !==
        canonicalCalculationJson(["insufficient-vectors"])) ||
    (status === "invalid" && issues.length === 0)
  )
    fail("report-calculation-disagreement-status-invalid");
  if (status === "available") {
    const maximum = Math.max(...ranges.map(({ range }) => range));
    const decisiveRange = ranges.find(
      ({ selectionKey }) => selectionKey === decisive,
    )?.range;
    const expectedClassification =
      maximum + Math.abs(block) * Number.EPSILON * 2 >= block
        ? "block"
        : maximum + Math.abs(warning) * Number.EPSILON * 2 >= warning
          ? "warning"
          : "none";
    if (
      new Set(ranges.map(({ selectionKey }) => selectionKey)).size !==
        ranges.length ||
      Math.abs(score! - maximum) > Number.EPSILON * 8 ||
      decisiveRange === undefined ||
      Math.abs(decisiveRange - maximum) > Number.EPSILON * 8 ||
      classification !== expectedClassification
    ) {
      fail("report-calculation-disagreement-relation-invalid");
    }
  }
  exactDisplay(result["display"], displaySchemas["market-disagreement"], {
    warningThreshold: displayPercentage(warning).text,
    blockThreshold: displayPercentage(block).text,
    score: score === null ? null : displayPercentage(score).text,
  });
  return status;
}

function validateDirectClvResult(result: Record<string, unknown>): string {
  const values = {
    placedAmericanOdds: finite(result["placedAmericanOdds"], "placed-american"),
    placedDecimalOdds: finite(result["placedDecimalOdds"], "placed-decimal", 1),
    placedImpliedProbability: finite(
      result["placedImpliedProbability"],
      "placed-probability",
      0,
      1,
    ),
    closingFairProbability: finite(
      result["closingFairProbability"],
      "closing-probability",
      0,
      1,
    ),
    priceClv: finite(result["priceClv"], "price-clv"),
    probabilityClv: finite(result["probabilityClv"], "probability-clv"),
  };
  if (
    !Number.isSafeInteger(values.placedAmericanOdds) ||
    Math.abs(values.placedAmericanOdds) < 100 ||
    Math.abs(values.placedAmericanOdds) > 100_000 ||
    values.placedDecimalOdds <= 1 ||
    values.placedImpliedProbability <= 0 ||
    values.placedImpliedProbability >= 1 ||
    values.closingFairProbability <= 0 ||
    values.closingFairProbability >= 1
  ) {
    fail("report-calculation-clv-values-invalid");
  }
  const expectedDecimal =
    values.placedAmericanOdds > 0
      ? 1 + values.placedAmericanOdds / 100
      : 1 + 100 / Math.abs(values.placedAmericanOdds);
  const expectedImplied = 1 / expectedDecimal;
  if (
    !approximatelyEqual(values.placedDecimalOdds, expectedDecimal) ||
    !approximatelyEqual(values.placedImpliedProbability, expectedImplied) ||
    !approximatelyEqual(
      values.priceClv,
      expectedDecimal * values.closingFairProbability - 1,
    ) ||
    !approximatelyEqual(
      values.probabilityClv,
      values.closingFairProbability - expectedImplied,
    )
  ) {
    fail("report-calculation-clv-relation-invalid");
  }
  exactDisplay(result["display"], displaySchemas.clv, {
    placedAmericanOdds: displayAmericanOdds(values.placedAmericanOdds).text,
    placedDecimalOdds: displayDecimalOdds(values.placedDecimalOdds).text,
    closingFairProbability: displayPercentage(values.closingFairProbability)
      .text,
    priceClv: displayPercentage(values.priceClv).text,
    probabilityClv: displayPercentage(values.probabilityClv).text,
  });
  return "available";
}

function validateClosingConsensusClvResult(
  result: Record<string, unknown>,
): string {
  const status = stringValue(result["status"], "status");
  if (!["available", "unavailable", "invalid"].includes(status))
    fail("report-calculation-status-invalid");
  const issues = stringArray(result["issues"], "issues", CLV_ISSUES);
  identifier(result["selectionKey"]);
  if (result["consensus"] !== null) {
    const consensus = record(result["consensus"]);
    exact(consensus, resultSchemas.consensus, "nested-consensus");
    validateConsensusResult(consensus);
    try {
      normalizeCalculationProvenance(consensus["provenance"]);
    } catch {
      fail("report-calculation-nested-provenance-invalid");
    }
  }
  if (status === "available") {
    const values = record(result["values"]);
    exact(
      values,
      [
        "calculationVersion",
        "placedAmericanOdds",
        "placedDecimalOdds",
        "placedImpliedProbability",
        "closingFairProbability",
        "priceClv",
        "probabilityClv",
        "provenance",
        "display",
      ],
      "nested-clv",
    );
    if (values["calculationVersion"] !== CLOSING_LINE_VALUE_CALCULATION_VERSION)
      fail("report-calculation-nested-clv-version-invalid");
    validateDirectClvResult(values);
    try {
      normalizeCalculationProvenance(values["provenance"]);
    } catch {
      fail("report-calculation-nested-provenance-invalid");
    }
    if (
      issues.length !== 0 ||
      result["consensus"] === null ||
      record(result["consensus"])["status"] !== "available" ||
      canonicalCalculationJson(result["display"]) !==
        canonicalCalculationJson(values["display"])
    ) {
      fail("report-calculation-display-mismatch");
    }
  } else {
    const consensusStatus =
      result["consensus"] === null
        ? null
        : record(result["consensus"])["status"];
    const expectedIssueShape =
      status === "unavailable"
        ? issues.length === 1 &&
          ((issues[0] === "closing-consensus-unavailable" &&
            consensusStatus === "unavailable") ||
            (issues[0] === "selection-not-found" &&
              consensusStatus === "available"))
        : issues.length === 1 &&
          ((issues[0] === "closing-consensus-invalid" &&
            (consensusStatus === null || consensusStatus === "invalid")) ||
            (["invalid-placed-odds", "numeric-overflow"].includes(issues[0]!) &&
              consensusStatus === null));
    if (
      !expectedIssueShape ||
      result["values"] !== null ||
      result["display"] !== null
    ) {
      fail("report-calculation-clv-status-invalid");
    }
  }
  return status;
}

function validateResultSchema(
  kind: ReportCalculationKind,
  calculationVersion: string,
  result: Record<string, unknown>,
): string {
  if (kind === "clv") {
    const isDirect =
      calculationVersion === CLOSING_LINE_VALUE_CALCULATION_VERSION;
    exact(
      result,
      isDirect
        ? [
            "calculationVersion",
            "placedAmericanOdds",
            "placedDecimalOdds",
            "placedImpliedProbability",
            "closingFairProbability",
            "priceClv",
            "probabilityClv",
            "provenance",
            "display",
          ]
        : [
            "calculationVersion",
            "status",
            "issues",
            "selectionKey",
            "values",
            "consensus",
            "provenance",
            "display",
          ],
      "result",
    );
    return isDirect
      ? validateDirectClvResult(result)
      : validateClosingConsensusClvResult(result);
  }
  exact(result, resultSchemas[kind], "result");
  switch (kind) {
    case "consensus":
      return validateConsensusResult(result);
    case "fair-value":
      return validateFairValueResult(result);
    case "qualification":
      return validateQualificationResult(result);
    case "line-movement":
      return validateMovementResult(result);
    case "market-disagreement":
      return validateMarketDisagreementResult(result);
  }
}

function normalizedSnapshotIdentity(
  value: unknown,
): Readonly<ReportOddsSnapshotIdentity> {
  const captured = record(clonePlain(value));
  const keys = Object.keys(captured);
  if (
    SNAPSHOT_KEYS.some((key) => !Object.hasOwn(captured, key)) ||
    keys.some(
      (key) =>
        !SNAPSHOT_KEYS.includes(key as (typeof SNAPSHOT_KEYS)[number]) &&
        !SNAPSHOT_OPTIONAL_KEYS.includes(
          key as (typeof SNAPSHOT_OPTIONAL_KEYS)[number],
        ),
    )
  ) {
    fail("report-calculation-snapshot-schema-invalid");
  }
  const observation = Object.fromEntries(
    [...SNAPSHOT_KEYS.slice(0, 9), ...SNAPSHOT_OPTIONAL_KEYS]
      .filter((key) => Object.hasOwn(captured, key))
      .map((key) => [key, captured[key]]),
  );
  let read: ReturnType<typeof readFixtureOddsSnapshotRecord>;
  try {
    // Accepts the current identity and, for verification only, rows committed
    // under the frozen legacy hash that included `retrievedAt`. Both must
    // reproduce the claimed snapshotId AND sortKey exactly.
    read = readFixtureOddsSnapshotRecord(
      observation as unknown as Parameters<
        typeof readFixtureOddsSnapshotRecord
      >[0],
      { snapshotId: captured["snapshotId"], sortKey: captured["sortKey"] },
    );
  } catch {
    return fail("report-calculation-snapshot-invalid");
  }
  if (!read || captured["partitionKey"] !== read.snapshot.partitionKey) {
    return fail("report-calculation-snapshot-forged");
  }
  return read.snapshot;
}

function validateEvidenceAttachments(
  kind: ReportCalculationKind,
  result: Record<string, unknown>,
  snapshots: readonly NormalizedFixtureOddsSnapshot[],
  outerSelectionKey: string,
  calculationInput: unknown,
): void {
  const snapshotIds = new Set(snapshots.map(({ snapshotId }) => snapshotId));
  const sportsbookIds = new Set(
    snapshots.map(({ sportsbookId }) => sportsbookId),
  );
  const requireBooks = (values: unknown, allowDuplicates = false): void => {
    if (!Array.isArray(values) || values.length > 256)
      fail("report-calculation-attached-sportsbooks-invalid");
    const books = values.map(identifier);
    if (
      (!allowDuplicates && new Set(books).size !== books.length) ||
      books.some((book) => !sportsbookIds.has(book))
    )
      fail("report-calculation-sportsbook-evidence-mismatch");
  };
  if (kind === "consensus") {
    requireBooks(result["includedSportsbookIds"]);
    requireBooks(
      (result["contributions"] as Array<Record<string, unknown>>).map(
        (item) => item["sportsbookId"],
      ),
    );
    requireBooks(
      (result["exclusions"] as Array<Record<string, unknown>>).map(
        (item) => item["sportsbookId"],
      ),
      result["status"] === "invalid",
    );
    const input = calculationInput as ConsensusInput;
    const snapshotsByBook = new Map<string, NormalizedFixtureOddsSnapshot[]>();
    for (const snapshot of snapshots) {
      const collected = snapshotsByBook.get(snapshot.sportsbookId) ?? [];
      collected.push(snapshot);
      snapshotsByBook.set(snapshot.sportsbookId, collected);
    }
    for (const book of input.books) {
      const captured =
        snapshotsByBook.get(book.sportsbookId.trim().toLowerCase()) ?? [];
      const selection = book.selections.find(
        (candidate) => candidate.selectionKey === outerSelectionKey,
      );
      if (
        captured.length > 0 &&
        (selection === undefined ||
          !captured.some(
            (snapshot) => snapshot.americanOdds === selection.americanOdds,
          ))
      ) {
        fail("report-calculation-snapshot-value-mismatch");
      }
    }
  } else if (kind === "fair-value") {
    const input = calculationInput as FairValueInput;
    if (
      !snapshots.some(
        ({ americanOdds }) => americanOdds === input.offeredAmerican,
      )
    )
      fail("report-calculation-snapshot-value-mismatch");
  } else if (kind === "qualification") {
    requireBooks(result["includedSportsbookIds"]);
    if (
      new Set(snapshots.map(({ sportsbookId }) => sportsbookId)).size !==
      snapshots.length
    ) {
      fail("report-calculation-qualification-snapshot-duplicate");
    }
    const input = calculationInput as QualificationInput;
    const snapshotsByBook = new Map(
      snapshots.map((snapshot) => [snapshot.sportsbookId, snapshot]),
    );
    const target = snapshotsByBook.get(
      input.targetSportsbookId.trim().toLowerCase(),
    );
    if (target?.americanOdds !== input.offeredAmerican)
      fail("report-calculation-snapshot-value-mismatch");
    for (const book of input.books) {
      const captured = snapshotsByBook.get(
        book.sportsbookId.trim().toLowerCase(),
      );
      if (
        captured !== undefined &&
        book.americanOdds[input.candidateIndex] !== captured.americanOdds
      ) {
        fail("report-calculation-snapshot-value-mismatch");
      }
    }
  } else if (kind === "market-disagreement") {
    requireBooks(result["contributingSportsbookIds"]);
    const input = calculationInput as MarketDisagreementInput;
    for (const contribution of input.contributions) {
      const sportsbookId = contribution.sportsbookId.trim().toLowerCase();
      const captured = input.selectionKeys.map((selectionKey) =>
        snapshots.filter(
          (snapshot) =>
            snapshot.sportsbookId === sportsbookId &&
            snapshot.selectionKey === selectionKey,
        ),
      );
      if (captured.some((matches) => matches.length !== 1)) {
        fail("report-calculation-disagreement-snapshot-mismatch");
      }
      let probabilities: readonly number[];
      try {
        probabilities = removeVig(
          captured.map((matches) => matches[0]!.americanOdds),
        );
      } catch {
        return fail("report-calculation-disagreement-snapshot-mismatch");
      }
      if (
        probabilities.length !== contribution.probabilities.length ||
        probabilities.some(
          (value, index) =>
            !approximatelyEqual(value, contribution.probabilities[index]!),
        )
      ) {
        fail("report-calculation-disagreement-vector-mismatch");
      }
    }
  } else if (kind === "line-movement") {
    if (new Set(snapshots.map(({ sportsbookId }) => sportsbookId)).size !== 1) {
      fail("report-calculation-movement-sportsbook-mismatch");
    }
    for (const key of [
      "openingObservationId",
      "latestObservationId",
    ] as const) {
      const observationId = result[key];
      if (
        observationId !== null &&
        (typeof observationId !== "string" || !snapshotIds.has(observationId))
      )
        fail("report-calculation-observation-evidence-mismatch");
    }
    const byId = new Map(
      snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]),
    );
    const input = calculationInput as LineMovementInput;
    if (
      input.observations.length !== snapshots.length ||
      input.observations.some((observation) => {
        const captured = byId.get(observation.observationId);
        return (
          captured === undefined ||
          captured.americanOdds !== observation.americanOdds ||
          (captured.point ?? undefined) !== observation.point ||
          captured.observedAt !== observation.observedAt ||
          captured.retrievedAt !== observation.retrievedAt
        );
      })
    ) {
      fail("report-calculation-observation-evidence-mismatch");
    }
  } else if (
    kind === "clv" &&
    result["calculationVersion"] === CLOSING_CONSENSUS_CLV_CALCULATION_VERSION
  ) {
    if (result["selectionKey"] !== outerSelectionKey)
      fail("report-calculation-selection-evidence-mismatch");
    const consensus = result["consensus"];
    if (consensus !== null) {
      validateEvidenceAttachments(
        "consensus",
        record(consensus),
        snapshots,
        outerSelectionKey,
        (calculationInput as ClosingConsensusClvInput).closingConsensusInput,
      );
    }
  } else if (kind === "clv") {
    const input = calculationInput as {
      placedAmericanOdds: number;
      closingFairProbability: number;
    };
    if (
      !snapshots.some(
        ({ americanOdds }) => americanOdds === input.placedAmericanOdds,
      )
    )
      fail("report-calculation-snapshot-value-mismatch");
  }
}

function recalculateResult(
  kind: ReportCalculationKind,
  calculationVersion: string,
  calculationInput: unknown,
): unknown {
  switch (kind) {
    case "consensus":
      return calculateWeightedConsensus(calculationInput as ConsensusInput);
    case "fair-value":
      return calculateFairValue(calculationInput as FairValueInput);
    case "qualification":
      return qualifyEvaluation(calculationInput as QualificationInput);
    case "line-movement":
      return calculateLineMovement(calculationInput as LineMovementInput);
    case "market-disagreement":
      return scoreMarketDisagreement(
        calculationInput as MarketDisagreementInput,
      );
    case "clv":
      if (calculationVersion === CLOSING_CONSENSUS_CLV_CALCULATION_VERSION) {
        return calculateClosingConsensusClv(
          calculationInput as ClosingConsensusClvInput,
        );
      }
      {
        const input = record(calculationInput);
        exact(
          input,
          ["placedAmericanOdds", "closingFairProbability"],
          "clv-input",
        );
        return closingLineValue(
          finite(input["placedAmericanOdds"], "placed-american"),
          finite(input["closingFairProbability"], "closing-probability"),
        );
      }
  }
}

function createReportCalculationReferenceUnchecked(
  input: CreateReportCalculationReferenceInput,
): Readonly<ReportCalculationReference> {
  if (
    typeof input.kind !== "string" ||
    !Object.hasOwn(expectedVersions, input.kind)
  ) {
    return fail("report-calculation-kind-invalid");
  }
  const id = identifier(input.id);
  const canonicalEventId = identifier(input.canonicalEventId);
  const canonicalEventVersion = String(input.canonicalEventVersion);
  const sportKey = identifier(input.sportKey);
  const marketKey = identifier(input.marketKey);
  const selectionKey = identifier(input.selectionKey);
  identifier(canonicalEventVersion);
  if (
    !Array.isArray(input.snapshots) ||
    input.snapshots.length === 0 ||
    input.snapshots.length > 256
  ) {
    return fail("report-calculation-snapshots-invalid");
  }
  const snapshotIds = new Set<string>();
  const snapshotIdentities = input.snapshots.map((snapshot) => {
    const normalized = normalizedSnapshotIdentity(snapshot);
    if (
      normalized.canonicalEventId !== canonicalEventId ||
      String(normalized.canonicalEventVersion) !== canonicalEventVersion ||
      normalized.sportKey !== sportKey ||
      normalized.marketKey !== marketKey ||
      (input.kind !== "market-disagreement" &&
        normalized.selectionKey !== selectionKey) ||
      !HASH.test(normalized.snapshotId) ||
      snapshotIds.has(normalized.snapshotId)
    ) {
      return fail("report-calculation-snapshot-mismatch");
    }
    snapshotIds.add(normalized.snapshotId);
    return normalized;
  });
  if (
    !snapshotIdentities.some(
      (snapshot) => snapshot.selectionKey === selectionKey,
    )
  ) {
    return fail("report-calculation-snapshot-mismatch");
  }
  snapshotIdentities.sort((left, right) =>
    left.snapshotId < right.snapshotId
      ? -1
      : left.snapshotId > right.snapshotId
        ? 1
        : 0,
  );

  const result = record(clonePlain(input.result));
  const calculationInput = clonePlain(input.calculationInput);
  const calculationVersion = identifier(result["calculationVersion"]);
  if (!expectedVersions[input.kind].includes(calculationVersion)) {
    return fail("report-calculation-version-mismatch");
  }
  const status = validateResultSchema(input.kind, calculationVersion, result);
  validateEvidenceAttachments(
    input.kind,
    result,
    snapshotIdentities,
    selectionKey,
    calculationInput,
  );
  let recalculated: unknown;
  try {
    recalculated = recalculateResult(
      input.kind,
      calculationVersion,
      calculationInput,
    );
  } catch {
    return fail("report-calculation-input-invalid");
  }
  if (
    canonicalCalculationJson(recalculated) !== canonicalCalculationJson(result)
  ) {
    return fail("report-calculation-result-recalculation-mismatch");
  }
  const displayValue = result["display"];
  if (displayValue !== null) {
    exact(record(displayValue), displaySchemas[input.kind], "display");
  } else if (
    input.kind === "qualification" ||
    calculationVersion === CLOSING_LINE_VALUE_CALCULATION_VERSION
  ) {
    return fail("report-calculation-display-invalid");
  }
  let provenance: Readonly<CalculationProvenance>;
  try {
    provenance = normalizeCalculationProvenance(result["provenance"]);
  } catch {
    return fail("report-calculation-provenance-invalid");
  }
  if (
    !expectedAlgorithmIds[input.kind].includes(provenance.root.algorithm.id) ||
    provenance.root.algorithm.version !== calculationVersion
  ) {
    return fail("report-calculation-provenance-mismatch");
  }
  const display = clonePlain(displayValue);
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key !== "display" && key !== "provenance") raw[key] = value;
  }
  const material = {
    id,
    kind: input.kind,
    canonicalEventId,
    canonicalEventVersion,
    sportKey,
    marketKey,
    selectionKey,
    snapshotIdentities,
    calculationInput,
    calculationVersion,
    status,
    raw,
    display,
    provenance,
  };
  return deepFreeze({
    ...material,
    referenceHash: calculationInputHash(
      "report-calculation-reference-v1",
      material,
    ),
  });
}

export function createReportCalculationReference(
  input: CreateReportCalculationReferenceInput,
): Readonly<ReportCalculationReference> {
  try {
    return validateReportCalculationReference(
      createReportCalculationReferenceUnchecked(input),
    );
  } catch (error) {
    if (error instanceof ReportCalculationReferenceError) throw error;
    throw new ReportCalculationReferenceError(
      "report-calculation-reference-invalid",
    );
  }
}

export function validateReportCalculationReference(
  input: unknown,
): Readonly<ReportCalculationReference> {
  try {
    const captured = record(clonePlain(input));
    exact(captured, REFERENCE_KEYS, "reference");
    const raw = record(captured["raw"]);
    if (Object.hasOwn(raw, "display") || Object.hasOwn(raw, "provenance"))
      fail("report-calculation-reference-raw-schema-invalid");
    if (!Array.isArray(captured["snapshotIdentities"]))
      fail("report-calculation-snapshots-invalid");
    const canonical = createReportCalculationReferenceUnchecked({
      id: identifier(captured["id"]),
      kind: captured["kind"] as ReportCalculationKind,
      canonicalEventId: identifier(captured["canonicalEventId"]),
      canonicalEventVersion: identifier(captured["canonicalEventVersion"]),
      sportKey: identifier(captured["sportKey"]),
      marketKey: identifier(captured["marketKey"]),
      selectionKey: identifier(captured["selectionKey"]),
      snapshots: captured[
        "snapshotIdentities"
      ] as NormalizedFixtureOddsSnapshot[],
      calculationInput: captured["calculationInput"],
      result: {
        ...raw,
        display: captured["display"],
        provenance: captured["provenance"],
      },
    });
    if (
      captured["calculationVersion"] !== canonical.calculationVersion ||
      captured["status"] !== canonical.status ||
      captured["referenceHash"] !== canonical.referenceHash
    ) {
      fail("report-calculation-reference-hash-mismatch");
    }
    return canonical;
  } catch (error) {
    if (error instanceof ReportCalculationReferenceError) throw error;
    throw new ReportCalculationReferenceError(
      "report-calculation-reference-invalid",
    );
  }
}

export const createReportReference = createReportCalculationReference;
