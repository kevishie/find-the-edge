import { canonicalCalculationJson, type SportKey } from "@find-the-edge/domain";

export type ScoutingInputCapability = string;

export interface ScoutingInputSourceDescriptor {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly maturity: "development" | "production";
  readonly productionEligible: boolean;
  readonly sourceKind: "synthetic-fixture" | "provider";
  readonly sportKey: SportKey;
  readonly competitionKeys: readonly string[];
  readonly capabilities: readonly ScoutingInputCapability[];
  readonly evidenceReferencePrefixes: readonly string[];
}

export interface ScoutingInputCollectionRequest {
  readonly correlationId: string;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly participantIds: readonly string[];
  readonly evaluatedAt: string;
  readonly collectorSequence: number;
}

export interface FixtureScoutingInputPort {
  readonly descriptor: ScoutingInputSourceDescriptor;
  collectFixture(request: ScoutingInputCollectionRequest): Promise<unknown>;
}

export interface TeamRosterScoutingInputPort {
  readonly descriptor: ScoutingInputSourceDescriptor;
  collectTeamRoster(request: ScoutingInputCollectionRequest): Promise<unknown>;
}

export interface LineupScoutingInputPort {
  readonly descriptor: ScoutingInputSourceDescriptor;
  collectLineup(request: ScoutingInputCollectionRequest): Promise<unknown>;
}

export interface InjurySuspensionScoutingInputPort {
  readonly descriptor: ScoutingInputSourceDescriptor;
  collectInjurySuspension(
    request: ScoutingInputCollectionRequest,
  ): Promise<unknown>;
}

export interface StatisticsScoutingInputPort {
  readonly descriptor: ScoutingInputSourceDescriptor;
  collectStatistics(request: ScoutingInputCollectionRequest): Promise<unknown>;
}

export interface ScoutingInputPorts {
  readonly descriptor: ScoutingInputSourceDescriptor;
  readonly fixture: FixtureScoutingInputPort;
  readonly teamRoster: TeamRosterScoutingInputPort;
  readonly lineup: LineupScoutingInputPort;
  readonly injurySuspension: InjurySuspensionScoutingInputPort;
  readonly statistics: StatisticsScoutingInputPort;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export class ScoutingInputPortValidationError extends Error {
  constructor(message: string) {
    super(`Invalid scouting input port: ${message}`);
    this.name = "ScoutingInputPortValidationError";
  }
}

function invalid(message: string): never {
  throw new ScoutingInputPortValidationError(message);
}

function clone(input: unknown): unknown {
  try {
    return JSON.parse(canonicalCalculationJson(input)) as unknown;
  } catch {
    return invalid("descriptor must be bounded plain data");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return invalid(`${label} must be canonical`);
  }
  return value;
}

export function validateScoutingInputSourceDescriptor(
  value: unknown,
): Readonly<ScoutingInputSourceDescriptor> {
  const input = record(clone(value), "descriptor");
  const expected = [
    "id",
    "providerId",
    "displayName",
    "maturity",
    "productionEligible",
    "sourceKind",
    "sportKey",
    "competitionKeys",
    "capabilities",
    "evidenceReferencePrefixes",
  ];
  if (
    Object.keys(input).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(input, key))
  ) {
    return invalid("descriptor has unknown or missing fields");
  }
  if (
    typeof input["displayName"] !== "string" ||
    !input["displayName"] ||
    input["displayName"] !== input["displayName"].trim()
  ) {
    return invalid("displayName must be trimmed text");
  }
  const maturity = input["maturity"];
  const productionEligible = input["productionEligible"];
  const sourceKind = input["sourceKind"];
  if (
    (maturity !== "development" && maturity !== "production") ||
    typeof productionEligible !== "boolean" ||
    (sourceKind !== "synthetic-fixture" && sourceKind !== "provider")
  ) {
    return invalid("source state is invalid");
  }
  if ((maturity === "production") !== productionEligible) {
    return invalid("production eligibility must match maturity");
  }
  if (
    sourceKind === "synthetic-fixture" &&
    (maturity !== "development" || productionEligible)
  ) {
    return invalid("synthetic sources are development-only");
  }
  if (
    !Array.isArray(input["competitionKeys"]) ||
    input["competitionKeys"].length === 0 ||
    input["competitionKeys"].length > 128 ||
    !Array.isArray(input["capabilities"]) ||
    input["capabilities"].length === 0 ||
    input["capabilities"].length > 128 ||
    !Array.isArray(input["evidenceReferencePrefixes"]) ||
    input["evidenceReferencePrefixes"].length === 0 ||
    input["evidenceReferencePrefixes"].length > 16
  ) {
    return invalid("coverage arrays are invalid");
  }
  const competitionKeys = input["competitionKeys"].map((item, index) =>
    id(item, `competitionKeys[${index}]`),
  );
  const capabilities = input["capabilities"].map((item, index) =>
    id(item, `capabilities[${index}]`),
  );
  const evidenceReferencePrefixes = input["evidenceReferencePrefixes"].map(
    (item, index) => {
      if (
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 1_024 ||
        item !== item.trim()
      ) {
        return invalid(
          `evidenceReferencePrefixes[${index}] must be bounded text`,
        );
      }
      const valid =
        sourceKind === "synthetic-fixture"
          ? item.startsWith("synthetic://") &&
            item.length > "synthetic://".length &&
            item.endsWith("/")
          : (item.startsWith("s3://") &&
              item.length > "s3://".length &&
              item.endsWith("/")) ||
            (item.startsWith("retained://") &&
              item.length > "retained://".length &&
              item.endsWith("/")) ||
            item === "sha256://";
      if (!valid)
        return invalid("evidence reference prefix is not source-safe");
      return item;
    },
  );
  if (
    new Set(competitionKeys).size !== competitionKeys.length ||
    new Set(capabilities).size !== capabilities.length ||
    new Set(evidenceReferencePrefixes).size !== evidenceReferencePrefixes.length
  ) {
    return invalid("coverage arrays must be unique");
  }
  return Object.freeze({
    id: id(input["id"], "id"),
    providerId: id(input["providerId"], "providerId"),
    displayName: input["displayName"],
    maturity,
    productionEligible,
    sourceKind,
    sportKey: id(input["sportKey"], "sportKey") as SportKey,
    competitionKeys: Object.freeze(competitionKeys),
    capabilities: Object.freeze(capabilities),
    evidenceReferencePrefixes: Object.freeze(evidenceReferencePrefixes),
  });
}
