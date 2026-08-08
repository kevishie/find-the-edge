import { describe, expect, it, vi } from "vitest";
import {
  BOARD_MAX_AGE_MS,
  boardPartition,
  materializationTargets,
  materializeBoards,
  validateStoredBoard,
  withoutWithdrawnListings,
} from "./board-projection";
import type { BettingSplitRepository } from "./index";

const NOW = new Date("2026-08-08T12:00:00.000Z");

const storedBoard = (generatedAt: string) => ({
  schemaVersion: 1 as const,
  generatedAt,
  body: JSON.stringify({ items: [] }),
  counts: { stale: 0, partial: 0, unavailable: 0 },
});

describe("stored board validation", () => {
  it("accepts a fresh well-formed board and rejects drifted ones", () => {
    const fresh = storedBoard(new Date(NOW.getTime() - 60_000).toISOString());
    expect(validateStoredBoard(fresh, NOW)).toEqual(fresh);
    // Stale, future, and malformed boards all fall back to the live path.
    expect(
      validateStoredBoard(
        storedBoard(
          new Date(NOW.getTime() - BOARD_MAX_AGE_MS - 1_000).toISOString(),
        ),
        NOW,
      ),
    ).toBeNull();
    expect(
      validateStoredBoard(
        storedBoard(new Date(NOW.getTime() + 120_000).toISOString()),
        NOW,
      ),
    ).toBeNull();
    for (const broken of [
      null,
      [],
      {},
      { ...fresh, schemaVersion: 2 },
      { ...fresh, body: "" },
      { ...fresh, generatedAt: "not-a-date" },
      { ...fresh, counts: { stale: -1, partial: 0, unavailable: 0 } },
      { ...fresh, counts: undefined },
    ])
      expect(validateStoredBoard(broken, NOW)).toBeNull();
  });
});

describe("materialization", () => {
  const page = (day: string) => ({
    items: [
      {
        id: `event:${day}`,
        metadata: {
          freshness: { state: "current" },
          availability: "available",
          evaluatedAt: NOW.toISOString(),
        },
      },
    ],
    nextCursor: null,
    projectionState: "ready" as const,
    evaluationState: "complete" as const,
    hasMoreUnknown: false,
    snapshotAt: NOW.toISOString(),
    freshness: null,
    unavailableReason: null,
  });

  it("targets both sports and both Eastern days with the default query", () => {
    expect(
      materializationTargets(NOW).filter(({ status }) => status === "all"),
    ).toHaveLength(4);
    const targets = materializationTargets(NOW);
    expect(targets).toHaveLength(12);
    expect(new Set(targets.map(boardPartition)).size).toBe(12);
    for (const target of targets) expect(target.limit).toBe(50);
    expect(new Set(targets.map(({ day }) => day))).toEqual(
      new Set(["2026-08-08", "2026-08-09"]),
    );
  });

  it("stores every board and attaches splits only on split boards", async () => {
    const puts: { pk: string; value: { body: string } }[] = [];
    const listCurrent = vi.fn(() =>
      Promise.resolve([
        { id: "split-1", scope: "consensus" },
        { id: "drop-me", scope: "draftkings" },
      ] as never),
    );
    const result = await materializeBoards({
      games: {
        list: (filter) => Promise.resolve(page(filter.day) as never),
      },
      splits: { listCurrent } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result).toEqual({ stored: 12, skipped: 0 });
    const splitBoards = puts.filter(({ pk }) => pk.startsWith("BOARD#splits#"));
    const gameBoards = puts.filter(({ pk }) => pk.startsWith("BOARD#games#"));
    expect(splitBoards).toHaveLength(4);
    expect(gameBoards).toHaveLength(8);
    for (const board of splitBoards) {
      const parsed = JSON.parse(board.value.body) as {
        items: { splits: { id: string }[] }[];
      };
      // The consensus filter ran during materialization, not at serve time.
      expect(parsed.items[0]!.splits.map(({ id }) => id)).toEqual(["split-1"]);
    }
    for (const board of gameBoards)
      expect(board.value.body).not.toContain('"splits"');
  });

  it("skips a board whose page would need a cursor", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: () =>
          Promise.resolve({ ...page("2026-08-08"), nextCursor: "sk" } as never),
      },
      splits: { listCurrent: vi.fn() } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });
    expect(result).toEqual({ stored: 0, skipped: 12 });
    expect(puts).toHaveLength(0);
  });
});

describe("withdrawn listings", () => {
  const game = (
    id: string,
    status = "scheduled",
    freshness: string | null = "2026-08-08T12:00:00.000Z",
  ) => ({
    id,
    status,
    freshness,
  });

  it("drops a scheduled game whose listing left the provider schedule", () => {
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b0",
          "scheduled",
          "2026-08-08T06:00:00.000Z",
        ),
        game("event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2"),
        game(
          "event:mlb%3Amlb:mlb_started_game_b1",
          "started",
          "2026-08-08T05:00:00.000Z",
        ),
      ],
      freshness: "2026-08-08T05:00:00.000Z",
    };
    const filtered = withoutWithdrawnListings(
      page,
      new Set(["mlb_athletics_redsox_2026-08-08_b2"]),
    );
    expect(filtered.items.map(({ id }) => id)).toEqual([
      "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
      // Non-scheduled lifecycles are never withdrawn by schedule absence.
      "event:mlb%3Amlb:mlb_started_game_b1",
    ]);
    // The oldest remaining freshness becomes the page freshness again.
    expect(filtered.freshness).toBe("2026-08-08T05:00:00.000Z");
  });

  it("fails open without a schedule and keeps every game", () => {
    const page = {
      items: [game("event:mlb%3Amlb:mlb_phantom_b0")],
      freshness: null,
    };
    expect(withoutWithdrawnListings(page, null)).toBe(page);
  });
});
