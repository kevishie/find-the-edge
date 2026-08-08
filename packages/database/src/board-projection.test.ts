import { describe, expect, it, vi } from "vitest";
import {
  BOARD_MAX_AGE_MS,
  boardPartition,
  materializationTargets,
  materializeBoards,
  usableScheduleListings,
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
    // Splits boards exist only where the provider publishes splits.
    expect(
      materializationTargets(NOW).filter(({ route }) => route === "splits"),
    ).toEqual(
      materializationTargets(NOW).filter(
        ({ route, sportKey }) => route === "splits" && sportKey === "mlb",
      ),
    );
    const targets = materializationTargets(NOW);
    expect(targets).toHaveLength(10);
    expect(new Set(targets.map(boardPartition)).size).toBe(10);
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

    expect(result).toEqual({ stored: 10, skipped: 0 });
    const splitBoards = puts.filter(({ pk }) => pk.startsWith("BOARD#splits#"));
    const gameBoards = puts.filter(({ pk }) => pk.startsWith("BOARD#games#"));
    expect(splitBoards).toHaveLength(2);
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
    expect(result).toEqual({ stored: 0, skipped: 10 });
    expect(puts).toHaveLength(0);
  });
});

describe("withdrawn listings", () => {
  const NOON = new Date("2026-08-08T16:00:00.000Z");
  const game = (
    id: string,
    startsAt: string,
    labels: readonly [string, string],
    status = "scheduled",
    freshness: string | null = "2026-08-08T12:00:00.000Z",
  ) => ({
    id,
    status,
    startsAt,
    freshness,
    participants: labels.map((label) => ({ label })),
  });
  const listing = (awayTeam: string, homeTeam: string, startsAt: string) => ({
    awayTeam,
    homeTeam,
    startsAt,
  });
  const noSplits = () => Promise.resolve(false);
  const withSplits = () => Promise.resolve(true);

  it("keeps a real game whose provider id churned entirely", async () => {
    // Observed live: canonical mlb_chicagows_guardians_..., schedule
    // mlb_guardians_whitesox_... — same clubs, same start.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_chicagows_guardians_2026-08-08_b3",
          "2026-08-08T23:15:00.000Z",
          ["Cleveland Guardians", "Chicago White Sox"],
        ),
      ],
      freshness: "2026-08-08T12:00:00.000Z" as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing(
          "Cleveland Guardians",
          "Chicago White Sox",
          "2026-08-08T23:15:00Z",
        ),
      ],
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: noSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("tolerates club abbreviation churn in schedule labels", async () => {
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
          "2026-08-08T20:10:00.000Z",
          ["Athletics", "Boston Red Sox"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing("Oakland Athletics", "Boston Red Sox", "2026-08-08T20:10:00Z"),
      ],
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: noSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("drops a withdrawn duplicate hours away from the real start", async () => {
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b0",
          "2026-08-08T06:50:00.000Z",
          ["Athletics", "Boston Red Sox"],
          "scheduled",
          "2026-08-08T06:00:00.000Z",
        ),
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
          "2026-08-08T20:10:00.000Z",
          ["Athletics", "Boston Red Sox"],
        ),
      ],
      freshness: "2026-08-08T06:00:00.000Z" as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing("Oakland Athletics", "Boston Red Sox", "2026-08-08T20:10:00Z"),
      ],
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
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_braves_yankees_2026-08-08_b2",
          "2026-08-08T15:05:00.000Z",
          ["Atlanta Braves", "New York Yankees"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [],
      now: NOON,
      splitsExpected: true,
      hasSplitEvidence: withSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("keeps a game the provider flipped to in-play just before first pitch", async () => {
    // 16:07 now, 16:10 start: absent from the live=false schedule already,
    // but its splits witness proves it is a real game about to begin.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_angels_marlins_2026-08-08_b2",
          "2026-08-08T20:10:00.000Z",
          ["Los Angeles Angels", "Miami Marlins"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [],
      now: new Date("2026-08-08T20:07:00.000Z"),
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
          ["Ghost A", "Ghost B"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [],
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
          ["Inter Miami", "LA Galaxy"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [],
      now: NOON,
      splitsExpected: false,
      hasSplitEvidence: noSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("fails open without a schedule and drops junk listings from the set", async () => {
    const page = {
      items: [
        game("event:mlb%3Amlb:mlb_phantom_b0", "2026-08-08T06:50:00.000Z", [
          "Athletics",
          "Boston Red Sox",
        ]),
      ],
      freshness: null as string | null,
    };
    expect(
      await withoutWithdrawnListings(page, {
        schedule: null,
        now: NOON,
        splitsExpected: true,
        hasSplitEvidence: noSplits,
      }),
    ).toBe(page);
    // Rows without both clubs never enter the usable schedule.
    expect(
      usableScheduleListings([
        { awayTeam: "", homeTeam: "Guardians", startsAt: "x" },
        { homeTeam: "Guardians", startsAt: "x" },
        { awayTeam: "A", homeTeam: "B", startsAt: "x" },
      ]),
    ).toHaveLength(1);
  });
});
