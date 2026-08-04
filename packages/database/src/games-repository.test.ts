import { describe, expect, it } from "vitest";
import {
  normalizeFixtureOddsObservation,
  assessEventMetadata,
  type EventDisplayDto,
} from "@find-the-edge/domain";
import { EventStorageError } from "./event-errors";
import type { EventRepository } from "./event-repository";
import { JoinedGamesRepository } from "./games-repository";

const event: EventDisplayDto = {
  id: "event-1",
  version: 2,
  sportKey: "mlb",
  leagueKey: "mlb",
  competition: { key: "mlb", state: "provisional" },
  participants: [
    { id: "bos", label: "Boston" },
    { id: "nyy", label: "New York" },
  ],
  startsAt: "2026-08-01T17:00:00.000Z",
  eastern: {
    timeZone: "America/New_York",
    calendarDay: "2026-08-01",
    display: "Aug 1, 2026",
  },
  status: "scheduled",
  freshness: "2026-08-01T12:00:00.000Z",
  metadata: assessEventMetadata(
    "scheduled",
    "2026-08-01T12:00:00.000Z",
    "2026-08-01T12:30:00.000Z",
  ),
};
const events = (
  items: readonly EventDisplayDto[] = [event],
  seen: { cursor: string | undefined } = { cursor: undefined },
): EventRepository => ({
  list: async (_filter, _limit, cursor) => {
    await Promise.resolve();
    seen.cursor = cursor;
    return {
      items,
      nextCursor: "next",
      projectionState: "ready",
      evaluationState: "complete",
      hasMoreUnknown: false,
      snapshotAt: "2026-08-01T12:00:00.000Z",
      freshness: event.freshness,
      unavailableReason: null,
    };
  },
  detail: () =>
    Promise.resolve({
      projectionState: "ready",
      item: null,
      unavailableReason: null,
    }),
});
const current = (
  source: EventDisplayDto,
  selectionKey: string,
  selectionLabel: string,
  marketKey = "moneyline",
  sportsbookId = "draftkings",
  observedAt = "2026-08-01T12:00:00.000Z",
  point?: number,
) =>
  normalizeFixtureOddsObservation({
    canonicalEventId: source.id,
    canonicalEventVersion: source.version,
    sportKey: source.sportKey,
    marketKey,
    selectionKey,
    selectionLabel,
    sportsbookId,
    sportsbookLabel: sportsbookId === "draftkings" ? "DraftKings" : "FanDuel",
    ...(point === undefined ? {} : { point }),
    americanOdds: selectionKey === "home" ? -135 : 120,
    observedAt,
    retrievedAt: "2026-08-01T12:00:00.000Z",
  });
const row = (value: ReturnType<typeof current>) => ({
  pk: value.partitionKey,
  sk: "CURRENT",
  value,
});

describe("joined games repository", () => {
  it("preserves page metadata and rebuilds MLB away/home order independently of response order", async () => {
    const seen: {
      cursor: string | undefined;
      keys?: readonly unknown[];
    } = { cursor: undefined };
    const away = current(event, "away", "Boston");
    const home = current(event, "home", "New York");
    const page = await new JoinedGamesRepository(events([event], seen), {
      batchGet: (keys) => {
        seen.keys = keys;
        return Promise.resolve([row(home), row(away)]);
      },
    }).list(
      { sportKey: "mlb", status: "scheduled", day: "2026-08-01" },
      50,
      "cursor",
    );
    expect(seen.cursor).toBe("cursor");
    expect(seen.keys).toEqual(
      expect.arrayContaining([
        { pk: away.partitionKey, sk: "CURRENT" },
        { pk: home.partitionKey, sk: "CURRENT" },
      ]),
    );
    expect(seen.keys).toHaveLength(24);
    expect(page).toMatchObject({
      nextCursor: "next",
      snapshotAt: "2026-08-01T12:00:00.000Z",
    });
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { selectionKey: "away", americanOdds: 120 },
        { selectionKey: "home", americanOdds: -135 },
      ],
    });
  });

  it("rebuilds soccer away/draw/home order", async () => {
    const soccer = {
      ...event,
      id: "event-mls",
      sportKey: "soccer",
      leagueKey: "mls",
      participants: [
        { id: "mia", label: "Miami" },
        { id: "atl", label: "Atlanta" },
      ],
    } as EventDisplayDto;
    const selections = [
      current(soccer, "away", "Miami"),
      current(soccer, "draw", "Draw"),
      current(soccer, "home", "Atlanta"),
    ];
    const page = await new JoinedGamesRepository(events([soccer]), {
      batchGet: () => Promise.resolve([...selections].reverse().map(row)),
    }).list({ sportKey: "soccer", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { selectionKey: "away" },
        { selectionKey: "draw" },
        { selectionKey: "home" },
      ],
    });
  });

  it("returns coherent spread and total markets beside moneyline", async () => {
    const selections = [
      current(event, "away", "Boston"),
      current(event, "home", "New York"),
      current(event, "away", "Boston", "spread", "draftkings", undefined, 1.5),
      current(
        event,
        "home",
        "New York",
        "spread",
        "draftkings",
        undefined,
        -1.5,
      ),
      current(event, "over", "Over", "total", "draftkings", undefined, 8.5),
      current(event, "under", "Under", "total", "draftkings", undefined, 8.5),
    ];
    const page = await new JoinedGamesRepository(events(), {
      batchGet: () => Promise.resolve(selections.map(row).reverse()),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { marketKey: "moneyline", selectionKey: "away" },
        { marketKey: "moneyline", selectionKey: "home" },
        { marketKey: "spread", selectionKey: "away", point: 1.5 },
        { marketKey: "spread", selectionKey: "home", point: -1.5 },
        { marketKey: "total", selectionKey: "over", point: 8.5 },
        { marketKey: "total", selectionKey: "under", point: 8.5 },
      ],
    });
  });

  it("uses unavailable only when the whole market is absent", async () => {
    const page = await new JoinedGamesRepository(events(), {
      batchGet: () => Promise.resolve([]),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
  });

  it("falls back to the next complete sportsbook market", async () => {
    const away = current(event, "away", "Boston", "moneyline", "fanduel");
    const home = current(event, "home", "New York", "moneyline", "fanduel");
    const page = await new JoinedGamesRepository(events(), {
      batchGet: () => Promise.resolve([row(home), row(away)]),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { selectionKey: "away", sportsbookId: "fanduel" },
        { selectionKey: "home", sportsbookId: "fanduel" },
      ],
    });
  });

  it("fails closed for partial, malformed, mismatched, duplicate, and unexpected rows", async () => {
    const away = current(event, "away", "Boston");
    const home = current(event, "home", "New York");
    const cases: readonly (readonly unknown[])[] = [
      [
        {
          pk: away.partitionKey,
          sk: "CURRENT",
          value: { ...away, canonicalEventVersion: 1 },
        },
        row(home),
      ],
      [row(away), row(away), row(home)],
      [row(away), row(home), { pk: "unexpected", sk: "CURRENT", value: away }],
      [{ pk: away.partitionKey, sk: "CURRENT", value: null }, row(home)],
    ];
    for (const rows of cases) {
      await expect(
        new JoinedGamesRepository(events(), {
          batchGet: () => Promise.resolve(rows),
        }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1),
      ).rejects.toBeInstanceOf(EventStorageError);
    }
  });

  it("hides partial and mixed-timestamp markets during ingestion", async () => {
    const away = current(event, "away", "Boston");
    for (const rows of [
      [row(away)],
      [
        row(away),
        row(
          current(
            event,
            "home",
            "New York",
            "moneyline",
            "draftkings",
            "2026-08-01T12:01:00.000Z",
          ),
        ),
      ],
    ]) {
      const page = await new JoinedGamesRepository(events(), {
        batchGet: () => Promise.resolve(rows),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
      expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
    }
  });

  it("requests exact keys for four preferred books on a maximum soccer page", async () => {
    const soccerEvents = Array.from({ length: 50 }, (_, index) => ({
      ...event,
      id: `event-${index}`,
      sportKey: "soccer",
      leagueKey: "mls",
    })) as EventDisplayDto[];
    let requested = 0;
    await new JoinedGamesRepository(events(soccerEvents), {
      batchGet: (keys) => {
        requested = keys.length;
        return Promise.resolve([]);
      },
    }).list({ sportKey: "soccer", status: "scheduled", day: "2026-08-01" }, 50);
    expect(requested).toBe(1_400);
  });
});
