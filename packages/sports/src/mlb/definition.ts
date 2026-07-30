import type { SportKey } from "@find-the-edge/domain";

import { createDeclarativeSportModule } from "../shared/create-module";
import type { StrategyDefinition } from "../shared/contracts";

const key = "mlb" as SportKey;

export const mlbModule = createDeclarativeSportModule({
  key,
  metadata: {
    displayName: "MLB",
    version: "1.0.0",
    maturity: "beta",
    supportedLeagues: ["mlb"],
    participantStructure: "two teams",
    eventPhases: [
      "scheduled",
      "pregame",
      "live",
      "final",
      "postponed",
      "cancelled",
    ],
  },
  markets: [
    {
      key: "moneyline",
      displayName: "Moneyline",
      outcomeStructure: "two-way",
      liveSupported: false,
      participantScope: "team",
    },
    {
      key: "pitcher_strikeouts",
      displayName: "Starting Pitcher Strikeouts",
      outcomeStructure: "numeric",
      liveSupported: false,
      participantScope: "player",
    },
    {
      key: "run_line",
      displayName: "Run Line",
      outcomeStructure: "two-way",
      liveSupported: false,
      participantScope: "team",
    },
  ],
  prohibitedMarketKeys: [],
  requiredDataInputs: [
    "starting-pitching",
    "offense-vs-handedness",
    "pitch-arsenal",
    "lineup",
    "bullpen",
    "defense-baserunning",
    "park-weather",
    "travel-rest",
    "market-intelligence",
  ],
  optionalDataInputs: ["catcher-framing", "public-betting"],
  scoutingCategories: [
    { key: "starting-pitching", label: "Starting Pitching", required: true },
    { key: "offense", label: "Offense vs Handedness", required: true },
    { key: "arsenal", label: "Pitch Arsenal Matchup", required: true },
    { key: "lineup", label: "Lineup Audit", required: true },
    { key: "bullpen", label: "Bullpen", required: true },
    { key: "defense", label: "Defense & Baserunning", required: true },
    { key: "environment", label: "Park & Weather", required: true },
    { key: "market", label: "Market Intelligence", required: true },
  ],
  featureDefinitions: [
    {
      key: "starter-edge",
      label: "Starter Edge",
      description: "Quality and arsenal matchup",
    },
    {
      key: "lineup-edge",
      label: "Lineup Edge",
      description: "Confirmed lineup matchup",
    },
    {
      key: "bullpen-edge",
      label: "Bullpen Edge",
      description: "Quality and availability",
    },
  ],
  fairPriceMethodology:
    "Model probability blended with independent no-vig market evidence",
  confidenceMethodology:
    "Evidence completeness, uncertainty, market quality, and agreement",
  recommendationRules: [
    "Never decide from starter alone",
    "No Bet when price lacks value",
  ],
  lineupOrRosterRules: [
    "Official lineup required inside configured pregame window",
  ],
  liveBettingSupported: false,
  gradingRules: [
    "ML grades from final winner",
    "Pitcher K props follow sportsbook rules",
  ],
  promptTemplateId: "sports/mlb@1",
  outputSchemaId: "scout/mlb@1",
  validationSchemaId: "sport-input/mlb@1",
  ui: {
    event: "Game",
    events: "Games",
    participant: "Team",
    participants: "Teams",
    lineup: "Lineup",
    result: "Final score",
  },
});

export const mlbFindTheEdgeStrategy: StrategyDefinition = {
  id: "find-the-edge",
  sportKey: key,
  version: "2.1.0",
  approvedMarketKeys: ["moneyline", "pitcher_strikeouts"],
  prohibitedMarketKeys: ["run_line"],
  minimumEv: 0.02,
  minimumComparisonBooks: 3,
  maximumPriceAgeMinutes: 15,
  nukeConfidenceThreshold: 9.5,
  maxFavoritePrice: -250,
  publicFade: {
    ticketThreshold: 0.8,
    confidencePenalty: { min: 1, max: 2 },
  },
};
