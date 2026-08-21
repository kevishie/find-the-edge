import { describe, expect, it, vi } from "vitest";

import {
  fetchSharpApiClosingLines,
  parseSharpApiClosingLines,
  SharpApiError,
} from "./sharp-api";

const eventId = "mlb_athletics_mariners_2026-04-22";
const retrievedAt = "2026-04-22T22:10:10.000Z" as never;

const closingOdd = (overrides: Record<string, unknown> = {}) => ({
  sportsbook: "draftkings",
  market_type: "moneyline",
  selection: "Seattle Mariners",
  selection_type: "home",
  line: null,
  odds_american: -165,
  odds_decimal: 1.606,
  market_id: "ml-main",
  selection_id: "ml-home",
  canonical_key: `${eventId}:moneyline:home`,
  implied_probability: 0.6226,
  no_vig_probability: 0.6041,
  fair_close_decimal: 1.6554,
  closing_probability: 0.6041,
  source_updated_at: "2026-04-22T22:09:55.001Z",
  ...overrides,
});

const closingBook = (overrides: Record<string, unknown> = {}) => ({
  captured_at: "2026-04-22T22:09:58.412Z",
  seconds_before_kickoff: -3,
  capture_trigger: "transition",
  is_final: true,
  odds: [
    closingOdd(),
    closingOdd({
      selection: "Athletics",
      selection_type: "away",
      odds_american: 145,
      odds_decimal: 2.45,
      selection_id: "ml-away",
      canonical_key: `${eventId}:moneyline:away`,
      implied_probability: 0.4082,
      no_vig_probability: 0.3959,
      fair_close_decimal: 2.5259,
      closing_probability: 0.3959,
    }),
    closingOdd({
      market_type: "run_line",
      market_id: "rl-main",
      selection_type: "home",
      line: -1.5,
      odds_american: 125,
      odds_decimal: 2.25,
      selection_id: "rl-home",
      canonical_key: `${eventId}:run_line:home:-1.5`,
      implied_probability: 0.4444,
      no_vig_probability: 0.43,
      fair_close_decimal: 2.3256,
      closing_probability: 0.43,
    }),
    closingOdd({
      market_type: "run_line",
      market_id: "rl-main",
      selection: "Athletics",
      selection_type: "away",
      line: 1.5,
      odds_american: -145,
      odds_decimal: 1.69,
      selection_id: "rl-away",
      canonical_key: `${eventId}:run_line:away:1.5`,
      implied_probability: 0.5917,
      no_vig_probability: 0.57,
      fair_close_decimal: 1.7544,
      closing_probability: 0.57,
    }),
    closingOdd({
      market_type: "total_runs",
      market_id: "total-main",
      selection: "Over",
      selection_type: "over",
      line: 7.5,
      odds_american: -110,
      odds_decimal: 1.91,
      selection_id: "total-over",
      canonical_key: `${eventId}:total_runs:over:7.5`,
      implied_probability: 0.5238,
      no_vig_probability: 0.5,
      fair_close_decimal: 2,
      closing_probability: 0.5,
    }),
    closingOdd({
      market_type: "total_runs",
      market_id: "total-main",
      selection: "Under",
      selection_type: "under",
      line: 7.5,
      odds_american: -110,
      odds_decimal: 1.91,
      selection_id: "total-under",
      canonical_key: `${eventId}:total_runs:under:7.5`,
      implied_probability: 0.5238,
      no_vig_probability: 0.5,
      fair_close_decimal: 2,
      closing_probability: 0.5,
    }),
  ],
  ...overrides,
});

const closingPayload = (
  books: Record<string, unknown> = { draftkings: closingBook() },
) => ({
  success: true,
  data: {
    event_id: eventId,
    sport: "baseball",
    league: "mlb",
    home_team: "Seattle Mariners",
    away_team: "Athletics",
    event_start_time: "2026-04-22T22:10:00Z",
    captured_at: "2026-04-22T22:09:58.412Z",
    books,
  },
});

describe("SharpAPI canonical closing lines", () => {
  it("normalizes one coherent finalized book across the supported markets", () => {
    const snapshot = parseSharpApiClosingLines(
      closingPayload(),
      eventId,
      retrievedAt,
    );

    expect(snapshot).toMatchObject({
      providerEventId: eventId,
      sport: "baseball",
      league: "mlb",
      awayTeam: "Athletics",
      homeTeam: "Seattle Mariners",
      startsAt: "2026-04-22T22:10:00.000Z",
      firstCapturedAt: "2026-04-22T22:09:58.412Z",
      rejections: [],
    });
    expect(snapshot.books).toHaveLength(1);
    expect(snapshot.books[0]).toMatchObject({
      id: "draftkings",
      providerSportsbookId: "draftkings",
      captureTrigger: "transition",
      isFinal: true,
    });
    expect(snapshot.books[0]?.prices.map(({ marketKey }) => marketKey)).toEqual(
      ["moneyline", "moneyline", "spread", "spread", "total", "total"],
    );
  });

  it("accepts the live endpoint's full-precision probabilities and nanosecond timestamps", () => {
    const odds = [
      closingOdd({
        sportsbook: "pinnacle",
        odds_decimal: 1.9433962264150944,
        implied_probability: 0.5145631067961165,
        no_vig_probability: 0.5047143126532152,
        fair_close_decimal: 1.9813188866056415,
        closing_probability: 0.5048495241801317,
        source_updated_at: "2026-04-22T22:09:55.001907432Z",
      }),
      closingOdd({
        sportsbook: "pinnacle",
        selection: "Athletics",
        selection_type: "away",
        odds_american: -102,
        odds_decimal: 1.9803921568627452,
        selection_id: "ml-away",
        canonical_key: `${eventId}:moneyline:away`,
        implied_probability: 0.504950495049505,
        no_vig_probability: 0.49528568734678485,
        fair_close_decimal: 2.0190367409099563,
        closing_probability: 0.4951504779680169,
        source_updated_at: "2026-04-22T22:09:55.001907432Z",
      }),
    ];
    const snapshot = parseSharpApiClosingLines(
      closingPayload({
        pinnacle: closingBook({
          captured_at: "2026-04-22T22:09:58.41293461Z",
          odds,
        }),
      }),
      eventId,
      retrievedAt,
    );

    expect(snapshot.books[0]?.prices).toHaveLength(2);
    expect(snapshot.books[0]?.capturedAt).toBe("2026-04-22T22:09:58.412Z");
    expect(snapshot.rejections).toEqual([]);
  });

  it("accepts provider-abbreviated team labels when exact event and side keys bind the row", () => {
    const base = closingBook();
    const odds = (base.odds as Record<string, unknown>[]).map((row) => ({
      ...row,
      ...(row["selection_type"] === "home"
        ? { selection: "Mariners" }
        : row["selection_type"] === "away"
          ? { selection: "A's" }
          : {}),
    }));
    const snapshot = parseSharpApiClosingLines(
      closingPayload({ draftkings: closingBook({ odds }) }),
      eventId,
      retrievedAt,
    );

    expect(snapshot.books[0]?.prices).toHaveLength(6);
    expect(snapshot.rejections).toEqual([]);
  });

  it("derives a fair decimal from closing probability when the live provider sends null", () => {
    const base = closingBook();
    const odds = (base.odds as Record<string, unknown>[]).map((row) =>
      row["market_type"] === "run_line" && row["selection_type"] === "home"
        ? {
            ...row,
            fair_close_decimal: null,
            closing_probability: 0.4,
          }
        : row,
    );
    const snapshot = parseSharpApiClosingLines(
      closingPayload({ draftkings: closingBook({ odds }) }),
      eventId,
      retrievedAt,
    );

    expect(
      snapshot.books[0]?.prices.find(
        ({ marketKey, selectionKey }) =>
          marketKey === "spread" && selectionKey === "home",
      )?.fairCloseDecimal,
    ).toBe(2.5);
    expect(snapshot.rejections).toEqual([]);
  });

  it("retains nonfinal and valid sibling books while reason-coding malformed books", () => {
    const snapshot = parseSharpApiClosingLines(
      closingPayload({
        draftkings: closingBook({ is_final: false }),
        pinnacle: closingBook({
          odds: [
            closingOdd({ sportsbook: "pinnacle" }),
            closingOdd({
              sportsbook: "pinnacle",
              selection: "Athletics",
              selection_type: "away",
              selection_id: "pin-away",
              canonical_key: `${eventId}:moneyline:away`,
            }),
          ],
        }),
        mystery_book: closingBook(),
        fanduel: { capture_trigger: "transition", odds: [] },
      }),
      eventId,
      retrievedAt,
    );

    expect(snapshot.books.map(({ id, isFinal }) => [id, isFinal])).toEqual([
      ["draftkings", false],
      ["pinnacle", true],
    ]);
    expect(snapshot.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "unknown-bookmaker" }),
        expect.objectContaining({ reason: "malformed-book" }),
      ]),
    );
  });

  it("selects the most balanced coherent line when alternate lines are present", () => {
    const base = closingBook();
    const odds = (base.odds as Record<string, unknown>[]).concat([
      closingOdd({
        market_type: "total_runs",
        market_id: "total-alt",
        selection: "Over",
        selection_type: "over",
        line: 8.5,
        selection_id: "total-alt-over",
        canonical_key: `${eventId}:total_runs:over:8.5`,
      }),
      closingOdd({
        market_type: "total_runs",
        market_id: "total-alt",
        selection: "Under",
        selection_type: "under",
        line: 8.5,
        selection_id: "total-alt-under",
        canonical_key: `${eventId}:total_runs:under:8.5`,
      }),
    ]);
    const snapshot = parseSharpApiClosingLines(
      closingPayload({ draftkings: closingBook({ odds }) }),
      eventId,
      retrievedAt,
    );

    expect(
      snapshot.books[0]?.prices
        .filter(({ marketKey }) => marketKey === "total")
        .map(({ point }) => point),
    ).toEqual([7.5, 7.5]);
    expect(snapshot.books[0]?.prices).toHaveLength(6);
    expect(snapshot.rejections).not.toContainEqual(
      expect.objectContaining({ auditId: "total_runs" }),
    );
  });

  it.each([
    ["moneyline", "away", "moneyline"],
    ["run_line", "away", "spread"],
    ["total_runs", "over", "total"],
  ] as const)(
    "rejects %s selections paired across different native provider markets",
    (providerMarketType, selectionType, marketKey) => {
      const base = closingBook();
      const odds = (base.odds as Record<string, unknown>[]).map((row) =>
        row["selection_type"] === selectionType &&
        row["market_type"] === providerMarketType
          ? { ...row, market_id: `${providerMarketType}-other` }
          : row,
      );
      const snapshot = parseSharpApiClosingLines(
        closingPayload({ draftkings: closingBook({ odds }) }),
        eventId,
        retrievedAt,
      );

      expect(
        snapshot.books[0]?.prices.some(
          (price) => price.marketKey === marketKey,
        ),
      ).toBe(false);
      expect(snapshot.rejections).toContainEqual(
        expect.objectContaining({ reason: "incomplete-market" }),
      );
    },
  );

  it("rejects moneyline sides that reuse one provider selection identity", () => {
    const base = closingBook();
    const odds = (base.odds as Record<string, unknown>[]).map((row) =>
      row["market_type"] === "moneyline" && row["selection_type"] === "away"
        ? { ...row, selection_id: "ml-home" }
        : row,
    );
    const snapshot = parseSharpApiClosingLines(
      closingPayload({ draftkings: closingBook({ odds }) }),
      eventId,
      retrievedAt,
    );
    expect(
      snapshot.books[0]?.prices.some(
        ({ marketKey }) => marketKey === "moneyline",
      ),
    ).toBe(false);
  });

  it.each([
    ["run_line", "spread"],
    ["total_runs", "total"],
  ] as const)(
    "selects a stable %s native market when duplicate propositions reorder",
    (providerMarketType, marketKey) => {
      const base = closingBook();
      const original = base.odds as Record<string, unknown>[];
      const duplicate = original
        .filter(({ market_type }) => market_type === providerMarketType)
        .map((row) => ({
          ...row,
          market_id: `duplicate-${providerMarketType}`,
          selection_id: `duplicate-${String(row["selection_id"])}`,
        }));
      const parse = (odds: readonly Record<string, unknown>[]) =>
        parseSharpApiClosingLines(
          closingPayload({ draftkings: closingBook({ odds }) }),
          eventId,
          retrievedAt,
        )
          .books[0]?.prices.filter((price) => price.marketKey === marketKey)
          .map(({ providerMarketId, providerSelectionId }) => ({
            providerMarketId,
            providerSelectionId,
          }));
      const rows = [...original, ...duplicate];
      expect(parse(rows)).toEqual(parse([...rows].reverse()));
    },
  );

  it("rejects a canonical proposition key from another event", () => {
    const base = closingBook();
    const odds = (base.odds as Record<string, unknown>[]).map((row) =>
      row["selection_type"] === "away" && row["market_type"] === "moneyline"
        ? { ...row, canonical_key: "another-event:moneyline:away" }
        : row,
    );
    const snapshot = parseSharpApiClosingLines(
      closingPayload({ draftkings: closingBook({ odds }) }),
      eventId,
      retrievedAt,
    );
    expect(
      snapshot.books[0]?.prices.some(
        ({ marketKey }) => marketKey === "moneyline",
      ),
    ).toBe(false);
    expect(snapshot.rejections).toContainEqual(
      expect.objectContaining({ reason: "incomplete-market" }),
    );
  });

  it("accepts the documented empty response without fabricating event fields", () => {
    expect(
      parseSharpApiClosingLines(
        { success: true, data: { event_id: eventId, books: {} } },
        eventId,
        retrievedAt,
      ),
    ).toEqual({
      providerEventId: eventId,
      books: [],
      rejections: [],
      retrievedAt,
    });
  });

  it("requires the exact requested event identity and a valid nonempty event shape", () => {
    expect(() =>
      parseSharpApiClosingLines(closingPayload(), "wrong-event", retrievedAt),
    ).toThrow(expect.objectContaining({ stage: "closing-odds:identity" }));
    expect(() =>
      parseSharpApiClosingLines(
        {
          ...closingPayload(),
          data: { ...closingPayload().data, away_team: "Seattle Mariners" },
        },
        eventId,
        retrievedAt,
      ),
    ).toThrow(expect.objectContaining({ stage: "closing-odds:event-shape" }));
  });

  it("calls the documented endpoint with encoded provider ids and optional books", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          { success: true, data: { event_id: eventId, books: {} } },
          {
            headers: {
              "x-ratelimit-limit": "60",
              "x-ratelimit-remaining": "9",
            },
          },
        ),
      ),
    );
    const result = await fetchSharpApiClosingLines(
      eventId,
      "secret-key",
      ["draftkings", "pinnacle"],
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.sharpapi.io/api/v1/odds/closing?event_id=${eventId}&sportsbook=draftkings%2Cpinnacle`,
    );
    expect(result.responseMetadata?.rateWindow).toEqual({
      limit: 60,
      remaining: 9,
    });
  });

  it("records retrievedAt after the response completes", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-22T22:09:58.000Z"));
      const result = await fetchSharpApiClosingLines(
        eventId,
        "secret-key",
        [],
        () => {
          vi.setSystemTime(new Date("2026-04-22T22:10:10.000Z"));
          return Promise.resolve(Response.json(closingPayload()));
        },
      );
      expect(result.retrievedAt).toBe("2026-04-22T22:10:10.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      403,
      { error: { code: "tier_restricted", message: "paid prose" } },
      "not-entitled",
      false,
    ],
    [
      503,
      { error: { code: "not_ready", message: "paid prose" } },
      "provider-unavailable",
      true,
    ],
    [
      400,
      { error: { code: "validation_error", message: "paid prose" } },
      "provider-rejected",
      false,
    ],
  ])(
    "maps HTTP %i using status and bounded codes",
    async (status, body, code, retryable) => {
      const error = await fetchSharpApiClosingLines(
        eventId,
        "secret-key",
        [],
        () => Promise.resolve(Response.json(body, { status })),
      ).catch((caught: unknown) => caught);

      expect(error).toEqual(
        expect.objectContaining({
          code,
          retryable,
          providerCode: (body.error as { code: string }).code,
          stage: `closing-odds:http-${status}`,
        }),
      );
      expect(error).toBeInstanceOf(SharpApiError);
      expect(error).not.toHaveProperty("response");
    },
  );

  it("uses closing-scoped diagnostics for malformed successful bodies", async () => {
    await expect(
      fetchSharpApiClosingLines(eventId, "secret-key", [], () =>
        Promise.resolve(new Response("not-json")),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "invalid-response",
        stage: "closing-odds:json",
      }),
    );
  });
});
