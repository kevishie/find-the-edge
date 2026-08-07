import {
  calculationInputHash,
  canonicalCalculationJson,
  type SportKey,
} from "@find-the-edge/domain";
import {
  scoutingCapabilityInstances,
  type SportModule,
  type SportScoutingCapabilitySchema,
  type SportScoutingFactSchema,
  type SportScoutingFactValidationContext,
} from "@find-the-edge/sports";

export type ScoutingEvidenceState =
  "verified" | "inferred" | "stale" | "conflicting" | "unavailable";

export interface CanonicalScoutingEvent {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly participantIds: readonly string[];
}

export interface ScoutingInputSourceAuthorization {
  readonly id: string;
  readonly providerId: string;
  readonly maturity: "development" | "production";
  readonly productionEligible: boolean;
  readonly sourceKind: "synthetic-fixture" | "provider";
  readonly sportKey: SportKey;
  readonly competitionKeys: readonly string[];
  readonly capabilities: readonly string[];
  readonly evidenceReferencePrefixes: readonly string[];
}

export interface ValidateScoutingInputOptions {
  readonly canonicalEvent: CanonicalScoutingEvent;
  readonly evaluatedAt: string;
  readonly environment: "development" | "test" | "production";
  readonly module: SportModule;
  readonly sourceAuthorization: ScoutingInputSourceAuthorization;
}

export type ScoutingInputErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "INVALID_REFERENCE"
  | "UNAUTHORIZED_SOURCE"
  | "CONTRADICTORY_REVISION";

export class ScoutingInputValidationError extends Error {
  constructor(
    readonly code: ScoutingInputErrorCode,
    message: string,
  ) {
    super(`Scouting input ${code.toLowerCase()}: ${message}`);
    this.name = "ScoutingInputValidationError";
  }
}

interface RawCoverage {
  capabilityKey: string;
  subjectId?: string;
  status: "available" | "partial" | "unavailable";
  unavailableReason?: string;
  observationIds: string[];
}

interface RawEvidenceReference {
  kind: "synthetic-fixture" | "retained-reference";
  reference: string;
  contentHash?: string;
}

interface RawObservation {
  id: string;
  capabilityKey: string;
  subjectId?: string;
  providerId: string;
  providerEntityType?: string;
  providerEntityId?: string;
  providerTimestamp?: string;
  collectedAt: string;
  evidenceReference: RawEvidenceReference;
  revision: {
    providerRevision?: string;
    providerOrdinal?: number;
    collectorSequence?: number;
  };
  supersedesObservationId?: string;
}

interface ConflictAlternative {
  value: unknown;
  observationIds: string[];
}

interface RawFact {
  id: string;
  capabilityKey: string;
  schemaKey: string;
  schemaVariant?: string;
  subjectId?: string;
  state: ScoutingEvidenceState;
  value?: unknown;
  observationIds: string[];
  basisFactIds?: string[];
  conflict?: { alternatives: ConflictAlternative[] };
  unavailableReason?: string;
  observedAt?: string;
  confidence: number;
}

interface SafeEnvelope {
  schemaId: "find-the-edge.scouting-input";
  schemaVersion: "1.0.0";
  moduleSchema: { id: string; version: string };
  event: CanonicalScoutingEvent;
  coverage: RawCoverage[];
  observations: RawObservation[];
  facts: RawFact[];
}

export interface NormalizedScoutingObservation extends RawObservation {
  readonly quarantined: boolean;
}

export interface NormalizedScoutingFact extends RawFact {
  readonly freshness: Readonly<{
    status: "current" | "stale" | "unavailable";
    originAt?: string;
    ageMilliseconds?: number;
  }>;
  readonly provenance: readonly NormalizedScoutingObservation[];
}

export interface NormalizedScoutingInput {
  readonly schemaId: "find-the-edge.scouting-input";
  readonly schemaVersion: "1.0.0";
  readonly moduleSchema: Readonly<{ id: string; version: string }>;
  readonly manifestHash: string;
  readonly event: CanonicalScoutingEvent;
  readonly coverage: readonly RawCoverage[];
  readonly observations: readonly NormalizedScoutingObservation[];
  readonly facts: readonly NormalizedScoutingFact[];
  readonly evaluatedAt: string;
  readonly source: ScoutingInputSourceAuthorization;
  readonly inputHash: string;
}

type UnknownRecord = Record<string, unknown>;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ITEMS = 256;

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index])
      return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function fail(code: ScoutingInputErrorCode, message: string): never {
  throw new ScoutingInputValidationError(code, message);
}

function clonePlain(
  input: unknown,
  seen = new Set<object>(),
  depth = 0,
  nodes = { count: 0 },
): unknown {
  nodes.count += 1;
  if (nodes.count > 4_096 || depth > 32)
    return fail("INVALID_INPUT", "payload exceeds size limits");
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input))
      return fail("INVALID_INPUT", "payload numbers must be finite");
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object" || seen.has(input))
    return fail("INVALID_INPUT", "payload must be acyclic plain data");
  seen.add(input);
  try {
    const prototype = Reflect.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (input.length > MAX_ITEMS)
        return fail("INVALID_INPUT", "payload exceeds size limits");
      if (prototype !== Array.prototype)
        return fail(
          "INVALID_INPUT",
          "payload arrays require the standard prototype",
        );
      const allowedKeys = new Set([
        "length",
        ...Array.from({ length: input.length }, (_, index) => String(index)),
      ]);
      if (
        Reflect.ownKeys(input).some(
          (key) => typeof key !== "string" || !allowedKeys.has(key),
        )
      )
        return fail(
          "INVALID_INPUT",
          "payload arrays contain unsupported fields",
        );
      const result: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          input,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor))
          return fail(
            "INVALID_INPUT",
            "payload arrays require enumerable index data fields",
          );
        result.push(clonePlain(descriptor.value, seen, depth + 1, nodes));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null)
      return fail("INVALID_INPUT", "payload must use plain objects");
    const keys = Reflect.ownKeys(input);
    if (keys.length > 256)
      return fail("INVALID_INPUT", "payload exceeds size limits");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor"
      )
        return fail("INVALID_INPUT", "payload contains an unsafe field");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        return fail("INVALID_INPUT", "payload requires enumerable data fields");
      result[key] = clonePlain(descriptor.value, seen, depth + 1, nodes);
    }
    return result;
  } catch (error) {
    if (error instanceof ScoutingInputValidationError) throw error;
    return fail("INVALID_INPUT", "payload must be bounded plain JSON");
  } finally {
    seen.delete(input);
  }
}

function safeCanonical(input: unknown): string {
  return canonicalCalculationJson(clonePlain(input));
}

function safeClone(input: unknown): unknown {
  try {
    const cloned = clonePlain(input);
    canonicalCalculationJson(cloned);
    return cloned;
  } catch {
    return fail("INVALID_INPUT", "payload must be bounded plain JSON");
  }
}

function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_INPUT", `${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exact(
  value: UnknownRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalCalculationJson(actual) !== canonicalCalculationJson(expected)) {
    fail("INVALID_INPUT", `${label} has unknown or missing fields`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return fail("INVALID_INPUT", `${label} is not canonical`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    return fail("INVALID_INPUT", `${label} must be trimmed nonblank text`);
  }
  return value;
}

function opaqueText(value: unknown, label: string, maximum = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    return fail("INVALID_INPUT", `${label} must be bounded nonblank text`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  const result = text(value, label, 64);
  const timestamp = Date.parse(result);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== result
  ) {
    return fail("INVALID_INPUT", `${label} must be a canonical timestamp`);
  }
  return result;
}

function stringArray(
  value: unknown,
  label: string,
  allowEmpty = false,
  setLike = false,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    return fail("INVALID_INPUT", `${label} must be a bounded array`);
  }
  const result = value.map((item, index) =>
    identifier(item, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length)
    fail("INVALID_INPUT", `${label} must be unique`);
  return setLike ? result.sort(compareUtf8) : result;
}

function optionalKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    fail("INVALID_INPUT", `${label} has unknown or missing fields`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseEvent(value: unknown): CanonicalScoutingEvent {
  const input = record(value, "event");
  exact(
    input,
    [
      "canonicalEventId",
      "canonicalEventVersion",
      "sportKey",
      "leagueKey",
      "startsAt",
      "participantIds",
    ],
    "event",
  );
  return {
    canonicalEventId: identifier(
      input["canonicalEventId"],
      "event.canonicalEventId",
    ),
    canonicalEventVersion: identifier(
      input["canonicalEventVersion"],
      "event.canonicalEventVersion",
    ),
    sportKey: identifier(input["sportKey"], "event.sportKey") as SportKey,
    leagueKey: identifier(input["leagueKey"], "event.leagueKey"),
    startsAt: instant(input["startsAt"], "event.startsAt"),
    participantIds: stringArray(
      input["participantIds"],
      "event.participantIds",
    ),
  };
}

function parseReference(value: unknown, label: string): RawEvidenceReference {
  const input = record(value, label);
  optionalKeys(input, ["kind", "reference"], ["contentHash"], label);
  const kind = input["kind"];
  if (kind !== "synthetic-fixture" && kind !== "retained-reference")
    fail("INVALID_INPUT", `${label}.kind is invalid`);
  const reference = text(input["reference"], `${label}.reference`, 2_048);
  const contentHash = input["contentHash"];
  if (kind === "synthetic-fixture") {
    if (
      !reference.startsWith("synthetic://") ||
      reference.length === "synthetic://".length ||
      contentHash !== undefined
    )
      fail(
        "INVALID_REFERENCE",
        "synthetic references must use synthetic:// and no content hash",
      );
    return { kind, reference };
  }
  if (
    typeof contentHash !== "string" ||
    !HASH.test(contentHash) ||
    !["s3://", "retained://", "sha256://"].some((scheme) =>
      reference.startsWith(scheme),
    )
  ) {
    return fail(
      "INVALID_REFERENCE",
      "retained references require immutable content hashes",
    );
  }
  if (
    (reference.startsWith("s3://") || reference.startsWith("retained://")) &&
    reference.slice(reference.lastIndexOf("/") + 1) !== contentHash
  ) {
    return fail(
      "INVALID_REFERENCE",
      "retained reference key must end with its content hash",
    );
  }
  if (
    reference.startsWith("sha256://") &&
    reference !== `sha256://${contentHash}`
  ) {
    return fail(
      "INVALID_REFERENCE",
      "sha256 retained reference must match its content hash",
    );
  }
  return { kind, reference, contentHash };
}

function parseObservation(value: unknown, index: number): RawObservation {
  const label = `observations[${index}]`;
  const input = record(value, label);
  optionalKeys(
    input,
    [
      "id",
      "capabilityKey",
      "providerId",
      "collectedAt",
      "evidenceReference",
      "revision",
    ],
    [
      "subjectId",
      "providerEntityType",
      "providerEntityId",
      "providerTimestamp",
      "supersedesObservationId",
    ],
    label,
  );
  const revisionInput = record(input["revision"], `${label}.revision`);
  optionalKeys(
    revisionInput,
    [],
    ["providerRevision", "providerOrdinal", "collectorSequence"],
    `${label}.revision`,
  );
  const providerRevision =
    revisionInput["providerRevision"] === undefined
      ? undefined
      : opaqueText(
          revisionInput["providerRevision"],
          `${label}.revision.providerRevision`,
        );
  const providerOrdinal = revisionInput["providerOrdinal"];
  const collectorSequence = revisionInput["collectorSequence"];
  for (const [name, value] of [
    ["providerOrdinal", providerOrdinal],
    ["collectorSequence", collectorSequence],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    ) {
      fail("INVALID_INPUT", `${label}.revision.${name} is invalid`);
    }
  }
  if ((providerRevision === undefined) !== (providerOrdinal === undefined))
    fail(
      "INVALID_INPUT",
      `${label}.revision provider revision and ordinal must be paired`,
    );
  if (providerOrdinal === undefined && collectorSequence === undefined)
    fail("INVALID_INPUT", `${label}.revision requires monotonic ordering`);
  const normalizedProviderOrdinal = providerOrdinal as number | undefined;
  const normalizedCollectorSequence = collectorSequence as number | undefined;
  if (
    (input["providerEntityType"] === undefined) !==
    (input["providerEntityId"] === undefined)
  ) {
    fail(
      "INVALID_INPUT",
      `${label} provider entity type and id must be paired`,
    );
  }
  return {
    id: identifier(input["id"], `${label}.id`),
    capabilityKey: identifier(input["capabilityKey"], `${label}.capabilityKey`),
    ...(input["subjectId"] === undefined
      ? {}
      : { subjectId: identifier(input["subjectId"], `${label}.subjectId`) }),
    providerId: identifier(input["providerId"], `${label}.providerId`),
    ...(input["providerEntityType"] === undefined
      ? {}
      : {
          providerEntityType: identifier(
            input["providerEntityType"],
            `${label}.providerEntityType`,
          ),
        }),
    ...(input["providerEntityId"] === undefined
      ? {}
      : {
          providerEntityId: opaqueText(
            input["providerEntityId"],
            `${label}.providerEntityId`,
          ),
        }),
    ...(input["providerTimestamp"] === undefined
      ? {}
      : {
          providerTimestamp: instant(
            input["providerTimestamp"],
            `${label}.providerTimestamp`,
          ),
        }),
    collectedAt: instant(input["collectedAt"], `${label}.collectedAt`),
    evidenceReference: parseReference(
      input["evidenceReference"],
      `${label}.evidenceReference`,
    ),
    revision: {
      ...(providerRevision === undefined ? {} : { providerRevision }),
      ...(normalizedProviderOrdinal === undefined
        ? {}
        : { providerOrdinal: normalizedProviderOrdinal }),
      ...(normalizedCollectorSequence === undefined
        ? {}
        : { collectorSequence: normalizedCollectorSequence }),
    },
    ...(input["supersedesObservationId"] === undefined
      ? {}
      : {
          supersedesObservationId: identifier(
            input["supersedesObservationId"],
            `${label}.supersedesObservationId`,
          ),
        }),
  };
}

function parseCoverage(value: unknown, index: number): RawCoverage {
  const label = `coverage[${index}]`;
  const input = record(value, label);
  optionalKeys(
    input,
    ["capabilityKey", "status", "observationIds"],
    ["subjectId", "unavailableReason"],
    label,
  );
  const status = input["status"];
  if (
    status !== "available" &&
    status !== "partial" &&
    status !== "unavailable"
  )
    fail("INVALID_INPUT", `${label}.status is invalid`);
  const unavailableReason = input["unavailableReason"];
  if ((status === "unavailable") !== (unavailableReason !== undefined))
    fail("INVALID_STATE", `${label} reason does not match status`);
  return {
    capabilityKey: identifier(input["capabilityKey"], `${label}.capabilityKey`),
    ...(input["subjectId"] === undefined
      ? {}
      : { subjectId: identifier(input["subjectId"], `${label}.subjectId`) }),
    status,
    ...(unavailableReason === undefined
      ? {}
      : {
          unavailableReason: text(
            unavailableReason,
            `${label}.unavailableReason`,
          ),
        }),
    observationIds: stringArray(
      input["observationIds"],
      `${label}.observationIds`,
      false,
      true,
    ),
  };
}

function parseFact(value: unknown, index: number): RawFact {
  const label = `facts[${index}]`;
  const input = record(value, label);
  optionalKeys(
    input,
    [
      "id",
      "capabilityKey",
      "schemaKey",
      "state",
      "observationIds",
      "confidence",
    ],
    [
      "schemaVariant",
      "subjectId",
      "value",
      "basisFactIds",
      "conflict",
      "unavailableReason",
      "observedAt",
    ],
    label,
  );
  const state = input["state"];
  if (
    !["verified", "inferred", "stale", "conflicting", "unavailable"].includes(
      String(state),
    )
  )
    fail("INVALID_INPUT", `${label}.state is invalid`);
  const confidence = input["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  )
    fail("INVALID_INPUT", `${label}.confidence is invalid`);
  let conflict: RawFact["conflict"];
  if (input["conflict"] !== undefined) {
    const conflictInput = record(input["conflict"], `${label}.conflict`);
    exact(conflictInput, ["alternatives"], `${label}.conflict`);
    if (
      !Array.isArray(conflictInput["alternatives"]) ||
      conflictInput["alternatives"].length < 2 ||
      conflictInput["alternatives"].length > 32
    )
      fail("INVALID_INPUT", `${label}.conflict.alternatives is invalid`);
    const alternatives = conflictInput["alternatives"].map(
      (item, alternativeIndex) => {
        const alternative = record(
          item,
          `${label}.conflict.alternatives[${alternativeIndex}]`,
        );
        exact(
          alternative,
          ["value", "observationIds"],
          `${label}.conflict.alternatives[${alternativeIndex}]`,
        );
        return {
          value: alternative["value"],
          observationIds: stringArray(
            alternative["observationIds"],
            `${label}.conflict.alternatives[${alternativeIndex}].observationIds`,
            false,
            true,
          ),
        };
      },
    );
    conflict = { alternatives };
  }
  return {
    id: identifier(input["id"], `${label}.id`),
    capabilityKey: identifier(input["capabilityKey"], `${label}.capabilityKey`),
    schemaKey: identifier(input["schemaKey"], `${label}.schemaKey`),
    ...(input["schemaVariant"] === undefined
      ? {}
      : {
          schemaVariant: identifier(
            input["schemaVariant"],
            `${label}.schemaVariant`,
          ),
        }),
    ...(input["subjectId"] === undefined
      ? {}
      : { subjectId: identifier(input["subjectId"], `${label}.subjectId`) }),
    state: state as ScoutingEvidenceState,
    ...(Object.hasOwn(input, "value") ? { value: input["value"] } : {}),
    observationIds: stringArray(
      input["observationIds"],
      `${label}.observationIds`,
      false,
      true,
    ),
    ...(input["basisFactIds"] === undefined
      ? {}
      : {
          basisFactIds: stringArray(
            input["basisFactIds"],
            `${label}.basisFactIds`,
            false,
            true,
          ),
        }),
    ...(conflict === undefined ? {} : { conflict }),
    ...(input["unavailableReason"] === undefined
      ? {}
      : {
          unavailableReason: text(
            input["unavailableReason"],
            `${label}.unavailableReason`,
          ),
        }),
    ...(input["observedAt"] === undefined
      ? {}
      : { observedAt: instant(input["observedAt"], `${label}.observedAt`) }),
    confidence,
  };
}

function parseEnvelope(input: unknown): SafeEnvelope {
  const root = record(safeClone(input), "input");
  exact(
    root,
    [
      "schemaId",
      "schemaVersion",
      "moduleSchema",
      "event",
      "coverage",
      "observations",
      "facts",
    ],
    "input",
  );
  if (
    root["schemaId"] !== "find-the-edge.scouting-input" ||
    root["schemaVersion"] !== "1.0.0"
  )
    fail("INVALID_INPUT", "unsupported envelope schema");
  const moduleSchema = record(root["moduleSchema"], "moduleSchema");
  exact(moduleSchema, ["id", "version"], "moduleSchema");
  for (const field of ["coverage", "observations", "facts"] as const) {
    if (
      !Array.isArray(root[field]) ||
      root[field].length === 0 ||
      root[field].length > MAX_ITEMS
    )
      fail("INVALID_INPUT", `${field} must be a nonempty bounded array`);
  }
  return {
    schemaId: "find-the-edge.scouting-input",
    schemaVersion: "1.0.0",
    moduleSchema: {
      id: identifier(moduleSchema["id"], "moduleSchema.id"),
      version: identifier(moduleSchema["version"], "moduleSchema.version"),
    },
    event: parseEvent(root["event"]),
    coverage: (root["coverage"] as unknown[]).map(parseCoverage),
    observations: (root["observations"] as unknown[]).map(parseObservation),
    facts: (root["facts"] as unknown[]).map(parseFact),
  };
}

function same(left: unknown, right: unknown): boolean {
  return safeCanonical(left) === safeCanonical(right);
}

function instanceKey(capabilityKey: string, subjectId?: string): string {
  return `${capabilityKey}\u0000${subjectId ?? ""}`;
}

function authorize(
  envelope: SafeEnvelope,
  options: ValidateScoutingInputOptions,
): void {
  const { module, canonicalEvent, sourceAuthorization: source } = options;
  instant(options.evaluatedAt, "evaluatedAt");
  if (
    options.environment !== "development" &&
    options.environment !== "test" &&
    options.environment !== "production"
  ) {
    fail("UNAUTHORIZED_SOURCE", "runtime environment is invalid");
  }
  if (
    module.key !== module.scoutingInputContract.sportKey ||
    envelope.event.sportKey !== module.key ||
    !module.metadata.supportedLeagues.includes(envelope.event.leagueKey)
  )
    fail("INVALID_REFERENCE", "event is not owned by the trusted sport module");
  if (
    envelope.moduleSchema.id !== module.scoutingInputContract.schemaId ||
    envelope.moduleSchema.version !== module.scoutingInputContract.schemaVersion
  )
    fail("INVALID_REFERENCE", "module schema does not match trusted module");
  if (!same(envelope.event, canonicalEvent))
    fail("INVALID_REFERENCE", "event does not match trusted canonical event");
  if (
    source.sportKey !== module.key ||
    !source.competitionKeys.includes(envelope.event.leagueKey)
  )
    fail(
      "UNAUTHORIZED_SOURCE",
      "source is not authorized for this competition",
    );
  if ((source.maturity === "production") !== source.productionEligible)
    fail("UNAUTHORIZED_SOURCE", "source maturity and eligibility disagree");
  if (
    source.sourceKind === "synthetic-fixture" &&
    (source.maturity !== "development" ||
      source.productionEligible ||
      (options.environment !== "development" && options.environment !== "test"))
  )
    fail("UNAUTHORIZED_SOURCE", "synthetic evidence is development-only");
  if (
    options.environment === "production" &&
    (source.sourceKind !== "provider" || !source.productionEligible)
  )
    fail("UNAUTHORIZED_SOURCE", "production requires an eligible provider");
  for (const observation of envelope.observations) {
    if (observation.providerId !== source.providerId)
      fail("UNAUTHORIZED_SOURCE", "observation provider is not authorized");
    const expectedKind =
      source.sourceKind === "synthetic-fixture"
        ? "synthetic-fixture"
        : "retained-reference";
    if (observation.evidenceReference.kind !== expectedKind)
      fail(
        "UNAUTHORIZED_SOURCE",
        "observation reference kind does not match source",
      );
    if (
      !source.evidenceReferencePrefixes.some((prefix) =>
        observation.evidenceReference.reference.startsWith(prefix),
      )
    ) {
      fail(
        "UNAUTHORIZED_SOURCE",
        "observation reference is not authorized for its source",
      );
    }
  }
}

function normalizeSourceAuthorization(
  value: ScoutingInputSourceAuthorization,
): ScoutingInputSourceAuthorization {
  const input = record(safeClone(value), "sourceAuthorization");
  const maturity = input["maturity"];
  const productionEligible = input["productionEligible"];
  const sourceKind = input["sourceKind"];
  if (
    (maturity !== "development" && maturity !== "production") ||
    typeof productionEligible !== "boolean" ||
    (sourceKind !== "synthetic-fixture" && sourceKind !== "provider")
  ) {
    return fail(
      "UNAUTHORIZED_SOURCE",
      "trusted source authorization is invalid",
    );
  }
  if (
    !Array.isArray(input["evidenceReferencePrefixes"]) ||
    input["evidenceReferencePrefixes"].length === 0 ||
    input["evidenceReferencePrefixes"].length > 16
  ) {
    return fail(
      "UNAUTHORIZED_SOURCE",
      "trusted evidence reference authorization is invalid",
    );
  }
  const evidenceReferencePrefixes = input["evidenceReferencePrefixes"].map(
    (item, index) => {
      const prefix = text(
        item,
        `sourceAuthorization.evidenceReferencePrefixes[${index}]`,
        1_024,
      );
      const valid =
        sourceKind === "synthetic-fixture"
          ? prefix.startsWith("synthetic://") &&
            prefix.length > "synthetic://".length &&
            prefix.endsWith("/")
          : (prefix.startsWith("s3://") &&
              prefix.length > "s3://".length &&
              prefix.endsWith("/")) ||
            (prefix.startsWith("retained://") &&
              prefix.length > "retained://".length &&
              prefix.endsWith("/")) ||
            prefix === "sha256://";
      if (!valid)
        fail(
          "UNAUTHORIZED_SOURCE",
          "trusted evidence reference authorization is invalid",
        );
      return prefix;
    },
  );
  if (
    new Set(evidenceReferencePrefixes).size !== evidenceReferencePrefixes.length
  )
    fail(
      "UNAUTHORIZED_SOURCE",
      "trusted evidence reference authorization must be unique",
    );
  return {
    id: identifier(input["id"], "sourceAuthorization.id"),
    providerId: identifier(
      input["providerId"],
      "sourceAuthorization.providerId",
    ),
    maturity,
    productionEligible,
    sourceKind,
    sportKey: identifier(
      input["sportKey"],
      "sourceAuthorization.sportKey",
    ) as SportKey,
    competitionKeys: stringArray(
      input["competitionKeys"],
      "sourceAuthorization.competitionKeys",
      false,
      true,
    ),
    capabilities: stringArray(
      input["capabilities"],
      "sourceAuthorization.capabilities",
      false,
      true,
    ),
    evidenceReferencePrefixes: evidenceReferencePrefixes.sort(compareUtf8),
  };
}

function schemaFor(
  capability: SportScoutingCapabilitySchema,
  fact: RawFact,
): SportScoutingFactSchema {
  const schema = capability.facts.find(
    (candidate) =>
      candidate.key === fact.schemaKey &&
      candidate.variant === fact.schemaVariant,
  );
  if (!schema)
    return fail(
      "INVALID_REFERENCE",
      "fact schema is not declared by the module",
    );
  return schema;
}

function validateFactShape(
  fact: RawFact,
  schema: SportScoutingFactSchema,
  context: SportScoutingFactValidationContext,
): void {
  const hasValue = Object.hasOwn(fact, "value");
  const hasBasis = fact.basisFactIds !== undefined;
  const hasConflict = fact.conflict !== undefined;
  const hasReason = fact.unavailableReason !== undefined;
  const hasObservedAt = fact.observedAt !== undefined;
  if (schema.subjectScope === "event" && fact.subjectId !== undefined)
    fail("INVALID_REFERENCE", "event fact cannot have a subject");
  if (schema.subjectScope !== "event" && fact.subjectId === undefined)
    fail("INVALID_REFERENCE", "scoped fact requires a subject");
  if (fact.state === "unavailable") {
    if (
      hasValue ||
      hasBasis ||
      hasConflict ||
      hasObservedAt ||
      !hasReason ||
      fact.confidence !== 0
    )
      fail("INVALID_STATE", "unavailable fact shape is invalid");
    return;
  }
  if (fact.state === "conflicting") {
    if (
      hasValue ||
      hasBasis ||
      hasReason ||
      hasObservedAt ||
      !hasConflict ||
      fact.confidence !== 0 ||
      fact.observationIds.length < 2
    )
      fail("INVALID_STATE", "conflicting fact shape is invalid");
    const alternativeObservations = fact.conflict!.alternatives.flatMap(
      (alternative) => alternative.observationIds,
    );
    if (
      new Set(alternativeObservations).size !==
        alternativeObservations.length ||
      !same(
        [...alternativeObservations].sort(),
        [...fact.observationIds].sort(),
      )
    )
      fail(
        "INVALID_STATE",
        "conflict alternatives must partition observations",
      );
    for (const alternative of fact.conflict!.alternatives)
      alternative.value = normalizedSportValue(
        schema,
        alternative.value,
        context,
        "conflict alternative violates sport schema",
      );
    const normalizedValues = fact.conflict!.alternatives.map((alternative) =>
      safeCanonical(alternative.value),
    );
    if (new Set(normalizedValues).size !== normalizedValues.length)
      fail("INVALID_STATE", "conflict alternatives must all differ");
    fact.conflict!.alternatives.sort((left, right) =>
      compareUtf8(safeCanonical(left), safeCanonical(right)),
    );
    return;
  }
  if (
    !hasValue ||
    hasConflict ||
    hasReason ||
    !hasObservedAt ||
    fact.confidence <= 0
  )
    fail("INVALID_STATE", `${fact.state} fact shape is invalid`);
  const value = fact.value;
  if (
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  )
    fail("INVALID_INPUT", "available fact value cannot be empty");
  fact.value = normalizedSportValue(
    schema,
    value,
    context,
    "fact value violates sport schema",
  );
  if (fact.state === "inferred") {
    if (!hasBasis || fact.confidence >= 1)
      fail(
        "INVALID_STATE",
        "inferred fact requires basis and reduced confidence",
      );
  } else if (hasBasis)
    fail("INVALID_STATE", "only inferred facts may have a basis");
  if (fact.state === "stale" && fact.confidence >= 1)
    fail("INVALID_STATE", "stale fact confidence must be reduced");
}

function normalizedSportValue(
  schema: SportScoutingFactSchema,
  value: unknown,
  context: SportScoutingFactValidationContext,
  invalidMessage: string,
): unknown {
  try {
    const result = schema.validateValue(value, context);
    if (result.valid !== true || !Object.hasOwn(result, "value"))
      return fail("INVALID_INPUT", invalidMessage);
    return safeClone(result.value);
  } catch (error) {
    if (error instanceof ScoutingInputValidationError) throw error;
    return fail("INVALID_INPUT", "sport fact validator failed safely");
  }
}

function validSportSubject(
  schema: SportScoutingFactSchema,
  subjectId: string,
  capabilitySubjectId: string | undefined,
  participantIds: readonly string[],
): boolean {
  if (schema.validateSubject === undefined) return false;
  try {
    return (
      schema.validateSubject({
        subjectId,
        ...(capabilitySubjectId === undefined ? {} : { capabilitySubjectId }),
        participantIds,
      }) === true
    );
  } catch {
    return fail("INVALID_INPUT", "sport subject validator failed safely");
  }
}

function observationStream(observation: RawObservation): string {
  return canonicalCalculationJson([
    observation.providerId,
    observation.capabilityKey,
    observation.subjectId ?? "",
    observation.providerEntityType ?? "",
    observation.providerEntityId ?? "",
  ]);
}

function revisionKey(observation: RawObservation): string {
  return observation.revision.providerOrdinal === undefined
    ? `collector:${observation.revision.collectorSequence}`
    : `provider:${observation.revision.providerOrdinal}`;
}

function revisionOrdinal(observation: RawObservation): number {
  return (
    observation.revision.providerOrdinal ??
    observation.revision.collectorSequence!
  );
}

function revisionMode(observation: RawObservation): "provider" | "collector" {
  return observation.revision.providerOrdinal === undefined
    ? "collector"
    : "provider";
}

function semanticObservationKey(observation: RawObservation): string {
  const providerOrdered = observation.revision.providerOrdinal !== undefined;
  return safeCanonical({
    stream: observationStream(observation),
    ...(observation.providerTimestamp === undefined
      ? {}
      : { providerTimestamp: observation.providerTimestamp }),
    evidence:
      observation.evidenceReference.contentHash ??
      observation.evidenceReference.reference,
    revision: providerOrdered
      ? {
          providerRevision: observation.revision.providerRevision,
          providerOrdinal: observation.revision.providerOrdinal,
        }
      : { collectorSequence: observation.revision.collectorSequence },
  });
}

function normalizeObservations(observations: RawObservation[]): {
  observations: NormalizedScoutingObservation[];
  byId: Map<string, NormalizedScoutingObservation>;
} {
  const byId = new Map<string, RawObservation>();
  for (const observation of observations) {
    const previous = byId.get(observation.id);
    if (previous && !same(previous, observation))
      fail(
        "CONTRADICTORY_REVISION",
        "observation id was reused with different content",
      );
    if (!previous) byId.set(observation.id, observation);
  }
  const unique = [...byId.values()];
  const providerRevisionOrdinals = new Map<string, number>();
  for (const observation of unique) {
    if (observation.revision.providerRevision === undefined) continue;
    const key = canonicalCalculationJson([
      observationStream(observation),
      observation.revision.providerRevision,
    ]);
    const previousOrdinal = providerRevisionOrdinals.get(key);
    if (
      previousOrdinal !== undefined &&
      previousOrdinal !== observation.revision.providerOrdinal
    ) {
      fail(
        "CONTRADICTORY_REVISION",
        "provider revision cannot map to multiple ordinals in one stream",
      );
    }
    providerRevisionOrdinals.set(key, observation.revision.providerOrdinal!);
  }
  const revisions = new Map<string, RawObservation[]>();
  for (const observation of unique) {
    const key = canonicalCalculationJson([
      observationStream(observation),
      revisionKey(observation),
    ]);
    revisions.set(key, [...(revisions.get(key) ?? []), observation]);
  }
  const quarantined = new Set<string>();
  for (const revision of revisions.values()) {
    const signatures = revision.map(semanticObservationKey);
    if (new Set(signatures).size > 1) {
      for (const item of revision) quarantined.add(item.id);
    }
  }
  for (const observation of unique) {
    if (!observation.supersedesObservationId) continue;
    const previous = byId.get(observation.supersedesObservationId);
    if (
      !previous ||
      observationStream(previous) !== observationStream(observation) ||
      revisionKey(previous) === revisionKey(observation)
    )
      fail("INVALID_REFERENCE", "invalid superseded observation");
    const currentMode = revisionMode(observation);
    const previousMode = revisionMode(previous);
    if (currentMode === "collector" && previousMode === "provider")
      fail(
        "INVALID_STATE",
        "revision ordering cannot return to collector mode",
      );
    if (
      currentMode === previousMode &&
      revisionOrdinal(observation) <= revisionOrdinal(previous)
    )
      fail("INVALID_STATE", "revision ordinal must increase");
  }
  const correctionTargets = new Set<string>();
  for (const observation of unique) {
    if (observation.supersedesObservationId === undefined) continue;
    if (correctionTargets.has(observation.supersedesObservationId)) {
      fail(
        "CONTRADICTORY_REVISION",
        "observation correction branches must be quarantined upstream",
      );
    }
    correctionTargets.add(observation.supersedesObservationId);
  }
  for (const start of unique) {
    const seen = new Set<string>();
    let cursor: RawObservation | undefined = start;
    while (cursor?.supersedesObservationId) {
      if (seen.has(cursor.id))
        fail("INVALID_REFERENCE", "observation correction cycle");
      seen.add(cursor.id);
      cursor = byId.get(cursor.supersedesObservationId);
    }
  }
  const streams = new Map<string, RawObservation[]>();
  for (const observation of unique) {
    const stream = observationStream(observation);
    streams.set(stream, [...(streams.get(stream) ?? []), observation]);
  }
  for (const stream of streams.values()) {
    const hasCollector = stream.some(
      (observation) => revisionMode(observation) === "collector",
    );
    const hasProvider = stream.some(
      (observation) => revisionMode(observation) === "provider",
    );
    if (!hasCollector || !hasProvider) continue;
    const hasTrustedTransition = stream.some((observation) => {
      if (revisionMode(observation) !== "provider") return false;
      let cursor: RawObservation | undefined = observation;
      const seen = new Set<string>();
      while (cursor?.supersedesObservationId) {
        if (seen.has(cursor.id)) return false;
        seen.add(cursor.id);
        const previous = byId.get(cursor.supersedesObservationId);
        if (previous && revisionMode(previous) === "collector") return true;
        cursor = previous;
      }
      return false;
    });
    if (!hasTrustedTransition)
      fail(
        "INVALID_STATE",
        "provider ordering requires an explicit collector transition",
      );
  }
  const normalized = unique
    .map((item) => ({ ...item, quarantined: quarantined.has(item.id) }))
    .sort((left, right) => {
      const stream = compareUtf8(
        observationStream(left),
        observationStream(right),
      );
      if (stream !== 0) return stream;
      const mode = compareUtf8(revisionMode(left), revisionMode(right));
      if (mode !== 0) return mode;
      const ordinal =
        revisionOrdinal(left) === revisionOrdinal(right)
          ? 0
          : revisionOrdinal(left) < revisionOrdinal(right)
            ? -1
            : 1;
      return ordinal !== 0 ? ordinal : compareUtf8(left.id, right.id);
    });
  return {
    observations: normalized,
    byId: new Map(normalized.map((item) => [item.id, item])),
  };
}

function latestObservationIdsByStream(
  observations: readonly NormalizedScoutingObservation[],
  includeQuarantined: boolean,
): ReadonlyMap<string, ReadonlySet<string>> {
  const streams = new Map<string, NormalizedScoutingObservation[]>();
  for (const observation of observations) {
    if (!includeQuarantined && observation.quarantined) continue;
    const stream = observationStream(observation);
    streams.set(stream, [...(streams.get(stream) ?? []), observation]);
  }
  return new Map(
    [...streams].map(([stream, candidates]) => {
      const providerCandidates = candidates.filter(
        (candidate) => revisionMode(candidate) === "provider",
      );
      const ordered =
        providerCandidates.length > 0 ? providerCandidates : candidates;
      const latestOrdinal = Math.max(...ordered.map(revisionOrdinal));
      return [
        stream,
        new Set(
          ordered
            .filter((candidate) => revisionOrdinal(candidate) === latestOrdinal)
            .map((candidate) => candidate.id),
        ),
      ];
    }),
  );
}

function latestUsableObservationIds(
  observations: readonly NormalizedScoutingObservation[],
): ReadonlyMap<string, ReadonlySet<string>> {
  return latestObservationIdsByStream(observations, false);
}

function terminalObservationIds(
  observations: readonly NormalizedScoutingObservation[],
): ReadonlyMap<string, ReadonlySet<string>> {
  return latestObservationIdsByStream(observations, true);
}

function manifestMaterial(module: SportModule): unknown {
  const capabilities = module.scoutingInputContract.capabilities
    .map((capability) => ({
      key: capability.key,
      required: capability.required,
      scope: capability.scope,
      availability: capability.availability,
      facts: capability.facts
        .map((fact) => ({
          key: fact.key,
          ...(fact.variant === undefined ? {} : { variant: fact.variant }),
          required: fact.required,
          cardinality: fact.cardinality,
          subjectScope: fact.subjectScope,
          maximumAgeMilliseconds: fact.maximumAgeMilliseconds,
          hasSubjectValidator: fact.validateSubject !== undefined,
        }))
        .sort((left, right) =>
          compareUtf8(
            `${left.key}\u0000${"variant" in left ? left.variant : ""}`,
            `${right.key}\u0000${"variant" in right ? right.variant : ""}`,
          ),
        ),
    }))
    .sort((left, right) => compareUtf8(left.key, right.key));
  return {
    schemaId: module.scoutingInputContract.schemaId,
    schemaVersion: module.scoutingInputContract.schemaVersion,
    sportKey: module.scoutingInputContract.sportKey,
    participantCardinality: module.scoutingInputContract.participantCardinality,
    capabilities,
  };
}

function validateScoutingInputInternal(
  input: unknown,
  options: ValidateScoutingInputOptions,
): NormalizedScoutingInput {
  const envelope = parseEnvelope(input);
  const sourceAuthorization = normalizeSourceAuthorization(
    options.sourceAuthorization,
  );
  const trustedOptions = { ...options, sourceAuthorization };
  authorize(envelope, trustedOptions);
  const evaluatedTimestamp = Date.parse(options.evaluatedAt);
  const expectedInstances = scoutingCapabilityInstances(
    options.module.scoutingInputContract,
    envelope.event.participantIds,
  );
  const expected = new Map(
    expectedInstances.map((instance) => [
      instanceKey(instance.capabilityKey, instance.subjectId),
      instance,
    ]),
  );
  const coverageByInstance = new Map<string, RawCoverage>();
  for (const coverage of envelope.coverage) {
    const key = instanceKey(coverage.capabilityKey, coverage.subjectId);
    if (!expected.has(key) || coverageByInstance.has(key))
      fail(
        "INVALID_REFERENCE",
        "coverage must match each declared capability instance exactly once",
      );
    coverageByInstance.set(key, coverage);
  }
  if (coverageByInstance.size !== expected.size)
    fail(
      "INVALID_STATE",
      "every declared capability instance requires coverage",
    );
  const { observations, byId: observationById } = normalizeObservations(
    envelope.observations,
  );
  const latestObservationIds = latestUsableObservationIds(observations);
  const terminalConflictObservationIds = terminalObservationIds(observations);
  for (const observation of observations) {
    const key = instanceKey(observation.capabilityKey, observation.subjectId);
    if (
      !expected.has(key) ||
      !sourceAuthorization.capabilities.includes(observation.capabilityKey)
    )
      fail("UNAUTHORIZED_SOURCE", "observation capability is not authorized");
    if (
      Date.parse(observation.collectedAt) > evaluatedTimestamp ||
      (observation.providerTimestamp !== undefined &&
        (Date.parse(observation.providerTimestamp) >
          Date.parse(observation.collectedAt) ||
          Date.parse(observation.providerTimestamp) > evaluatedTimestamp))
    ) {
      fail(
        "INVALID_STATE",
        "provider timestamp must not follow collection or evaluation",
      );
    }
  }
  for (const coverage of envelope.coverage) {
    for (const id of coverage.observationIds) {
      const observation = observationById.get(id);
      if (
        !observation ||
        instanceKey(observation.capabilityKey, observation.subjectId) !==
          instanceKey(coverage.capabilityKey, coverage.subjectId)
      )
        fail(
          "INVALID_REFERENCE",
          "coverage observation does not belong to its instance",
        );
    }
  }
  const coveredObservationIds = new Set(
    envelope.coverage.flatMap((coverage) => coverage.observationIds),
  );
  if (
    observations.some(
      (observation) => !coveredObservationIds.has(observation.id),
    )
  ) {
    fail("INVALID_REFERENCE", "every observation must appear in coverage");
  }
  const factById = new Map<string, RawFact>();
  const schemaByFact = new Map<string, SportScoutingFactSchema>();
  const factInstanceById = new Map<string, string>();
  const entityIdentities = new Set<string>();
  for (const fact of envelope.facts) {
    if (factById.has(fact.id)) fail("INVALID_INPUT", "fact ids must be unique");
    factById.set(fact.id, fact);
    const capability = options.module.scoutingInputContract.capabilities.find(
      (item) => item.key === fact.capabilityKey,
    );
    if (!capability)
      fail(
        "INVALID_REFERENCE",
        "fact capability is not declared by the module",
      );
    const schema = schemaFor(capability, fact);
    const capabilityInstances = [...expected.values()].filter(
      (instance) => instance.capabilityKey === fact.capabilityKey,
    );
    const candidates = capabilityInstances.filter((instance) => {
      if (schema.subjectScope === "event") {
        return fact.subjectId === undefined && instance.subjectId === undefined;
      }
      if (schema.subjectScope === "capability-instance") {
        return fact.subjectId === instance.subjectId;
      }
      return (
        fact.subjectId !== undefined &&
        validSportSubject(
          schema,
          fact.subjectId,
          instance.subjectId,
          envelope.event.participantIds,
        )
      );
    });
    if (candidates.length !== 1) {
      fail(
        "INVALID_REFERENCE",
        "fact does not resolve to exactly one capability instance",
      );
    }
    const instance = candidates[0]!;
    const resolvedInstanceKey = instanceKey(
      instance.capabilityKey,
      instance.subjectId,
    );
    schemaByFact.set(fact.id, schema);
    factInstanceById.set(fact.id, resolvedInstanceKey);
    if (schema.subjectScope === "entity") {
      const identity = [
        resolvedInstanceKey,
        schema.key,
        schema.variant ?? "",
        fact.subjectId!,
      ].join("\u0000");
      if (entityIdentities.has(identity))
        fail("INVALID_STATE", "entity fact cannot repeat within an instance");
      entityIdentities.add(identity);
    }
  }
  for (const fact of envelope.facts) {
    const schema = schemaByFact.get(fact.id)!;
    const resolvedInstanceKey = factInstanceById.get(fact.id)!;
    const instance = expected.get(resolvedInstanceKey)!;
    const capabilityFacts = envelope.facts
      .filter(
        (candidate) =>
          factInstanceById.get(candidate.id) === resolvedInstanceKey,
      )
      .map((candidate) => ({
        schemaKey: candidate.schemaKey,
        ...(candidate.schemaVariant === undefined
          ? {}
          : { schemaVariant: candidate.schemaVariant }),
        ...(candidate.subjectId === undefined
          ? {}
          : { subjectId: candidate.subjectId }),
        status:
          candidate.state === "conflicting"
            ? ("conflicting" as const)
            : candidate.state === "unavailable"
              ? ("unavailable" as const)
              : ("resolved" as const),
      }));
    validateFactShape(fact, schema, {
      sportKey: envelope.event.sportKey,
      leagueKey: envelope.event.leagueKey,
      participantIds: envelope.event.participantIds,
      ...(instance.subjectId === undefined
        ? {}
        : { capabilitySubjectId: instance.subjectId }),
      capabilityFacts,
    });
    if (
      fact.observedAt !== undefined &&
      Date.parse(fact.observedAt) > evaluatedTimestamp
    )
      fail("INVALID_STATE", "fact timestamp cannot be in the future");
    const coverage = coverageByInstance.get(resolvedInstanceKey)!;
    for (const observationId of fact.observationIds) {
      const observation = observationById.get(observationId);
      if (
        !observation ||
        instanceKey(observation.capabilityKey, observation.subjectId) !==
          resolvedInstanceKey ||
        !coverage.observationIds.includes(observationId)
      )
        fail(
          "INVALID_REFERENCE",
          "fact observation must belong to its instance coverage",
        );
      if (
        observation.quarantined &&
        fact.state !== "conflicting" &&
        fact.state !== "unavailable"
      )
        fail(
          "CONTRADICTORY_REVISION",
          "quarantined evidence cannot support a resolved fact",
        );
    }
    if (fact.state === "conflicting") {
      const alternativeBySemanticEvidence = new Map<string, number>();
      for (const [
        alternativeIndex,
        alternative,
      ] of fact.conflict!.alternatives.entries()) {
        for (const observationId of alternative.observationIds) {
          const semanticKey = semanticObservationKey(
            observationById.get(observationId)!,
          );
          const previousAlternative =
            alternativeBySemanticEvidence.get(semanticKey);
          if (
            previousAlternative !== undefined &&
            previousAlternative !== alternativeIndex
          )
            fail(
              "CONTRADICTORY_REVISION",
              "duplicate evidence cannot support separate conflict alternatives",
            );
          alternativeBySemanticEvidence.set(semanticKey, alternativeIndex);
        }
      }
      if (alternativeBySemanticEvidence.size < 2)
        fail(
          "CONTRADICTORY_REVISION",
          "conflict requires distinct underlying evidence",
        );
      if (
        fact.observationIds.some((id) => {
          const observation = observationById.get(id)!;
          return !terminalConflictObservationIds
            .get(observationStream(observation))
            ?.has(id);
        })
      )
        fail(
          "INVALID_REFERENCE",
          "conflict must cite terminal stream evidence",
        );
    }
    if (
      fact.state !== "conflicting" &&
      fact.state !== "unavailable" &&
      fact.observationIds.some((id) => {
        const observation = observationById.get(id)!;
        return !latestObservationIds
          .get(observationStream(observation))
          ?.has(id);
      })
    ) {
      fail(
        "INVALID_REFERENCE",
        "resolved fact must cite the latest usable stream evidence",
      );
    }
  }
  const verifyResolvedBasis = (
    fact: RawFact,
    stack = new Set<string>(),
  ): void => {
    if (stack.has(fact.id)) fail("INVALID_REFERENCE", "fact inference cycle");
    stack.add(fact.id);
    for (const basisId of fact.basisFactIds ?? []) {
      const basis = factById.get(basisId);
      if (!basis) fail("INVALID_REFERENCE", "inferred basis fact is missing");
      if (basis.state === "unavailable" || basis.state === "conflicting")
        fail("INVALID_STATE", "inferred basis must be resolved");
      if (
        basis.observationIds.some(
          (observationId) => observationById.get(observationId)!.quarantined,
        )
      )
        fail("CONTRADICTORY_REVISION", "inferred basis is quarantined");
      verifyResolvedBasis(basis, stack);
    }
    stack.delete(fact.id);
  };
  for (const fact of envelope.facts) {
    if (fact.state === "inferred") verifyResolvedBasis(fact);
  }
  const origins = new Map<string, number>();
  const resolveOrigin = (
    fact: RawFact,
    stack = new Set<string>(),
  ): number | undefined => {
    if (fact.state === "unavailable") return undefined;
    const cached = origins.get(fact.id);
    if (cached !== undefined) return cached;
    if (stack.has(fact.id)) fail("INVALID_REFERENCE", "fact inference cycle");
    stack.add(fact.id);
    const values = [
      fact.observedAt ? Date.parse(fact.observedAt) : undefined,
      ...fact.observationIds.map((id) => {
        const observation = observationById.get(id)!;
        return Date.parse(
          observation.providerTimestamp ?? observation.collectedAt,
        );
      }),
    ].filter((value): value is number => value !== undefined);
    for (const basisId of fact.basisFactIds ?? []) {
      const basis = factById.get(basisId);
      if (!basis) fail("INVALID_REFERENCE", "inferred basis fact is missing");
      const origin = resolveOrigin(basis, stack);
      if (origin !== undefined) values.push(origin);
    }
    stack.delete(fact.id);
    const origin = Math.min(...values);
    origins.set(fact.id, origin);
    return origin;
  };
  const resolveProvenance = (
    fact: RawFact,
    stack = new Set<string>(),
  ): NormalizedScoutingObservation[] => {
    if (stack.has(fact.id)) fail("INVALID_REFERENCE", "fact inference cycle");
    stack.add(fact.id);
    const result = fact.observationIds.map((id) => observationById.get(id)!);
    for (const basisId of fact.basisFactIds ?? []) {
      const basis = factById.get(basisId);
      if (!basis) fail("INVALID_REFERENCE", "inferred basis fact is missing");
      result.push(...resolveProvenance(basis, stack));
    }
    stack.delete(fact.id);
    return [...new Map(result.map((item) => [item.id, item])).values()].sort(
      (left, right) => compareUtf8(left.id, right.id),
    );
  };
  const facts = envelope.facts
    .map((fact): NormalizedScoutingFact => {
      const schema = schemaByFact.get(fact.id)!;
      const origin = resolveOrigin(fact);
      const freshness =
        origin === undefined
          ? { status: "unavailable" as const }
          : {
              status:
                evaluatedTimestamp - origin > schema.maximumAgeMilliseconds
                  ? ("stale" as const)
                  : ("current" as const),
              originAt: new Date(origin).toISOString(),
              ageMilliseconds: evaluatedTimestamp - origin,
            };
      if (fact.state === "verified" && freshness.status !== "current")
        fail("INVALID_STATE", "verified fact must be fresh");
      if (fact.state === "stale" && freshness.status !== "stale")
        fail("INVALID_STATE", "stale fact must derive stale freshness");
      if (
        (fact.state === "unavailable") !==
        (freshness.status === "unavailable")
      )
        fail("INVALID_STATE", "unavailable fact freshness is invalid");
      return { ...fact, freshness, provenance: resolveProvenance(fact) };
    })
    .sort((left, right) => compareUtf8(left.id, right.id));
  for (const [key, instance] of expected) {
    const capability = options.module.scoutingInputContract.capabilities.find(
      (item) => item.key === instance.capabilityKey,
    )!;
    const coverage = coverageByInstance.get(key)!;
    const instanceFacts = facts.filter(
      (fact) => factInstanceById.get(fact.id) === key,
    );
    for (const schema of capability.facts.filter((item) => item.required)) {
      const matches = instanceFacts.filter(
        (fact) =>
          fact.schemaKey === schema.key &&
          fact.schemaVariant === schema.variant,
      );
      if (schema.cardinality === "one" && matches.length !== 1)
        fail(
          "INVALID_STATE",
          "required fact schema must occur exactly once per capability instance",
        );
      if (schema.cardinality === "many" && matches.length === 0)
        fail("INVALID_STATE", "required repeated fact schema is missing");
    }
    for (const schema of capability.facts.filter(
      (item) => item.cardinality === "one",
    )) {
      const matches = instanceFacts.filter(
        (fact) =>
          fact.schemaKey === schema.key &&
          fact.schemaVariant === schema.variant,
      );
      if (matches.length > 1)
        fail("INVALID_STATE", "single-cardinality fact schema cannot repeat");
    }
    if (
      capability.availability === "unavailable-only" &&
      instanceFacts.some((fact) => fact.state !== "unavailable")
    )
      fail("INVALID_STATE", "planned capability must remain unavailable");
    const states = instanceFacts.map((fact) => fact.state);
    const unavailableCount = states.filter(
      (state) => state === "unavailable",
    ).length;
    const resolvedCount = states.filter(
      (state) =>
        state === "verified" || state === "inferred" || state === "stale",
    ).length;
    if (
      coverage.status === "available" &&
      (states.length === 0 || resolvedCount !== states.length)
    )
      fail(
        "INVALID_STATE",
        "available coverage requires all present facts to be resolved",
      );
    if (
      coverage.status === "partial" &&
      (states.length === 0 ||
        resolvedCount === states.length ||
        unavailableCount === states.length)
    )
      fail(
        "INVALID_STATE",
        "partial coverage requires degraded but not wholly unavailable facts",
      );
    if (
      coverage.status === "unavailable" &&
      (states.length === 0 || unavailableCount !== states.length)
    )
      fail(
        "INVALID_STATE",
        "unavailable coverage requires all present facts to be unavailable",
      );
    if (
      coverage.status === "unavailable" &&
      instanceFacts.some(
        (fact) => fact.unavailableReason !== coverage.unavailableReason,
      )
    )
      fail(
        "INVALID_STATE",
        "unavailable coverage and facts must share one reason",
      );
    if (
      coverage.status === "available" &&
      coverage.observationIds.some((id) => observationById.get(id)!.quarantined)
    )
      fail(
        "CONTRADICTORY_REVISION",
        "available coverage cannot rely on quarantined evidence",
      );
  }
  const coverage = [...envelope.coverage].sort((left, right) =>
    compareUtf8(
      instanceKey(left.capabilityKey, left.subjectId),
      instanceKey(right.capabilityKey, right.subjectId),
    ),
  );
  const manifestHash = calculationInputHash(
    "scouting-manifest-v1",
    manifestMaterial(options.module),
  );
  const material = {
    schemaId: envelope.schemaId,
    schemaVersion: envelope.schemaVersion,
    moduleSchema: envelope.moduleSchema,
    manifestHash,
    event: envelope.event,
    coverage,
    observations,
    facts,
    evaluatedAt: options.evaluatedAt,
    source: sourceAuthorization,
  };
  return deepFreeze({
    ...material,
    inputHash: calculationInputHash("scouting-input-v1", clonePlain(material)),
  });
}

export function validateScoutingInput(
  input: unknown,
  options: ValidateScoutingInputOptions,
): NormalizedScoutingInput {
  try {
    return validateScoutingInputInternal(input, options);
  } catch (error) {
    if (error instanceof ScoutingInputValidationError) throw error;
    return fail("INVALID_INPUT", "normalization failed safely");
  }
}
