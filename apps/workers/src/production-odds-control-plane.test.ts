import { describe, expect, it, vi } from "vitest";
import {
  EventDataConflict,
  MemoryEventIngestionStore,
  MemoryOddsControlPlaneStore,
  type FixtureOddsIngestInput,
} from "@find-the-edge/database";
import type {
  FixtureOddsAvailabilityEvidence,
  IsoTimestamp,
} from "@find-the-edge/domain";
import { productionOddsCollectionPolicies } from "@find-the-edge/config";
import {
  parseSharpApiSchedulePage,
  SharpApiError,
  type SharpApiLeague,
} from "@find-the-edge/providers";
import {
  capabilityFailure,
  scheduleCapabilityFailure,
  evidenceGaps,
  fetchSharpOddsPageWithRetry,
  runFocusedSharpOddsIngestion,
  runProductionOddsControlPlane,
  reconstructSharpOddsRun,
  scheduleEventConflictReason,
  sharpOddsFailureRequestCost,
  sharpOddsRequestIdentity,
} from "./production-odds-control-plane";
import { ScheduleEventConflictError } from "./schedule-reconciliation";

const now = new Date("2026-08-03T12:00:00.000Z");
const at = now.toISOString() as IsoTimestamp;
const expectedMarketCount = (leagueKey: string) =>
  Object.values(
    productionOddsCollectionPolicies.find(
      (policy) => policy.leagueKey === leagueKey,
    )!.providers[0]!.expectedBooks!,
  ).reduce((count, markets) => count + markets.length, 0);

describe("production odds control-plane composition", () => {
  it("retries one transient invalid SharpAPI odds page and accounts for both requests", async () => {
    const page = {
      events: [],
      hasMore: false,
      retrievedAt: at,
    };
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new SharpApiError("invalid-response"))
      .mockResolvedValueOnce(page);
    const onRetry = vi.fn();

    await expect(
      fetchSharpOddsPageWithRetry(fetchPage, onRetry),
    ).resolves.toEqual({ page, quotaCost: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("records the actual paid request count when featured odds fails", async () => {
    const terminal = new SharpApiError(
      "provider-rejected",
      false,
      undefined,
      "odds:provider-error",
    );
    await expect(
      fetchSharpOddsPageWithRetry(() => Promise.reject(terminal)),
    ).rejects.toBe(terminal);
    expect(sharpOddsFailureRequestCost(terminal)).toBe(1);

    const first = new SharpApiError("invalid-response");
    const second = new SharpApiError("provider-rejected");
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second);
    await expect(fetchSharpOddsPageWithRetry(fetchPage)).rejects.toBe(second);
    expect(sharpOddsFailureRequestCost(second)).toBe(2);
  });

  it("does not retry non-contract SharpAPI failures", async () => {
    for (const code of ["unauthorized", "provider-rejected"] as const) {
      const fetchPage = vi.fn().mockRejectedValue(new SharpApiError(code));
      await expect(fetchSharpOddsPageWithRetry(fetchPage)).rejects.toThrow(
        code,
      );
      expect(fetchPage).toHaveBeenCalledOnce();
    }
  });

  it("preserves SharpAPI schedule rejection diagnostics through operations", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };
    await runProductionOddsControlPlane({
      events: new MemoryEventIngestionStore(),
      odds: { persist: vi.fn() },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      metrics,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule: vi
        .fn()
        .mockRejectedValue(
          new SharpApiError(
            "provider-rejected",
            false,
            undefined,
            "schedule:provider-error",
          ),
        ),
      fetchSharpOdds: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
      }),
    });

    const scheduleAttempts = [...control.attempts.values()].filter(
      (attempt) => attempt.capability === "schedule",
    );
    expect(scheduleAttempts).toHaveLength(5);
    expect(scheduleAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "failed",
          failureReason: "provider-rejected",
          failureStage: "schedule:provider-error",
        }),
      ]),
    );
    expect(
      [...control.health.values()].find((health) =>
        health.healthKey?.endsWith(":schedule"),
      ),
    ).toMatchObject({
      failureReason: "provider-rejected",
      failureStage: "schedule:provider-error",
    });
    expect(metrics.emit).toHaveBeenCalledWith(
      "OddsScheduleFailure",
      1,
      expect.objectContaining({
        provider: "sharpapi",
        reason: "provider-rejected",
        failureStage: "schedule:provider-error",
      }),
    );
  });

  it("preserves SharpAPI account and splits rejection diagnostics", async () => {
    const run = async (capability: "account" | "splits") => {
      const control = new MemoryOddsControlPlaneStore();
      const metrics = { emit: vi.fn() };
      await runProductionOddsControlPlane({
        events: new MemoryEventIngestionStore(),
        odds: { persist: vi.fn() },
        splits: {
          persist: vi.fn(),
          current: vi.fn(),
          listCurrent: vi.fn(),
          persistGap: vi.fn(),
        },
        control,
        metrics,
        sharpApiKey: "sharp-key",
        now,
        fetchSharpSchedule: vi.fn().mockResolvedValue({
          events: [],
          hasMore: false,
          retrievedAt: at,
        }),
        fetchSharpOdds: vi.fn().mockResolvedValue({
          events: [],
          hasMore: false,
          retrievedAt: at,
        }),
        fetchSharpAccount:
          capability === "account"
            ? vi
                .fn()
                .mockRejectedValue(
                  new SharpApiError(
                    "provider-rejected",
                    false,
                    undefined,
                    "account:provider-error",
                  ),
                )
            : vi.fn().mockResolvedValue({
                tier: "pro",
                features: ["splits"],
                requestsPerMinute: 300,
                maxBooks: 25,
                streamingEnabled: false,
              }),
        ...(capability === "splits"
          ? {
              fetchSharpSplits: vi
                .fn()
                .mockRejectedValue(
                  new SharpApiError(
                    "provider-rejected",
                    false,
                    undefined,
                    "splits:provider-error",
                  ),
                ),
            }
          : {}),
      });
      return { control, metrics };
    };

    for (const capability of ["account", "splits"] as const) {
      const { control, metrics } = await run(capability);
      if (capability === "splits")
        expect(metrics.emit).toHaveBeenCalledWith(
          "OddsAccountBookCapacity",
          25,
          { provider: "sharpapi" },
        );
      const stage = `${capability}:provider-error`;
      const attempts = [...control.attempts.values()].filter(
        (attempt) => attempt.capability === capability,
      );
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts[0]).toMatchObject({
        state: "failed",
        failureReason: "provider-rejected",
        failureStage: stage,
      });
      expect(
        [...control.health.values()].find((health) =>
          health.healthKey?.endsWith(`:${capability}`),
        ),
      ).toMatchObject({
        failureReason: "provider-rejected",
        failureStage: stage,
      });
      expect(metrics.emit).toHaveBeenCalledWith(
        capability === "account" ? "OddsAccountFailure" : "OddsSplitFailure",
        1,
        expect.objectContaining({
          provider: "sharpapi",
          reason: "provider-rejected",
          failureStage: stage,
        }),
      );
      if (capability === "splits")
        expect(metrics.emit).toHaveBeenCalledWith("OddsSplitFailure", 1, {});
    }
  });

  it("persists successful schedule, account, and split request windows", async () => {
    const control = new MemoryOddsControlPlaneStore();
    await runProductionOddsControlPlane({
      events: new MemoryEventIngestionStore(),
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
      clock: () => now,
      fetchSharpSchedule: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
        responseMetadata: {
          rateWindow: {
            limit: 1_000,
            remaining: 810,
            resetsAt: "2026-08-03T12:15:00.000Z",
          },
        },
      }),
      fetchSharpOdds: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: ["splits"],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
        responseMetadata: {
          rateWindow: {
            limit: 1_000,
            remaining: 805,
            resetsAt: "2026-08-03T12:15:00.000Z",
          },
        },
      }),
      fetchSharpSplits: vi.fn().mockResolvedValue({
        items: [],
        hasMore: false,
        retrievedAt: at,
        responseMetadata: {
          rateWindow: {
            limit: 1_000,
            remaining: 800,
            resetsAt: "2026-08-03T12:15:00.000Z",
          },
        },
      }),
    });
    expect(await control.getHealth("sharpapi:mlb:schedule")).toMatchObject({
      rateWindow: { limit: 1_000, remaining: 810 },
    });
    expect(await control.getHealth("sharpapi:account:account")).toMatchObject({
      rateWindow: { limit: 1_000, remaining: 800 },
    });
    expect(await control.getHealth("sharpapi:mlb:splits")).toMatchObject({
      rateWindow: { limit: 1_000, remaining: 800 },
    });
    expect(
      await control.getCheckpoint("public-betting:sharpapi"),
    ).toMatchObject({ nextDueAt: "2026-08-03T12:05:00.000Z" });
  });

  it("resumes account and league split continuations after ambiguity expires", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const expiredAt = "2026-08-03T11:55:00.000Z";
    await control.putContinuation({
      leagueKey: "public-betting:sharpapi",
      runId: "splits:sharpapi:expired",
      providerId: "sharpapi",
      updatedAt: expiredAt,
      startedAt: expiredAt,
      capability: "account",
      ambiguousUntil: expiredAt,
      leaseUntil: expiredAt,
      ownerId: "expired-owner",
    });
    await control.putContinuation({
      leagueKey: "splits:mlb",
      runId: "splits:mlb:expired",
      providerId: "sharpapi",
      updatedAt: expiredAt,
      startedAt: expiredAt,
      capability: "splits",
      ambiguousUntil: expiredAt,
      leaseUntil: expiredAt,
      ownerId: "expired-owner",
    });
    const fetchSharpAccount = vi.fn().mockResolvedValue({
      tier: "pro",
      features: ["splits"],
      requestsPerMinute: 300,
      maxBooks: 25,
      streamingEnabled: false,
    });
    const fetchSharpSplits = vi.fn((league: SharpApiLeague) => {
      void league;
      return Promise.resolve({
        items: [],
        hasMore: false,
        retrievedAt: at,
      });
    });

    await runProductionOddsControlPlane({
      events: new MemoryEventIngestionStore(),
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
      clock: () => now,
      fetchSharpSchedule: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpOdds: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpAccount,
      fetchSharpSplits,
    });

    expect(fetchSharpAccount).toHaveBeenCalledOnce();
    expect(
      fetchSharpSplits.mock.calls.filter(
        ([league]) => league.leagueKey === "mlb",
      ),
    ).toHaveLength(1);
    expect(await control.getContinuation("public-betting:sharpapi")).toBeNull();
    expect(await control.getContinuation("splits:mlb")).toBeNull();
    expect(await control.getHealth("sharpapi:mlb:splits")).toMatchObject({
      healthy: true,
      lastSuccessfulAt: at,
    });
  });

  it("carries canonical odds candidates into suffixless MLB split persistence", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const events = new MemoryEventIngestionStore();
    const metrics = { emit: vi.fn() };
    const persistOdds = vi.fn().mockResolvedValue({
      snapshot: "created",
      current: "advanced",
    });
    const persistSplit = vi.fn().mockResolvedValue({
      history: "inserted",
      current: "advanced",
    });
    const persistGap = vi.fn();
    const providerEventId = "sharp-opaque-mlb-event";
    const startsAt = "2026-08-03T20:00:00.000Z" as IsoTimestamp;
    const prices = (["away", "home"] as const).map((selectionKey, index) => ({
      providerPriceId: `price-${selectionKey}`,
      marketKey: "moneyline" as const,
      outcomeStructure: "two-way" as const,
      providerMarketType: "moneyline",
      providerMarketId: "market-moneyline",
      selectionKey,
      selectionLabel:
        selectionKey === "away" ? "St. Louis Cardinals" : "New York Yankees",
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
    }));

    await runProductionOddsControlPlane({
      events,
      odds: { persist: persistOdds },
      splits: {
        persist: persistSplit,
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap,
      },
      control,
      metrics,
      sharpApiKey: "sharp-key",
      now,
      clock: () => now,
      fetchSharpSchedule: vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events:
            league.leagueKey === "mlb"
              ? [
                  {
                    providerEventId,
                    awayTeam: "St. Louis Cardinals",
                    homeTeam: "New York Yankees",
                    startsAt,
                    status: "scheduled" as const,
                  },
                ]
              : [],
          hasMore: false,
          retrievedAt: at,
        }),
      ),
      fetchSharpOdds: vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events:
            league.leagueKey === "mlb"
              ? [
                  {
                    providerEventId,
                    providerEventUuid: "sharp-opaque-mlb-uuid",
                    awayTeam: "St. Louis Cardinals",
                    homeTeam: "New York Yankees",
                    startsAt,
                    bookmakers: [
                      {
                        id: "draftkings",
                        label: "DraftKings",
                        prices,
                      },
                    ],
                  },
                ]
              : [],
          hasMore: false,
          retrievedAt: at,
        }),
      ),
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: ["splits"],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
      }),
      fetchSharpSplits: vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          items:
            league.leagueKey === "mlb"
              ? [
                  {
                    providerEventId: "mlb_cardinals_yankees_2026-08-03",
                    sport: "baseball",
                    league: "mlb",
                    sportsbookId: "consensus",
                    awayTeam: "ST Louis Cardinals",
                    homeTeam: "New York Yankees",
                    providerTimestamp: at,
                    markets: [
                      {
                        marketKey: "moneyline" as const,
                        selections: [
                          { selectionKey: "away" as const, betPercent: 42 },
                          { selectionKey: "home" as const, betPercent: 58 },
                        ],
                      },
                    ],
                  },
                ]
              : [],
          hasMore: false,
          retrievedAt: at,
        }),
      ),
      fetchSharpSplitHistory: vi.fn().mockImplementation((sourceEvent) =>
        Promise.resolve({
          items: [
            {
              ...sourceEvent,
              sportsbookId: "draftkings",
              providerTimestamp: "2026-08-03T11:50:00.000Z",
              markets: [
                {
                  marketKey: "moneyline" as const,
                  selections: [
                    { selectionKey: "away" as const, betPercent: 41 },
                    { selectionKey: "home" as const, betPercent: 59 },
                  ],
                },
              ],
            },
            {
              ...sourceEvent,
              sportsbookId: "draftkings",
              providerTimestamp: "2026-08-03T11:55:00.000Z",
              markets: [
                {
                  marketKey: "moneyline" as const,
                  selections: [
                    { selectionKey: "away" as const, betPercent: 43 },
                    { selectionKey: "home" as const, betPercent: 57 },
                  ],
                },
              ],
            },
            {
              ...sourceEvent,
              sportsbookId: "circa",
              providerTimestamp: "2026-08-03T11:55:00.000Z",
              markets: [
                {
                  marketKey: "moneyline" as const,
                  selections: [
                    { selectionKey: "away" as const, moneyPercent: 61 },
                    { selectionKey: "home" as const, moneyPercent: 39 },
                  ],
                },
              ],
            },
          ],
          retrievedAt: at,
        }),
      ),
    });

    const canonicalEventId = (
      persistOdds.mock.calls[0]![0] as FixtureOddsIngestInput
    ).observation.canonicalEventId;
    expect(persistSplit).toHaveBeenCalledTimes(6);
    expect(persistSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: "mlb_cardinals_yankees_2026-08-03",
        canonicalEventId,
        scope: "consensus",
      }),
    );
    expect(persistGap).not.toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: "mlb_cardinals_yankees_2026-08-03",
      }),
    );
    expect(persistSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "draftkings",
        providerTimestamp: "2026-08-03T11:55:00.000Z",
        betPercent: 43,
      }),
    );
    expect(persistSplit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "draftkings",
        providerTimestamp: "2026-08-03T11:50:00.000Z",
      }),
    );
    expect(persistSplit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "circa", moneyPercent: 61 }),
    );
    const historyAttempts = [...control.attempts.values()].filter(
      ({ pageToken }) => pageToken.startsWith("history:"),
    );
    expect(historyAttempts).toHaveLength(1);
    expect(historyAttempts[0]).toMatchObject({
      capability: "splits",
      state: "succeeded",
      quotaCost: 1,
    });
    expect(metrics.emit).toHaveBeenCalledWith(
      "OddsSplitHistoryBooksRecovered",
      2,
      { league: "mlb", provider: "sharpapi" },
    );
  });

  it("rejects invalid replayed account capacity before telemetry", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };
    await runProductionOddsControlPlane({
      events: new MemoryEventIngestionStore(),
      odds: { persist: vi.fn() },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      metrics,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpOdds: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: ["splits"],
        requestsPerMinute: 300,
        maxBooks: -1,
        streamingEnabled: false,
      }),
    });

    expect(metrics.emit).not.toHaveBeenCalledWith(
      "OddsAccountBookCapacity",
      expect.anything(),
      expect.anything(),
    );
    expect(metrics.emit).toHaveBeenCalledWith(
      "OddsAccountFailure",
      1,
      expect.objectContaining({ provider: "sharpapi" }),
    );
  });

  it("reserves and records the two-call worst case for a failed featured page", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const fetchSharpOdds = vi.fn((league: SharpApiLeague) =>
      league.leagueKey === "mlb"
        ? Promise.reject(
            new SharpApiError(
              "invalid-response",
              false,
              undefined,
              "odds:page-envelope",
            ),
          )
        : Promise.resolve({ events: [], hasMore: false, retrievedAt: at }),
    );
    await runProductionOddsControlPlane({
      events: new MemoryEventIngestionStore(),
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
      fetchSharpSchedule: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
      }),
    });

    expect(
      fetchSharpOdds.mock.calls.filter(
        ([league]) => league.leagueKey === "mlb",
      ),
    ).toHaveLength(2);
    expect(
      [...control.attempts.values()].find(
        (attempt) =>
          attempt.capability === "odds" && attempt.leagueKey === "mlb",
      ),
    ).toMatchObject({
      state: "failed",
      quotaCost: 2,
      failureReason: "invalid-response",
    });
  });

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
      expect.objectContaining({
        status: "completed",
        gaps: expectedMarketCount("mls"),
      }),
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
      status: "degraded",
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
      healthKey: "sharpapi:mlb:odds",
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
      request: { leagueKey: "mlb" as const, providerEventId: "event-2" },
      now,
      fetchFocused,
    };
    expect(await runFocusedSharpOddsIngestion(common)).toEqual(
      expect.objectContaining({ status: "retryable", reason: "quota-reserve" }),
    );
    expect(fetchFocused).not.toHaveBeenCalled();

    await control.putHealth({
      ...(await control.getHealth("sharpapi:mlb:odds"))!,
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
            leagueKey: "mlb",
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
      new SharpApiError(
        "rate-limited",
        true,
        retryAt,
        "focused-odds:provider-error",
      ),
    );
    await expect(
      runFocusedSharpOddsIngestion({
        ...common,
        request: { leagueKey: "mls", providerEventId: "event-3" },
        now: new Date("2026-08-03T12:05:00.000Z"),
      }),
    ).rejects.toThrow("rate-limited");
    expect(await control.getHealth("sharpapi:mls:odds")).toEqual(
      expect.objectContaining({
        cooldownUntil: retryAt,
        failureStage: "focused-odds:provider-error",
      }),
    );
    expect(
      await control.getAttempt(
        sharpOddsRequestIdentity({
          leagueKey: "mls",
          endpointMode: "focused",
          providerEventId: "event-3",
          marketSet: ["main"],
          now: new Date("2026-08-03T12:05:00.000Z"),
          pollingWindowSeconds: 300,
        }),
      ),
    ).toMatchObject({ failureStage: "focused-odds:provider-error" });
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
    expect(
      capabilityFailure(new Error("schedule-conflict-metric-pending")),
    ).toBe("conflict-metric-pending");
    for (const reason of [
      "mapping-canonical-missing",
      "mapping-canonical-scope-mismatch",
      "mapping-scope-mismatch",
      "sharpapi-odds-mapping-no-candidate",
      "sharpapi-odds-mapping-ambiguous-candidates",
      "sharpapi-odds-mapping-participant-mismatch",
      "sharpapi-odds-mapping-start-mismatch",
    ])
      expect(capabilityFailure(new Error(reason))).toBe(reason);
    expect(capabilityFailure(new Error("secret mapping detail"))).toBe(
      "mapping-quarantine",
    );
    for (const [reason, expected] of [
      ["run-owned", "provider-recovering"],
      ["schedule-attempt-reservation-conflict", "transition-conflict"],
      ["schedule-stored-event-conflict", "stored-event-conflict"],
      ["schedule-conflict-metric-pending", "conflict-metric-pending"],
    ] as const)
      expect(
        scheduleCapabilityFailure(new Error(reason), "event-reconcile"),
      ).toBe(expected);
    for (const reason of [
      "provider-unavailable",
      "rate-limited",
      "unauthorized",
      "not-entitled",
      "invalid-response",
      "quota-reserve",
      "provider-request-ambiguous",
      "mapping-quarantine",
      "pagination-invalid",
      "transition-conflict",
    ])
      expect(
        scheduleCapabilityFailure(new Error(reason), "schedule-fetch"),
      ).toBe(reason);
    for (const reason of [
      "invalid-event-reconciliation-lock",
      "event-reconciliation-lock-timeout",
      "event-reconciliation-ownership-lost",
      "dynamo-conditional-conflict",
      "identity-snapshot-unstable",
      "dangling-identity-aggregate",
      "stale-identity-aggregate",
      "mapping-canonical-missing",
      "mapping-canonical-scope-mismatch",
      "event-projection-pointer-missing",
      "event-projection-pointer-corrupt",
      "event-projection-active-missing",
      "event-projection-active-corrupt",
      "bootstrap-stale",
      "identity-register-conflict",
      "identity-snapshot-mismatch",
      "canonical-revision-provider-limit",
      "mapped-canonical-participants-missing",
      "near-canonical-participants-missing",
      "multiple-current-event-projections",
      "near-canonical-projection-stale",
      "mapping-scope-mismatch",
      "bootstrap-identity-already-exists",
      "bootstrap-identity-snapshot-mismatch",
      "identity-conflict-count-exhausted",
      "invalid-scheduled-reconciliation",
      "reconciliation-participants-required",
      "invalid-provider-event-mapping",
      "invalid-provider-revision",
      "invalid-canonical-event",
      "invalid-identity-claim",
      "identity-version-exhausted",
      "version-exhausted",
      "bootstrap-response-conflict",
      "bootstrap-failed",
      "event-reconciliation-acquisition-failed",
      "event-reconciliation-execution-failed",
      "event-reconciliation-renewal-failed",
      "event-reconciliation-cleanup-failed",
    ])
      expect(
        scheduleCapabilityFailure(new Error(reason), "event-reconcile"),
      ).toBe(`provider-error-${reason}`);
    for (const [name, reason] of [
      ["ValidationException", "storage-validation"],
      ["ResourceNotFoundException", "storage-resource-missing"],
      ["ProvisionedThroughputExceededException", "storage-throttled"],
      ["ThrottlingException", "storage-throttled"],
      ["RequestLimitExceeded", "storage-throttled"],
      ["TransactionCanceledException", "storage-transaction-cancelled"],
      ["TransactionInProgressException", "storage-transaction-in-progress"],
      ["InternalServerError", "storage-unavailable"],
      ["ServiceUnavailable", "storage-unavailable"],
    ] as const) {
      const error = new Error("sensitive provider detail");
      error.name = name;
      expect(scheduleCapabilityFailure(error, "event-reconcile")).toBe(
        `provider-error-${reason}`,
      );
      expect(scheduleCapabilityFailure(error, "schedule-fetch")).toBe(
        "provider-error-schedule-fetch",
      );
    }
    for (const reason of [
      "invalid-event-reconciliation-lock",
      "event-reconciliation-lock-timeout",
      "event-reconciliation-ownership-lost",
      "mapping-canonical-missing",
      "event-projection-active-corrupt",
    ])
      expect(
        scheduleCapabilityFailure(new Error(reason), "schedule-fetch"),
      ).toBe("provider-error-schedule-fetch");
    for (const error of [
      new Error("secret provider detail"),
      new Error("secret mapping detail"),
      new Error("secret pagination detail"),
      Object.assign(new Error("secret provider detail"), {
        name: "SensitiveProviderException",
      }),
      "mapping-canonical-missing",
      { message: "event-reconciliation-lock-timeout" },
      null,
    ])
      expect(scheduleCapabilityFailure(error, "event-reconcile")).toBe(
        "provider-error-event-reconcile",
      );
    expect(
      scheduleCapabilityFailure(new Error("unknown"), "raw-secret" as never),
    ).toBe("provider-error-initialize");
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
    ] as const)
      expect(options.metrics.emit).toHaveBeenCalledWith(
        metric,
        1,
        expect.objectContaining({ provider: "sharpapi", league: "mlb" }),
      );
    const missingGaps = [...control.gaps.values()].filter(
      (gap) => gap.reason === "missing",
    );
    const mlbExpected = productionOddsCollectionPolicies.find(
      (policy) => policy.leagueKey === "mlb",
    )!.providers[0]!.expectedBooks as Readonly<
      Record<string, readonly string[]>
    >;
    expect(missingGaps.length).toBeGreaterThan(0);
    for (const gap of missingGaps)
      expect(mlbExpected).toHaveProperty(
        gap.sportsbookId!,
        expect.arrayContaining([gap.marketKey]),
      );
    expect(
      [...control.gaps.values()].find(
        (gap) => gap.reason === "missing-provider-timestamp",
      ),
    ).toMatchObject({ sourceState: "missing", sportsbookId: "draftkings" });
    expect(
      [...control.gaps.values()].filter((gap) => gap.reason === "unsupported"),
    ).toHaveLength(5);

    // Inside every cadence: nothing is due twenty seconds after the run.
    const gated = await runProductionOddsControlPlane({
      ...options,
      now: new Date("2026-08-03T12:00:20.000Z"),
    });
    expect(gated.map((result) => result.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(5);

    // Forty-five seconds in, the base cadence is still not due; only the
    // durable 12:45 scheduled start puts every league in its near-start
    // window, so odds refresh while schedule discovery stays skipped.
    const second = await runProductionOddsControlPlane({
      ...options,
      now: new Date("2026-08-03T12:00:45.000Z"),
    });
    expect(second.map((result) => result.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(fetchSharpSchedule).toHaveBeenCalledTimes(5);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(10);
  });

  it("keeps an approved book active when the same event continues on another page", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const reserveQuotaAttempt = vi.spyOn(control, "reserveQuotaAttempt");
    const persistAvailability = vi
      .fn<(value: FixtureOddsAvailabilityEvidence) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const mlbEvent = {
      providerEventId: "mlb-multipage-event",
      providerEventUuid: "mlb-multipage-uuid",
      awayTeam: "Boston Red Sox",
      homeTeam: "New York Yankees",
      startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
    };
    const prices = (["away", "home"] as const).map((selectionKey, index) => ({
      providerPriceId: `pinnacle-${selectionKey}`,
      marketKey: "moneyline" as const,
      outcomeStructure: "two-way" as const,
      providerMarketType: "moneyline",
      providerMarketId: "pinnacle-moneyline",
      selectionKey,
      selectionLabel:
        selectionKey === "away" ? mlbEvent.awayTeam : mlbEvent.homeTeam,
      providerSelectionId: `pinnacle-${selectionKey}`,
      americanOdds: index === 0 ? 110 : -120,
      decimalOdds: index === 0 ? 2.1 : 1.83,
      impliedProbability: index === 0 ? 0.476 : 0.545,
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      isActive: true,
      isSuspended: false,
      observedAt: at,
    }));
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events:
          league.leagueKey === "mlb"
            ? [{ ...mlbEvent, status: "scheduled" as const }]
            : [],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const fetchSharpOdds = vi.fn(
      (league: SharpApiLeague, _key: string, cursor?: string) =>
        Promise.resolve(
          league.leagueKey !== "mlb"
            ? { events: [], hasMore: false, retrievedAt: at }
            : cursor
              ? {
                  events: [
                    {
                      ...mlbEvent,
                      bookmakers: [
                        {
                          id: "pinnacle",
                          label: "Pinnacle",
                          prices: [prices[1]!],
                        },
                      ],
                    },
                  ],
                  hasMore: false,
                  retrievedAt: "2026-08-03T12:01:00.000Z" as IsoTimestamp,
                }
              : {
                  events: [
                    {
                      ...mlbEvent,
                      bookmakers: [
                        {
                          id: "pinnacle",
                          label: "Pinnacle",
                          prices: [prices[0]!],
                        },
                      ],
                    },
                  ],
                  hasMore: true,
                  nextCursor: "mlb-page-2",
                  retrievedAt: at,
                },
        ),
    );
    const metrics = { emit: vi.fn() };
    const persist = vi.fn().mockResolvedValue({
      snapshot: "created",
      current: "advanced",
    });

    await runProductionOddsControlPlane({
      events,
      odds: {
        persist,
        persistAvailability,
      },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      metrics,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
      }),
    });

    expect(fetchSharpOdds).toHaveBeenCalledWith(
      expect.objectContaining({ leagueKey: "mlb" }),
      "sharp-key",
      "mlb-page-2",
    );
    expect(
      reserveQuotaAttempt.mock.calls.some(
        ([key, , cost]) => key === "sharpapi:mlb:odds" && cost === 2,
      ),
    ).toBe(true);
    expect(persistAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "active",
      }),
    );
    expect(
      persistAvailability.mock.calls.some(
        ([value]) => value.state === "missing",
      ),
    ).toBe(false);
    const pinnacleGroupStates = persistAvailability.mock.calls
      .map(([value]) => value)
      .filter((value) =>
        ["complete-market", "incomplete-market"].includes(value.reason),
      );
    expect(pinnacleGroupStates.map(({ state }) => state)).toEqual(["active"]);
    expect(pinnacleGroupStates.at(-1)?.state).toBe("active");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        persist.mock.calls.map(
          ([value]) =>
            (value as FixtureOddsIngestInput).observation.retrievedAt,
        ),
      ),
    ).toEqual(new Set([at, "2026-08-03T12:01:00.000Z"]));
    expect(
      [...control.gaps.values()].some(
        (gap) => gap.sportsbookId === "pinnacle" && gap.reason === "missing",
      ),
    ).toBe(false);
    expect(metrics.emit).toHaveBeenCalledWith(
      "OddsRunPinnacleCoverage",
      1,
      expect.objectContaining({ league: "mlb", status: "observed" }),
    );
  });

  it("reconstructs selection siblings from legacy sealed Sharp pages", async () => {
    const control = new MemoryOddsControlPlaneStore();
    const identity = {
      providerEventId: "legacy-event",
      providerEventUuid: "legacy-uuid",
      awayTeam: "Boston Red Sox",
      homeTeam: "New York Yankees",
      startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
    };
    const material = (
      selectionKey: "away" | "home",
      retrievedAt: string,
      startsAt = identity.startsAt,
      reversed = false,
    ) => ({
      kind: "sharpapi",
      page: {
        events: [
          {
            ...identity,
            startsAt,
            ...(reversed
              ? {
                  awayTeam: identity.homeTeam,
                  homeTeam: identity.awayTeam,
                }
              : {}),
            bookmakers: [
              {
                id: "pinnacle",
                label: "Pinnacle",
                prices: [
                  {
                    providerPriceId: `legacy-${reversed ? "reversed-" : ""}${selectionKey}`,
                    selectionKey,
                  },
                ],
              },
            ],
          },
        ],
        hasMore: false,
        retrievedAt,
      },
    });
    await control.sealPage({
      runId: "legacy-run",
      pageToken: "start",
      nextPageToken: "two",
      responseDigest: "one",
      normalizedItems: [material("away", at)],
      gaps: [],
      quotaCost: 1,
      sealedAt: at,
    });
    await control.sealPage({
      runId: "legacy-run",
      pageToken: "two",
      responseDigest: "two",
      normalizedItems: [
        material(
          "away",
          "2026-08-03T12:01:00.000Z",
          "2026-08-03T21:00:00.000Z" as IsoTimestamp,
          true,
        ),
      ],
      gaps: [],
      quotaCost: 1,
      sealedAt: at,
    });

    const merged = await reconstructSharpOddsRun(control, "legacy-run");
    expect(
      merged.events[0]?.bookmakers[0]?.prices.map(
        ({ selectionKey }) => selectionKey,
      ),
    ).toEqual(["away", "home"]);
    expect(merged.events[0]?.startsAt).toBe(identity.startsAt);
    expect(merged.retrievedAt).toBe("2026-08-03T12:01:00.000Z");
    expect(merged.eventRetrievedAt?.[identity.providerEventId]).toBe(at);
    expect(
      merged.events[0]?.bookmakers[0]?.prices.map(
        ({ retrievedAt }) => retrievedAt,
      ),
    ).toEqual([at, "2026-08-03T12:01:00.000Z"]);

    await control.sealPage({
      runId: "broken-run",
      pageToken: "start",
      nextPageToken: "missing",
      responseDigest: "broken",
      normalizedItems: [material("away", at)],
      gaps: [],
      quotaCost: 1,
      sealedAt: at,
    });
    await expect(
      reconstructSharpOddsRun(control, "broken-run"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "invalid-response",
        stage: "odds:sealed-page-missing",
      }),
    );
  });

  it("keeps the latest repricing for a stable cross-page price identity", async () => {
    const pageMaterial = (
      americanOdds: number,
      observedAt: IsoTimestamp,
      providerMarketId = "market-1",
      selectionLabel = "Away",
      point = -1.5,
    ) => ({
      kind: "sharpapi",
      page: {
        events: [
          {
            providerEventId: "repriced-event",
            providerEventUuid: "repriced-event-uuid",
            awayTeam: "Away",
            homeTeam: "Home",
            startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
            bookmakers: [
              {
                id: "pinnacle",
                label: "Pinnacle",
                prices: [
                  {
                    providerPriceId: "stable-price-id",
                    marketKey: "spread" as const,
                    providerMarketType: "spread",
                    providerMarketId,
                    selectionKey: "away" as const,
                    outcomeStructure: "two-way" as const,
                    selectionLabel,
                    providerSelectionId: "away-selection",
                    point,
                    americanOdds,
                    decimalOdds:
                      americanOdds > 0
                        ? 1 + americanOdds / 100
                        : 1 + 100 / -americanOdds,
                    impliedProbability:
                      americanOdds > 0
                        ? 100 / (americanOdds + 100)
                        : -americanOdds / (-americanOdds + 100),
                    isLive: false,
                    isMainLine: true,
                    isAlternateLine: false,
                    isPlayerProp: false,
                    isStalePregamePrice: false,
                    observedAt,
                  },
                ],
              },
            ],
          },
        ],
        hasMore: false,
        retrievedAt: observedAt,
      },
    });
    const seal = async (
      control: MemoryOddsControlPlaneStore,
      runId: string,
      pageToken: string,
      material: ReturnType<typeof pageMaterial>,
      nextPageToken?: string,
    ) =>
      control.sealPage({
        runId,
        pageToken,
        ...(nextPageToken ? { nextPageToken } : {}),
        responseDigest: `${runId}:${pageToken}`,
        normalizedItems: [material],
        gaps: [],
        quotaCost: 1,
        sealedAt: at,
      });

    const control = new MemoryOddsControlPlaneStore();
    await seal(
      control,
      "repriced-run",
      "start",
      pageMaterial(110, "2026-08-03T12:00:00.000Z" as IsoTimestamp),
      "two",
    );
    await seal(
      control,
      "repriced-run",
      "two",
      pageMaterial(
        125,
        "2026-08-03T12:01:00.000Z" as IsoTimestamp,
        "market-1",
        "Away +2.5",
        2.5,
      ),
    );
    const merged = await reconstructSharpOddsRun(control, "repriced-run");
    expect(merged.events[0]?.bookmakers[0]?.prices[0]).toMatchObject({
      providerPriceId: "stable-price-id",
      americanOdds: 125,
      selectionLabel: "Away +2.5",
      point: 2.5,
      observedAt: "2026-08-03T12:01:00.000Z",
    });

    const conflict = new MemoryOddsControlPlaneStore();
    await seal(
      conflict,
      "identity-conflict-run",
      "start",
      pageMaterial(110, "2026-08-03T12:00:00.000Z" as IsoTimestamp),
      "two",
    );
    await seal(
      conflict,
      "identity-conflict-run",
      "two",
      pageMaterial(
        125,
        "2026-08-03T12:01:00.000Z" as IsoTimestamp,
        "different-market",
      ),
    );
    await expect(
      reconstructSharpOddsRun(conflict, "identity-conflict-run"),
    ).rejects.toMatchObject({
      code: "invalid-response",
      stage: "odds:cross-page-price-conflict",
    });
  });

  it("persists scoped missing availability for a scheduled event omitted from odds", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const persistAvailability = vi
      .fn<(value: FixtureOddsAvailabilityEvidence) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const resolveBinding = vi.spyOn(events, "resolveExactCanonicalBinding");
    const providerEventId = "mlb-scheduled-without-odds";
    await runProductionOddsControlPlane({
      events,
      odds: { persist: vi.fn(), persistAvailability },
      splits: {
        persist: vi.fn(),
        current: vi.fn(),
        listCurrent: vi.fn(),
        persistGap: vi.fn(),
      },
      control,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule: vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events:
            league.leagueKey === "mlb"
              ? [
                  {
                    providerEventId,
                    awayTeam: "Boston Red Sox",
                    homeTeam: "New York Yankees",
                    startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
                    status: "scheduled" as const,
                  },
                ]
              : [],
          hasMore: false,
          retrievedAt: at,
        }),
      ),
      fetchSharpOdds: vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      }),
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
      }),
    });

    expect(persistAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "missing",
        reason: "provider-market-omitted",
      }),
    );
    expect(resolveBinding).toHaveBeenCalledWith({
      providerId: "sharpapi",
      providerEventId,
      sportKey: "mlb",
      leagueKey: "mlb",
    });
    expect(
      [...control.gaps.values()].some(
        (gap) =>
          gap.providerEventId === providerEventId && gap.reason === "missing",
      ),
    ).toBe(true);
  });
  it("withholds fresh schedule readiness when continuation cleanup fails", async () => {
    class CleanupFailingControl extends MemoryOddsControlPlaneStore {
      override async clearContinuation(
        ...args: Parameters<MemoryOddsControlPlaneStore["clearContinuation"]>
      ) {
        if (args[0].startsWith("schedule:sharpapi:")) {
          const error = new Error("denied");
          error.name = "AccessDeniedException";
          throw error;
        }
        return super.clearContinuation(...args);
      }
    }
    const control = new CleanupFailingControl();
    const fetchSharpOdds = vi.fn();
    const results = await runProductionOddsControlPlane({
      events: new MemoryEventIngestionStore(),
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
      forceRefresh: true,
      fetchSharpSchedule: (league) =>
        Promise.resolve({
          events: [
            {
              providerEventId: `${league.leagueKey}-event`,
              awayTeam: "Away",
              homeTeam: "Home",
              startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
              status: "scheduled" as const,
            },
          ],
          hasMore: false,
          retrievedAt: at,
        }),
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 15,
        streamingEnabled: false,
      }),
    });

    expect(fetchSharpOdds).not.toHaveBeenCalled();
    expect(results).toHaveLength(5);
    expect(results.every(({ pages }) => pages === 0)).toBe(true);
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

  it("keeps contaminated MLB participants out of reconciliation and schedule state", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) => {
      if (league.leagueKey === "mlb")
        return Promise.resolve(
          parseSharpApiSchedulePage(
            {
              data: [
                {
                  id: "mlb-valid",
                  league: "mlb",
                  away_team: "Boston Red Sox",
                  home_team: "New York Yankees",
                  start_time: "2026-08-03T20:00:00.000Z",
                  status: "upcoming",
                  is_live: false,
                },
                {
                  id: "mlb-foreign",
                  league: "mlb",
                  away_team: "Yomiuri Giants",
                  home_team: "Hanshin Tigers",
                  start_time: "2026-08-03T21:00:00.000Z",
                  status: "upcoming",
                  is_live: false,
                },
              ],
              pagination: { has_more: false, next_offset: null },
            },
            league,
            at,
          ),
        );
      return Promise.resolve({
        events: [
          {
            providerEventId: `${league.leagueKey}-event`,
            awayTeam: `${league.leagueKey} Away`,
            homeTeam: `${league.leagueKey} Home`,
            startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
            status: "scheduled" as const,
          },
        ],
        hasMore: false,
        retrievedAt: at,
      });
    });
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
      metrics,
      fetchSharpSchedule,
      fetchSharpOdds: vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events: [],
          hasMore: false,
          retrievedAt: at,
          ...(league.leagueKey === "mlb" ? { rejections: [] } : {}),
        }),
      ),
      fetchSharpAccount: vi.fn().mockResolvedValue({
        tier: "pro",
        features: [],
        requestsPerMinute: 300,
        maxBooks: 15,
        streamingEnabled: false,
      }),
    });
    expect(result.every(({ status }) => status === "completed")).toBe(true);
    expect(
      [...events.mappings.values()].map(
        ({ providerEventId }) => providerEventId,
      ),
    ).toContain("mlb-valid");
    expect(
      [...events.mappings.values()].map(
        ({ providerEventId }) => providerEventId,
      ),
    ).not.toContain("mlb-foreign");
    expect(await control.getCheckpoint("schedule:sharpapi:mlb")).toMatchObject({
      upcomingStarts: ["2026-08-03T20:00:00.000Z"],
      expectedProviderEventIds: ["mlb-valid"],
      expectedProviderEvents: [
        {
          providerEventId: "mlb-valid",
          startsAt: "2026-08-03T20:00:00.000Z",
        },
      ],
    });
    expect(metrics.emit).toHaveBeenCalledWith("OddsScheduleExcluded", 1, {
      provider: "sharpapi",
      league: "mlb",
      reason: "participant-out-of-scope",
    });
  });

  it("uses a closed classifier for only deterministic event-scoped schedule conflicts", () => {
    for (const reason of [
      "schedule-mapping-unresolved",
      "canonical-candidate-conflict",
      "identity-claim-conflict",
      "mapping-provenance-conflict",
      "provider-revision-content-conflict",
      "bootstrap-content-mismatch",
      "bootstrap-revision-content-conflict",
    ] as const)
      expect(
        scheduleEventConflictReason(new ScheduleEventConflictError(reason)),
      ).toBe(reason);
    for (const reason of [
      "event-reconciliation-lock-timeout",
      "event-reconciliation-ownership-lost",
      "dynamo-transaction-failed",
      "sharpapi-schedule-pagination-invalid",
      "continuation-transition-conflict",
      "unknown-failure",
    ])
      expect(scheduleEventConflictReason(new Error(reason))).toBeNull();
    expect(
      scheduleEventConflictReason("provider-revision-content-conflict"),
    ).toBeNull();
    expect(
      scheduleEventConflictReason(
        new Error("provider-revision-content-conflict"),
      ),
    ).toBeNull();
  });

  it("quarantines one typed identity conflict while retaining valid siblings", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };
    await control.putCheckpoint({
      leagueKey: "schedule:sharpapi:mlb",
      providerId: "sharpapi",
      completedAt: "2026-08-03T10:00:00.000Z",
      nextDueAt: "2026-08-03T11:00:00.000Z",
      runId: "prior-mlb-schedule",
      upcomingStarts: ["2026-08-03T19:00:00.000Z", "2026-08-03T21:00:00.000Z"],
      expectedProviderEventIds: ["prior-only", "mlb-conflict"],
      expectedProviderEvents: [
        {
          providerEventId: "prior-only",
          startsAt: "2026-08-03T19:00:00.000Z",
        },
        {
          providerEventId: "mlb-conflict",
          startsAt: "2026-08-03T21:00:00.000Z",
        },
      ],
    });
    const reconcile = events.reconcileScheduledEvent.bind(events);
    vi.spyOn(events, "reconcileScheduledEvent").mockImplementation((input) =>
      input.event.providerEventId === "mlb-conflict"
        ? Promise.reject(new EventDataConflict("identity-claim-conflict"))
        : reconcile(input),
    );
    const scheduleRow = (providerEventId: string, startsAt: IsoTimestamp) => ({
      providerEventId,
      awayTeam: "Away",
      homeTeam: "Home",
      startsAt,
      status: "scheduled" as const,
    });
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events:
          league.leagueKey === "mlb"
            ? [
                scheduleRow(
                  "mlb-valid-a",
                  "2026-08-03T20:00:00.000Z" as IsoTimestamp,
                ),
                scheduleRow(
                  "mlb-conflict",
                  "2026-08-03T21:00:00.000Z" as IsoTimestamp,
                ),
                scheduleRow(
                  "mlb-valid-b",
                  "2026-08-03T22:00:00.000Z" as IsoTimestamp,
                ),
              ]
            : [
                scheduleRow(
                  `${league.leagueKey}-event`,
                  "2026-08-03T20:00:00.000Z" as IsoTimestamp,
                ),
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
      metrics,
      sharpApiKey: "sharp-key",
      now,
      fetchSharpSchedule,
      fetchSharpOdds: vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events: [],
          hasMore: false,
          retrievedAt: at,
          ...(league.leagueKey === "mlb" ? { rejections: [] } : {}),
        }),
      ),
      fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
    });
    expect(result.every(({ status }) => status === "completed")).toBe(true);
    expect(await control.getCheckpoint("schedule:sharpapi:mlb")).toMatchObject({
      expectedProviderEventIds: ["mlb-valid-a", "mlb-valid-b"],
      upcomingStarts: ["2026-08-03T20:00:00.000Z", "2026-08-03T22:00:00.000Z"],
    });
    const conflictGap = [...control.gaps.values()].find(
      ({ reason }) => reason === "identity-claim-conflict",
    );
    expect(conflictGap).toMatchObject({
      runId: "schedule:mlb:2026-08-03T12:00:00.000Z",
      reason: "identity-claim-conflict",
    });
    expect(conflictGap).not.toHaveProperty("providerEventId");
    expect(await control.getHealth("sharpapi:mlb:schedule")).toMatchObject({
      healthy: true,
      degraded: true,
      degradedReason: "stored-event-conflict",
      degradedCount: 1,
    });
    expect(metrics.emit).toHaveBeenCalledWith("OddsScheduleEventConflict", 1, {
      provider: "sharpapi",
      league: "mlb",
      reason: "identity-claim-conflict",
    });
  });

  for (const replayMode of ["resolved", "different-category"] as const)
    it(`replays a sealed conflict after it becomes ${replayMode}`, async () => {
      const events = new MemoryEventIngestionStore();
      const control = new MemoryOddsControlPlaneStore();
      const metrics = { emit: vi.fn() };
      const reconcile = events.reconcileScheduledEvent.bind(events);
      let conflictState: typeof replayMode | "original" = "original";
      let conflictReconciliationCalls = 0;
      vi.spyOn(events, "reconcileScheduledEvent").mockImplementation(
        (input) => {
          if (input.event.providerEventId !== "mlb-conflict")
            return reconcile(input);
          conflictReconciliationCalls += 1;
          if (conflictState === "resolved") return reconcile(input);
          return Promise.reject(
            new EventDataConflict(
              conflictState === "different-category"
                ? "provider-revision-content-conflict"
                : "mapping-provenance-conflict",
            ),
          );
        },
      );
      const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events: [
            {
              providerEventId:
                league.leagueKey === "mlb"
                  ? "mlb-conflict"
                  : `${league.leagueKey}-event`,
              awayTeam: "Away",
              homeTeam: "Home",
              startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
              status: "scheduled" as const,
            },
            ...(league.leagueKey === "mlb"
              ? [
                  {
                    providerEventId: "mlb-valid",
                    awayTeam: "Other Away",
                    homeTeam: "Other Home",
                    startsAt: "2026-08-03T21:00:00.000Z" as IsoTimestamp,
                    status: "scheduled" as const,
                  },
                ]
              : []),
          ],
          hasMore: false,
          retrievedAt: at,
        }),
      );
      const commitEvidencePage = control.commitEvidencePage.bind(control);
      let failConflictCommit = replayMode === "different-category";
      let liveTime = now.getTime();
      vi.spyOn(control, "commitEvidencePage").mockImplementation(
        (run, token, at) => {
          if (token === "0:schedule-conflicts" && failConflictCommit) {
            failConflictCommit = false;
            return Promise.reject(new Error("conflict-page-commit-failed"));
          }
          return commitEvidencePage(run, token, at);
        },
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
        clock: () => new Date(liveTime),
        fetchSharpSchedule,
        fetchSharpOdds: vi.fn().mockResolvedValue({
          events: [],
          hasMore: false,
          retrievedAt: at,
        }),
        fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
      };
      const firstResults = await runProductionOddsControlPlane(options);
      const pendingConflictPage = await control.getPage(
        "schedule:mlb:2026-08-03T12:00:00.000Z",
        "0:schedule-conflicts",
      );
      expect(pendingConflictPage).toMatchObject({
        gaps: [{ reason: "mapping-provenance-conflict" }],
      });
      if (replayMode === "resolved") {
        expect(firstResults[0]).toMatchObject({
          status: "failed",
          reason: "schedule-conflict-metric-pending",
        });
        expect(pendingConflictPage).toMatchObject({ committedAt: at });
        expect(await control.getCheckpoint("schedule:sharpapi:mlb")).toBeNull();
        expect(
          await control.getContinuation("schedule:sharpapi:mlb"),
        ).not.toBeNull();
      } else expect(pendingConflictPage).not.toHaveProperty("committedAt");
      expect(pendingConflictPage).not.toHaveProperty("metricDeliveredAt");
      conflictState = replayMode;
      liveTime += 301_000;
      const replayResults = await runProductionOddsControlPlane({
        ...options,
        metrics,
      });
      expect(replayResults[0]).toMatchObject({
        status: "completed",
        providerId: "sharpapi",
      });
      expect(
        fetchSharpSchedule.mock.calls.filter(
          ([league]) => league.leagueKey === "mlb",
        ),
      ).toHaveLength(1);
      expect(conflictReconciliationCalls).toBe(1);
      const conflictGaps = [...control.gaps.values()].filter(
        ({ reason }) => reason === "mapping-provenance-conflict",
      );
      expect(conflictGaps).toHaveLength(1);
      expect(conflictGaps[0]?.runId).toBe(
        "schedule:mlb:2026-08-03T12:00:00.000Z",
      );
      expect(
        metrics.emit.mock.calls.filter(
          ([name]) => name === "OddsScheduleEventConflict",
        ),
      ).toHaveLength(1);
      expect(
        [...events.mappings.values()].filter(
          ({ providerEventId }) => providerEventId === "mlb-valid",
        ),
      ).toHaveLength(1);
      expect(
        await control.getCheckpoint("schedule:sharpapi:mlb"),
      ).toMatchObject({
        expectedProviderEventIds: ["mlb-valid"],
      });
      expect(await control.getContinuation("schedule:sharpapi:mlb")).toBeNull();
      expect(
        await control.getPage(
          "schedule:mlb:2026-08-03T12:00:00.000Z",
          "0:schedule-conflicts",
        ),
      ).toMatchObject({
        committedAt: at,
        metricDeliveredAt: at,
        gaps: [{ reason: "mapping-provenance-conflict" }],
      });
    });

  it("keeps an all-conflicted schedule unhealthy and lets systemic failures abort", async () => {
    const runCase = async (failure: string, seedPriorCheckpoint = false) => {
      const events = new MemoryEventIngestionStore();
      const control = new MemoryOddsControlPlaneStore();
      const reconcile = events.reconcileScheduledEvent.bind(events);
      vi.spyOn(events, "reconcileScheduledEvent").mockImplementation((input) =>
        input.event.providerEventId === "mlb-event"
          ? failure === "schedule-mapping-unresolved"
            ? Promise.resolve({
                kind: "unresolved" as const,
                reason: "ambiguous-candidates" as const,
              })
            : failure === "event-reconciliation-lock-timeout"
              ? Promise.reject(new Error(failure))
              : Promise.reject(new EventDataConflict(failure as never))
          : reconcile(input),
      );
      const fetchSharpOdds = vi.fn().mockResolvedValue({
        events: [],
        hasMore: false,
        retrievedAt: at,
      });
      if (seedPriorCheckpoint)
        await control.putCheckpoint({
          leagueKey: "schedule:sharpapi:mlb",
          providerId: "sharpapi",
          completedAt: "2026-08-03T10:00:00.000Z",
          nextDueAt: "2026-08-03T11:00:00.000Z",
          runId: "last-known-good",
          upcomingStarts: ["2026-08-03T20:00:00.000Z"],
          expectedProviderEventIds: ["mlb-event"],
          expectedProviderEvents: [
            {
              providerEventId: "mlb-event",
              startsAt: "2026-08-03T20:00:00.000Z",
            },
          ],
        });
      const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
        Promise.resolve({
          events: [
            {
              providerEventId: `${league.leagueKey}-event`,
              awayTeam: "Away",
              homeTeam: "Home",
              startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
              status: "scheduled" as const,
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
        metrics: { emit: vi.fn() },
        sharpApiKey: "sharp-key",
        now,
        fetchSharpSchedule,
        fetchSharpOdds,
        fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
      };
      const results = await runProductionOddsControlPlane(options);
      return {
        control,
        fetchSharpOdds,
        fetchSharpSchedule,
        results,
        rerun: () => runProductionOddsControlPlane(options),
      };
    };
    for (const reason of [
      "schedule-mapping-unresolved",
      "canonical-candidate-conflict",
      "identity-claim-conflict",
      "mapping-provenance-conflict",
      "provider-revision-content-conflict",
      "bootstrap-content-mismatch",
      "bootstrap-revision-content-conflict",
    ]) {
      const deterministic = await runCase(
        reason,
        reason === "schedule-mapping-unresolved",
      );
      expect(deterministic.results[0]).toMatchObject({
        status: "failed",
        reason: "schedule-stored-event-conflict",
      });
      expect(
        await deterministic.control.getCheckpoint("schedule:sharpapi:mlb"),
      ).toMatchObject({
        expectedProviderEventIds: [],
        expectedProviderEvents: [],
        upcomingStarts: [],
        unavailableReason: "stored-event-conflict",
      });
      expect(
        deterministic.fetchSharpOdds.mock.calls.some(
          ([league]) => (league as SharpApiLeague).leagueKey === "mlb",
        ),
      ).toBe(false);
      const gap = [...deterministic.control.gaps.values()].find(
        (item) => item.reason === reason,
      );
      expect(gap).toBeDefined();
      const run = [...deterministic.control.runs.values()].find(
        (item) => item.leagueKey === "mlb",
      );
      expect(run).toMatchObject({
        status: "failed",
        evidenceCommitted: true,
        failureReason: "stored-event-conflict",
      });
      expect(gap?.runId).toBe(run?.runId);
      expect(
        await deterministic.control.getContinuation("schedule:sharpapi:mlb"),
      ).toBeNull();
      expect(
        await deterministic.control.getHealth("sharpapi:mlb:schedule"),
      ).toMatchObject({
        healthy: false,
        failureReason: "stored-event-conflict",
      });
      if (reason === "schedule-mapping-unresolved") {
        const mlbFetches = () =>
          deterministic.fetchSharpSchedule.mock.calls.filter(
            ([league]) => league.leagueKey === "mlb",
          ).length;
        expect(mlbFetches()).toBe(1);
        expect((await deterministic.rerun())[0]).toMatchObject({
          status: "failed",
          reason: "schedule-stored-event-conflict",
        });
        expect(mlbFetches()).toBe(1);
      }
    }

    const systemic = await runCase("event-reconciliation-lock-timeout");
    expect(systemic.results[0]).toMatchObject({
      status: "failed",
      reason: "schedule-provider-error-event-reconciliation-lock-timeout",
    });
    expect(
      systemic.fetchSharpOdds.mock.calls.some(
        ([league]) => (league as SharpApiLeague).leagueKey === "mlb",
      ),
    ).toBe(false);
    expect(
      await systemic.control.getHealth("sharpapi:mlb:schedule"),
    ).toMatchObject({
      healthy: false,
    });
    expect(
      [...systemic.control.runs.values()].find(
        ({ leagueKey }) => leagueKey === "mlb",
      ),
    ).toMatchObject({
      status: "failed",
      failureReason: "provider-error-event-reconciliation-lock-timeout",
    });
    expect(
      [...systemic.control.gaps.values()].filter(({ reason }) =>
        [
          "schedule-mapping-unresolved",
          "canonical-candidate-conflict",
          "identity-claim-conflict",
          "mapping-provenance-conflict",
          "provider-revision-content-conflict",
          "bootstrap-content-mismatch",
          "bootstrap-revision-content-conflict",
        ].includes(reason),
      ),
    ).toHaveLength(0);
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

  it("does not poison provider health when another schedule worker owns the lease", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    for (const { leagueKey } of productionOddsCollectionPolicies) {
      if (leagueKey === "mlb") continue;
      await control.putCheckpoint({
        leagueKey: `schedule:sharpapi:${leagueKey}`,
        providerId: "sharpapi",
        completedAt: "2026-08-03T11:00:00.000Z",
        nextDueAt: "2026-08-03T13:00:00.000Z",
        runId: `stored-${leagueKey}`,
        upcomingStarts: ["2026-08-03T20:00:00.000Z"],
        expectedProviderEventIds: [`${leagueKey}-event`],
        expectedProviderEvents: [
          {
            providerEventId: `${leagueKey}-event`,
            startsAt: "2026-08-03T20:00:00.000Z",
          },
        ],
      });
    }
    await control.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:schedule",
      healthy: true,
      status: "healthy",
      consecutiveSuccesses: 4,
      quotaRemaining: 900,
      updatedAt: "2026-08-03T11:55:00.000Z",
    });
    await control.claimContinuation({
      leagueKey: "schedule:sharpapi:mlb",
      runId: "active-mlb-schedule",
      providerId: "sharpapi",
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      capability: "schedule",
      evidenceCommitted: false,
      quotaCost: 0,
      ownerId: "active-owner",
      leaseUntil: "2026-08-03T12:05:00.000Z",
    });
    const fetchSharpSchedule = vi.fn();
    const fetchSharpOdds = vi.fn().mockResolvedValue({
      events: [],
      hasMore: false,
      retrievedAt: at,
    });

    const results = await runProductionOddsControlPlane({
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
      clock: () => now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
    });

    expect(results.find(({ leagueKey }) => leagueKey === "mlb")).toMatchObject({
      status: "skipped",
      reason: "schedule-provider-recovering",
    });
    expect(fetchSharpSchedule).not.toHaveBeenCalled();
    expect(await control.getHealth("sharpapi:mlb:schedule")).toMatchObject({
      healthy: true,
      status: "healthy",
      consecutiveSuccesses: 4,
      quotaRemaining: 900,
      updatedAt: "2026-08-03T11:55:00.000Z",
    });
  });

  it("takes over an expired schedule lease and reuses its sealed paid page", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    for (const { leagueKey } of productionOddsCollectionPolicies) {
      if (leagueKey === "mlb") continue;
      await control.putCheckpoint({
        leagueKey: `schedule:sharpapi:${leagueKey}`,
        providerId: "sharpapi",
        completedAt: "2026-08-03T11:00:00.000Z",
        nextDueAt: "2026-08-03T13:00:00.000Z",
        runId: `stored-${leagueKey}`,
        upcomingStarts: ["2026-08-03T20:00:00.000Z"],
        expectedProviderEventIds: [`${leagueKey}-event`],
        expectedProviderEvents: [
          {
            providerEventId: `${leagueKey}-event`,
            startsAt: "2026-08-03T20:00:00.000Z",
          },
        ],
      });
    }
    await control.putRun({
      runId: "interrupted-mlb-schedule",
      leagueKey: "mlb",
      providerId: "sharpapi",
      policyVersion: "test",
      status: "running",
      startedAt: "2026-08-03T11:50:00.000Z",
      updatedAt: "2026-08-03T11:55:00.000Z",
      evidenceCommitted: false,
      quotaCost: 1,
    });
    await control.claimContinuation({
      leagueKey: "schedule:sharpapi:mlb",
      runId: "interrupted-mlb-schedule",
      providerId: "sharpapi",
      updatedAt: "2026-08-03T11:50:00.000Z",
      startedAt: "2026-08-03T11:50:00.000Z",
      capability: "schedule",
      evidenceCommitted: false,
      quotaCost: 1,
      ownerId: "expired-owner",
      leaseUntil: "2026-08-03T11:55:00.000Z",
    });
    await control.sealPage({
      runId: "interrupted-mlb-schedule",
      pageToken: "0",
      responseDigest: "already-paid",
      normalizedItems: [
        {
          events: [
            {
              providerEventId: "mlb-recovered-event",
              awayTeam: "Away",
              homeTeam: "Home",
              startsAt: "2026-08-03T20:00:00.000Z",
              status: "scheduled",
            },
          ],
          hasMore: false,
          retrievedAt: at,
          responseMetadata: {
            rateWindow: {
              limit: 1_000,
              remaining: 777,
              resetsAt: "2026-08-03T12:15:00.000Z",
            },
          },
        },
      ],
      gaps: [],
      quotaCost: 1,
      sealedAt: "2026-08-03T11:54:00.000Z",
    });
    const fetchSharpSchedule = vi.fn();
    const fetchSharpOdds = vi.fn().mockResolvedValue({
      events: [],
      hasMore: false,
      retrievedAt: at,
    });

    const results = await runProductionOddsControlPlane({
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
      clock: () => now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
    });

    expect(results.find(({ leagueKey }) => leagueKey === "mlb")).toMatchObject({
      status: "completed",
      providerId: "sharpapi",
    });
    expect(
      fetchSharpSchedule.mock.calls.some(
        ([league]) => (league as SharpApiLeague).leagueKey === "mlb",
      ),
    ).toBe(false);
    expect(await control.getContinuation("schedule:sharpapi:mlb")).toBeNull();
    expect(await control.getCheckpoint("schedule:sharpapi:mlb")).toMatchObject({
      runId: "interrupted-mlb-schedule",
      expectedProviderEventIds: ["mlb-recovered-event"],
    });
    expect(await control.getHealth("sharpapi:mlb:schedule")).toMatchObject({
      rateWindow: { limit: 1_000, remaining: 777 },
    });
  });

  it("pairs legacy checkpoint IDs and starts only when their lengths match", async () => {
    const events = new MemoryEventIngestionStore();
    const control = new MemoryOddsControlPlaneStore();
    for (const [leagueKey, ids, starts] of [
      ["mlb", ["legacy-mlb"], ["2026-08-03T20:00:00.000Z"]],
      ["mls", ["legacy-mls", "orphan-id"], ["2026-08-03T21:00:00.000Z"]],
    ] as const)
      await control.putCheckpoint({
        leagueKey: `schedule:sharpapi:${leagueKey}`,
        providerId: "sharpapi",
        completedAt: "2026-08-03T11:00:00.000Z",
        nextDueAt: "2026-08-03T13:00:00.000Z",
        runId: `legacy-${leagueKey}`,
        expectedProviderEventIds: ids,
        upcomingStarts: starts,
      });
    const fetchSharpSchedule = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            providerEventId: `${league.leagueKey}-fresh`,
            awayTeam: "Away",
            homeTeam: "Home",
            startsAt: "2026-08-03T20:00:00.000Z" as IsoTimestamp,
            status: "scheduled" as const,
          },
        ],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const fetchSharpOdds = vi.fn().mockResolvedValue({
      events: [],
      hasMore: false,
      retrievedAt: at,
    });
    const results = await runProductionOddsControlPlane({
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
    expect(
      fetchSharpSchedule.mock.calls.some(
        ([league]) => league.leagueKey === "mlb",
      ),
    ).toBe(false);
    expect(
      fetchSharpSchedule.mock.calls.some(
        ([league]) => league.leagueKey === "mls",
      ),
    ).toBe(false);
    expect(
      fetchSharpOdds.mock.calls.some(
        ([league]) => (league as SharpApiLeague).leagueKey === "mlb",
      ),
    ).toBe(true);
    expect(
      fetchSharpOdds.mock.calls.some(
        ([league]) => (league as SharpApiLeague).leagueKey === "mls",
      ),
    ).toBe(false);
    expect(results[0]?.status).toBe("completed");
    expect(results[1]).toMatchObject({
      status: "failed",
      reason: "schedule-dependency-failed",
    });
  });
});
