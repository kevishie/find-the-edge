import {
  calculationInputHash,
  canonicalCalculationJson,
  sha256Hex,
} from "@find-the-edge/domain";
import type { SportModule, StrategyDefinition } from "@find-the-edge/sports";
import {
  validateReportCalculationReference,
  type ReportCalculationReference,
} from "@find-the-edge/odds";

import type {
  ReportModelPort,
  ReportModelRequest,
  ReportModelResult,
} from "./report-model-port";
import { ReportModelProviderError } from "./report-model-port";
import { validTrustedInstructions } from "./trusted-instructions";
import type {
  NormalizedScoutingFact,
  NormalizedScoutingInput,
} from "./scouting-input";

export type TrustedReportCalculationReference = ReportCalculationReference;

export type ScoutingReportSectionState =
  "available" | "partial" | "unavailable";

export interface ScoutingReportDraftSection {
  readonly key: string;
  readonly classification?: "summary" | "interpretation" | "risk";
  readonly narrative?: string;
  readonly factCitations?: readonly string[];
  readonly calculationCitations?: readonly string[];
}

export interface ScoutingReportDraft {
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly sections: readonly ScoutingReportDraftSection[];
}

export interface ExpectedReportModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly deploymentId?: string;
}

export interface ExpectedReportPromptBundle {
  readonly id: string;
  readonly version: string;
  readonly trustedInstructions: readonly string[];
}

export interface CanonicalScoutingReportSection {
  readonly key: string;
  readonly title: string;
  readonly state: ScoutingReportSectionState;
  readonly classification: "summary" | "interpretation" | "risk" | null;
  readonly narrative: string | null;
  readonly unavailableReason: string | null;
  readonly facts: readonly NormalizedScoutingFact[];
  readonly calculations: readonly TrustedReportCalculationReference[];
}

export interface CanonicalScoutingReport {
  readonly schemaId: "find-the-edge.scouting-report-draft";
  readonly schemaVersion: "1.0.0";
  readonly reportSchema: Readonly<{ id: string; version: string }>;
  readonly event: Readonly<{
    canonicalEventId: string;
    canonicalEventVersion: string;
  }>;
  readonly sport: Readonly<{ key: string; moduleVersion: string }>;
  readonly strategy: Readonly<{ id: string; version: string }>;
  readonly scoutingInput: Readonly<{
    schemaId: string;
    schemaVersion: string;
    manifestHash: string;
    inputHash: string;
  }>;
  readonly instructionBundle: Readonly<{
    id: string;
    version: string;
    requestHash: string;
    calculationManifestHash: string;
  }>;
  readonly model: ReportModelResult["metadata"];
  readonly disposition: Readonly<{
    state: "plays" | "pass" | "unavailable";
    qualificationReferenceIds: readonly string[];
  }>;
  readonly sections: readonly CanonicalScoutingReportSection[];
  readonly draftHash: string;
}

export interface ValidateScoutingReportOptions {
  readonly module: SportModule;
  readonly strategy: Pick<StrategyDefinition, "id" | "version" | "sportKey">;
  readonly scoutingInput: NormalizedScoutingInput;
  readonly modelRequest: ReportModelRequest;
  readonly expectedPromptBundle: ExpectedReportPromptBundle;
  readonly expectedModel: ExpectedReportModelIdentity;
  readonly calculationReferences: readonly TrustedReportCalculationReference[];
}

export type ScoutingReportErrorCode =
  | "INVALID_DRAFT"
  | "INVALID_CONTEXT"
  | "MODEL_MISMATCH"
  | "UNSUPPORTED_CITATION"
  | "FORGED_AUTHORITY"
  | "UNSAFE_CONTENT";

export class ScoutingReportValidationError extends Error {
  override readonly name = "ScoutingReportValidationError";
  constructor(readonly code: ScoutingReportErrorCode) {
    super(`Scouting report ${code.toLowerCase()}`);
  }
}

export type ScoutingReportTelemetryEvent =
  | Readonly<{
      type: "scouting-report.started";
      schemaVersion: string;
      requestHash: string;
      inputHash: string;
      calculationManifestHash: string;
    }>
  | Readonly<{
      type: "scouting-report.succeeded";
      schemaVersion: string;
      requestHash: string;
      draftHash: string;
      sectionCount: number;
      factCitationCount: number;
      calculationCitationCount: number;
      inputUnits: number;
      outputUnits: number;
      totalUnits: number;
      latencyMilliseconds: number;
      validationOutcome: "accepted";
    }>
  | Readonly<{
      type: "scouting-report.failed";
      schemaVersion: string;
      requestHash: string;
      reasonCode:
        | ScoutingReportErrorCode
        | "PROVIDER_DISABLED"
        | "PROVIDER_ABORTED"
        | "PROVIDER_FAILED"
        | "PROVIDER_INVALID_RESULT";
      validationOutcome: "rejected";
    }>;

export type ScoutingReportTelemetry = (
  event: ScoutingReportTelemetryEvent,
) => void;

type RecordValue = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SECTIONS = 64;
const MAX_CITATIONS = 64;
const MAX_NARRATIVE = 4_096;
const MAX_TOTAL_NARRATIVE = 32_768;
const SECRET =
  /(?:\bbearer\s+\S+|\bbasic\s+\S+|\b(?:ghp_|github_pat_|sk[-_]|AKIA|ASIA)[A-Za-z0-9_-]+|-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|(?:secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:^|\D)\d{3}[- ]\d{2}[- ]\d{4}(?:$|\D)|(?:^|\D)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?:$|\D))/i;
const FORGED_NUMBER =
  /(?:\b(?:decimal\s+odds|american\s+odds|odds|probabilit(?:y|ies)|chance|price|line|fair\s*(?:price|odds|probability)|expected\s+value|EV|kelly|CLV|edge|line\s+movement)\b[^\n]{0,32}?[-+]?(?:\d+(?:\.\d+)?|\.\d+)%?|[-+]?(?:\d+(?:\.\d+)?|\.\d+)%\s+(?:chance|probability|edge|EV)\b|\bp\s*=\s*(?:0?\.\d+|1(?:\.0+)?)\b)/i;
const FORGED_DECISION =
  /(?:\b(?:nuke|no[- ]bet|final\s+plays?|qualified\s+(?:play|opportunity)|lock|guarantee(?:d)?|risk[- ]free)\b|\b(?:decision|recommendation|pick)\s*(?::|is|=)?\s*(?:play|pass|bet|no[- ]bet|back|wager)\b|\bthe\s+play\s+is\b|\bis\s+a\s+value\s+(?:bet|wager|play)\b|\bis\s+the\s+side\s+to\s+(?:back|bet|take|play)\b|\bconsider\s+(?:betting|backing|wagering)(?:\s+on)?\b|\b(?:you|we|bettors?)\s+should\s+(?:bet|back|wager|play|take)\b|\bshould\s+be\s+(?:backed|bet|played|taken|wagered)\b|\bgets?\s+the\s+nod\b|\bi\s+(?:recommend|suggest|advise|favou?r|like|love|prefer)\b|\bmy\s+pick\b|\b(?:best|strongest|top|preferred)\s+(?:bet|wager|play|pick)\b|\bworth\s+(?:betting|backing|a\s+(?:bet|wager|play))\b|\brecommended\s+(?:side|play|bet|wager|pick)\b|\blean(?:ing)?\s+(?:toward|to)\b|(?:^|[.!?]\s*)\s*(?:bet|take|play|back|wager)\s+(?:on\s+)?(?:the\s+)?[A-Za-z0-9])/i;

function hasMixedScriptToken(value: string): boolean {
  const tokens = value.match(/[\p{L}\p{M}]+/gu) ?? [];
  return tokens.some(
    (token) =>
      /\p{Script=Latin}/u.test(token) &&
      (/\p{Script=Cyrillic}/u.test(token) || /\p{Script=Greek}/u.test(token)),
  );
}

function fail(code: ScoutingReportErrorCode): never {
  throw new ScoutingReportValidationError(code);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clonePlain(
  input: unknown,
  seen = new Set<object>(),
  depth = 0,
  counter = { count: 0 },
): unknown {
  counter.count += 1;
  if (counter.count > 4_096 || depth > 32) return fail("INVALID_DRAFT");
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return fail("INVALID_DRAFT");
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object" || seen.has(input))
    return fail("INVALID_DRAFT");
  seen.add(input);
  try {
    const prototype = Reflect.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype || input.length > 256)
        return fail("INVALID_DRAFT");
      const allowed = new Set([
        "length",
        ...Array.from({ length: input.length }, (_, index) => String(index)),
      ]);
      if (
        Reflect.ownKeys(input).some(
          (key) => typeof key !== "string" || !allowed.has(key),
        )
      ) {
        return fail("INVALID_DRAFT");
      }
      const output: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          input,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor))
          return fail("INVALID_DRAFT");
        output.push(clonePlain(descriptor.value, seen, depth + 1, counter));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null)
      return fail("INVALID_DRAFT");
    const keys = Reflect.ownKeys(input);
    if (keys.length > 256) return fail("INVALID_DRAFT");
    const output: RecordValue = {};
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key)
      ) {
        return fail("INVALID_DRAFT");
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        return fail("INVALID_DRAFT");
      output[key] = clonePlain(descriptor.value, seen, depth + 1, counter);
    }
    return output;
  } catch (error) {
    if (error instanceof ScoutingReportValidationError) throw error;
    return fail("INVALID_DRAFT");
  } finally {
    seen.delete(input);
  }
}

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("INVALID_DRAFT");
  return value as RecordValue;
}

function exact(
  value: RecordValue,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.includes(key))
  ) {
    fail("INVALID_DRAFT");
  }
}

function exactContext(
  value: RecordValue,
  allowed: readonly string[],
  required = allowed,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.includes(key))
  ) {
    fail("INVALID_CONTEXT");
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value))
    return fail("INVALID_DRAFT");
  return value;
}

function citations(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CITATIONS)
    return fail("INVALID_DRAFT");
  const output = value.map(identifier);
  if (new Set(output).size !== output.length) return fail("INVALID_DRAFT");
  return output.sort();
}

function narrative(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NARRATIVE ||
    value !== value.trim() ||
    hasUnsafeControl(value) ||
    SECRET.test(value)
  ) {
    return fail("UNSAFE_CONTENT");
  }
  const authorityText = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (
    hasMixedScriptToken(authorityText) ||
    FORGED_NUMBER.test(authorityText) ||
    FORGED_DECISION.test(authorityText)
  )
    return fail("FORGED_AUTHORITY");
  return value;
}

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}

interface ParsedSection {
  key: string;
  classification?: "summary" | "interpretation" | "risk";
  narrative?: string;
  factCitations: string[];
  calculationCitations: string[];
}

function parseDraft(input: unknown): {
  schemaId: string;
  schemaVersion: string;
  sections: ParsedSection[];
} {
  const root = record(clonePlain(input));
  exact(
    root,
    ["schemaId", "schemaVersion", "sections"],
    ["schemaId", "schemaVersion", "sections"],
  );
  if (
    !Array.isArray(root["sections"]) ||
    root["sections"].length > MAX_SECTIONS
  )
    return fail("INVALID_DRAFT");
  let totalNarrativeBytes = 0;
  const encoder = new TextEncoder();
  const sections = root["sections"].map((value) => {
    const section = record(value);
    exact(
      section,
      [
        "key",
        "classification",
        "narrative",
        "factCitations",
        "calculationCitations",
      ],
      ["key"],
    );
    const classification = section["classification"];
    if (
      classification !== undefined &&
      (typeof classification !== "string" ||
        !["summary", "interpretation", "risk"].includes(classification))
    ) {
      return fail("INVALID_DRAFT");
    }
    const text = narrative(section["narrative"]);
    totalNarrativeBytes += text === undefined ? 0 : encoder.encode(text).length;
    const parsed: ParsedSection = {
      key: identifier(section["key"]),
      ...(text === undefined ? {} : { narrative: text }),
      factCitations: citations(section["factCitations"]),
      calculationCitations: citations(section["calculationCitations"]),
    };
    if (classification !== undefined) {
      parsed.classification = classification as Exclude<
        ParsedSection["classification"],
        undefined
      >;
    }
    return parsed;
  });
  if (totalNarrativeBytes > MAX_TOTAL_NARRATIVE) return fail("UNSAFE_CONTENT");
  return {
    schemaId: identifier(root["schemaId"]),
    schemaVersion: identifier(root["schemaVersion"]),
    sections,
  };
}

function calculationManifestHash(
  references: readonly TrustedReportCalculationReference[],
): string {
  const summaries = [...references]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      marketKey: reference.marketKey,
      selectionKey: reference.selectionKey,
      calculationVersion: reference.calculationVersion,
      status: reference.status,
      referenceHash: reference.referenceHash,
    }));
  return sha256Hex(canonicalCalculationJson(summaries));
}

function normalizeReferencesUnchecked(
  input: readonly TrustedReportCalculationReference[],
): readonly Readonly<TrustedReportCalculationReference>[] {
  if (!Array.isArray(input) || input.length > 256) fail("INVALID_CONTEXT");
  const normalized = input.map((value) =>
    validateReportCalculationReference(value),
  );
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length)
    fail("INVALID_CONTEXT");
  normalized.sort((left, right) =>
    left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : left.referenceHash < right.referenceHash
          ? -1
          : left.referenceHash > right.referenceHash
            ? 1
            : 0,
  );
  return Object.freeze(normalized);
}

function normalizeReferences(
  input: readonly TrustedReportCalculationReference[],
): readonly Readonly<TrustedReportCalculationReference>[] {
  try {
    return normalizeReferencesUnchecked(input);
  } catch (error) {
    if (
      error instanceof ScoutingReportValidationError &&
      error.code === "INVALID_CONTEXT"
    ) {
      throw error;
    }
    return fail("INVALID_CONTEXT");
  }
}

function parseFramedRequest(value: string): Readonly<Record<string, string>> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  const prefix = encoder.encode("FTE-REPORT-REQUEST/1\n");
  if (
    bytes.length < prefix.length ||
    prefix.some((byte, index) => byte !== bytes[index])
  ) {
    fail("INVALID_CONTEXT");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output: Record<string, string> = {};
  let offset = prefix.length;
  const names = [
    "TRUSTED_INSTRUCTIONS",
    "TRUSTED_IDENTITIES",
    "UNTRUSTED_FACTS",
    "DETERMINISTIC_REFERENCES",
  ] as const;
  try {
    for (const expectedName of names) {
      let newline = offset;
      while (newline < bytes.length && bytes[newline] !== 10) newline += 1;
      if (newline === bytes.length) fail("INVALID_CONTEXT");
      const header = decoder.decode(bytes.slice(offset, newline));
      const match = /^([A-Z_]+):(0|[1-9]\d*)$/.exec(header);
      if (match?.[1] !== expectedName) fail("INVALID_CONTEXT");
      const length = Number(match[2]);
      if (!Number.isSafeInteger(length) || length > 262_144)
        fail("INVALID_CONTEXT");
      const start = newline + 1;
      const end = start + length;
      if (end >= bytes.length || bytes[end] !== 10) fail("INVALID_CONTEXT");
      output[expectedName] = decoder.decode(bytes.slice(start, end));
      offset = end + 1;
    }
  } catch (error) {
    if (error instanceof ScoutingReportValidationError) throw error;
    return fail("INVALID_CONTEXT");
  }
  if (offset !== bytes.length) fail("INVALID_CONTEXT");
  return Object.freeze(output);
}

function canonicalFrameJson(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (canonicalCalculationJson(parsed) !== value) fail("INVALID_CONTEXT");
    return clonePlain(parsed);
  } catch (error) {
    if (error instanceof ScoutingReportValidationError) throw error;
    return fail("INVALID_CONTEXT");
  }
}

function validateModelRequestUnchecked(
  options: ValidateScoutingReportOptions,
  references: readonly TrustedReportCalculationReference[],
): Readonly<ReportModelRequest> {
  if (
    options.module.key !== options.module.scoutingReportContract.sportKey ||
    options.module.key !== options.strategy.sportKey ||
    options.module.key !== options.scoutingInput.event.sportKey ||
    references.some(
      (reference) =>
        reference.canonicalEventId !==
          options.scoutingInput.event.canonicalEventId ||
        reference.canonicalEventVersion !==
          String(options.scoutingInput.event.canonicalEventVersion) ||
        reference.sportKey !== options.module.key,
    )
  ) {
    fail("INVALID_CONTEXT");
  }
  const request = record(clonePlain(options.modelRequest));
  exactContext(request, [
    "schema",
    "identities",
    "requestHash",
    "framedContent",
  ]);
  const schema = record(request["schema"]);
  exactContext(schema, ["id", "version"]);
  const identities = record(request["identities"]);
  exactContext(identities, [
    "sportKey",
    "moduleVersion",
    "strategyId",
    "strategyVersion",
    "scoutingInputHash",
    "calculationManifestHash",
    "promptBundleId",
    "promptBundleVersion",
  ]);
  if (
    [schema["id"], schema["version"], ...Object.values(identities)].some(
      (value) => typeof value !== "string" || !ID.test(value),
    ) ||
    !HASH.test(options.scoutingInput.inputHash) ||
    !HASH.test(options.scoutingInput.manifestHash) ||
    !HASH.test(String(identities["scoutingInputHash"])) ||
    !HASH.test(String(identities["calculationManifestHash"]))
  ) {
    fail("INVALID_CONTEXT");
  }
  const framedContent = request["framedContent"];
  const requestHash = request["requestHash"];
  if (
    typeof framedContent !== "string" ||
    typeof requestHash !== "string" ||
    !HASH.test(requestHash) ||
    sha256Hex(framedContent) !== requestHash
  ) {
    fail("INVALID_CONTEXT");
  }
  const frames = parseFramedRequest(framedContent);
  const trustedInstructions = canonicalFrameJson(
    frames["TRUSTED_INSTRUCTIONS"]!,
  );
  if (!validTrustedInstructions(trustedInstructions)) {
    fail("INVALID_CONTEXT");
  }
  const expectedBundle = record(clonePlain(options.expectedPromptBundle));
  exactContext(expectedBundle, ["id", "version", "trustedInstructions"]);
  if (
    typeof expectedBundle["id"] !== "string" ||
    !ID.test(expectedBundle["id"]) ||
    typeof expectedBundle["version"] !== "string" ||
    !ID.test(expectedBundle["version"]) ||
    !Array.isArray(expectedBundle["trustedInstructions"]) ||
    canonicalCalculationJson(expectedBundle["trustedInstructions"]) !==
      canonicalCalculationJson(trustedInstructions)
  ) {
    fail("INVALID_CONTEXT");
  }
  const framedIdentities = record(
    canonicalFrameJson(frames["TRUSTED_IDENTITIES"]!),
  );
  exactContext(framedIdentities, [
    "schema",
    "sportKey",
    "moduleVersion",
    "strategy",
    "sourceSchema",
    "sourceManifestHash",
    "sourceInputHash",
    "instructionBundle",
    "calculationManifestHash",
  ]);
  const framedSchema = record(framedIdentities["schema"]);
  const framedStrategy = record(framedIdentities["strategy"]);
  const framedSourceSchema = record(framedIdentities["sourceSchema"]);
  const framedBundle = record(framedIdentities["instructionBundle"]);
  exactContext(framedSchema, ["id", "version"]);
  exactContext(framedStrategy, ["id", "version"]);
  exactContext(framedSourceSchema, ["id", "version"]);
  exactContext(framedBundle, ["id", "version"]);
  const framedFacts = canonicalFrameJson(frames["UNTRUSTED_FACTS"]!);
  const expectedFacts = [...options.scoutingInput.facts]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((fact) => ({
      id: fact.id,
      capabilityKey: fact.capabilityKey,
      schemaKey: fact.schemaKey,
      ...(fact.schemaVariant === undefined
        ? {}
        : { schemaVariant: fact.schemaVariant }),
      ...(fact.subjectId === undefined ? {} : { subjectId: fact.subjectId }),
      state: fact.state,
      ...(Object.hasOwn(fact, "value") ? { value: fact.value } : {}),
      ...(fact.unavailableReason === undefined
        ? {}
        : { unavailableReason: fact.unavailableReason }),
      confidence: fact.confidence,
      freshness: fact.freshness,
      evidenceIds: fact.provenance.map((item) => item.id).sort(),
    }));
  const framedReferences = canonicalFrameJson(
    frames["DETERMINISTIC_REFERENCES"]!,
  );
  const expectedReferences = [...references]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      marketKey: reference.marketKey,
      selectionKey: reference.selectionKey,
      calculationVersion: reference.calculationVersion,
      status: reference.status,
      referenceHash: reference.referenceHash,
    }));
  const manifestHash = calculationManifestHash(references);
  if (
    canonicalCalculationJson(framedFacts) !==
      canonicalCalculationJson(expectedFacts) ||
    canonicalCalculationJson(framedReferences) !==
      canonicalCalculationJson(expectedReferences) ||
    schema["id"] !== options.module.scoutingReportContract.schemaId ||
    schema["version"] !== options.module.scoutingReportContract.schemaVersion ||
    identities["sportKey"] !== options.module.key ||
    identities["moduleVersion"] !== options.module.metadata.version ||
    identities["strategyId"] !== options.strategy.id ||
    identities["strategyVersion"] !== options.strategy.version ||
    identities["scoutingInputHash"] !== options.scoutingInput.inputHash ||
    identities["calculationManifestHash"] !== manifestHash ||
    framedSchema["id"] !== schema["id"] ||
    framedSchema["version"] !== schema["version"] ||
    framedIdentities["sportKey"] !== identities["sportKey"] ||
    framedIdentities["moduleVersion"] !== identities["moduleVersion"] ||
    framedStrategy["id"] !== identities["strategyId"] ||
    framedStrategy["version"] !== identities["strategyVersion"] ||
    framedSourceSchema["id"] !== options.scoutingInput.moduleSchema.id ||
    framedSourceSchema["version"] !==
      options.scoutingInput.moduleSchema.version ||
    framedIdentities["sourceManifestHash"] !==
      options.scoutingInput.manifestHash ||
    framedIdentities["sourceInputHash"] !== identities["scoutingInputHash"] ||
    framedBundle["id"] !== identities["promptBundleId"] ||
    framedBundle["version"] !== identities["promptBundleVersion"] ||
    framedBundle["id"] !== expectedBundle["id"] ||
    framedBundle["version"] !== expectedBundle["version"] ||
    framedIdentities["calculationManifestHash"] !== manifestHash
  ) {
    fail("INVALID_CONTEXT");
  }
  return deepFreeze({
    schema: { id: String(schema["id"]), version: String(schema["version"]) },
    identities: {
      sportKey: String(identities["sportKey"]),
      moduleVersion: String(identities["moduleVersion"]),
      strategyId: String(identities["strategyId"]),
      strategyVersion: String(identities["strategyVersion"]),
      scoutingInputHash: String(identities["scoutingInputHash"]),
      calculationManifestHash: String(identities["calculationManifestHash"]),
      promptBundleId: String(identities["promptBundleId"]),
      promptBundleVersion: String(identities["promptBundleVersion"]),
    },
    requestHash,
    framedContent,
  });
}

function validateModelRequest(
  options: ValidateScoutingReportOptions,
  references: readonly TrustedReportCalculationReference[],
): Readonly<ReportModelRequest> {
  try {
    return validateModelRequestUnchecked(options, references);
  } catch (error) {
    if (
      error instanceof ScoutingReportValidationError &&
      error.code === "INVALID_CONTEXT"
    ) {
      throw error;
    }
    return fail("INVALID_CONTEXT");
  }
}

function validateExpectedModelIdentity(
  input: ExpectedReportModelIdentity,
): Readonly<ExpectedReportModelIdentity> {
  const expected = record(clonePlain(input));
  exactContext(
    expected,
    ["providerId", "modelId", "modelVersion", "deploymentId"],
    ["providerId", "modelId", "modelVersion"],
  );
  for (const key of ["providerId", "modelId", "modelVersion"] as const) {
    if (
      typeof expected[key] !== "string" ||
      !ID.test(expected[key]) ||
      SECRET.test(expected[key])
    )
      fail("INVALID_CONTEXT");
  }
  if (
    expected["deploymentId"] !== undefined &&
    (typeof expected["deploymentId"] !== "string" ||
      !ID.test(expected["deploymentId"]) ||
      SECRET.test(expected["deploymentId"]))
  ) {
    fail("INVALID_CONTEXT");
  }
  return deepFreeze({
    providerId: expected["providerId"] as string,
    modelId: expected["modelId"] as string,
    modelVersion: expected["modelVersion"] as string,
    ...(expected["deploymentId"] === undefined
      ? {}
      : { deploymentId: expected["deploymentId"] }),
  });
}

function invalidProviderResult(): never {
  throw new ReportModelProviderError("INVALID_RESULT", false);
}

function normalizeModelResult(input: unknown): Readonly<ReportModelResult> {
  try {
    const result = record(clonePlain(input));
    exactContext(result, ["output", "metadata"]);
    const metadata = record(result["metadata"]);
    exactContext(metadata, [
      "providerId",
      "modelId",
      "modelVersion",
      "deploymentId",
      "usage",
      "latencyMilliseconds",
    ]);
    const usage = record(metadata["usage"]);
    exactContext(usage, ["inputUnits", "outputUnits", "totalUnits"]);
    const values = [
      usage["inputUnits"],
      usage["outputUnits"],
      usage["totalUnits"],
      metadata["latencyMilliseconds"],
    ];
    if (
      values.some(
        (value) => !Number.isSafeInteger(value) || Number(value) < 0,
      ) ||
      Number(usage["inputUnits"]) + Number(usage["outputUnits"]) !==
        usage["totalUnits"] ||
      [
        metadata["providerId"],
        metadata["modelId"],
        metadata["modelVersion"],
        metadata["deploymentId"],
      ].some(
        (value) =>
          typeof value !== "string" || !ID.test(value) || SECRET.test(value),
      )
    ) {
      return invalidProviderResult();
    }
    return deepFreeze({
      output: result["output"],
      metadata: {
        providerId: metadata["providerId"] as string,
        modelId: metadata["modelId"] as string,
        modelVersion: metadata["modelVersion"] as string,
        deploymentId: metadata["deploymentId"] as string,
        usage: {
          inputUnits: Number(usage["inputUnits"]),
          outputUnits: Number(usage["outputUnits"]),
          totalUnits: Number(usage["totalUnits"]),
        },
        latencyMilliseconds: Number(metadata["latencyMilliseconds"]),
      },
    });
  } catch (error) {
    if (error instanceof ReportModelProviderError) throw error;
    return invalidProviderResult();
  }
}

interface ValidatedReportContext {
  readonly result: Readonly<ReportModelResult>;
  readonly modelRequest: Readonly<ReportModelRequest>;
  readonly calculationReferences: readonly Readonly<TrustedReportCalculationReference>[];
}

function validateContext(
  untrustedResult: unknown,
  options: ValidateScoutingReportOptions,
): ValidatedReportContext {
  const references = normalizeReferences(options.calculationReferences);
  const modelRequest = validateModelRequest(options, references);
  const result = normalizeModelResult(untrustedResult);
  const { module, strategy, scoutingInput, expectedModel } = options;
  if (
    module.key !== module.scoutingReportContract.sportKey ||
    module.key !== strategy.sportKey ||
    module.key !== scoutingInput.event.sportKey ||
    references.some(
      (reference) =>
        reference.canonicalEventId !== scoutingInput.event.canonicalEventId ||
        reference.canonicalEventVersion !==
          String(scoutingInput.event.canonicalEventVersion) ||
        reference.sportKey !== module.key,
    )
  ) {
    fail("INVALID_CONTEXT");
  }
  const expected = record(clonePlain(expectedModel));
  exactContext(
    expected,
    ["providerId", "modelId", "modelVersion", "deploymentId"],
    ["providerId", "modelId", "modelVersion"],
  );
  for (const key of ["providerId", "modelId", "modelVersion"] as const) {
    const value = expected[key];
    if (typeof value !== "string" || !ID.test(value)) fail("INVALID_CONTEXT");
  }
  if (
    expected["deploymentId"] !== undefined &&
    (typeof expected["deploymentId"] !== "string" ||
      !ID.test(expected["deploymentId"]))
  ) {
    fail("INVALID_CONTEXT");
  }
  if (
    result.metadata.providerId !== expected["providerId"] ||
    result.metadata.modelId !== expected["modelId"] ||
    result.metadata.modelVersion !== expected["modelVersion"] ||
    (expected["deploymentId"] !== undefined &&
      result.metadata.deploymentId !== expected["deploymentId"])
  ) {
    fail("MODEL_MISMATCH");
  }
  return { result, modelRequest, calculationReferences: references };
}

function disposition(references: readonly TrustedReportCalculationReference[]) {
  const qualifications = references.filter(
    (reference) => reference.kind === "qualification",
  );
  const plays = qualifications.filter(
    (reference) => reference.raw["decision"] === "play",
  );
  return {
    state:
      plays.length > 0
        ? ("plays" as const)
        : qualifications.length > 0
          ? ("pass" as const)
          : ("unavailable" as const),
    qualificationReferenceIds: (plays.length > 0 ? plays : qualifications)
      .map(({ id }) => id)
      .sort(),
  };
}

function usableCalculationReference(
  reference: TrustedReportCalculationReference,
): boolean {
  return reference.kind === "qualification"
    ? reference.status === "play" || reference.status === "no-bet"
    : reference.status === "available";
}

function deterministicSectionReferences(
  definition: SportModule["scoutingReportContract"]["sections"][number],
  references: readonly TrustedReportCalculationReference[],
): readonly TrustedReportCalculationReference[] {
  return references.filter((reference) => {
    if (!definition.allowedCalculationKinds.includes(reference.kind))
      return false;
    if (definition.deterministicReferencePolicy === "qualification-play-only") {
      return reference.kind === "qualification" && reference.status === "play";
    }
    return usableCalculationReference(reference);
  });
}

function assertReportHashCapacity(
  options: ValidateScoutingReportOptions,
  references: readonly TrustedReportCalculationReference[],
  modelRequest: ReportModelRequest,
): void {
  const contract = options.module.scoutingReportContract;
  let narrativeReserve = MAX_TOTAL_NARRATIVE;
  const sections = contract.sections.map((definition) => {
    const unavailable = definition.availability === "unavailable-only";
    const facts = unavailable
      ? []
      : options.scoutingInput.facts.filter((fact) =>
          definition.allowedFactCategories.includes(fact.capabilityKey),
        );
    const calculations = unavailable
      ? []
      : definition.content === "deterministic"
        ? deterministicSectionReferences(definition, references)
        : references.filter((reference) =>
            definition.allowedCalculationKinds.includes(reference.kind),
          );
    const reservedNarrativeLength =
      unavailable || definition.content === "deterministic"
        ? 0
        : Math.min(MAX_NARRATIVE, narrativeReserve);
    narrativeReserve -= reservedNarrativeLength;
    return {
      key: definition.key,
      title: definition.title,
      state: "available",
      classification: null,
      narrative:
        reservedNarrativeLength === 0
          ? null
          : "x".repeat(reservedNarrativeLength),
      unavailableReason: null,
      facts,
      calculations,
    };
  });
  try {
    calculationInputHash("scouting-report-draft-v1", {
      schemaId: "find-the-edge.scouting-report-draft",
      schemaVersion: "1.0.0",
      reportSchema: { id: contract.schemaId, version: contract.schemaVersion },
      event: {
        canonicalEventId: options.scoutingInput.event.canonicalEventId,
        canonicalEventVersion: String(
          options.scoutingInput.event.canonicalEventVersion,
        ),
      },
      sport: {
        key: options.module.key,
        moduleVersion: options.module.metadata.version,
      },
      strategy: { id: options.strategy.id, version: options.strategy.version },
      scoutingInput: {
        schemaId: options.scoutingInput.schemaId,
        schemaVersion: options.scoutingInput.schemaVersion,
        manifestHash: options.scoutingInput.manifestHash,
        inputHash: options.scoutingInput.inputHash,
      },
      instructionBundle: {
        id: modelRequest.identities.promptBundleId,
        version: modelRequest.identities.promptBundleVersion,
        requestHash: modelRequest.requestHash,
        calculationManifestHash:
          modelRequest.identities.calculationManifestHash,
      },
      model: {
        providerId: options.expectedModel.providerId,
        modelId: options.expectedModel.modelId,
        modelVersion: options.expectedModel.modelVersion,
        deploymentId: "x".repeat(256),
      },
      disposition: disposition(references),
      sections,
    });
  } catch {
    fail("INVALID_CONTEXT");
  }
}

export function validateScoutingReportDraft(
  result: ReportModelResult,
  options: ValidateScoutingReportOptions,
): Readonly<CanonicalScoutingReport> {
  const context = validateContext(result, options);
  const draft = parseDraft(context.result.output);
  const contract = options.module.scoutingReportContract;
  if (
    draft.schemaId !== contract.schemaId ||
    draft.schemaVersion !== contract.schemaVersion
  ) {
    fail("INVALID_DRAFT");
  }
  const sectionIndexes = new Map(
    contract.sections.map((section, index) => [section.key, index]),
  );
  const supplied = new Map<string, ParsedSection>();
  let priorIndex = -1;
  for (const section of draft.sections) {
    const index = sectionIndexes.get(section.key);
    if (index === undefined || supplied.has(section.key) || index <= priorIndex)
      fail("INVALID_DRAFT");
    supplied.set(section.key, section);
    priorIndex = index;
  }
  const facts = new Map(
    options.scoutingInput.facts.map((fact) => [fact.id, fact]),
  );
  const calculations = new Map(
    context.calculationReferences.map((reference) => [reference.id, reference]),
  );
  const sections = contract.sections.map(
    (definition): CanonicalScoutingReportSection => {
      const modelSection = supplied.get(definition.key);
      if (definition.availability === "unavailable-only") {
        if (modelSection) fail("UNSUPPORTED_CITATION");
        return {
          key: definition.key,
          title: definition.title,
          state: "unavailable",
          classification: null,
          narrative: null,
          unavailableReason: "module-section-unavailable",
          facts: [],
          calculations: [],
        };
      }
      if (
        definition.content === "deterministic" &&
        (modelSection?.narrative || modelSection?.classification)
      )
        fail("FORGED_AUTHORITY");
      const factIds = modelSection?.factCitations ?? [];
      const suppliedCalculationIds = modelSection?.calculationCitations ?? [];
      for (const id of suppliedCalculationIds) {
        const reference = calculations.get(id);
        if (
          !reference ||
          !definition.allowedCalculationKinds.includes(reference.kind)
        ) {
          fail("UNSUPPORTED_CITATION");
        }
      }
      const calculationIds =
        definition.content === "deterministic"
          ? deterministicSectionReferences(
              definition,
              context.calculationReferences,
            ).map(({ id }) => id)
          : suppliedCalculationIds;
      const citedFacts = factIds.map((id) => {
        const fact = facts.get(id);
        if (
          !fact ||
          !definition.allowedFactCategories.includes(fact.capabilityKey)
        )
          fail("UNSUPPORTED_CITATION");
        return fact;
      });
      const citedCalculations = calculationIds.map((id) => {
        const reference = calculations.get(id);
        if (
          !reference ||
          !definition.allowedCalculationKinds.includes(reference.kind)
        )
          fail("UNSUPPORTED_CITATION");
        return reference;
      });
      const usableFacts = citedFacts.filter(
        (fact) => fact.state !== "unavailable",
      );
      const usableCalculations = citedCalculations.filter(
        usableCalculationReference,
      );
      const usable = usableFacts.length + usableCalculations.length;
      if (modelSection?.narrative && usable === 0) fail("UNSUPPORTED_CITATION");
      const degraded =
        citedFacts.some(
          (fact) =>
            fact.state !== "verified" || fact.freshness.status !== "current",
        ) ||
        citedCalculations.some(
          (reference) => !usableCalculationReference(reference),
        );
      const state: ScoutingReportSectionState =
        usable === 0 ? "unavailable" : degraded ? "partial" : "available";
      return {
        key: definition.key,
        title: definition.title,
        state,
        classification:
          state === "unavailable"
            ? null
            : (modelSection?.classification ?? null),
        narrative:
          state === "unavailable" || definition.content === "deterministic"
            ? null
            : (modelSection?.narrative ?? null),
        unavailableReason:
          state !== "unavailable"
            ? null
            : modelSection === undefined &&
                definition.content !== "deterministic"
              ? "model-section-omitted"
              : "evidence-unavailable",
        facts: citedFacts,
        calculations: citedCalculations,
      };
    },
  );
  const dispositionValue = disposition(context.calculationReferences);
  const material = {
    schemaId: "find-the-edge.scouting-report-draft" as const,
    schemaVersion: "1.0.0" as const,
    reportSchema: { id: contract.schemaId, version: contract.schemaVersion },
    event: {
      canonicalEventId: options.scoutingInput.event.canonicalEventId,
      canonicalEventVersion: String(
        options.scoutingInput.event.canonicalEventVersion,
      ),
    },
    sport: {
      key: options.module.key,
      moduleVersion: options.module.metadata.version,
    },
    strategy: { id: options.strategy.id, version: options.strategy.version },
    scoutingInput: {
      schemaId: options.scoutingInput.schemaId,
      schemaVersion: options.scoutingInput.schemaVersion,
      manifestHash: options.scoutingInput.manifestHash,
      inputHash: options.scoutingInput.inputHash,
    },
    instructionBundle: {
      id: context.modelRequest.identities.promptBundleId,
      version: context.modelRequest.identities.promptBundleVersion,
      requestHash: context.modelRequest.requestHash,
      calculationManifestHash:
        context.modelRequest.identities.calculationManifestHash,
    },
    model: context.result.metadata,
    disposition: dispositionValue,
    sections,
  };
  const hashMaterial = {
    ...material,
    model: {
      providerId: material.model.providerId,
      modelId: material.model.modelId,
      modelVersion: material.model.modelVersion,
      deploymentId: material.model.deploymentId,
    },
  };
  let draftHash: string;
  try {
    draftHash = calculationInputHash("scouting-report-draft-v1", hashMaterial);
  } catch {
    return fail("INVALID_DRAFT");
  }
  return deepFreeze({
    ...material,
    draftHash,
  });
}

export const validateScoutingReport = validateScoutingReportDraft;

export interface GenerateValidatedScoutingReportOptions extends ValidateScoutingReportOptions {
  readonly provider: ReportModelPort;
  readonly telemetry?: ScoutingReportTelemetry;
  readonly signal?: AbortSignal;
}

function safeTelemetry(
  telemetry: ScoutingReportTelemetry | undefined,
  event: ScoutingReportTelemetryEvent,
): void {
  try {
    telemetry?.(deepFreeze(event));
  } catch {
    // Telemetry is observational and cannot change validation behavior.
  }
}

function providerReasonCode(
  code: ReportModelProviderError["code"],
):
  | "PROVIDER_DISABLED"
  | "PROVIDER_ABORTED"
  | "PROVIDER_FAILED"
  | "PROVIDER_INVALID_RESULT" {
  switch (code) {
    case "DISABLED":
      return "PROVIDER_DISABLED";
    case "ABORTED":
      return "PROVIDER_ABORTED";
    case "INVALID_RESULT":
      return "PROVIDER_INVALID_RESULT";
    case "FAILED":
      return "PROVIDER_FAILED";
  }
}

async function generateWithAbort(
  provider: ReportModelPort,
  request: ReportModelRequest,
  signal: AbortSignal | undefined,
): Promise<ReportModelResult> {
  if (signal?.aborted) throw new ReportModelProviderError("ABORTED", false);
  const generated = Promise.resolve().then(() =>
    provider.generate(request, signal === undefined ? undefined : { signal }),
  );
  if (signal === undefined) return await generated;
  let removeListener = (): void => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void =>
      reject(new ReportModelProviderError("ABORTED", false));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    const result = await Promise.race([generated, abort]);
    if (signal.aborted) throw new ReportModelProviderError("ABORTED", false);
    return result;
  } finally {
    removeListener();
  }
}

export async function generateValidatedScoutingReport(
  options: GenerateValidatedScoutingReportOptions,
): Promise<Readonly<CanonicalScoutingReport>> {
  validateExpectedModelIdentity(options.expectedModel);
  const references = normalizeReferences(options.calculationReferences);
  const modelRequest = validateModelRequest(options, references);
  assertReportHashCapacity(options, references, modelRequest);
  safeTelemetry(options.telemetry, {
    type: "scouting-report.started",
    schemaVersion: options.module.scoutingReportContract.schemaVersion,
    requestHash: modelRequest.requestHash,
    inputHash: options.scoutingInput.inputHash,
    calculationManifestHash: modelRequest.identities.calculationManifestHash,
  });
  try {
    const providerResult = await generateWithAbort(
      options.provider,
      modelRequest,
      options.signal,
    );
    const result = normalizeModelResult(providerResult);
    const report = validateScoutingReportDraft(result, {
      ...options,
      modelRequest,
      calculationReferences: references,
    });
    safeTelemetry(options.telemetry, {
      type: "scouting-report.succeeded",
      schemaVersion: report.schemaVersion,
      requestHash: modelRequest.requestHash,
      draftHash: report.draftHash,
      sectionCount: report.sections.length,
      factCitationCount: report.sections.reduce(
        (total, section) => total + section.facts.length,
        0,
      ),
      calculationCitationCount: report.sections.reduce(
        (total, section) => total + section.calculations.length,
        0,
      ),
      inputUnits: result.metadata.usage.inputUnits,
      outputUnits: result.metadata.usage.outputUnits,
      totalUnits: result.metadata.usage.totalUnits,
      latencyMilliseconds: result.metadata.latencyMilliseconds,
      validationOutcome: "accepted",
    });
    return report;
  } catch (error) {
    const normalizedError =
      error instanceof ScoutingReportValidationError ||
      error instanceof ReportModelProviderError
        ? error
        : options.signal?.aborted ||
            (error instanceof Error && error.name === "AbortError")
          ? new ReportModelProviderError("ABORTED", false)
          : new ReportModelProviderError("INVALID_RESULT", false);
    const reasonCode =
      normalizedError instanceof ScoutingReportValidationError
        ? normalizedError.code
        : normalizedError instanceof ReportModelProviderError
          ? providerReasonCode(normalizedError.code)
          : "PROVIDER_FAILED";
    safeTelemetry(options.telemetry, {
      type: "scouting-report.failed",
      schemaVersion: options.module.scoutingReportContract.schemaVersion,
      requestHash: modelRequest.requestHash,
      reasonCode,
      validationOutcome: "rejected",
    });
    throw normalizedError;
  }
}
