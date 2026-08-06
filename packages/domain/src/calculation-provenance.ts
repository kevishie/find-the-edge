import { sha256Hex } from "./fixture-odds.js";

export const CALCULATION_HASH_STRATEGY_VERSION =
  "calculation-input-sha256-v1" as const;
export const CALCULATION_PROVENANCE_SCHEMA_VERSION =
  "calculation-provenance-v1" as const;

const MAX_CANONICAL_BYTES = 65_536;
const MAX_STRING_BYTES = 16_384;
const MAX_COLLECTION_SIZE = 256;
const MAX_DEPTH = 32;
const MAX_NODES = 4_096;
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/;
const UNSAFE_KEY_SEGMENTS = new Set([
  "address",
  "body",
  "cookie",
  "credential",
  "dob",
  "email",
  "passphrase",
  "password",
  "payload",
  "phone",
  "pii",
  "prompt",
  "response",
  "secret",
  "ssn",
  "token",
]);
const UNSAFE_KEY_PHRASES = new Set([
  "access token",
  "api key",
  "authorization",
  "client secret",
  "date of birth",
  "private key",
  "refresh token",
  "signing key",
  "social security",
]);
const UNSAFE_ASSIGNMENT =
  /(?:^|[?&#;\s"'])(?:secret|credential|password|passphrase|api[_-]?key|client[_-]?secret|private[_-]?key|signing[_-]?key|auth(?:orization)?|cookie|access[_-]?token|refresh[_-]?token|token|raw[_-]?(?:payload|response|body)|provider[_-]?(?:payload|response|body)|prompt|pii)["']?\s*[:=]/i;
const OBVIOUS_CREDENTIAL_VALUE =
  /(?:^|\s)(?:basic|bearer)\s+\S+|\b(?:ghp_[a-z0-9]+|github_pat_[a-z0-9_]+)\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk[-_][a-z0-9_-]+|-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i;
const EMAIL_ADDRESS_VALUE =
  /(?:^|[^a-z0-9.!#$%&'*+/=?^_`{|}~-])[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:$|[^a-z0-9-])/i;
const SSN_VALUE = /(?:^|\D)\d{3}[- ]\d{2}[- ]\d{4}(?:$|\D)/;
const PHONE_NUMBER_VALUE =
  /(?:^|[^\d])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?:$|[^\d])/;

export class CalculationProvenanceInputError extends Error {
  override readonly name = "CalculationProvenanceInputError";
}

export interface CalculationAlgorithmRef {
  readonly id: string;
  readonly version: string;
}

export interface CalculationComponentProvenance {
  readonly algorithm: Readonly<CalculationAlgorithmRef>;
  readonly inputHash: string;
}

export interface CalculationProvenance {
  readonly schemaVersion: typeof CALCULATION_PROVENANCE_SCHEMA_VERSION;
  readonly hashStrategyVersion: typeof CALCULATION_HASH_STRATEGY_VERSION;
  readonly precisionPolicyVersion: string;
  readonly root: Readonly<CalculationComponentProvenance>;
  readonly components: readonly Readonly<CalculationComponentProvenance>[];
}

export interface CalculationComponentInput {
  readonly algorithm: CalculationAlgorithmRef;
  readonly input: unknown;
}

export interface CreateCalculationProvenanceInput extends CalculationComponentInput {
  readonly precisionPolicyVersion: string;
  readonly components?: readonly CalculationComponentInput[];
  readonly componentEvidence?: readonly CalculationComponentProvenance[];
}

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index])
      return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
};

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function unsafeKey(value: string): boolean {
  if (
    value === "__proto__" ||
    value === "prototype" ||
    value === "constructor"
  ) {
    return true;
  }
  const segments = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => UNSAFE_KEY_SEGMENTS.has(segment))) return true;
  return [...UNSAFE_KEY_PHRASES].some((unsafe) => {
    const unsafeSegments = unsafe.split(" ");
    return segments.some((_, start) =>
      unsafeSegments.every(
        (segment, offset) => segments[start + offset] === segment,
      ),
    );
  });
}

function unsafeValue(value: string): boolean {
  return (
    UNSAFE_ASSIGNMENT.test(value) ||
    OBVIOUS_CREDENTIAL_VALUE.test(value) ||
    EMAIL_ADDRESS_VALUE.test(value) ||
    SSN_VALUE.test(value) ||
    PHONE_NUMBER_VALUE.test(value)
  );
}

function plainRecord(value: object): Record<string, unknown> {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CalculationProvenanceInputError(
      "calculation input requires plain objects",
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_COLLECTION_SIZE) {
    throw new CalculationProvenanceInputError(
      "calculation input exceeds size limits",
    );
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      containsUnpairedSurrogate(key) ||
      unsafeKey(key)
    ) {
      throw new CalculationProvenanceInputError(
        "calculation input contains an unsafe field",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new CalculationProvenanceInputError(
        "calculation input requires enumerable data properties",
      );
    }
    record[key] = descriptor.value;
  }
  return record;
}

function canonicalize(
  value: unknown,
  depth: number,
  seen: Set<object>,
  counter: { nodes: number },
): unknown {
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new CalculationProvenanceInputError(
      "calculation input exceeds size limits",
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CalculationProvenanceInputError(
        "calculation input numbers must be finite",
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (
      containsUnpairedSurrogate(value) ||
      new TextEncoder().encode(value).length > MAX_STRING_BYTES ||
      unsafeValue(value)
    ) {
      throw new CalculationProvenanceInputError(
        containsUnpairedSurrogate(value)
          ? "calculation input strings must contain valid Unicode"
          : unsafeValue(value)
            ? "calculation input contains an unsafe value"
            : "calculation input exceeds size limits",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new CalculationProvenanceInputError(
      "calculation input contains an unsupported value",
    );
  }
  if (seen.has(value)) {
    throw new CalculationProvenanceInputError(
      "calculation input must not be cyclic",
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_SIZE) {
        throw new CalculationProvenanceInputError(
          "calculation input exceeds size limits",
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CalculationProvenanceInputError(
            "calculation input arrays must not be sparse",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new CalculationProvenanceInputError(
            "calculation input arrays require data properties",
          );
        }
      }
      const allowedKeys = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowedKeys.has(key)) {
          throw new CalculationProvenanceInputError(
            typeof key === "string" && unsafeKey(key)
              ? "calculation input contains an unsafe field"
              : "calculation input arrays contain unsupported properties",
          );
        }
      }
      return value.map((entry) =>
        canonicalize(entry, depth + 1, seen, counter),
      );
    }
    const record = plainRecord(value);
    const keys = Object.keys(record);
    return Object.fromEntries(
      keys
        .sort(compareUtf8)
        .map((key) => [
          key,
          canonicalize(record[key], depth + 1, seen, counter),
        ]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalCalculationJson(value: unknown): string {
  const encoded = JSON.stringify(
    canonicalize(value, 0, new Set(), { nodes: 0 }),
  );
  if (new TextEncoder().encode(encoded).length > MAX_CANONICAL_BYTES) {
    throw new CalculationProvenanceInputError(
      "calculation input exceeds size limits",
    );
  }
  return encoded;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    containsUnpairedSurrogate(value) ||
    !IDENTIFIER.test(value)
  ) {
    throw new CalculationProvenanceInputError(`${label} is invalid`);
  }
  return value;
}

function algorithmRef(
  value: CalculationAlgorithmRef,
): Readonly<CalculationAlgorithmRef> {
  return Object.freeze({
    id: identifier(value.id, "calculation algorithm id"),
    version: identifier(value.version, "calculation algorithm version"),
  });
}

export function calculationInputHash(domain: string, input: unknown): string {
  const normalizedDomain = identifier(domain, "calculation hash domain");
  return sha256Hex(
    canonicalCalculationJson([
      "find-the-edge",
      CALCULATION_HASH_STRATEGY_VERSION,
      normalizedDomain,
      input,
    ]),
  );
}

function componentFromInput(
  component: CalculationComponentInput,
): Readonly<CalculationComponentProvenance> {
  const algorithm = algorithmRef(component.algorithm);
  return Object.freeze({
    algorithm,
    inputHash: calculationInputHash("calculation-input", {
      algorithm,
      input: component.input,
      components: [],
    }),
  });
}

function componentOrder(
  left: CalculationComponentProvenance,
  right: CalculationComponentProvenance,
): number {
  return (
    compareUtf8(left.algorithm.id, right.algorithm.id) ||
    compareUtf8(left.algorithm.version, right.algorithm.version) ||
    compareUtf8(left.inputHash, right.inputHash)
  );
}

export function createCalculationProvenance(
  input: CreateCalculationProvenanceInput,
): Readonly<CalculationProvenance> {
  const algorithm = algorithmRef(input.algorithm);
  const precisionPolicyVersion = identifier(
    input.precisionPolicyVersion,
    "precision policy version",
  );
  const rawComponents = input.components ?? [];
  const rawComponentEvidence = input.componentEvidence ?? [];
  if (
    rawComponents.length + rawComponentEvidence.length >
    MAX_COLLECTION_SIZE
  ) {
    throw new CalculationProvenanceInputError(
      "calculation provenance components exceed size limits",
    );
  }
  const components = [
    ...rawComponents.map(componentFromInput),
    ...rawComponentEvidence.map((component, index) =>
      normalizedStoredComponent(
        component,
        `calculation component evidence ${index}`,
      ),
    ),
  ].sort(componentOrder);
  const componentIds = components.map(({ algorithm: item }) => item.id);
  if (new Set(componentIds).size !== componentIds.length) {
    throw new CalculationProvenanceInputError(
      "calculation provenance contains duplicate components",
    );
  }
  const root = Object.freeze({
    algorithm,
    inputHash: calculationInputHash("calculation-input", {
      algorithm,
      input: input.input,
      components,
    }),
  });
  return Object.freeze({
    schemaVersion: CALCULATION_PROVENANCE_SCHEMA_VERSION,
    hashStrategyVersion: CALCULATION_HASH_STRATEGY_VERSION,
    precisionPolicyVersion,
    root,
    components: Object.freeze(components),
  });
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new CalculationProvenanceInputError(`${label} fields are invalid`);
  }
}

function normalizedStoredComponent(
  value: unknown,
  label: string,
): Readonly<CalculationComponentProvenance> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalculationProvenanceInputError(`${label} is invalid`);
  }
  const record = plainRecord(value);
  exactKeys(record, ["algorithm", "inputHash"], label);
  if (!record.algorithm || typeof record.algorithm !== "object") {
    throw new CalculationProvenanceInputError(`${label} algorithm is invalid`);
  }
  const rawAlgorithm = plainRecord(record.algorithm);
  exactKeys(rawAlgorithm, ["id", "version"], `${label} algorithm`);
  const algorithm = algorithmRef({
    id: identifier(rawAlgorithm.id, `${label} algorithm id`),
    version: identifier(rawAlgorithm.version, `${label} algorithm version`),
  });
  if (typeof record.inputHash !== "string" || !HASH.test(record.inputHash)) {
    throw new CalculationProvenanceInputError(`${label} hash is invalid`);
  }
  return Object.freeze({ algorithm, inputHash: record.inputHash });
}

export function normalizeCalculationProvenance(
  value: unknown,
): Readonly<CalculationProvenance> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalculationProvenanceInputError(
      "calculation provenance is invalid",
    );
  }
  const record = plainRecord(value);
  exactKeys(
    record,
    [
      "schemaVersion",
      "hashStrategyVersion",
      "precisionPolicyVersion",
      "root",
      "components",
    ],
    "calculation provenance",
  );
  if (record.schemaVersion !== CALCULATION_PROVENANCE_SCHEMA_VERSION) {
    throw new CalculationProvenanceInputError(
      "calculation provenance schema is invalid",
    );
  }
  if (record.hashStrategyVersion !== CALCULATION_HASH_STRATEGY_VERSION) {
    throw new CalculationProvenanceInputError(
      "calculation provenance hash strategy is invalid",
    );
  }
  const precisionPolicyVersion = identifier(
    record.precisionPolicyVersion,
    "precision policy version",
  );
  if (
    !Array.isArray(record.components) ||
    record.components.length > MAX_COLLECTION_SIZE
  ) {
    throw new CalculationProvenanceInputError(
      "calculation provenance components are invalid",
    );
  }
  const root = normalizedStoredComponent(record.root, "calculation root");
  const components = record.components
    .map((component, index) =>
      normalizedStoredComponent(component, `calculation component ${index}`),
    )
    .sort(componentOrder);
  if (
    new Set(components.map(({ algorithm }) => algorithm.id)).size !==
    components.length
  ) {
    throw new CalculationProvenanceInputError(
      "calculation provenance contains duplicate components",
    );
  }
  return Object.freeze({
    schemaVersion: CALCULATION_PROVENANCE_SCHEMA_VERSION,
    hashStrategyVersion: CALCULATION_HASH_STRATEGY_VERSION,
    precisionPolicyVersion,
    root,
    components: Object.freeze(components),
  });
}
