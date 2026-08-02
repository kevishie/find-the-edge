import { describe, expect, it } from "vitest";
import {
  parseTheOddsApiEvents,
  TheOddsApiError,
  theOddsApiLeagues,
} from "./the-odds-api";

const mlb = theOddsApiLeagues[0]!;
const payload = [
  {
    id: "provider-event-1",
    away_team: "Boston Red Sox",
    home_team: "New York Yankees",
    commence_time: "2026-08-02T23:05:00.000Z",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        last_update: "2026-08-02T20:00:00.000Z",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "New York Yankees", price: -135 },
              { name: "Boston Red Sox", price: 120 },
            ],
          },
        ],
      },
    ],
  },
];

describe("The Odds API V4 normalization", () => {
  it("maps participants by name rather than response order", () => {
    const [event] = parseTheOddsApiEvents(payload, mlb);
    expect(event).toMatchObject({
      providerEventId: "provider-event-1",
      awayTeam: "Boston Red Sox",
      homeTeam: "New York Yankees",
    });
    expect(event?.bookmakers[0]?.prices).toEqual([
      {
        selectionKey: "home",
        selectionLabel: "New York Yankees",
        americanOdds: -135,
      },
      {
        selectionKey: "away",
        selectionLabel: "Boston Red Sox",
        americanOdds: 120,
      },
    ]);
  });

  it("rejects partial or duplicated moneyline markets", () => {
    const partial = structuredClone(payload);
    partial[0]!.bookmakers[0]!.markets[0]!.outcomes.pop();
    expect(() => parseTheOddsApiEvents(partial, mlb)).toThrow(TheOddsApiError);
    const duplicate = structuredClone(payload);
    duplicate[0]!.bookmakers[0]!.markets[0]!.outcomes[1] = {
      name: "New York Yankees",
      price: 120,
    };
    expect(() => parseTheOddsApiEvents(duplicate, mlb)).toThrow(
      TheOddsApiError,
    );
  });
});
