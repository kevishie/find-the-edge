import { describe, expect, it, vi } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
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
  parseSharpApiSportsCatalog,
  parseSharpApiLeaguesCatalog,
  parseSharpApiUniversalEventsPage,
  parseSharpApiUniversalOddsPage,
  fetchSharpApiEventOdds,
  fetchSharpApiAccount,
  fetchSharpApiCatalog,
  fetchSharpApiUniversalEventsPage,
  fetchSharpApiUniversalOddsPage,
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

  const universalEventRow = (overrides: Record<string, unknown> = {}) => ({
    id: "event-universal-1",
    sport: "tennis",
    league: "atp",
    start_time: "2026-08-15T12:00:00.000Z",
    status: "upcoming",
    is_live: false,
    markets: ["moneyline"],
    books: ["hardrock"],
    ...overrides,
  });

  const universalOddsRow = (overrides: Record<string, unknown> = {}) => ({
    id: "price-universal-1",
    event_id: "event-universal-1",
    sport: "tennis",
    league: "atp",
    sportsbook: "hardrock",
    market_type: "moneyline",
    selection: "Player A",
    selection_type: "away",
    odds_american: -115,
    odds_decimal: 1.87,
    odds_probability: 0.535,
    timestamp: "2026-08-14T20:00:00.000Z",
    is_live: false,
    is_active: true,
    is_main_line: true,
    is_alternate_line: false,
    is_player_prop: false,
    is_stale_pregame_price: false,
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
        new Date("2026-08-04T17:00:00.000Z"),
      ).rateWindow.resetsAt,
    ).toBe("2026-08-04T17:00:30.000Z");
  });

  it("bounds untrusted rate timestamps without throwing RangeError", () => {
    expect(() =>
      parseSharpApiResponseMetadata(
        new Headers({
          "x-ratelimit-reset": "9007199254740991",
          "retry-after": "9007199254740991",
        }),
        new Date("2026-08-04T12:00:00.000Z"),
      ),
    ).not.toThrow();
    expect(
      parseSharpApiResponseMetadata(
        new Headers({
          "x-ratelimit-reset": "9007199254740991",
          "retry-after": "9007199254740991",
        }),
        new Date("2026-08-04T12:00:00.000Z"),
      ),
    ).toEqual({ rateWindow: {} });
  });

  it("bounds rate instants to the documented operational horizon", () => {
    const now = new Date("2026-08-04T17:00:00.000Z");
    expect(
      parseSharpApiResponseMetadata(
        new Headers({
          "x-ratelimit-reset": "1785862830",
          "retry-after": "Tue, 04 Aug 2026 17:00:45 GMT",
        }),
        now,
      ),
    ).toEqual({
      rateWindow: { resetsAt: "2026-08-04T17:00:30.000Z" },
      retryAt: "2026-08-04T17:00:45.000Z",
    });
    expect(
      parseSharpApiResponseMetadata(
        new Headers({
          "x-ratelimit-reset": "Fri, 31 Dec 9999 23:59:59 GMT",
          "retry-after": "Fri, 31 Dec 9999 23:59:59 GMT",
        }),
        now,
      ),
    ).toEqual({ rateWindow: {} });
    expect(
      parseSharpApiResponseMetadata(
        new Headers({
          "x-ratelimit-reset": "86401",
          "retry-after": "86401",
        }),
        now,
      ),
    ).toEqual({ rateWindow: {} });
  });

  it("discovers arbitrary provider sports and leagues without a product allowlist", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    expect(
      parseSharpApiSportsCatalog(
        {
          updated_at: retrievedAt,
          data: [
            {
              id: "tennis",
              name: "Tennis",
              numerical_id: 7,
              event_count: 895,
              live_count: 12,
              leagues: ["atp", "wta"],
            },
            {
              id: "future_provider_sport",
              name: "Future Provider Sport",
              event_count: 1,
              live_count: 0,
              leagues: ["future_league"],
            },
          ],
        },
        retrievedAt,
      ).sports,
    ).toMatchObject([
      {
        providerSportId: "tennis",
        displayName: "Tennis",
        numericalId: 7,
        eventCount: 895,
        liveCount: 12,
        providerLeagueIds: ["atp", "wta"],
      },
      {
        providerSportId: "future_provider_sport",
        displayName: "Future Provider Sport",
        eventCount: 1,
        liveCount: 0,
        providerLeagueIds: ["future_league"],
      },
    ]);
    expect(
      parseSharpApiLeaguesCatalog(
        {
          updated_at: retrievedAt,
          data: [
            {
              id: "atp",
              display_name: "ATP",
              sport: "tennis",
              event_count: 649,
              live_count: 4,
            },
          ],
        },
        retrievedAt,
      ).leagues,
    ).toMatchObject([
      {
        providerLeagueId: "atp",
        displayName: "ATP",
        providerSportId: "tennis",
        eventCount: 649,
        liveCount: 4,
      },
    ]);
  });

  it("accepts catalogues beyond the former 5,000-row ceiling within the hard cap", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const data = Array.from({ length: 5_001 }, (_, index) => ({
      id: `league-${index}`,
      display_name: `League ${index}`,
      sport: "provider-sport",
      event_count: 0,
      live_count: 0,
    }));
    const parsed = parseSharpApiLeaguesCatalog({ data }, retrievedAt);
    expect(parsed.sourceRows).toBe(5_001);
    expect(parsed.leagues).toHaveLength(5_001);
    expect(parsed.quarantines).toEqual([]);

    expect(() =>
      parseSharpApiLeaguesCatalog(
        { data: Array.from({ length: 50_001 }, () => null) },
        retrievedAt,
      ),
    ).toThrow(expect.objectContaining({ stage: "leagues:data" }));
  });

  it("keeps provider generation and total optional but rejects malformed present values", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    expect(
      parseSharpApiSportsCatalog({ data: [] }, retrievedAt),
    ).not.toHaveProperty("providerUpdatedAt");
    expect(
      parseSharpApiUniversalEventsPage(
        {
          data: [],
          pagination: { has_more: false, next_offset: null },
        },
        retrievedAt,
      ),
    ).not.toHaveProperty("providerTotal");
    expect(() =>
      parseSharpApiSportsCatalog({ data: [], updated_at: null }, retrievedAt),
    ).toThrow(expect.objectContaining({ stage: "sports:updated-at" }));
    for (const total of [null, "1", -1, 1.5])
      expect(() =>
        parseSharpApiUniversalEventsPage(
          {
            data: [],
            pagination: { has_more: false, next_offset: null, total },
          },
          retrievedAt,
        ),
      ).toThrow(
        expect.objectContaining({ stage: "universal-events:pagination-total" }),
      );
  });

  it("rejects impossible provider calendar dates and UTC offsets before normalization", () => {
    const page = parseSharpApiUniversalEventsPage(
      {
        data: [
          universalEventRow({
            id: "february-thirtieth",
            start_time: "2026-02-30T12:00:00.000Z",
          }),
          universalEventRow({
            id: "offset-hour-too-large",
            start_time: "2026-02-28T12:00:00.000+15:00",
          }),
          universalEventRow({
            id: "offset-minute-too-large",
            start_time: "2026-02-28T12:00:00.000+14:01",
          }),
          universalEventRow({
            id: "valid-leap-day",
            start_time: "2028-02-29T12:00:00.000+14:00",
          }),
        ],
        pagination: { count: 4, has_more: false, next_offset: null, total: 4 },
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(page.records).toEqual([
      expect.objectContaining({
        providerEventId: "valid-leap-day",
        startsAt: "2028-02-28T22:00:00.000Z",
      }),
    ]);
    expect(
      page.quarantines.map(({ providerRecordId }) => providerRecordId),
    ).toEqual([
      "february-thirtieth",
      "offset-hour-too-large",
      "offset-minute-too-large",
    ]);
  });

  it("preserves nanosecond provider generations and accepts valid high-precision row timestamps", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const providerGeneration = "2026-08-14T20:00:00.000984217Z";
    expect(
      parseSharpApiSportsCatalog(
        { data: [], updated_at: providerGeneration },
        retrievedAt,
      ),
    ).toMatchObject({ providerUpdatedAt: providerGeneration });

    const events = parseSharpApiUniversalEventsPage(
      {
        data: [
          universalEventRow({
            id: "submillisecond-event-1",
            start_time: "2026-08-15T12:00:00.000001Z",
          }),
          universalEventRow({
            id: "submillisecond-event-2",
            start_time: "2026-08-15T12:00:00.000999Z",
          }),
          universalEventRow({
            id: "millisecond-event",
            start_time: "2026-08-15T12:00:00.001Z",
          }),
        ],
        pagination: { count: 3, has_more: false, next_offset: null, total: 3 },
      },
      retrievedAt,
    );
    expect(
      events.records.map(({ providerEventId }) => providerEventId),
    ).toEqual([
      "submillisecond-event-1",
      "submillisecond-event-2",
      "millisecond-event",
    ]);
    expect(events.quarantines).toEqual([]);

    const odds = parseSharpApiUniversalOddsPage(
      {
        data: [
          universalOddsRow({
            id: "submillisecond-price",
            timestamp: "2026-08-14T20:00:00.000001Z",
          }),
          universalOddsRow({
            id: "millisecond-price",
            timestamp: "2026-08-14T20:00:00.001Z",
          }),
          universalOddsRow({
            id: "minute-precision-event-start",
            timestamp: "2026-08-14T20:00:00.123456789Z",
            event_start_time: "2026-08-15T04:00Z",
            away_team: "",
          }),
        ],
        pagination: { count: 3, has_more: false, next_cursor: null, total: 3 },
      },
      retrievedAt,
    );
    expect(odds.records.map(({ providerPriceId }) => providerPriceId)).toEqual([
      "submillisecond-price",
      "millisecond-price",
      "minute-precision-event-start",
    ]);
    expect(odds.quarantines).toEqual([]);
    expect(odds.records[2]).toMatchObject({
      eventStartsAt: "2026-08-15T04:00:00.000Z",
      providerTimestamp: "2026-08-14T20:00:00.123Z",
    });
    expect(odds.records[2]).not.toHaveProperty("sourceWarnings");
  });

  it("quarantines catalog counts outside the JavaScript safe-integer range", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    for (const unsafeField of ["event_count", "live_count"] as const) {
      const parsed = parseSharpApiSportsCatalog(
        {
          data: [
            {
              id: `unsafe-${unsafeField}`,
              name: "Unsafe Count",
              event_count: 0,
              live_count: 0,
              leagues: [],
              [unsafeField]: Number.MAX_SAFE_INTEGER + 1,
            },
            {
              id: `safe-${unsafeField}`,
              name: "Safe Count",
              event_count: 0,
              live_count: 0,
              leagues: [],
            },
          ],
        },
        retrievedAt,
      );
      expect(
        parsed.sports.map(({ providerSportId }) => providerSportId),
      ).toEqual([`safe-${unsafeField}`]);
      expect(parsed.quarantines).toEqual([
        expect.objectContaining({ providerRecordId: `unsafe-${unsafeField}` }),
      ]);
    }
  });

  it("lands supported universal rows and quarantines invalid siblings", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const events = parseSharpApiUniversalEventsPage(
      {
        updated_at: retrievedAt,
        data: [
          {
            id: "atp-player-a-player-b",
            uuid: "event-uuid",
            external_ids: { provider_b: "other-id" },
            sport: "tennis",
            league: "atp",
            home_team: "Player B",
            away_team: "Player A",
            start_time: "2026-08-15T12:00:00.000Z",
            status: "upcoming",
            is_live: false,
            markets: ["moneyline"],
            books: ["hardrock"],
          },
          { id: "broken", sport: "tennis" },
        ],
        pagination: {
          has_more: true,
          next_offset: 200,
          total: 400,
        },
      },
      retrievedAt,
    );
    expect(events).toMatchObject({
      sourceRows: 2,
      hasMore: true,
      nextOffset: 200,
      providerTotal: 400,
      records: [{ providerEventId: "atp-player-a-player-b", sport: "tennis" }],
      quarantines: [
        {
          rowIndex: 1,
          providerRecordId: "broken",
          reason: "invalid-row",
        },
      ],
    });

    const odds = parseSharpApiUniversalOddsPage(
      {
        data: [
          {
            id: "price-1",
            event_id: "atp-player-a-player-b",
            event_uuid: "event-uuid",
            sport: "tennis",
            league: "atp",
            sportsbook: "hardrock",
            home_team: "Player B",
            away_team: "Player A",
            market_type: "moneyline",
            market_id: "market-1",
            selection: "Player A",
            selection_type: "away",
            selection_id: "selection-1",
            odds_american: -115,
            odds_decimal: 1.87,
            odds_probability: 0.535,
            line: null,
            event_start_time: "2026-08-15T12:00:00.000Z",
            timestamp: "2026-08-14T19:59:00.000Z",
            is_live: false,
            is_active: true,
            is_main_line: true,
          },
          "unexpected-row",
        ],
        pagination: {
          has_more: true,
          next_cursor: "next-cursor",
          next_offset: 200,
        },
      },
      retrievedAt,
    );
    expect(odds).toMatchObject({
      sourceRows: 2,
      hasMore: true,
      nextCursor: "next-cursor",
      records: [
        {
          providerPriceId: "price-1",
          sport: "tennis",
          marketType: "moneyline",
          americanOdds: -115,
        },
      ],
      quarantines: [{ rowIndex: 1, reason: "invalid-row" }],
    });
  });

  it("lands optional event warnings and quarantines capture-critical odds drift", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const events = parseSharpApiUniversalEventsPage(
      {
        data: [
          {
            id: "future-sport-event",
            uuid: 17,
            external_ids: { good: "alias", bad: 99 },
            sport: "future_provider_sport",
            league: "future_league",
            home_team: "Home",
            away_team: { display: "Away" },
            start_time: "2026-08-15T12:00:00.000Z",
            status: "upcoming",
            is_live: false,
            markets: ["moneyline", null],
            books: "new-book",
          },
        ],
        pagination: { has_more: false, next_offset: null, total: 1 },
      },
      retrievedAt,
    );
    expect(events.quarantines).toEqual([]);
    expect(events.records[0]).toMatchObject({
      providerEventId: "future-sport-event",
      externalIds: { good: "alias" },
      marketKeys: ["moneyline"],
      sportsbookIds: [],
      sourceWarnings: [
        "uuid-invalid",
        "away-participant-invalid",
        "external-ids-entry-invalid",
        "markets-entry-invalid",
        "books-invalid",
      ],
    });

    const odds = parseSharpApiUniversalOddsPage(
      {
        data: [
          {
            id: "future-price",
            event_id: "future-sport-event",
            sport: "future_provider_sport",
            league: "future_league",
            sportsbook: "new-book",
            market_type: "new-market",
            selection: "Selection",
            selection_type: "side",
            odds_american: "-110",
            event_start_time: "not-an-instant",
            timestamp: "2026-08-14T20:00:00.000Z",
            is_live: false,
            is_active: "yes",
          },
        ],
        pagination: { has_more: false, next_cursor: null },
      },
      retrievedAt,
    );
    expect(odds.records).toEqual([]);
    expect(odds.quarantines).toHaveLength(1);
    expect(odds.quarantines[0]).toMatchObject({
      providerRecordId: "future-price",
      reason: "invalid-row",
    });
    expect(odds.quarantines[0]?.sourceFields).toContain("is_active");
    expect(odds.quarantines[0]?.sourceFields).toContain("odds_american");
    expect(odds.quarantines[0]?.sourceSchemaHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("calls the provider-wide catalog, event, and unfiltered odds endpoints", async () => {
    const responses = [
      new Response(
        JSON.stringify({ data: [], updated_at: "2026-08-14T20:00:00.000Z" }),
      ),
      new Response(
        JSON.stringify({ data: [], updated_at: "2026-08-14T20:00:00.000Z" }),
      ),
      new Response(
        JSON.stringify({
          data: [],
          pagination: { has_more: false, next_offset: null, total: 200 },
          updated_at: "2026-08-14T20:00:00.123456789Z",
        }),
      ),
      new Response(
        JSON.stringify({
          data: [],
          pagination: {
            limit: 25,
            has_more: false,
            next_cursor: null,
            next_offset: null,
          },
          updated_at: "2026-08-14T20:00:00.123456789Z",
        }),
      ),
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(responses.shift()!));
    await fetchSharpApiCatalog("secret", fetcher);
    const events = await fetchSharpApiUniversalEventsPage(
      "secret",
      { sport: "tennis", leagues: ["atp", "wta"] },
      200,
      fetcher,
    );
    await fetchSharpApiUniversalOddsPage("secret", "cursor-1", fetcher);
    const urls = fetcher.mock.calls.map(
      ([input]) =>
        new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input,
        ),
    );
    expect(
      urls
        .slice(0, 2)
        .map(({ pathname }) => pathname)
        .sort(),
    ).toEqual(["/api/v1/leagues", "/api/v1/sports"]);
    expect(
      urls.slice(0, 2).map((url) => url.searchParams.get("include_empty")),
    ).toEqual(["true", "true"]);
    expect(urls[2]?.pathname).toBe("/api/v1/events");
    expect(urls[2]?.searchParams.get("sport")).toBe("tennis");
    expect(urls[2]?.searchParams.get("league")).toBe("atp,wta");
    expect(urls[2]?.searchParams.get("offset")).toBe("200");
    expect(events.requestedOffset).toBe(200);
    expect(urls[3]?.pathname).toBe("/api/v1/odds");
    expect([...urls[3]!.searchParams.keys()].sort()).toEqual([
      "cursor",
      "limit",
    ]);
    expect(urls[3]?.searchParams.get("limit")).toBe("25");
    expect(urls[3]?.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("uses compound catalog identity and quarantines league IDs the documented filter cannot represent", () => {
    const parsed = parseSharpApiLeaguesCatalog(
      {
        data: [
          {
            id: "shared_slug",
            display_name: "Shared Football",
            sport: "football",
            event_count: 2,
            live_count: 0,
          },
          {
            id: "shared_slug",
            display_name: "Shared Soccer",
            sport: "soccer",
            event_count: 3,
            live_count: 0,
          },
          {
            id: "world_championships,_mens_singles",
            display_name: "World Championships, Men's Singles",
            sport: "olympics",
            event_count: 1,
            live_count: 0,
          },
          {
            id: "openapi_name_shape",
            name: "OpenAPI Name Shape",
            sport: "tennis",
            event_count: 0,
            live_count: 0,
          },
        ],
        updated_at: "2026-08-15T12:00:00.123456789Z",
      },
      "2026-08-15T12:00:01.000Z" as never,
    );
    expect(
      parsed.leagues.map(({ providerSportId }) => providerSportId),
    ).toEqual(["football", "soccer", "tennis"]);
    expect(parsed.leagues[2]?.displayName).toBe("OpenAPI Name Shape");
    expect(parsed.quarantines).toEqual([
      expect.objectContaining({
        providerRecordId: "world_championships,_mens_singles",
        reason: "unrepresentable-filter-id",
      }),
    ]);
  });

  it("quarantines comma-bearing sport IDs before event-plan construction", () => {
    const retrievedAt = "2026-08-15T12:00:01.000Z" as never;
    const sports = parseSharpApiSportsCatalog(
      {
        data: [
          {
            id: "motor,sport",
            name: "Unrepresentable",
            event_count: 1,
            live_count: 0,
            leagues: [],
          },
          {
            id: "tennis",
            name: "Tennis",
            event_count: 1,
            live_count: 0,
            leagues: [],
          },
        ],
        updated_at: "2026-08-15T12:00:00.123456789Z",
      },
      retrievedAt,
    );
    const leagues = parseSharpApiLeaguesCatalog(
      {
        data: [
          {
            id: "unsafe-league",
            display_name: "Unsafe League",
            sport: "motor,sport",
            event_count: 1,
            live_count: 0,
          },
        ],
        updated_at: "2026-08-15T12:00:00.123456789Z",
      },
      retrievedAt,
    );
    expect(sports.sports.map(({ providerSportId }) => providerSportId)).toEqual(
      ["tennis"],
    );
    expect(sports.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "motor,sport" }),
    ]);
    expect(leagues.leagues).toEqual([]);
    expect(leagues.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "unsafe-league" }),
    ]);
  });

  it("rejects event requests outside SharpAPI's documented league and offset contract before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const [filter, offset] of [
      [{ sport: "" }, 0],
      [{ sport: "tennis", leagues: ["atp", "atp"] }, 0],
      [
        {
          sport: "tennis",
          leagues: Array.from({ length: 51 }, (_, index) => `league-${index}`),
        },
        0,
      ],
      [{ sport: "tennis", leagues: ["atp"] }, 5_001],
    ] as const)
      await expect(
        fetchSharpApiUniversalEventsPage("secret", filter, offset, fetcher),
      ).rejects.toMatchObject({ code: "configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains bounded provider rejection diagnostics without body or logging", async () => {
    const requestId = "r".repeat(128);
    const sensitiveProse = "commercial provider body must never escape";
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "validation_error",
              message: sensitiveProse,
              details: { paid: sensitiveProse },
            },
          }),
          { status: 400, headers: { "x-request-id": requestId } },
        ),
      ),
    );
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    try {
      const error = await fetchSharpApiUniversalOddsPage(
        "secret",
        "opaque-cursor",
        fetcher,
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code: "provider-rejected",
        providerCode: "validation_error",
        httpStatus: 400,
        requestId,
        stage: "universal-odds:http-400",
      });
      expect(error).not.toHaveProperty("body");
      expect(error).not.toHaveProperty("response");
      expect(JSON.stringify(error)).not.toContain(sensitiveProse);
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();

      const oversizedRequestId = "x".repeat(129);
      const oversized = await fetchSharpApiUniversalOddsPage(
        "secret",
        "opaque-cursor",
        () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: "validation_error" } }),
              {
                status: 400,
                headers: { "x-request-id": oversizedRequestId },
              },
            ),
          ),
      ).catch((value: unknown) => value);
      expect(oversized).toMatchObject({
        code: "provider-rejected",
        providerCode: "validation_error",
        httpStatus: 400,
        requestId: undefined,
      });
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it.each([
    [401, "invalid_api_key", "unauthorized"],
    [403, "tier_restricted", "not-entitled"],
    [429, "rate_limited", "rate-limited"],
  ] as const)(
    "retains bounded support diagnostics for HTTP %s",
    async (status, providerCode, code) => {
      const requestId = `request-${status}`;
      const error = await fetchSharpApiUniversalOddsPage(
        "secret",
        undefined,
        vi.fn<typeof fetch>(() =>
          Promise.resolve(
            Response.json(
              {
                error: {
                  code: providerCode,
                  message: "human prose is never retained",
                  ...(status === 429 ? { retryAfter: 3 } : {}),
                },
              },
              {
                status,
                headers: { "x-request-id": requestId },
              },
            ),
          ),
        ),
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({
        code,
        providerCode,
        httpStatus: status,
        requestId,
      });
      expect(JSON.stringify(error)).not.toContain("human prose");
    },
  );

  it("uses longer bounded timeouts only for universal acquisition calls", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);
    const responses = [
      new Response(
        JSON.stringify({
          data: [],
          updated_at: "2026-08-14T20:00:00.000Z",
        }),
      ),
      new Response(
        JSON.stringify({
          data: [],
          updated_at: "2026-08-14T20:00:00.000Z",
        }),
      ),
      new Response(
        JSON.stringify({
          data: [],
          pagination: { has_more: false, next_offset: null, total: 0 },
          updated_at: "2026-08-14T20:00:00.123456789Z",
        }),
      ),
      new Response(
        JSON.stringify({
          data: [],
          pagination: { has_more: false, next_cursor: null },
          updated_at: "2026-08-14T20:00:00.123456789Z",
        }),
      ),
      new Response(
        JSON.stringify({
          data: {
            tier: "pro",
            features: [],
            rate_limit: { requests_per_minute: 60, max_books: 25 },
            streaming: { enabled: false },
          },
        }),
      ),
    ];
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(responses.shift()!),
    );
    try {
      await fetchSharpApiCatalog("secret", fetcher);
      await fetchSharpApiUniversalEventsPage(
        "secret",
        { sport: "tennis", leagues: ["atp"] },
        0,
        fetcher,
      );
      await fetchSharpApiUniversalOddsPage("secret", undefined, fetcher);
      await fetchSharpApiAccount("secret", fetcher);
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
        20_000, 20_000, 20_000, 25_000, 10_000,
      ]);
      expect(
        fetcher.mock.calls.every(
          ([, init]) => init?.signal instanceof AbortSignal,
        ),
      ).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("serializes the two catalog requests against the shared rate window", async () => {
    let resolveSports: ((response: Response) => void) | undefined;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSports = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            updated_at: "2026-08-14T20:00:00.000Z",
            data: [],
          }),
          {
            headers: {
              "x-ratelimit-limit": "100",
              "x-ratelimit-remaining": "20",
            },
          },
        ),
      );
    const pending = fetchSharpApiCatalog("secret", fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    resolveSports?.(
      new Response(
        JSON.stringify({
          updated_at: "2026-08-14T20:00:00.000Z",
          data: [],
        }),
      ),
    );
    await expect(pending).resolves.toMatchObject({
      responseMetadata: { rateWindow: { limit: 100, remaining: 20 } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels a chunked response as soon as the bounded body cap is exceeded", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(5_100_000).fill(32);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fetchSharpApiUniversalOddsPage(
        "secret",
        undefined,
        vi.fn<typeof fetch>(() => Promise.resolve(new Response(body))),
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(cancelled).toBe(true);
  });

  it("rejects malformed UTF-8 in streamed and fallback response bodies", async () => {
    const malformed = new Uint8Array([0xc3, 0x28]);
    const streamed = await fetchSharpApiUniversalEventsPage(
      "secret",
      { sport: "tennis", leagues: ["atp"] },
      0,
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(malformed))),
    ).catch((error: unknown) => error);
    expect(streamed).toMatchObject({
      code: "invalid-response",
      stage: "universal-events:utf8",
    });

    const fallbackResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: () => Promise.resolve(malformed.buffer),
    } as unknown as Response;
    const fallback = await fetchSharpApiUniversalEventsPage(
      "secret",
      { sport: "tennis", leagues: ["atp"] },
      0,
      vi.fn<typeof fetch>(() => Promise.resolve(fallbackResponse)),
    ).catch((error: unknown) => error);
    expect(fallback).toMatchObject({
      code: "invalid-response",
      stage: "universal-events:utf8",
    });
  });

  it("rejects incoherent universal counts, terminal tokens, and event offset jumps", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    expect(() =>
      parseSharpApiUniversalEventsPage(
        {
          data: [universalEventRow()],
          pagination: {
            count: 0,
            total: 1,
            has_more: false,
            next_offset: null,
          },
        },
        retrievedAt,
      ),
    ).toThrow("invalid-response");
    expect(
      parseSharpApiUniversalEventsPage(
        {
          data: [universalEventRow()],
          pagination: {
            count: 1,
            total: 5_300,
            has_more: true,
            next_offset: 5_200,
          },
        },
        retrievedAt,
        5_000,
      ),
    ).toMatchObject({
      requestedOffset: 5_000,
      nextOffset: 5_200,
      providerTotal: 5_300,
    });
    expect(() =>
      parseSharpApiUniversalEventsPage(
        {
          data: [universalEventRow()],
          pagination: {
            count: null,
            total: 1,
            has_more: false,
            next_offset: null,
          },
        },
        retrievedAt,
      ),
    ).toThrow("invalid-response");
    expect(() =>
      parseSharpApiUniversalOddsPage(
        {
          data: [universalOddsRow()],
          pagination: {
            count: 1,
            has_more: false,
            next_cursor: "stale-terminal-cursor",
          },
        },
        retrievedAt,
      ),
    ).toThrow("invalid-response");
    expect(() =>
      parseSharpApiUniversalEventsPage(
        {
          data: [universalEventRow()],
          pagination: {
            count: 1,
            total: 500,
            has_more: true,
            next_offset: 400,
          },
        },
        retrievedAt,
        0,
      ),
    ).toThrow("invalid-response");
    expect(() =>
      parseSharpApiUniversalEventsPage(
        {
          data: [universalEventRow()],
          pagination: {
            count: 1,
            total: 5_200,
            has_more: true,
            next_offset: 5_200,
          },
        },
        retrievedAt,
        5_000,
      ),
    ).toThrow("invalid-response");
    expect(
      parseSharpApiUniversalEventsPage(
        {
          data: [universalEventRow()],
          pagination: {
            limit: 200,
            offset: 200,
            count: 1,
            total: 500,
            has_more: true,
            next_offset: 400,
          },
        },
        retrievedAt,
        200,
      ),
    ).toMatchObject({ requestedOffset: 200, nextOffset: 400 });
  });

  it("accepts SharpAPI's documented null empty Events page", () => {
    expect(
      parseSharpApiUniversalEventsPage(
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
          updated_at: "2026-08-14T20:00:00.123456789Z",
        },
        "2026-08-14T20:00:01.000Z" as never,
      ),
    ).toMatchObject({
      records: [],
      quarantines: [],
      sourceRows: 0,
      providerTotal: 0,
      providerUpdatedAt: "2026-08-14T20:00:00.123456789Z",
      hasMore: false,
    });
  });

  it("requires SharpAPI's documented updated_at on fetched universal successes", async () => {
    const response = () =>
      Promise.resolve(
        Response.json({
          data: null,
          pagination: {
            count: 0,
            total: 0,
            has_more: false,
            next_offset: null,
            next_cursor: null,
          },
        }),
      );
    await expect(
      fetchSharpApiUniversalEventsPage(
        "secret",
        { sport: "tennis" },
        0,
        vi.fn<typeof fetch>(response),
      ),
    ).rejects.toMatchObject({
      code: "invalid-response",
      stage: "universal-events:updated-at-missing",
    });
    await expect(
      fetchSharpApiUniversalOddsPage(
        "secret",
        undefined,
        vi.fn<typeof fetch>(response),
      ),
    ).rejects.toMatchObject({
      code: "invalid-response",
      stage: "universal-odds:updated-at-missing",
    });
  });

  it("rejects unsafe-integer universal pagination metadata", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    for (const pagination of [
      { has_more: false, next_offset: null, count: unsafe },
      { has_more: false, next_offset: null, limit: unsafe },
      { has_more: false, next_offset: null, offset: unsafe },
      { has_more: false, next_offset: null, total: unsafe },
    ])
      expect(() =>
        parseSharpApiUniversalEventsPage({ data: [], pagination }, retrievedAt),
      ).toThrow("invalid-response");
  });

  it("accepts the provider's 200-row odds maximum and rejects an oversized page", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const rows = Array.from({ length: 200 }, (_, index) =>
      universalOddsRow({ id: `price-${index}` }),
    );
    expect(
      parseSharpApiUniversalOddsPage(
        {
          data: rows,
          pagination: {
            limit: 200,
            count: 200,
            has_more: true,
            next_cursor: "next",
          },
        },
        retrievedAt,
      ).records,
    ).toHaveLength(200);
    expect(() =>
      parseSharpApiUniversalOddsPage(
        {
          data: [...rows, universalOddsRow({ id: "price-200" })],
          pagination: {
            limit: 200,
            count: 201,
            has_more: true,
            next_cursor: "next",
          },
        },
        retrievedAt,
      ),
    ).toThrow(expect.objectContaining({ stage: "universal-odds:page" }));
  });

  it("accepts only storage-safe bounded universal cursors", async () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const validUtf8Cursor = "😀".repeat(2_048);
    expect(
      parseSharpApiUniversalOddsPage(
        {
          data: [universalOddsRow()],
          pagination: {
            has_more: true,
            next_cursor: validUtf8Cursor,
          },
        },
        retrievedAt,
      ).nextCursor,
    ).toBe(validUtf8Cursor);

    for (const nextCursor of [
      "",
      " padded ",
      "control\u0001cursor",
      "control\u0085cursor",
      "lone-surrogate-\ud800",
      "x".repeat(4_097),
    ])
      expect(() =>
        parseSharpApiUniversalOddsPage(
          {
            data: [universalOddsRow()],
            pagination: { has_more: true, next_cursor: nextCursor },
          },
          retrievedAt,
        ),
      ).toThrow(
        expect.objectContaining({ stage: "universal-odds:pagination" }),
      );

    await expect(
      fetchSharpApiUniversalOddsPage(
        "secret",
        "lone-surrogate-\ud800",
        vi.fn<typeof fetch>(),
      ),
    ).rejects.toMatchObject({ code: "configuration" });
  });

  it("quarantines nested DynamoDB-unsafe numbers without losing valid siblings", async () => {
    const rowJson = (id: string, numberSource: string) => {
      const base = JSON.stringify(universalEventRow({ id }));
      return `${base.slice(0, -1)},"provider_extension":{"nested":{"value":${numberSource}}}}`;
    };
    const body = `{"data":[${[
      rowJson("valid-number", "1.5e-100"),
      rowJson("integer-too-large", "9007199254740992"),
      rowJson("exponent-too-large", "1e126"),
      rowJson("exponent-too-small", "1e-131"),
      rowJson("precision-too-large", "123456789012345678901234567890123456789"),
    ].join(
      ",",
    )}],"pagination":{"has_more":false,"next_offset":null,"total":5},"updated_at":"2026-08-14T20:00:00.123456789Z"}`;
    const page = await fetchSharpApiUniversalEventsPage(
      "secret",
      { sport: "tennis", leagues: ["atp"] },
      0,
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(body))),
    );
    expect(page.records.map(({ providerEventId }) => providerEventId)).toEqual([
      "valid-number",
    ]);
    expect(
      page.quarantines.map(({ providerRecordId }) => providerRecordId),
    ).toEqual([
      "integer-too-large",
      "exponent-too-large",
      "exponent-too-small",
      "precision-too-large",
    ]);
    expect(page.sourceRows).toBe(5);
    expect(() =>
      marshall(page.records[0] as unknown as Record<string, unknown>),
    ).not.toThrow();
  });

  it("never returns an odds number rejected by the default DynamoDB marshaller", () => {
    const page = parseSharpApiUniversalOddsPage(
      {
        data: [
          universalOddsRow({
            id: "unsafe-integer",
            max_bet: Number.MAX_SAFE_INTEGER + 1,
          }),
          universalOddsRow({ id: "safe-sibling", max_bet: 2_500.5 }),
        ],
        pagination: { has_more: false, next_cursor: null, total: 2 },
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(page.records.map(({ providerPriceId }) => providerPriceId)).toEqual([
      "safe-sibling",
    ]);
    expect(page.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "unsafe-integer" }),
    ]);
    expect(() =>
      marshall(page.records[0] as unknown as Record<string, unknown>),
    ).not.toThrow();
  });

  it("rejects lossy known decimal sources in fetched and direct parser rows", async () => {
    const fetchedRowJson = (id: string, decimalSource: string) =>
      JSON.stringify(universalOddsRow({ id })).replace(
        '"odds_decimal":1.87',
        `"odds_decimal":${decimalSource}`,
      );
    const fetched = await fetchSharpApiUniversalOddsPage(
      "secret",
      undefined,
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            `{"data":[${fetchedRowJson(
              "lossy-source",
              "1.87000000000000001",
            )},${fetchedRowJson(
              "exact-source",
              "1.87000000000001",
            )}],"pagination":{"has_more":false,"next_cursor":null,"total":2},"updated_at":"2026-08-14T20:00:00.123456789Z"}`,
          ),
        ),
      ),
    );
    expect(
      fetched.records.map(({ providerPriceId }) => providerPriceId),
    ).toEqual(["exact-source"]);
    expect(fetched.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "lossy-source" }),
    ]);
    expect(() =>
      marshall(fetched.records[0] as unknown as Record<string, unknown>),
    ).not.toThrow();

    const direct = parseSharpApiUniversalOddsPage(
      {
        data: [
          universalOddsRow({
            id: "ambiguous-direct-decimal",
            odds_decimal: 1.2345678901234567,
          }),
          universalOddsRow({
            id: "bounded-direct-decimal",
            odds_decimal: 1.23456789012345,
          }),
        ],
        pagination: { has_more: false, next_cursor: null, total: 2 },
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(
      direct.records.map(({ providerPriceId }) => providerPriceId),
    ).toEqual(["bounded-direct-decimal"]);
    expect(direct.quarantines).toEqual([
      expect.objectContaining({
        providerRecordId: "ambiguous-direct-decimal",
      }),
    ]);
    expect(() =>
      marshall(direct.records[0] as unknown as Record<string, unknown>),
    ).not.toThrow();
  });

  it("quarantines odds without a reconstructable price or valid active lifecycle", () => {
    const page = parseSharpApiUniversalOddsPage(
      {
        data: [
          universalOddsRow({
            id: "missing-price",
            odds_american: undefined,
            odds_decimal: undefined,
            odds_probability: undefined,
          }),
          universalOddsRow({ id: "invalid-lifecycle", is_active: "yes" }),
          universalOddsRow({
            id: "documented-default-active",
            is_active: undefined,
          }),
          universalOddsRow({ id: "valid-sibling" }),
        ],
        pagination: {
          count: 4,
          has_more: false,
          next_cursor: null,
        },
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(
      page.records.map(({ providerPriceId, isActive }) => ({
        providerPriceId,
        isActive,
      })),
    ).toEqual([
      { providerPriceId: "documented-default-active", isActive: true },
      { providerPriceId: "valid-sibling", isActive: true },
    ]);
    expect(
      page.quarantines.map(({ providerRecordId }) => providerRecordId),
    ).toEqual(["missing-price", "invalid-lifecycle"]);
  });

  it("retains bounded complete shape evidence for novel landed fields", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const base = parseSharpApiUniversalOddsPage(
      {
        data: [universalOddsRow()],
        pagination: { has_more: false, next_cursor: null },
      },
      retrievedAt,
    ).records[0]!;
    const novel = parseSharpApiUniversalOddsPage(
      {
        data: [universalOddsRow({ provider_period: "first-half" })],
        pagination: { has_more: false, next_cursor: null },
      },
      retrievedAt,
    ).records[0]!;
    expect(novel.sourceFields).toContain("provider_period");
    expect(novel.sourceFieldCount).toBe(base.sourceFieldCount! + 1);
    expect(novel.sourceSchemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(novel.sourceSchemaHash).not.toBe(base.sourceSchemaHash);

    const manyFields = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `novel_${String(index).padStart(2, "0")}`,
        index,
      ]),
    );
    const bounded = parseSharpApiUniversalEventsPage(
      {
        data: [universalEventRow(manyFields)],
        pagination: { has_more: false, next_offset: null, total: 1 },
      },
      retrievedAt,
    ).records[0]!;
    expect(bounded.sourceFields).toHaveLength(64);
    expect(bounded.sourceFieldsTruncated).toBe(true);
    expect(bounded.sourceFieldCount).toBeGreaterThan(64);
    expect(bounded.sourceSchemaHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("quarantines storage-unsafe keys without suppressing valid siblings", () => {
    const page = parseSharpApiUniversalEventsPage(
      {
        data: [
          universalEventRow({ id: "valid-event" }),
          universalEventRow({ id: "bad\u0001event" }),
          universalEventRow({ id: "bad\u0085event" }),
          universalEventRow({ id: "😀".repeat(128) }),
        ],
        pagination: { count: 4, has_more: false, next_offset: null, total: 4 },
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(page.records.map(({ providerEventId }) => providerEventId)).toEqual([
      "valid-event",
    ]);
    expect(page.quarantines).toHaveLength(3);
  });

  it("never lands lone-surrogate provider display or participant strings", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const catalog = parseSharpApiSportsCatalog(
      {
        data: [
          {
            id: "invalid-display",
            name: "Broken \ud800 Display",
            event_count: 0,
            live_count: 0,
            leagues: [],
          },
          {
            id: "valid-display",
            name: "Valid Display 😀",
            event_count: 0,
            live_count: 0,
            leagues: [],
          },
        ],
      },
      retrievedAt,
    );
    expect(
      catalog.sports.map(({ providerSportId }) => providerSportId),
    ).toEqual(["valid-display"]);
    expect(catalog.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "invalid-display" }),
    ]);

    const events = parseSharpApiUniversalEventsPage(
      {
        data: [
          universalEventRow({
            id: "invalid-participant",
            home_team: "Broken \udfff Participant",
          }),
          universalEventRow({
            id: "valid-participant",
            home_team: "Valid Participant 😀",
          }),
        ],
        pagination: { count: 2, has_more: false, next_offset: null, total: 2 },
      },
      retrievedAt,
    );
    expect(events.records).toEqual([
      expect.objectContaining({
        providerEventId: "invalid-participant",
        sourceWarnings: ["home-participant-invalid", "external-ids-invalid"],
      }),
      expect.objectContaining({
        providerEventId: "valid-participant",
        homeParticipant: "Valid Participant 😀",
      }),
    ]);
    expect(events.records[0]).not.toHaveProperty("homeParticipant");

    const odds = parseSharpApiUniversalOddsPage(
      {
        data: [
          universalOddsRow({
            id: "invalid-selection",
            selection: "Broken \ud800 Selection",
          }),
          universalOddsRow({
            id: "valid-selection",
            selection: "Valid Selection 😀",
          }),
        ],
        pagination: { count: 2, has_more: false, next_cursor: null, total: 2 },
      },
      retrievedAt,
    );
    expect(odds.records.map(({ providerPriceId }) => providerPriceId)).toEqual([
      "valid-selection",
    ]);
    expect(odds.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "invalid-selection" }),
    ]);
  });

  it("bounds generic nested row traversal without suppressing valid siblings", () => {
    const page = parseSharpApiUniversalEventsPage(
      {
        data: [
          universalEventRow({
            id: "oversized-source-tree",
            provider_extension: Array.from({ length: 100_001 }, () => 1),
          }),
          universalEventRow({ id: "valid-event" }),
        ],
        pagination: { count: 2, has_more: false, next_offset: null, total: 2 },
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(page.records.map(({ providerEventId }) => providerEventId)).toEqual([
      "valid-event",
    ]);
    expect(page.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: "oversized-source-tree" }),
    ]);
  });

  it("pre-bounds oversized catalog membership as a row quarantine", () => {
    const leagues = Array.from(
      { length: 2_600 },
      (_, index) =>
        `league-${String(index).padStart(4, "0")}-${"x".repeat(110)}`,
    );
    const page = parseSharpApiSportsCatalog(
      {
        data: [
          {
            id: "oversized-sport",
            name: "Oversized Sport",
            event_count: 1,
            live_count: 0,
            leagues,
          },
          {
            id: "valid-sport",
            name: "Valid Sport",
            event_count: 0,
            live_count: 0,
            leagues: [],
          },
        ],
      },
      "2026-08-14T20:00:00.000Z" as never,
    );
    expect(page.sports.map(({ providerSportId }) => providerSportId)).toEqual([
      "valid-sport",
    ]);
    expect(page.quarantines).toEqual([
      expect.objectContaining({
        providerRecordId: "oversized-sport",
        reason: "invalid-row",
      }),
    ]);
  });

  it("quarantines rows whose encoded snapshot sort key exceeds DynamoDB bounds", () => {
    const retrievedAt = "2026-08-14T20:00:00.000Z" as never;
    const boundaryRecordId = `${"😀".repeat(84)}xxxx`;
    const boundarySport = "😀".repeat(32);
    const boundaryLeague = `${"😀".repeat(52)}xx`;

    const events = parseSharpApiUniversalEventsPage(
      {
        data: [
          universalEventRow({ id: boundaryRecordId }),
          universalEventRow({ id: "valid-event" }),
        ],
        pagination: { count: 2, has_more: false, next_offset: null, total: 2 },
      },
      retrievedAt,
    );
    expect(
      events.records.map(({ providerEventId }) => providerEventId),
    ).toEqual(["valid-event"]);
    expect(events.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: boundaryRecordId }),
    ]);

    const odds = parseSharpApiUniversalOddsPage(
      {
        data: [
          universalOddsRow({ id: boundaryRecordId }),
          universalOddsRow({ id: "valid-price" }),
        ],
        pagination: { count: 2, has_more: false, next_cursor: null, total: 2 },
      },
      retrievedAt,
    );
    expect(odds.records.map(({ providerPriceId }) => providerPriceId)).toEqual([
      "valid-price",
    ]);
    expect(odds.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: boundaryRecordId }),
    ]);

    const leagues = parseSharpApiLeaguesCatalog(
      {
        data: [
          {
            id: boundaryLeague,
            display_name: "Boundary League",
            sport: boundarySport,
            event_count: 1,
            live_count: 0,
          },
          {
            id: "valid-league",
            display_name: "Valid League",
            sport: "baseball",
            event_count: 1,
            live_count: 0,
          },
        ],
      },
      retrievedAt,
    );
    expect(
      leagues.leagues.map(({ providerLeagueId }) => providerLeagueId),
    ).toEqual(["valid-league"]);
    expect(leagues.quarantines).toEqual([
      expect.objectContaining({ providerRecordId: boundaryLeague }),
    ]);
  });

  it("requires timestamped coherent catalogs without treating response emission times as a shared generation", async () => {
    const catalogFetcher = (
      sportUpdatedAt: string | undefined,
      leagueUpdatedAt: string | undefined,
      sportLeagues: readonly string[],
    ) => {
      const responses = [
        new Response(
          JSON.stringify({
            ...(sportUpdatedAt ? { updated_at: sportUpdatedAt } : {}),
            data: [
              {
                id: "tennis",
                name: "Tennis",
                event_count: 1,
                live_count: 0,
                leagues: sportLeagues,
              },
            ],
          }),
        ),
        new Response(
          JSON.stringify({
            ...(leagueUpdatedAt ? { updated_at: leagueUpdatedAt } : {}),
            data: [
              {
                id: "atp",
                display_name: "ATP",
                sport: "tennis",
                event_count: 1,
                live_count: 0,
              },
            ],
          }),
        ),
      ];
      return vi.fn<typeof fetch>(() => Promise.resolve(responses.shift()!));
    };
    const firstGeneration = "2026-08-14T20:00:00.000Z";
    await expect(
      fetchSharpApiCatalog(
        "secret",
        catalogFetcher(
          "2026-08-14T20:00:00.000001Z",
          "2026-08-14T20:00:00.000999Z",
          ["atp"],
        ),
      ),
    ).resolves.toMatchObject({
      providerUpdatedAt: "2026-08-14T20:00:00.000999Z",
    });
    const nanosecondGeneration = "2026-08-14T20:00:00.000984217Z";
    await expect(
      fetchSharpApiCatalog(
        "secret",
        catalogFetcher(nanosecondGeneration, nanosecondGeneration, ["atp"]),
      ),
    ).resolves.toMatchObject({
      sourceRows: 2,
      providerUpdatedAt: nanosecondGeneration,
    });
    for (const [sportUpdatedAt, leagueUpdatedAt] of [
      [undefined, undefined],
      [firstGeneration, undefined],
      [undefined, firstGeneration],
    ] as const)
      await expect(
        fetchSharpApiCatalog(
          "secret",
          catalogFetcher(sportUpdatedAt, leagueUpdatedAt, ["atp"]),
        ),
      ).rejects.toMatchObject({
        code: "invalid-response",
        stage: "leagues:catalog-generation",
      });
    await expect(
      fetchSharpApiCatalog(
        "secret",
        catalogFetcher(firstGeneration, "2026-08-14T20:00:01.000Z", ["atp"]),
      ),
    ).resolves.toMatchObject({
      providerUpdatedAt: "2026-08-14T20:00:01.000Z",
    });
    await expect(
      fetchSharpApiCatalog(
        "secret",
        catalogFetcher(firstGeneration, firstGeneration, ["wta"]),
      ),
    ).resolves.toMatchObject({
      sports: [expect.objectContaining({ providerLeagueIds: ["wta"] })],
      leagues: [expect.objectContaining({ providerLeagueId: "atp" })],
    });
    await expect(
      fetchSharpApiCatalog(
        "secret",
        catalogFetcher(firstGeneration, firstGeneration, ["atp"]),
      ),
    ).resolves.toMatchObject({
      sourceRows: 2,
      providerUpdatedAt: firstGeneration,
    });
    await expect(
      fetchSharpApiCatalog(
        "secret",
        catalogFetcher(firstGeneration, firstGeneration, [
          "atp",
          "slug-colliding-in-another-sport",
        ]),
      ),
    ).resolves.toMatchObject({ sourceRows: 2 });
  });

  it("resolves only exact catalog-backed runtime leagues", () => {
    expect(sharpApiLeagues.map(({ leagueKey }) => leagueKey)).toEqual([
      "mlb",
      "mls",
      "nfl",
      "epl",
      "liga-mx",
      "uefa-champions-league",
    ]);
    // Football takes the two-way shape, and its sport key is what the board's
    // market specifications switch on.
    expect(sharpApiLeagueByKey("nfl")).toMatchObject({
      sportKey: "football",
      providerLeague: "nfl",
      moneylineMarket: "moneyline",
    });
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

  it("uses a valid provider reset for 429 when Retry-After is absent", async () => {
    const resetAt = Date.now() + 30_000;
    const calls = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "limited" }), {
          status: 429,
          headers: { "x-ratelimit-reset": String(resetAt) },
        }),
      ),
    );
    const error = await fetchSharpApiFeaturedOdds(
      sharpApiLeagueByKey("mls"),
      "secret-key",
      undefined,
      calls,
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "rate-limited",
      retryable: true,
      retryAt: new Date(resetAt).toISOString(),
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["documented retryAfter seconds", { retryAfter: 3 }, 3_000],
    ["OpenAPI retry_after epoch milliseconds", { retry_after: 0 }, 4_000],
  ])(
    "uses bounded %s from the 429 error envelope",
    async (_label, fields, delay) => {
      const before = Date.now();
      const bodyFields =
        "retry_after" in fields ? { retry_after: before + delay } : fields;
      const error = await fetchSharpApiUniversalOddsPage(
        "secret",
        undefined,
        vi.fn<typeof fetch>(() =>
          Promise.resolve(
            Response.json(
              {
                error: {
                  code: "rate_limited",
                  message: "prose is not parsed",
                  ...bodyFields,
                },
              },
              { status: 429 },
            ),
          ),
        ),
      ).catch((value: unknown) => value);
      const after = Date.now();
      expect(error).toMatchObject({ code: "rate-limited", retryable: true });
      if (!(error instanceof SharpApiError) || !error.retryAt)
        throw new Error("expected bounded retry timestamp");
      expect(Date.parse(error.retryAt)).toBeGreaterThanOrEqual(before + delay);
      expect(Date.parse(error.retryAt)).toBeLessThanOrEqual(after + delay);
    },
  );

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
