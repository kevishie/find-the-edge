import type { SportKey } from "@find-the-edge/domain";

export type ProviderCapability =
  | "odds"
  | "schedule"
  | "stats"
  | "injury"
  | "lineup"
  | "weather"
  | "public-betting"
  | "results";

export interface ProviderCoverage {
  readonly leagues: readonly {
    readonly sportKey: SportKey;
    readonly leagueKey: string;
    readonly capabilities: readonly ProviderCapability[];
    readonly marketKeys: readonly string[];
  }[];
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly coverage: ProviderCoverage;
  readonly rateLimit?: {
    readonly requests: number;
    readonly windowSeconds: number;
  };
  readonly expectedFreshnessSeconds: number;
  readonly qualityTier: "unknown" | "development" | "standard" | "premium";
}

export interface ProviderRequest {
  sportKey: SportKey;
  leagueKey?: string;
  eventId?: string;
  marketKeys?: string[];
  asOf?: string;
}

export interface ProviderResponse<T> {
  providerId: string;
  retrievedAt: string;
  data: T;
  warnings: string[];
}

interface ProviderPort<T> {
  readonly descriptor: ProviderDescriptor;
  fetch(request: ProviderRequest): Promise<ProviderResponse<T>>;
}

export type OddsProvider<T = unknown> = ProviderPort<T>;
export type ScheduleProvider<T = unknown> = ProviderPort<T>;
export type StatsProvider<T = unknown> = ProviderPort<T>;
export type InjuryProvider<T = unknown> = ProviderPort<T>;
export type LineupProvider<T = unknown> = ProviderPort<T>;
export type WeatherProvider<T = unknown> = ProviderPort<T>;
export type PublicBettingProvider<T = unknown> = ProviderPort<T>;
export type ResultsProvider<T = unknown> = ProviderPort<T>;

export function supportsRequest(
  descriptor: ProviderDescriptor,
  capability: ProviderCapability,
  request: ProviderRequest,
): boolean {
  try {
    if (
      request === null ||
      typeof request !== "object" ||
      typeof request.sportKey !== "string" ||
      !request.sportKey ||
      request.sportKey !== request.sportKey.trim() ||
      (request.leagueKey !== undefined &&
        (typeof request.leagueKey !== "string" ||
          !request.leagueKey ||
          request.leagueKey !== request.leagueKey.trim())) ||
      (request.marketKeys !== undefined &&
        (!Array.isArray(request.marketKeys) ||
          request.marketKeys.some(
            (market) =>
              typeof market !== "string" || !market || market !== market.trim(),
          ) ||
          new Set(request.marketKeys).size !== request.marketKeys.length)) ||
      (capability !== "odds" && (request.marketKeys?.length ?? 0) > 0) ||
      !Array.isArray(descriptor.capabilities) ||
      !descriptor.capabilities.includes(capability) ||
      !Array.isArray(descriptor.coverage?.leagues)
    ) {
      return false;
    }
    for (const item of descriptor.coverage.leagues as readonly unknown[]) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const pair = item as Record<string, unknown>;
      const pairCapabilities = pair["capabilities"];
      const pairMarkets = pair["marketKeys"];
      if (
        pair["sportKey"] === request.sportKey &&
        (request.leagueKey === undefined ||
          pair["leagueKey"] === request.leagueKey) &&
        Array.isArray(pairCapabilities) &&
        (pairCapabilities as readonly unknown[]).includes(capability) &&
        Array.isArray(pairMarkets) &&
        (request.marketKeys ?? []).every((market) =>
          (pairMarkets as readonly unknown[]).includes(market),
        )
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export * from "./the-odds-api";
export * from "./sharp-api";

export * from "./coverage-registry";
export * from "./upcoming-events";
export * from "./fixtures/mlb-schedule";
export * from "./fixtures/mls-schedule";
export * from "./fixtures/mvp-odds";

export * from "./coverage-registry";
