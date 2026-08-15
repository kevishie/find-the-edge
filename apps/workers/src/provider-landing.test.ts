import { describe, expect, it, vi } from "vitest";
import type {
  ProviderLandingCheckpoint,
  ProviderLandingPutRecordsResult,
  ProviderLandingRecord,
  ProviderLandingStream,
} from "@find-the-edge/database";
import { MemoryOddsControlPlaneStore } from "@find-the-edge/database";
import type {
  SharpApiCatalogSnapshot,
  SharpApiUniversalEvent,
  SharpApiUniversalOddsRecord,
  SharpApiUniversalPage,
} from "@find-the-edge/providers";
import { SharpApiError } from "@find-the-edge/providers";
import { createHash } from "node:crypto";

import {
  buildSharpApiEventPartitions,
  runProviderLanding,
  SharedSharpApiAccountRateCoordinator,
  type ProviderLandingSource,
  type ProviderLandingStore,
} from "./provider-landing";

class MemoryLandingStore implements ProviderLandingStore {
  readonly checkpoints = new Map<
    ProviderLandingStream,
    ProviderLandingCheckpoint
  >();
  readonly records: ProviderLandingRecord[] = [];
  readonly positionClaims = new Map<string, number>();

  getCheckpoint(stream: ProviderLandingStream) {
    return Promise.resolve(this.checkpoints.get(stream) ?? null);
  }

  putRecords(
    records: readonly ProviderLandingRecord[],
  ): Promise<ProviderLandingPutRecordsResult> {
    this.records.push(...records);
    return Promise.resolve({
      crossPageDuplicateCount: 0,
      crossPageDuplicateRecordIds: [],
    });
  }

  putCheckpoint(
    checkpoint: ProviderLandingCheckpoint,
    expectedVersion: number | null,
  ) {
    const current = this.checkpoints.get(checkpoint.stream);
    if ((current?.version ?? null) !== expectedVersion)
      return Promise.reject(new Error("checkpoint-conflict"));
    this.checkpoints.set(checkpoint.stream, checkpoint);
    return Promise.resolve();
  }

  claimPosition(claim: {
    readonly stream: "events" | "odds";
    readonly sweepId: string;
    readonly slot: 0 | 1;
    readonly positionHash: string;
    readonly pageNumber: number;
  }) {
    const key = `${claim.stream}\u0000${claim.sweepId}\u0000${claim.slot}\u0000${claim.positionHash}`;
    const pageNumber = this.positionClaims.get(key);
    if (pageNumber === undefined) {
      this.positionClaims.set(key, claim.pageNumber);
      return Promise.resolve("claimed" as const);
    }
    return Promise.resolve(
      pageNumber === claim.pageNumber
        ? ("replay" as const)
        : ("cycle" as const),
    );
  }
}

const catalog = (
  overrides: Partial<SharpApiCatalogSnapshot> = {},
): SharpApiCatalogSnapshot => ({
  sports: [
    {
      providerSportId: "tennis",
      displayName: "Tennis",
      eventCount: 895,
      liveCount: 4,
      providerLeagueIds: ["atp"],
    },
  ],
  leagues: [
    {
      providerLeagueId: "atp",
      displayName: "ATP",
      providerSportId: "tennis",
      eventCount: 649,
      liveCount: 2,
    },
  ],
  quarantines: [],
  sourceRows: 2,
  providerUpdatedAt: "2026-08-14T20:00:00.000Z",
  retrievedAt: "2026-08-14T20:00:01.000Z" as never,
  ...overrides,
});

const event = (id: string): SharpApiUniversalEvent => ({
  providerEventId: id,
  externalIds: {},
  sport: "tennis",
  league: "atp",
  awayParticipant: "Player A",
  homeParticipant: "Player B",
  startsAt: "2026-08-15T12:00:00.000Z" as never,
  status: "upcoming",
  isLive: false,
  marketKeys: ["moneyline"],
  sportsbookIds: ["hardrock"],
});

const odds = (id: string): SharpApiUniversalOddsRecord => ({
  providerPriceId: id,
  providerEventId: "event-1",
  sport: "tennis",
  league: "atp",
  sportsbook: "hardrock",
  marketType: "moneyline",
  selection: "Player A",
  selectionType: "away",
  americanOdds: -115,
  providerTimestamp: "2026-08-14T20:00:00.000Z" as never,
  isLive: false,
});

const eventPage = (
  records: readonly SharpApiUniversalEvent[],
  overrides: Partial<SharpApiUniversalPage<SharpApiUniversalEvent>> = {},
): SharpApiUniversalPage<SharpApiUniversalEvent> => ({
  records,
  quarantines: [],
  sourceRows: records.length,
  hasMore: false,
  providerTotal: records.length,
  providerUpdatedAt: "2026-08-14T20:00:00.000Z",
  retrievedAt: "2026-08-14T20:00:02.000Z" as never,
  ...overrides,
});

const oddsPage = (
  records: readonly SharpApiUniversalOddsRecord[],
  overrides: Partial<SharpApiUniversalPage<SharpApiUniversalOddsRecord>> = {},
): SharpApiUniversalPage<SharpApiUniversalOddsRecord> => ({
  records,
  quarantines: [],
  sourceRows: records.length,
  hasMore: false,
  providerTotal: records.length,
  providerUpdatedAt: "2026-08-14T20:00:00.000Z",
  retrievedAt: "2026-08-14T20:00:03.000Z" as never,
  ...overrides,
});

const source = (
  overrides: Partial<ProviderLandingSource> = {},
): ProviderLandingSource => ({
  fetchCatalog: vi.fn(() => Promise.resolve(catalog())),
  fetchEvents: vi.fn(() => Promise.resolve(eventPage([event("event-1")]))),
  fetchOdds: vi.fn(() => Promise.resolve(oddsPage([odds("price-1")]))),
  ...overrides,
});

const oddsPositionHash = (cursor: string) =>
  createHash("sha256")
    .update(JSON.stringify({ stream: "odds", position: { cursor } }))
    .digest("hex")
    .slice(0, 32);

const oddsSuspectToken = (cursor: string) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        `provider-landing-position-suspect:${oddsPositionHash(cursor)}`,
      ),
    )
    .digest("hex")
    .slice(0, 32);

const saturatedCompactOddsHistory = (
  cursor: string,
  suspects: readonly string[] = [],
) => [
  oddsPositionHash(cursor),
  "c0000000000000000000000000000001",
  ...Array.from(
    { length: 3_932 },
    (_, index) => `b${index.toString(16).padStart(3, "0")}${"f".repeat(28)}`,
  ),
  "c1000000000000000000000000000001",
  "c2000000000000000000000000000001",
  ...suspects,
];

describe("universal provider landing", () => {
  it("derives bounded event filters from every catalog league without a sport allowlist", () => {
    const leagues = [
      ["mlb", "baseball", 900],
      ["nfl", "football", 1_500],
      ["usa_-_major_league_soccer", "soccer", 700],
      ["atp", "tennis", 1_100],
      ["zero_season", "rugby_union", 0],
    ].map(([providerLeagueId, providerSportId, eventCount]) => ({
      providerLeagueId: providerLeagueId as string,
      displayName: providerLeagueId as string,
      providerSportId: providerSportId as string,
      eventCount: eventCount as number,
      liveCount: 0,
    }));
    const sports = leagues.map(
      ({ providerLeagueId, providerSportId, eventCount }) => ({
        providerSportId,
        displayName: providerSportId,
        eventCount,
        liveCount: 0,
        providerLeagueIds: [providerLeagueId],
      }),
    );
    sports.push({
      providerSportId: "olympics",
      displayName: "olympics",
      eventCount: 1,
      liveCount: 0,
      providerLeagueIds: ["world_championships,_mens_singles"],
    });
    const partitions = buildSharpApiEventPartitions({ sports, leagues });
    expect(partitions.map(({ sport }) => sport).sort()).toEqual(
      sports.map(({ providerSportId }) => providerSportId).sort(),
    );
    expect(
      partitions.every(({ sport, leagues: members }) => {
        const query = new URLSearchParams({ sport });
        if (members) query.set("league", members.join(","));
        return (members?.length ?? 0) <= 50 && query.toString().length <= 3_800;
      }),
    ).toBe(true);
    expect(partitions).toContainEqual({ sport: "olympics" });
  });

  it("unions sequential sport and league catalogs without dropping a newly listed league", () => {
    expect(
      buildSharpApiEventPartitions({
        sports: [
          {
            providerSportId: "soccer",
            displayName: "Soccer",
            eventCount: 4_000,
            liveCount: 0,
            providerLeagueIds: ["league-a"],
          },
        ],
        leagues: [
          {
            providerLeagueId: "league-a",
            displayName: "League A",
            providerSportId: "soccer",
            eventCount: 2_000,
            liveCount: 0,
          },
          {
            providerLeagueId: "league-b",
            displayName: "League B",
            providerSportId: "soccer",
            eventCount: 2_000,
            liveCount: 0,
          },
        ],
      }),
    ).toEqual([
      { sport: "soccer", leagues: ["league-a"] },
      { sport: "soccer", leagues: ["league-b"] },
    ]);
  });

  it("reconciles and completes catalog-derived event partitions independently", async () => {
    const store = new MemoryLandingStore();
    const snapshot = catalog({
      sports: [
        {
          providerSportId: "tennis",
          displayName: "Tennis",
          eventCount: 3_001,
          liveCount: 0,
          providerLeagueIds: ["atp", "wta"],
        },
      ],
      leagues: [
        {
          providerLeagueId: "atp",
          displayName: "ATP",
          providerSportId: "tennis",
          eventCount: 3_000,
          liveCount: 0,
        },
        {
          providerLeagueId: "wta",
          displayName: "WTA",
          providerSportId: "tennis",
          eventCount: 1,
          liveCount: 0,
        },
      ],
      sourceRows: 3,
    });
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>((filter) =>
      Promise.resolve(
        eventPage([event(`event-${filter.leagues?.[0]}`)], {
          providerTotal: 1,
        }),
      ),
    );
    const result = await runProviderLanding({
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
        fetchOdds: vi.fn(() => Promise.resolve(oddsPage([]))),
      }),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });
    expect(result.catalog?.eventPartitions).toEqual([
      { sport: "tennis", leagues: ["atp"] },
      { sport: "tennis", leagues: ["wta"] },
    ]);
    expect(fetchEvents.mock.calls).toEqual([
      [{ sport: "tennis", leagues: ["atp"] }, 0],
      [{ sport: "tennis", leagues: ["wta"] }, 0],
    ]);
    expect(result.events).toMatchObject({
      status: "complete",
      eventPartitions: [
        { sport: "tennis", leagues: ["atp"] },
        { sport: "tennis", leagues: ["wta"] },
      ],
      counts: {
        pages: 2,
        sourceRows: 2,
        landedRows: 2,
        quarantinedRows: 0,
      },
    });
    expect(result.events?.providerTotal).toBeUndefined();
  });

  it("splits a live event partition that exceeds the documented offset reach", async () => {
    const store = new MemoryLandingStore();
    const snapshot = catalog({
      sports: [
        {
          providerSportId: "tennis",
          displayName: "Tennis",
          eventCount: 4_000,
          liveCount: 0,
          providerLeagueIds: ["atp", "wta"],
        },
      ],
      leagues: [
        {
          providerLeagueId: "atp",
          displayName: "ATP",
          providerSportId: "tennis",
          eventCount: 1_500,
          liveCount: 0,
        },
        {
          providerLeagueId: "wta",
          displayName: "WTA",
          providerSportId: "tennis",
          eventCount: 1_500,
          liveCount: 0,
        },
      ],
      sourceRows: 3,
    });
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>((filter) =>
      Promise.resolve(
        filter.leagues?.length === 2
          ? eventPage([], {
              hasMore: true,
              nextOffset: 200,
              providerTotal: 5_300,
            })
          : eventPage([event(`event-${filter.leagues?.[0]}`)], {
              providerTotal: 1,
            }),
      ),
    );
    const input = {
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
        fetchOdds: vi.fn(() => Promise.resolve(oddsPage([]))),
      }),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    };
    const first = await runProviderLanding(input);
    expect(first.events).toMatchObject({
      status: "running",
      eventPartitions: [
        { sport: "tennis", leagues: ["atp"] },
        { sport: "tennis", leagues: ["wta"] },
      ],
      counts: { pages: 0, sourceRows: 0 },
    });
    const second = await runProviderLanding(input);
    expect(second.events).toMatchObject({
      status: "complete",
      counts: { pages: 2, sourceRows: 2 },
    });
    expect(fetchEvents.mock.calls).toEqual([
      [{ sport: "tennis", leagues: ["atp", "wta"] }, 0],
      [{ sport: "tennis", leagues: ["atp"] }, 0],
      [{ sport: "tennis", leagues: ["wta"] }, 0],
    ]);
  });

  it("restarts a rejected non-initial odds cursor without a 24-hour stream pause", async () => {
    const store = new MemoryLandingStore();
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "stale-cursor",
        }),
      )
      .mockRejectedValueOnce(
        new SharpApiError(
          "provider-rejected",
          false,
          undefined,
          "universal-odds:http-400",
          "validation_error",
          400,
        ),
      )
      .mockResolvedValueOnce(oddsPage([odds("price-fresh")]));
    const input = {
      source: source({ fetchOdds }),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      oddsPageBudget: 1,
    };
    await runProviderLanding(input);
    const restarted = await runProviderLanding(input);
    expect(restarted.odds).toMatchObject({
      status: "running",
      position: { cursor: "__initial__" },
    });
    expect(restarted.odds?.resumeAfter).toBeUndefined();
    const completed = await runProviderLanding(input);
    expect(completed.odds?.status).toBe("complete");
    expect(fetchOdds.mock.calls).toEqual([
      [undefined],
      ["stale-cursor"],
      [undefined],
    ]);
  });

  it("self-heals a paused event filter only after the refreshed catalog changes its plan", async () => {
    const store = new MemoryLandingStore();
    let clock = "2026-08-15T12:00:00.000Z";
    const catalogFor = (league: string) =>
      catalog({
        sports: [
          {
            providerSportId: "tennis",
            displayName: "Tennis",
            eventCount: 3_001,
            liveCount: 0,
            providerLeagueIds: [league],
          },
        ],
        leagues: [
          {
            providerLeagueId: league,
            displayName: league.toUpperCase(),
            providerSportId: "tennis",
            eventCount: 3_001,
            liveCount: 0,
          },
        ],
      });
    const fetchCatalog = vi
      .fn<ProviderLandingSource["fetchCatalog"]>()
      .mockResolvedValueOnce(catalogFor("atp"))
      .mockResolvedValueOnce(catalogFor("wta"));
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockRejectedValueOnce(
        new SharpApiError(
          "provider-rejected",
          false,
          undefined,
          "universal-events:http-400",
          "invalid_filter",
          400,
        ),
      )
      .mockResolvedValueOnce(
        eventPage([event("event-wta")], {
          providerTotal: 1,
        }),
      );
    const input = {
      source: source({ fetchCatalog, fetchEvents }),
      store,
      now: () => new Date(clock),
    };
    await expect(runProviderLanding(input)).rejects.toMatchObject({
      code: "provider-rejected",
    });
    expect(store.checkpoints.get("events")).toMatchObject({
      eventPartitions: [{ sport: "tennis", leagues: ["atp"] }],
      pauseScope: "stream",
    });

    clock = "2026-08-15T12:16:00.000Z";
    const healed = await runProviderLanding(input);
    expect(healed.events).toMatchObject({
      status: "complete",
      eventPartitions: [{ sport: "tennis", leagues: ["wta"] }],
    });
    expect(fetchEvents.mock.calls).toEqual([
      [{ sport: "tennis", leagues: ["atp"] }, 0],
      [{ sport: "tennis", leagues: ["wta"] }, 0],
    ]);
  });

  it("migrates the deployed legacy offset checkpoint to the catalog plan and clears its stream pause", async () => {
    const store = new MemoryLandingStore();
    const initial = await runProviderLanding({
      source: source(),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });
    if (!initial.events) throw new Error("missing event checkpoint");
    store.checkpoints.set("events", {
      ...initial.events,
      version: initial.events.version + 1,
      status: "running",
      position: { offset: 5_000 },
      startedAt: "2026-08-15T12:01:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
      counts: {
        pages: 25,
        sourceRows: 5_000,
        landedRows: 5_000,
        quarantinedRows: 0,
        warningRows: 0,
      },
      visitedPositionHashes: [],
      resumeAfter: "2026-08-16T12:01:00.000Z",
      pauseScope: "stream",
    });
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>(() =>
      Promise.resolve(eventPage([event("event-migrated")])),
    );
    const migrated = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-15T12:16:00.000Z"),
    });
    expect(fetchEvents).toHaveBeenCalledWith({ sport: "tennis" }, 0);
    expect(migrated.events).toMatchObject({
      status: "complete",
      position: null,
      eventPartitions: [{ sport: "tennis" }],
    });
    expect(migrated.events?.resumeAfter).toBeUndefined();
  });

  it("reserves the shared account window for both catalog calls and every unfiltered page", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 700,
        resetsAt: "2026-08-14T20:05:00.000Z",
      },
      updatedAt: "2026-08-14T20:00:00.000Z",
    });
    const reserveAccountRate = vi.spyOn(control, "reserveAccountRate");
    const fetchCatalog = vi.fn(() =>
      Promise.resolve(
        catalog({
          responseMetadata: {
            rateWindow: {
              limit: 1_000,
              remaining: 698,
              resetsAt: "2026-08-14T20:05:00.000Z" as never,
            },
          },
        }),
      ),
    );
    const fetchEvents = vi.fn(() =>
      Promise.resolve(
        eventPage([event("event-1")], {
          responseMetadata: {
            rateWindow: {
              limit: 1_000,
              remaining: 697,
              resetsAt: "2026-08-14T20:05:00.000Z" as never,
            },
          },
        }),
      ),
    );
    const fetchOdds = vi.fn(() =>
      Promise.resolve(
        oddsPage([odds("price-1")], {
          responseMetadata: {
            rateWindow: {
              limit: 1_000,
              remaining: 696,
              resetsAt: "2026-08-14T20:05:00.000Z" as never,
            },
          },
        }),
      ),
    );
    await runProviderLanding({
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control),
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(
      reserveAccountRate.mock.calls.map(([, reserve, cost]) => [reserve, cost]),
    ).toEqual([
      [500, 2],
      [500, 1],
      [500, 1],
    ]);
    expect(fetchCatalog).toHaveBeenCalledOnce();
    expect(fetchEvents).toHaveBeenCalledWith({ sport: "tennis" }, 0);
    expect(fetchOdds).toHaveBeenCalledWith(undefined);
    expect((await control.getHealth(healthKey))?.rateWindow).toMatchObject({
      limit: 1_000,
      remaining: 696,
      resetsAt: "2026-08-14T20:05:00.000Z",
    });
  });

  it("fails closed before provider dispatch when the shared account reserve is unavailable", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:account:account",
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 500,
        resetsAt: "2026-08-14T20:05:00.000Z",
      },
      updatedAt: "2026-08-14T20:00:00.000Z",
    });
    const fetchCatalog = vi.fn<ProviderLandingSource["fetchCatalog"]>();
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>();
    const result = await runProviderLanding({
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control),
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.catalog).toMatchObject({
      status: "running",
      resumeAfter: "2026-08-14T20:05:00.000Z",
    });
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).not.toHaveBeenCalled();
  });

  it("waits once for the live owner to publish a new minute window before dispatch", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-14T20:00:00.000Z",
      },
      updatedAt: "2026-08-14T19:59:30.000Z",
    });
    let currentNow = new Date("2026-08-14T20:00:00.000Z");
    const order: string[] = [];
    const waitForRefresh = vi.fn(async () => {
      order.push("wait");
      currentNow = new Date("2026-08-14T20:00:05.000Z");
      await control.reserveAccountRate(
        healthKey,
        500,
        1,
        currentNow.toISOString(),
        {
          version: 1,
          limit: 1_000,
          resetsAt: "2026-08-14T20:00:00.000Z",
        },
      );
      await control.reconcileAccountRateWindow(
        healthKey,
        0,
        0,
        {
          limit: 1_000,
          remaining: 999,
          resetsAt: "2026-08-14T20:01:00.000Z",
        },
        currentNow.toISOString(),
      );
    });
    const fetchCatalog = vi.fn(() => {
      order.push("catalog");
      return Promise.resolve(catalog());
    });
    const result = await runProviderLanding({
      source: source({ fetchCatalog }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control, {
        recoverWindow: waitForRefresh,
        now: () => currentNow,
      }),
      now: () => currentNow,
    });
    expect(waitForRefresh).toHaveBeenCalledOnce();
    expect(order).toEqual(["wait", "catalog"]);
    expect(result).toMatchObject({
      catalog: { status: "complete" },
      events: { status: "complete" },
      odds: { status: "complete" },
    });
    expect((await control.getHealth(healthKey))?.rateWindow).toMatchObject({
      limit: 1_000,
      remaining: 995,
      resetsAt: "2026-08-14T20:01:00.000Z",
    });
  });

  it("does not reserve against an authoritative window that is about to reset", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-14T20:00:08.000Z",
      },
      updatedAt: "2026-08-14T19:59:30.000Z",
    });
    let currentNow = new Date("2026-08-14T20:00:00.000Z");
    const resetExpiredWindow = control.reserveAccountRate.bind(control);
    const reserveAccountRate = vi.spyOn(control, "reserveAccountRate");
    const waitForRefresh = vi.fn(async () => {
      currentNow = new Date("2026-08-14T20:00:10.000Z");
      await resetExpiredWindow(healthKey, 500, 1, currentNow.toISOString(), {
        version: 1,
        limit: 1_000,
        resetsAt: "2026-08-14T20:00:08.000Z",
      });
      await control.reconcileAccountRateWindow(
        healthKey,
        0,
        0,
        {
          limit: 1_000,
          remaining: 999,
          resetsAt: "2026-08-14T20:01:00.000Z",
        },
        currentNow.toISOString(),
      );
    });
    const admission = await new SharedSharpApiAccountRateCoordinator(control, {
      recoverWindow: waitForRefresh,
      now: () => currentNow,
    }).reserve(1, currentNow);
    expect(admission).toEqual({ admitted: true });
    expect(waitForRefresh).toHaveBeenCalledOnce();
    expect(reserveAccountRate).toHaveBeenCalledOnce();
    expect((await control.getHealth(healthKey))?.rateWindow?.remaining).toBe(
      998,
    );
  });

  it("recovers each distinct minute window during one long landing invocation", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-14T20:00:00.000Z",
      },
      updatedAt: "2026-08-14T19:59:30.000Z",
    });
    let currentNow = new Date("2026-08-14T20:00:05.000Z");
    const recoverWindow = vi.fn(async () => {
      const requestedAt = currentNow.toISOString();
      const probeUntil = new Date(currentNow.getTime() + 60_000).toISOString();
      const claimVersion = await control.claimAccountRateProbe(
        healthKey,
        requestedAt,
        probeUntil,
      );
      expect(claimVersion).toEqual(expect.any(Number));
      if (claimVersion === null)
        throw new Error("expected account probe claim");
      expect(
        await control.completeAccountRateProbe(
          healthKey,
          probeUntil,
          claimVersion,
          {
            limit: 1_000,
            remaining: 999,
            resetsAt: new Date(currentNow.getTime() + 55_000).toISOString(),
          },
          requestedAt,
        ),
      ).toBe(true);
    });
    const coordinator = new SharedSharpApiAccountRateCoordinator(control, {
      recoverWindow,
      now: () => currentNow,
    });
    await expect(coordinator.reserve(1, currentNow)).resolves.toEqual({
      admitted: true,
    });
    currentNow = new Date("2026-08-14T20:01:05.000Z");
    await expect(coordinator.reserve(1, currentNow)).resolves.toEqual({
      admitted: true,
    });
    expect(recoverWindow).toHaveBeenCalledTimes(2);
    expect((await control.getHealth(healthKey))?.rateWindow).toMatchObject({
      remaining: 998,
      resetsAt: "2026-08-14T20:02:00.000Z",
    });
  });

  it("recomputes the reserve after a concurrent authoritative window refresh", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 500,
        remaining: 400,
        resetsAt: "2026-08-14T20:05:00.000Z",
      },
      updatedAt: "2026-08-14T20:00:00.000Z",
    });
    const originalReserve = control.reserveAccountRate.bind(control);
    const reserveAccountRate = vi
      .spyOn(control, "reserveAccountRate")
      .mockImplementationOnce(async () => {
        const current = await control.getHealth(healthKey);
        if (!current) throw new Error("missing-test-health");
        await control.putHealth({
          ...current,
          rateWindow: {
            limit: 1_000,
            remaining: 700,
            resetsAt: "2026-08-14T20:06:00.000Z",
          },
          updatedAt: "2026-08-14T20:00:01.000Z",
        });
        return false;
      })
      .mockImplementation(originalReserve);
    const admission = await new SharedSharpApiAccountRateCoordinator(
      control,
    ).reserve(1, new Date("2026-08-14T20:00:02.000Z"));
    expect(admission).toEqual({ admitted: true });
    expect(reserveAccountRate.mock.calls.map(([, reserve]) => reserve)).toEqual(
      [250, 500],
    );
    expect((await control.getHealth(healthKey))?.rateWindow?.remaining).toBe(
      699,
    );
  });

  it("waits at most once and still fails closed when no owner refresh arrives", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:account:account",
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-14T20:00:00.000Z",
      },
      updatedAt: "2026-08-14T19:59:30.000Z",
    });
    const waitForRefresh = vi.fn(() => Promise.resolve());
    const fetchCatalog = vi.fn<ProviderLandingSource["fetchCatalog"]>();
    const result = await runProviderLanding({
      source: source({ fetchCatalog }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control, {
        recoverWindow: waitForRefresh,
        now: () => new Date("2026-08-14T20:00:10.000Z"),
      }),
      now: () => new Date("2026-08-14T20:00:00.000Z"),
    });
    expect(waitForRefresh).toHaveBeenCalledOnce();
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(result.catalog).toMatchObject({
      status: "running",
      pauseScope: "account",
    });
  });

  it("does not wait or dispatch when the refresh would consume the checkpoint safety budget", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:account:account",
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-14T20:00:00.000Z",
      },
      updatedAt: "2026-08-14T19:59:30.000Z",
    });
    const waitForRefresh = vi.fn(() => Promise.resolve());
    const fetchCatalog = vi.fn<ProviderLandingSource["fetchCatalog"]>();
    const result = await runProviderLanding({
      source: source({ fetchCatalog }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control, {
        recoverWindow: waitForRefresh,
        now: () => new Date("2026-08-14T20:00:00.000Z"),
        canRecoverWindow: () => false,
      }),
      now: () => new Date("2026-08-14T20:00:00.000Z"),
    });
    expect(waitForRefresh).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(result.catalog).toMatchObject({
      status: "running",
      pauseScope: "account",
    });
  });

  it("does not reserve or dispatch when the checkpoint safety budget expires during the wait", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-14T20:00:00.000Z",
      },
      updatedAt: "2026-08-14T19:59:30.000Z",
    });
    const reserveAccountRate = vi.spyOn(control, "reserveAccountRate");
    const waitForRefresh = vi.fn(async () => {
      await control.reconcileAccountRateWindow(
        healthKey,
        0,
        0,
        {
          limit: 1_000,
          remaining: 999,
          resetsAt: "2026-08-14T20:01:00.000Z",
        },
        "2026-08-14T20:00:10.000Z",
      );
    });
    const fetchCatalog = vi.fn<ProviderLandingSource["fetchCatalog"]>();
    const result = await runProviderLanding({
      source: source({ fetchCatalog }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control, {
        recoverWindow: waitForRefresh,
        now: () => new Date("2026-08-14T20:00:10.000Z"),
        canRecoverWindow: () => true,
        canDispatch: () => false,
      }),
      now: () => new Date("2026-08-14T20:00:00.000Z"),
    });
    expect(waitForRefresh).toHaveBeenCalledOnce();
    expect(reserveAccountRate).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(result.catalog).toMatchObject({
      status: "running",
      pauseScope: "account",
    });
  });

  it("circuit-breaks every paid stream on terminal shared account health", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:account:account",
      healthy: false,
      status: "unhealthy",
      failureClass: "terminal",
      failureReason: "unauthorized",
      consecutiveSuccesses: 0,
      rateWindow: { limit: 1_000, remaining: 900 },
      updatedAt: "2026-08-14T20:00:00.000Z",
    });
    const fetchCatalog = vi.fn<ProviderLandingSource["fetchCatalog"]>();
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>();
    await expect(
      runProviderLanding({
        source: source({ fetchCatalog, fetchEvents, fetchOdds }),
        store,
        accountRate: new SharedSharpApiAccountRateCoordinator(control),
        now: () => new Date("2026-08-14T20:00:05.000Z"),
      }),
    ).rejects.toThrow("provider-landing-account-terminal");
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).not.toHaveBeenCalled();
  });

  it("publishes a provider rate limit to the shared account row and stops every later stream", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 700,
        resetsAt: "2026-08-14T20:01:00.000Z",
      },
      updatedAt: "2026-08-14T20:00:00.000Z",
    });
    const fetchCatalog = vi.fn(() =>
      Promise.reject(
        new SharpApiError(
          "rate-limited",
          true,
          "2026-08-14T20:05:00.000Z" as never,
        ),
      ),
    );
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>();
    const result = await runProviderLanding({
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control),
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.catalog?.resumeAfter).toBe("2026-08-14T20:05:00.000Z");
    expect(fetchCatalog).toHaveBeenCalledOnce();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).not.toHaveBeenCalled();
    expect(await control.getHealth(healthKey)).toMatchObject({
      healthy: false,
      failureReason: "rate-limited",
      retryAt: "2026-08-14T20:05:00.000Z",
      rateWindow: {
        remaining: 0,
        resetsAt: "2026-08-14T20:05:00.000Z",
      },
    });
  });

  it.each(["configuration", "not-entitled", "unauthorized"] as const)(
    "persists an account-wide %s response as terminal before stopping",
    async (code) => {
      const store = new MemoryLandingStore();
      const control = new MemoryOddsControlPlaneStore();
      const healthKey = "sharpapi:account:account";
      await control.putHealth({
        providerId: "sharpapi",
        healthKey,
        healthy: true,
        consecutiveSuccesses: 1,
        rateWindow: { limit: 1_000, remaining: 700 },
        updatedAt: "2026-08-14T20:00:00.000Z",
      });
      const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
      const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>();
      await expect(
        runProviderLanding({
          source: source({
            fetchCatalog: vi.fn(() => Promise.reject(new SharpApiError(code))),
            fetchEvents,
            fetchOdds,
          }),
          store,
          accountRate: new SharedSharpApiAccountRateCoordinator(control),
          now: () => new Date("2026-08-14T20:00:05.000Z"),
        }),
      ).rejects.toMatchObject({ code });
      expect(fetchEvents).not.toHaveBeenCalled();
      expect(fetchOdds).not.toHaveBeenCalled();
      expect(await control.getHealth(healthKey)).toMatchObject({
        healthy: false,
        status: "unhealthy",
        failureClass: "terminal",
        failureReason: code,
      });
    },
  );

  it("keeps an ambiguous request charged and stops locally without poisoning live account health", async () => {
    const store = new MemoryLandingStore();
    const control = new MemoryOddsControlPlaneStore();
    const healthKey = "sharpapi:account:account";
    await control.putHealth({
      providerId: "sharpapi",
      healthKey,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 700,
        resetsAt: "2026-08-14T20:05:00.000Z",
      },
      updatedAt: "2026-08-14T20:00:00.000Z",
    });
    const blockAccountRateWindow = vi.spyOn(control, "blockAccountRateWindow");
    const fetchCatalog = vi.fn(() =>
      Promise.reject(new SharpApiError("provider-request-ambiguous")),
    );
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>();
    const result = await runProviderLanding({
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control),
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.catalog?.resumeAfter).toBe("2026-08-14T20:15:05.000Z");
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).not.toHaveBeenCalled();
    expect(blockAccountRateWindow).not.toHaveBeenCalled();
    expect(await control.getHealth(healthKey)).toMatchObject({
      healthy: true,
      rateWindow: { remaining: 698 },
    });
  });

  it("lands catalog, events, and odds without a configured sport or league", async () => {
    const store = new MemoryLandingStore();
    const result = await runProviderLanding({
      source: source(),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.catalog?.status).toBe("complete");
    expect(result.events?.lastCompletedCounts).toEqual({
      pages: 1,
      sourceRows: 1,
      landedRows: 1,
      quarantinedRows: 0,
      warningRows: 0,
    });
    expect(result.odds?.status).toBe("complete");
    expect(store.records.map(({ recordType }) => recordType)).toEqual([
      "catalog-sport",
      "catalog-league",
      "event",
      "odds",
    ]);
    expect(store.records.map(({ sport }) => sport).filter(Boolean)).toContain(
      "tennis",
    );
  });

  it("resumes exact offsets and cursors across bounded invocations", async () => {
    const store = new MemoryLandingStore();
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValueOnce(
        eventPage([event("event-1")], {
          hasMore: true,
          nextOffset: 200,
          providerTotal: 2,
        }),
      )
      .mockResolvedValueOnce(
        eventPage([event("event-2")], { providerTotal: 2 }),
      );
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "cursor-2",
          providerTotal: 2,
        }),
      )
      .mockResolvedValueOnce(oddsPage([odds("price-2")], { providerTotal: 2 }));
    const input = {
      source: source({ fetchEvents, fetchOdds }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      eventPageBudget: 1,
      oddsPageBudget: 1,
    };
    const first = await runProviderLanding(input);
    expect(first.events).toMatchObject({
      status: "running",
      position: { partition: 0, offset: 200 },
    });
    expect(first.odds).toMatchObject({
      status: "running",
      position: { cursor: "cursor-2" },
    });

    const second = await runProviderLanding(input);
    expect(fetchEvents).toHaveBeenLastCalledWith({ sport: "tennis" }, 200);
    expect(fetchOdds).toHaveBeenLastCalledWith("cursor-2");
    expect(second.events?.status).toBe("complete");
    expect(second.odds?.status).toBe("complete");
    expect(second.events?.counts.sourceRows).toBe(2);
    expect(second.odds?.counts.sourceRows).toBe(2);
  });

  it("keeps the prior completed generation addressable during the next sweep", async () => {
    const store = new MemoryLandingStore();
    let clock = "2026-08-14T20:00:05.000Z";
    const first = await runProviderLanding({
      source: source(),
      store,
      now: () => new Date(clock),
    });
    if (!first.events) throw new Error("missing completed event checkpoint");
    const completedSweepId = first.events.sweepId;
    clock = "2026-08-14T20:11:05.000Z";
    const second = await runProviderLanding({
      source: source({
        fetchEvents: vi.fn(() =>
          Promise.resolve(
            eventPage([event("event-next")], {
              hasMore: true,
              nextOffset: 200,
              providerTotal: 400,
            }),
          ),
        ),
      }),
      store,
      now: () => new Date(clock),
      eventPageBudget: 1,
    });
    expect(second.events).toMatchObject({
      status: "running",
      lastCompletedSlot: first.events.slot,
      lastCompletedSweepId: completedSweepId,
      lastCompletedAt: first.events.lastCompletedAt,
      lastCompletedCounts: first.events.lastCompletedCounts,
    });
    expect(second.events?.sweepId).not.toBe(completedSweepId);
    expect(second.events?.slot).not.toBe(first.events.slot);
  });

  it("represents each rejected row as quarantine and preserves valid siblings", async () => {
    const store = new MemoryLandingStore();
    const fetchEvents = vi.fn(() =>
      Promise.resolve(
        eventPage([event("event-1")], {
          sourceRows: 2,
          quarantines: [
            {
              rowIndex: 1,
              endpoint: "events",
              reason: "invalid-row",
              providerRecordId: "broken",
              sourceFields: ["id", "sport"],
            },
          ],
          providerTotal: 2,
        }),
      ),
    );
    const result = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.events?.counts).toEqual({
      pages: 1,
      sourceRows: 2,
      landedRows: 1,
      quarantinedRows: 1,
      warningRows: 0,
    });
    expect(
      store.records.find(({ recordType }) => recordType === "quarantine"),
    ).toMatchObject({
      endpoint: "events",
      value: { providerRecordId: "broken", reason: "invalid-row" },
    });
  });

  it("abandons and safely restarts a cyclic cursor sweep", async () => {
    const store = new MemoryLandingStore();
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "cursor-1",
          providerTotal: 100,
        }),
      )
      .mockResolvedValueOnce(
        oddsPage([odds("price-2")], {
          hasMore: true,
          nextCursor: "cursor-1",
          providerTotal: 100,
        }),
      );
    const result = await runProviderLanding({
      source: source({ fetchOdds }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      oddsPageBudget: 3,
    });
    expect(result.odds?.sweepId).toContain("odds:recovery-");
    expect(store.checkpoints.get("odds")).toMatchObject({
      status: "running",
      position: { cursor: "__initial__" },
      counts: { pages: 0 },
    });
  });

  it("continues the independent odds stream when event acquisition fails", async () => {
    const store = new MemoryLandingStore();
    await expect(
      runProviderLanding({
        source: source({
          fetchEvents: vi.fn(() =>
            Promise.reject(new Error("provider-unavailable")),
          ),
        }),
        store,
        now: () => new Date("2026-08-14T20:00:05.000Z"),
      }),
    ).rejects.toThrow("provider-unavailable");
    expect(store.checkpoints.get("events")?.status).toBe("running");
    expect(store.checkpoints.get("odds")?.status).toBe("complete");
  });

  it("stops cleanly on a shared invocation deadline after durable page progress", async () => {
    const store = new MemoryLandingStore();
    let checks = 0;
    const fetchEvents = vi.fn(() =>
      Promise.resolve(
        eventPage([event("event-1")], {
          hasMore: true,
          nextOffset: 200,
          providerTotal: 400,
        }),
      ),
    );
    const fetchOdds = vi.fn(() =>
      Promise.resolve(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "cursor-1",
        }),
      ),
    );
    const result = await runProviderLanding({
      source: source({ fetchEvents, fetchOdds }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      shouldContinue: () => {
        checks += 1;
        return checks <= 7;
      },
    });
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchOdds).toHaveBeenCalledTimes(1);
    expect(result.events).toMatchObject({
      status: "running",
      counts: { pages: 1 },
    });
    expect(result.odds).toMatchObject({
      status: "running",
      counts: { pages: 1 },
    });
  });

  it("abandons a terminal page whose provider total does not reconcile", async () => {
    const store = new MemoryLandingStore();
    const result = await runProviderLanding({
      source: source({
        fetchEvents: vi.fn(() =>
          Promise.resolve(eventPage([event("event-1")], { providerTotal: 2 })),
        ),
      }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.events?.sweepId).toContain("events:recovery-");
    expect(result.events).toMatchObject({
      status: "running",
      position: { offset: 0 },
      counts: { pages: 0 },
    });
    expect(store.checkpoints.get("events")?.pendingPage).toBeUndefined();
  });

  it("continues across mutable provider generations and records the terminal observation", async () => {
    const store = new MemoryLandingStore();
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValueOnce(
        eventPage([event("event-1")], {
          hasMore: true,
          nextOffset: 200,
          providerTotal: 2,
          providerUpdatedAt: "2026-08-14T20:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        eventPage([event("event-2")], {
          providerTotal: 2,
          providerUpdatedAt: "2026-08-14T20:01:00.000Z",
        }),
      );
    const result = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-14T20:02:00.000Z"),
      eventPageBudget: 2,
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(result.events).toMatchObject({
      status: "complete",
      counts: { pages: 2, sourceRows: 2, landedRows: 2 },
      providerUpdatedAt: "2026-08-14T20:01:00.000Z",
    });
    expect(result.events?.providerTotal).toBeUndefined();
  });

  it("abandons and restarts a non-immediate A-B-A cursor cycle", async () => {
    const store = new MemoryLandingStore();
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "cursor-a",
          providerTotal: 100,
        }),
      )
      .mockResolvedValueOnce(
        oddsPage([odds("price-2")], {
          hasMore: true,
          nextCursor: "cursor-b",
          providerTotal: 100,
        }),
      )
      .mockResolvedValueOnce(
        oddsPage([odds("price-3")], {
          hasMore: true,
          nextCursor: "cursor-a",
          providerTotal: 100,
        }),
      );
    const result = await runProviderLanding({
      source: source({ fetchOdds }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      oddsPageBudget: 4,
    });
    expect(fetchOdds).toHaveBeenCalledTimes(3);
    expect(result.odds?.sweepId).toContain("odds:recovery-");
    expect(store.checkpoints.get("odds")).toMatchObject({
      status: "running",
      position: { cursor: "__initial__" },
      counts: { pages: 0 },
    });
  });

  it("compacts cursor history and completes beyond 4,096 positions without restarting", async () => {
    const store = new MemoryLandingStore();
    const visitedPositionHashes = [
      oddsPositionHash("__initial__"),
      ...Array.from({ length: 4_095 }, (_, index) =>
        oddsPositionHash(`cursor-${index + 1}`),
      ),
    ];
    store.checkpoints.set("odds", {
      schemaVersion: "provider-landing-checkpoint-v1",
      providerId: "sharpapi",
      stream: "odds",
      version: 0,
      status: "running",
      sweepId: "odds:2026-08-14T19:00:00.000Z",
      slot: 0,
      position: { cursor: "cursor-4095" },
      startedAt: "2026-08-14T19:00:00.000Z",
      updatedAt: "2026-08-14T20:00:00.000Z",
      counts: {
        pages: 4_095,
        sourceRows: 4_095,
        landedRows: 4_095,
        quarantinedRows: 0,
        warningRows: 0,
      },
      providerTotal: 4_097,
      providerUpdatedAt: "2026-08-14T20:00:00.000Z",
      visitedPositionHashes,
    });
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-4096")], {
          hasMore: true,
          nextCursor: "cursor-4096",
          providerTotal: 4_097,
        }),
      )
      .mockResolvedValueOnce(
        oddsPage([odds("price-4097")], { providerTotal: 4_097 }),
      );
    const emit = vi.fn();
    const result = await runProviderLanding({
      source: source({ fetchOdds }),
      store,
      metrics: { emit },
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      oddsPageBudget: 2,
    });
    expect(fetchOdds).toHaveBeenNthCalledWith(1, "cursor-4095");
    expect(fetchOdds).toHaveBeenNthCalledWith(2, "cursor-4096");
    expect(result.odds).toMatchObject({
      status: "complete",
      sweepId: "odds:2026-08-14T19:00:00.000Z",
      counts: { pages: 4_097, sourceRows: 4_097 },
    });
    expect(result.odds?.visitedPositionHashes?.length).toBeLessThanOrEqual(
      4_096,
    );
    expect(new Set(result.odds?.visitedPositionHashes).size).toBe(
      result.odds?.visitedPositionHashes?.length,
    );
    expect(
      result.odds?.visitedPositionHashes?.every((value) =>
        /^[0-9a-f]{32}$/.test(value),
      ),
    ).toBe(true);
    expect(emit).not.toHaveBeenCalledWith(
      "ProviderLandingRecovery",
      expect.anything(),
      expect.anything(),
    );
  });

  it("treats a deterministic compact-history false positive as suspicion and still completes", async () => {
    const store = new MemoryLandingStore();
    store.checkpoints.set("odds", {
      schemaVersion: "provider-landing-checkpoint-v1",
      providerId: "sharpapi",
      stream: "odds",
      version: 0,
      status: "running",
      sweepId: "odds:2026-08-14T19:00:00.000Z",
      slot: 0,
      position: { cursor: "cursor-4095" },
      startedAt: "2026-08-14T19:00:00.000Z",
      updatedAt: "2026-08-14T20:00:00.000Z",
      counts: {
        pages: 4_095,
        sourceRows: 4_095,
        landedRows: 4_095,
        quarantinedRows: 0,
        warningRows: 0,
      },
      providerTotal: 4_097,
      providerUpdatedAt: "2026-08-14T20:00:00.000Z",
      visitedPositionHashes: saturatedCompactOddsHistory("cursor-4095"),
    });
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-4096")], {
          hasMore: true,
          nextCursor: "legitimate-new-cursor",
          providerTotal: 4_097,
        }),
      )
      .mockResolvedValueOnce(
        oddsPage([odds("price-4097")], { providerTotal: 4_097 }),
      );
    const emit = vi.fn();
    const result = await runProviderLanding({
      source: source({ fetchOdds }),
      store,
      metrics: { emit },
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      oddsPageBudget: 2,
    });
    expect(fetchOdds).toHaveBeenNthCalledWith(2, "legitimate-new-cursor");
    expect(result.odds).toMatchObject({
      status: "complete",
      sweepId: "odds:2026-08-14T19:00:00.000Z",
      counts: { pages: 4_097 },
    });
    expect(emit).not.toHaveBeenCalledWith(
      "ProviderLandingRecovery",
      expect.anything(),
      expect.anything(),
    );
  });

  it("confirms a long compact-history cycle even after an unrelated false-positive suspect", async () => {
    const store = new MemoryLandingStore();
    store.checkpoints.set("odds", {
      schemaVersion: "provider-landing-checkpoint-v1",
      providerId: "sharpapi",
      stream: "odds",
      version: 0,
      status: "running",
      sweepId: "odds:2026-08-14T19:00:00.000Z",
      slot: 0,
      position: { cursor: "cycle-origin" },
      startedAt: "2026-08-14T19:00:00.000Z",
      updatedAt: "2026-08-14T20:00:00.000Z",
      counts: {
        pages: 0,
        sourceRows: 0,
        landedRows: 0,
        quarantinedRows: 0,
        warningRows: 0,
      },
      providerTotal: 10_000,
      providerUpdatedAt: "2026-08-14T20:00:00.000Z",
      visitedPositionHashes: saturatedCompactOddsHistory("cycle-origin", [
        oddsSuspectToken("unrelated-false-positive"),
      ]),
    });
    let pageIndex = 0;
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>(() => {
      const index = pageIndex++;
      const nextCursor =
        index === 0 || index === 130 ? "cycle-target" : `cycle-middle-${index}`;
      return Promise.resolve(
        oddsPage([odds(`cycle-price-${index}`)], {
          hasMore: true,
          nextCursor,
          providerTotal: 10_000,
        }),
      );
    });
    const emit = vi.fn();
    const result = await runProviderLanding({
      source: source({ fetchOdds }),
      store,
      metrics: { emit },
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      oddsPageBudget: 132,
    });
    expect(fetchOdds).toHaveBeenCalledTimes(131);
    expect(result.odds).toMatchObject({
      status: "running",
      position: { cursor: "__initial__" },
      counts: { pages: 0 },
      startedAt: "2026-08-14T19:00:00.000Z",
    });
    expect(result.odds?.sweepId).toContain("odds:recovery-");
    expect(emit).toHaveBeenCalledWith("ProviderLandingRecovery", 1, {
      stream: "odds",
      outcome: "restart",
    });
  });

  it("uses the stable provider total as a hard bound before writing an extra page", async () => {
    const store = new MemoryLandingStore();
    store.checkpoints.set("odds", {
      schemaVersion: "provider-landing-checkpoint-v1",
      providerId: "sharpapi",
      stream: "odds",
      version: 0,
      status: "running",
      sweepId: "odds:2026-08-14T19:00:00.000Z",
      slot: 0,
      position: { cursor: "cursor-over-total" },
      startedAt: "2026-08-14T19:00:00.000Z",
      updatedAt: "2026-08-14T20:00:00.000Z",
      counts: {
        pages: 2,
        sourceRows: 2,
        landedRows: 2,
        quarantinedRows: 0,
        warningRows: 0,
      },
      providerTotal: 2,
      providerUpdatedAt: "2026-08-14T20:00:00.000Z",
      visitedPositionHashes: [oddsPositionHash("cursor-over-total")],
    });
    const result = await runProviderLanding({
      source: source({
        fetchOdds: vi.fn(() =>
          Promise.resolve(
            oddsPage([odds("should-not-write")], {
              hasMore: true,
              nextCursor: "cursor-after-total",
              providerTotal: 2,
            }),
          ),
        ),
      }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.odds?.sweepId).toContain("odds:recovery-");
    expect(
      store.records.find(({ recordId }) => recordId === "should-not-write"),
    ).toBeUndefined();
  });

  it("completes events when optional generation metadata is absent", async () => {
    const store = new MemoryLandingStore();
    const missingGeneration = { ...eventPage([event("event-1")]) };
    delete missingGeneration.providerUpdatedAt;
    const emit = vi.fn();
    const result = await runProviderLanding({
      source: source({
        fetchEvents: vi.fn(() => Promise.resolve(missingGeneration)),
      }),
      store,
      metrics: { emit },
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.events).toMatchObject({
      status: "complete",
      position: null,
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
      startedAt: "2026-08-14T20:00:05.000Z",
    });
    expect(result.events?.lastCompletedAt).toBe("2026-08-14T20:00:05.000Z");
    expect(emit).not.toHaveBeenCalledWith(
      "ProviderLandingFailure",
      expect.anything(),
      expect.anything(),
    );
  });

  it("completes cursor-paginated odds when provider total is absent", async () => {
    const store = new MemoryLandingStore();
    const missingTotal = { ...oddsPage([odds("price-1")]) };
    delete missingTotal.providerTotal;
    const result = await runProviderLanding({
      source: source({
        fetchOdds: vi.fn(() => Promise.resolve(missingTotal)),
      }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.odds).toMatchObject({
      status: "complete",
      position: null,
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
    });
    expect(result.odds?.lastCompletedAt).toBe("2026-08-14T20:00:05.000Z");
    expect(result.odds?.providerTotal).toBeUndefined();
  });

  it("refuses to publish an offset-paginated event sweep without its denominator", async () => {
    const store = new MemoryLandingStore();
    const missingTotal = { ...eventPage([event("event-1")]) };
    delete missingTotal.providerTotal;
    const result = await runProviderLanding({
      source: source({
        fetchEvents: vi.fn(() => Promise.resolve(missingTotal)),
      }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.events).toMatchObject({
      status: "running",
      position: { offset: 0 },
      counts: { pages: 0, sourceRows: 0, landedRows: 0 },
    });
    expect(result.events?.lastCompletedAt).toBeUndefined();
  });

  it("replays a sealed page when only SharpAPI's response emission time changes", async () => {
    const store = new MemoryLandingStore();
    const originalPutCheckpoint = store.putCheckpoint.bind(store);
    let failFinalCommit = true;
    vi.spyOn(store, "putCheckpoint").mockImplementation(
      (checkpoint, expectedVersion) => {
        if (
          failFinalCommit &&
          checkpoint.stream === "events" &&
          checkpoint.counts.pages === 1
        ) {
          failFinalCommit = false;
          return Promise.reject(new Error("simulated-checkpoint-outage"));
        }
        return originalPutCheckpoint(checkpoint, expectedVersion);
      },
    );
    const firstPage = eventPage([event("event-1")], {
      providerUpdatedAt: "2026-08-15T12:00:00.000000001Z",
    });
    const replayedPage = {
      ...firstPage,
      providerUpdatedAt: "2026-08-15T12:00:01.000000001Z",
    };
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(replayedPage);

    await expect(
      runProviderLanding({
        source: source({ fetchEvents }),
        store,
        now: () => new Date("2026-08-15T12:00:00.000Z"),
      }),
    ).rejects.toThrow("simulated-checkpoint-outage");

    const replay = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-15T12:00:01.000Z"),
    });
    expect(replay.events).toMatchObject({
      status: "complete",
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
      providerUpdatedAt: "2026-08-15T12:00:01.000000001Z",
    });
    expect(replay.events?.sweepId).not.toContain("recovery");
  });

  it("seals a fetched page and self-heals a changed crash replay", async () => {
    const store = new MemoryLandingStore();
    const originalPutCheckpoint = store.putCheckpoint.bind(store);
    let failFinalCommit = true;
    vi.spyOn(store, "putCheckpoint").mockImplementation(
      (checkpoint, expectedVersion) => {
        if (
          failFinalCommit &&
          checkpoint.stream === "events" &&
          checkpoint.counts.pages === 1
        ) {
          failFinalCommit = false;
          return Promise.reject(new Error("simulated-checkpoint-outage"));
        }
        return originalPutCheckpoint(checkpoint, expectedVersion);
      },
    );
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValueOnce(eventPage([event("event-1")]))
      .mockResolvedValueOnce(eventPage([event("event-changed")]))
      .mockResolvedValue(eventPage([event("event-changed")]));
    await expect(
      runProviderLanding({
        source: source({ fetchEvents }),
        store,
        now: () => new Date("2026-08-14T20:00:05.000Z"),
      }),
    ).rejects.toThrow("simulated-checkpoint-outage");
    expect(store.checkpoints.get("events")?.pendingPage).toBeDefined();
    const restarted = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-14T20:00:06.000Z"),
    });
    expect(restarted.events).toMatchObject({
      status: "running",
      position: { offset: 0 },
      counts: { pages: 0 },
      startedAt: "2026-08-14T20:00:05.000Z",
    });
    expect(restarted.events?.pendingPage).toBeUndefined();
    expect(restarted.events?.sweepId).toContain("events:recovery-");

    const completed = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-14T20:00:07.000Z"),
    });
    expect(completed.events).toMatchObject({
      status: "complete",
      counts: { pages: 1, landedRows: 1 },
    });
    expect(
      store.records.filter(({ recordType }) => recordType === "event"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: "event-1" }),
        expect.objectContaining({ recordId: "event-changed" }),
      ]),
    );
  });

  it("persists provider rate-window pauses and does not redispatch before reset", async () => {
    const store = new MemoryLandingStore();
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValueOnce(
        eventPage([event("event-1")], {
          hasMore: true,
          nextOffset: 200,
          providerTotal: 400,
          responseMetadata: {
            rateWindow: {
              limit: 100,
              remaining: 10,
              resetsAt: "2026-08-14T20:05:00.000Z" as never,
            },
          },
        }),
      )
      .mockResolvedValue(
        eventPage([event("event-2")], {
          hasMore: true,
          nextOffset: 400,
          providerTotal: 400,
          responseMetadata: {
            rateWindow: { limit: 100, remaining: 100 },
          },
        }),
      );
    const fetchOdds = vi.fn(() =>
      Promise.resolve(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "cursor-1",
          responseMetadata: {
            rateWindow: {
              limit: 100,
              remaining: 9,
              resetsAt: "2026-08-14T20:05:00.000Z" as never,
            },
          },
        }),
      ),
    );
    let clock = "2026-08-14T20:00:05.000Z";
    const input = {
      source: source({ fetchEvents, fetchOdds }),
      store,
      now: () => new Date(clock),
    };
    const first = await runProviderLanding(input);
    expect(first.events?.resumeAfter).toBe("2026-08-14T20:05:00.000Z");
    expect(first.odds).toBeUndefined();
    await runProviderLanding(input);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchOdds).not.toHaveBeenCalled();
    clock = "2026-08-14T20:06:00.000Z";
    await runProviderLanding(input);
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(fetchOdds).toHaveBeenCalledTimes(1);
  });

  it("persists a shared low-rate catalog pause before starting either data stream", async () => {
    const store = new MemoryLandingStore();
    const fetchCatalog = vi.fn(() =>
      Promise.resolve(
        catalog({
          responseMetadata: {
            rateWindow: {
              limit: 100,
              remaining: 20,
              resetsAt: "2026-08-14T20:05:00.000Z" as never,
            },
          },
        }),
      ),
    );
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>(() =>
      Promise.resolve(eventPage([event("event-1")])),
    );
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>(() =>
      Promise.resolve(oddsPage([odds("price-1")])),
    );
    let clock = "2026-08-14T20:00:05.000Z";
    const input = {
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      now: () => new Date(clock),
    };
    const first = await runProviderLanding(input);
    expect(first.catalog).toMatchObject({
      status: "complete",
      resumeAfter: "2026-08-14T20:05:00.000Z",
    });
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).not.toHaveBeenCalled();
    await runProviderLanding(input);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).not.toHaveBeenCalled();
    clock = "2026-08-14T20:06:00.000Z";
    await runProviderLanding(input);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchOdds).toHaveBeenCalledTimes(1);
  });

  it("emits exact landed, quarantine, and warning row metrics after commit", async () => {
    const store = new MemoryLandingStore();
    const emit = vi.fn();
    await runProviderLanding({
      source: source({
        fetchEvents: vi.fn(() =>
          Promise.resolve(
            eventPage(
              [{ ...event("event-1"), sourceWarnings: ["new-field"] }],
              {
                sourceRows: 2,
                quarantines: [
                  {
                    rowIndex: 1,
                    endpoint: "events",
                    reason: "invalid-row",
                    sourceFields: ["id"],
                    sourceFieldCount: 1,
                    sourceSchemaHash: "a".repeat(64),
                  },
                ],
                providerTotal: 2,
              },
            ),
          ),
        ),
      }),
      store,
      metrics: { emit },
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingPage", 2, {
      stream: "catalog",
      outcome: "persisted",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingRows", 1, {
      stream: "events",
      outcome: "landed",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingRows", 1, {
      stream: "events",
      outcome: "quarantined",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingRows", 1, {
      stream: "events",
      outcome: "warning",
    });
  });

  it("replays cumulative quarantine and warning evidence after a post-commit metric crash", async () => {
    const store = new MemoryLandingStore();
    let failAfterEventCommit = true;
    const emit = vi.fn(
      (
        metric: string,
        _value: number,
        dimensions: Readonly<Record<string, string>>,
      ) => {
        if (
          failAfterEventCommit &&
          metric === "ProviderLandingPage" &&
          dimensions["stream"] === "events"
        ) {
          failAfterEventCommit = false;
          throw new Error("simulated-metric-crash");
        }
      },
    );
    const qualityPage = eventPage(
      [{ ...event("event-1"), sourceWarnings: ["new-field"] }],
      {
        sourceRows: 2,
        quarantines: [
          {
            rowIndex: 1,
            endpoint: "events",
            reason: "invalid-row",
            sourceFields: ["id"],
            sourceFieldCount: 1,
            sourceSchemaHash: "a".repeat(64),
          },
        ],
        providerTotal: 2,
      },
    );
    await expect(
      runProviderLanding({
        source: source({
          fetchEvents: vi.fn(() => Promise.resolve(qualityPage)),
        }),
        store,
        metrics: { emit },
        now: () => new Date("2026-08-14T20:00:05.000Z"),
      }),
    ).rejects.toThrow("simulated-metric-crash");
    expect(store.checkpoints.get("events")).toMatchObject({
      status: "complete",
      counts: { quarantinedRows: 1, warningRows: 1 },
    });

    const replayEmit = vi.fn();
    await runProviderLanding({
      source: source(),
      store,
      metrics: { emit: replayEmit },
      now: () => new Date("2026-08-14T20:00:06.000Z"),
    });
    expect(replayEmit).toHaveBeenCalledWith("ProviderLandingRows", 1, {
      stream: "events",
      outcome: "quarantined",
    });
    expect(replayEmit).toHaveBeenCalledWith("ProviderLandingRows", 1, {
      stream: "events",
      outcome: "warning",
    });
  });

  it("checkpoints large catalog chunks and resumes from durable row progress", async () => {
    const store = new MemoryLandingStore();
    const largeCatalog = catalog({
      sports: Array.from({ length: 60 }, (_, index) => ({
        providerSportId: `sport-${index}`,
        displayName: `Sport ${index}`,
        eventCount: index,
        liveCount: 0,
        providerLeagueIds: [],
      })),
      sourceRows: 61,
    });
    const fetchCatalog = vi.fn(() => Promise.resolve(largeCatalog));
    const putRecords = vi.spyOn(store, "putRecords");
    const runWithOneChunk = async () => {
      let checksRemaining = 2;
      return runProviderLanding({
        source: source({ fetchCatalog }),
        store,
        eventPageBudget: 0,
        oddsPageBudget: 0,
        shouldContinue: () => checksRemaining-- > 0,
        now: () => new Date("2026-08-14T20:00:05.000Z"),
      });
    };

    const first = await runWithOneChunk();
    expect(first.catalog).toMatchObject({
      status: "running",
      counts: { pages: 0, sourceRows: 25, landedRows: 25 },
    });
    expect(first.catalog?.pendingPage).toBeDefined();
    const second = await runWithOneChunk();
    expect(second.catalog).toMatchObject({
      status: "running",
      counts: { pages: 0, sourceRows: 50, landedRows: 50 },
    });
    const third = await runProviderLanding({
      source: source({ fetchCatalog }),
      store,
      eventPageBudget: 0,
      oddsPageBudget: 0,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(third.catalog).toMatchObject({
      status: "complete",
      counts: {
        pages: 2,
        sourceRows: 61,
        landedRows: 61,
        quarantinedRows: 0,
      },
    });
    expect(putRecords.mock.calls.map(([records]) => records.length)).toEqual([
      25, 25, 11,
    ]);
    expect(fetchCatalog).toHaveBeenCalledTimes(3);
  });

  it("rejects corrupt non-boundary catalog progress before skipping records", async () => {
    const store = new MemoryLandingStore();
    const largeCatalog = catalog({
      sports: Array.from({ length: 30 }, (_, index) => ({
        providerSportId: `sport-${index}`,
        displayName: `Sport ${index}`,
        eventCount: index,
        liveCount: 0,
        providerLeagueIds: [],
      })),
      sourceRows: 31,
    });
    let checksRemaining = 2;
    await runProviderLanding({
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(largeCatalog)),
      }),
      store,
      eventPageBudget: 0,
      oddsPageBudget: 0,
      shouldContinue: () => checksRemaining-- > 0,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    const checkpoint = store.checkpoints.get("catalog")!;
    store.checkpoints.set("catalog", {
      ...checkpoint,
      counts: {
        ...checkpoint.counts,
        sourceRows: 7,
        landedRows: 7,
      },
    });
    const putRecords = vi.spyOn(store, "putRecords");
    await expect(
      runProviderLanding({
        source: source({
          fetchCatalog: vi.fn(() => Promise.resolve(largeCatalog)),
        }),
        store,
        eventPageBudget: 0,
        oddsPageBudget: 0,
        now: () => new Date("2026-08-14T20:00:06.000Z"),
      }),
    ).rejects.toThrow("provider-landing-reconciliation-failed");
    expect(putRecords).not.toHaveBeenCalled();
  });

  it("persists catalog quarantine evidence before refusing an empty endpoint", async () => {
    const store = new MemoryLandingStore();
    await expect(
      runProviderLanding({
        source: source({
          fetchCatalog: vi.fn(() =>
            Promise.resolve(
              catalog({
                sports: [],
                quarantines: [
                  {
                    endpoint: "sports",
                    rowIndex: 0,
                    reason: "invalid-row",
                    sourceFields: ["id", "name"],
                    sourceFieldCount: 2,
                    sourceSchemaHash: "a".repeat(64),
                  },
                ],
              }),
            ),
          ),
        }),
        store,
        eventPageBudget: 0,
        oddsPageBudget: 0,
        now: () => new Date("2026-08-14T20:00:05.000Z"),
      }),
    ).rejects.toThrow("provider-landing-catalog-empty");
    expect(store.checkpoints.get("catalog")).toMatchObject({
      status: "running",
      counts: { sourceRows: 2, landedRows: 1, quarantinedRows: 1 },
    });
    expect(store.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: "quarantine",
          endpoint: "sports",
        }),
        expect.objectContaining({ recordType: "catalog-league" }),
      ]),
    );
  });

  it("moves cross-page duplicates from landed into quarantine accounting", async () => {
    const store = new MemoryLandingStore();
    const putRecords = vi.spyOn(store, "putRecords");
    putRecords.mockImplementation((records) => {
      store.records.push(...records);
      const duplicate = records.some(
        ({ recordType, pageNumber }) =>
          recordType === "event" && pageNumber === 2,
      );
      return Promise.resolve({
        crossPageDuplicateCount: duplicate ? 1 : 0,
        crossPageDuplicateRecordIds: duplicate ? ["event-1"] : [],
      });
    });
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValueOnce(
        eventPage([event("event-1")], {
          hasMore: true,
          nextOffset: 200,
          providerTotal: 2,
        }),
      )
      .mockResolvedValueOnce(
        eventPage([event("event-1")], { providerTotal: 2 }),
      );
    const result = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.events?.counts).toEqual({
      pages: 2,
      sourceRows: 2,
      landedRows: 1,
      quarantinedRows: 1,
      warningRows: 0,
    });
  });

  it("pauses a rejected catalog while withholding unplanned events and preserving odds", async () => {
    const store = new MemoryLandingStore();
    const fetchCatalog = vi.fn(() =>
      Promise.reject(new SharpApiError("provider-rejected", false)),
    );
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockResolvedValue(eventPage([]));
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValue(oddsPage([]));
    const terminal = vi.fn(() => Promise.resolve());
    const accountRate = {
      reserve: vi.fn(() => Promise.resolve({ admitted: true as const })),
      reconcile: vi.fn(() => Promise.resolve()),
      rateLimited: vi.fn(() => Promise.resolve()),
      terminal,
    };
    const input = {
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      accountRate,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    };
    await expect(runProviderLanding(input)).rejects.toMatchObject({
      code: "provider-rejected",
    });
    expect(store.checkpoints.get("catalog")?.resumeAfter).toBe(
      "2026-08-15T20:00:05.000Z",
    );
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();

    await runProviderLanding(input);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).toHaveBeenCalledTimes(1);
  });

  it("durably pauses only the rejected paged stream", async () => {
    const store = new MemoryLandingStore();
    const fetchEvents = vi.fn(() =>
      Promise.reject(new SharpApiError("provider-rejected", false)),
    );
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValue(oddsPage([]));
    const input = {
      source: source({ fetchEvents, fetchOdds }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    };
    await expect(runProviderLanding(input)).rejects.toMatchObject({
      code: "provider-rejected",
    });
    expect(store.checkpoints.get("events")?.resumeAfter).toBe(
      "2026-08-15T20:00:05.000Z",
    );
    expect(fetchOdds).toHaveBeenCalledTimes(1);

    await runProviderLanding(input);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchOdds).toHaveBeenCalledTimes(1);
  });

  it.each(["configuration", "unauthorized", "not-entitled"] as const)(
    "circuit-breaks all paid streams after a terminal catalog %s error",
    async (code) => {
      const store = new MemoryLandingStore();
      const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
      const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>();
      await expect(
        runProviderLanding({
          source: source({
            fetchCatalog: vi.fn(() => Promise.reject(new SharpApiError(code))),
            fetchEvents,
            fetchOdds,
          }),
          store,
          now: () => new Date("2026-08-14T20:00:05.000Z"),
        }),
      ).rejects.toMatchObject({ code });
      expect(fetchEvents).not.toHaveBeenCalled();
      expect(fetchOdds).not.toHaveBeenCalled();
    },
  );
});
