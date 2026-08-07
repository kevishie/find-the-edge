import { canonicalCalculationJson, type SportKey } from "@find-the-edge/domain";
import type { LoggerPort } from "@find-the-edge/observability";

import {
  fixtureFragment,
  injurySuspensionFragment,
  lineupFragment,
  statisticsFragment,
  teamRosterFragment,
} from "./fixtures/scouting-input";
import {
  type ScoutingInputCollectionRequest,
  type ScoutingInputPorts,
  validateScoutingInputSourceDescriptor,
} from "./scouting-input-ports";

export type ScoutingInputStubEnvironment =
  "development" | "test" | "production";

export class DevelopmentScoutingInputStubError extends Error {
  constructor(
    readonly code: "PRODUCTION_FORBIDDEN" | "INVALID_REQUEST",
    message: string,
  ) {
    super(`Development scouting stub ${code.toLowerCase()}: ${message}`);
    this.name = "DevelopmentScoutingInputStubError";
  }
}

export const developmentScoutingInputSource =
  validateScoutingInputSourceDescriptor({
    id: "scouting-development-stub",
    providerId: "scouting-development-fixture",
    displayName: "Scouting Development Fixture",
    maturity: "development",
    productionEligible: false,
    sourceKind: "synthetic-fixture",
    sportKey: "soccer" as SportKey,
    competitionKeys: ["mls", "epl", "liga-mx", "uefa-champions-league"],
    capabilities: [
      "fixture",
      "venue",
      "team-roster-profile",
      "lineup",
      "injury-suspension",
      "statistics",
    ],
    evidenceReferencePrefixes: ["synthetic://scouting/"],
  });

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_FIXTURE_SEQUENCE = Number.MAX_SAFE_INTEGER - 64;

function boundedIdentifier(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    IDENTIFIER.test(value)
  );
}

function invalid(): never {
  throw new DevelopmentScoutingInputStubError(
    "INVALID_REQUEST",
    "request must be bounded canonical plain data",
  );
}

function validateRequest(value: unknown): ScoutingInputCollectionRequest {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(canonicalCalculationJson(value)) as Record<
      string,
      unknown
    >;
  } catch {
    return invalid();
  }
  const keys = [
    "correlationId",
    "canonicalEventId",
    "canonicalEventVersion",
    "sportKey",
    "leagueKey",
    "startsAt",
    "participantIds",
    "evaluatedAt",
    "collectorSequence",
  ];
  if (
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    [
      input["correlationId"],
      input["canonicalEventId"],
      input["canonicalEventVersion"],
      input["sportKey"],
      input["leagueKey"],
    ].some((item) => !boundedIdentifier(item)) ||
    !boundedIdentifier(input["canonicalEventId"], 96) ||
    input["sportKey"] !== developmentScoutingInputSource.sportKey ||
    !developmentScoutingInputSource.competitionKeys.includes(
      String(input["leagueKey"]),
    ) ||
    !Array.isArray(input["participantIds"]) ||
    input["participantIds"].length !== 2 ||
    input["participantIds"].some((item) => !boundedIdentifier(item, 96)) ||
    new Set(input["participantIds"]).size !== input["participantIds"].length ||
    input["participantIds"].some((participantId, index, participantIds) =>
      participantIds.some(
        (candidate, candidateIndex) =>
          index !== candidateIndex &&
          String(candidate).startsWith(`${String(participantId)}.player-`),
      ),
    ) ||
    typeof input["collectorSequence"] !== "number" ||
    !Number.isSafeInteger(input["collectorSequence"]) ||
    input["collectorSequence"] < 0 ||
    input["collectorSequence"] > MAX_FIXTURE_SEQUENCE
  ) {
    return invalid();
  }
  for (const field of ["startsAt", "evaluatedAt"]) {
    const candidate = input[field];
    if (
      typeof candidate !== "string" ||
      !Number.isFinite(Date.parse(candidate)) ||
      new Date(Date.parse(candidate)).toISOString() !== candidate
    ) {
      return invalid();
    }
  }
  return input as unknown as ScoutingInputCollectionRequest;
}

function safeLog(
  logger: LoggerPort | undefined,
  request: ScoutingInputCollectionRequest,
  capability: string,
): void {
  try {
    logger?.info("Development scouting fixture collected", {
      correlationId: request.correlationId,
      eventId: request.canonicalEventId,
      sportKey: request.sportKey,
      leagueKey: request.leagueKey,
      capability,
      providerId: developmentScoutingInputSource.providerId,
    });
  } catch {
    // Logging cannot change deterministic fixture behavior.
  }
}

export function createDevelopmentScoutingInputPorts(
  environment: ScoutingInputStubEnvironment,
  logger?: LoggerPort,
): ScoutingInputPorts {
  if (environment === "production") {
    throw new DevelopmentScoutingInputStubError(
      "PRODUCTION_FORBIDDEN",
      "fixture unavailable",
    );
  }
  if (environment !== "development" && environment !== "test") return invalid();
  const collect = (
    value: ScoutingInputCollectionRequest,
    capability: string,
    factory: (request: ScoutingInputCollectionRequest) => unknown,
  ) => {
    return Promise.resolve().then(() => {
      const request = validateRequest(value);
      let result: unknown;
      try {
        result = factory(request);
      } catch {
        return invalid();
      }
      safeLog(logger, request, capability);
      return result;
    });
  };
  return Object.freeze({
    descriptor: developmentScoutingInputSource,
    fixture: Object.freeze({
      descriptor: developmentScoutingInputSource,
      collectFixture: (request: ScoutingInputCollectionRequest) =>
        collect(request, "fixture,venue", fixtureFragment),
    }),
    teamRoster: Object.freeze({
      descriptor: developmentScoutingInputSource,
      collectTeamRoster: (request: ScoutingInputCollectionRequest) =>
        collect(request, "team-roster-profile", teamRosterFragment),
    }),
    lineup: Object.freeze({
      descriptor: developmentScoutingInputSource,
      collectLineup: (request: ScoutingInputCollectionRequest) =>
        collect(request, "lineup", lineupFragment),
    }),
    injurySuspension: Object.freeze({
      descriptor: developmentScoutingInputSource,
      collectInjurySuspension: (request: ScoutingInputCollectionRequest) =>
        collect(request, "injury-suspension", injurySuspensionFragment),
    }),
    statistics: Object.freeze({
      descriptor: developmentScoutingInputSource,
      collectStatistics: (request: ScoutingInputCollectionRequest) =>
        collect(request, "statistics", statisticsFragment),
    }),
  });
}
