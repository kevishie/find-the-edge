import { describe, expect, it, vi } from "vitest";
import {
  BOARD_MAX_AGE_MS,
  boardPartition,
  materializationTargets,
  materializeBoards,
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
  });
});

describe("materialization", () => {
  const page = (day: string) => ({
    items: [
      {
        id: `event:${day}`,
        version: 1,
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
                ? [upcoming("unavailable"), upcoming("unavailable")]
                : [upcoming("available"), upcoming("unavailable")],
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
    expect(result).toEqual({
      stored: 0,
      skipped: 10,
      scheduledOddsAgeSeconds: null,
      withdrawnDropped: 0,
      withdrawnByReason: {},
      pricedBySport: expect.any(Object) as Record<string, unknown>,
    });
    expect(puts).toHaveLength(0);
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
