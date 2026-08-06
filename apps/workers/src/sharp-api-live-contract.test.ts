import { describe, expect, it } from "vitest";
import {
  MemoryBettingSplitRepository,
  MemoryEventIngestionStore,
  MemoryOddsControlPlaneStore,
} from "@find-the-edge/database";
import { productionOddsCollectionPolicies } from "@find-the-edge/config";
import {
  fetchSharpApiAccount,
  fetchSharpApiOddsPage,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  SharpApiError,
  sharpApiLeagueByKey,
  sharpApiLeagues,
} from "@find-the-edge/providers";

import {
  ingestSharpApi,
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
  type SharpApiOddsPersister,
} from "./sharp-api-ingestion";
import { runProductionOddsControlPlane } from "./production-odds-control-plane";
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

    const hasPregameApprovedEvidence = page.events.some(
      (event) =>
        Date.parse(event.startsAt) > Date.parse(page.retrievedAt) &&
        event.bookmakers.some(
          (book) =>
            policy.books[book.id] &&
            book.prices.some(
              (price) =>
                price.isMainLine &&
                !price.isAlternateLine &&
                !price.isPlayerProp &&
                !price.isStalePregamePrice &&
                price.isActive !== false &&
                !price.isSuspended &&
                Date.parse(price.observedAt) < Date.parse(event.startsAt),
            ),
        ),
    );
    if (hasPregameApprovedEvidence)
      expect(persisted.observations).toBeGreaterThan(0);
    else expect(persisted.observations).toBe(0);
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
    expect(summary.observations).toBeGreaterThan(0);
    expect(summary.observations).toBe(writes);
    expect(events.events.size).toBeGreaterThan(0);
    expect(events.mappings.size).toBeGreaterThanOrEqual(events.events.size);
    if (summary.splitsEntitled) expect(summary.splits).toBeGreaterThan(0);
  }, 120_000);

  it("parses complete odds pagination for every production league locally", async () => {
    const failures: {
      readonly leagueKey: string;
      readonly requestKind: "initial" | "cursor";
      readonly status?: number;
      readonly code: string;
      readonly stage?: string;
    }[] = [];

    for (const league of sharpApiLeagues) {
      let cursor: string | undefined;
      let reachedTerminalPage = false;
      const cursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        let status: number | undefined;
        try {
          const page = await fetchSharpApiOddsPage(
            league,
            apiKey!,
            cursor,
            async (...args) => {
              const response = await fetch(...args);
              status = response.status;
              return response;
            },
          );
          if (!page.hasMore) {
            reachedTerminalPage = true;
            break;
          }
          expect(page.nextCursor).toBeTruthy();
          expect(cursors.has(page.nextCursor!)).toBe(false);
          cursors.add(page.nextCursor!);
          cursor = page.nextCursor;
        } catch (error) {
          failures.push({
            leagueKey: league.leagueKey,
            requestKind: cursor ? "cursor" : "initial",
            ...(status === undefined ? {} : { status }),
            code: error instanceof Error ? error.message : typeof error,
            ...(error instanceof SharpApiError && error.stage
              ? { stage: error.stage }
              : {}),
          });
          break;
        }
      }
      if (
        !reachedTerminalPage &&
        !failures.some(({ leagueKey }) => leagueKey === league.leagueKey)
      )
        failures.push({
          leagueKey: league.leagueKey,
          requestKind: cursor ? "cursor" : "initial",
          code: "page-limit-exceeded",
        });
    }

    expect(failures).toEqual([]);
  }, 300_000);

  it("runs the complete production control plane locally against SharpAPI", async () => {
    const events = new MemoryEventIngestionStore();
    const splits = new MemoryBettingSplitRepository();
    const control = new MemoryOddsControlPlaneStore();
    let observations = 0;
    const persistedBooks = new Set<string>();
    const recordingOdds: SharpApiOddsPersister = {
      persist: ({ observation }) => {
        observations += 1;
        persistedBooks.add(observation.sportsbookId);
        return Promise.resolve({
          snapshot: "created",
          current: "advanced",
          value: observation as never,
        });
      },
      persistAvailability: () => Promise.resolve(),
    };

    const summary = await runProductionOddsControlPlane({
      events,
      odds: recordingOdds,
      splits,
      control,
      sharpApiKey: apiKey!,
      forceRefresh: true,
    });

    expect(summary).toHaveLength(sharpApiLeagues.length);
    expect(summary.every(({ status }) => status === "completed")).toBe(true);
    expect(observations).toBeGreaterThan(0);
    expect(persistedBooks.size).toBeGreaterThan(0);
  }, 300_000);
});
