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
  sportKeys: SportKey[];
  leagueKeys: string[];
  marketKeys: string[];
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  capabilities: ProviderCapability[];
  coverage: ProviderCoverage;
  rateLimit?: {
    requests: number;
    windowSeconds: number;
  };
  expectedFreshnessSeconds: number;
  qualityTier: "unknown" | "development" | "standard" | "premium";
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
  if (!descriptor.capabilities.includes(capability)) return false;
  if (!descriptor.coverage.sportKeys.includes(request.sportKey)) return false;
  if (
    request.leagueKey &&
    descriptor.coverage.leagueKeys.length > 0 &&
    !descriptor.coverage.leagueKeys.includes(request.leagueKey)
  ) {
    return false;
  }
  return (request.marketKeys ?? []).every(
    (market) =>
      descriptor.coverage.marketKeys.length === 0 ||
      descriptor.coverage.marketKeys.includes(market),
  );
}
