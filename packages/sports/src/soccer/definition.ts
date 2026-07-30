import type { SportKey } from "@find-the-edge/domain";

import { createDeclarativeSportModule } from "../shared/create-module";
import type { StrategyDefinition } from "../shared/contracts";

const key = "soccer" as SportKey;

export const soccerModule = createDeclarativeSportModule({
  key,
  metadata: {
    displayName: "Soccer",
    version: "1.0.0",
    maturity: "experimental",
    supportedLeagues: ["mls"],
    participantStructure: "two teams",
    eventPhases: [
      "scheduled",
      "pregame",
      "first-half",
      "halftime",
      "second-half",
      "final",
    ],
  },
  markets: [
    ["to_advance", "To Advance", "two-way", "team"],
    ["btts", "Both Teams to Score", "two-way", "event"],
    ["goal_total", "Goal Total", "numeric", "event"],
    ["team_total", "Team Total", "numeric", "team"],
    ["anytime_scorer", "Anytime Scorer", "multi-way", "player"],
    ["shots_on_target", "Shots on Target", "numeric", "player"],
    ["three_way_moneyline", "Three-Way Moneyline", "three-way", "team"],
  ].map(([marketKey, displayName, outcomeStructure, participantScope]) => ({
    key: marketKey!,
    displayName: displayName!,
    outcomeStructure: outcomeStructure as
      "two-way" | "three-way" | "multi-way" | "numeric",
    liveSupported: false,
    participantScope: participantScope as "event" | "team" | "player",
  })),
  prohibitedMarketKeys: [],
  requiredDataInputs: [
    "form",
    "expected-goals",
    "tactical-matchup",
    "lineups",
    "injuries",
    "rest-travel",
    "home-away-splits",
    "market-intelligence",
  ],
  optionalDataInputs: ["weather", "set-pieces", "public-betting"],
  scoutingCategories: [
    { key: "form", label: "Form", required: true },
    { key: "expected-goals", label: "Expected Goals", required: true },
    { key: "tactics", label: "Tactical Matchup", required: true },
    { key: "lineups", label: "Lineups & Injuries", required: true },
    { key: "market", label: "Market Intelligence", required: true },
  ],
  featureDefinitions: [
    {
      key: "xg-edge",
      label: "xG Edge",
      description: "Chance quality differential",
    },
    {
      key: "availability",
      label: "Availability",
      description: "Lineup and injury quality",
    },
  ],
  fairPriceMethodology:
    "Market-specific model probability and no-vig consensus",
  confidenceMethodology:
    "Lineup certainty, data quality, market depth, and model agreement",
  recommendationRules: [
    "Moneyline only when meaningfully mispriced",
    "No Bet is valid",
  ],
  lineupOrRosterRules: ["Confirmed XI materially changes pre-match confidence"],
  liveBettingSupported: false,
  gradingRules: [
    "Grade each market against official competition result and sportsbook rules",
  ],
  promptTemplateId: "sports/soccer@1",
  outputSchemaId: "scout/soccer@1",
  validationSchemaId: "sport-input/soccer@1",
  ui: {
    event: "Match",
    events: "Matches",
    participant: "Club",
    participants: "Clubs",
    lineup: "Starting XI",
    result: "Full-time result",
  },
});

export const soccerFindTheEdgeStrategy: StrategyDefinition = {
  id: "find-the-edge",
  sportKey: key,
  version: "1.0.0-experimental",
  approvedMarketKeys: [
    "to_advance",
    "btts",
    "goal_total",
    "team_total",
    "anytime_scorer",
    "shots_on_target",
    "three_way_moneyline",
  ],
  prohibitedMarketKeys: [],
  minimumEv: 0.025,
  minimumComparisonBooks: 3,
  maximumPriceAgeMinutes: 15,
};
