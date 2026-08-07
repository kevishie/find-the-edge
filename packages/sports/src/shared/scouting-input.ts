import type { SportKey } from "@find-the-edge/domain";

import type { ValidationResult } from "./contracts";

export type ScoutingCapabilityScope = "event" | "participant";
export type ScoutingFactSubjectScope =
  "event" | "capability-instance" | "entity";

export type ScoutingFactValidationStatus =
  "resolved" | "conflicting" | "unavailable";

export interface SportScoutingFactValidationContext {
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly participantIds: readonly string[];
  readonly capabilitySubjectId?: string;
  readonly capabilityFacts: readonly Readonly<{
    readonly schemaKey: string;
    readonly schemaVariant?: string;
    readonly subjectId?: string;
    readonly status: ScoutingFactValidationStatus;
  }>[];
}

export interface SportScoutingFactSchema {
  readonly key: string;
  readonly variant?: string;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly subjectScope: ScoutingFactSubjectScope;
  readonly maximumAgeMilliseconds: number;
  readonly validateSubject?: (
    input: Readonly<{
      subjectId: string;
      capabilitySubjectId?: string;
      participantIds: readonly string[];
    }>,
  ) => boolean;
  readonly validateValue: (
    value: unknown,
    context: SportScoutingFactValidationContext,
  ) => ValidationResult<unknown>;
}

export interface SportScoutingCapabilitySchema {
  readonly key: string;
  readonly required: boolean;
  readonly scope: ScoutingCapabilityScope;
  readonly availability: "evidence" | "unavailable-only";
  readonly facts: readonly SportScoutingFactSchema[];
}

export interface SportScoutingInputContract {
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly sportKey: SportKey;
  readonly participantCardinality: Readonly<{
    minimum: number;
    maximum: number;
    readonly allowedCounts?: readonly number[];
  }>;
  readonly capabilities: readonly SportScoutingCapabilitySchema[];
}

export interface ScoutingCapabilityInstance {
  readonly capabilityKey: string;
  readonly subjectId?: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
// Keep contract expansion within the canonical calculation JSON collection
// limit used when the normalized input and manifest are hashed.
const MAX_ITEMS = 256;

const CAPABILITY_SCOPES: readonly ScoutingCapabilityScope[] = [
  "event",
  "participant",
];
const CAPABILITY_AVAILABILITIES: readonly SportScoutingCapabilitySchema["availability"][] =
  ["evidence", "unavailable-only"];
const FACT_CARDINALITIES: readonly SportScoutingFactSchema["cardinality"][] = [
  "one",
  "many",
];
const FACT_SUBJECT_SCOPES: readonly ScoutingFactSubjectScope[] = [
  "event",
  "capability-instance",
  "entity",
];

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label}-invalid`);
  }
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneContract<T>(input: T): T {
  const stack = new Set<object>();
  const clone = (value: unknown, depth: number): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "undefined" ||
      typeof value === "function"
    ) {
      return value;
    }
    if (typeof value !== "object" || stack.has(value) || depth > 16) {
      throw new Error("scouting-contract-plain-data-invalid");
    }
    stack.add(value);
    try {
      const prototype = Reflect.getPrototypeOf(value);
      const array = Array.isArray(value);
      if (
        (array && prototype !== Array.prototype) ||
        (!array && prototype !== Object.prototype && prototype !== null)
      ) {
        throw new Error("scouting-contract-plain-data-invalid");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_ITEMS)
        throw new Error("scouting-contract-plain-data-invalid");
      const result: unknown[] | Record<string, unknown> = array ? [] : {};
      const lengthDescriptor = array
        ? Object.getOwnPropertyDescriptor(value, "length")
        : undefined;
      const arrayLength =
        lengthDescriptor && "value" in lengthDescriptor
          ? (lengthDescriptor.value as unknown)
          : undefined;
      if (
        array &&
        (typeof arrayLength !== "number" ||
          !Number.isSafeInteger(arrayLength) ||
          arrayLength < 0 ||
          arrayLength > MAX_ITEMS)
      ) {
        throw new Error("scouting-contract-plain-data-invalid");
      }
      const allowedArrayKeys = array
        ? new Set([
            "length",
            ...Array.from({ length: arrayLength as number }, (_, index) =>
              String(index),
            ),
          ])
        : undefined;
      if (array && keys.some((key) => !allowedArrayKeys!.has(String(key)))) {
        throw new Error("scouting-contract-plain-data-invalid");
      }
      if (array) {
        for (let index = 0; index < (arrayLength as number); index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw new Error("scouting-contract-plain-data-invalid");
          }
          (result as unknown[]).push(clone(descriptor.value, depth + 1));
        }
        return result;
      }
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor"
        ) {
          throw new Error("scouting-contract-plain-data-invalid");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("scouting-contract-plain-data-invalid");
        }
        const child = clone(descriptor.value, depth + 1);
        (result as Record<string, unknown>)[key] = child;
      }
      return result;
    } finally {
      stack.delete(value);
    }
  };
  try {
    return clone(input, 0) as T;
  } catch {
    throw new Error("scouting-contract-plain-data-invalid");
  }
}

export function defineSportScoutingInputContract(
  input: SportScoutingInputContract,
): Readonly<SportScoutingInputContract> {
  input = cloneContract(input);
  if (input === null || typeof input !== "object" || isArray(input)) {
    throw new Error("scouting-contract-invalid");
  }
  assertIdentifier(input.schemaId, "scouting-schema-id");
  assertIdentifier(input.schemaVersion, "scouting-schema-version");
  assertIdentifier(input.sportKey, "scouting-sport-key");
  if (
    input.participantCardinality === null ||
    typeof input.participantCardinality !== "object" ||
    isArray(input.participantCardinality) ||
    !isArray(input.capabilities)
  ) {
    throw new Error("scouting-contract-shape-invalid");
  }
  if (
    !Number.isSafeInteger(input.participantCardinality.minimum) ||
    !Number.isSafeInteger(input.participantCardinality.maximum) ||
    input.participantCardinality.minimum < 1 ||
    input.participantCardinality.maximum <
      input.participantCardinality.minimum ||
    input.participantCardinality.maximum > 256 ||
    input.capabilities.length === 0 ||
    input.capabilities.length > 128
  ) {
    throw new Error("scouting-contract-bounds-invalid");
  }
  const allowedCounts = input.participantCardinality.allowedCounts;
  if (
    allowedCounts !== undefined &&
    (!isArray(allowedCounts) ||
      allowedCounts.length === 0 ||
      allowedCounts.some(
        (count) =>
          !Number.isSafeInteger(count) ||
          count < input.participantCardinality.minimum ||
          count > input.participantCardinality.maximum,
      ) ||
      new Set(allowedCounts).size !== allowedCounts.length ||
      allowedCounts.some(
        (count, index) => index > 0 && count <= allowedCounts[index - 1]!,
      ))
  ) {
    throw new Error("scouting-participant-cardinality-invalid");
  }
  const capabilityKeys = new Set<string>();
  let maximumCapabilityInstances = 0;
  let maximumFactInstances = 0;
  for (const capability of input.capabilities) {
    if (
      capability === null ||
      typeof capability !== "object" ||
      isArray(capability) ||
      typeof capability.required !== "boolean" ||
      !CAPABILITY_SCOPES.includes(capability.scope) ||
      !CAPABILITY_AVAILABILITIES.includes(capability.availability) ||
      !isArray(capability.facts)
    ) {
      throw new Error("scouting-capability-schema-invalid");
    }
    assertIdentifier(capability.key, "scouting-capability-key");
    if (capabilityKeys.has(capability.key)) {
      throw new Error("scouting-capability-duplicate");
    }
    capabilityKeys.add(capability.key);
    if (capability.facts.length === 0 || capability.facts.length > 128) {
      throw new Error("scouting-fact-schema-bounds-invalid");
    }
    const factKeys = new Set<string>();
    const capabilityInstances =
      capability.scope === "event" ? 1 : input.participantCardinality.maximum;
    maximumCapabilityInstances += capabilityInstances;
    maximumFactInstances += capabilityInstances * capability.facts.length;
    if (
      maximumCapabilityInstances > MAX_ITEMS ||
      maximumFactInstances > MAX_ITEMS
    ) {
      throw new Error("scouting-contract-expansion-invalid");
    }
    for (const fact of capability.facts) {
      if (
        fact === null ||
        typeof fact !== "object" ||
        isArray(fact) ||
        typeof fact.required !== "boolean" ||
        !FACT_CARDINALITIES.includes(fact.cardinality) ||
        !FACT_SUBJECT_SCOPES.includes(fact.subjectScope) ||
        typeof fact.validateValue !== "function" ||
        (fact.validateSubject !== undefined &&
          typeof fact.validateSubject !== "function") ||
        (fact.subjectScope === "entity" &&
          typeof fact.validateSubject !== "function")
      ) {
        throw new Error("scouting-fact-schema-invalid");
      }
      if (
        (capability.scope === "event" &&
          fact.subjectScope === "capability-instance") ||
        (capability.scope === "participant" && fact.subjectScope === "event")
      ) {
        throw new Error("scouting-fact-scope-invalid");
      }
      assertIdentifier(fact.key, "scouting-fact-key");
      if (fact.variant !== undefined) {
        assertIdentifier(fact.variant, "scouting-fact-variant");
      }
      const identity = `${fact.key}\u0000${fact.variant ?? ""}`;
      if (factKeys.has(identity))
        throw new Error("scouting-fact-schema-duplicate");
      factKeys.add(identity);
      if (
        !Number.isSafeInteger(fact.maximumAgeMilliseconds) ||
        fact.maximumAgeMilliseconds < 1
      ) {
        throw new Error("scouting-fact-maximum-age-invalid");
      }
      if (
        capability.availability === "unavailable-only" &&
        (!fact.required || fact.cardinality !== "one")
      ) {
        throw new Error("unavailable-only-fact-schema-invalid");
      }
    }
  }
  return deepFreeze(input);
}

export function scoutingCapabilityInstances(
  contract: SportScoutingInputContract,
  participantIds: readonly string[],
): readonly Readonly<ScoutingCapabilityInstance>[] {
  if (
    !isArray(participantIds) ||
    participantIds.some(
      (participantId) =>
        typeof participantId !== "string" || !IDENTIFIER.test(participantId),
    ) ||
    participantIds.length < contract.participantCardinality.minimum ||
    participantIds.length > contract.participantCardinality.maximum ||
    (contract.participantCardinality.allowedCounts !== undefined &&
      !contract.participantCardinality.allowedCounts.includes(
        participantIds.length,
      )) ||
    new Set(participantIds).size !== participantIds.length
  ) {
    throw new Error("scouting-participant-cardinality-invalid");
  }
  return deepFreeze(
    contract.capabilities.flatMap((capability) =>
      capability.scope === "event"
        ? [{ capabilityKey: capability.key }]
        : participantIds.map((subjectId) => ({
            capabilityKey: capability.key,
            subjectId,
          })),
    ),
  );
}

export function createUnavailableScoutingInputContract(input: {
  readonly sportKey: SportKey;
  readonly schemaVersion: string;
  readonly participantMinimum: number;
  readonly participantMaximum: number;
  readonly participantAllowedCounts?: readonly number[];
  readonly capabilityKeys: readonly string[];
}): Readonly<SportScoutingInputContract> {
  return defineSportScoutingInputContract({
    schemaId: `scout-input/${input.sportKey}`,
    schemaVersion: input.schemaVersion,
    sportKey: input.sportKey,
    participantCardinality: {
      minimum: input.participantMinimum,
      maximum: input.participantMaximum,
      ...(input.participantAllowedCounts === undefined
        ? {}
        : { allowedCounts: input.participantAllowedCounts }),
    },
    capabilities: input.capabilityKeys.map((key) => ({
      key,
      required: true,
      scope: "event",
      availability: "unavailable-only",
      facts: [
        {
          key: "availability",
          required: true,
          cardinality: "one",
          subjectScope: "event",
          maximumAgeMilliseconds: 86_400_000,
          validateValue: () => ({
            valid: false,
            errors: ["Capability is not implemented"],
          }),
        },
      ],
    })),
  });
}
