import { describe, expect, it, vi } from "vitest";
import {
  EventDataConflict,
  MemoryEventIngestionStore,
  MemoryOddsControlPlaneStore,
} from "@find-the-edge/database";
import type { IsoTimestamp } from "@find-the-edge/domain";
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
  runFocusedSharpOddsIngestion,
  runProductionOddsControlPlane,
  scheduleEventConflictReason,
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
    expect(
      capabilityFailure(new Error("schedule-conflict-metric-pending")),
    ).toBe("conflict-metric-pending");
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
