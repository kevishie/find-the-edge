import type {
  FeedCapability,
  FeedCoverageRegistration,
  InactiveFeedPolicy,
  SportKey,
} from "@find-the-edge/domain";
import { productionSportsbookRoles } from "./sportsbooks";

export const feedCoverageCatalogVersion = "2026-08-04.v7";
export const oddsCollectionPolicyVersion =
  "2026-08-04.control-plane.sharpapi-pro.v3";

export type OddsBookRole = "offered" | "comparison" | "splits";
export interface OddsProviderPolicy {
  readonly providerId: string;
  readonly role: "primary" | "fallback";
  readonly active: boolean;
  readonly quotaReserve: number;
  readonly cooldownSeconds: number;
  readonly failbackSuccesses: number;
  readonly books: Readonly<Record<string, OddsBookRole>>;
}
export interface LeagueOddsCollectionPolicy {
  readonly leagueKey: "mlb" | "mls";
  readonly baseCadenceSeconds: number;
  readonly nearStart: {
    readonly windowSeconds: number;
    readonly cadenceSeconds: number;
  };
  readonly markets: readonly string[];
  readonly providers: readonly OddsProviderPolicy[];
}
export interface ScheduleDiscoveryPolicy {
  readonly providerId: string;
  readonly role: "primary" | "fallback";
  readonly cadenceSeconds: number;
  readonly quotaReserve: number;
  readonly requestCost: number;
}

const productionOddsBooks: Readonly<Record<string, OddsBookRole>> =
  productionSportsbookRoles;
/** Schedule requests have an explicit budget independent from odds reserves. */
export const productionScheduleDiscoveryPolicies: readonly ScheduleDiscoveryPolicy[] =
  deepFreeze([
    {
      providerId: "sharpapi",
      role: "primary",
      cadenceSeconds: 3_600,
      quotaReserve: 20,
      requestCost: 1,
    },
  ]);

const providerPolicy = (
  leagueKey: "mlb" | "mls",
): LeagueOddsCollectionPolicy => ({
  leagueKey,
  baseCadenceSeconds: 3_600,
  nearStart: {
    windowSeconds: leagueKey === "mlb" ? 5_400 : 7_200,
    cadenceSeconds: leagueKey === "mlb" ? 900 : 1_800,
  },
  markets:
    leagueKey === "mlb"
      ? ["moneyline", "spread", "total"]
      : ["moneyline", "spread", "total"],
  providers: [
    {
      providerId: "sharpapi",
      role: "primary",
      active: true,
      quotaReserve: 100,
      cooldownSeconds: 900,
      failbackSuccesses: 2,
      books: productionOddsBooks,
    },
  ],
});

/** Versioned, immutable production policy. Scheduling ticks do not imply paid calls. */
export const productionOddsCollectionPolicies: readonly LeagueOddsCollectionPolicy[] =
  deepFreeze([providerPolicy("mlb"), providerPolicy("mls")]);
const capabilities = ["schedule", "odds", "results"] as const;

function enabledLeague(
  sportKey: SportKey,
  leagueKey: string,
  leagueName: string,
  oddsMarkets: readonly [string, ...string[]],
): FeedCoverageRegistration[] {
  return capabilities.map((capability) => {
    const common = {
      sportKey,
      leagueKey,
      leagueName,
      allowlistState: "enabled" as const,
      providerId: "fixture-development",
      maturity: "development" as const,
      cadence: {
        mode: "interval" as const,
        seconds: capability === "odds" ? 900 : 3600,
      },
      quotaEstimate: {
        requestsPerRun: 1,
        requestsPerDay: capability === "odds" ? 96 : 24,
      },
      active: true as const,
    };
    return capability === "odds"
      ? {
          ...common,
          capability,
          supportedMarketKeys: [...oddsMarkets] as [string, ...string[]],
        }
      : { ...common, capability, supportedMarketKeys: [] };
  });
}

function plannedLeague(
  sportKey: SportKey,
  leagueKey: string,
  leagueName: string,
): InactiveFeedPolicy[] {
  return capabilities.map((capability: FeedCapability) => ({
    sportKey,
    leagueKey,
    leagueName,
    allowlistState: "planned",
    capability,
    supportedMarketKeys: [],
    active: false,
    unsupportedReason: "league-planned",
  }));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const defaultFeedCoveragePolicies: readonly FeedCoverageRegistration[] =
  deepFreeze([
    ...enabledLeague("mlb" as SportKey, "mlb", "Major League Baseball", [
      "moneyline",
      "spread",
    ]),
    ...enabledLeague("soccer" as SportKey, "mls", "Major League Soccer", [
      "moneyline",
      "spread",
    ]),
    ...plannedLeague("tennis" as SportKey, "atp", "ATP Tour"),
    ...plannedLeague("nfl" as SportKey, "nfl", "National Football League"),
    ...plannedLeague(
      "nba" as SportKey,
      "nba",
      "National Basketball Association",
    ),
    ...plannedLeague(
      "soccer" as SportKey,
      "international",
      "International Soccer",
    ),
  ]);
