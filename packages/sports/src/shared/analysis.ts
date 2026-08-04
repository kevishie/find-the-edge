export type AnalysisMarketKey = "moneyline" | "spread";
export type AnalysisSelectionKind = "participant" | "draw";
export type EvidenceRequirementLevel = "hard" | "conditional" | "optional";
export type AnalysisMaturity = "complete" | "reduced" | "abstain";

export interface AnalysisMarketPolicy {
  readonly marketKey: AnalysisMarketKey;
  readonly displayName: string;
  readonly outcomeStructure: "two-way" | "three-way";
  readonly selectionKinds: readonly AnalysisSelectionKind[];
  readonly requiresPoint: boolean;
  readonly pointPolicy?: {
    readonly minimum: number;
    readonly maximum: number;
    readonly increment: number;
    readonly precision: number;
  };
  readonly legacyMarketAliases: readonly string[];
}

export interface AnalysisEvidenceRequirement {
  readonly category: string;
  readonly level: EvidenceRequirementLevel;
  /** Conditional evidence becomes hard this many minutes before start. */
  readonly enforceWithinMinutes?: number;
  readonly maximumAgeMinutes: number;
}

export interface AnalysisProbabilityPolicy {
  readonly minimum: number;
  readonly maximum: number;
  readonly maximumRangeWidth: number;
  readonly maximumUncertainty: number;
}

export interface AnalysisVersionReferences {
  readonly contractVersion: string;
  readonly promptBundleId: string;
  readonly promptBundleVersion: string;
  readonly promptSections: Readonly<
    Record<
      "shared" | "sport" | "strategy" | "analysis",
      {
        readonly id: string;
        readonly version: string;
      }
    >
  >;
  readonly inputSchemaId: string;
  readonly inputSchemaVersion: string;
  readonly outputSchemaId: string;
  readonly outputSchemaVersion: string;
  readonly modelId: string;
  readonly modelVersion: string;
}

export interface SportAnalysisPolicy {
  readonly enabled: boolean;
  readonly sportKey: string;
  readonly leagueKeys: readonly string[];
  readonly plannedReason?: "planned-module-disabled";
  readonly markets: readonly AnalysisMarketPolicy[];
  readonly evidenceRequirements: readonly AnalysisEvidenceRequirement[];
  readonly probability: AnalysisProbabilityPolicy;
  readonly contraindications: readonly {
    readonly code: string;
    readonly evidenceCategory: string;
    readonly statuses: readonly ("stale" | "conflicting" | "unavailable")[];
  }[];
  readonly prohibitedClaims: readonly string[];
  readonly citationRequired: true;
  readonly versions: AnalysisVersionReferences;
}

export function createPlannedAnalysisPolicy(
  sportKey: string,
  leagueKeys: readonly string[],
): SportAnalysisPolicy {
  return Object.freeze({
    enabled: false,
    sportKey,
    leagueKeys: Object.freeze([...leagueKeys]),
    plannedReason: "planned-module-disabled" as const,
    markets: Object.freeze([]),
    evidenceRequirements: Object.freeze([]),
    probability: Object.freeze({
      minimum: 0.01,
      maximum: 0.99,
      maximumRangeWidth: 0.2,
      maximumUncertainty: 0.2,
    }),
    contraindications: Object.freeze([]),
    prohibitedClaims: Object.freeze(["lock", "guarantee", "risk-free"]),
    citationRequired: true as const,
    versions: Object.freeze({
      contractVersion: `${sportKey}-analysis@0.1.0-planned`,
      promptBundleId: `${sportKey}-analysis`,
      promptBundleVersion: "0",
      promptSections: Object.freeze({
        shared: Object.freeze({ id: "evidence-safety", version: "1" }),
        sport: Object.freeze({ id: sportKey, version: "0" }),
        strategy: Object.freeze({ id: "planned", version: "0" }),
        analysis: Object.freeze({ id: "moneyline-spread", version: "1" }),
      }),
      inputSchemaId: `analysis-input/${sportKey}`,
      inputSchemaVersion: "0",
      outputSchemaId: `analysis-output/${sportKey}`,
      outputSchemaVersion: "0",
      modelId: `${sportKey}-planned`,
      modelVersion: "0.1.0-planned",
    }),
  });
}

export function resolveAnalysisMarket(
  policy: SportAnalysisPolicy,
  marketKey: string,
  outcomeStructure: "two-way" | "three-way",
): AnalysisMarketPolicy | undefined {
  return policy.markets.find(
    (market) =>
      market.outcomeStructure === outcomeStructure &&
      (market.marketKey === marketKey ||
        market.legacyMarketAliases.includes(marketKey)),
  );
}
