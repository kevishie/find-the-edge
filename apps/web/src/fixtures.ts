import type {
  DecisionVersions,
  EntityId,
  Event,
  IsoTimestamp,
  SportKey,
} from "@find-the-edge/domain";
import {
  sportRegistry,
  strategyRegistry,
  type SportModule,
} from "@find-the-edge/sports";

export interface FixtureEvent {
  event: Event;
  participants: string[];
  leagueName: string;
  recommendation?: {
    decision: "play" | "no-bet";
    marketLabel: string;
    reasons: string[];
    versions: DecisionVersions;
  };
}

const fixtureNames: Record<string, readonly [string, string]> = {
  mlb: ["New York", "Boston"],
  soccer: ["Orlando", "Atlanta"],
  tennis: ["Alex Morgan", "Jordan Lee"],
  nfl: ["Miami", "Buffalo"],
  ncaaf: ["Coastal State", "Metro Tech"],
};

function id(value: string): EntityId {
  return value as EntityId;
}

function timestamp(value: string): IsoTimestamp {
  return value as IsoTimestamp;
}

function versions(
  module: SportModule,
  strategyVersion: string,
): DecisionVersions {
  return {
    sportModule: { id: String(module.key), version: module.metadata.version },
    strategy: { id: "find-the-edge", version: strategyVersion },
    model: { id: "fixture-price-model", version: "1.0.0" },
    calculation: { id: "weighted-consensus", version: "1.0.0" },
    inputSchema: { id: module.validationSchemaId, version: "1.0.0" },
  };
}

export const fixtureEvents: FixtureEvent[] = sportRegistry
  .list()
  .map((module, index) => {
    const names = fixtureNames[String(module.key)] ?? [
      `${module.ui.participant} A`,
      `${module.ui.participant} B`,
    ];
    const strategy = strategyRegistry.find(module.key);
    const recommendation =
      module.metadata.maturity === "planned" || strategy === undefined
        ? undefined
        : {
            decision: "no-bet" as const,
            marketLabel: module.markets[0]?.displayName ?? "Market",
            reasons: [
              "Fixture evidence only; no live recommendation published",
            ],
            versions: versions(module, strategy.version),
          };

    return {
      event: {
        id: id(`${String(module.key)}-fixture-001`),
        sportKey: module.key as SportKey,
        leagueId: id(module.metadata.supportedLeagues[0] ?? "unassigned"),
        participantIds: names.map((_, participantIndex) =>
          id(
            `${String(module.key)}-participant-${String(participantIndex + 1)}`,
          ),
        ),
        startsAt: timestamp(
          new Date(Date.UTC(2026, 7, 1 + index, 23, 30)).toISOString(),
        ),
        phase: "scheduled",
        detail: {
          schemaId: module.validationSchemaId,
          schemaVersion: module.metadata.version,
          value: { fixture: true },
        },
        evidence: [],
      },
      participants: [...names],
      leagueName:
        module.metadata.supportedLeagues[0]?.toUpperCase() ?? "UNASSIGNED",
      ...(recommendation ? { recommendation } : {}),
    };
  });

export const fixtureEventsBySport = new Map(
  fixtureEvents.map((fixture) => [fixture.event.sportKey, [fixture]]),
);
