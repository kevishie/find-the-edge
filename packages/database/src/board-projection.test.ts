import { describe, expect, it, vi } from "vitest";
import {
  BOARD_MAX_AGE_MS,
  boardPartition,
  materializationTargets,
  materializeBoards,
  inspectBoardBody,
  usableScheduleListings,
  validateStoredBoard,
  withoutWithdrawnListings,
  attachSplits,
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
    expect(
      validateStoredBoard({ ...fresh, body: "é".repeat(200_000) }, NOW),
    ).toBeNull();
  });

  it("expires noncanonical games and splits at their earliest kickoff", () => {
    const kickoff = NOW.toISOString();
    const item = {
      id: "event:mlb:one",
      startsAt: kickoff,
      odds: {
        state: "available",
        selections: [],
        source: "pregame-snapshot",
      },
    };
    for (const extra of [{}, { splits: [] }]) {
      const board = {
        ...storedBoard(new Date(NOW.getTime() - 60_000).toISOString()),
        body: JSON.stringify({ items: [{ ...item, ...extra }] }),
      };
      expect(validateStoredBoard(board, new Date(NOW.getTime() - 1))).toEqual(
        board,
      );
      expect(validateStoredBoard(board, NOW)).toBeNull();
    }
  });

  it("keeps canonical closing boards eligible after kickoff", () => {
    const board = {
      ...storedBoard(new Date(NOW.getTime() - 60_000).toISOString()),
      body: JSON.stringify({
        items: [
          {
            id: "event:mlb:closed",
            startsAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
            odds: {
              state: "available",
              selections: [],
              source: "canonical-closing",
            },
          },
        ],
      }),
    };
    expect(validateStoredBoard(board, NOW)).toEqual(board);
    expect(inspectBoardBody(board.body)).toEqual({
      earliestUnsafeKickoff: null,
      earliestPregamePriceKickoff: null,
    });
  });

  it("rejects bodies that cannot prove item identity and provenance", () => {
    const fresh = storedBoard(new Date(NOW.getTime() - 60_000).toISOString());
    for (const body of [
      "not-json",
      JSON.stringify({}),
      JSON.stringify({ items: {} }),
      JSON.stringify({ items: [null] }),
      JSON.stringify({
        items: [{ startsAt: NOW.toISOString(), odds: { state: "available" } }],
      }),
      JSON.stringify({
        items: [{ id: "event", startsAt: "bad", odds: { state: "available" } }],
      }),
      JSON.stringify({
        items: [
          { id: "event", startsAt: "2026-08-08", odds: { state: "available" } },
        ],
      }),
      JSON.stringify({
        items: [
          {
            id: "event",
            startsAt: NOW.toISOString(),
            odds: { state: "available", source: "inferred-closing" },
          },
        ],
      }),
    ])
      expect(validateStoredBoard({ ...fresh, body }, NOW)).toBeNull();
  });

  it("treats legacy available odds without source as pregame evidence", () => {
    const kickoff = NOW.toISOString();
    const board = {
      ...storedBoard(new Date(NOW.getTime() - 60_000).toISOString()),
      body: JSON.stringify({
        items: [
          {
            id: "event:mlb:legacy",
            startsAt: kickoff,
            odds: { state: "available", selections: [] },
          },
        ],
      }),
    };
    expect(validateStoredBoard(board, new Date(NOW.getTime() - 1))).toEqual(
      board,
    );
    expect(validateStoredBoard(board, NOW)).toBeNull();
  });
});

describe("materialization", () => {
  const game = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    version: 1,
    sportKey: "soccer",
    leagueKey: "mls",
    status: "scheduled",
    startsAt: "2026-08-09T00:00:00.000Z",
    participants: [{ label: `Away ${id}` }, { label: `Home ${id}` }],
    freshness: NOW.toISOString(),
    odds: { state: "unavailable" },
    metadata: {
      freshness: {
        state: "current",
        evidenceAt: NOW.toISOString(),
      },
      availability: "available",
      evaluatedAt: NOW.toISOString(),
    },
    ...overrides,
  });
  const page = (day: string) => ({
    items: [game(`event:${day}`)],
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
        { id: "split-1", scope: "consensus", canonicalEventVersion: 1 },
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

    expect(result).toEqual({
      stored: 10,
      skipped: 0,
      scheduledOddsAgeSeconds: null,
      withdrawnDropped: 0,
      withdrawnByReason: {},
      skippedBoards: expect.any(Array) as unknown[],
      pricedBySport: expect.any(Object) as Record<string, unknown>,
    });
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

  it("reports the worst priced-scheduled odds age across boards", async () => {
    const retrievedAt = new Date(NOW.getTime() - 600_000).toISOString();
    const pricedPage = {
      ...page("2026-08-08"),
      items: [
        {
          ...page("2026-08-08").items[0]!,
          status: "scheduled",
          startsAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          odds: {
            state: "available",
            selections: [{ retrievedAt }, { retrievedAt }],
          },
        },
      ],
    };
    const result = await materializeBoards({
      games: { list: () => Promise.resolve(pricedPage as never) },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: () => Promise.resolve(),
      now: NOW,
    });
    expect(result.scheduledOddsAgeSeconds).toBe(600);
  });

  it("reports a sport whose upcoming games carry no price", async () => {
    // Board freshness is blind to this: with no price on the board there is
    // nothing to be stale. It is how soccer ran priceless for eleven hours.
    const upcoming = (state: "available" | "unavailable") => ({
      ...page("2026-08-08").items[0]!,
      status: "scheduled",
      startsAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      odds:
        state === "available"
          ? { state, selections: [{ retrievedAt: NOW.toISOString() }] }
          : { state },
    });
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          Promise.resolve({
            ...page("2026-08-08"),
            items:
              filter.sportKey === "soccer"
                ? [
                    upcoming("unavailable"),
                    {
                      ...upcoming("unavailable"),
                      id: "event:soccer-second",
                      participants: [
                        { label: "Second Away" },
                        { label: "Second Home" },
                      ],
                    },
                  ]
                : [
                    upcoming("available"),
                    {
                      ...upcoming("unavailable"),
                      id: "event:mlb-second",
                      participants: [
                        { label: "Second Away" },
                        { label: "Second Home" },
                      ],
                    },
                  ],
          } as never),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: () => Promise.resolve(),
      now: NOW,
    });
    // Both Eastern days are materialized, so each sport counts twice over.
    expect(result.pricedBySport["soccer"]).toEqual({ upcoming: 4, priced: 0 });
    expect(result.pricedBySport["mlb"]).toEqual({ upcoming: 4, priced: 2 });
  });

  it("materializes a physical second page after global duplicate collapse", async () => {
    const puts: { value: { body: string } }[] = [];
    const firstItems = Array.from({ length: 50 }, (_, index) =>
      game(`event:${index}`),
    );
    const replacement = game("event:replacement", {
      version: 2,
      participants: firstItems[0]!.participants,
      startsAt: firstItems[0]!.startsAt,
    });
    const result = await materializeBoards({
      games: {
        list: (_filter, _limit, cursor) =>
          Promise.resolve(
            (cursor
              ? { ...page("2026-08-08"), items: [replacement] }
              : {
                  ...page("2026-08-08"),
                  items: firstItems,
                  nextCursor: "second-page",
                }) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(10);
    expect(result.skipped).toBe(0);
    const body = JSON.parse(puts[0]!.value.body) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(50);
    expect(body.items.map(({ id }) => id)).toContain("event:replacement");
    expect(body.items.map(({ id }) => id)).not.toContain("event:0");
    expect(body.nextCursor).toBeNull();
  });

  it("applies withdrawal evidence across page boundaries", async () => {
    const ghost = game("event:ghost", {
      startsAt: "2026-08-08T06:50:00.000Z",
      participants: [
        { label: "Kansas City Royals" },
        { label: "Los Angeles Dodgers" },
      ],
    });
    const real = game("event:real", {
      startsAt: "2026-08-09T02:10:00.000Z",
      participants: ghost.participants,
    });
    const puts: { value: { body: string } }[] = [];
    const result = await materializeBoards({
      games: {
        list: (_filter, _limit, cursor) =>
          Promise.resolve(
            (cursor
              ? { ...page("2026-08-08"), items: [real] }
              : {
                  ...page("2026-08-08"),
                  items: [ghost],
                  nextCursor: "second-page",
                }) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
      scheduleListings: () =>
        Promise.resolve([
          {
            awayTeam: "Kansas City Royals",
            homeTeam: "Los Angeles Dodgers",
            startsAt: real.startsAt,
          },
        ]),
    });

    expect(result.stored).toBe(10);
    expect(result.withdrawnByReason["vouched-sibling"]).toBe(10);
    const body = JSON.parse(puts[0]!.value.body) as {
      items: { id: string }[];
    };
    expect(body.items.map(({ id }) => id)).toEqual(["event:real"]);
  });

  it("skips a genuine 51-game logical board without storing a partial page", async () => {
    const puts: unknown[] = [];
    const firstItems = Array.from({ length: 50 }, (_, index) =>
      game(`event:${index}`),
    );
    const result = await materializeBoards({
      games: {
        list: (_filter, _limit, cursor) =>
          Promise.resolve(
            (cursor
              ? { ...page("2026-08-08"), items: [game("event:50")] }
              : {
                  ...page("2026-08-08"),
                  items: firstItems,
                  nextCursor: "second-page",
                }) as never,
          ),
      },
      splits: { listCurrent: vi.fn() } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });
    expect(result).toEqual({
      stored: 0,
      skipped: 10,
      scheduledOddsAgeSeconds: null,
      withdrawnDropped: 0,
      withdrawnByReason: {},
      skippedBoards: expect.any(Array) as unknown[],
      pricedBySport: expect.any(Object) as Record<string, unknown>,
    });
    expect(puts).toHaveLength(0);
    // The count alone is what let this hide. On 2026-08-13 one Eastern day's
    // soccer board went unstored for over six hours while every other board
    // refreshed every three minutes, and `skipped` was returned unread — so
    // the skip has to name the board and the rule.
    expect(result.skippedBoards).toHaveLength(10);
    expect(result.skippedBoards[0]).toEqual({
      board: expect.stringContaining("BOARD#") as string,
      reason: "needs-cursor",
    });
    expect(new Set(result.skippedBoards.map(({ board }) => board)).size).toBe(
      10,
    );
  });

  it("isolates cursor cycles, snapshot drift, and page-bound failures", async () => {
    const puts: unknown[] = [];
    const calls = new Map<string, number>();
    const result = await materializeBoards({
      games: {
        list: (filter, _limit, cursor) => {
          const key = `${filter.sportKey}:${filter.status}:${filter.day}`;
          calls.set(key, (calls.get(key) ?? 0) + 1);
          if (key === "mlb:all:2026-08-08")
            return Promise.resolve({
              ...page(filter.day),
              items: [game(cursor ? "event:cycle-page" : "event:cycle-first")],
              nextCursor: cursor ? "cycle" : "cycle",
            } as never);
          if (key === "mlb:scheduled:2026-08-08")
            return Promise.resolve({
              ...page(filter.day),
              snapshotAt: cursor
                ? "2026-08-08T12:00:01.000Z"
                : NOW.toISOString(),
              nextCursor: cursor ? null : "drift",
            } as never);
          if (key === "soccer:all:2026-08-08") {
            const pageNumber = cursor ? Number(cursor.slice(1)) : 0;
            return Promise.resolve({
              ...page(filter.day),
              items: [game(`event:page-${String(pageNumber)}`)],
              nextCursor: `p${String(pageNumber + 1)}`,
            } as never);
          }
          return Promise.resolve(page(filter.day) as never);
        },
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    // The scheduled MLB filter feeds both the games and splits boards, so its
    // drifting chain invalidates two targets while the other six still store.
    expect(result.stored).toBe(6);
    expect(result.skipped).toBe(4);
    expect(puts).toHaveLength(6);
    expect(result.skippedBoards.map(({ reason }) => reason)).toEqual([
      "pagination-invalid",
      "pagination-invalid",
      "pagination-invalid",
      "pagination-invalid",
    ]);
    expect(calls.get("mlb:all:2026-08-08")).toBe(2);
    expect(calls.get("soccer:all:2026-08-08")).toBe(50);
  });

  it("rejects projection-state drift", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter, _limit, cursor) =>
          Promise.resolve(
            (filter.sportKey === "soccer" &&
            filter.status === "all" &&
            filter.day === "2026-08-09"
              ? {
                  ...page(filter.day),
                  items: [game(cursor ? "event:drift-2" : "event:drift-1")],
                  nextCursor: cursor ? null : "drift",
                  projectionState: cursor ? "uninitialized" : "ready",
                  unavailableReason: cursor ? "projection-uninitialized" : null,
                }
              : page(filter.day)) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(puts).toHaveLength(9);
    expect(result.skippedBoards[0]?.reason).toBe("pagination-invalid");
  });

  it("rejects unavailable-reason drift", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter, _limit, cursor) =>
          Promise.resolve(
            (filter.sportKey === "soccer" &&
            filter.status === "all" &&
            filter.day === "2026-08-09"
              ? {
                  ...page(filter.day),
                  items: [game(cursor ? "event:drift-2" : "event:drift-1")],
                  nextCursor: cursor ? null : "drift",
                  unavailableReason: cursor ? "projection-uninitialized" : null,
                }
              : page(filter.day)) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(puts).toHaveLength(9);
    expect(result.skippedBoards[0]?.reason).toBe("pagination-invalid");
  });

  it("rejects an event id repeated across pages and continues later boards", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter, _limit, cursor) => {
          if (
            filter.sportKey === "soccer" &&
            filter.status === "scheduled" &&
            filter.day === "2026-08-09"
          )
            return Promise.resolve({
              ...page(filter.day),
              items: [game("event:overlap")],
              nextCursor: cursor ? null : "overlap",
            } as never);
          return Promise.resolve(page(filter.day) as never);
        },
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(result.skipped).toBe(1);
    expect(puts).toHaveLength(9);
    expect(result.skippedBoards).toEqual([
      {
        board: boardPartition({
          route: "games",
          sportKey: "soccer",
          leagueKey: "mls",
          status: "scheduled",
          day: "2026-08-09",
          limit: 50,
        }),
        reason: "pagination-invalid",
      },
    ]);
  });

  it("rejects a terminal partial envelope and continues later boards", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          Promise.resolve(
            (filter.sportKey === "soccer" &&
            filter.status === "all" &&
            filter.day === "2026-08-09"
              ? {
                  ...page(filter.day),
                  evaluationState: "partial",
                  hasMoreUnknown: true,
                }
              : page(filter.day)) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(result.skipped).toBe(1);
    expect(puts).toHaveLength(9);
    expect(result.skippedBoards[0]?.reason).toBe("pagination-invalid");
  });

  it("reports repository read failures and continues later boards", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          filter.sportKey === "mlb" &&
          filter.status === "all" &&
          filter.day === "2026-08-08"
            ? Promise.reject(new Error("read failed"))
            : Promise.resolve(page(filter.day) as never),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(puts).toHaveLength(9);
    expect(result.skippedBoards[0]?.reason).toBe("repository-read-failed");
  });

  it.each([
    {
      name: "missing snapshot",
      broken: (filter: { day: string }) => ({
        ...page(filter.day),
        snapshotAt: null,
      }),
    },
    {
      name: "duplicate event ids",
      broken: (filter: { day: string }) => ({
        ...page(filter.day),
        items: [game("event:duplicate"), game("event:duplicate")],
      }),
    },
  ])("rejects a single page with $name", async ({ broken }) => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          Promise.resolve(
            (filter.sportKey === "soccer" &&
            filter.status === "all" &&
            filter.day === "2026-08-09"
              ? broken(filter)
              : page(filter.day)) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(puts).toHaveLength(9);
    expect(result.skippedBoards[0]?.reason).toBe("pagination-invalid");
  });

  it("reports an uninitialized terminal page as projection-not-ready", async () => {
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          Promise.resolve(
            (filter.sportKey === "soccer" &&
            filter.status === "all" &&
            filter.day === "2026-08-09"
              ? {
                  ...page(filter.day),
                  items: [],
                  projectionState: "uninitialized",
                  snapshotAt: null,
                  freshness: null,
                  unavailableReason: "projection-uninitialized",
                }
              : page(filter.day)) as never,
          ),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: () => Promise.resolve(),
      now: NOW,
    });

    expect(result.stored).toBe(9);
    expect(result.skipped).toBe(1);
    expect(result.skippedBoards).toContainEqual({
      board: boardPartition({
        route: "games",
        sportKey: "soccer",
        leagueKey: "mls",
        status: "all",
        day: "2026-08-09",
        limit: 50,
      }),
      reason: "projection-not-ready",
    });
  });

  it("recomputes freshness after single-page duplicate collapse", async () => {
    const puts: { value: { body: string } }[] = [];
    const retainedFreshness = "2026-08-08T11:59:00.000Z";
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          Promise.resolve({
            ...page(filter.day),
            freshness: "2026-08-08T01:00:00.000Z",
            items: [
              game("event:old", {
                freshness: "2026-08-08T01:00:00.000Z",
                participants: [
                  { label: "New York City FC" },
                  { label: "Inter Miami CF" },
                ],
              }),
              game("event:new", {
                version: 2,
                freshness: retainedFreshness,
                participants: [
                  { label: "New York City FC" },
                  { label: "Inter Miami CF" },
                ],
              }),
            ],
          } as never),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(10);
    const body = JSON.parse(puts[0]!.value.body) as {
      freshness: string | null;
      items: { id: string }[];
    };
    expect(body.items.map(({ id }) => id)).toEqual(["event:new"]);
    expect(body.freshness).toBe(retainedFreshness);
  });

  it("isolates split enrichment and storage failures per board", async () => {
    const puts: unknown[] = [];
    const result = await materializeBoards({
      games: {
        list: (filter) => Promise.resolve(page(filter.day) as never),
      },
      splits: {
        listCurrent: (eventId: string) =>
          eventId === "event:2026-08-08"
            ? Promise.reject(new Error("split failed"))
            : Promise.resolve([]),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        if (item.pk === "BOARD#games#soccer#mls#all#2026-08-09#50")
          return Promise.reject(new Error("put failed"));
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(8);
    expect(puts).toHaveLength(8);
    expect(result.skippedBoards.map(({ reason }) => reason)).toEqual([
      "split-enrichment-failed",
      "store-failed",
    ]);
  });

  it("enforces the write body limit in UTF-8 bytes", async () => {
    const puts: unknown[] = [];
    const oversized = game("event:large", {
      metadata: {
        ...game("metadata-template").metadata,
        diagnostic: "é".repeat(200_000),
      },
    });
    const result = await materializeBoards({
      games: {
        list: (filter) =>
          Promise.resolve({ ...page(filter.day), items: [oversized] } as never),
      },
      splits: {
        listCurrent: vi.fn(() => Promise.resolve([])),
      } as unknown as BettingSplitRepository,
      put: (item) => {
        puts.push(item);
        return Promise.resolve();
      },
      now: NOW,
    });

    expect(result.stored).toBe(0);
    expect(puts).toHaveLength(0);
    expect(new Set(result.skippedBoards.map(({ reason }) => reason))).toEqual(
      new Set(["body-too-big"]),
    );
  });
});

describe("schedule-orphaned duplicates", () => {
  const NOW = new Date("2026-08-11T21:19:00.000Z");
  const royals = (id: string, startsAt: string) => ({
    id,
    status: "scheduled",
    startsAt,
    freshness: "2026-08-11T21:00:00.000Z",
    participants: [
      { label: "Kansas City Royals" },
      { label: "Los Angeles Dodgers" },
    ],
  });

  it("drops a bucket-churned orphan while the vouched game stays", async () => {
    // One real game, two canonical events: the provider first published a
    // placeholder start (a different time bucket, so a different id) and then
    // corrected it. The orphan keeps the wrong kickoff and partial odds, and
    // it has split evidence too, so only the schedule can tell them apart.
    const page = {
      items: [
        royals("event:ghost", "2026-08-11T06:50:00.000Z"),
        royals("event:real", "2026-08-12T02:10:00.000Z"),
      ],
      freshness: "2026-08-11T21:00:00.000Z",
    };
    const result = await withoutWithdrawnListings(page, {
      schedule: [
        {
          awayTeam: "Kansas City Royals",
          homeTeam: "Los Angeles Dodgers",
          startsAt: "2026-08-12T02:10:00.000Z",
        },
      ],
      now: NOW,
      splitsExpected: true,
      splitWitnessAt: () => Promise.resolve("2026-08-08T11:30:00.000Z"),
    });
    expect(result.items.map(({ id }) => id)).toEqual(["event:real"]);
  });

  it("keeps both halves of a real doubleheader", async () => {
    // Same participants twice on one day is legitimate when the provider
    // lists both, which is exactly what separates it from an orphan.
    const page = {
      items: [
        royals("event:game-1", "2026-08-11T17:10:00.000Z"),
        royals("event:game-2", "2026-08-11T23:40:00.000Z"),
      ],
      freshness: "2026-08-11T21:00:00.000Z",
    };
    const result = await withoutWithdrawnListings(page, {
      schedule: [
        {
          awayTeam: "Kansas City Royals",
          homeTeam: "Los Angeles Dodgers",
          startsAt: "2026-08-11T17:10:00.000Z",
        },
        {
          awayTeam: "Kansas City Royals",
          homeTeam: "Los Angeles Dodgers",
          startsAt: "2026-08-11T23:40:00.000Z",
        },
      ],
      now: NOW,
      splitsExpected: true,
      splitWitnessAt: () => Promise.resolve("2026-08-08T11:30:00.000Z"),
    });
    expect(result.items.map(({ id }) => id)).toEqual([
      "event:game-1",
      "event:game-2",
    ]);
  });

  it("leaves a lone unlisted game to the older rules", async () => {
    // With no vouched sibling the new rule must not fire: an in-play game has
    // left the schedule feed and is still real, proven by its splits.
    const page = {
      items: [royals("event:in-play", "2026-08-11T20:00:00.000Z")],
      freshness: "2026-08-11T21:00:00.000Z",
    };
    const result = await withoutWithdrawnListings(page, {
      schedule: [],
      now: NOW,
      splitsExpected: true,
      splitWitnessAt: () => Promise.resolve("2026-08-08T11:30:00.000Z"),
    });
    expect(result.items.map(({ id }) => id)).toEqual(["event:in-play"]);
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
  // A witness reading is a timestamp now, not a boolean: "no splits" and "the
  // splits feed stopped" are different facts. FRESH is inside the ninety
  // minute window from NOON; ANCIENT is the 2026-08-12 twenty-hour freeze.
  const FRESH = "2026-08-08T15:30:00.000Z";
  const ANCIENT = "2026-08-07T20:00:00.000Z";
  const noSplits = () => Promise.resolve(null);
  const withSplits = () => Promise.resolve(FRESH);

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
      splitWitnessAt: noSplits,
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
      splitWitnessAt: noSplits,
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
      splitWitnessAt: noSplits,
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
      splitWitnessAt: withSplits,
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
      splitWitnessAt: withSplits,
    });
    expect(filtered.items).toHaveLength(1);
  });

  it("drops a future listing the provider no longer has and nothing vouches for", async () => {
    // This case previously used withSplits and still expected a drop. That
    // pinned an unconditional rule which, on 2026-08-12, deleted two real
    // games three hours before first pitch. A future absentee is now judged
    // by the same witness as a started one; with no witness it still goes.
    //
    // The board carries a live game too, and it has to: on a page where
    // nothing is fresh, "this game has no splits" and "the splits feed is
    // down" are the same observation. The live game is what proves the feed
    // is up, which is what earns the phantom its verdict.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_real_2026-08-08_b1",
          "2026-08-08T23:00:00.000Z",
          ["Boston Red Sox", "New York Yankees"],
        ),
        game(
          "event:mlb%3Amlb:mlb_future_phantom_2026-08-08_b1",
          "2026-08-08T23:59:00.000Z",
          ["Ghost A", "Ghost B"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing("Boston Red Sox", "New York Yankees", "2026-08-08T23:00:00Z"),
      ],
      now: NOON,
      splitsExpected: true,
      splitWitnessAt: (id) =>
        Promise.resolve(id.includes("phantom") ? null : FRESH),
    });
    expect(filtered.items.map(({ id }) => id)).toEqual([
      "event:mlb%3Amlb:mlb_real_2026-08-08_b1",
    ]);
  });

  it("names the rule that dropped each listing", async () => {
    // A single total cannot tell a correctly-rejected churn orphan from a
    // deleted real game, and those need opposite responses. On 2026-08-12 the
    // count was computed and discarded unread, so a reader reporting a short
    // board could not be answered from telemetry at all.
    const reasons: string[] = [];
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_real_2026-08-08_b2",
          "2026-08-08T23:00:00.000Z",
          ["Boston Red Sox", "New York Yankees"],
        ),
        // Same participants as the vouched game, placeholder kickoff.
        game(
          "event:mlb%3Amlb:mlb_orphan_2026-08-08_b0",
          "2026-08-08T21:00:00.000Z",
          ["Boston Red Sox", "New York Yankees"],
        ),
        // Past start, feed is live, nothing to say about this one.
        game(
          "event:mlb%3Amlb:mlb_silent_2026-08-08_b1",
          "2026-08-08T15:00:00.000Z",
          ["Chicago Cubs", "Washington Nationals"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing("Boston Red Sox", "New York Yankees", "2026-08-08T23:00:00Z"),
      ],
      now: NOON,
      splitsExpected: true,
      splitWitnessAt: (id) =>
        Promise.resolve(id.includes("real") ? FRESH : null),
      onDrop: (reason) => reasons.push(reason),
    });

    expect(filtered.items.map(({ id }) => id)).toEqual([
      "event:mlb%3Amlb:mlb_real_2026-08-08_b2",
    ]);
    expect(reasons.sort()).toEqual(["vouched-sibling", "witness-silent"]);
  });

  it("keeps every absentee when the splits feed itself has gone quiet", async () => {
    // Production 2026-08-12: MLB splits froze for nearly twenty hours while
    // every stored observation kept looking like evidence. A board must not
    // shrink because a provider went quiet, so a witness this stale is not
    // consulted at all — in either direction.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_started_2026-08-08_b1",
          "2026-08-08T15:00:00.000Z",
          ["Chicago Cubs", "Washington Nationals"],
        ),
        game(
          "event:mlb%3Amlb:mlb_future_2026-08-08_b1",
          "2026-08-08T23:59:00.000Z",
          ["Texas Rangers", "Los Angeles Angels"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [],
      now: NOON,
      splitsExpected: true,
      splitWitnessAt: () => Promise.resolve(ANCIENT),
    });
    expect(filtered.items).toHaveLength(2);
  });

  it("keeps a future game the catalogue rotated out while splits still carry it", async () => {
    // 2026-08-12: SharpAPI's MLB /events catalogue returned 416 rows for the
    // day and not one clean full-game row for either 22:10 Eastern game —
    // only Player Props, Kalshi binaries, and empty-participant rows, all of
    // which the parser correctly refuses. The splits feed published for both
    // on the same pass as every retained game.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_rangers_angels_2026-08-08_b3",
          "2026-08-08T23:10:00.000Z",
          ["Texas Rangers", "Los Angeles Angels"],
        ),
        game(
          "event:mlb%3Amlb:mlb_royals_dodgers_2026-08-08_b3",
          "2026-08-08T23:10:00.000Z",
          ["Kansas City Royals", "Los Angeles Dodgers"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing("Chicago Cubs", "Washington Nationals", "2026-08-08T22:45:00Z"),
      ],
      now: NOON,
      splitsExpected: true,
      splitWitnessAt: withSplits,
    });
    expect(filtered.items.map(({ id }) => id)).toEqual([
      "event:mlb%3Amlb:mlb_rangers_angels_2026-08-08_b3",
      "event:mlb%3Amlb:mlb_royals_dodgers_2026-08-08_b3",
    ]);
  });

  it("still drops a churned future orphan whose sibling the provider vouches for", async () => {
    // The witness cannot save this one: splits attach by participants and day,
    // so the orphan inherits the real game's. The vouched sibling decides.
    const page = {
      items: [
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b0",
          "2026-08-08T22:50:00.000Z",
          ["Athletics", "Boston Red Sox"],
        ),
        game(
          "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
          "2026-08-08T23:10:00.000Z",
          ["Athletics", "Boston Red Sox"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [
        listing("Oakland Athletics", "Boston Red Sox", "2026-08-08T23:10:00Z"),
      ],
      now: NOON,
      splitsExpected: true,
      splitWitnessAt: withSplits,
    });
    expect(filtered.items.map(({ id }) => id)).toEqual([
      "event:mlb%3Amlb:mlb_athletics_redsox_2026-08-08_b2",
    ]);
  });

  it("leaves a future absentee dropped in a league with no split witness", async () => {
    const page = {
      items: [
        game(
          "event:soccer%3Amls:mls_future_phantom_2026-08-08_b1",
          "2026-08-08T23:59:00.000Z",
          ["Inter Miami", "LA Galaxy"],
        ),
      ],
      freshness: null as string | null,
    };
    const filtered = await withoutWithdrawnListings(page, {
      schedule: [],
      now: NOON,
      splitsExpected: false,
      splitWitnessAt: noSplits,
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
      splitWitnessAt: noSplits,
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
        splitWitnessAt: noSplits,
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

it("never attaches split evidence from a higher canonical version than the event", async () => {
  // A rebuilt catalog restarts event versions at one while retained split
  // rows remember the prior lineage; those rows must not reach clients.
  const game = {
    id: "event:mlb%3Amlb:mlb_a_b_2026-08-09_b2",
    version: 1,
    sportKey: "mlb",
    leagueKey: "mlb",
  } as never;
  const splits = [
    { id: "stale", canonicalEventVersion: 2, scope: "betmgm" },
    { id: "fresh", canonicalEventVersion: 1, scope: "draftkings" },
  ] as never[];
  const page = await attachSplits(
    { items: [game] } as never,
    { listCurrent: () => Promise.resolve(splits) } as never,
    () => Promise.resolve(splits as never),
  );
  expect(
    (page.items[0] as { splits: readonly { id: string }[] }).splits.map(
      ({ id }) => id,
    ),
  ).toEqual(["fresh"]);
});
