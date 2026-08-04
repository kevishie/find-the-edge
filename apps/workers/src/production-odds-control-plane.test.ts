import { describe, expect, it, vi } from "vitest";
import {
  MemoryEventIngestionStore,
  MemoryOddsControlPlaneStore,
} from "@find-the-edge/database";
import type { IsoTimestamp } from "@find-the-edge/domain";
import { SharpApiError, type SharpApiLeague } from "@find-the-edge/providers";
import {
  capabilityFailure,
  evidenceGaps,
  runFocusedSharpOddsIngestion,
  runProductionOddsControlPlane,
  sharpOddsRequestIdentity,
} from "./production-odds-control-plane";

const now = new Date("2026-08-03T12:00:00.000Z");
const at = now.toISOString() as IsoTimestamp;

describe("production odds control-plane composition", () => {
  it("deduplicates focused event refreshes by durable polling-window identity", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const events = new MemoryEventIngestionStore();
    vi.spyOn(events, "resolveExactCanonicalBinding").mockResolvedValue({
      id: "canonical-event-1",
      version: 1,
      sportKey: "soccer",
      startsAt: "2026-08-03T20:00:00.000Z",
      participantIds: ["away", "home"],
      participantLabels: ["Away", "Home"],
    } as never);
    const fetchFocused = vi.fn((league: SharpApiLeague, eventId: string) =>
      Promise.resolve({
        request: {
          endpointMode: "focused" as const,
          leagueKey: league.leagueKey,
          providerLeague: league.providerLeague,
          marketSet: ["main"] as const,
          providerEventId: eventId,
        },
        page: {
          events: [],
          hasMore: false,
          retrievedAt: at,
        },
      }),
    );
    const input = {
      events,
      odds: { persist: vi.fn() },
      control,
      sharpApiKey: "server-secret",
      request: { leagueKey: "mls" as const, providerEventId: "event-1" },
      now,
      fetchFocused,
    };
    expect(await runFocusedSharpOddsIngestion(input)).toEqual(
      expect.objectContaining({ status: "completed", gaps: 15 }),
    );
    expect(await runFocusedSharpOddsIngestion(input)).toEqual(
      expect.objectContaining({ status: "deduplicated" }),
    );
    expect(fetchFocused).toHaveBeenCalledTimes(1);
    expect(
      (await control.getHealth("sharpapi:mls:odds"))?.rateWindow,
    ).toBeUndefined();
    expect(
      sharpOddsRequestIdentity({
        leagueKey: "mls",
        endpointMode: "focused",
        providerEventId: "event-1",
        marketSet: ["main"],
        now,
        pollingWindowSeconds: 300,
      }),
    ).toHaveLength(64);
    expect(
      sharpOddsRequestIdentity({
        leagueKey: "mls",
        endpointMode: "focused",
        providerEventId: "event-1",
        marketSet: ["main"],
        now,
        pollingWindowSeconds: 600,
      }),
    ).not.toBe(
      sharpOddsRequestIdentity({
        leagueKey: "mls",
        endpointMode: "focused",
        providerEventId: "event-1",
        marketSet: ["main"],
        now,
        pollingWindowSeconds: 300,
      }),
    );
  });

  it("fails closed on unknown capacity or malformed cooldown and persists authoritative focused rate metadata", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const events = new MemoryEventIngestionStore();
    vi.spyOn(events, "resolveExactCanonicalBinding").mockResolvedValue({
      id: "canonical-event-1",
      version: 1,
      sportKey: "soccer",
      startsAt: "2026-08-03T20:00:00.000Z",
      participantIds: ["away", "home"],
      participantLabels: ["Away", "Home"],
    } as never);
    const common = {
      events,
      odds: { persist: vi.fn() },
      control,
      sharpApiKey: "server-secret",
      request: { leagueKey: "mls" as const, providerEventId: "event-rate" },
      now,
    };
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mls:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: { limit: 1_000 },
      updatedAt: at,
    });
    expect(await runFocusedSharpOddsIngestion(common)).toMatchObject({
      status: "retryable",
      reason: "quota-reserve",
    });
    await control.putHealth({
      ...(await control.getHealth("sharpapi:mls:odds"))!,
      healthy: false,
      cooldownUntil: "not-an-instant",
      rateWindow: { limit: 1_000, remaining: 900 },
      updatedAt: at,
    });
    expect(await runFocusedSharpOddsIngestion(common)).toMatchObject({
      status: "retryable",
      reason: "rate-limited",
    });
    await control.putHealth({
      ...(await control.getHealth("sharpapi:mls:odds"))!,
      healthy: true,
      cooldownUntil: undefined,
      quotaRemaining: 0,
      rateWindow: {
        limit: 1_000,
        remaining: 0,
        resetsAt: "2026-08-03T11:59:00.000Z",
      },
      updatedAt: at,
    } as never);
    const fetchFocused = vi.fn().mockResolvedValue({
      request: {},
      page: {
        events: [],
        hasMore: false,
        retrievedAt: at,
        responseMetadata: {
          rateWindow: {
            limit: 1_000,
            remaining: 731,
            resetsAt: "2026-08-03T12:01:00.000Z",
          },
        },
      },
    });
    expect(
      await runFocusedSharpOddsIngestion({
        ...common,
        request: { ...common.request, providerEventId: "event-rate-success" },
        fetchFocused,
      }),
    ).toMatchObject({ status: "completed" });
    expect(await control.getHealth("sharpapi:mls:odds")).toMatchObject({
      rateWindow: { limit: 1_000, remaining: 731 },
    });
  });

  it("distinguishes quota blocking and records persistence failure before success", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const events = new MemoryEventIngestionStore();
    vi.spyOn(events, "resolveExactCanonicalBinding").mockResolvedValue({
      id: "canonical-event-1",
      version: 1,
      sportKey: "soccer",
      startsAt: at,
      participantIds: ["away", "home"],
      participantLabels: ["Away", "Home"],
    } as never);
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mls:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 100,
      updatedAt: at,
    });
    const fetchFocused = vi.fn();
    const common = {
      events,
      odds: { persist: vi.fn() },
      control,
      sharpApiKey: "server-secret",
      request: { leagueKey: "mls" as const, providerEventId: "event-2" },
      now,
      fetchFocused,
    };
    expect(await runFocusedSharpOddsIngestion(common)).toEqual(
      expect.objectContaining({ status: "retryable", reason: "quota-reserve" }),
    );
    expect(fetchFocused).not.toHaveBeenCalled();

    await control.putHealth({
      ...(await control.getHealth("sharpapi:mls:odds"))!,
      quotaRemaining: 1000,
      updatedAt: at,
    });
    fetchFocused.mockResolvedValue({
      request: {},
      page: { events: [], hasMore: false, retrievedAt: at },
    });
    vi.spyOn(control, "putGap").mockRejectedValueOnce(
      new Error("gap-write-failed"),
    );
    await expect(runFocusedSharpOddsIngestion(common)).rejects.toThrow(
      "gap-write-failed",
    );
    expect(
      (
        await control.getAttempt(
          sharpOddsRequestIdentity({
            leagueKey: "mls",
            endpointMode: "focused",
            providerEventId: "event-2",
            marketSet: ["main"],
            now,
            pollingWindowSeconds: 300,
          }),
        )
      )?.state,
    ).toBe("failed");

    const retryAt = "2026-08-03T12:20:00.000Z" as IsoTimestamp;
    fetchFocused.mockRejectedValueOnce(
      new SharpApiError("rate-limited", true, retryAt),
    );
    await expect(
      runFocusedSharpOddsIngestion({
        ...common,
        request: { leagueKey: "mls", providerEventId: "event-3" },
        now: new Date("2026-08-03T12:05:00.000Z"),
      }),
    ).rejects.toThrow("rate-limited");
    expect(await control.getHealth("sharpapi:mls:odds")).toEqual(
      expect.objectContaining({ cooldownUntil: retryAt }),
    );
    expect(
      await runFocusedSharpOddsIngestion({
        ...common,
        request: { leagueKey: "mls", providerEventId: "event-4" },
        now: new Date("2026-08-03T12:10:00.000Z"),
      }),
    ).toEqual(expect.objectContaining({ status: "retryable", retryAt }));
  });
  it("preserves recoverable ownership and reservation failure mappings", () => {
    expect(capabilityFailure(new Error("run-owned"))).toBe(
      "provider-recovering",
    );
    expect(
      capabilityFailure(new Error("schedule-attempt-reservation-conflict")),
    ).toBe("transition-conflict");
  });
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
      "sharpapi",
      "sharpapi",
      "sharpapi",
    ]);
    expect(fetchSharpSchedule).toHaveBeenCalledTimes(5);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(5);
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
    ).toHaveLength(72);
    expect(
      [...control.gaps.values()].find(
        (gap) => gap.reason === "missing-provider-timestamp",
      ),
    ).toMatchObject({ sourceState: "missing", sportsbookId: "draftkings" });
    expect(
      [...control.gaps.values()].filter((gap) => gap.reason === "unsupported"),
    ).toHaveLength(5);

    const second = await runProductionOddsControlPlane({
      ...options,
      now: new Date("2026-08-03T12:15:00.000Z"),
    });
    expect(second.map((result) => result.status)).toEqual([
      "completed",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(fetchSharpSchedule).toHaveBeenCalledTimes(5);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(6);
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
      "sharpapi",
      "sharpapi",
      "sharpapi",
    ]);
    expect(result[0]).toMatchObject({
      status: "failed",
      reason: "schedule-provider-unavailable",
    });
    expect(fetchSharpOdds).toHaveBeenCalledTimes(4);
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
      ["sharpapi", "completed"],
      ["sharpapi", "completed"],
      ["sharpapi", "completed"],
    ]);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(10);
  });
});
