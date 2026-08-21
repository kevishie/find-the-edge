import { describe, expect, it, vi } from "vitest";
import type {
  ProviderLandingCheckpoint,
  ProviderLandingPutRecordsResult,
  ProviderLandingRecord,
  ProviderLandingStream,
} from "@find-the-edge/database";
import {
  MemoryOddsControlPlaneStore,
  providerLandingPositionHash,
} from "@find-the-edge/database";
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
      eventCount: 649,
      liveCount: 2,
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
  it("derives bounded league-scoped event filters for every nonempty catalog sport without an allowlist", () => {
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
    expect([...new Set(partitions.map(({ sport }) => sport))].sort()).toEqual(
      sports
        .filter(({ eventCount }) => eventCount > 0)
        .map(({ providerSportId }) => providerSportId)
        .sort(),
    );
    expect(
      partitions.every(({ sport, leagues: members }) => {
        const query = new URLSearchParams({ sport });
        if (members) query.set("league", members.join(","));
        return (members?.length ?? 0) <= 50 && query.toString().length <= 3_800;
      }),
    ).toBe(true);
    expect(partitions).not.toContainEqual({ sport: "rugby_union" });
    expect(partitions).toContainEqual({ sport: "olympics" });
    expect(partitions).toContainEqual({
      sport: "baseball",
      leagues: ["mlb"],
    });
  });

  it("falls back to sport-wide acquisition when a quarantined league prevents exact coverage", () => {
    expect(
      buildSharpApiEventPartitions({
        sports: [
          {
            providerSportId: "olympics",
            displayName: "Olympics",
            eventCount: 171,
            liveCount: 0,
            providerLeagueIds: [
              "bwf_world_championships",
              "world_championships,_mens_singles",
            ],
          },
        ],
        leagues: [
          {
            providerLeagueId: "bwf_world_championships",
            displayName: "BWF World Championships",
            providerSportId: "olympics",
            eventCount: 120,
            liveCount: 0,
          },
        ],
      }),
    ).toEqual([{ sport: "olympics" }]);
  });

  it("forces sport-wide acquisition when the later league response quarantines a sibling", () => {
    expect(
      buildSharpApiEventPartitions({
        sports: [
          {
            providerSportId: "olympics",
            displayName: "Olympics",
            eventCount: 120,
            liveCount: 0,
            providerLeagueIds: ["bwf_world_championships"],
          },
        ],
        leagues: [
          {
            providerLeagueId: "bwf_world_championships",
            displayName: "BWF World Championships",
            providerSportId: "olympics",
            eventCount: 120,
            liveCount: 0,
          },
        ],
        quarantines: [
          {
            rowIndex: 1,
            reason: "unrepresentable-filter-id",
            endpoint: "leagues",
            providerRecordId: "world_championships,_mens_singles",
            providerSportId: "olympics",
            sourceFields: ["id", "sport"],
            sourceSchemaHash: "a".repeat(64),
          },
        ],
      }),
    ).toEqual([{ sport: "olympics" }]);
  });

  it("does not publish a partial league plan when catalog denominators disagree", () => {
    expect(
      buildSharpApiEventPartitions({
        sports: [
          {
            providerSportId: "soccer",
            displayName: "Soccer",
            eventCount: 101,
            liveCount: 2,
            providerLeagueIds: ["mls"],
          },
        ],
        leagues: [
          {
            providerLeagueId: "mls",
            displayName: "MLS",
            providerSportId: "soccer",
            eventCount: 100,
            liveCount: 1,
          },
        ],
      }),
    ).toEqual([{ sport: "soccer" }]);
  });

  it("retains live catalog sports even when their event counters are zero", () => {
    expect(
      buildSharpApiEventPartitions({
        sports: [
          {
            providerSportId: "tennis",
            displayName: "Tennis",
            eventCount: 0,
            liveCount: 1,
            providerLeagueIds: ["atp"],
          },
        ],
        leagues: [
          {
            providerLeagueId: "atp",
            displayName: "ATP",
            providerSportId: "tennis",
            eventCount: 0,
            liveCount: 1,
          },
        ],
      }),
    ).toEqual([{ sport: "tennis", leagues: ["atp"] }]);
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

  it("completes an all-zero Events generation without dispatching a paid page", async () => {
    const store = new MemoryLandingStore();
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
    const result = await runProviderLanding({
      source: source({
        fetchCatalog: vi.fn(() =>
          Promise.resolve(
            catalog({
              sports: [
                {
                  providerSportId: "rugby_union",
                  displayName: "Rugby Union",
                  eventCount: 0,
                  liveCount: 0,
                  providerLeagueIds: ["zero_season"],
                },
              ],
              leagues: [
                {
                  providerLeagueId: "zero_season",
                  displayName: "Zero Season",
                  providerSportId: "rugby_union",
                  eventCount: 0,
                  liveCount: 0,
                },
              ],
            }),
          ),
        ),
        fetchEvents,
      }),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(result.events).toMatchObject({
      status: "complete",
      position: null,
      eventPartitions: [],
      counts: {
        pages: 0,
        sourceRows: 0,
        landedRows: 0,
        quarantinedRows: 0,
      },
    });
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it("keeps quarantined league ownership durable and forces its sport fail-closed", async () => {
    const store = new MemoryLandingStore();
    const quarantine = {
      rowIndex: 1,
      reason: "unrepresentable-filter-id" as const,
      endpoint: "leagues" as const,
      providerRecordId: "world_championships,_mens_singles",
      providerSportId: "olympics",
      sourceFields: ["id", "sport"],
      sourceSchemaHash: "a".repeat(64),
    };
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>(() =>
      Promise.resolve(eventPage([])),
    );
    await runProviderLanding({
      source: source({
        fetchCatalog: vi.fn(() =>
          Promise.resolve(
            catalog({
              sports: [
                {
                  providerSportId: "olympics",
                  displayName: "Olympics",
                  eventCount: 1,
                  liveCount: 0,
                  providerLeagueIds: [
                    "bwf_world_championships",
                    "world_championships,_mens_singles",
                  ],
                },
              ],
              leagues: [
                {
                  providerLeagueId: "bwf_world_championships",
                  displayName: "BWF World Championships",
                  providerSportId: "olympics",
                  eventCount: 1,
                  liveCount: 0,
                },
              ],
              quarantines: [quarantine],
              sourceRows: 3,
            }),
          ),
        ),
        fetchEvents,
      }),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(fetchEvents).toHaveBeenCalledWith({ sport: "olympics" }, 0);
    expect(
      store.records.find(
        ({ recordType, value }) =>
          recordType === "quarantine" &&
          value["providerRecordId"] === "world_championships,_mens_singles",
      ),
    ).toMatchObject({
      sport: "olympics",
      value: { providerSportId: "olympics" },
    });
  });

  it("lands an oversized catalog and raises a bounded diagnostic instead of failing its checkpoint", async () => {
    const store = new MemoryLandingStore();
    await runProviderLanding({
      source: source(),
      store,
      now: () => new Date("2026-08-15T11:00:00.000Z"),
    });
    const sports = Array.from({ length: 2_049 }, (_, index) => ({
      providerSportId: `sport-${index.toString().padStart(4, "0")}`,
      displayName: `Sport ${index}`,
      eventCount: 1,
      liveCount: 0,
      providerLeagueIds: index === 0 ? ["league-0"] : [],
    }));
    const leagues = [
      {
        providerLeagueId: "league-0",
        displayName: "League 0",
        providerSportId: "sport-0000",
        eventCount: 1,
        liveCount: 0,
      },
    ];
    const fetchCatalog = vi.fn(() =>
      Promise.resolve(
        catalog({
          sports,
          leagues,
          sourceRows: sports.length + leagues.length,
        }),
      ),
    );
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();
    const emit = vi.fn((metric: string) => {
      if (metric === "ProviderLandingDiagnostic")
        throw new Error("simulated-capacity-metric-crash");
    });
    const input = {
      source: source({
        fetchCatalog,
        fetchEvents,
      }),
      store,
    };
    await expect(
      runProviderLanding({
        ...input,
        metrics: { emit },
        now: () => new Date("2026-08-15T12:00:00.000Z"),
      }),
    ).rejects.toThrow("simulated-capacity-metric-crash");

    const result = await runProviderLanding({
      ...input,
      now: () => new Date("2026-08-15T12:01:00.000Z"),
    });

    expect(result.catalog).toMatchObject({
      status: "complete",
      counts: {
        sourceRows: 2_050,
        landedRows: 2_050,
        quarantinedRows: 0,
      },
    });
    expect(result.catalog?.eventPartitions).toBeUndefined();
    expect(result.events).toBeUndefined();
    const capacity = store.records.find(
      ({ recordType, value }) =>
        recordType === "quarantine" &&
        value["reason"] === "provider-event-plan-capacity",
    );
    expect(capacity).toMatchObject({
      recordType: "quarantine",
      endpoint: "events",
    });
    expect(capacity?.value).toMatchObject({
      reason: "provider-event-plan-capacity",
      partitionCount: 2_049,
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingDiagnostic", 1, {
      stream: "catalog",
      outcome: "observed",
    });
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchEvents).not.toHaveBeenCalled();
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
          eventCount: 3_000,
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
    const completed = await runProviderLanding(input);
    expect(completed.events).toMatchObject({
      status: "complete",
      eventPartitions: [
        { sport: "tennis", leagues: ["atp"] },
        { sport: "tennis", leagues: ["wta"] },
      ],
      counts: { pages: 3, sourceRows: 2, landedRows: 2 },
    });
    const gap = store.records.find(
      ({ recordType, value }) =>
        recordType === "quarantine" &&
        value["reason"] === "provider-event-partition-too-large",
    );
    expect(gap).toMatchObject({
      recordType: "quarantine",
      endpoint: "events",
    });
    expect(gap?.value).toMatchObject({
      reason: "provider-event-partition-too-large",
      providerTotal: 5_300,
    });
    expect(fetchEvents.mock.calls).toEqual([
      [{ sport: "tennis", leagues: ["atp", "wta"] }, 0],
      [{ sport: "tennis", leagues: ["atp"] }, 0],
      [{ sport: "tennis", leagues: ["wta"] }, 0],
    ]);
  });

  it("keeps an indivisible oversized event partition unpublished while later sports land", async () => {
    const store = new MemoryLandingStore();
    const catalogFor = (includeBaseball: boolean) =>
      catalog({
        sports: [
          ...(includeBaseball
            ? [
                {
                  providerSportId: "baseball",
                  displayName: "Baseball",
                  eventCount: 5_300,
                  liveCount: 0,
                  providerLeagueIds: [],
                },
              ]
            : []),
          {
            providerSportId: "golf",
            displayName: "Golf",
            eventCount: 1,
            liveCount: 0,
            providerLeagueIds: ["pga"],
          },
        ],
        leagues: [
          {
            providerLeagueId: "pga",
            displayName: "PGA",
            providerSportId: "golf",
            eventCount: 1,
            liveCount: 0,
          },
        ],
        sourceRows: includeBaseball ? 3 : 2,
      });
    const fetchCatalog = vi
      .fn<ProviderLandingSource["fetchCatalog"]>()
      .mockResolvedValueOnce(catalogFor(true))
      .mockResolvedValueOnce(catalogFor(false));
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockImplementation((partition) =>
        Promise.resolve(
          partition.sport === "baseball"
            ? eventPage([], {
                hasMore: true,
                nextOffset: 200,
                providerTotal: 5_300,
              })
            : eventPage([
                {
                  ...event("event-golf"),
                  sport: "golf",
                },
              ]),
        ),
      );
    let clock = "2026-08-15T12:00:00.000Z";
    const input = {
      source: source({ fetchCatalog, fetchEvents }),
      store,
      now: () => new Date(clock),
    };

    const incomplete = await runProviderLanding(input);
    expect(incomplete.events).toMatchObject({
      status: "running",
      pauseScope: "stream",
      eventDeferredPartitions: [0],
      eventPrimaryTraversalComplete: true,
      counts: {
        pages: 2,
        sourceRows: 1,
        landedRows: 1,
        quarantinedRows: 0,
      },
    });
    expect(
      store.records.some(
        ({ recordType, value }) =>
          recordType === "quarantine" &&
          value["reason"] === "provider-event-partition-too-large",
      ),
    ).toBe(true);

    clock = "2026-08-15T12:16:00.000Z";
    const healed = await runProviderLanding(input);
    expect(healed.events).toMatchObject({
      status: "complete",
      eventPartitions: [{ sport: "golf" }],
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
    });
  });

  it("abandons late oversized partition pages once and resumes unrelated sports", async () => {
    const store = new MemoryLandingStore();
    const snapshot = catalog({
      sports: ["baseball", "golf"].map((providerSportId) => ({
        providerSportId,
        displayName: providerSportId,
        eventCount: providerSportId === "baseball" ? 5_000 : 1,
        liveCount: 0,
        providerLeagueIds: [],
      })),
      leagues: [
        {
          providerLeagueId: "pga",
          displayName: "PGA",
          providerSportId: "golf",
          eventCount: 1,
          liveCount: 0,
        },
      ],
      sourceRows: 3,
    });
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockImplementation((partition, offset) => {
        if (partition.sport === "baseball" && offset === 0)
          return Promise.resolve(
            eventPage([event("event-baseball")], {
              hasMore: true,
              nextOffset: 200,
              providerTotal: 5_000,
            }),
          );
        if (partition.sport === "baseball")
          return Promise.resolve(
            eventPage([], {
              hasMore: true,
              nextOffset: 400,
              providerTotal: 5_300,
            }),
          );
        return Promise.resolve(
          eventPage([
            {
              ...event("event-golf"),
              sport: "golf",
            },
          ]),
        );
      });
    let clock = "2026-08-15T12:00:00.000Z";
    const input = {
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
      }),
      store,
      now: () => new Date(clock),
    };

    const restarted = await runProviderLanding(input);
    expect(restarted.events).toMatchObject({
      status: "running",
      position: { partition: 1, offset: 0 },
      eventDeferredPartitions: [0],
      counts: { pages: 0, sourceRows: 0 },
    });
    clock = "2026-08-15T12:01:00.000Z";
    const isolated = await runProviderLanding(input);
    expect(isolated.events).toMatchObject({
      status: "running",
      pauseScope: "stream",
      eventDeferredPartitions: [0],
      eventPrimaryTraversalComplete: true,
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
    });
    expect(fetchEvents.mock.calls).toEqual([
      [{ sport: "baseball" }, 0],
      [{ sport: "baseball" }, 200],
      [{ sport: "golf", leagues: ["pga"] }, 0],
    ]);
  });

  it("skips a middle deferred partition during recovery and lands it once after siblings", async () => {
    const store = new MemoryLandingStore();
    const sports = ["alpha", "middle", "zulu"];
    const snapshot = catalog({
      sports: sports.map((providerSportId) => ({
        providerSportId,
        displayName: providerSportId,
        eventCount: providerSportId === "middle" ? 5_000 : 1,
        liveCount: 0,
        providerLeagueIds: [`${providerSportId}-league`],
      })),
      leagues: sports.map((providerSportId) => ({
        providerLeagueId: `${providerSportId}-league`,
        displayName: `${providerSportId} league`,
        providerSportId,
        eventCount: providerSportId === "middle" ? 5_000 : 1,
        liveCount: 0,
      })),
      sourceRows: 6,
    });
    let middleInitialPages = true;
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockImplementation((partition, offset) => {
        if (partition.sport === "middle" && middleInitialPages) {
          if (offset === 0)
            return Promise.resolve(
              eventPage([event("event-middle-initial")], {
                hasMore: true,
                nextOffset: 200,
                providerTotal: 5_000,
              }),
            );
          middleInitialPages = false;
          return Promise.resolve(
            eventPage([], {
              hasMore: true,
              nextOffset: 400,
              providerTotal: 5_300,
            }),
          );
        }
        return Promise.resolve(
          eventPage([
            {
              ...event(`event-${partition.sport}`),
              sport: partition.sport,
            },
          ]),
        );
      });
    let clock = "2026-08-15T12:00:00.000Z";
    const input = {
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
      }),
      store,
      now: () => new Date(clock),
    };

    const restarted = await runProviderLanding(input);
    expect(restarted.events).toMatchObject({
      status: "running",
      position: { partition: 0, offset: 0 },
      eventDeferredPartitions: [1],
      counts: { pages: 0, sourceRows: 0 },
    });

    clock = "2026-08-15T12:01:00.000Z";
    const deferred = await runProviderLanding(input);
    expect(deferred.events).toMatchObject({
      status: "running",
      eventPrimaryTraversalComplete: true,
      eventDeferredPartitions: [1],
      counts: { pages: 2, sourceRows: 2, landedRows: 2 },
    });

    clock = "2026-08-15T12:17:00.000Z";
    const completed = await runProviderLanding(input);
    expect(completed.events).toMatchObject({
      status: "complete",
      counts: { pages: 3, sourceRows: 3, landedRows: 3 },
    });
    expect(
      fetchEvents.mock.calls.map(([partition, offset]) => [
        partition.sport,
        offset,
      ]),
    ).toEqual([
      ["alpha", 0],
      ["middle", 0],
      ["middle", 200],
      ["alpha", 0],
      ["zulu", 0],
      ["middle", 0],
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

  it("preserves a generic non-initial odds pause instead of misclassifying it as cursor rejection", async () => {
    const store = new MemoryLandingStore();
    let clock = "2026-08-15T12:00:00.000Z";
    const fetchOdds = vi
      .fn<ProviderLandingSource["fetchOdds"]>()
      .mockResolvedValueOnce(
        oddsPage([odds("price-1")], {
          hasMore: true,
          nextCursor: "cursor-1",
        }),
      )
      .mockRejectedValueOnce(new SharpApiError("invalid-response", false));
    const input = {
      source: source({ fetchOdds }),
      store,
      now: () => new Date(clock),
      oddsPageBudget: 1,
    };

    await runProviderLanding(input);
    clock = "2026-08-15T12:01:00.000Z";
    const paused = await runProviderLanding(input);
    expect(paused.odds).toMatchObject({
      status: "running",
      position: { cursor: "cursor-1" },
      pauseScope: "stream",
      resumeAfter: "2026-08-16T12:01:00.000Z",
    });

    clock = "2026-08-15T12:02:00.000Z";
    const preserved = await runProviderLanding(input);
    expect(preserved.odds).toMatchObject({
      sweepId: paused.odds?.sweepId,
      position: { cursor: "cursor-1" },
      pauseScope: "stream",
      resumeAfter: "2026-08-16T12:01:00.000Z",
    });
    expect(fetchOdds).toHaveBeenCalledTimes(2);
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
          "request-atp-stale",
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
    await expect(runProviderLanding(input)).resolves.toMatchObject({
      catalog: { status: "complete" },
      events: {
        status: "running",
        pauseScope: "stream",
        counts: { pages: 1, sourceRows: 0, landedRows: 0, quarantinedRows: 0 },
        eventDeferredPartitions: [0],
      },
    });
    expect(store.checkpoints.get("events")).toMatchObject({
      eventPartitions: [{ sport: "tennis", leagues: ["atp"] }],
      status: "running",
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
    expect(fetchEvents).toHaveBeenCalledWith(
      { sport: "tennis", leagues: ["atp"] },
      0,
    );
    expect(migrated.events).toMatchObject({
      status: "complete",
      position: null,
      eventPartitions: [{ sport: "tennis", leagues: ["atp"] }],
    });
    expect(migrated.events?.resumeAfter).toBeUndefined();
  });

  it("migrates an active broad-filter sweep when the completed catalog plan changes", async () => {
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
      position: { partition: 0, offset: 200 },
      startedAt: "2026-08-15T12:01:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
      counts: {
        pages: 1,
        sourceRows: 200,
        landedRows: 200,
        quarantinedRows: 0,
        warningRows: 0,
      },
      eventPartitions: [{ sport: "tennis" }],
      eventCatalogPlanHash: "f".repeat(64),
      eventPartitionSourceRows: 200,
      eventPositionRevision: 0,
      visitedPositionHashes: [],
    });
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>(() =>
      Promise.resolve(eventPage([event("event-migrated-active")])),
    );

    const migrated = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-15T12:16:00.000Z"),
    });

    expect(fetchEvents).toHaveBeenCalledWith(
      { sport: "tennis", leagues: ["atp"] },
      0,
    );
    expect(migrated.events).toMatchObject({
      status: "complete",
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
      eventPartitions: [{ sport: "tennis", leagues: ["atp"] }],
    });
  });

  it("backfills lineage on a paused partition checkpoint without replaying its paid progress", async () => {
    const store = new MemoryLandingStore();
    const initial = await runProviderLanding({
      source: source(),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });
    if (!initial.events?.eventPartitions)
      throw new Error("missing event checkpoint");
    const position = { partition: 0, offset: 200 } as const;
    const paused = {
      ...initial.events,
      version: initial.events.version + 1,
      status: "running" as const,
      position,
      startedAt: "2026-08-15T12:01:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
      counts: {
        pages: 1,
        sourceRows: 200,
        landedRows: 200,
        quarantinedRows: 0,
        warningRows: 0,
      },
      eventPartitionSourceRows: 200,
      visitedPositionHashes: [
        providerLandingPositionHash({ stream: "events", position }),
      ],
      resumeAfter: "2026-08-16T12:01:00.000Z",
      pauseScope: "stream" as const,
    };
    delete paused.eventCatalogPlanHash;
    store.checkpoints.set("events", paused);
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();

    const preserved = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-15T12:16:00.000Z"),
    });

    expect(fetchEvents).not.toHaveBeenCalled();
    expect(preserved.events).toMatchObject({
      sweepId: paused.sweepId,
      position,
      counts: paused.counts,
      pauseScope: "stream",
      resumeAfter: paused.resumeAfter,
    });
    expect(preserved.events?.eventCatalogPlanHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps catalog lineage stable when DynamoDB reorders event partition map fields", async () => {
    const store = new MemoryLandingStore();
    const snapshot = catalog({
      sports: [
        {
          providerSportId: "tennis",
          displayName: "Tennis",
          eventCount: 3_000,
          liveCount: 0,
          providerLeagueIds: ["atp", "wta"],
        },
      ],
      leagues: ["atp", "wta"].map((providerLeagueId) => ({
        providerLeagueId,
        displayName: providerLeagueId.toUpperCase(),
        providerSportId: "tennis",
        eventCount: 1_500,
        liveCount: 0,
      })),
      sourceRows: 3,
    });
    const initial = await runProviderLanding({
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents: vi.fn<ProviderLandingSource["fetchEvents"]>((partition) =>
          Promise.resolve(
            eventPage([event(`event-${partition.leagues?.[0]}`)]),
          ),
        ),
      }),
      store,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });
    if (
      !initial.events?.eventPartitions ||
      !initial.events.eventCatalogPlanHash
    )
      throw new Error("missing event plan lineage");
    const position = { partition: 0, offset: 200 } as const;
    const eventPositionRevision = 0;
    const reordered = initial.events.eventPartitions.map((partition) =>
      partition.leagues
        ? { leagues: [...partition.leagues], sport: partition.sport }
        : { sport: partition.sport },
    );
    const paused = {
      ...initial.events,
      version: initial.events.version + 1,
      sweepId: "events:2026-08-15T12:01:00.000Z",
      slot: initial.events.slot === 0 ? (1 as const) : (0 as const),
      status: "running" as const,
      position,
      startedAt: "2026-08-15T12:01:00.000Z",
      updatedAt: "2026-08-15T12:01:00.000Z",
      counts: {
        pages: 1,
        sourceRows: 200,
        landedRows: 200,
        quarantinedRows: 0,
        warningRows: 0,
      },
      eventPartitions: reordered,
      eventPartitionSourceRows: 200,
      eventPositionRevision,
      visitedPositionHashes: [
        providerLandingPositionHash({
          stream: "events",
          position,
          eventPositionRevision,
        }),
      ],
      resumeAfter: "2026-08-15T12:16:00.000Z",
      pauseScope: "stream" as const,
    };
    store.checkpoints.set("events", paused);
    const fetchEvents = vi.fn<ProviderLandingSource["fetchEvents"]>();

    const preserved = await runProviderLanding({
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
      }),
      store,
      now: () => new Date("2026-08-15T12:02:00.000Z"),
    });

    expect(fetchEvents).not.toHaveBeenCalled();
    expect(preserved.events).toMatchObject({
      sweepId: paused.sweepId,
      position,
      counts: paused.counts,
      eventCatalogPlanHash: initial.events.eventCatalogPlanHash,
    });
  });

  it("reserves the shared account window for both catalog calls and every provider page", async () => {
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
    expect(fetchEvents).toHaveBeenCalledWith(
      { sport: "tennis", leagues: ["atp"] },
      0,
    );
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

  it("keeps an ambiguous request charged and pauses only its stream without poisoning live account health", async () => {
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
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>(() =>
      Promise.resolve(oddsPage([odds("price-1")])),
    );
    const result = await runProviderLanding({
      source: source({ fetchCatalog, fetchEvents, fetchOdds }),
      store,
      accountRate: new SharedSharpApiAccountRateCoordinator(control),
      now: () => new Date("2026-08-14T20:00:05.000Z"),
    });
    expect(result.catalog?.resumeAfter).toBe("2026-08-14T20:15:05.000Z");
    expect(result.catalog?.pauseScope).toBe("stream");
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(fetchOdds).toHaveBeenCalledOnce();
    expect(result.odds?.status).toBe("complete");
    expect(blockAccountRateWindow).not.toHaveBeenCalled();
    expect(await control.getHealth(healthKey)).toMatchObject({
      healthy: true,
      rateWindow: { remaining: 697 },
    });
  });

  it("continues event pagination after an ambiguous odds request", async () => {
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
    const fetchOdds = vi.fn<ProviderLandingSource["fetchOdds"]>(() =>
      Promise.reject(new SharpApiError("provider-request-ambiguous")),
    );
    const result = await runProviderLanding({
      source: source({ fetchEvents, fetchOdds }),
      store,
      now: () => new Date("2026-08-14T20:00:05.000Z"),
      eventPageBudget: 2,
      oddsPageBudget: 1,
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(result.events).toMatchObject({
      status: "complete",
      counts: { pages: 2, landedRows: 2 },
    });
    expect(result.odds).toMatchObject({
      status: "running",
      pauseScope: "stream",
      resumeAfter: "2026-08-14T20:10:05.000Z",
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
    expect(fetchEvents).toHaveBeenLastCalledWith(
      { sport: "tennis", leagues: ["atp"] },
      200,
    );
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

  it("abandons a sealed page before treating its offset-zero replay as a rejected filter", async () => {
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
      .mockResolvedValueOnce(eventPage([event("event-before-crash")]))
      .mockRejectedValueOnce(
        new SharpApiError(
          "provider-rejected",
          false,
          undefined,
          "universal-events:http-400",
          "invalid_filter",
          400,
          "request-pending-replay",
        ),
      )
      .mockResolvedValueOnce(eventPage([event("event-after-restart")]));
    const emit = vi.fn((metric: string) => {
      if (metric === "ProviderLandingDiagnostic")
        throw new Error("simulated-diagnostic-metric-crash");
    });

    await expect(
      runProviderLanding({
        source: source({ fetchEvents }),
        store,
        now: () => new Date("2026-08-15T16:00:00.000Z"),
      }),
    ).rejects.toThrow("simulated-checkpoint-outage");

    await expect(
      runProviderLanding({
        source: source({ fetchEvents }),
        store,
        now: () => new Date("2026-08-15T16:00:01.000Z"),
        metrics: { emit },
      }),
    ).rejects.toThrow("simulated-diagnostic-metric-crash");
    const restarted = store.checkpoints.get("events");
    expect(restarted).toMatchObject({
      status: "running",
      counts: { pages: 0, sourceRows: 0, quarantinedRows: 0 },
    });
    expect(restarted?.pendingPage).toBeUndefined();
    const rejection = store.records.find(
      ({ recordType, value }) =>
        recordType === "quarantine" &&
        value["requestId"] === "request-pending-replay",
    );
    expect(rejection).toMatchObject({ endpoint: "events" });
    expect(rejection?.value).toMatchObject({
      reason: "provider-filter-rejected",
      providerCode: "invalid_filter",
      httpStatus: 400,
      requestId: "request-pending-replay",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingDiagnostic", 1, {
      stream: "events",
      outcome: "observed",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingPage", 1, {
      stream: "events",
      outcome: "rejected",
    });

    const completed = await runProviderLanding({
      source: source({ fetchEvents }),
      store,
      now: () => new Date("2026-08-15T16:00:02.000Z"),
    });
    expect(completed.events).toMatchObject({
      status: "complete",
      counts: { pages: 1, sourceRows: 1, landedRows: 1 },
    });
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
    await expect(runProviderLanding(input)).resolves.toMatchObject({
      catalog: {
        status: "running",
        pauseScope: "stream",
        resumeAfter: "2026-08-15T20:00:05.000Z",
      },
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
    await expect(runProviderLanding(input)).resolves.toMatchObject({
      events: {
        status: "running",
        pauseScope: "stream",
        resumeAfter: "2026-08-15T20:00:05.000Z",
      },
    });
    expect(store.checkpoints.get("events")?.resumeAfter).toBe(
      "2026-08-15T20:00:05.000Z",
    );
    expect(fetchOdds).toHaveBeenCalledTimes(1);

    await runProviderLanding(input);
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(fetchOdds).toHaveBeenCalledTimes(1);
  });

  it("defers a rejected catalog sport without fabricating coverage and later self-heals", async () => {
    const store = new MemoryLandingStore();
    const snapshot = catalog({
      sports: ["baseball", "futsal", "golf"].map((providerSportId) => ({
        providerSportId,
        displayName: providerSportId,
        eventCount: 1,
        liveCount: 0,
        providerLeagueIds: [],
      })),
      leagues: [
        {
          providerLeagueId: "mlb",
          displayName: "MLB",
          providerSportId: "baseball",
          eventCount: 1,
          liveCount: 0,
        },
      ],
      sourceRows: 4,
    });
    let rejectFutsal = true;
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockImplementation((partition) => {
        if (partition.sport === "futsal" && rejectFutsal)
          return Promise.reject(
            new SharpApiError(
              "provider-rejected",
              false,
              undefined,
              "universal-events:http-400",
              "invalid_filter",
              400,
              "request-1786811503722601-3299637",
            ),
          );
        return Promise.resolve(
          eventPage([
            {
              ...event(`event-${partition.sport}`),
              sport: partition.sport,
              league: `${partition.sport}-league`,
            },
          ]),
        );
      });
    const emit = vi.fn();

    let clock = "2026-08-15T16:30:00.000Z";
    const input = {
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
      }),
      store,
      now: () => new Date(clock),
      metrics: { emit },
    };
    const result = await runProviderLanding(input);

    expect(
      fetchEvents.mock.calls.map(([partition]) => partition.sport),
    ).toEqual(["baseball", "futsal", "golf"]);
    expect(result.events).toMatchObject({
      status: "running",
      pauseScope: "stream",
      eventDeferredPartitions: [1],
      eventPrimaryTraversalComplete: true,
      counts: {
        pages: 3,
        sourceRows: 2,
        landedRows: 2,
        quarantinedRows: 0,
        warningRows: 0,
      },
    });
    const quarantine = store.records.find(
      ({ recordType, endpoint }) =>
        recordType === "quarantine" && endpoint === "events",
    );
    expect(quarantine).toMatchObject({
      recordType: "quarantine",
      endpoint: "events",
      value: {
        reason: "provider-filter-rejected",
        providerCode: "invalid_filter",
        httpStatus: 400,
        requestId: "request-1786811503722601-3299637",
      },
    });
    expect(quarantine?.value).not.toHaveProperty("sourceSchemaHash");
    expect(emit).toHaveBeenCalledWith("ProviderLandingFailure", 1, {
      stream: "events",
      reason: "provider-filter-rejected",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingPage", 1, {
      stream: "events",
      outcome: "rejected",
    });

    rejectFutsal = false;
    clock = "2026-08-15T16:46:00.000Z";
    const healed = await runProviderLanding(input);
    expect(healed.events).toMatchObject({
      status: "complete",
      counts: {
        pages: 4,
        sourceRows: 3,
        landedRows: 3,
        quarantinedRows: 0,
      },
    });
  });

  it("bisects a rejected multi-league filter in one invocation and defers only the bad leaf", async () => {
    const store = new MemoryLandingStore();
    const snapshot = catalog({
      sports: [
        {
          providerSportId: "baseball",
          displayName: "Baseball",
          eventCount: 1,
          liveCount: 0,
          providerLeagueIds: ["mlb"],
        },
        {
          providerSportId: "tennis",
          displayName: "Tennis",
          eventCount: 3_000,
          liveCount: 0,
          providerLeagueIds: ["bad-league", "good-league"],
        },
      ],
      leagues: [
        {
          providerLeagueId: "mlb",
          displayName: "MLB",
          providerSportId: "baseball",
          eventCount: 1,
          liveCount: 0,
        },
        ...["bad-league", "good-league"].map((providerLeagueId) => ({
          providerLeagueId,
          displayName: providerLeagueId,
          providerSportId: "tennis",
          eventCount: 1_500,
          liveCount: 0,
        })),
      ],
      sourceRows: 5,
    });
    let rejectBadLeague = true;
    const fetchEvents = vi
      .fn<ProviderLandingSource["fetchEvents"]>()
      .mockImplementation((partition) => {
        if (partition.leagues?.includes("bad-league") && rejectBadLeague)
          return Promise.reject(
            new SharpApiError(
              "provider-rejected",
              false,
              undefined,
              "universal-events:http-400",
              "invalid_filter",
              400,
              "request-filter-split",
            ),
          );
        return Promise.resolve(
          eventPage([
            {
              ...event(`event-${partition.sport}`),
              sport: partition.sport,
            },
          ]),
        );
      });
    let clock = "2026-08-15T16:45:00.000Z";
    const input = {
      source: source({
        fetchCatalog: vi.fn(() => Promise.resolve(snapshot)),
        fetchEvents,
      }),
      store,
      now: () => new Date(clock),
    };

    const deferred = await runProviderLanding(input);
    expect(deferred.events).toMatchObject({
      status: "running",
      pauseScope: "stream",
      counts: { pages: 4, sourceRows: 2, landedRows: 2 },
      position: { partition: 1, offset: 0 },
      eventDeferredPartitions: [1],
      eventPrimaryTraversalComplete: true,
      eventPartitions: [
        { sport: "baseball", leagues: ["mlb"] },
        { sport: "tennis", leagues: ["bad-league"] },
        { sport: "tennis", leagues: ["good-league"] },
      ],
    });
    expect(deferred.events?.sweepId).not.toContain("recovery");
    expect(
      fetchEvents.mock.calls.map(([partition]) => [
        partition.sport,
        partition.leagues,
      ]),
    ).toEqual([
      ["baseball", ["mlb"]],
      ["tennis", ["bad-league", "good-league"]],
      ["tennis", ["bad-league"]],
      ["tennis", ["good-league"]],
    ]);

    rejectBadLeague = false;
    clock = "2026-08-15T17:01:00.000Z";
    const completed = await runProviderLanding(input);
    expect(completed.events).toMatchObject({
      status: "complete",
      counts: {
        pages: 5,
        sourceRows: 3,
        landedRows: 3,
        quarantinedRows: 0,
      },
    });
    const quarantine = store.records.find(
      ({ recordType, endpoint }) =>
        recordType === "quarantine" && endpoint === "events",
    );
    expect(quarantine).toMatchObject({
      value: {
        reason: "provider-filter-rejected",
        providerCode: "invalid_filter",
      },
    });
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
