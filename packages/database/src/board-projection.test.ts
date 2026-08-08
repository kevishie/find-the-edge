import { describe, expect, it, vi } from "vitest";
import {
  BOARD_MAX_AGE_MS,
  boardPartition,
  materializationTargets,
  materializeBoards,
  scheduleListingKeys,
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
  const NOON = new Date("2026-08-08T16:00:00.000Z");
  const game = (
    id: string,
    startsAt: string,
    status = "scheduled",
    freshness: string | null = "2026-08-08T12:00:00.000Z",
  ) => ({ id, status, startsAt, freshness });
  const noSplits = () => Promise.resolve(false);
  const withSplits = () => Promise.resolve(true);

  it("keeps a real game whose suffix churned between schedule runs", async () => {
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_guardians_whitesox_2026-08-08_b3",
          "2026-08-08T23:15:00.000Z",
        ),
      ],
      freshness: "2026-08-08T12:00:00.000Z",
    };
    const filtered = await withoutWithdrawnListings(page, {
      // The schedule lists the same game under a different suffix.
      scheduleKeys: scheduleListingKeys([
        {
          providerEventId: "mlb_guardians_whitesox_2026-08-08_b2",
          startsAt: "2026-08-08T23:15:00.000Z",
        },
      ]),
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: noSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("drops a withdrawn duplicate that shares its base with the real game", async () => {
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b0",
          "2026-08-08T06:50:00.000Z",
          "scheduled",
          "2026-08-08T06:00:00.000Z",
        ),
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
          "2026-08-08T20:10:00.000Z",
        ),
      ],
      freshness: "2026-08-08T06:00:00.000Z",
    };
    const filtered = await withoutWithdrawnListings(page, {
      scheduleKeys: scheduleListingKeys([
        {
          providerEventId: "mlb_athletics_redsox_2026-08-08_b2",
          startsAt: "2026-08-08T20:10:00.000Z",
        },
      ]),
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: noSplits,
    });
    expect(filtered.items.map(({ id }) => id)).toEqual([
      "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
    ]);
    expect(filtered.freshness).toBe("2026-08-08T12:00:00.000Z");
  });

  it("keeps an in-play game through its splits witness", async () => {
    // In-play games leave the schedule feed but their splits persist.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_braves_yankees_2026-08-08_b2",
          "2026-08-08T15:05:00.000Z",
        ),
      ],
      freshness: null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      scheduleKeys: scheduleListingKeys([]),
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: withSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("drops a future listing the provider no longer has", async () => {
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_future_phantom_2026-08-08_b1",
          "2026-08-08T23:59:00.000Z",
        ),
      ],
      freshness: null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      scheduleKeys: scheduleListingKeys([]),
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: withSplits,
    });
    expect(filtered.items).toHaveLength(0);
  });

  it("keeps past-start absentees in a league without split coverage", async () => {
    const page = {
      items: [
        game(
          "event:soccer%3Amls:mls_inplay_2026-08-08_b1",
          "2026-08-08T15:00:00.000Z",
        ),
      ],
      freshness: null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      scheduleKeys: scheduleListingKeys([]),
      now: NOON,
      splitsExpected: false,
      hasSplitEvidence: noSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("fails open without a schedule and keeps every game", async () => {
    const page = {
      items: [
        game("event:mlb%3Amlb:mlb_phantom_b0", "2026-08-08T06:50:00.000Z"),
      ],
      freshness: null,
    };
    expect(
      await withoutWithdrawnListings(page, {
        scheduleKeys: null,
        now: NOON,
        splitsExpected: true,
        hasSplitEvidence: noSplits,
      }),
    ).toBe(page);
  });
});
