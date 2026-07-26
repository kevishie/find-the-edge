import { describe, expect, it } from "vitest";

import {
  americanToDecimal,
  decimalToAmerican,
  evaluateEdge,
  expectedValue,
  impliedProbability,
  removeVig,
} from "./index";

describe("odds conversion", () => {
  it.each([
    [150, 2.5, 150],
    [-200, 1.5, -200],
    [100, 2, 100],
    [-100, 2, 100],
  ])(
    "converts %s American odds to decimal",
    (american, decimal, canonicalAmerican) => {
      expect(americanToDecimal(american)).toBeCloseTo(decimal);
      expect(decimalToAmerican(decimal)).toBeCloseTo(canonicalAmerican);
    },
  );

  it("rejects invalid American odds", () => {
    expect(() => americanToDecimal(0)).toThrow(RangeError);
    expect(() => americanToDecimal(99)).toThrow(RangeError);
  });

  it("calculates implied probability", () => {
    expect(impliedProbability(-150)).toBeCloseTo(0.6);
    expect(impliedProbability(150)).toBeCloseTo(0.4);
  });
});

describe("fair price and EV", () => {
  it("removes vig from a two-way market", () => {
    expect(removeVig([-110, -110])).toEqual([0.5, 0.5]);
  });

  it("removes vig from a three-way market", () => {
    const probabilities = removeVig([140, 230, 240]);
    expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("calculates expected value", () => {
    expect(expectedValue(0.48, 120)).toBeCloseTo(0.056);
  });
});

describe("qualification", () => {
  const base = {
    offeredAmerican: 120,
    fairProbability: 0.48,
    marketKey: "moneyline",
    approvedMarketKeys: ["moneyline"],
    comparisonBooks: 5,
    priceAgeMinutes: 4,
    lineupConfirmed: true,
    minutesToStart: 40,
  };

  it("qualifies a fresh, supported positive-EV play", () => {
    expect(evaluateEdge(base)).toMatchObject({
      decision: "play",
      reasons: ["positive-ev"],
    });
  });

  it("returns no bet with auditable reasons", () => {
    expect(
      evaluateEdge({
        ...base,
        fairProbability: 0.44,
        comparisonBooks: 2,
        priceAgeMinutes: 20,
        lineupConfirmed: false,
        publicTicketPercent: 84,
      }),
    ).toMatchObject({
      decision: "no-bet",
      reasons: [
        "ev-below-threshold",
        "insufficient-books",
        "stale-price",
        "lineup-unconfirmed",
        "public-fade",
      ],
    });
  });
});
