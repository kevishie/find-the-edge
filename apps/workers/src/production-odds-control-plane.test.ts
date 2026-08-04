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
            bookmakers: [],
          },
        ],
        hasMore: false,
        retrievedAt: at,
      }),
    );
    const fetchFallbackSchedule = vi.fn(() =>
      Promise.resolve({
        events: [],
        retrievedAt: at,
        quota: { used: 0 },
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
      theOddsApiKey: "fallback-key",
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
      fetchFallbackSchedule,
      fetchFallbackOdds: vi.fn(),
    };
    const first = await runProductionOddsControlPlane(options);
    expect(first.map((result) => result.providerId)).toEqual([
      "sharpapi",
      "sharpapi",
    ]);
    expect(fetchSharpSchedule).toHaveBeenCalledTimes(2);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(2);
    expect(
      [...control.gaps.values()].filter((gap) => gap.reason === "missing"),
    ).toHaveLength(12);
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
    expect(fetchFallbackSchedule).not.toHaveBeenCalled();
  });
  it("requires schedule readiness for the selected provider and isolates account setup failure", async () => {
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
    const fetchFallbackOdds = vi.fn(() =>
      Promise.resolve({
        events: [{ ...scheduleEvent("fallback-mlb"), bookmakers: [] }],
        quota: { used: 3, remaining: 500 },
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
      theOddsApiKey: "fallback-key",
      now,
      fetchSharpSchedule,
      fetchSharpOdds,
      fetchFallbackSchedule: vi.fn(() =>
        Promise.resolve({
          events: [{ ...scheduleEvent("fallback-mlb"), bookmakers: [] }],
          quota: { used: 1, remaining: 500 },
          retrievedAt: at,
        }),
      ),
      fetchFallbackOdds,
      fetchSharpAccount: vi.fn().mockRejectedValue(new Error("account-down")),
    });
    expect(result.map(({ providerId }) => providerId)).toEqual([
      "the-odds-api",
      "sharpapi",
    ]);
    expect(fetchSharpOdds).toHaveBeenCalledTimes(1);
    expect(fetchSharpOdds.mock.calls[0]?.[0].leagueKey).toBe("mls");
    expect(fetchFallbackOdds).toHaveBeenCalledTimes(1);
    expect(
      [...control.runs.values()].some(
        (run) => run.leagueKey === "account" && run.status === "failed",
      ),
    ).toBe(true);
  });
});
