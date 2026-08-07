import type { SportKey } from "@find-the-edge/domain";

import { createDeclarativeSportModule } from "../shared/create-module";
import type { StrategyDefinition } from "../shared/contracts";
import { createUnavailableScoutingInputContract } from "../shared/scouting-input";
import { createUnavailableScoutingReportContract } from "../shared/scouting-report";

export const mlbAnalysisPolicy = {
  enabled: true,
  sportKey: "mlb",
  leagueKeys: ["mlb"],
  markets: [
    {
      marketKey: "moneyline",
      displayName: "Moneyline",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: false,
      legacyMarketAliases: [],
    },
    {
      marketKey: "spread",
      displayName: "Run Line",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: true,
      pointPolicy: { minimum: -20, maximum: 20, increment: 0.5, precision: 1 },
      legacyMarketAliases: ["run_line"],
    },
  ],
  evidenceRequirements: [
    { category: "starting-pitching", level: "hard", maximumAgeMinutes: 120 },
    {
      category: "offense-vs-handedness",
      level: "hard",
      maximumAgeMinutes: 1440,
    },
    { category: "pitch-arsenal", level: "hard", maximumAgeMinutes: 1440 },
    { category: "bullpen", level: "hard", maximumAgeMinutes: 360 },
    { category: "defense-baserunning", level: "hard", maximumAgeMinutes: 1440 },
    { category: "park-weather", level: "hard", maximumAgeMinutes: 120 },
    {
      category: "lineup",
      level: "conditional",
      enforceWithinMinutes: 60,
      maximumAgeMinutes: 120,
    },
    { category: "market-intelligence", level: "hard", maximumAgeMinutes: 15 },
    { category: "travel-rest", level: "hard", maximumAgeMinutes: 1440 },
    { category: "public-betting", level: "optional", maximumAgeMinutes: 30 },
    { category: "event-identity", level: "optional", maximumAgeMinutes: 1440 },
  ],
  probability: {
    minimum: 0.05,
    maximum: 0.95,
    maximumRangeWidth: 0.18,
    maximumUncertainty: 0.18,
  },
  contraindications: [
    {
      code: "contraindication:unknown-starting-pitcher",
      evidenceCategory: "starting-pitching",
      statuses: ["unavailable", "conflicting"],
    },
    {
      code: "contraindication:conflicting-event-identity",
      evidenceCategory: "event-identity",
      statuses: ["conflicting"],
    },
    {
      code: "contraindication:stale-offered-price",
      evidenceCategory: "market-intelligence",
      statuses: ["stale"],
    },
  ],
  prohibitedClaims: ["lock", "guarantee", "risk-free", "sharp action proof"],
  citationRequired: true,
  versions: {
    contractVersion: "mlb-ml-spread@1.0.0",
    promptBundleId: "mlb-analysis",
    promptBundleVersion: "1",
    promptSections: {
      shared: { id: "evidence-safety", version: "1" },
      sport: { id: "mlb", version: "2" },
      strategy: { id: "find-the-edge", version: "2.1.0" },
      analysis: { id: "moneyline-spread", version: "1" },
    },
    inputSchemaId: "analysis-input/mlb",
    inputSchemaVersion: "1",
    outputSchemaId: "analysis-output/mlb",
    outputSchemaVersion: "1",
    modelId: "mlb-v2.1",
    modelVersion: "2.1.0",
  },
} as const;

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
      key: "spread",
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
  promptTemplateId: "sports/mlb@2",
  outputSchemaId: "scout/mlb@1",
  validationSchemaId: "sport-input/mlb@1",
  analysisPolicy: mlbAnalysisPolicy,
  scoutingInputContract: createUnavailableScoutingInputContract({
    sportKey: key,
    schemaVersion: "1",
    participantMinimum: 2,
    participantMaximum: 2,
    capabilityKeys: [
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
  }),
  scoutingReportContract: createUnavailableScoutingReportContract({
    sportKey: key,
    schemaVersion: "1",
    sections: [{ key: "report-unavailable", title: "Report Unavailable" }],
  }),
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
  prohibitedMarketKeys: ["spread"],
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
