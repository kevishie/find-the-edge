import { describe, expect, it } from "vitest";
import type { SportKey } from "@find-the-edge/domain";
import {
  parseSharpApiSplitPage,
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
