import type {
  FeedCapability,
  FeedCoverageRegistration,
  InactiveFeedPolicy,
  SportKey,
} from "@find-the-edge/domain";

export const feedCoverageCatalogVersion = "2026-07-30.v5";
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
      "run_line",
    ]),
    ...enabledLeague("soccer" as SportKey, "mls", "Major League Soccer", [
      "three_way_moneyline",
    ]),
    ...plannedLeague("tennis" as SportKey, "atp", "ATP Tour"),
    ...plannedLeague("nfl" as SportKey, "nfl", "National Football League"),
    ...plannedLeague(
      "basketball" as SportKey,
      "nba",
      "National Basketball Association",
    ),
    ...plannedLeague(
      "soccer" as SportKey,
      "international",
      "International Soccer",
    ),
  ]);
