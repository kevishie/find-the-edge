import { describe, expect, it, vi } from "vitest";
import type { SportKey } from "@find-the-edge/domain";
import {
  isSharpDerivativeMatchup,
  parseSharpApiOddsPage,
  parseSharpApiAccount,
  parseSharpApiSchedulePage,
  parseSharpApiSplitPage,
  parseSharpApiSplitHistoryPage,
  latestSharpApiSplitHistoryByBook,
  parseSharpApiResponseMetadata,
  fetchSharpApiEventOdds,
  fetchSharpApiAccount,
  fetchSharpApiFeaturedOdds,
  fetchSharpApiOddsPage,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  fetchSharpApiSplitHistory,
  sharpApiLeagueByKey,
  sharpApiLeagues,
  sharpApiDescriptor,
  SharpApiError,
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
    league: "mls",
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
    is_active: true,
    ...overrides,
  });

  it("captures authoritative rate-window metadata without inventing plan quota", () => {
    expect(
      parseSharpApiResponseMetadata(
        new Headers({
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "17",
          "x-ratelimit-reset": "30",
          "retry-after": "12",
        }),
        new Date("2026-08-04T12:00:00.000Z"),
      ),
    ).toEqual({
      rateWindow: {
        limit: 60,
        remaining: 17,
        resetsAt: "2026-08-04T12:00:30.000Z",
      },
      retryAt: "2026-08-04T12:00:12.000Z",
    });
    expect(parseSharpApiResponseMetadata(new Headers())).toEqual({
      rateWindow: {},
    });
    expect(
      parseSharpApiResponseMetadata(
        new Headers({ "x-ratelimit-reset": "1785862830000" }),
      ).rateWindow.resetsAt,
    ).toBe("2026-08-04T17:00:30.000Z");
  });

  it("resolves only exact catalog-backed runtime leagues", () => {
    expect(sharpApiLeagues.map(({ leagueKey }) => leagueKey)).toEqual([
      "mlb",
      "mls",
      "epl",
      "liga-mx",
      "uefa-champions-league",
    ]);
    expect(sharpApiLeagueByKey("epl").providerLeague).toBe(
      "england_-_premier_league",
    );
    expect(() => sharpApiLeagueByKey("premier-league")).toThrow(
      "configuration",
    );
  });

  it("builds featured and focused prematch operations without leaking the key", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn((input: string | URL | Request) => {
      calls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [oddsRow()],
            pagination: { has_more: false, next_cursor: null },
          }),
          {
            status: 200,
            headers: {
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "41",
            },
          },
        ),
      );
    });
    const league = sharpApiLeagueByKey("mls");
    const featured = await fetchSharpApiFeaturedOdds(
      league,
      "secret-key",
      undefined,
      fetcher,
    );
    expect(calls[0]).toContain(
      "league=MLS&market=main&is_live=false&limit=200",
    );
    expect(calls[0]).not.toContain("secret-key");
    expect(featured.request.endpointMode).toBe("featured");
    expect(featured.page.responseMetadata?.rateWindow).toEqual({
      limit: 60,
      remaining: 41,
    });

    const focused = await fetchSharpApiEventOdds(
      league,
      "mls-away-home-2026-08-04",
      "secret-key",
      fetcher,
    );
    expect(calls[1]).toContain("/events/mls-away-home-2026-08-04/odds");
    expect(focused.request).toEqual(
      expect.objectContaining({
        endpointMode: "focused",
        providerEventId: "mls-away-home-2026-08-04",
        marketSet: ["main"],
      }),
    );
  });

  it("preserves suspension and rejects a mismatched focused event", async () => {
    const league = sharpApiLeagueByKey("mls");
    const suspended = parseSharpApiOddsPage(
      {
        data: [oddsRow({ is_active: false })],
        pagination: { has_more: false, next_cursor: null },
      },
      league,
      "2026-08-04T20:00:01.000Z" as never,
    );
    expect(suspended.events[0]?.bookmakers[0]?.prices[0]).toEqual(
      expect.objectContaining({ isActive: false, isSuspended: true }),
    );
    await expect(
      fetchSharpApiEventOdds(league, "expected-event", "secret-key", () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: [oddsRow({ event_id: "wrong-event" })] }),
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toThrow("invalid-response");
  });

  it("parses Retry-After without immediately retrying a paid request", async () => {
    const calls = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "limited" }), {
          status: 429,
          headers: { "retry-after": "60" },
        }),
      ),
    );
    const error = await fetchSharpApiFeaturedOdds(
      sharpApiLeagueByKey("mls"),
      "secret-key",
      undefined,
      calls,
    ).catch((value: unknown) => value);
    expect(error).toEqual(
      expect.objectContaining({ code: "rate-limited", retryable: true }),
    );
    if (!(error instanceof SharpApiError)) throw new Error("expected-error");
    expect(error.retryAt).toMatch(/^\d{4}-/);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("keeps valid siblings while failing closed on inactive ambiguity", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow(),
          oddsRow({ id: "missing-active", is_active: undefined }),
          oddsRow({ id: "bad-price", odds_american: 20 }),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagueByKey("mls"),
      "2026-08-04T20:00:01.000Z" as never,
    );
    expect(page.events[0]?.bookmakers[0]?.prices).toHaveLength(1);
    expect(page.rejections?.map(({ reason }) => reason)).toEqual([
      "incomplete-market",
      "incomplete-market",
    ]);
  });

  /**
   * SharpAPI publishes soccer's three-way moneyline as `moneyline` with a
   * separate draw selection, not as `moneyline_3-way`. Believing `market_type`
   * per price labelled every one of them two-way, so a three-selection
   * moneyline failed the completeness check and was rejected whole — no soccer
   * fixture in any competition had ever carried a price, while the odds sat in
   * the table. It would have mis-valued the no-vig consensus too.
   */
  it("reads a moneyline carrying a draw as three-way, whatever market_type says", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow({
            id: "ml-home",
            market_type: "moneyline",
            selection_type: "home",
            selection: "Home Club",
          }),
          oddsRow({
            id: "ml-away",
            market_type: "moneyline",
            selection_type: "away",
            selection: "Away Club",
          }),
          oddsRow({
            id: "ml-draw",
            market_type: "moneyline",
            selection_type: "draw",
            selection: "Draw",
          }),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagueByKey("mls"),
      "2026-08-04T20:00:01.000Z" as never,
    );
    const prices = page.events[0]?.bookmakers[0]?.prices ?? [];
    expect(prices).toHaveLength(3);
    // Every price in the market, not just the draw: the structure belongs to
    // the market, and a mixed group would not survive completeness grouping.
    expect(prices.map((price) => price.outcomeStructure)).toEqual([
      "three-way",
      "three-way",
      "three-way",
    ]);
    expect(page.rejections ?? []).toHaveLength(0);
  });

  it("leaves a genuine two-way moneyline alone", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow({
            id: "ml-home",
            event_id: "mlb-away-home-2026-08-04",
            market_type: "moneyline",
            selection_type: "home",
            selection: "Home Club",
          }),
          oddsRow({
            id: "ml-away",
            event_id: "mlb-away-home-2026-08-04",
            market_type: "moneyline",
            selection_type: "away",
            selection: "Away Club",
          }),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagueByKey("mls"),
      "2026-08-04T20:00:01.000Z" as never,
    );
    expect(
      (page.events[0]?.bookmakers[0]?.prices ?? []).map(
        (price) => price.outcomeStructure,
      ),
    ).toEqual(["two-way", "two-way"]);
  });

  it("accepts an unambiguous soccer Draw label outside MLS", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [oddsRow({ league: "england_-_premier_league" })],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagueByKey("epl"),
      "2026-08-04T20:00:01.000Z" as never,
    );
    expect(page.events[0]?.bookmakers[0]?.prices[0]?.selectionKey).toBe("draw");
  });

  it("accepts an empty focused payload as no coverage", async () => {
    await expect(
      fetchSharpApiEventOdds(
        sharpApiLeagueByKey("mls"),
        "mls-away-home-2026-08-04",
        "secret-key",
        () => Promise.resolve(Response.json({ data: [] })),
      ),
    ).resolves.toMatchObject({ page: { events: [], hasMore: false } });

    await expect(
      fetchSharpApiEventOdds(
        sharpApiLeagueByKey("mls"),
        "mls-away-home-2026-08-04",
        "secret-key",
        () =>
          Promise.resolve(
            Response.json({
              data: null,
              pagination: {
                has_more: false,
                next_cursor: null,
                count: 0,
                total: 0,
              },
            }),
          ),
      ),
    ).resolves.toMatchObject({ page: { events: [], hasMore: false } });
  });

  it.each([
    { data: [oddsRow({ event_id: "wrong-event" })] },
    { data: [oddsRow({ league: "mlb" })] },
    { data: [], pagination: { has_more: true } },
    {
      data: [],
      pagination: {
        has_more: false,
        next_cursor: "stale",
        count: 0,
        total: 0,
      },
    },
    {
      data: [],
      pagination: {
        has_more: false,
        next_cursor: null,
        count: 1,
        total: 1,
      },
    },
    {
      data: [],
      pagination: {
        has_more: false,
        next_cursor: null,
        count: 0,
        total: 1,
      },
    },
  ])("rejects focused payload identity failures", async (payload) => {
    await expect(
      fetchSharpApiEventOdds(
        sharpApiLeagueByKey("mls"),
        "mls-away-home-2026-08-04",
        "secret-key",
        () => Promise.resolve(new Response(JSON.stringify(payload))),
      ),
    ).rejects.toThrow("invalid-response");
  });

  it("canonicalizes approved bookmaker aliases and reason-codes unsupported rows", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow(),
          oddsRow({ id: "pinnacle-price", sportsbook: "Pinnacle Sports" }),
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
    expect(page.events[0]?.bookmakers.map(({ id }) => id)).toEqual([
      "hardrock",
      "pinnacle",
    ]);
    expect(
      page.events[0]?.bookmakers.find(({ id }) => id === "pinnacle")
        ?.providerSportsbookIds,
    ).toEqual(["Pinnacle Sports"]);
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
              away_team: "Boston Red Sox",
              home_team: "New York Yankees",
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
        awayTeam: "Boston Red Sox",
        homeTeam: "New York Yankees",
        awayClubKey: "redsox",
        homeClubKey: "yankees",
        startsAt: "2026-08-03T19:00:00.000Z",
        status: "scheduled",
      },
    ]);
    // This used to assert a throw. FTE-090: a started row is a lifecycle we
    // do not want, not a corrupt response, and throwing cost the whole page.
    const started = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "mlb-event-1",
            league: "mlb",
            away_team: "Boston Red Sox",
            home_team: "New York Yankees",
            start_time: "2026-08-03T19:00:00Z",
            status: "live",
            is_live: true,
          },
        ],
        pagination: { has_more: false },
      },
      sharpApiLeagues[0]!,
      retrievedAt,
    );
    expect(started.events).toEqual([]);
    expect(started.exclusions).toEqual([
      expect.objectContaining({
        providerEventId: "mlb-event-1",
        reason: "not-upcoming",
      }),
    ]);
  });
  it("filters MLB catalogue contamination while retaining valid siblings", () => {
    const row = (
      id: string,
      awayTeam: string,
      homeTeam: string,
      league = "mlb",
    ) => ({
      id,
      league,
      away_team: awayTeam,
      home_team: homeTeam,
      start_time: "2026-08-04T20:00:00Z",
      status: "upcoming",
      is_live: false,
    });
    const mlb = parseSharpApiSchedulePage(
      {
        data: [
          row("valid", "Dodgers", "San Francisco Giants"),
          row("foreign", "Yomiuri Giants", "Hanshin Tigers"),
          row("half-known", "Detroit Tigers", "Hanshin Tigers"),
          row("same-club", "Giants", "San Francisco Giants"),
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagueByKey("mlb"),
      "2026-08-04T12:00:00.000Z" as never,
    );
    expect(mlb.events).toEqual([
      expect.objectContaining({
        providerEventId: "valid",
        awayTeam: "Los Angeles Dodgers",
        homeTeam: "San Francisco Giants",
      }),
    ]);
    expect(mlb.exclusions).toHaveLength(3);
    expect(
      mlb.exclusions?.map(({ providerEventId }) => providerEventId),
    ).toEqual(["foreign", "half-known", "same-club"]);

    const soccer = parseSharpApiSchedulePage(
      {
        data: [row("soccer", "Away Club", "Home Club", "mls")],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagueByKey("mls"),
      "2026-08-04T12:00:00.000Z" as never,
    );
    expect(soccer.events).toHaveLength(1);
  });

  it("excludes thin MLB sportsbook derivatives that masquerade as games", () => {
    const page = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "mlb_brewers_pirates_2026-08-07_b1",
            league: "mlb",
            away_team: "Pittsburgh Pirates",
            home_team: "Milwaukee Brewers",
            start_time: "2026-08-07T14:59:28Z",
            status: "upcoming",
            is_live: false,
            book_count: 1,
            market_count: 1,
            markets: ["run_line"],
            books: ["bet365 us"],
          },
          {
            id: "mlb_mets_pirates_2026-08-07_b3",
            league: "mlb",
            away_team: "New York Mets",
            home_team: "Pittsburgh Pirates",
            start_time: "2026-08-07T22:40:00Z",
            status: "upcoming",
            is_live: false,
            book_count: 37,
            market_count: 78,
            markets: ["moneyline", "run_line", "total_runs"],
            books: ["circa", "draftkings", "pinnacle"],
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagueByKey("mlb"),
      "2026-08-07T15:00:00.000Z" as never,
    );

    expect(page.events.map(({ providerEventId }) => providerEventId)).toEqual([
      "mlb_mets_pirates_2026-08-07_b3",
    ]);
    expect(page.exclusions).toContainEqual(
      expect.objectContaining({
        providerEventId: "mlb_brewers_pirates_2026-08-07_b1",
        reason: "catalogue-derivative",
      }),
    );
  });

  it("rejects the provider's plus-suffixed secondary catalogue", () => {
    // Captured from the mls+ catalogue: participants labelled with a trailing
    // "+" and fixtures that are USL sides, not MLS. Twenty-one of these were
    // bootstrapped as canonical events for 2026-08-13, pushing the soccer
    // partition to 61 events against a board limit of 50 — which is what
    // stopped that board being materialised at all.
    const page = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "mls+_charleston_hartford_2026-08-13_b2",
            league: "mls",
            away_team: "Charleston +",
            home_team: "Hartford +",
            start_time: "2026-08-13T23:00:00Z",
            status: "upcoming",
            is_live: false,
          },
          {
            id: "mls_real_2026-08-13_b2",
            league: "mls",
            away_team: "Away Club",
            home_team: "Home Club",
            start_time: "2026-08-13T23:30:00Z",
            status: "upcoming",
            is_live: false,
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagueByKey("mls"),
      "2026-08-13T12:00:00.000Z" as never,
    );

    expect(page.events.map(({ providerEventId }) => providerEventId)).toEqual([
      "mls_real_2026-08-13_b2",
    ]);
  });

  it("keeps a club whose real name merely contains a plus sign", () => {
    // The rule is a trailing " +" only. Nothing legitimate should match it,
    // but a bare "+" inside a name must not be swept up with the catalogue.
    expect(isSharpDerivativeMatchup("A+ United", "B+ City")).toBe(false);
    expect(isSharpDerivativeMatchup("Rapids +", "Earthquakes +")).toBe(true);
  });

  it("rejects a foreign-sport fixture wearing the league's own label", () => {
    // Captured live from /events?league=mlb on 2026-08-13. An NFL game, but
    // the provider labelled it league "mlb", sport "baseball", and gave it a
    // run_line — so it clears the league check, the shape check, and the MLB
    // derivative check, which requires only that markets include moneyline
    // or total_runs. Club resolution is the ONLY thing that rejects it, and
    // it is closer than it looks: "ARI Cardinals" shares its last token with
    // the St. Louis Cardinals, so a resolver that matched on nickname alone
    // would mint a phantom MLB game against the Raiders.
    const page = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "mlb_cardinals_lvraiders_2026-08-13_b3",
            league: "mlb",
            away_team: "ARI Cardinals",
            home_team: "Las Vegas Raiders",
            start_time: "2026-08-14T00:00:00Z",
            status: "upcoming",
            is_live: false,
            markets: ["moneyline", "run_line"],
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagueByKey("mlb"),
      "2026-08-13T02:00:00.000Z" as never,
    );

    expect(page.events).toEqual([]);
    expect(page.exclusions).toEqual([
      expect.objectContaining({
        providerEventId: "mlb_cardinals_lvraiders_2026-08-13_b3",
        reason: "participant-out-of-scope",
      }),
    ]);
  });

  describe("a lifecycle we do not want costs the row, never the page", () => {
    const scheduleRow = (
      id: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      league: "mls",
      away_team: "Away Club",
      home_team: "Home Club",
      start_time: "2026-08-12T23:30:00Z",
      status: "upcoming",
      is_live: false,
      ...overrides,
    });
    const parse = (data: readonly unknown[]) =>
      parseSharpApiSchedulePage(
        { data, pagination: { has_more: false, next_offset: null } },
        sharpApiLeagueByKey("mls"),
        "2026-08-12T22:00:00.000Z" as never,
      );

    it("keeps the surviving rows and counts the started ones", () => {
      // 02c1a67: a live row inside the league's OWN catalogue reaches the
      // shape check, which threw — so one started game failed the whole page
      // and took MLS's schedule, and the odds run that schedule gates, down.
      const page = parse([
        scheduleRow("live-now", { status: "live", is_live: true }),
        scheduleRow("already-final", { status: "final" }),
        scheduleRow("still-upcoming"),
      ]);

      expect(page.events.map(({ providerEventId }) => providerEventId)).toEqual(
        ["still-upcoming"],
      );
      expect(page.exclusions).toEqual([
        expect.objectContaining({
          providerEventId: "live-now",
          reason: "not-upcoming",
        }),
        expect.objectContaining({
          providerEventId: "already-final",
          reason: "not-upcoming",
        }),
      ]);
    });

    it("survives a page whose every row has started", () => {
      const page = parse([
        scheduleRow("live-a", { status: "live", is_live: true }),
        scheduleRow("live-b", { status: "live", is_live: true }),
      ]);

      expect(page.events).toEqual([]);
      expect(page.exclusions).toHaveLength(2);
      expect(page.hasMore).toBe(false);
    });

    it("still throws when the lifecycle fields are malformed rather than unwanted", () => {
      // A status we do not recognise is a provider behaviour; a status that is
      // not a string at all is a defect, and the page is not to be trusted.
      expect(() => parse([scheduleRow("bad-status", { status: 7 })])).toThrow(
        "invalid-response",
      );
      expect(() =>
        parse([scheduleRow("bad-live", { is_live: "yes" })]),
      ).toThrow("invalid-response");
      expect(() =>
        parse([scheduleRow("bad-start", { start_time: "not-a-time" })]),
      ).toThrow("invalid-response");
    });
  });

  it("defensively excludes contaminated MLB odds identities", () => {
    const mlbRow = (
      id: string,
      eventId: string,
      awayTeam: string,
      homeTeam: string,
    ) =>
      oddsRow({
        id,
        event_id: eventId,
        event_uuid: `${eventId}-uuid`,
        league: "mlb",
        away_team: awayTeam,
        home_team: homeTeam,
        market_type: "moneyline",
        market_id: `${eventId}-market`,
        selection_type: "away",
        selection: awayTeam,
        selection_id: `${eventId}-away`,
      });
    const page = parseSharpApiOddsPage(
      {
        data: [
          mlbRow("valid-price", "valid-event", "Boston Red Sox", "Yankees"),
          mlbRow(
            "foreign-price",
            "foreign-event",
            "Yomiuri Giants",
            "Hanshin Tigers",
          ),
          mlbRow(
            "half-known-price",
            "half-known-event",
            "Detroit Tigers",
            "Hanshin Tigers",
          ),
          mlbRow("same-price", "same-event", "Giants", "San Francisco Giants"),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagueByKey("mlb"),
      "2026-08-04T20:00:01.000Z" as never,
    );
    expect(page.events.map(({ providerEventId }) => providerEventId)).toEqual([
      "valid-event",
    ]);
    expect(page.events[0]).toMatchObject({
      awayTeam: "Boston Red Sox",
      homeTeam: "New York Yankees",
    });
    expect(
      page.rejections?.filter(
        ({ reason }) => reason === "participant-unavailable",
      ),
    ).toHaveLength(3);
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
            away_team: "Boston Red Sox",
            home_team: "New York Yankees",
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
              away_team: "Boston Red Sox",
              home_team: "New York Yankees",
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
            away_team: "Boston Red Sox",
            home_team: "New York Yankees",
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
            away_team: "Boston Red Sox",
            home_team: "New York Yankees",
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

    const soccerPage = parseSharpApiSchedulePage(
      {
        data: [
          {
            id: "mls-same-team-future",
            league: "mls",
            away_team: "San Diego FC",
            home_team: "San Diego FC",
            start_time: "2026-12-20T21:00:00Z",
            status: "upcoming",
            is_live: false,
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      sharpApiLeagues[1]!,
      "2026-08-05T18:00:00.000Z" as never,
    );
    expect(soccerPage.events).toEqual([]);
    expect(soccerPage.exclusions).toEqual([
      expect.objectContaining({
        providerEventId: "mls-same-team-future",
        reason: "same-club-matchup",
      }),
    ]);
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
      away_team: "Boston Red Sox",
      home_team: "New York Yankees",
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
      is_active: true,
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
    const conflicted = parseSharpApiOddsPage(
      {
        data: [price, { ...price, selection_id: "different-selection" }],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagues[0]!,
      "2026-08-03T21:42:01.000Z" as never,
    );
    expect(conflicted.events).toHaveLength(0);
    expect(conflicted.rejections).toContainEqual(
      expect.objectContaining({
        reason: "incomplete-market",
        auditId: "price-1",
      }),
    );
  });

  it("merges sportsbook rows for the same event UUID when their start times differ", () => {
    const page = parseSharpApiOddsPage(
      {
        data: [
          oddsRow({
            id: "draftkings-price",
            sportsbook: "draftkings",
          }),
          oddsRow({
            id: "pinnacle-price",
            sportsbook: "pinnacle",
            event_start_time: "2026-08-04T23:00:00.000Z",
          }),
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      sharpApiLeagueByKey("mls"),
      "2026-08-04T20:00:01.000Z" as never,
    );

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      providerEventId: "mls-away-home-2026-08-04",
      providerEventUuid: "event-normalization-1",
      startsAt: "2026-08-04T22:00:00.000Z",
    });
    expect(page.events[0]?.bookmakers.map(({ id }) => id)).toEqual([
      "draftkings",
      "pinnacle",
    ]);
  });

  it("accepts an explicitly empty terminal odds page", () => {
    expect(
      parseSharpApiOddsPage(
        {
          data: null,
          pagination: {
            has_more: false,
            count: 0,
            total: 0,
            next_cursor: null,
          },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
      ),
    ).toMatchObject({ events: [], hasMore: false });
    expect(
      parseSharpApiOddsPage(
        {
          data: null,
          pagination: {
            has_more: false,
            total: 200,
            next_cursor: null,
          },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
        200,
        "cursor",
      ),
    ).toMatchObject({ events: [], hasMore: false });
    expect(() =>
      parseSharpApiOddsPage(
        {
          data: null,
          pagination: {
            has_more: false,
            count: null,
            total: null,
            next_cursor: null,
          },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
        200,
        "cursor",
      ),
    ).toThrow(expect.objectContaining({ stage: "odds:page-envelope" }));
    expect(() =>
      parseSharpApiOddsPage(
        {
          data: null,
          pagination: { has_more: true, count: 0, next_cursor: "next" },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
      ),
    ).toThrow("invalid-response");
    expect(() =>
      parseSharpApiOddsPage(
        {
          data: null,
          pagination: {
            has_more: false,
            total: 200,
            next_cursor: null,
          },
        },
        sharpApiLeagues[0]!,
        "2026-08-03T21:42:01.000Z" as never,
      ),
    ).toThrow(expect.objectContaining({ stage: "odds:page-envelope" }));
  });

  it("does not mistake provider errors or incoherent pagination for empty pages", () => {
    const league = sharpApiLeagues[0]!;
    const retrievedAt = "2026-08-03T21:42:01.000Z" as never;
    for (const payload of [
      {
        data: null,
        error: { code: "provider_failure" },
        pagination: { has_more: false, count: 0, next_cursor: null },
      },
      {
        success: false,
        data: null,
        pagination: { has_more: false, count: 0, next_cursor: null },
      },
    ]) {
      const error = (() => {
        try {
          parseSharpApiOddsPage(payload, league, retrievedAt);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toEqual(
        expect.objectContaining({
          code: "provider-rejected",
          stage: "odds:provider-error",
        }),
      );
    }
    for (const payload of [
      {
        data: null,
        pagination: { has_more: false, count: 1, next_cursor: null },
      },
      {
        data: null,
        pagination: { has_more: false, count: 0, next_cursor: "stale" },
      },
    ])
      expect(() => parseSharpApiOddsPage(payload, league, retrievedAt)).toThrow(
        expect.objectContaining({
          code: "invalid-response",
          stage: "odds:page-envelope",
        }),
      );
  });

  it("rejects incoherent array pagination metadata", () => {
    const league = sharpApiLeagueByKey("mlb");
    const retrievedAt = "2026-08-03T21:42:01.000Z" as never;
    for (const pagination of [
      { has_more: false, count: 0, total: 1, next_cursor: null },
      { has_more: false, count: 1, total: 0, next_cursor: null },
      { has_more: false, count: 1, total: 1, next_cursor: "stale" },
    ])
      expect(() =>
        parseSharpApiOddsPage(
          { data: [oddsRow({ league: "mlb" })], pagination },
          league,
          retrievedAt,
        ),
      ).toThrow(
        expect.objectContaining({ stage: "odds:pagination-coherence" }),
      );
  });

  it("adds bounded endpoint stages without exposing malformed response bodies", async () => {
    const error = await fetchSharpApiFeaturedOdds(
      sharpApiLeagueByKey("mlb"),
      "secret-key",
      undefined,
      () => Promise.resolve(new Response("not-json", { status: 200 })),
    ).catch((caught: unknown) => caught);
    expect(error).toEqual(
      expect.objectContaining({
        code: "invalid-response",
        stage: "odds:json",
      }),
    );
    expect(error).not.toHaveProperty("response");

    expect(() => parseSharpApiAccount({ data: null })).toThrow(
      expect.objectContaining({ stage: "account:envelope" }),
    );
  });

  it("uses endpoint-scoped diagnostics for malformed JSON responses", async () => {
    const malformed = () =>
      Promise.resolve(new Response("not-json", { status: 200 }));
    const cases = [
      ["account:json", () => fetchSharpApiAccount("secret-key", malformed)],
      [
        "odds:json",
        () =>
          fetchSharpApiOddsPage(
            sharpApiLeagueByKey("mlb"),
            "secret-key",
            undefined,
            malformed,
          ),
      ],
      [
        "focused-odds:json",
        () =>
          fetchSharpApiEventOdds(
            sharpApiLeagueByKey("mlb"),
            "event-1",
            "secret-key",
            malformed,
          ),
      ],
      [
        "schedule:json",
        () =>
          fetchSharpApiSchedulePage(
            sharpApiLeagueByKey("mlb"),
            "secret-key",
            0,
            malformed,
          ),
      ],
      [
        "splits:json",
        () =>
          fetchSharpApiSplitsPage(
            sharpApiLeagueByKey("mlb"),
            "secret-key",
            0,
            malformed,
          ),
      ],
    ] as const;
    for (const [stage, invoke] of cases)
      await expect(invoke()).rejects.toEqual(
        expect.objectContaining({ code: "invalid-response", stage }),
      );
  });

  it("uses endpoint-scoped diagnostics for structured error envelopes", async () => {
    const response = () =>
      Promise.resolve(
        Response.json({
          success: false,
          error: { code: "provider_failure" },
          data: [],
          pagination: { has_more: false },
        }),
      );
    const cases = [
      [
        "account:provider-error",
        () => fetchSharpApiAccount("secret-key", response),
      ],
      [
        "odds:provider-error",
        () =>
          fetchSharpApiOddsPage(
            sharpApiLeagueByKey("mlb"),
            "secret-key",
            undefined,
            response,
          ),
      ],
      [
        "focused-odds:provider-error",
        () =>
          fetchSharpApiEventOdds(
            sharpApiLeagueByKey("mlb"),
            "event-1",
            "secret-key",
            response,
          ),
      ],
      [
        "schedule:provider-error",
        () =>
          fetchSharpApiSchedulePage(
            sharpApiLeagueByKey("mlb"),
            "secret-key",
            0,
            response,
          ),
      ],
      [
        "splits:provider-error",
        () =>
          fetchSharpApiSplitsPage(
            sharpApiLeagueByKey("mlb"),
            "secret-key",
            0,
            response,
          ),
      ],
    ] as const;
    for (const [stage, invoke] of cases)
      await expect(invoke()).rejects.toEqual(
        expect.objectContaining({ code: "provider-rejected", stage }),
      );
  });

  it("allows empty error sentinels but rejects malformed success envelopes", () => {
    const account = {
      success: true,
      error: false,
      errors: [],
      data: {
        tier: "pro",
        features: [],
        rate_limit: { requests_per_minute: 60, max_books: 25 },
        streaming: { enabled: false },
      },
    };
    expect(parseSharpApiAccount(account)).toMatchObject({ tier: "pro" });
    expect(() => parseSharpApiAccount({ ...account, success: "true" })).toThrow(
      expect.objectContaining({ stage: "account:envelope" }),
    );
    expect(() =>
      parseSharpApiSchedulePage(
        { success: false, data: [], pagination: { has_more: false } },
        sharpApiLeagueByKey("mlb"),
        "2026-08-03T21:42:01.000Z" as never,
      ),
    ).toThrow(expect.objectContaining({ stage: "schedule:provider-error" }));
    expect(() =>
      parseSharpApiSplitPage(
        {
          errors: [{ code: "failed" }],
          data: [],
          pagination: { has_more: false },
        },
        "2026-08-03T21:42:01.000Z" as never,
      ),
    ).toThrow(expect.objectContaining({ stage: "splits:provider-error" }));
  });

  it("treats unauthorized HTML and ordinary client errors as terminal", async () => {
    for (const status of [401, 403])
      await expect(
        fetchSharpApiOddsPage(
          sharpApiLeagueByKey("mlb"),
          "secret-key",
          undefined,
          () =>
            Promise.resolve(new Response("<html>denied</html>", { status })),
        ),
      ).rejects.toEqual(expect.objectContaining({ code: "unauthorized" }));
    await expect(
      fetchSharpApiOddsPage(
        sharpApiLeagueByKey("mlb"),
        "secret-key",
        undefined,
        () => Promise.resolve(new Response("bad request", { status: 400 })),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "provider-rejected" }));
  });

  it("keeps valid sibling prices when a provider timestamp is unavailable", () => {
    const base = {
      id: "price-valid",
      event_id: "mlb-away-home-2026-08-03",
      event_uuid: "event-uuid-1",
      away_team: "Boston Red Sox",
      home_team: "New York Yankees",
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
      is_active: true,
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

  it("strictly parses bounded split history and selects the newest DK/Circa rows", () => {
    const sourceEvent = parseSharpApiSplitPage(
      {
        data: [
          {
            event_id: "mlb-away-home-2026-08-07",
            sport: "baseball",
            league: "mlb",
            sportsbook: "consensus",
            away_team: "Away Club",
            home_team: "Home Club",
            spread: null,
            total: null,
            moneyline: null,
            fetched_at: "2026-08-07T18:20:00.000Z",
          },
        ],
        pagination: { has_more: false, next_offset: null },
      },
      "2026-08-07T18:20:01.000Z" as never,
    ).items[0]!;
    const row = (book: string, ts: string, away: number) => ({
      book,
      timestamp: Date.parse(ts) / 1_000,
      ts,
      spread: {
        away_line: 1.5,
        home_line: -1.5,
        handle_pct: { away, home: 1 - away },
        bets_pct: { away: 0.4, home: 0.6 },
      },
      total: null,
      moneyline: null,
    });
    const page = parseSharpApiSplitHistoryPage(
      {
        success: true,
        meta: {
          books: ["circa", "draftkings"],
          event_id: sourceEvent.providerEventId,
          newest: "2026-08-07T18:20:00.000Z",
          oldest: "2026-08-07T18:00:00.000Z",
          total: 4,
          updated_at: "2026-08-07T18:20:10.000Z",
        },
        data: [
          row("circa", "2026-08-07T18:00:00.000Z", 0.51),
          row("draftkings", "2026-08-07T18:00:00.000Z", 0.55),
          row("circa", "2026-08-07T18:20:00.000Z", 0.63),
          row("draftkings", "2026-08-07T18:20:00.000Z", 0.67),
        ],
      },
      sourceEvent,
      "2026-08-07T18:20:11.000Z" as never,
      "2026-08-07T17:50:00.000Z" as never,
      "2026-08-07T18:30:00.000Z" as never,
    );
    const latest = latestSharpApiSplitHistoryByBook(page.items);
    expect(latest.map(({ sportsbookId }) => sportsbookId)).toEqual([
      "circa",
      "draftkings",
    ]);
    expect(latest[0]?.providerTimestamp).toBe("2026-08-07T18:20:00.000Z");
    expect(latest[0]?.markets[0]?.selections[0]?.point).toBe(1.5);
    expect(latest[1]?.markets[0]?.selections[0]?.moneyPercent).toBe(67);
  });

  it("requests only a bounded history window and rejects mismatched event metadata", async () => {
    const sourceEvent = {
      providerEventId: "mlb-away-home-2026-08-07",
      sport: "baseball",
      league: "mlb",
      sportsbookId: "consensus",
      awayTeam: "Away Club",
      homeTeam: "Home Club",
      providerTimestamp: "2026-08-07T18:20:00.000Z" as never,
      markets: [],
    } as const;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          meta: {
            event_id: sourceEvent.providerEventId,
            total: 0,
            updated_at: "2026-08-07T18:20:10.000Z",
          },
          data: [],
        }),
      ),
    );
    await fetchSharpApiSplitHistory(
      sourceEvent,
      "2026-08-07T17:50:00.000Z" as never,
      "2026-08-07T18:20:00.000Z" as never,
      "secret",
      fetcher,
    );
    const requestInput = fetcher.mock.calls[0]?.[0];
    if (typeof requestInput !== "string")
      throw new Error("Expected a string SharpAPI history request URL.");
    const requested = new URL(requestInput);
    expect(requested.pathname).toBe("/api/v1/splits/history");
    expect(requested.searchParams.get("event_id")).toBe(
      sourceEvent.providerEventId,
    );
    expect(requested.searchParams.get("start_time")).toBe(
      "2026-08-07T17:50:00.000Z",
    );
    expect(requested.searchParams.get("end_time")).toBe(
      "2026-08-07T18:20:00.000Z",
    );

    expect(() =>
      parseSharpApiSplitHistoryPage(
        {
          success: true,
          meta: {
            books: [],
            event_id: "another-event",
            newest: null,
            oldest: null,
            total: 0,
            updated_at: "2026-08-07T18:20:10.000Z",
          },
          data: [],
        },
        sourceEvent,
        "2026-08-07T18:20:11.000Z" as never,
        "2026-08-07T17:50:00.000Z" as never,
        "2026-08-07T18:20:00.000Z" as never,
      ),
    ).toThrow("invalid-response");
  });
});
