import type { SportKey } from "@find-the-edge/domain";

import { createDeclarativeSportModule } from "../shared/create-module";
import type { StrategyDefinition } from "../shared/contracts";

export const soccerAnalysisPolicy = {
  enabled: true,
  sportKey: "soccer",
  leagueKeys: ["mls", "epl", "liga-mx", "uefa-champions-league"],
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
      marketKey: "moneyline",
      displayName: "Three-Way Moneyline",
      outcomeStructure: "three-way",
      selectionKinds: ["participant", "draw"],
      requiresPoint: false,
      legacyMarketAliases: ["three_way_moneyline"],
    },
    {
      marketKey: "spread",
      displayName: "Spread",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: true,
      pointPolicy: { minimum: -10, maximum: 10, increment: 0.25, precision: 2 },
      legacyMarketAliases: [],
    },
  ],
  evidenceRequirements: [
    { category: "form", level: "hard", maximumAgeMinutes: 1440 },
    { category: "expected-goals", level: "hard", maximumAgeMinutes: 1440 },
    { category: "tactical-matchup", level: "hard", maximumAgeMinutes: 1440 },
    { category: "injuries", level: "hard", maximumAgeMinutes: 180 },
    { category: "rest-travel", level: "hard", maximumAgeMinutes: 1440 },
    { category: "home-away-splits", level: "hard", maximumAgeMinutes: 1440 },
    {
      category: "lineups",
      level: "conditional",
      enforceWithinMinutes: 75,
      maximumAgeMinutes: 120,
    },
    { category: "market-intelligence", level: "hard", maximumAgeMinutes: 15 },
    { category: "weather", level: "optional", maximumAgeMinutes: 120 },
    { category: "event-identity", level: "optional", maximumAgeMinutes: 1440 },
  ],
  probability: {
    minimum: 0.03,
    maximum: 0.94,
    maximumRangeWidth: 0.2,
    maximumUncertainty: 0.2,
  },
  contraindications: [
    {
      code: "contraindication:conflicting-event-identity",
      evidenceCategory: "event-identity",
      statuses: ["conflicting"],
    },
    {
      code: "contraindication:unresolved-player-availability",
      evidenceCategory: "injuries",
      statuses: ["unavailable", "conflicting"],
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
    contractVersion: "soccer-ml-spread@1.0.0",
    promptBundleId: "soccer-analysis",
    promptBundleVersion: "1",
    promptSections: {
      shared: { id: "evidence-safety", version: "1" },
      sport: { id: "soccer", version: "2" },
      strategy: { id: "find-the-edge", version: "1.0.0-experimental" },
      analysis: { id: "moneyline-spread", version: "1" },
    },
    inputSchemaId: "analysis-input/soccer",
    inputSchemaVersion: "1",
    outputSchemaId: "analysis-output/soccer",
    outputSchemaVersion: "1",
    modelId: "mls-v1.0-draft",
    modelVersion: "1.0.0-draft",
  },
} as const;

const key = "soccer" as SportKey;

export const soccerModule = createDeclarativeSportModule({
  key,
  metadata: {
    displayName: "Soccer",
    version: "1.0.0",
    maturity: "experimental",
    supportedLeagues: ["mls", "epl", "liga-mx", "uefa-champions-league"],
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
    ["moneyline", "Moneyline", "three-way", "team"],
    ["btts", "Both Teams to Score", "two-way", "event"],
    ["goal_total", "Goal Total", "numeric", "event"],
    ["team_total", "Team Total", "numeric", "team"],
    ["anytime_scorer", "Anytime Scorer", "multi-way", "player"],
    ["shots_on_target", "Shots on Target", "numeric", "player"],
    ["spread", "Spread", "two-way", "team"],
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
  promptTemplateId: "sports/soccer@2",
  outputSchemaId: "scout/soccer@1",
  validationSchemaId: "sport-input/soccer@1",
  analysisPolicy: soccerAnalysisPolicy,
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
    "moneyline",
    "btts",
    "goal_total",
    "team_total",
    "anytime_scorer",
    "shots_on_target",
    "spread",
  ],
  prohibitedMarketKeys: [],
  minimumEv: 0.025,
  minimumComparisonBooks: 3,
  maximumPriceAgeMinutes: 15,
};
