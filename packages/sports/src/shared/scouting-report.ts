import type { SportKey } from "@find-the-edge/domain";

export type ScoutingReportSectionContent = "narrative" | "deterministic";

export interface SportScoutingReportSection {
  readonly key: string;
  readonly title: string;
  readonly availability: "evidence" | "unavailable-only";
  readonly content: ScoutingReportSectionContent;
  readonly allowedFactCategories: readonly string[];
  readonly allowedCalculationKinds: readonly string[];
  readonly deterministicReferencePolicy?:
    "all-available" | "qualification-play-only";
}

export interface SportScoutingReportContract {
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly sportKey: SportKey;
  readonly sections: readonly SportScoutingReportSection[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_SECTIONS = 64;
const MAX_CATEGORIES = 128;

function fail(code: string): never {
  throw new Error(`scouting-report-contract-${code}`);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function canonicalTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return code > 31 && code !== 127;
    })
  );
}

function identifiers(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CATEGORIES &&
    value.every(identifier) &&
    new Set(value).size === value.length
  );
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function clonePlain(input: unknown, seen = new Set<object>()): unknown {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input !== "object" || seen.has(input))
    return fail("plain-data-invalid");
  seen.add(input);
  try {
    const prototype = Reflect.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype || input.length > MAX_CATEGORIES)
        return fail("plain-data-invalid");
      const allowed = new Set([
        "length",
        ...Array.from({ length: input.length }, (_, index) => String(index)),
      ]);
      if (
        Reflect.ownKeys(input).some(
          (key) => typeof key !== "string" || !allowed.has(key),
        )
      )
        return fail("plain-data-invalid");
      const output: unknown[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          input,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor))
          return fail("plain-data-invalid");
        output.push(clonePlain(descriptor.value, seen));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null)
      return fail("plain-data-invalid");
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        return fail("plain-data-invalid");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        return fail("plain-data-invalid");
      output[key] = clonePlain(descriptor.value, seen);
    }
    return output;
  } finally {
    seen.delete(input);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function defineSportScoutingReportContract(
  input: SportScoutingReportContract,
): Readonly<SportScoutingReportContract> {
  input = clonePlain(input) as SportScoutingReportContract;
  if (
    !exactObject(input, [
      "schemaId",
      "schemaVersion",
      "sportKey",
      "sections",
    ]) ||
    !identifier(input.schemaId) ||
    !identifier(input.schemaVersion) ||
    !identifier(input.sportKey) ||
    !Array.isArray(input.sections) ||
    input.sections.length === 0 ||
    input.sections.length > MAX_SECTIONS
  ) {
    return fail("invalid");
  }
  const keys = new Set<string>();
  const titles = new Set<string>();
  const sections: SportScoutingReportSection[] = input.sections.map(
    (section: SportScoutingReportSection) => {
      const sectionKeys = [
        "key",
        "title",
        "availability",
        "content",
        "allowedFactCategories",
        "allowedCalculationKinds",
      ];
      if (section.deterministicReferencePolicy !== undefined)
        sectionKeys.push("deterministicReferencePolicy");
      if (
        !exactObject(section, sectionKeys) ||
        !identifier(section.key) ||
        !canonicalTitle(section.title) ||
        (section.availability !== "evidence" &&
          section.availability !== "unavailable-only") ||
        (section.content !== "narrative" &&
          section.content !== "deterministic") ||
        !identifiers(section.allowedFactCategories) ||
        !identifiers(section.allowedCalculationKinds) ||
        (section.deterministicReferencePolicy !== undefined &&
          section.deterministicReferencePolicy !== "all-available" &&
          section.deterministicReferencePolicy !== "qualification-play-only") ||
        (section.deterministicReferencePolicy !== undefined &&
          section.content !== "deterministic") ||
        keys.has(section.key) ||
        titles.has(section.title)
      ) {
        return fail("section-invalid");
      }
      if (
        section.availability === "unavailable-only" &&
        (section.allowedFactCategories.length > 0 ||
          section.allowedCalculationKinds.length > 0)
      ) {
        return fail("unavailable-section-invalid");
      }
      keys.add(section.key);
      titles.add(section.title);
      return {
        key: section.key,
        title: section.title,
        availability: section.availability,
        content: section.content,
        allowedFactCategories: [...section.allowedFactCategories],
        allowedCalculationKinds: [...section.allowedCalculationKinds],
        ...(section.deterministicReferencePolicy === undefined
          ? {}
          : {
              deterministicReferencePolicy:
                section.deterministicReferencePolicy,
            }),
      };
    },
  );
  return deepFreeze({
    schemaId: input.schemaId,
    schemaVersion: input.schemaVersion,
    sportKey: input.sportKey,
    sections,
  });
}

export function createUnavailableScoutingReportContract(input: {
  readonly sportKey: SportKey;
  readonly schemaVersion: string;
  readonly sections: readonly Readonly<{ key: string; title: string }>[];
}): Readonly<SportScoutingReportContract> {
  return defineSportScoutingReportContract({
    schemaId: `scout-report/${input.sportKey}`,
    schemaVersion: input.schemaVersion,
    sportKey: input.sportKey,
    sections: input.sections.map((section) => ({
      ...section,
      availability: "unavailable-only",
      content: "narrative",
      allowedFactCategories: [],
      allowedCalculationKinds: [],
    })),
  });
}
