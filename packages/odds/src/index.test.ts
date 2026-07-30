import { describe, expect, it } from "vitest";

import {
  americanToDecimal,
  calculateWeightedConsensus,
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

describe("weighted consensus", () => {
  const twoWayBooks = [
    {
      sportsbookId: "offered",
      americanOdds: [180, -220],
      weight: 10,
      ageMinutes: 1,
      status: "active" as const,
    },
    {
      sportsbookId: "a",
      americanOdds: [-110, -110],
      weight: 2,
      ageMinutes: 2,
      status: "active" as const,
    },
    {
      sportsbookId: "b",
      americanOdds: [-120, 100],
      weight: 1,
      ageMinutes: 3,
      status: "active" as const,
    },
    {
      sportsbookId: "c",
      americanOdds: [-115, -105],
      weight: 1,
      ageMinutes: 4,
      status: "active" as const,
    },
  ];

  it("weights two-way no-vig prices and excludes the offered sportsbook", () => {
    const result = calculateWeightedConsensus({
      books: twoWayBooks,
      offeredSportsbookId: "offered",
      outcomeCount: 2,
    });

    expect(result.status).toBe("available");
    expect(result.includedSportsbookIds).toEqual(["a", "b", "c"]);
    expect(result.exclusions).toContainEqual({
      sportsbookId: "offered",
      reason: "offered-sportsbook",
    });
    expect(
      result.probabilities?.reduce((sum, value) => sum + value, 0),
    ).toBeCloseTo(1);
  });

  it("supports weighted three-way no-vig consensus", () => {
    const result = calculateWeightedConsensus({
      offeredSportsbookId: "target",
      outcomeCount: 3,
      books: [
        ["a", [140, 230, 240], 2],
        ["b", [150, 220, 235], 1],
        ["c", [145, 225, 245], 1],
      ].map(([sportsbookId, americanOdds, weight]) => ({
        sportsbookId: sportsbookId as string,
        americanOdds: americanOdds as number[],
        weight: weight as number,
        ageMinutes: 3,
        status: "active",
      })),
    });

    expect(result.status).toBe("available");
    expect(result.probabilities).toHaveLength(3);
    expect(
      result.probabilities?.reduce((sum, value) => sum + value, 0),
    ).toBeCloseTo(1);
  });

  it("returns explicit stale, suspended, sparse, and outlier states", () => {
    const result = calculateWeightedConsensus({
      offeredSportsbookId: "target",
      outcomeCount: 2,
      books: [
        ...twoWayBooks.slice(1, 3),
        {
          sportsbookId: "stale",
          americanOdds: [-110, -110],
          weight: 1,
          ageMinutes: 30,
          status: "active",
        },
        {
          sportsbookId: "suspended",
          americanOdds: [-110, -110],
          weight: 1,
          ageMinutes: 1,
          status: "suspended",
        },
        {
          sportsbookId: "outlier",
          americanOdds: [-900, 500],
          weight: 1,
          ageMinutes: 1,
          status: "active",
        },
      ],
    });

    expect(result.status).toBe("unavailable");
    expect(result.issues).toEqual(
      expect.arrayContaining(["stale", "suspended", "sparse", "outlier"]),
    );
    expect(result.exclusions.map(({ reason }) => reason)).toEqual(
      expect.arrayContaining(["stale", "suspended", "outlier"]),
    );
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
