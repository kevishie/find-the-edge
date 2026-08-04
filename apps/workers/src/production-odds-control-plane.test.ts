import { describe, expect, it, vi } from "vitest";
import {
  MemoryEventIngestionStore,
  MemoryOddsControlPlaneStore,
} from "@find-the-edge/database";
import type { IsoTimestamp } from "@find-the-edge/domain";
import type { SharpApiLeague } from "@find-the-edge/providers";
import {
  evidenceGaps,
  runProductionOddsControlPlane,
} from "./production-odds-control-plane";

const now = new Date("2026-08-03T12:00:00.000Z");
const at = now.toISOString() as IsoTimestamp;

describe("production odds control-plane composition", () => {
  it("creates per-book market gaps and preserves provider source states", () => {
    const states = [
      ["stale", { isStalePregamePrice: true }],
      ["suspended", { isSuspended: true }],
      ["closed", { isClosed: true }],
      ["unsupported", { isUnsupported: true }],
      ["partial", { isMainLine: false }],
    ] as const;
    const events = states.map(([state, flags]) => ({
      providerEventId: state,
      bookmakers: [
        {
          id: "draftkings",
          prices: [{ marketKey: "moneyline", ...flags }],
        },
      ],
    }));
    const gaps = evidenceGaps(
      "run",
      "sharpapi",
      "mlb",
      events,
      ["moneyline"],
      { draftkings: "offered", circa: "comparison" },
      at,
      [...states.map(([state]) => state), "absent"],
    );
    expect(new Set(gaps.map((gap) => gap.sourceState))).toEqual(
      new Set([
        "stale",
        "suspended",
        "closed",
        "unsupported",
        "partial",
        "missing",
      ]),
    );
    expect(gaps.some((gap) => gap.sportsbookId === "circa")).toBe(true);
  });
  it("persists an incomplete-market gap when an active market is one-sided", () => {
    const gaps = evidenceGaps(
      "run",
      "sharpapi",
      "mlb",
      [
        {
          providerEventId: "mlb-event",
          bookmakers: [
            {
              id: "draftkings",
              prices: [
                {
                  marketKey: "moneyline",
                  selectionKey: "away",
                  outcomeStructure: "two-way" as const,
                  isMainLine: true,
                },
              ],
            },
          ],
        },
      ],
      ["moneyline"],
      { draftkings: "offered" },
      at,
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        providerEventId: "mlb-event",
        sportsbookId: "draftkings",
        marketKey: "moneyline",
        sourceState: "partial",
        reason: "incomplete-market",
      }),
    ]);
  });
  it("uses durable scheduled starts for near-start cadence while discovery is skipped", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            providerEventId: `${league.leagueKey}-event`,
            awayTeam: "Away",
            homeTeam: "Home",
            startsAt: "2026-08-03T12:45:00.000Z" as IsoTimestamp,
            status: "scheduled" as const,
          },
        ],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const fetchSharpOdds = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            providerEventId: `${league.leagueKey}-event`,
            providerEventUuid: `${league.leagueKey}-uuid`,
            awayTeam: "Away",
            homeTeam: "Home",
            startsAt: "2026-08-03T12:45:00.000Z" as IsoTimestamp,
            bookmakers:
              league.leagueKey === "mlb"
                ? [
                    {
                      id: "draftkings",
                      label: "DraftKings",
                      prices: [
                        ...(["away", "home"] as const).map(
                          (selectionKey, index) => ({
                            providerPriceId: `price-${selectionKey}`,
                            marketKey: "moneyline" as const,
                            outcomeStructure: "two-way" as const,
                            providerMarketType: "moneyline",
                            providerMarketId: "market-1",
                            selectionKey,
                            selectionLabel:
                              selectionKey === "away" ? "Away" : "Home",
                            providerSelectionId: `selection-${selectionKey}`,
                            americanOdds: index === 0 ? 110 : -120,
                            decimalOdds: index === 0 ? 2.1 : 1.83,
                            impliedProbability: index === 0 ? 0.476 : 0.545,
                            isLive: false,
                            isMainLine: true,
                            isAlternateLine: false,
                            isPlayerProp: false,
                            isStalePregamePrice: false,
                            observedAt: at,
                          }),
                        ),
                        {
                          providerPriceId: "spread-away",
                          marketKey: "spread" as const,
                          providerMarketType: "run_line",
                          providerMarketId: "spread-1",
                          selectionKey: "away" as const,
                          selectionLabel: "Away",
                          providerSelectionId: "spread-away",
                          point: 1.5,
                          americanOdds: -110,
                          decimalOdds: 1.91,
                          impliedProbability: 0.524,
                          isLive: false,
                          isMainLine: true,
                          isAlternateLine: false,
                          isPlayerProp: false,
                          isStalePregamePrice: false,
                          observedAt: at,
                        },
                        {
                          providerPriceId: "stale-total-over",
                          marketKey: "total" as const,
                          providerMarketType: "total_runs",
                          providerMarketId: "total-1",
                          selectionKey: "over" as const,
                          selectionLabel: "Over",
                          providerSelectionId: "total-over",
                          point: 8.5,
                          americanOdds: -110,
                          decimalOdds: 1.91,
                          impliedProbability: 0.524,
                          isLive: false,
                          isMainLine: true,
                          isAlternateLine: false,
                          isPlayerProp: false,
                          isStalePregamePrice: true,
                          observedAt: at,
                        },
                      ],
                    },
                  ]
                : [],
          },
        ],
        hasMore: false,
        retrievedAt: at,
        ...(league.leagueKey === "mlb"
          ? {
              rejections: [
                {
                  providerId: "sharpapi" as const,
                  providerEventId: "mlb-event",
                  sportsbookId: "draftkings",
                  reason: "missing-provider-timestamp" as const,
                  auditId: "price-missing-time",
                },
              ],
            }
          : {}),
      }),
    );
    const options = {
      events,
      odds: {
        persist: vi
          .fn()
          .mockResolvedValue({ snapshot: "existing", current: "retained" })
          .mockResolvedValueOnce({ snapshot: "created", current: "advanced" })
          .mockResolvedValueOnce({ snapshot: "existing", current: "retained" }),
      },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      metrics: { emit: vi.fn() },
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 15,
        streamingEnabled: false,
      }),
    };
    const first = await runProductionOddsControlPlane(options);
    expect(first.map((result) => result.providerId)).toEqual([
      "sharpapi",
      "sharpapi",
    ]);
    expect(fetchSharpSchedule).toHaveBeenCalledTimes(2);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(2);
    expect(options.metrics.emit).toHaveBeenCalledWith(
      "OddsNormalizedObservation",
      2,
      expect.objectContaining({ provider: "sharpapi" }),
    );
    for (const metric of ["OddsStaleEvidence", "OddsPartialEvidence"])
      expect(options.metrics.emit).toHaveBeenCalledWith(
        metric,
        1,
        expect.objectContaining({ provider: "sharpapi", league: "mlb" }),
      );
    expect(options.metrics.emit).toHaveBeenCalledWith(
      "OddsMissingProviderTimestamp",
      1,
      expect.objectContaining({ provider: "sharpapi", league: "mlb" }),
    );
    for (const metric of [
      "OddsSnapshotCreated",
      "OddsSnapshotDuplicate",
      "OddsCurrentAdvanced",
      "OddsCurrentRetained",
    ])
      expect(options.metrics.emit).toHaveBeenCalledWith(
        metric,
        1,
        expect.objectContaining({ provider: "sharpapi", league: "mlb" }),
      );
    expect(
      [...control.gaps.values()].filter((gap) => gap.reason === "missing"),
    ).toHaveLength(27);
    expect(
      [...control.gaps.values()].find(
        (gap) => gap.reason === "missing-provider-timestamp",
      ),
    ).toMatchObject({ sourceState: "missing", sportsbookId: "draftkings" });
    expect(
      [...control.gaps.values()].filter((gap) => gap.reason === "unsupported"),
    ).toHaveLength(2);

    const second = await runProductionOddsControlPlane({
      ...options,
      now: new Date("2026-08-03T12:15:00.000Z"),
    });
    expect(second.map((result) => result.status)).toEqual([
      "completed",
      "skipped",
    ]);
    expect(fetchSharpSchedule).toHaveBeenCalledTimes(2);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(3);
  });
  it("fails closed without a secondary schedule and isolates account setup failure", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const scheduleEvent = (providerEventId: string) => ({
      providerEventId,
      awayTeam: "Away",
      homeTeam: "Home",
      startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
      status: "scheduled" as const,
    });
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) => {
      if (league.leagueKey === "mlb")
        return Promise.reject(new Error("provider-unavailable"));
      return Promise.resolve({
        events: [scheduleEvent("sharp-mls")],
        hasMore: false,
        retrievedAt: at,
      });
    });
    const fetchSharpOdds = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            ...scheduleEvent(`sharp-${league.leagueKey}`),
            providerEventUuid: `sharp-${league.leagueKey}-uuid`,
            bookmakers: [],
          },
        ],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const result = await runProductionOddsControlPlane({
      events,
      odds: { persist: vi.fn() },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
    });
    expect(result.map(({ providerId }) => providerId)).toEqual([
      undefined,
      "sharpapi",
    ]);
    expect(result[0]).toMatchObject({
      status: "failed",
      reason: "schedule-provider-unavailable",
    });
    expect(fetchSharpOdds).toHaveBeenCalledTimes(1);
    expect(fetchSharpOdds.mock.calls[0]?.[0].leagueKey).toBe("mls");
    expect(
      [...control.runs.values()].some(
        (run) => run.leagueKey === "account" && run.status === "failed",
      ),
    ).toBe(true);
  });

  it("uses a valid stored schedule when a forced discovery refresh is unavailable", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const scheduleEvent = (leagueKey: string) => ({
      providerEventId: `${leagueKey}-event`,
      awayTeam: "Away",
      homeTeam: "Home",
      startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
      status: "scheduled" as const,
    });
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [scheduleEvent(league.leagueKey)],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const fetchSharpOdds = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            ...scheduleEvent(league.leagueKey),
            providerEventUuid: `${league.leagueKey}-uuid`,
            bookmakers: [],
          },
        ],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const options = {
      events,
      odds: { persist: vi.fn() },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 15,
        streamingEnabled: false,
      }),
    };
    await runProductionOddsControlPlane(options);
    fetchSharpSchedule.mockRejectedValue(new Error("provider-unavailable"));
    const forced = await runProductionOddsControlPlane({
      ...options,
      now: new Date("2026-08-03T12:15:00.000Z"),
      forceRefresh: true,
    });
    expect(
      forced.map(({ providerId, status }) => [providerId, status]),
    ).toEqual([
      ["sharpapi", "completed"],
      ["sharpapi", "completed"],
    ]);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(4);
  });
});
