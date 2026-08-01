const IDENTIFIER_PATTERN = /^[\x21-\x7e]+$/;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_LABEL_BYTES = 256;
const MAX_SORT_KEY_BYTES = 1_024;
const MAX_NORMALIZED_BYTES = 16_384;

export interface FixtureOddsObservation {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly selectionLabel?: string;
  readonly sportsbookId: string;
  readonly sportsbookLabel?: string;
  readonly americanOdds: number;
  readonly observedAt: string;
  readonly retrievedAt: string;
}

export interface FixtureOddsPartition {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly sportsbookId: string;
  readonly key: string;
}

export interface NormalizedFixtureOddsSnapshot extends Required<
  Omit<FixtureOddsObservation, "selectionLabel" | "sportsbookLabel">
> {
  readonly selectionLabel?: string;
  readonly sportsbookLabel?: string;
  readonly partitionKey: string;
  readonly snapshotId: string;
  readonly sortKey: string;
}

export interface FixtureOddsState {
  readonly partition: FixtureOddsPartition;
  readonly snapshots: Readonly<Record<string, NormalizedFixtureOddsSnapshot>>;
  readonly currentSnapshotId: string;
}

export type FixtureOddsSnapshotDecision = "created" | "existing";
export type FixtureOddsCurrentDecision = "advanced" | "retained";

export interface FixtureOddsTransitionResult {
  readonly state: FixtureOddsState;
  readonly snapshot: FixtureOddsSnapshotDecision;
  readonly current: FixtureOddsCurrentDecision;
}

export class FixtureOddsInputError extends Error {
  override readonly name = "FixtureOddsInputError";
}

export class FixtureOddsStateCorruptionError extends Error {
  override readonly name = "FixtureOddsStateCorruptionError";
}

const OBSERVATION_REQUIRED_KEYS = [
  "canonicalEventId",
  "canonicalEventVersion",
  "sportKey",
  "marketKey",
  "selectionKey",
  "sportsbookId",
  "americanOdds",
  "observedAt",
  "retrievedAt",
] as const;
const OBSERVATION_OPTIONAL_KEYS = [
  "selectionLabel",
  "sportsbookLabel",
] as const;
const PARTITION_KEYS = [
  "canonicalEventId",
  "canonicalEventVersion",
  "sportKey",
  "marketKey",
  "selectionKey",
  "sportsbookId",
  "key",
] as const;
const SNAPSHOT_REQUIRED_KEYS = [
  ...OBSERVATION_REQUIRED_KEYS,
  "partitionKey",
  "snapshotId",
  "sortKey",
] as const;

function captureOwnDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  ErrorType:
    typeof FixtureOddsInputError | typeof FixtureOddsStateCorruptionError,
  label: string,
  rejectUndefinedOptionals = false,
): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new ErrorType(`${label} must be an object`);
  }
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ErrorType(`${label} must have a plain or null prototype`);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (!required.includes(key) && !optional.includes(key)),
      ) ||
      required.some((key) => !keys.includes(key))
    ) {
      throw new ErrorType(
        `${label} has missing, symbolic, or unexpected properties`,
      );
    }
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        (rejectUndefinedOptionals &&
          optional.includes(key) &&
          descriptor.value === undefined)
      ) {
        throw new ErrorType(
          `${label}.${key} must be an enumerable own data property in canonical form`,
        );
      }
      captured[key] = descriptor.value;
    }
    return captured;
  } catch (error) {
    if (
      error instanceof FixtureOddsInputError ||
      error instanceof FixtureOddsStateCorruptionError
    ) {
      throw error;
    }
    throw new ErrorType(
      `${label} property descriptors cannot be inspected safely`,
    );
  }
}

function captureObservation(value: unknown): FixtureOddsObservation {
  return captureOwnDataRecord(
    value,
    OBSERVATION_REQUIRED_KEYS,
    OBSERVATION_OPTIONAL_KEYS,
    FixtureOddsInputError,
    "observation",
    true,
  ) as unknown as FixtureOddsObservation;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeIdentifier(name: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !IDENTIFIER_PATTERN.test(value) ||
    utf8Length(value) > MAX_IDENTIFIER_BYTES
  ) {
    throw new FixtureOddsInputError(
      `${name} must be non-empty printable ASCII and at most ${MAX_IDENTIFIER_BYTES} bytes`,
    );
  }
  return value;
}

function normalizeLabel(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const hasControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasControlCharacter ||
    utf8Length(value) > MAX_LABEL_BYTES
  ) {
    throw new FixtureOddsInputError(
      `${name} must be non-empty text without control characters and at most ${MAX_LABEL_BYTES} bytes`,
    );
  }
  return value;
}

function normalizeTimestamp(name: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    throw new FixtureOddsInputError(
      `${name} must be an ISO timestamp with an offset`,
    );
  }
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)!;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const leapYear =
    yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][monthNumber - 1];
  if (
    monthNumber < 1 ||
    monthNumber > 12 ||
    Number(day) < 1 ||
    Number(day) > (daysInMonth ?? 0)
  ) {
    throw new FixtureOddsInputError(
      `${name} must contain a real calendar date`,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new FixtureOddsInputError(`${name} must be a real ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function encodeComposite(parts: readonly (string | number | null)[]): string {
  return JSON.stringify(parts);
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Dependency-free SHA-256 over UTF-8, suitable for Node and browser builds. */
export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + constants[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < hash.length; index += 1) {
      hash[index] = (hash[index]! + next[index]!) >>> 0;
    }
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

type FixtureOddsPartitionDimensions = Pick<
  FixtureOddsObservation,
  | "canonicalEventId"
  | "canonicalEventVersion"
  | "sportKey"
  | "marketKey"
  | "selectionKey"
  | "sportsbookId"
>;

function partitionFrom(
  observation: FixtureOddsPartitionDimensions,
): FixtureOddsPartition {
  const canonicalEventId = normalizeIdentifier(
    "canonicalEventId",
    observation.canonicalEventId,
  );
  if (
    !Number.isSafeInteger(observation.canonicalEventVersion) ||
    observation.canonicalEventVersion < 1
  ) {
    throw new FixtureOddsInputError(
      "canonicalEventVersion must be a positive safe integer",
    );
  }
  const sportKey = normalizeIdentifier("sportKey", observation.sportKey);
  const marketKey = normalizeIdentifier("marketKey", observation.marketKey);
  const selectionKey = normalizeIdentifier(
    "selectionKey",
    observation.selectionKey,
  );
  const sportsbookId = normalizeIdentifier(
    "sportsbookId",
    observation.sportsbookId,
  );
  const key = `FIXTURE_ODDS#${encodeComposite([
    canonicalEventId,
    observation.canonicalEventVersion,
    sportKey,
    marketKey,
    selectionKey,
    sportsbookId,
  ])}`;
  if (utf8Length(key) > MAX_SORT_KEY_BYTES) {
    throw new FixtureOddsInputError(
      "partition key exceeds the DynamoDB key limit",
    );
  }
  return deepFreeze({
    canonicalEventId,
    canonicalEventVersion: observation.canonicalEventVersion,
    sportKey,
    marketKey,
    selectionKey,
    sportsbookId,
    key,
  });
}

function snapshotContent(
  snapshot: Omit<NormalizedFixtureOddsSnapshot, "snapshotId" | "sortKey">,
): string {
  return encodeComposite([
    snapshot.canonicalEventId,
    snapshot.canonicalEventVersion,
    snapshot.sportKey,
    snapshot.marketKey,
    snapshot.selectionKey,
    snapshot.selectionLabel ?? null,
    snapshot.sportsbookId,
    snapshot.sportsbookLabel ?? null,
    snapshot.americanOdds,
    snapshot.observedAt,
    snapshot.retrievedAt,
  ]);
}

export function normalizeFixtureOddsObservation(
  observation: FixtureOddsObservation,
): NormalizedFixtureOddsSnapshot {
  const captured = captureObservation(observation);
  const partition = partitionFrom(captured);
  if (
    !Number.isSafeInteger(captured.americanOdds) ||
    captured.americanOdds === 0 ||
    Math.abs(captured.americanOdds) < 100 ||
    Math.abs(captured.americanOdds) > 100_000
  ) {
    throw new FixtureOddsInputError(
      "americanOdds must be a safe integer from -100000..-100 or 100..100000",
    );
  }
  const selectionLabel = normalizeLabel(
    "selectionLabel",
    captured.selectionLabel,
  );
  const sportsbookLabel = normalizeLabel(
    "sportsbookLabel",
    captured.sportsbookLabel,
  );
  const base: Omit<NormalizedFixtureOddsSnapshot, "snapshotId" | "sortKey"> = {
    canonicalEventId: partition.canonicalEventId,
    canonicalEventVersion: partition.canonicalEventVersion,
    sportKey: partition.sportKey,
    marketKey: partition.marketKey,
    selectionKey: partition.selectionKey,
    ...(selectionLabel === undefined ? {} : { selectionLabel }),
    sportsbookId: partition.sportsbookId,
    ...(sportsbookLabel === undefined ? {} : { sportsbookLabel }),
    americanOdds: captured.americanOdds,
    observedAt: normalizeTimestamp("observedAt", captured.observedAt),
    retrievedAt: normalizeTimestamp("retrievedAt", captured.retrievedAt),
    partitionKey: partition.key,
  };
  const content = snapshotContent(base);
  if (utf8Length(content) > MAX_NORMALIZED_BYTES) {
    throw new FixtureOddsInputError(
      "normalized snapshot exceeds the item-size safety limit",
    );
  }
  const snapshotId = sha256Hex(content);
  const sortKey = `SNAPSHOT#${base.observedAt}#${snapshotId}`;
  if (utf8Length(sortKey) > MAX_SORT_KEY_BYTES) {
    throw new FixtureOddsInputError(
      "snapshot sort key exceeds the DynamoDB key limit",
    );
  }
  return deepFreeze({ ...base, snapshotId, sortKey });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function compareSnapshots(
  a: NormalizedFixtureOddsSnapshot,
  b: NormalizedFixtureOddsSnapshot,
): number {
  if (a.observedAt < b.observedAt) return -1;
  if (a.observedAt > b.observedAt) return 1;
  return a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0;
}

function sameSnapshot(
  a: NormalizedFixtureOddsSnapshot,
  b: NormalizedFixtureOddsSnapshot,
): boolean {
  return snapshotContent(a) === snapshotContent(b);
}

function validatePriorState(state: FixtureOddsState): FixtureOddsState {
  const capturedState = captureOwnDataRecord(
    state,
    ["partition", "snapshots", "currentSnapshotId"],
    [],
    FixtureOddsStateCorruptionError,
    "state",
  );
  const capturedPartition = captureOwnDataRecord(
    capturedState.partition,
    PARTITION_KEYS,
    [],
    FixtureOddsStateCorruptionError,
    "state.partition",
  ) as unknown as FixtureOddsPartition;
  const snapshotDictionary = capturedState.snapshots;
  if (snapshotDictionary === null || typeof snapshotDictionary !== "object") {
    throw new FixtureOddsStateCorruptionError(
      "state.snapshots must be an object",
    );
  }
  let dictionaryKeys: readonly (string | symbol)[];
  try {
    const prototype = Reflect.getPrototypeOf(snapshotDictionary);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new FixtureOddsStateCorruptionError(
        "state.snapshots must have a plain or null prototype",
      );
    }
    dictionaryKeys = Reflect.ownKeys(snapshotDictionary);
  } catch (error) {
    if (error instanceof FixtureOddsStateCorruptionError) throw error;
    throw new FixtureOddsStateCorruptionError(
      "state.snapshots property descriptors cannot be inspected safely",
    );
  }
  if (dictionaryKeys.some((key) => typeof key !== "string")) {
    throw new FixtureOddsStateCorruptionError(
      "state.snapshots cannot contain symbolic properties",
    );
  }
  const copied: Record<string, NormalizedFixtureOddsSnapshot> = Object.create(
    null,
  ) as Record<string, NormalizedFixtureOddsSnapshot>;
  let maximum: NormalizedFixtureOddsSnapshot | undefined;
  for (const key of dictionaryKeys as string[]) {
    let dictionaryDescriptor: PropertyDescriptor | undefined;
    try {
      dictionaryDescriptor = Reflect.getOwnPropertyDescriptor(
        snapshotDictionary,
        key,
      );
    } catch {
      throw new FixtureOddsStateCorruptionError(
        "state.snapshots property descriptors cannot be inspected safely",
      );
    }
    if (
      dictionaryDescriptor === undefined ||
      dictionaryDescriptor.enumerable !== true ||
      !("value" in dictionaryDescriptor)
    ) {
      throw new FixtureOddsStateCorruptionError(
        "snapshot dictionary entries must be enumerable own data properties",
      );
    }
    const candidate = captureOwnDataRecord(
      dictionaryDescriptor.value,
      SNAPSHOT_REQUIRED_KEYS,
      OBSERVATION_OPTIONAL_KEYS,
      FixtureOddsStateCorruptionError,
      `state.snapshots.${key}`,
      true,
    ) as unknown as NormalizedFixtureOddsSnapshot;
    let normalized: NormalizedFixtureOddsSnapshot;
    try {
      const observation = Object.create(null) as Record<string, unknown>;
      for (const field of OBSERVATION_REQUIRED_KEYS) {
        observation[field] = candidate[field];
      }
      for (const field of OBSERVATION_OPTIONAL_KEYS) {
        if (Object.hasOwn(candidate, field))
          observation[field] = candidate[field];
      }
      normalized = normalizeFixtureOddsObservation(
        observation as unknown as FixtureOddsObservation,
      );
    } catch (error) {
      throw new FixtureOddsStateCorruptionError(
        `snapshot record is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (
      key !== candidate.snapshotId ||
      normalized.snapshotId !== candidate.snapshotId ||
      normalized.sortKey !== candidate.sortKey ||
      normalized.partitionKey !== candidate.partitionKey ||
      normalized.partitionKey !== capturedPartition.key
    ) {
      throw new FixtureOddsStateCorruptionError(
        "snapshot key, identity, sort key, or partition is forged",
      );
    }
    const dimensions = [
      "canonicalEventId",
      "canonicalEventVersion",
      "sportKey",
      "marketKey",
      "selectionKey",
      "sportsbookId",
    ] as const;
    if (
      dimensions.some(
        (dimension) => normalized[dimension] !== capturedPartition[dimension],
      )
    ) {
      throw new FixtureOddsStateCorruptionError(
        "snapshot belongs to another partition",
      );
    }
    copied[key] = normalized;
    if (maximum === undefined || compareSnapshots(normalized, maximum) > 0)
      maximum = normalized;
  }
  if (
    maximum === undefined ||
    capturedState.currentSnapshotId !== maximum.snapshotId
  ) {
    throw new FixtureOddsStateCorruptionError(
      "CURRENT is missing or is not the deterministic maximum snapshot",
    );
  }
  let rebuiltPartition: FixtureOddsPartition;
  try {
    rebuiltPartition = partitionFrom(capturedPartition);
  } catch (error) {
    throw new FixtureOddsStateCorruptionError(
      `partition is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (rebuiltPartition.key !== capturedPartition.key) {
    throw new FixtureOddsStateCorruptionError(
      "partition key does not match its dimensions",
    );
  }
  return deepFreeze({
    partition: rebuiltPartition,
    snapshots: copied,
    currentSnapshotId: maximum.snapshotId,
  });
}

export function transitionFixtureOdds(
  priorState: FixtureOddsState | undefined,
  observation: FixtureOddsObservation,
): FixtureOddsTransitionResult {
  const snapshot = normalizeFixtureOddsObservation(observation);
  const partition = partitionFrom(snapshot);
  if (priorState === undefined) {
    const snapshots = Object.create(null) as Record<
      string,
      NormalizedFixtureOddsSnapshot
    >;
    snapshots[snapshot.snapshotId] = snapshot;
    return deepFreeze({
      state: { partition, snapshots, currentSnapshotId: snapshot.snapshotId },
      snapshot: "created" as const,
      current: "advanced" as const,
    });
  }
  const valid = validatePriorState(priorState);
  if (valid.partition.key !== partition.key) {
    throw new FixtureOddsStateCorruptionError(
      "observation belongs to another partition",
    );
  }
  const existing = valid.snapshots[snapshot.snapshotId];
  if (existing !== undefined) {
    if (!sameSnapshot(existing, snapshot)) {
      throw new FixtureOddsStateCorruptionError("snapshot identity collision");
    }
    return deepFreeze({
      state: valid,
      snapshot: "existing",
      current: "retained",
    });
  }
  const snapshots = Object.create(null) as Record<
    string,
    NormalizedFixtureOddsSnapshot
  >;
  for (const key of Object.keys(valid.snapshots))
    snapshots[key] = valid.snapshots[key]!;
  snapshots[snapshot.snapshotId] = snapshot;
  const oldCurrent = valid.snapshots[valid.currentSnapshotId]!;
  const advances = compareSnapshots(snapshot, oldCurrent) > 0;
  return deepFreeze({
    state: {
      partition: valid.partition,
      snapshots,
      currentSnapshotId: advances ? snapshot.snapshotId : oldCurrent.snapshotId,
    },
    snapshot: "created" as const,
    current: advances ? ("advanced" as const) : ("retained" as const),
  });
}
