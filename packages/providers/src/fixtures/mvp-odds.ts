import type { FixtureOddsObservation, SportKey } from "@find-the-edge/domain";

export interface FixtureOddsSeedEvent {
  readonly providerId: "fixture-development";
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: "mlb" | "mls";
  readonly prices: readonly Pick<
    FixtureOddsObservation,
    | "marketKey"
    | "selectionKey"
    | "selectionLabel"
    | "sportsbookId"
    | "sportsbookLabel"
    | "americanOdds"
    | "observedAt"
    | "retrievedAt"
  >[];
}

const price = (
  marketKey: string,
  selectionKey: string,
  selectionLabel: string,
  americanOdds: number,
  observedAt: string,
) => ({
  marketKey,
  selectionKey,
  selectionLabel,
  sportsbookId: "fixture-book",
  sportsbookLabel: "Fixture Book",
  americanOdds,
  observedAt,
  retrievedAt: observedAt,
});

export const mvpFixtureOdds: readonly FixtureOddsSeedEvent[] = [
  {
    providerId: "fixture-development",
    providerEventId: "mlb-1",
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    prices: [
      price(
        "moneyline",
        "away",
        "Boston Red Sox",
        120,
        "2026-08-01T12:00:00.000Z",
      ),
      price(
        "moneyline",
        "home",
        "New York Yankees",
        -135,
        "2026-08-01T12:00:00.000Z",
      ),
    ],
  },
  {
    providerId: "fixture-development",
    providerEventId: "mlb-2",
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    prices: [
      price(
        "moneyline",
        "away",
        "Chicago Cubs",
        -105,
        "2026-08-01T12:01:00.000Z",
      ),
      price(
        "moneyline",
        "home",
        "Detroit Tigers",
        -105,
        "2026-08-01T12:01:00.000Z",
      ),
    ],
  },
  {
    providerId: "fixture-development",
    providerEventId: "mls-1",
    sportKey: "soccer" as SportKey,
    leagueKey: "mls",
    prices: [
      price("moneyline", "away", "Miami", 145, "2026-08-01T12:02:00.000Z"),
      price("moneyline", "draw", "Draw", 220, "2026-08-01T12:02:00.000Z"),
      price("moneyline", "home", "Atlanta", 175, "2026-08-01T12:02:00.000Z"),
    ],
  },
] as const;
