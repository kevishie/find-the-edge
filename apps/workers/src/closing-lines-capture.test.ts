import {
  MemoryClosingLinesRepository,
  MemoryClvRepository,
} from "@find-the-edge/database";
import type {
  ClosingBookRecord,
  GameDisplayDto,
  IsoTimestamp,
} from "@find-the-edge/domain";
import {
  SharpApiError,
  type SharpApiClosingSnapshot,
} from "@find-the-edge/providers";
import { describe, expect, it, vi } from "vitest";
import { captureClosingLines } from "./closing-lines-capture";

const now = new Date("2026-08-10T23:20:00.000Z");
const game = (): GameDisplayDto => ({
  id: "event-1",
  version: 2,
  sportKey: "mlb",
  leagueKey: "mlb",
  competition: { key: "mlb", state: "provisional" },
  participants: [
    { id: "away", label: "Away Club" },
    { id: "home", label: "Home Club" },
  ],
  startsAt: "2026-08-10T23:10:00.000Z",
  status: "started",
  freshness: null,
  eastern: {
    timeZone: "America/New_York",
    calendarDay: "2026-08-10",
    display: "7:10 PM",
  },
  metadata: {
    lifecycle: { state: "started" },
    availability: "complete",
  } as never,
  odds: { state: "unavailable" },
});
const games = (items: readonly GameDisplayDto[]) => ({
  list: (filter: { day: string }) =>
    Promise.resolve({
      items: filter.day === "2026-08-10" ? items : [],
      nextCursor: null,
      projectionState: "ready",
      evaluationState: "complete",
      hasMoreUnknown: false,
      snapshotAt: now.toISOString(),
      freshness: null,
      unavailableReason: null,
    }) as never,
});
const price = (selectionKey: "away" | "home", odds: number) => ({
  providerMarketType: "moneyline" as const,
  marketKey: "moneyline" as const,
  providerMarketId: "moneyline",
  selectionKey,
  selectionLabel: selectionKey === "away" ? "Away Club" : "Home Club",
  providerSelectionId: selectionKey,
  canonicalKey: `moneyline:${selectionKey}`,
  americanOdds: odds,
  decimalOdds: odds > 0 ? 2.2 : 1.8,
  impliedProbability: 0.5,
  fairCloseDecimal: 2,
  closingProbability: 0.5,
  sourceUpdatedAt: "2026-08-10T23:09:00.000Z" as IsoTimestamp,
});
const snapshot = (
  books: SharpApiClosingSnapshot["books"],
): SharpApiClosingSnapshot => ({
  providerEventId: "provider-event-1",
  sport: "baseball",
  league: "MLB",
  awayTeam: "Away Club",
  homeTeam: "Home Club",
  startsAt: "2026-08-10T23:10:00.000Z" as IsoTimestamp,
  firstCapturedAt: "2026-08-10T23:10:00.000Z" as IsoTimestamp,
  books,
  rejections: [],
  retrievedAt: now.toISOString() as IsoTimestamp,
});
const book = (id: "hardrock" | "pinnacle", final = true) => ({
  id,
  providerSportsbookId: id,
  capturedAt: "2026-08-10T23:10:00.000Z" as IsoTimestamp,
  secondsBeforeKickoff: 0,
  captureTrigger: "kickoff" as const,
  isFinal: final,
  prices: [
    price("away", id === "pinnacle" ? 118 : 120),
    price("home", id === "pinnacle" ? -124 : -135),
  ],
});
const bound = async () => {
  const repository = new MemoryClosingLinesRepository();
  await repository.bind({
    canonicalEventId: "event-1",
    canonicalEventVersion: 2,
    providerId: "sharpapi",
    providerEventId: "provider-event-1",
    sportKey: "mlb",
    leagueKey: "mlb",
    startsAt: "2026-08-10T23:10:00.000Z",
    observedAt: "2026-08-10T22:00:00.000Z",
  });
  return repository;
};

describe("canonical closing lines capture", () => {
  it("persists finalized books independently and replays idempotently", async () => {
    const closingLines = await bound();
    const fetchClosing = vi
      .fn()
      .mockResolvedValue(snapshot([book("hardrock"), book("pinnacle")]));
    const first = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(first).toEqual({
      captured: 2,
      pending: 0,
      failed: 0,
      clvScored: 0,
      requests: 1,
    });
    expect(await closingLines.listFinalized("event-1")).toHaveLength(2);
    expect(
      (await closingLines.listFinalized("event-1"))[0]?.selections[0],
    ).toMatchObject({
      providerMarketId: "moneyline",
      providerSelectionId: "away",
      canonicalKey: "moneyline:away",
      impliedProbability: 0.5,
      closingProbability: 0.5,
    });
    const replay = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      new Date(now.getTime() + 60_000),
    );
    expect(replay.captured).toBe(0);
    expect(fetchClosing).toHaveBeenCalledTimes(1);
    expect(await closingLines.listFinalized("event-1")).toHaveLength(2);
  });

  it("merges a later finalized book without freezing a partial response", async () => {
    const closingLines = await bound();
    const fetchClosing = vi
      .fn()
      .mockResolvedValueOnce(
        snapshot([book("hardrock"), book("pinnacle", false)]),
      )
      .mockResolvedValueOnce(snapshot([book("hardrock"), book("pinnacle")]));
    await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(await closingLines.listFinalized("event-1")).toHaveLength(1);
    const later = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      new Date(now.getTime() + 60_000),
    );
    expect(later.captured).toBe(1);
    expect(await closingLines.listFinalized("event-1")).toHaveLength(2);
  });

  it("scores a qualified entry from the coherent finalized projection", async () => {
    const closingLines = await bound();
    const clv = new MemoryClvRepository();
    await clv.putEntry({
      logicalOpportunityId: `opportunity:${"a".repeat(64)}`,
      canonicalEventId: "event-1",
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      point: null,
      entryAmericanOdds: 135,
      entryFairProbability: 0.46,
      evaluatedAt: "2026-08-10T20:00:00.000Z",
    });
    const result = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        clv,
        fetchClosing: () =>
          Promise.resolve(snapshot([book("hardrock"), book("pinnacle")])),
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result.clvScored).toBe(1);
    expect((await clv.board("mlb"))?.results[0]?.closingSource).toBe(
      "display-book",
    );
  });

  it("leaves missing bindings and quota-blocked events pending", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    const fetchClosing = vi.fn();
    const missing = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(missing).toMatchObject({ captured: 0, pending: 1, requests: 0 });
    await closingLines.bind({
      canonicalEventId: "event-1",
      canonicalEventVersion: 2,
      providerId: "sharpapi",
      providerEventId: "provider-event-1",
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: game().startsAt,
      observedAt: now.toISOString(),
    });
    const blocked = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        reserveQuota: () => Promise.resolve(false),
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(blocked).toMatchObject({ pending: 1, requests: 0 });
    expect(fetchClosing).not.toHaveBeenCalled();
  });

  it("isolates one conflicting finalized book and persists its valid sibling", async () => {
    const backing = await bound();
    const closingLines = {
      getBinding: backing.getBinding.bind(backing),
      listBindings: backing.listBindings.bind(backing),
      listFinalized: backing.listFinalized.bind(backing),
      bind: backing.bind.bind(backing),
      capture: backing.capture.bind(backing),
      get: backing.get.bind(backing),
      finalizeBook: vi
        .fn()
        .mockRejectedValueOnce(new Error("closing-book-finalization-conflict"))
        .mockImplementation((record: ClosingBookRecord) =>
          backing.finalizeBook(record),
        ),
    };
    const result = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing: () =>
          Promise.resolve(snapshot([book("hardrock"), book("pinnacle")])),
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result).toMatchObject({ captured: 1, failed: 1, requests: 1 });
    expect((await backing.listFinalized("event-1"))[0]?.sportsbookId).toBe(
      "pinnacle",
    );
  });

  it("refuses a future canonical binding before quota or provider access", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    await closingLines.bind({
      canonicalEventId: "event-1",
      canonicalEventVersion: 3,
      providerId: "sharpapi",
      providerEventId: "provider-event-old",
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: game().startsAt,
      observedAt: now.toISOString(),
    });
    const fetchClosing = vi.fn();
    const reserveQuota = vi.fn();
    const result = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        reserveQuota,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result).toMatchObject({ captured: 0, pending: 1, requests: 0 });
    expect(fetchClosing).not.toHaveBeenCalled();
    expect(reserveQuota).not.toHaveBeenCalled();
  });

  it("reports structured provider failures so account health can cool down", async () => {
    const closingLines = await bound();
    const recordProviderFailure = vi.fn();
    const failure = new SharpApiError(
      "rate-limited",
      true,
      "2026-08-10T23:21:00.000Z" as IsoTimestamp,
    );
    const result = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing: () => Promise.reject(failure),
        recordProviderFailure,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result).toMatchObject({ failed: 1, requests: 1 });
    expect(recordProviderFailure).toHaveBeenCalledWith(failure);
  });

  it("retries CLV persistence without repeating a completed provider fetch", async () => {
    const closingLines = await bound();
    const backing = new MemoryClvRepository();
    await backing.putEntry({
      logicalOpportunityId: `opportunity:${"b".repeat(64)}`,
      canonicalEventId: "event-1",
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      point: null,
      entryAmericanOdds: 135,
      entryFairProbability: 0.46,
      evaluatedAt: "2026-08-10T20:00:00.000Z",
    });
    const appendResults = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage-unavailable"))
      .mockImplementation((...args: Parameters<typeof backing.appendResults>) =>
        backing.appendResults(...args),
      );
    const clv = {
      listEntries: backing.listEntries.bind(backing),
      appendResults,
    };
    const fetchClosing = vi
      .fn()
      .mockResolvedValue(snapshot([book("hardrock"), book("pinnacle")]));
    const first = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        clv,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(first).toMatchObject({ clvScored: 0, failed: 1, requests: 1 });
    const replay = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        clv,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      new Date(now.getTime() + 60_000),
    );
    expect(replay).toMatchObject({ clvScored: 1, requests: 0 });
    expect(fetchClosing).toHaveBeenCalledTimes(1);
  });

  it("uses a proven prior-version binding after identity-preserving churn", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    await closingLines.bind({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      providerId: "sharpapi",
      providerEventId: "provider-event-1",
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: game().startsAt,
      observedAt: now.toISOString(),
    });
    const fetchClosing = vi
      .fn()
      .mockResolvedValue(snapshot([book("hardrock"), book("pinnacle")]));
    const result = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        fetchClosing,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result).toMatchObject({ captured: 2, requests: 1, failed: 0 });
  });
});
