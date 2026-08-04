import { describe, expect, it, vi } from "vitest";
import type {
  BettingSplitRepository,
  EventIngestionStore,
} from "@find-the-edge/database";
import type {
  CanonicalEvent,
  CanonicalEventBootstrap,
  IsoTimestamp,
} from "@find-the-edge/domain";
import type { SharpApiLeague } from "@find-the-edge/providers";

import {
  ingestSharpApi,
  type SharpApiOddsPersister,
} from "./sharp-api-ingestion";

describe("SharpAPI primary ingestion", () => {
  it("persists main odds and entitled splits with exact provider bindings", async () => {
    const bindings = new Map<string, CanonicalEvent>();
    const resolveExactCanonicalBinding = vi.fn(
      ({
        providerEventId,
      }: Parameters<EventIngestionStore["resolveExactCanonicalBinding"]>[0]) =>
        Promise.resolve(bindings.get(providerEventId) ?? null),
    );
    const bootstrapCanonicalEvent = vi.fn(
      (bootstrap: CanonicalEventBootstrap) => {
        bindings.set(`${bootstrap.leagueKey}-event_2026-08-03_b3`, {
          id: bootstrap.id,
          version: 1,
          sportKey: bootstrap.sportKey,
          participantLabels: ["Away Club", "Home Club"],
        } as unknown as CanonicalEvent);
        return Promise.resolve("created" as const);
      },
    );
    const ingestEvent = vi.fn(
      (input: Parameters<EventIngestionStore["ingestEvent"]>[0]) =>
        Promise.resolve(
          bindings.has(input.providerEventId)
            ? { kind: "updated" as const, eventId: input.providerEventId }
            : { kind: "unresolved" as const, reason: "no-candidate" as const },
        ),
    );
    const store = {
      resolveExactCanonicalBinding,
      bootstrapCanonicalEvent,
      ingestEvent,
      findNearCanonicalCandidates: vi.fn(() => Promise.resolve([])),
      reconcileScheduledEvent: vi.fn(
        ({
          event,
          bootstrap,
        }: Parameters<EventIngestionStore["reconcileScheduledEvent"]>[0]) =>
          bootstrapCanonicalEvent(bootstrap).then(() => ingestEvent(event)),
      ),
    } as unknown as EventIngestionStore;
    const oddsPersist = vi.fn(
      (input: Parameters<SharpApiOddsPersister["persist"]>[0]) => {
        void input;
        return Promise.resolve({});
      },
    );
    const odds = { persist: oddsPersist };
    const splitPersist = vi.fn(
      (input: Parameters<BettingSplitRepository["persist"]>[0]) =>
        Promise.resolve({
          history: "inserted",
          current: "advanced",
          observation: input,
        }),
    );
    const splits = {
      persist: splitPersist,
      current: vi.fn(),
      listCurrent: vi.fn(),
      persistGap: vi.fn(),
    } as unknown as BettingSplitRepository;
    const fetchOddsPage = vi.fn((league: SharpApiLeague) => {
      const eventId = `${league.leagueKey}-event_2026-08-03_b3`;
      return Promise.resolve({
        events: [
          {
            providerEventId: eventId,
            providerEventUuid: `${eventId}-uuid`,
            awayTeam: "Away Club",
            homeTeam: "Home Club",
            startsAt: "2026-08-04T00:00:00.000Z" as IsoTimestamp,
            bookmakers: [
              {
                id: "draftkings",
                label: "DraftKings",
                prices: [
                  {
                    providerPriceId: `${eventId}-price`,
                    marketKey: league.moneylineMarket,
                    providerMarketType: "moneyline",
                    providerMarketId: "market-1",
                    selectionKey: "away" as const,
                    selectionLabel: "Away Club",
                    providerSelectionId: "selection-1",
                    americanOdds: 120,
                    decimalOdds: 2.2,
                    impliedProbability: 0.4545,
                    isLive: false,
                    isMainLine: true,
                    isAlternateLine: false,
                    isPlayerProp: false,
                    isStalePregamePrice: false,
                    observedAt: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
                  },
                  {
                    providerPriceId: `${eventId}-price-home`,
                    marketKey: league.moneylineMarket,
                    providerMarketType: "moneyline",
                    providerMarketId: "market-1",
                    selectionKey: "home" as const,
                    selectionLabel: "Home Club",
                    providerSelectionId: "selection-home",
                    americanOdds: -130,
                    decimalOdds: 1.77,
                    impliedProbability: 0.565,
                    isLive: false,
                    isMainLine: true,
                    isAlternateLine: false,
                    isPlayerProp: false,
                    isStalePregamePrice: false,
                    observedAt: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
                  },
                  ...(league.leagueKey === "mls"
                    ? [
                        {
                          providerPriceId: `${eventId}-price-draw`,
                          marketKey: league.moneylineMarket,
                          providerMarketType: "moneyline_3-way",
                          providerMarketId: "market-1",
                          selectionKey: "draw" as const,
                          selectionLabel: "Draw",
                          providerSelectionId: "selection-draw",
                          americanOdds: 240,
                          decimalOdds: 3.4,
                          impliedProbability: 0.294,
                          isLive: false,
                          isMainLine: true,
                          isAlternateLine: false,
                          isPlayerProp: false,
                          isStalePregamePrice: false,
                          observedAt:
                            "2026-08-03T23:00:00.000Z" as IsoTimestamp,
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
          {
            providerEventId: `${league.leagueKey}-props_2026-08-03_b3`,
            providerEventUuid: `${league.leagueKey}-props-uuid`,
            awayTeam: "Away Club - Player Props",
            homeTeam: "Home Club - Player Props",
            startsAt: "2026-08-04T00:00:00.000Z" as IsoTimestamp,
            bookmakers: [],
          },
        ],
        hasMore: false,
        retrievedAt: "2026-08-03T23:00:01.000Z" as IsoTimestamp,
      });
    });
    const fetchSchedulePage = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            providerEventId: `${league.leagueKey}-event_2026-08-03_b3`,
            awayTeam: "Away Club",
            homeTeam: "Home Club",
            startsAt: "2026-08-04T00:00:00.000Z" as IsoTimestamp,
            status: "scheduled" as const,
          },
        ],
        hasMore: false,
        retrievedAt: "2026-08-03T22:59:00.000Z" as IsoTimestamp,
      }),
    );
    const fetchSplitsPage = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        items: [
          {
            providerEventId: `${league.leagueKey}-event_2026-08-03`,
            sport: league.leagueKey === "mlb" ? "baseball" : "soccer",
            league: league.leagueKey,
            sportsbookId: "consensus",
            awayTeam: "Away Club",
            homeTeam: "Home Club",
            providerTimestamp: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline" as const,
                selections: [
                  {
                    selectionKey: "away" as const,
                    americanOdds: 120,
                    betPercent: 40,
                    moneyPercent: 60,
                  },
                ],
              },
            ],
          },
        ],
        hasMore: false,
        retrievedAt: "2026-08-03T23:00:01.000Z" as IsoTimestamp,
      }),
    );

    const result = await ingestSharpApi(store, odds as never, splits, "key", {
      fetchAccount: () =>
        Promise.resolve({
          tier: "pro",
          features: ["odds", "schedule", "splits"],
          requestsPerMinute: 300,
          maxBooks: 15,
          streamingEnabled: false,
        }),
      fetchOddsPage,
      fetchSchedulePage,
      fetchSplitsPage,
    });

    expect(result).toMatchObject({
      leagues: 2,
      events: 2,
      observations: 5,
      splits: 2,
      splitsEntitled: true,
    });
    expect(oddsPersist).toHaveBeenCalledTimes(5);
    expect(splitPersist).toHaveBeenCalledTimes(2);
    expect(
      splitPersist.mock.calls.map(([input]) => input.providerEventId),
    ).toEqual(["mlb-event_2026-08-03", "mls-event_2026-08-03"]);
    expect(splitPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "consensus",
        betPercent: 40,
        moneyPercent: 60,
      }),
    );
  });
});
