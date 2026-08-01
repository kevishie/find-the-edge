import { describe, expect, it } from "vitest";
import {
  normalizeFixtureOddsObservation,
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
};
const events = (seen: { cursor: string | undefined }): EventRepository => ({
  list: async (_filter, _limit, cursor) => {
    await Promise.resolve();
    seen.cursor = cursor;
    return {
      items: [event],
      nextCursor: "next",
      projectionState: "ready",
      evaluationState: "complete",
      hasMoreUnknown: false,
      snapshotAt: "2026-08-01T12:00:00.000Z",
      freshness: event.freshness,
    };
  },
  detail: async () => ({
    ...(await Promise.resolve({})),
    projectionState: "ready",
    item: null,
  }),
});
const current = normalizeFixtureOddsObservation({
  canonicalEventId: event.id,
  canonicalEventVersion: event.version,
  sportKey: event.sportKey,
  marketKey: "moneyline",
  selectionKey: "away",
  selectionLabel: "Boston",
  sportsbookId: "fixture-book",
  sportsbookLabel: "Fixture Book",
  americanOdds: 120,
  observedAt: "2026-08-01T12:00:00.000Z",
  retrievedAt: "2026-08-01T12:00:00.000Z",
});

describe("joined games repository", () => {
  it("preserves the event page/cursor and exact-reads one validated CURRENT per game", async () => {
    const seen: { cursor: string | undefined; keys?: readonly unknown[] } = {
      cursor: undefined,
    };
    const repository = new JoinedGamesRepository(events(seen), {
      batchGet: async (keys) => {
        await Promise.resolve();
        seen.keys = keys;
        return [{ pk: current.partitionKey, sk: "CURRENT", value: current }];
      },
    });
    const page = await repository.list(
      {
        sportKey: "mlb",
        leagueKey: "mlb",
        status: "scheduled",
        day: "2026-08-01",
      },
      50,
      "cursor",
    );
    expect(seen.cursor).toBe("cursor");
    expect(seen.keys).toEqual([{ pk: current.partitionKey, sk: "CURRENT" }]);
    expect(page.nextCursor).toBe("next");
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [{ americanOdds: 120, observedAt: current.observedAt }],
    });
  });

  it("uses explicit unavailable for a missing current row", async () => {
    const page = await new JoinedGamesRepository(
      events({ cursor: undefined }),
      {
        batchGet: async () => await Promise.resolve([]),
      },
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
  });

  it("rejects malformed or event/version-mismatched current rows", async () => {
    const bad = { ...current, canonicalEventVersion: 1 };
    await expect(
      new JoinedGamesRepository(events({ cursor: undefined }), {
        batchGet: async () =>
          await Promise.resolve([
            { pk: current.partitionKey, sk: "CURRENT", value: bad },
          ]),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1),
    ).rejects.toBeInstanceOf(EventStorageError);
    await expect(
      new JoinedGamesRepository(events({ cursor: undefined }), {
        batchGet: async () =>
          await Promise.resolve([
            { pk: "unexpected", sk: "CURRENT", value: current },
          ]),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1),
    ).rejects.toBeInstanceOf(EventStorageError);
  });
});
