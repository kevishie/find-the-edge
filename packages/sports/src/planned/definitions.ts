import type { SportKey } from "@find-the-edge/domain";

import { createDeclarativeSportModule } from "../shared/create-module";
import { createPlannedAnalysisPolicy } from "../shared/analysis";
import { createUnavailableScoutingInputContract } from "../shared/scouting-input";
import { createUnavailableScoutingReportContract } from "../shared/scouting-report";

function planned(
  keyValue: string,
  displayName: string,
  leagues: string[],
  markets: string[],
  categories: string[],
) {
  const key = keyValue as SportKey;
  return createDeclarativeSportModule({
    key,
    metadata: {
      displayName,
      version: "0.1.0",
      maturity: "planned",
      supportedLeagues: leagues,
      participantStructure:
        keyValue === "tennis" ? "two players or pairs" : "two teams",
      eventPhases: ["scheduled", "pregame", "live", "final"],
    },
    markets: markets.map((marketKey) => ({
      key: marketKey,
      displayName: marketKey.replaceAll("_", " "),
      outcomeStructure: marketKey.includes("total") ? "numeric" : "two-way",
      liveSupported: false,
      participantScope: marketKey.includes("player") ? "player" : "event",
    })),
    prohibitedMarketKeys: [],
    requiredDataInputs: categories,
    optionalDataInputs: [],
    scoutingCategories: categories.map((category) => ({
      key: category,
      label: category.replaceAll("-", " "),
      required: true,
    })),
    featureDefinitions: [],
    fairPriceMethodology: "Planned; requires calibration before beta",
    confidenceMethodology:
      "Planned; module maturity forces visible uncertainty",
    recommendationRules: [
      "No recommendations before module reaches experimental maturity",
    ],
    lineupOrRosterRules: ["Planned"],
    liveBettingSupported: false,
    gradingRules: ["Planned"],
    promptTemplateId: `sports/${keyValue}@0`,
    outputSchemaId: `scout/${keyValue}@0`,
    validationSchemaId: `sport-input/${keyValue}@0`,
    analysisPolicy: createPlannedAnalysisPolicy(keyValue, leagues),
    scoutingInputContract: createUnavailableScoutingInputContract({
      sportKey: key,
      schemaVersion: "0",
      participantMinimum: 2,
      participantMaximum: keyValue === "tennis" ? 4 : 2,
      ...(keyValue === "tennis" ? { participantAllowedCounts: [2, 4] } : {}),
      capabilityKeys: categories,
    }),
    scoutingReportContract: createUnavailableScoutingReportContract({
      sportKey: key,
      schemaVersion: "0",
      sections: categories.map((category) => ({
        key: category,
        title: category.replaceAll("-", " "),
      })),
    }),
    ui: {
      event: keyValue === "tennis" ? "Match" : "Game",
      events: keyValue === "tennis" ? "Matches" : "Games",
      participant: keyValue === "tennis" ? "Player" : "Team",
      participants: keyValue === "tennis" ? "Players" : "Teams",
      lineup: keyValue === "tennis" ? "Entrants" : "Roster",
      result: "Result",
    },
  });
}

export const tennisModule = planned(
  "tennis",
  "Tennis",
  ["atp", "wta"],
  ["match_moneyline", "set_betting", "player_games", "player_sets"],
  [
    "surface-performance",
    "hold-break-rates",
    "serve-return",
    "form-fatigue",
    "travel-injury",
    "format-conditions",
    "market-movement",
  ],
);

export const nflModule = planned(
  "nfl",
  "NFL",
  ["nfl"],
  ["moneyline", "spread", "total", "player_props"],
  [
    "quarterback-efficiency",
    "epa-success-rate",
    "pressure-protection",
    "explosive-plays",
    "red-zone",
    "injuries-rest-travel",
    "weather-coaching",
    "market-movement",
  ],
);

export const nbaModule = planned(
  "nba",
  "NBA",
  ["nba"],
  ["moneyline", "spread", "total", "player_props"],
  [
    "player-availability",
    "rest-travel",
    "pace-efficiency",
    "lineup-matchups",
    "market-movement",
  ],
);

export const ncaafModule = planned(
  "ncaaf",
  "NCAAF",
  ["ncaaf"],
  ["moneyline", "spread", "total"],
  [
    "team-efficiency",
    "returning-production",
    "quarterback-lines",
    "explosiveness-havoc",
    "finishing-drives",
    "special-teams",
    "injuries-opt-outs",
    "travel-rivalry",
    "market-movement",
    "uncertainty",
  ],
);
