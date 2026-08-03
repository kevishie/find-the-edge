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
          {
            key: "spreads",
            outcomes: [
              { name: "Boston Red Sox", price: -110, point: 1.5 },
              { name: "New York Yankees", price: -110, point: -1.5 },
            ],
          },
          {
            key: "totals",
            outcomes: [
              { name: "Over", price: -105, point: 8.5 },
              { name: "Under", price: -115, point: 8.5 },
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
        marketKey: "moneyline",
        selectionKey: "home",
        selectionLabel: "New York Yankees",
        americanOdds: -135,
      },
      {
        marketKey: "moneyline",
        selectionKey: "away",
        selectionLabel: "Boston Red Sox",
        americanOdds: 120,
      },
      {
        marketKey: "spread",
        selectionKey: "away",
        selectionLabel: "Boston Red Sox",
        point: 1.5,
        americanOdds: -110,
      },
      {
        marketKey: "spread",
        selectionKey: "home",
        selectionLabel: "New York Yankees",
        point: -1.5,
        americanOdds: -110,
      },
      {
        marketKey: "total",
        selectionKey: "over",
        selectionLabel: "Over",
        point: 8.5,
        americanOdds: -105,
      },
      {
        marketKey: "total",
        selectionKey: "under",
        selectionLabel: "Under",
        point: 8.5,
        americanOdds: -115,
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

  it("drops malformed optional markets while preserving valid moneylines", () => {
    const malformed = structuredClone(payload);
    malformed[0]!.bookmakers[0]!.markets[1]!.outcomes.pop();
    const totalOutcome = malformed[0]!.bookmakers[0]!.markets[2]!
      .outcomes[0] as {
      point?: number;
    };
    totalOutcome.point = -8.5;
    expect(
      parseTheOddsApiEvents(malformed, mlb)[0]?.bookmakers[0]?.prices,
    ).toEqual(
      payload[0]!.bookmakers[0]!.markets[0]!.outcomes.map((outcome) => ({
        marketKey: "moneyline",
        selectionKey: outcome.name === "Boston Red Sox" ? "away" : "home",
        selectionLabel: outcome.name,
        americanOdds: outcome.price,
      })),
    );
  });

  it("rejects moneyline prices that downstream storage cannot accept", () => {
    const invalid = structuredClone(payload);
    invalid[0]!.bookmakers[0]!.markets[0]!.outcomes[0]!.price = -99;
    expect(() => parseTheOddsApiEvents(invalid, mlb)).toThrow(TheOddsApiError);
  });
});
