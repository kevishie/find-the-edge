import { describe, expect, it } from "vitest";
import {
  assessEventMetadata,
  collapseNearDuplicateGames,
  type EventStatus,
  type GameDisplayDto,
} from "./index";

const game = (input: {
  id: string;
  startsAt: string;
  version?: number;
  status?: EventStatus;
  away?: string;
  home?: string;
  evidenceAt?: string | null;
  odds?: boolean;
  sportKey?: string;
}): GameDisplayDto => {
  const status = input.status ?? "scheduled";
  const evidenceAt = input.evidenceAt ?? "2026-08-04T12:00:00.000Z";
  return {
    id: input.id,
    version: input.version ?? 1,
    sportKey: input.sportKey ?? "mlb",
    leagueKey: input.sportKey === "soccer" ? "mls" : "mlb",
    competition: {
      key: input.sportKey === "soccer" ? "mls" : "mlb",
      state: "provisional",
    },
    participants: [
      { id: `${input.id}-away`, label: input.away ?? "Chicago White Sox" },
      { id: `${input.id}-home`, label: input.home ?? "Boston Red Sox" },
    ],
    startsAt: input.startsAt,
    eastern: {
      timeZone: "America/New_York",
      calendarDay: "2026-08-04",
      display: "Aug 4, 2026",
    },
    status,
    freshness: evidenceAt,
    metadata: assessEventMetadata(
      status,
      evidenceAt,
      "2026-08-04T12:30:00.000Z",
    ),
    odds: input.odds
      ? {
          state: "available",
          selections: [
            {
              marketKey: "moneyline",
              selectionKey: "away",
              sportsbookId: "draftkings",
              americanOdds: 110,
              observedAt: "2026-08-04T12:00:00.000Z",
              retrievedAt: "2026-08-04T12:00:00.000Z",
            },
          ],
        }
      : { state: "unavailable" },
  };
};

describe("event display duplicate invariant", () => {
  it("prefers the authoritative version across status and stale-odds differences", () => {
    const sharp = game({
      id: "sharp",
      startsAt: "2026-08-04T23:10:00.000Z",
      version: 23,
      status: "started",
      evidenceAt: null,
    });
    const legacy = game({
      id: "legacy",
      startsAt: "2026-08-04T23:11:00.000Z",
      version: 1,
      status: "scheduled",
      evidenceAt: "2026-08-04T12:20:00.000Z",
      odds: true,
      away: "Chicago WS",
    });
    expect(
      collapseNearDuplicateGames([legacy, sharp]).map(({ id }) => id),
    ).toEqual(["sharp"]);
    expect(
      collapseNearDuplicateGames([sharp, legacy]).map(({ id }) => id),
    ).toEqual(["sharp"]);
  });

  it("anchors deterministic clusters without transitively merging doubleheaders", () => {
    const a = game({ id: "a", startsAt: "2026-08-04T20:00:00.000Z" });
    const b = game({ id: "b", startsAt: "2026-08-04T20:01:50.000Z" });
    const c = game({ id: "c", startsAt: "2026-08-04T20:03:40.000Z" });
    expect(collapseNearDuplicateGames([c, b, a]).map(({ id }) => id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("normalizes common MLB and soccer provider aliases", () => {
    const athletics = game({
      id: "athletics",
      startsAt: "2026-08-04T20:00:00.000Z",
      away: "Athletics",
      home: "Arizona Diamondbacks",
      version: 2,
    });
    const aliases = game({
      id: "aliases",
      startsAt: "2026-08-04T20:01:00.000Z",
      away: "A's",
      home: "D-backs",
    });
    const soccer = game({
      id: "soccer",
      startsAt: "2026-08-04T22:00:00.000Z",
      away: "Inter Miami CF",
      home: "Atlanta United FC",
      sportKey: "soccer",
      version: 2,
    });
    const soccerAliases = game({
      id: "soccer-alias",
      startsAt: "2026-08-04T22:00:30.000Z",
      away: "Inter Miami",
      home: "Atlanta United",
      sportKey: "soccer",
    });
    expect(
      collapseNearDuplicateGames([
        aliases,
        athletics,
        soccerAliases,
        soccer,
      ]).map(({ id }) => id),
    ).toEqual(["athletics", "soccer"]);
  });
});
