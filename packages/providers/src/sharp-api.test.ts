import { describe, expect, it } from "vitest";
import type { SportKey } from "@find-the-edge/domain";
import {
  isSharpDerivativeMatchup,
  parseSharpApiOddsPage,
  parseSharpApiSchedulePage,
  parseSharpApiSplitPage,
  sharpApiLeagues,
  sharpApiDescriptor,
  validateSharpApiActivation,
  type SharpApiActivationConfig,
} from "./sharp-api";

const disabled: SharpApiActivationConfig = {
  enabled: false,
  contractVerified: false,
  licensingVerified: false,
  splitFreshnessSeconds: 900,
  quotaReserve: 100,
  cooldownSeconds: 1800,
  recoverySuccesses: 3,
  coverage: [
    {
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      capability: "odds",
      enabled: false,
      marketKeys: [],
      reason: "contract-unverified",
    },
    {
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      capability: "public-betting",
      enabled: false,
      marketKeys: [],
      reason: "not-entitled",
    },
  ],
};

describe("SharpAPI activation boundary", () => {
  const oddsRow = (overrides: Record<string, unknown> = {}) => ({
    id: "price-normalization-1",
    event_id: "mls-away-home-2026-08-04",
    event_uuid: "event-normalization-1",
    away_team: "Away Club",
    home_team: "Home Club",
    event_start_time: "2026-08-04T22:00:00.000Z",
    sportsbook: "Hard Rock Bet",
    market_type: "moneyline_3-way",
    market_id: "market-normalization-1",
    selection_type: "draw",
    selection: "Draw",
    selection_id: "selection-normalization-1",
    odds_american: 240,
    odds_decimal: 3.4,
    odds_probability: 0.294,
    public_bet_pct: null,
    timestamp: "2026-08-04T20:00:00.000Z",
    is_live: false,
    is_main_line: true,
    is_alternate_line: false,
    is_player_prop: false,
    is_stale_pregame_price: false,
    ...overrides,
  });

  it("canonicalizes approved bookmaker aliases and reason-codes unsupported rows", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow(),
          oddsRow({ id: "unknown-book", sportsbook: "Mystery Book" }),
          oddsRow({ id: "unknown-market", market_type: "first_corner" }),
          oddsRow({
            id: "unknown-selection",
            selection_type: "maybe",
            selection: "Maybe",
          }),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[1]!,
      "2026-08-04T20:00:01.000Z" as never,
    );
    expect(page.events[0]?.bookmakers[0]?.id).toBe("hardrock");
    expect((page.rejections ?? []).map(({ reason }) => reason)).toEqual([
      "unknown-bookmaker",
      "unsupported-market",
      "unsupported-selection",
    ]);
  });

  it("normalizes only explicit BTTS and participant-bound team totals", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow({
            id: "btts",
            market_type: "both_teams_to_score",
            selection_type: "yes",
            selection: "Yes",
          }),
          oddsRow({
            id: "team-total",
            market_type: "team_total_goals",
            selection_type: "over",
            selection: "Over",
            line: 1.5,
            participant_side: "away",
          }),
          oddsRow({
            id: "ambiguous-team-total",
            market_type: "team_total_goals",
            selection_type: "under",
            selection: "Under",
            line: 1.5,
          }),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[1]!,
      "2026-08-04T20:00:01.000Z" as never,
    );
    const prices = page.events[0]?.bookmakers[0]?.prices ?? [];
    expect(
      prices.map(({ marketKey, selectionKey, participantSide }) => [
        marketKey,
        selectionKey,
        participantSide,
      ]),
    ).toEqual([
      ["btts", "yes", undefined],
      ["team_total", "over", "away"],
    ]);
    expect(page.rejections).toContainEqual(
      expect.objectContaining({ reason: "participant-unavailable" }),
    );
  });
  it("strictly normalizes the verified event-reference schedule", () => {
    const retrievedAt = "2026-08-03T12:00:00.000Z" as never;
    expect(
      parseSharpApiSchedulePage(
        {
          data: [
            {
              id: "mlb-event-1",
              league: "mlb",
              away_team: "Away",
              home_team: "Home",
              start_time: "2026-08-03T19:00:00Z",
              status: "upcoming",
              is_live: false,
            },
          ],
          pagination: { has_more: false, next_offset: null },
        },
        sharpApiLeagues[0]!,
        retrievedAt,
      ).events,
    ).toEqual([
      {
        providerEventId: "mlb-event-1",
        awayTeam: "Away",
        homeTeam: "Home",
        startsAt: "2026-08-03T19:00:00.000Z",
        status: "scheduled",
      },
    ]);
    expect(() =>
      parseSharpApiSchedulePage(
        {
          data: [
            {
              id: "mlb-event-1",
              league: "mlb",
              away_team: "Away",
              home_team: "Home",
              start_time: "2026-08-03T19:00:00Z",
              status: "live",
              is_live: true,
            },
          ],
          pagination: { has_more: false },
        },
        sharpApiLeagues[0]!,
        retrievedAt,
      ),
    ).toThrow("invalid-response");
  });
  it("ignores futures without discarding valid scheduled matches", () => {
    const page = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "future-1",
            league: "mlb",
            away_team: "",
            home_team: "World Series Winner",
            start_time: "2026-10-01T00:00:00Z",
            status: "upcoming",
            is_live: false,
          },
          {
            id: "future-2",
            league: "mlb",
            away_team: null,
            home_team: "American League Winner",
            start_time: "2026-10-01T00:00:00Z",
            status: "upcoming",
            is_live: false,
          },
          {
            id: "future-3",
            league: "mlb",
            home_team: "National League Winner",
            start_time: "2026-10-01T00:00:00Z",
            status: "upcoming",
            is_live: false,
          },
          {
            id: "game-1",
            league: "mlb",
            away_team: "Away",
            home_team: "Home",
            start_time: "2026-08-04T20:00:00Z",
            status: "upcoming",
            is_live: false,
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-04T12:00:00.000Z" as never,
    );
    expect(page.events.map(({ providerEventId }) => providerEventId)).toEqual([
      "game-1",
    ]);
    expect(() =>
      parseSharpApiSchedulePage(
        {
          data: [
            {
              id: "malformed-game",
              league: "mlb",
              away_team: "Away",
              home_team: "Home",
              start_time: "not-an-instant",
              status: "upcoming",
              is_live: false,
            },
          ],
          pagination: { has_more: false, next_offset: null },
        },
        sharpApiLeagues[0]!,
        "2026-08-04T12:00:00.000Z" as never,
      ),
    ).toThrow("invalid-response");
  });
  it("ignores related provider sub-leagues returned by an exact filter", () => {
    const page = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "american-league-future",
            league: "mlb_american_league",
            status: "completed",
            is_live: true,
          },
          {
            id: "game-1",
            league: "mlb",
            away_team: "Away",
            home_team: "Home",
            start_time: "2026-08-04T20:00:00Z",
            status: "upcoming",
            is_live: false,
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-04T12:00:00.000Z" as never,
    );
    expect(page.events.map(({ providerEventId }) => providerEventId)).toEqual([
      "game-1",
    ]);
  });
  it("excludes recognizable derivative catalogue rows", () => {
    const page = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "team-total",
            league: "mlb",
            away_team: "Away Total Runs",
            home_team: "Home Total Runs",
            start_time: "2026-08-04T20:00:00Z",
            status: "upcoming",
            is_live: false,
          },
          {
            id: "innings",
            league: "mlb",
            away_team: "Away: First 5 Innings",
            home_team: "Home: First 5 Innings",
            start_time: "2026-08-04T20:00:00Z",
            status: "upcoming",
            is_live: false,
          },
          {
            id: "game",
            league: "mlb",
            away_team: "Away",
            home_team: "Home",
            start_time: "2026-08-04T20:00:00Z",
            status: "upcoming",
            is_live: false,
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-04T12:00:00.000Z" as never,
    );
    expect(page.events.map((event) => event.providerEventId)).toEqual(["game"]);
    expect(
      isSharpDerivativeMatchup("Away - Player Props", "Home - Player Props"),
    ).toBe(true);
    expect(isSharpDerivativeMatchup("Away Total Runs", "Home Club")).toBe(
      false,
    );
    expect(isSharpDerivativeMatchup("Total Runs Baseball Club", "Home")).toBe(
      false,
    );
    expect(isSharpDerivativeMatchup("Innings United", "Cy Young Academy")).toBe(
      false,
    );
  });
  it("validates malformed derivative-shaped rows before excluding them", () => {
    expect(() =>
      parseSharpApiSchedulePage(
        {
          data: [
            {
              id: "malformed-team-total",
              league: "mlb",
              away_team: "Away Total Runs",
              home_team: "Home Total Runs",
              start_time: "not-an-instant",
              status: "upcoming",
              is_live: false,
            },
          ],
          pagination: { has_more: false, next_offset: null },
        },
        sharpApiLeagues[0]!,
        "2026-08-04T12:00:00.000Z" as never,
      ),
    ).toThrow("invalid-response");
  });
  it("keeps unverified coverage explicitly disabled", () => {
    expect(validateSharpApiActivation(disabled).coverage[1]?.reason).toBe(
      "not-entitled",
    );
    expect(sharpApiDescriptor(disabled)).toBeNull();
  });

  it("blocks activation without verified contract and licensing", () => {
    expect(() =>
      validateSharpApiActivation({ ...disabled, enabled: true }),
    ).toThrow("sharpapi-activation-unverified");
  });

  it("registers independently verified capabilities", () => {
    const descriptor = sharpApiDescriptor({
      ...disabled,
      enabled: true,
      contractVerified: true,
      licensingVerified: true,
      coverage: [
        {
          sportKey: "mlb" as SportKey,
          leagueKey: "mlb",
          capability: "odds",
          enabled: true,
          marketKeys: ["moneyline", "spread", "total"],
        },
        {
          sportKey: "mlb" as SportKey,
          leagueKey: "mlb",
          capability: "public-betting",
          enabled: false,
          marketKeys: [],
          reason: "not-entitled",
        },
      ],
    });
    expect(descriptor?.capabilities).toEqual(["odds"]);
  });

  it("accepts SharpAPI's nullable public betting percentage on odds rows", () => {
    const price = {
      id: "price-1",
      event_id: "mlb-away-home-2026-08-03",
      event_uuid: "event-uuid-1",
      away_team: "Away Club",
      home_team: "Home Club",
      event_start_time: "2026-08-03T22:40:00.000Z",
      sportsbook: "draftkings",
      market_type: "total_runs",
      market_id: "market-1",
      selection: "Under",
      selection_id: "selection-1",
      line: 8.5,
      odds_american: -110,
      odds_decimal: 1.91,
      odds_probability: 0.524,
      public_bet_pct: null,
      timestamp: "2026-08-03T21:42:00.000Z",
      is_live: false,
      is_main_line: true,
      is_alternate_line: false,
      is_player_prop: false,
      is_stale_pregame_price: false,
    };
    const page = parseSharpApiOddsPage(
      {
        data: [price, { ...price }],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-03T21:42:01.000Z" as never,
    );
    expect(page.events[0]?.bookmakers[0]?.prices[0]).not.toHaveProperty(
      "publicBetPercent",
    );
    expect(page.events[0]?.bookmakers[0]?.prices).toHaveLength(1);
    const repriced = parseSharpApiOddsPage(
      {
        data: [price, { ...price, odds_american: -115 }],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-03T21:42:01.000Z" as never,
    );
    expect(repriced.events[0]?.bookmakers[0]?.prices).toHaveLength(1);
    expect(repriced.events[0]?.bookmakers[0]?.prices[0]?.americanOdds).toBe(
      -115,
    );
    expect(() =>
      parseSharpApiOddsPage(
        {
          data: [price, { ...price, selection_id: "different-selection" }],
          pagination: { has_more: false, next_cursor: null },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
      ),
    ).toThrow("invalid-response");
  });

  it("keeps valid sibling prices when a provider timestamp is unavailable", () => {
    const base = {
      id: "price-valid",
      event_id: "mlb-away-home-2026-08-03",
      event_uuid: "event-uuid-1",
      away_team: "Away Club",
      home_team: "Home Club",
      event_start_time: "2026-08-03T22:40:00.000Z",
      sportsbook: "draftkings",
      market_type: "moneyline",
      market_id: "market-1",
      selection: "Away Club",
      selection_type: "away",
      selection_id: "selection-away",
      odds_american: 120,
      odds_decimal: 2.2,
      odds_probability: 0.4545,
      timestamp: "2026-08-03T21:42:00.000Z",
      is_live: false,
      is_main_line: true,
      is_alternate_line: false,
      is_player_prop: false,
      is_stale_pregame_price: false,
    };
    const page = parseSharpApiOddsPage(
      {
        data: [
          base,
          { ...base, id: "price-missing", timestamp: undefined },
          { ...base, id: "price-malformed", timestamp: "not-an-instant" },
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-03T21:42:01.000Z" as never,
    );
    expect(page.events[0]?.bookmakers[0]?.prices).toHaveLength(1);
    expect(page.rejections).toHaveLength(2);
    expect(page.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "missing-provider-timestamp",
          providerEventId: base.event_id,
          sportsbookId: "draftkings",
        }),
      ]),
    );
    const invalidated = parseSharpApiOddsPage(
      {
        data: [base, { ...base, timestamp: undefined }],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-03T21:42:01.000Z" as never,
    );
    expect(invalidated.events).toHaveLength(0);
    for (const timestamp of [
      "2026-08-03",
      "2026-08-03T21:42:00",
      "2026-02-30T21:42:00Z",
    ]) {
      const strict = parseSharpApiOddsPage(
        {
          data: [{ ...base, id: `invalid-${timestamp}`, timestamp }],
          pagination: { has_more: false, next_cursor: null },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
      );
      expect(strict.events).toHaveLength(0);
      expect(strict.rejections?.[0]?.reason).toBe("missing-provider-timestamp");
    }
  });

  it("normalizes the documented split contract without inferring values", () => {
    const page = parseSharpApiSplitPage(
      {
        data: [
          {
            event_id: "mlb-away-home-2026-08-03",
            sport: "baseball",
            league: "mlb",
            sportsbook: "draftkings",
            away_team: "Away Club",
            home_team: "Home Club",
            spread: {
              away_odds: -1.5,
              home_odds: 1.5,
              handle_pct: { away: 0.62, home: 0.38 },
              bets_pct: { away: 0.44, home: 0.56 },
            },
            total: null,
            moneyline: {
              away_odds: 120,
              home_odds: -140,
              handle_pct: { away: 0.51, home: 0.49 },
              bets_pct: { away: 0.4, home: 0.6 },
            },
            fetched_at: "2026-08-03T15:00:00.000Z",
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      "2026-08-03T15:00:01.000Z" as never,
    );
    expect(page.items[0]?.markets[0]?.selections[0]).toMatchObject({
      selectionKey: "away",
      point: -1.5,
      betPercent: 44,
      moneyPercent: 62,
    });
    expect(page.items[0]?.markets).toHaveLength(2);
  });

  it("preserves every sportsbook scope returned for the same event", () => {
    const event = (sportsbook: string, away: number) => ({
      event_id: "mlb-away-home-2026-08-03",
      sport: "baseball",
      league: "mlb",
      sportsbook,
      away_team: "Away Club",
      home_team: "Home Club",
      spread: null,
      total: null,
      moneyline: {
        away_odds: 120,
        home_odds: -140,
        handle_pct: { away, home: 1 - away },
        bets_pct: { away: 0.4, home: 0.6 },
      },
      fetched_at: "2026-08-03T15:00:00.000Z",
    });
    const page = parseSharpApiSplitPage(
      {
        data: [event("draftkings", 0.55), event("betmgm", 0.63)],
        pagination: { has_more: false, next_offset: null },
      },
      "2026-08-03T15:00:01.000Z" as never,
    );
    expect(page.items.map(({ sportsbookId }) => sportsbookId)).toEqual([
      "draftkings",
      "betmgm",
    ]);
    expect(page.items[0]?.markets[0]?.selections[0]?.moneyPercent).toBe(55);
    expect(page.items[1]?.markets[0]?.selections[0]?.moneyPercent).toBe(63);
  });

  it("accepts SharpAPI's null data shape for an explicitly empty split page", () => {
    expect(
      parseSharpApiSplitPage(
        {
          data: null,
          pagination: {
            limit: 200,
            offset: 0,
            count: 0,
            total: 0,
            has_more: false,
            next_offset: null,
          },
        },
        "2026-08-03T15:00:01.000Z" as never,
      ),
    ).toMatchObject({ items: [], hasMore: false });
  });

  it("preserves available split percentages when the provider returns nulls", () => {
    const page = parseSharpApiSplitPage(
      {
        data: [
          {
            event_id: "mlb-away-home-2026-08-03",
            sport: "baseball",
            league: "mlb",
            sportsbook: "draftkings",
            away_team: "Away Club",
            home_team: "Home Club",
            spread: {
              away_odds: -1.5,
              home_odds: null,
              handle_pct: { away: 0.62, home: null },
              bets_pct: { away: null, home: 0.56 },
            },
            total: null,
            moneyline: null,
            fetched_at: "2026-08-03T15:00:00.000Z",
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      "2026-08-03T15:00:01.000Z" as never,
    );
    expect(page.items[0]?.markets[0]?.selections).toEqual([
      { selectionKey: "away", point: -1.5, moneyPercent: 62 },
      { selectionKey: "home", betPercent: 56 },
    ]);
  });

  it("rejects null split data unless pagination proves the page is empty", () => {
    expect(() =>
      parseSharpApiSplitPage(
        {
          data: null,
          pagination: {
            count: 1,
            total: 1,
            has_more: false,
            next_offset: null,
          },
        },
        "2026-08-03T15:00:01.000Z" as never,
      ),
    ).toThrow("invalid-response");
  });
});
