import type { AnalysisPolicyLike } from "../analysis-contract";

export const fixturePolicy: AnalysisPolicyLike = {
  enabled: true,
  sportKey: "mlb",
  leagueKeys: ["mlb"],
  markets: [
    {
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: false,
      legacyMarketAliases: [],
    },
    {
      marketKey: "moneyline",
      outcomeStructure: "three-way",
      selectionKinds: ["participant", "draw"],
      requiresPoint: false,
      legacyMarketAliases: ["three_way_moneyline"],
    },
    {
      marketKey: "spread",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: true,
      pointPolicy: { minimum: -20, maximum: 20, increment: 0.5, precision: 1 },
      legacyMarketAliases: ["run_line"],
    },
  ],
  evidenceRequirements: [
    { category: "form", level: "hard", maximumAgeMinutes: 60 },
    {
      category: "lineup",
      level: "conditional",
      enforceWithinMinutes: 60,
      maximumAgeMinutes: 60,
    },
    { category: "weather", level: "optional", maximumAgeMinutes: 120 },
  ],
  probability: {
    minimum: 0.05,
    maximum: 0.95,
    maximumRangeWidth: 0.2,
    maximumUncertainty: 0.2,
  },
  contraindications: [],
  prohibitedClaims: ["lock", "guarantee", "risk-free"],
  versions: {
    contractVersion: "fixture@1",
    promptBundleId: "analysis",
    promptBundleVersion: "1",
    promptSections: {
      shared: { id: "safety", version: "1" },
      sport: { id: "sport", version: "2" },
      strategy: { id: "strategy", version: "1" },
      analysis: { id: "analysis", version: "1" },
    },
    inputSchemaId: "input/fixture",
    inputSchemaVersion: "1",
    outputSchemaId: "output/fixture",
    outputSchemaVersion: "1",
    modelId: "model-1",
    modelVersion: "model-1",
  },
};

export const completeRequest = {
  sportKey: "mlb",
  leagueKey: "mlb",
  eventId: "event-1",
  participantIds: ["away", "home"],
  startsAt: "2026-08-04T00:00:00.000Z",
  asOf: "2026-08-03T22:00:00.000Z",
  candidate: {
    marketKey: "moneyline",
    outcomeStructure: "two-way",
    selection: { kind: "participant", participantId: "home" },
  },
  evidence: [
    {
      id: "form-1",
      category: "form",
      status: "verified",
      observedAt: "2026-08-03T21:55:00.000Z",
      facts: { description: "Home form is above baseline", rating: 0.62 },
    },
    {
      id: "lineup-1",
      category: "lineup",
      status: "verified",
      observedAt: "2026-08-03T21:56:00.000Z",
      facts: { confirmed: true },
    },
  ],
} as const;

export const completeOutput = {
  candidate: completeRequest.candidate,
  versions: fixturePolicy.versions,
  probability: { estimate: 0.57, low: 0.51, high: 0.63, uncertainty: 0.06 },
  status: "complete",
  abstentionCodes: [],
  summary: "Home form is above baseline.",
  assertions: [
    {
      text: "Home form is above baseline.",
      classification: "factual",
      citationIds: ["form-1"],
    },
  ],
} as const;

export const completeSoccerRequest = {
  ...completeRequest,
  sportKey: "soccer",
  leagueKey: "mls",
  eventId: "mls-event-1",
  candidate: {
    marketKey: "moneyline",
    outcomeStructure: "three-way",
    selection: { kind: "draw" },
  },
} as const;

export const fixtureSoccerPolicy: AnalysisPolicyLike = {
  ...fixturePolicy,
  sportKey: "soccer",
  leagueKeys: ["mls"],
};
