import { describe, expect, it } from "vitest";
import {
  assessEventMetadata,
  type GameDisplayDto,
} from "@find-the-edge/domain";
import {
  eventCompetitionOptions,
  filterAndSortEvents,
  normalizeEventSearch,
} from "./event-explorer";

const game = (
  id: string,
  label: string,
  competition: string,
  startsAt: string,
): GameDisplayDto => ({
  id,
  version: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  competition: { key: competition, state: "provisional" },
  participants: [
    { id: `${id}:1`, label },
    { id: `${id}:2`, label: "New York" },
  ],
  startsAt,
  eastern: {
    timeZone: "America/New_York",
    calendarDay: "2026-08-04",
    display: startsAt,
  },
  status: "scheduled",
  freshness: "2026-08-04T12:00:00.000Z",
  metadata: assessEventMetadata(
    "scheduled",
    "2026-08-04T12:00:00.000Z",
    "2026-08-04T12:00:00.000Z",
  ),
  odds: { state: "unavailable" },
});

describe("event explorer policy", () => {
  it("normalizes compatibility, accents, case, and whitespace", () => {
    expect(normalizeEventSearch("  ＢÓSTON  ")).toBe("boston");
  });
  it("combines competition and participant search and sorts deterministically", () => {
    const items = [
      game("b", "Bóston", "AL", "2026-08-04T20:00:00.000Z"),
      game("a", "Boston", "AL", "2026-08-04T19:00:00.000Z"),
      game("c", "Boston", "NL", "2026-08-04T18:00:00.000Z"),
    ];
    expect(
      filterAndSortEvents(items, {
        competition: "AL",
        query: "ＢＯＳＴＯＮ",
        sort: "kickoff",
        direction: "desc",
      }).map(({ id }) => id),
    ).toEqual(["b", "a"]);
  });
  it("returns sorted unique safe competition options", () => {
    expect(
      eventCompetitionOptions([
        game("b", "B", "NL", "2026-08-04T20:00:00.000Z"),
        game("a", "A", "AL", "2026-08-04T19:00:00.000Z"),
      ]),
    ).toEqual([
      { value: "AL", label: "AL" },
      { value: "NL", label: "NL" },
    ]);
  });
});
