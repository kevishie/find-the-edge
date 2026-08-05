import { describe, expect, it } from "vitest";
import {
  MemoryBettingSplitRepository,
  MemoryEventIngestionStore,
} from "@find-the-edge/database";
import { productionOddsCollectionPolicies } from "@find-the-edge/config";
import {
  fetchSharpApiAccount,
  fetchSharpApiOddsPage,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  sharpApiLeagueByKey,
} from "@find-the-edge/providers";

import {
  ingestSharpApi,
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
  type SharpApiOddsPersister,
} from "./sharp-api-ingestion";
import { reconcileScheduledProviderEvent } from "./schedule-reconciliation";

const apiKey = process.env["SHARP_API_KEY"];

describe.skipIf(!apiKey)("SharpAPI live contract", () => {
  const odds: SharpApiOddsPersister = {
    persist: ({ observation }) =>
      Promise.resolve({
        snapshot: "created",
        current: "advanced",
        value: observation as never,
      }),
    persistAvailability: () => Promise.resolve(),
  };

  it("persists the current MLB schedule, odds, and splits locally", async () => {
    const events = new MemoryEventIngestionStore();
    const splits = new MemoryBettingSplitRepository();
    const league = sharpApiLeagueByKey("mlb");
    const schedule = await fetchSharpApiSchedulePage(league, apiKey!);
    for (const raw of schedule.events)
      await reconcileScheduledProviderEvent(
        events,
        "sharpapi",
        {
          providerEventId: raw.providerEventId,
          sportKey: league.sportKey,
          leagueKey: league.leagueKey,
          participantLabels: [raw.awayTeam, raw.homeTeam],
          ...(raw.awayClubKey && raw.homeClubKey
            ? {
                participantIdentityKeys: [raw.awayClubKey, raw.homeClubKey] as [
                  string,
                  string,
                ],
              }
            : {}),
          startsAt: raw.startsAt,
          status: "scheduled",
          revision: {
            providerId: "sharpapi",
            authorityRank: 60,
            updatedAt: schedule.retrievedAt,
            sequence: 0,
            token: schedule.retrievedAt,
          },
        },
        schedule.retrievedAt,
      );
    const page = await fetchSharpApiOddsPage(league, apiKey!);
    const policy = productionOddsCollectionPolicies
      .find(({ leagueKey }) => leagueKey === league.leagueKey)!
      .providers.find(({ providerId }) => providerId === "sharpapi")!;
    const persisted = await persistSharpApiOddsPage(
      events,
      odds,
      league,
      page,
      policy.books,
      undefined,
      policy.expectedBooks,
    );

    expect(persisted.events).toBeGreaterThan(0);
    expect(persisted.observations).toBeGreaterThan(0);
    expect(persisted.canonicalOddsEvents).toHaveLength(persisted.events);
    const account = await fetchSharpApiAccount(apiKey!);
    if (account.features.includes("splits")) {
      const splitPage = await fetchSharpApiSplitsPage(league, apiKey!);
      const count = await persistSharpApiSplitPage(
        events,
        splits,
        league,
        splitPage,
        persisted.canonicalOddsEvents,
      );
      expect(count).toBeGreaterThan(0);
    }
  }, 120_000);

  it("ingests the current schedule, odds, and entitled splits locally", async () => {
    const events = new MemoryEventIngestionStore();
    const splits = new MemoryBettingSplitRepository();
    let writes = 0;
    const recordingOdds: SharpApiOddsPersister = {
      persist: ({ observation }) => {
        writes += 1;
        return Promise.resolve({
          snapshot: "created",
          current: "advanced",
          value: observation as never,
        });
      },
      persistAvailability: () => Promise.resolve(),
    };

    const summary = await ingestSharpApi(
      events,
      recordingOdds,
      splits,
      apiKey!,
    );

    expect(summary.leagues).toBeGreaterThan(0);
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.observations).toBe(writes);
    expect(events.events.size).toBeGreaterThan(0);
    expect(events.mappings.size).toBeGreaterThanOrEqual(events.events.size);
    if (summary.splitsEntitled) expect(summary.splits).toBeGreaterThan(0);
  }, 120_000);
});
