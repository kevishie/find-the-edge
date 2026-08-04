import { sha256Hex } from "./fixture-odds.js";

export type WagerMode = "paper" | "money";
export type PerformanceMarket = "moneyline" | "spread";
export type OddsBand =
  "heavy-favorite" | "favorite" | "near-even" | "underdog" | "longshot";

export interface CohortDefinition {
  readonly window: { readonly from: string; readonly to: string };
  readonly filters: {
    readonly sports?: readonly string[];
    readonly leagues?: readonly string[];
    readonly markets?: readonly PerformanceMarket[];
    readonly oddsBands?: readonly OddsBand[];
    readonly strategyVersions?: readonly string[];
    readonly modelVersions?: readonly string[];
    readonly wagerMode: WagerMode;
  };
  readonly policyVersions: {
    readonly cohort: "cohort-v1";
    readonly performance: "performance-v1";
    readonly oddsBand: "odds-band-v1";
    readonly calibration: "calibration-deciles-v1";
    readonly clv: "clv-same-book-15m-v1";
  };
}

export interface CohortMember {
  readonly paperBetId: string;
  readonly evaluationId: string;
  readonly gradeId: string;
  readonly resultObservationId: string;
  readonly openingSnapshotId: string;
  readonly closingSnapshotId: string | null;
}

export interface FrozenCohort {
  readonly cohortId: string;
  readonly definitionHash: string;
  readonly membershipDigest: string;
  readonly cutoff: string;
  readonly definition: CohortDefinition;
  readonly members: readonly CohortMember[];
}

const iso = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("cohort-value-invalid");
  return value;
};
export const stableCohortValue = (value: unknown) =>
  JSON.stringify(canonical(value));
const sortedUnique = (values: readonly string[] | undefined) =>
  values === undefined ? undefined : [...new Set(values)].sort();
const validStrings = (values: readonly string[] | undefined) =>
  values === undefined ||
  (values.length > 0 &&
    values.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        value === value.trim(),
    ));

export function normalizeCohortDefinition(
  input: CohortDefinition,
): CohortDefinition {
  if (
    !iso(input.window.from) ||
    !iso(input.window.to) ||
    input.window.from >= input.window.to ||
    input.filters.wagerMode !== "paper" ||
    !validStrings(input.filters.sports) ||
    !validStrings(input.filters.leagues) ||
    !validStrings(input.filters.markets) ||
    !validStrings(input.filters.oddsBands) ||
    !validStrings(input.filters.strategyVersions) ||
    !validStrings(input.filters.modelVersions) ||
    input.filters.markets?.some(
      (value) => value !== "moneyline" && value !== "spread",
    ) ||
    input.filters.oddsBands?.some(
      (value) =>
        value !== "heavy-favorite" &&
        value !== "favorite" &&
        value !== "near-even" &&
        value !== "underdog" &&
        value !== "longshot",
    ) ||
    input.policyVersions.cohort !== "cohort-v1" ||
    input.policyVersions.performance !== "performance-v1" ||
    input.policyVersions.oddsBand !== "odds-band-v1" ||
    input.policyVersions.calibration !== "calibration-deciles-v1" ||
    input.policyVersions.clv !== "clv-same-book-15m-v1"
  )
    throw new Error("cohort-definition-invalid");
  return Object.freeze({
    window: Object.freeze({ ...input.window }),
    filters: Object.freeze({
      wagerMode: input.filters.wagerMode,
      ...(input.filters.sports
        ? { sports: sortedUnique(input.filters.sports)! }
        : {}),
      ...(input.filters.leagues
        ? { leagues: sortedUnique(input.filters.leagues)! }
        : {}),
      ...(input.filters.markets
        ? {
            markets: sortedUnique(
              input.filters.markets,
            )! as readonly PerformanceMarket[],
          }
        : {}),
      ...(input.filters.oddsBands
        ? {
            oddsBands: sortedUnique(
              input.filters.oddsBands,
            )! as readonly OddsBand[],
          }
        : {}),
      ...(input.filters.strategyVersions
        ? { strategyVersions: sortedUnique(input.filters.strategyVersions)! }
        : {}),
      ...(input.filters.modelVersions
        ? { modelVersions: sortedUnique(input.filters.modelVersions)! }
        : {}),
    }),
    policyVersions: Object.freeze({ ...input.policyVersions }),
  });
}

export function freezeCohort(input: {
  readonly definition: CohortDefinition;
  readonly cutoff: string;
  readonly members: readonly CohortMember[];
}): FrozenCohort {
  if (!iso(input.cutoff)) throw new Error("cohort-cutoff-invalid");
  const definition = normalizeCohortDefinition(input.definition);
  const members = [...input.members].sort((a, b) =>
    a.paperBetId.localeCompare(b.paperBetId),
  );
  if (Date.parse(input.cutoff) < Date.parse(definition.window.to))
    throw new Error("cohort-cutoff-before-window");
  for (const member of members)
    if (
      !/^paper-bet:[a-f0-9]{64}$/.test(member.paperBetId) ||
      !/^evaluation:[a-f0-9]{64}$/.test(member.evaluationId) ||
      !/^paper-grade:[a-f0-9]{64}$/.test(member.gradeId) ||
      !/^result:[a-f0-9]{64}$/.test(member.resultObservationId) ||
      !/^[a-f0-9]{64}$/.test(member.openingSnapshotId) ||
      (member.closingSnapshotId !== null &&
        !/^[a-f0-9]{64}$/.test(member.closingSnapshotId))
    )
      throw new Error("cohort-member-invalid");
  if (
    new Set(members.map((member) => member.paperBetId)).size !== members.length
  )
    throw new Error("cohort-member-duplicate");
  const definitionHash = sha256Hex(stableCohortValue(definition));
  const membershipDigest = sha256Hex(stableCohortValue(members));
  return Object.freeze({
    cohortId: `cohort:${sha256Hex(stableCohortValue({ definitionHash, membershipDigest, cutoff: input.cutoff }))}`,
    definitionHash,
    membershipDigest,
    cutoff: input.cutoff,
    definition,
    members: Object.freeze(
      members.map((member) => Object.freeze({ ...member })),
    ),
  });
}

export const performanceReportId = (
  cohortId: string,
  evidenceDigest: string,
  cutoff: string,
  revision: number,
) =>
  `performance-report:${sha256Hex(stableCohortValue({ cohortId, evidenceDigest, cutoff, revision, version: "performance-v1" }))}`;
