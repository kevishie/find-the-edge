import type {
  Event,
  EventResult,
  MarketDefinition,
  ModuleMaturity,
  Pick,
  PickGrade,
  SportKey,
} from "@find-the-edge/domain";

export interface ValidationResult<T = unknown> {
  valid: boolean;
  value?: T;
  errors: string[];
}

export interface SportMetadata {
  displayName: string;
  version: string;
  maturity: ModuleMaturity;
  supportedLeagues: string[];
  participantStructure: string;
  eventPhases: string[];
}

export interface ScoutingCategory {
  key: string;
  label: string;
  required: boolean;
}

export interface FeatureDefinition {
  key: string;
  label: string;
  description: string;
}

export interface EventContext {
  event: Event;
  sportData: unknown;
  marketData: unknown;
}

export interface FeatureSet {
  values: Record<string, number | string | boolean | null>;
  warnings: string[];
}

export interface FairPriceResult {
  marketKey: string;
  selectionKey: string;
  probability: number;
  methodology: string;
  warnings: string[];
}

export interface MarketEvaluation {
  marketKey: string;
  selectionKey?: string;
  status: "qualified" | "disqualified" | "insufficient-data";
  reasons: string[];
}

export interface StructuredScoutInput {
  sportKey: SportKey;
  moduleVersion: string;
  event: Event;
  evidence: unknown[];
}

export interface ScoutReport {
  schemaId: string;
  schemaVersion: string;
  sections: Record<string, unknown>;
  warnings: string[];
}

export interface UiTerminology {
  event: string;
  events: string;
  participant: string;
  participants: string;
  lineup: string;
  result: string;
}

export interface SportModule {
  key: SportKey;
  metadata: SportMetadata;
  markets: MarketDefinition[];
  prohibitedMarketKeys: string[];
  requiredDataInputs: string[];
  optionalDataInputs: string[];
  scoutingCategories: ScoutingCategory[];
  featureDefinitions: FeatureDefinition[];
  fairPriceMethodology: string;
  confidenceMethodology: string;
  recommendationRules: string[];
  lineupOrRosterRules: string[];
  liveBettingSupported: boolean;
  gradingRules: string[];
  promptTemplateId: string;
  outputSchemaId: string;
  validationSchemaId: string;
  ui: UiTerminology;
  validateInput(input: unknown): ValidationResult;
  normalizeEvent(raw: unknown): ValidationResult<Event>;
  calculateFeatures(context: EventContext): FeatureSet;
  calculateFairPrice(context: EventContext): FairPriceResult[];
  evaluateMarkets(context: EventContext): MarketEvaluation[];
  buildScoutInput(context: EventContext): StructuredScoutInput;
  validateScoutOutput(output: unknown): ValidationResult<ScoutReport>;
  gradePick(pick: Pick, result: EventResult): PickGrade;
}

export interface StrategyDefinition {
  id: string;
  sportKey: SportKey;
  version: string;
  approvedMarketKeys: string[];
  prohibitedMarketKeys: string[];
  minimumEv: number;
  minimumComparisonBooks: number;
  maximumPriceAgeMinutes: number;
  targetSportsbookId?: string;
  nukeConfidenceThreshold?: number;
  maxFavoritePrice?: number;
  publicFade?: {
    ticketThreshold: number;
    confidencePenalty: { min: number; max: number };
  };
}
