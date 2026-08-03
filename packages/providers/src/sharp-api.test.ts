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
});
