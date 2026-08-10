import {
  MemoryClosingLinesRepository,
  MemoryClvRepository,
} from "@find-the-edge/database";
import type { GameDisplayDto } from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import { captureClosingLines } from "./closing-lines-capture";

const now = new Date("2026-08-10T23:20:00.000Z");
const game = (overrides: Partial<GameDisplayDto> = {}): GameDisplayDto =>
  ({
    id: "event-1",
    version: 2,
    sportKey: "mlb",
    leagueKey: "mlb",
    participants: [
      { id: "away", label: "Away Club" },
      { id: "home", label: "Home Club" },
    ],
    startsAt: "2026-08-10T23:10:00.000Z",
    status: "in_progress",
    odds: {
      state: "available",
      selections: [
        {
          marketKey: "moneyline",
          selectionKey: "participant:away",
          sportsbookId: "hardrock",
          americanOdds: 120,
          sharpAmericanOdds: 118,
          observedAt: "2026-08-10T23:09:00.000Z",
          retrievedAt: "2026-08-10T23:09:30.000Z",
        },
        {
          marketKey: "moneyline",
          selectionKey: "participant:home",
          sportsbookId: "hardrock",
          americanOdds: -135,
          observedAt: "2026-08-10T23:09:00.000Z",
          retrievedAt: "2026-08-10T23:09:30.000Z",
        },
      ],
    },
    ...overrides,
  }) as GameDisplayDto;

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

describe("closing lines capture", () => {
  it("captures a just-started priced game exactly once", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    const first = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(first).toEqual({ captured: 1, failed: 0, clvScored: 0 });
    const record = await closingLines.get("event-1");
    expect(record?.selections).toHaveLength(2);
    expect(record?.selections[0]?.sharpAmericanOdds).toBe(118);
    expect(record?.capturedAt).toBe(now.toISOString());
    // The next tick sees the existing record and leaves it untouched.
    const replay = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      new Date(now.getTime() + 60_000),
    );
    expect(replay).toEqual({ captured: 0, failed: 0, clvScored: 0 });
    expect((await closingLines.get("event-1"))?.capturedAt).toBe(
      now.toISOString(),
    );
  });

  it("skips unstarted, long-started, and unpriced games", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    const result = await captureClosingLines(
      {
        games: games([
          game({
            id: "not-started",
            startsAt: "2026-08-11T00:00:00.000Z",
          }),
          game({
            id: "long-started",
            startsAt: "2026-08-10T20:00:00.000Z",
          }),
          game({
            id: "unpriced",
            odds: { state: "unavailable" },
          }),
        ]),
        closingLines,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result).toEqual({ captured: 0, failed: 0, clvScored: 0 });
    expect(closingLines.records.size).toBe(0);
  });

  it("scores qualified entries against the closing fair line", async () => {
    const closingLines = new MemoryClosingLinesRepository();
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
    // A moved-line entry (different point) is skipped, never fabricated.
    await clv.putEntry({
      logicalOpportunityId: `opportunity:${"b".repeat(64)}`,
      canonicalEventId: "event-1",
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "total",
      selectionKey: "over",
      point: 9.5,
      entryAmericanOdds: -105,
      entryFairProbability: null,
      evaluatedAt: "2026-08-10T20:00:00.000Z",
    });
    const result = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        clv,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result).toEqual({ captured: 1, failed: 0, clvScored: 1 });
    const board = await clv.board("mlb");
    expect(board?.results).toHaveLength(1);
    const scored = board!.results[0]!;
    // Closing anchor exists only on the away side, so the fair de-vigs the
    // display book: p(+120)/(p(+120)+p(-135)) = 0.4416; entry +135 EV is
    // positive — the entry beat the close.
    expect(scored.closingSource).toBe("display-book");
    expect(scored.clvPercent).toBeCloseTo(3.78, 1);
    // Replay ticks never rescore: capture already exists.
    const replay = await captureClosingLines(
      {
        games: games([game()]),
        closingLines,
        clv,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      new Date(now.getTime() + 60_000),
    );
    expect(replay.clvScored).toBe(0);
    expect((await clv.board("mlb"))?.results).toHaveLength(1);
  });

  it("counts a failing board read without aborting the pass", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    const result = await captureClosingLines(
      {
        games: { list: () => Promise.reject(new Error("board-read-failed")) },
        closingLines,
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      now,
    );
    expect(result.captured).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
  });
});
