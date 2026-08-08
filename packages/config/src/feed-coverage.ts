import type {
  FeedCapability,
  FeedCoverageRegistration,
  InactiveFeedPolicy,
  ProviderStatusCapability,
  SportKey,
} from "@find-the-edge/domain";
import { approvedSportsbookCollection } from "./sportsbooks";

export const feedCoverageCatalogVersion = "2026-08-04.v7";
export const oddsCollectionPolicyVersion =
  "2026-08-04.control-plane.sharpapi-pro.v3";

export type OddsBookRole = "offered" | "comparison" | "collected" | "splits";
export interface OddsProviderPolicy {
  readonly providerId: string;
  readonly role: "primary" | "fallback";
  readonly active: boolean;
  readonly quotaReserve: number;
  readonly cooldownSeconds: number;
  readonly failbackSuccesses: number;
  readonly books: Readonly<Record<string, OddsBookRole>>;
  /** Only these scoped books produce absence evidence. Collection alone does not. */
  readonly expectedBooks?: Readonly<Record<string, readonly string[]>>;
}
export interface LeagueOddsCollectionPolicy {
  readonly leagueKey:
    "mlb" | "mls" | "epl" | "liga-mx" | "uefa-champions-league";
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
  approvedSportsbookCollection;
/** Schedule requests have an explicit budget independent from odds reserves. */
export const productionScheduleDiscoveryPolicies: readonly ScheduleDiscoveryPolicy[] =
  deepFreeze([
    {
      providerId: "sharpapi",
      role: "primary",
      // The scheduler ticks once a minute and the schedule refresh rides
      // every tick: the games catalog is the source of truth for the board.
      cadenceSeconds: 60,
      quotaReserve: 20,
      requestCost: 1,
    },
  ]);

const providerPolicy = (
  leagueKey: LeagueOddsCollectionPolicy["leagueKey"],
): LeagueOddsCollectionPolicy => ({
  leagueKey,
  // Lines refresh on every one-minute scheduler tick; the near-start window
  // keeps a faster nominal cadence so a tick can never skip it.
  baseCadenceSeconds: 60,
  nearStart: {
    windowSeconds: leagueKey === "mlb" ? 5_400 : 7_200,
    cadenceSeconds: 30,
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
      expectedBooks: {
        // Only canary-verified league/market expectations belong here.
        // Collection approval alone never implies expected coverage.
        ...(leagueKey === "mlb" ? { pinnacle: ["moneyline"] } : {}),
      },
    },
  ],
});

/** Versioned, immutable production policy. Scheduling ticks do not imply paid calls. */
export const productionOddsCollectionPolicies: readonly LeagueOddsCollectionPolicy[] =
  deepFreeze([
    providerPolicy("mlb"),
    providerPolicy("mls"),
    providerPolicy("epl"),
    providerPolicy("liga-mx"),
    providerPolicy("uefa-champions-league"),
  ]);

export interface ProductionProviderStatusScope {
  readonly scopeId: string;
  readonly healthKey: string;
  readonly providerId: "sharpapi";
  readonly providerName: "SharpAPI";
  readonly sportKey: "mlb" | "soccer" | null;
  readonly leagueKey: string;
  readonly capability: ProviderStatusCapability;
  readonly purpose: string;
  readonly supportedData: readonly string[];
  readonly expectedFreshnessSeconds: number;
  readonly reserve: number;
}

const providerStatusLeague = (leagueKey: string) => ({
  sportKey: leagueKey === "mlb" ? ("mlb" as const) : ("soccer" as const),
  leagueKey,
});

/** Exact public-status catalog. It deliberately describes production SharpAPI
 * collection rather than fixture-development coverage. */
export const productionProviderStatusCatalog: readonly ProductionProviderStatusScope[] =
  deepFreeze([
    {
      scopeId: "sharpapi:account",
      healthKey: "sharpapi:account:account",
      providerId: "sharpapi",
      providerName: "SharpAPI",
      sportKey: null,
      leagueKey: "account",
      capability: "account",
      purpose: "Connection and request-window metadata",
      supportedData: ["Provider connectivity", "Request-window telemetry"],
      expectedFreshnessSeconds: 900,
      reserve: productionScheduleDiscoveryPolicies[0]!.quotaReserve,
    },
    ...productionOddsCollectionPolicies.flatMap((policy) => {
      const league = providerStatusLeague(policy.leagueKey);
      const provider = policy.providers[0]!;
      return (
        [
          {
            capability: "schedule",
            purpose: "Upcoming event discovery",
            supportedData: ["Schedules", "Event status"],
            expectedFreshnessSeconds:
              productionScheduleDiscoveryPolicies[0]!.cadenceSeconds,
            reserve: productionScheduleDiscoveryPolicies[0]!.quotaReserve,
          },
          {
            capability: "odds",
            purpose: "Sportsbook prices and market availability",
            supportedData: [...policy.markets],
            expectedFreshnessSeconds: policy.baseCadenceSeconds,
            reserve: provider.quotaReserve,
          },
          {
            capability: "splits",
            purpose: "Public betting splits",
            supportedData: ["Bet percentage", "Money percentage"],
            expectedFreshnessSeconds: 900,
            reserve: provider.quotaReserve,
          },
        ] as const
      ).map((entry) => ({
        scopeId: `sharpapi:${policy.leagueKey}:${entry.capability}`,
        healthKey: `sharpapi:${policy.leagueKey}:${entry.capability}`,
        providerId: "sharpapi" as const,
        providerName: "SharpAPI" as const,
        ...league,
        ...entry,
      }));
    }),
  ]);
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
