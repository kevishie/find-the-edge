import { sha256Hex } from "./fixture-odds.js";

const MAX_TEXT = 256;
const MAX_ARRAY = 64;
const FORBIDDEN_KEY =
  /(?:secret|credential|api[_-]?key|auth(?:orization)?|cookie|access[_-]?token|refresh[_-]?token|raw[_-]?(?:payload|response|body))/i;
const ID = /^[\x21-\x7e]+$/;
const HASH = /^[a-f0-9]{64}$/;

export class PaperEvaluationInputError extends Error {
  override readonly name = "PaperEvaluationInputError";
}

export interface PaperVersionRef {
  readonly id: string;
  readonly version: string;
}
export interface ImmutableOddsEvidenceRef {
  readonly partitionKey: string;
  readonly sortKey: string;
  readonly snapshotId: string;
}
export interface EvaluationProbability {
  readonly point?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}
export interface EvaluationThresholds {
  readonly minimumExpectedValue: number;
  readonly minimumComparisonBooks: number;
  readonly maximumPriceAgeMinutes: number;
}
export interface EvaluationManifestInput {
  readonly mode: "decision-time" | "backtest";
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly eventId: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly offeredOdds: ImmutableOddsEvidenceRef;
  readonly comparisonEvidence: readonly ImmutableOddsEvidenceRef[];
  readonly probability: EvaluationProbability;
  readonly uncertainty: number;
  readonly noVigProbability: number;
  readonly expectedValue: number;
  readonly thresholds: EvaluationThresholds;
  readonly evidenceCompleteness: "complete" | "partial" | "insufficient";
  readonly versions: {
    readonly sportModule: PaperVersionRef;
    readonly strategy: PaperVersionRef;
    readonly model: PaperVersionRef;
    readonly promptBundle: PaperVersionRef | null;
    readonly calculation: PaperVersionRef;
    readonly inputSchema: PaperVersionRef;
    readonly manifestSchema: PaperVersionRef;
  };
  readonly provenanceReferences: readonly string[];
}
export interface NormalizedEvaluationManifest extends EvaluationManifestInput {
  readonly inputHash: string;
}
export type PaperDecision = "play" | "no-bet";
export interface PaperEvaluationInput {
  readonly manifest: EvaluationManifestInput & { readonly inputHash?: string };
  readonly decision: PaperDecision;
  readonly reasonCodes: readonly string[];
  readonly createdAt: string;
  readonly evaluationId?: string;
  readonly paperBetId?: string;
}
export interface PaperEvaluationRecord {
  readonly evaluationId: string;
  readonly inputHash: string;
  readonly manifest: NormalizedEvaluationManifest;
  readonly decision: PaperDecision;
  readonly reasonCodes: readonly string[];
  readonly createdAt: string;
}
export interface PaperBetRecord {
  readonly paperBetId: string;
  readonly evaluationId: string;
  readonly inputHash: string;
  readonly mode: "decision-time" | "backtest";
  readonly offeredOdds: ImmutableOddsEvidenceRef;
  readonly createdAt: string;
}
export interface PaperEvaluationPair {
  readonly evaluation: PaperEvaluationRecord;
  readonly paperBet: PaperBetRecord | null;
}

const own = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PaperEvaluationInputError(`${label}-object-required`);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new PaperEvaluationInputError(`${label}-plain-object-required`);
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEY.test(key))
      throw new PaperEvaluationInputError(`${label}-unsafe-field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new PaperEvaluationInputError(`${label}-data-properties-required`);
    record[key] = descriptor.value;
  }
  return record;
};
const exact = (
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) => {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  )
    throw new PaperEvaluationInputError(`${label}-fields-invalid`);
};
const id = (value: unknown, label: string, maximum = MAX_TEXT) => {
  if (
    typeof value !== "string" ||
    !value.length ||
    new TextEncoder().encode(value).length > maximum ||
    !ID.test(value)
  )
    throw new PaperEvaluationInputError(`${label}-invalid`);
  return value;
};
const finite = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    throw new PaperEvaluationInputError(`${label}-invalid`);
  return Object.is(value, -0) ? 0 : value;
};
const probabilityValue = (value: unknown, label: string) => {
  const result = finite(value, label, 0, 1);
  if (result <= 0 || result >= 1)
    throw new PaperEvaluationInputError(`${label}-invalid`);
  return result;
};
const integer = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new PaperEvaluationInputError(`${label}-invalid`);
  return Number(value);
};
const iso = (value: unknown, label: string) => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new PaperEvaluationInputError(`${label}-invalid`);
  return value;
};
const version = (value: unknown, label: string): PaperVersionRef => {
  const record = own(value, label);
  exact(record, ["id", "version"], label);
  return {
    id: id(record.id, `${label}-id`),
    version: id(record.version, `${label}-version`),
  };
};
const evidence = (value: unknown, label: string): ImmutableOddsEvidenceRef => {
  const record = own(value, label);
  exact(record, ["partitionKey", "sortKey", "snapshotId"], label);
  const partitionKey = id(record.partitionKey, `${label}-partition-key`, 1024);
  const sortKey = id(record.sortKey, `${label}-sort-key`, 1024);
  const snapshotId = id(record.snapshotId, `${label}-snapshot-id`, 64);
  if (
    !partitionKey.startsWith("FIXTURE_ODDS#") ||
    /CURRENT/i.test(partitionKey) ||
    /CURRENT/i.test(sortKey) ||
    !sortKey.startsWith("SNAPSHOT#")
  )
    throw new PaperEvaluationInputError(
      `${label}-must-reference-immutable-snapshot`,
    );
  if (!HASH.test(snapshotId))
    throw new PaperEvaluationInputError(`${label}-snapshot-id-invalid`);
  const partitionEncoded = partitionKey.slice("FIXTURE_ODDS#".length);
  let dimensions: unknown;
  try {
    dimensions = JSON.parse(partitionEncoded);
  } catch {
    throw new PaperEvaluationInputError(`${label}-partition-key-invalid`);
  }
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 6 ||
    dimensions.some((dimension, index) =>
      index === 1
        ? !Number.isSafeInteger(dimension) || Number(dimension) < 1
        : typeof dimension !== "string" || !dimension.length,
    ) ||
    JSON.stringify(dimensions) !== partitionEncoded
  )
    throw new PaperEvaluationInputError(`${label}-partition-key-invalid`);
  const sortMatch = /^SNAPSHOT#(.+)#([a-f0-9]{64})$/.exec(sortKey);
  if (
    !sortMatch ||
    sortMatch[2] !== snapshotId ||
    !Number.isFinite(Date.parse(sortMatch[1]!)) ||
    new Date(sortMatch[1]!).toISOString() !== sortMatch[1]
  )
    throw new PaperEvaluationInputError(`${label}-snapshot-identity-mismatch`);
  return { partitionKey, sortKey, snapshotId };
};
const evidenceDimensions = (reference: ImmutableOddsEvidenceRef) =>
  JSON.parse(reference.partitionKey.slice("FIXTURE_ODDS#".length)) as readonly [
    string,
    number,
    string,
    string,
    string,
    string,
  ];
const semanticStrings = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length > MAX_ARRAY)
    throw new PaperEvaluationInputError(`${label}-invalid`);
  const normalized = value.map((entry, index) =>
    id(entry, `${label}-${index}`),
  );
  if (
    normalized.some((entry) =>
      /(?:^|[?&#;\s])(?:secret|credential|api[_-]?key|auth(?:orization)?|cookie|access[_-]?token|refresh[_-]?token|raw[_-]?(?:payload|response|body))\s*[:=]/i.test(
        entry,
      ),
    )
  )
    throw new PaperEvaluationInputError(`${label}-unsafe-value`);
  return [...new Set(normalized)].sort(compareBytes);
};
const compareBytes = (a: string, b: string) => {
  const aa = new TextEncoder().encode(a),
    bb = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) {
    if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  }
  return aa.length - bb.length;
};
const stable = (value: unknown): string => JSON.stringify(canonical(value));
const canonical = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new PaperEvaluationInputError("non-finite-number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  const record = own(value, "canonical-value");
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareBytes)
      .map((key) => [key, canonical(record[key])]),
  );
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>))
      freeze(nested);
    Object.freeze(value);
  }
  return value;
};

export function normalizeEvaluationManifest(
  input: EvaluationManifestInput & { readonly inputHash?: string },
): NormalizedEvaluationManifest {
  const record = own(input, "manifest");
  const suppliedHash = record.inputHash;
  delete record.inputHash;
  exact(
    record,
    [
      "mode",
      "sportKey",
      "leagueKey",
      "eventId",
      "marketKey",
      "selectionKey",
      "offeredOdds",
      "comparisonEvidence",
      "probability",
      "uncertainty",
      "noVigProbability",
      "expectedValue",
      "thresholds",
      "evidenceCompleteness",
      "versions",
      "provenanceReferences",
    ],
    "manifest",
  );
  if (record.mode !== "decision-time" && record.mode !== "backtest")
    throw new PaperEvaluationInputError("manifest-mode-invalid");
  const probability = own(record.probability, "probability");
  if (Object.hasOwn(probability, "point")) {
    exact(probability, ["point"], "probability");
    probability.point = probabilityValue(
      probability.point,
      "probability-point",
    );
  } else {
    exact(probability, ["minimum", "maximum"], "probability");
    probability.minimum = probabilityValue(
      probability.minimum,
      "probability-minimum",
    );
    probability.maximum = probabilityValue(
      probability.maximum,
      "probability-maximum",
    );
    if (Number(probability.minimum) > Number(probability.maximum))
      throw new PaperEvaluationInputError("probability-range-invalid");
  }
  const thresholds = own(record.thresholds, "thresholds");
  exact(
    thresholds,
    [
      "minimumExpectedValue",
      "minimumComparisonBooks",
      "maximumPriceAgeMinutes",
    ],
    "thresholds",
  );
  const versions = own(record.versions, "versions");
  exact(
    versions,
    [
      "sportModule",
      "strategy",
      "model",
      "promptBundle",
      "calculation",
      "inputSchema",
      "manifestSchema",
    ],
    "versions",
  );
  const comparisons = Array.isArray(record.comparisonEvidence)
    ? record.comparisonEvidence.map((item, index) =>
        evidence(item, `comparison-evidence-${index}`),
      )
    : (() => {
        throw new PaperEvaluationInputError("comparison-evidence-invalid");
      })();
  if (comparisons.length > MAX_ARRAY)
    throw new PaperEvaluationInputError("comparison-evidence-invalid");
  const uniqueComparisons = [
    ...new Map(comparisons.map((item) => [stable(item), item])).values(),
  ].sort((a, b) => compareBytes(stable(a), stable(b)));
  const completeness = record.evidenceCompleteness;
  if (!["complete", "partial", "insufficient"].includes(String(completeness)))
    throw new PaperEvaluationInputError("evidence-completeness-invalid");
  const normalizedBase: EvaluationManifestInput = {
    mode: record.mode,
    sportKey: id(record.sportKey, "sport-key"),
    leagueKey: id(record.leagueKey, "league-key"),
    eventId: id(record.eventId, "event-id"),
    marketKey: id(record.marketKey, "market-key"),
    selectionKey: id(record.selectionKey, "selection-key"),
    offeredOdds: evidence(record.offeredOdds, "offered-odds"),
    comparisonEvidence: uniqueComparisons,
    probability: Object.hasOwn(probability, "point")
      ? { point: probability.point as number }
      : {
          minimum: probability.minimum as number,
          maximum: probability.maximum as number,
        },
    uncertainty: finite(record.uncertainty, "uncertainty", 0, 1),
    noVigProbability: probabilityValue(
      record.noVigProbability,
      "no-vig-probability",
    ),
    expectedValue: finite(record.expectedValue, "expected-value", -1000, 1000),
    thresholds: {
      minimumExpectedValue: finite(
        thresholds.minimumExpectedValue,
        "minimum-expected-value",
        -1000,
        1000,
      ),
      minimumComparisonBooks: integer(
        thresholds.minimumComparisonBooks,
        "minimum-comparison-books",
        0,
        MAX_ARRAY,
      ),
      maximumPriceAgeMinutes: integer(
        thresholds.maximumPriceAgeMinutes,
        "maximum-price-age-minutes",
        0,
        10080,
      ),
    },
    evidenceCompleteness:
      completeness as EvaluationManifestInput["evidenceCompleteness"],
    versions: {
      sportModule: version(versions.sportModule, "sport-module-version"),
      strategy: version(versions.strategy, "strategy-version"),
      model: version(versions.model, "model-version"),
      promptBundle:
        versions.promptBundle === null
          ? null
          : version(versions.promptBundle, "prompt-bundle-version"),
      calculation: version(versions.calculation, "calculation-version"),
      inputSchema: version(versions.inputSchema, "input-schema-version"),
      manifestSchema: version(
        versions.manifestSchema,
        "manifest-schema-version",
      ),
    },
    provenanceReferences: semanticStrings(
      record.provenanceReferences,
      "provenance-references",
    ),
  };
  const expectedDimensions = [
    normalizedBase.eventId,
    normalizedBase.sportKey,
    normalizedBase.marketKey,
    normalizedBase.selectionKey,
  ] as const;
  for (const [index, reference] of [
    normalizedBase.offeredOdds,
    ...normalizedBase.comparisonEvidence,
  ].entries()) {
    const [eventId, , sportKey, marketKey, selectionKey] =
      evidenceDimensions(reference);
    if (
      eventId !== expectedDimensions[0] ||
      sportKey !== expectedDimensions[1] ||
      marketKey !== expectedDimensions[2] ||
      selectionKey !== expectedDimensions[3]
    )
      throw new PaperEvaluationInputError(
        `${index === 0 ? "offered" : "comparison"}-evidence-binding-invalid`,
      );
  }
  const encoded = stable(normalizedBase);
  if (new TextEncoder().encode(encoded).length > 64 * 1024)
    throw new PaperEvaluationInputError("manifest-too-large");
  const inputHash = sha256Hex(encoded);
  if (suppliedHash !== undefined && suppliedHash !== inputHash)
    throw new PaperEvaluationInputError("manifest-input-hash-invalid");
  return freeze({ ...normalizedBase, inputHash });
}

export function createPaperEvaluation(
  input: PaperEvaluationInput,
): PaperEvaluationPair {
  const record = own(input, "evaluation-input");
  exact(
    record,
    [
      "manifest",
      "decision",
      "reasonCodes",
      "createdAt",
      ...(Object.hasOwn(record, "evaluationId") ? ["evaluationId"] : []),
      ...(Object.hasOwn(record, "paperBetId") ? ["paperBetId"] : []),
    ],
    "evaluation-input",
  );
  if (input.decision !== "play" && input.decision !== "no-bet")
    throw new PaperEvaluationInputError("decision-invalid");
  const manifest = normalizeEvaluationManifest(input.manifest);
  const reasonCodes = semanticStrings(input.reasonCodes, "reason-codes");
  if (!reasonCodes.length)
    throw new PaperEvaluationInputError("reason-codes-required");
  const createdAt = iso(input.createdAt, "created-at");
  const evaluationId = `evaluation:${manifest.inputHash}`;
  if (input.evaluationId !== undefined && input.evaluationId !== evaluationId)
    throw new PaperEvaluationInputError("evaluation-id-invalid");
  const evaluation = freeze({
    evaluationId,
    inputHash: manifest.inputHash,
    manifest,
    decision: input.decision,
    reasonCodes,
    createdAt,
  });
  if (input.decision === "no-bet") {
    if (input.paperBetId !== undefined)
      throw new PaperEvaluationInputError("no-bet-cannot-have-paper-bet");
    return freeze({ evaluation, paperBet: null });
  }
  const paperBetId = `paper-bet:${manifest.inputHash}`;
  if (input.paperBetId !== undefined && input.paperBetId !== paperBetId)
    throw new PaperEvaluationInputError("paper-bet-id-invalid");
  return freeze({
    evaluation,
    paperBet: freeze({
      paperBetId,
      evaluationId,
      inputHash: manifest.inputHash,
      mode: manifest.mode,
      offeredOdds: manifest.offeredOdds,
      createdAt,
    }),
  });
}

export function normalizePaperEvaluationRecord(
  value: unknown,
): PaperEvaluationRecord {
  const record = own(value, "stored-evaluation");
  exact(
    record,
    [
      "evaluationId",
      "inputHash",
      "manifest",
      "decision",
      "reasonCodes",
      "createdAt",
    ],
    "stored-evaluation",
  );
  if (typeof record.inputHash !== "string" || !HASH.test(record.inputHash))
    throw new PaperEvaluationInputError("stored-evaluation-input-hash-invalid");
  const pair = createPaperEvaluation({
    manifest: record.manifest as EvaluationManifestInput & {
      readonly inputHash?: string;
    },
    decision: record.decision as PaperDecision,
    reasonCodes: record.reasonCodes as readonly string[],
    createdAt: record.createdAt as string,
    evaluationId: record.evaluationId as string,
  });
  if (pair.evaluation.inputHash !== record.inputHash)
    throw new PaperEvaluationInputError("stored-evaluation-hash-mismatch");
  return pair.evaluation;
}

export function normalizePaperBetRecord(value: unknown): PaperBetRecord {
  const record = own(value, "stored-paper-bet");
  exact(
    record,
    [
      "paperBetId",
      "evaluationId",
      "inputHash",
      "mode",
      "offeredOdds",
      "createdAt",
    ],
    "stored-paper-bet",
  );
  const inputHash = id(record.inputHash, "stored-paper-bet-input-hash", 64);
  if (!HASH.test(inputHash))
    throw new PaperEvaluationInputError("stored-paper-bet-input-hash-invalid");
  if (
    record.evaluationId !== `evaluation:${inputHash}` ||
    record.paperBetId !== `paper-bet:${inputHash}`
  )
    throw new PaperEvaluationInputError("stored-paper-bet-identity-invalid");
  if (record.mode !== "decision-time" && record.mode !== "backtest")
    throw new PaperEvaluationInputError("stored-paper-bet-mode-invalid");
  return freeze({
    paperBetId: record.paperBetId,
    evaluationId: record.evaluationId,
    inputHash,
    mode: record.mode,
    offeredOdds: evidence(record.offeredOdds, "stored-paper-bet-offered-odds"),
    createdAt: iso(record.createdAt, "stored-paper-bet-created-at"),
  });
}

export function assertEvaluationId(value: unknown): string {
  if (typeof value !== "string" || !/^evaluation:[a-f0-9]{64}$/.test(value))
    throw new PaperEvaluationInputError("evaluation-id-invalid");
  return value;
}

export function assertPaperBetId(value: unknown): string {
  if (typeof value !== "string" || !/^paper-bet:[a-f0-9]{64}$/.test(value))
    throw new PaperEvaluationInputError("paper-bet-id-invalid");
  return value;
}

export const stablePaperEvaluationValue = stable;
export const clonePaperEvaluationValue = <T>(value: T): T =>
  freeze(JSON.parse(stable(value)) as T);
