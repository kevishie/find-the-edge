import { describe, expect, it } from "vitest";
import {
  assessEventMetadata,
  buildExactParticipantAliasMap,
  MLB_PARTICIPANT_CATALOGUE,
  canonicalDisplayParticipantKey,
  collapseNearDuplicateGames,
  resolveMlbMatchup,
  resolveMlbParticipantKey,
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
  it("resolves every declared approved alias to its declared club", () => {
    for (const [key, aliases] of MLB_PARTICIPANT_CATALOGUE)
      for (const alias of aliases)
        expect(resolveMlbParticipantKey(alias)).toBe(key);
  });

  it("resolves the exact 30-club MLB catalogue and approved aliases", () => {
    const officialNames = [
      "Arizona Diamondbacks",
      "Athletics",
      "Atlanta Braves",
      "Baltimore Orioles",
      "Boston Red Sox",
      "Chicago Cubs",
      "Chicago White Sox",
      "Cincinnati Reds",
      "Cleveland Guardians",
      "Colorado Rockies",
      "Detroit Tigers",
      "Houston Astros",
      "Kansas City Royals",
      "Los Angeles Angels",
      "Los Angeles Dodgers",
      "Miami Marlins",
      "Milwaukee Brewers",
      "Minnesota Twins",
      "New York Mets",
      "New York Yankees",
      "Philadelphia Phillies",
      "Pittsburgh Pirates",
      "San Diego Padres",
      "San Francisco Giants",
      "Seattle Mariners",
      "St. Louis Cardinals",
      "Tampa Bay Rays",
      "Texas Rangers",
      "Toronto Blue Jays",
      "Washington Nationals",
    ];
    const keys = officialNames.map(resolveMlbParticipantKey);
    expect(keys.every((key) => key !== null)).toBe(true);
    expect(new Set(keys).size).toBe(30);
    expect(resolveMlbParticipantKey("  ST LOUIS   CÁRDINALS ")).toBe(
      "cardinals",
    );
    expect(resolveMlbParticipantKey("A’s")).toBe("athletics");
    expect(resolveMlbParticipantKey("d—backs")).toBe("diamondbacks");
    expect(resolveMlbParticipantKey("C.W.S.")).toBe("whitesox");
    expect(resolveMlbParticipantKey("Bøstøn Red Søx")).toBe("redsox");
    expect(resolveMlbParticipantKey("Łos Angeles Dodgers")).toBe("dodgers");
    expect(resolveMlbParticipantKey("Pølish Giants")).toBeNull();
    expect(() =>
      buildExactParticipantAliasMap([
        ["first", ["Bøstøn"]],
        ["second", ["Boston"]],
      ]),
    ).toThrow("participant-alias-collision");
  });

  it("rejects unknown, suffix-collision, and same-club MLB matchups", () => {
    expect(resolveMlbParticipantKey("Yomiuri Giants")).toBeNull();
    expect(resolveMlbParticipantKey("Hanshin Tigers")).toBeNull();
    expect(resolveMlbParticipantKey("New York")).toBeNull();
    expect(resolveMlbMatchup("Giants", "San Francisco Giants")).toBeNull();
    expect(resolveMlbMatchup("Dodgers", "San Francisco Giants")).toEqual({
      awayKey: "dodgers",
      homeKey: "giants",
    });
    expect(canonicalDisplayParticipantKey("mlb", "Yomiuri Giants")).toBe(
      "yomiurigiants",
    );
  });

  it("suppresses previously stored contaminated MLB games from list reads", () => {
    const contaminated = game({
      id: "foreign",
      startsAt: "2026-08-04T20:00:00.000Z",
      away: "Yomiuri Giants",
      home: "Hanshin Tigers",
      odds: true,
      version: 50,
    });
    const legitimate = game({
      id: "mlb",
      startsAt: "2026-08-04T21:00:00.000Z",
    });
    expect(
      collapseNearDuplicateGames([contaminated, legitimate]).map(
        ({ id }) => id,
      ),
    ).toEqual(["mlb"]);
    expect(
      collapseNearDuplicateGames([
        { ...contaminated, sportKey: "soccer", leagueKey: "mlb" },
      ]),
    ).toEqual([]);
  });

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
