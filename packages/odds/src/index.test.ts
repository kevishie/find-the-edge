import { describe, expect, it } from "vitest";

import {
  americanToDecimal,
  calculateWeightedConsensus,
  decimalToAmerican,
  evaluateEdge,
  expectedValue,
  impliedProbability,
  probabilityToAmerican,
  removeVig,
  type ConsensusPolicy,
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
    expect(() => americanToDecimal(-99)).toThrow(RangeError);
    expect(() => americanToDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => americanToDecimal(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it("rejects invalid decimal odds", () => {
    expect(() => decimalToAmerican(1)).toThrow(RangeError);
    expect(() => decimalToAmerican(0)).toThrow(RangeError);
    expect(() => decimalToAmerican(Number.NaN)).toThrow(RangeError);
    expect(() => decimalToAmerican(Number.NEGATIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it("calculates implied probability", () => {
    expect(impliedProbability(-150)).toBeCloseTo(0.6);
    expect(impliedProbability(150)).toBeCloseTo(0.4);
    expect(impliedProbability(100)).toBeCloseTo(0.5);
    expect(impliedProbability(-100)).toBeCloseTo(0.5);
  });

  it.each([-100_000, -5000, -250, -110, -100, 100, 110, 250, 5000, 100_000])(
    "round-trips boundary and representative American odds %s",
    (american) => {
      const roundTrip = decimalToAmerican(americanToDecimal(american));
      const canonicalAmerican = american === -100 ? 100 : american;
      expect(
        Math.abs(roundTrip - canonicalAmerican) / Math.abs(canonicalAmerican),
      ).toBeLessThan(1e-12);
    },
  );

  it.each([0.000_001, 0.01, 0.25, 0.5, 0.75, 0.99, 0.999_999])(
    "round-trips representative probability %s",
    (probability) => {
      expect(
        impliedProbability(probabilityToAmerican(probability)),
      ).toBeCloseTo(probability, 10);
    },
  );

  it("rejects impossible probabilities", () => {
    expect(() => probabilityToAmerican(0)).toThrow(RangeError);
    expect(() => probabilityToAmerican(1)).toThrow(RangeError);
    expect(() => probabilityToAmerican(-0.1)).toThrow(RangeError);
    expect(() => probabilityToAmerican(1.1)).toThrow(RangeError);
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
  const twoWayPolicy = {
    comparisonWeights: { a: 2, b: 1, c: 1, target: 10 },
    minimumBooks: 3,
    maximumAgeMinutes: 15,
    outlierThreshold: 0.08,
  } as const;
  const book = (
    sportsbookId: string,
    odds: readonly number[],
    overrides: Partial<{
      ageMinutes: number;
      status: "active" | "suspended" | "closed" | "unavailable";
    }> = {},
  ) => ({
    sportsbookId,
    ageMinutes: overrides.ageMinutes ?? 1,
    status: overrides.status ?? ("active" as const),
    selections: odds.map((americanOdds, index) => ({
      selectionKey: index === 0 ? "away" : index === 1 ? "home" : "draw",
      americanOdds,
    })),
  });
  const baseBooks = [
    book("target", [180, -220]),
    book("a", [-110, -110]),
    book("b", [-120, 100]),
    book("c", [-115, -105]),
  ];

  it("matches the golden two-way formula and excludes Hard Rock case-insensitively", () => {
    const result = calculateWeightedConsensus({
      books: [
        { ...baseBooks[0]!, sportsbookId: "HARDROCK" },
        ...baseBooks.slice(1),
      ],
      targetSportsbookId: "hardrock",
      selectionKeys: ["away", "home"],
      policy: twoWayPolicy,
    });

    expect(result.status).toBe("available");
    expect(result.includedSportsbookIds).toEqual(["a", "b", "c"]);
    expect(result.exclusions).toContainEqual({
      sportsbookId: "hardrock",
      reason: "target-sportsbook",
    });
    expect(result.probabilities?.[0]).toBeCloseTo(0.508_143_341_7, 8);
    expect(result.probabilities?.[1]).toBeCloseTo(0.491_856_658_3, 8);
    expect(result.probabilities?.reduce((sum, value) => sum + value, 0)).toBe(
      1,
    );
  });

  it("supports a selection-aligned weighted three-way consensus", () => {
    const result = calculateWeightedConsensus({
      targetSportsbookId: "target",
      selectionKeys: ["home", "draw", "away"],
      policy: twoWayPolicy,
      books: [
        book("a", [140, 230, 240]),
        book("b", [150, 220, 235]),
        book("c", [145, 225, 245]),
      ].map((entry) => ({
        ...entry,
        selections: [...entry.selections].reverse(),
      })),
    });

    expect(result.status).toBe("available");
    expect(result.probabilities).toEqual([
      expect.closeTo(0.303_211_245_155_705_74, 12),
      expect.closeTo(0.290_921_604_906_368_87, 12),
      expect.closeTo(0.405_867_149_937_925_4, 12),
    ]);
    expect(result.probabilities?.reduce((sum, value) => sum + value, 0)).toBe(
      1,
    );
  });

  it("excludes every ordinary bad observation with one explicit reason", () => {
    const result = calculateWeightedConsensus({
      targetSportsbookId: "target",
      selectionKeys: ["away", "home"],
      policy: {
        ...twoWayPolicy,
        comparisonWeights: {
          ...twoWayPolicy.comparisonWeights,
          stale: 1,
          suspended: 1,
          missing: 1,
          invalid: 1,
          "invalid-age": 1,
          duplicate: 1,
          closed: 1,
          unavailable: 1,
          zero: 0,
          boundary: 1,
          "invalid-status": 1,
        },
      },
      books: [
        ...baseBooks.slice(1),
        book("stale", [-110, -110], { ageMinutes: 16 }),
        book("suspended", [-110, -110], { status: "suspended" }),
        {
          ...book("missing", [-110]),
          selections: [{ selectionKey: "away", americanOdds: -110 }],
        },
        book("invalid", [-50, -110]),
        book("invalid-age", [-110, -110], { ageMinutes: Number.NaN }),
        {
          ...book("duplicate", [-110, -110]),
          selections: [
            { selectionKey: "away", americanOdds: -110 },
            { selectionKey: "away", americanOdds: -105 },
          ],
        },
        book("closed", [-110, -110], { status: "closed" }),
        book("unavailable", [-110, -110], { status: "unavailable" }),
        book("zero", [-110, -110]),
        book("unknown", [-110, -110]),
        book("boundary", [-110, -110], { ageMinutes: 15 }),
        book("invalid-status", [-110, -110], {
          status: "settled" as never,
        }),
      ],
    });

    expect(result.status).toBe("available");
    expect(result.includedSportsbookIds).toContain("boundary");
    expect(result.exclusions).toEqual([
      { sportsbookId: "closed", reason: "closed" },
      { sportsbookId: "duplicate", reason: "duplicate-selection" },
      { sportsbookId: "invalid", reason: "invalid-odds" },
      { sportsbookId: "invalid-age", reason: "invalid-age" },
      { sportsbookId: "invalid-status", reason: "invalid-status" },
      { sportsbookId: "missing", reason: "missing-selection" },
      { sportsbookId: "stale", reason: "stale" },
      { sportsbookId: "suspended", reason: "suspended" },
      { sportsbookId: "unavailable", reason: "unavailable" },
      { sportsbookId: "unknown", reason: "unconfigured" },
      { sportsbookId: "zero", reason: "zero-weight" },
    ]);
  });

  it("excludes any-outcome outliers, keeps the exact boundary, and fails closed when sparse", () => {
    const boundaryOdds = [-108.33333333333333, 108.33333333333333] as const;
    const boundaryThreshold = removeVig(boundaryOdds)[0]! - 0.5;
    const common = {
      targetSportsbookId: "target",
      selectionKeys: ["away", "home"],
      policy: {
        comparisonWeights: { a: 1, b: 1, c: 1 },
        minimumBooks: 3,
        maximumAgeMinutes: 15,
        outlierThreshold: boundaryThreshold,
      },
    } as const;
    const boundary = calculateWeightedConsensus({
      ...common,
      books: [
        book("a", [100, 100]),
        book("b", [100, 100]),
        book("c", boundaryOdds),
      ],
    });
    expect(boundary.status).toBe("available");

    const sparse = calculateWeightedConsensus({
      ...common,
      books: [
        book("a", [100, 100]),
        book("b", [100, 100]),
        book("c", [-900, 500]),
      ],
    });
    expect(sparse).toMatchObject({
      status: "unavailable",
      probabilities: null,
      requiredBookCount: 3,
      eligibleBookCount: 2,
      issues: ["insufficient-books", "outlier"],
    });
  });

  it("returns typed invalid results for malformed markets and duplicate books", () => {
    const invalidMarket = calculateWeightedConsensus({
      books: baseBooks,
      targetSportsbookId: "target",
      selectionKeys: ["home", "home"],
      policy: twoWayPolicy,
    });
    expect(invalidMarket).toMatchObject({
      status: "invalid",
      probabilities: null,
      issues: ["invalid-market"],
    });

    const duplicateBooks = calculateWeightedConsensus({
      books: [book("A", [-110, -110]), book("a", [-105, -115])],
      targetSportsbookId: "target",
      selectionKeys: ["away", "home"],
      policy: twoWayPolicy,
    });
    expect(duplicateBooks).toMatchObject({
      status: "invalid",
      probabilities: null,
      issues: ["duplicate-sportsbook"],
      exclusions: [
        { sportsbookId: "a", reason: "duplicate-sportsbook" },
        { sportsbookId: "a", reason: "duplicate-sportsbook" },
      ],
    });

    const whitespaceSelection = calculateWeightedConsensus({
      books: baseBooks,
      targetSportsbookId: "target",
      selectionKeys: ["home", " "],
      policy: twoWayPolicy,
    });
    expect(whitespaceSelection).toMatchObject({
      status: "invalid",
      probabilities: null,
      issues: ["invalid-market"],
    });
  });

  it("is deterministic across input permutations and does not mutate inputs", () => {
    const books = baseBooks.slice(1).map((entry) => ({
      ...entry,
      selections: [...entry.selections].reverse(),
    }));
    const before = structuredClone(books);
    const left = calculateWeightedConsensus({
      books,
      targetSportsbookId: "target",
      selectionKeys: ["away", "home"],
      policy: twoWayPolicy,
    });
    const right = calculateWeightedConsensus({
      books: [...books].reverse(),
      targetSportsbookId: "target",
      selectionKeys: ["away", "home"],
      policy: twoWayPolicy,
    });
    expect(right).toEqual(left);
    expect(books).toEqual(before);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.probabilities)).toBe(true);
    expect(Object.isFrozen(left.contributions[0]?.probabilities)).toBe(true);
  });

  it("throws deterministic programmer errors for malformed policy", () => {
    const run = (policy: ConsensusPolicy) =>
      calculateWeightedConsensus({
        books: baseBooks,
        targetSportsbookId: "target",
        selectionKeys: ["away", "home"],
        policy,
      });
    expect(() => run({ ...twoWayPolicy, minimumBooks: 0 })).toThrow(RangeError);
    expect(() =>
      run({ ...twoWayPolicy, maximumAgeMinutes: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => run({ ...twoWayPolicy, outlierThreshold: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      run({
        ...twoWayPolicy,
        comparisonWeights: [] as unknown as Readonly<Record<string, number>>,
      }),
    ).toThrow("Consensus comparison weights must be a record");
    expect(() =>
      run({
        ...twoWayPolicy,
        comparisonWeights: { a: 1 },
      }),
    ).toThrow("cannot satisfy its minimum comparison books");
    expect(() =>
      calculateWeightedConsensus({
        books: baseBooks,
        targetSportsbookId: " ",
        selectionKeys: ["away", "home"],
        policy: twoWayPolicy,
      }),
    ).toThrow("target sportsbook is required");
  });

  it("normalizes extreme finite weights before aggregation", () => {
    const result = calculateWeightedConsensus({
      targetSportsbookId: "hardrock",
      selectionKeys: ["away", "home"],
      policy: {
        comparisonWeights: {
          a: Number.MAX_VALUE,
          b: Number.MAX_VALUE,
          c: Number.MAX_VALUE,
        },
        minimumBooks: 3,
        maximumAgeMinutes: 15,
        outlierThreshold: 0.08,
      },
      books: [
        book("a", [-110, -110]),
        book("b", [-120, 100]),
        book("c", [-115, -105]),
      ],
    });

    expect(result.status).toBe("available");
    expect(result.probabilities?.every(Number.isFinite)).toBe(true);
    expect(result.probabilities?.reduce((sum, value) => sum + value, 0)).toBe(
      1,
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
