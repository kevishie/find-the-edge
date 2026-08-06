import { describe, expect, it } from "vitest";

import {
  americanToDecimal,
  calculateFairValue,
  calculateWeightedConsensus,
  decimalToAmerican,
  evaluateEdge,
  expectedProfit,
  expectedValue,
  fairOdds,
  fractionalKelly,
  impliedProbability,
  kellyFraction,
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

  it.each([
    [0.48, 2.083_333_333_333_333_5, 108.333_333_333_333_34],
    [0.5, 2, 100],
    [0.65, 1.538_461_538_461_538_3, -185.714_285_714_285_67],
  ])(
    "calculates fair decimal and American prices for probability %s",
    (probability, decimalOdds, americanOdds) => {
      const result = fairOdds(probability);
      expect(result.decimalOdds).toBeCloseTo(decimalOdds, 12);
      expect(result.americanOdds).toBeCloseTo(americanOdds, 12);
      expect(impliedProbability(result.americanOdds)).toBeCloseTo(
        probability,
        12,
      );
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it("calculates expected profit and raw and fractional Kelly", () => {
    expect(expectedProfit(100, 0.48, 120)).toBeCloseTo(5.6, 12);
    expect(kellyFraction(0.48, 120)).toBeCloseTo(0.046_666_666_666_666_67, 12);
    expect(fractionalKelly(0.48, 120, 0.25)).toBeCloseTo(
      0.011_666_666_666_666_667,
      12,
    );
  });

  it("keeps negative raw Kelly truthful but never returns a negative fractional stake", () => {
    expect(expectedValue(0.5, -110)).toBeCloseTo(-0.045_454_545_454_545_414);
    expect(expectedProfit(100, 0.5, -110)).toBeCloseTo(-4.545_454_545_454_541);
    expect(kellyFraction(0.5, -110)).toBeCloseTo(-0.05);
    expect(fractionalKelly(0.5, -110, 0.25)).toBe(0);
  });

  it("preserves zero-edge and zero-stake boundaries", () => {
    expect(expectedValue(0.4, 150)).toBe(0);
    expect(expectedProfit(0, 0.4, 150)).toBe(0);
    expect(kellyFraction(0.4, 150)).toBe(0);
    expect(fractionalKelly(0.4, 150, 1)).toBe(0);
  });

  it("rejects invalid strict-helper inputs", () => {
    expect(() => fairOdds(0)).toThrow(RangeError);
    expect(() => fairOdds(1)).toThrow(RangeError);
    expect(() => fairOdds(Number.NaN)).toThrow(RangeError);
    expect(() => expectedProfit(-1, 0.5, 100)).toThrow(RangeError);
    expect(() => expectedProfit(Number.POSITIVE_INFINITY, 0.5, 100)).toThrow(
      RangeError,
    );
    expect(() => kellyFraction(0.5, -Number.MAX_VALUE)).toThrow(RangeError);
    expect(() => fractionalKelly(0.5, 100, 0)).toThrow(RangeError);
    expect(() => fractionalKelly(0.5, 100, 1.01)).toThrow(RangeError);
    expect(() => expectedProfit(Number.MIN_VALUE, 0.48, 120)).toThrow(
      "collapsed below numeric precision",
    );
    expect(() => fractionalKelly(0.48, 120, Number.MIN_VALUE)).toThrow(
      "collapsed below numeric precision",
    );
  });
});

describe("fair-value result", () => {
  it("returns the positive-EV golden result with immutable raw and display values", () => {
    const input = {
      fairProbability: 0.48,
      offeredAmerican: 120,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
    } as const;
    const result = calculateFairValue(input);

    expect(result).toMatchObject({
      calculationVersion: "fair-value-v1",
      displayVersion: "fair-value-display-v1",
      status: "available",
      issues: [],
      inputs: input,
      labels: {
        expectedProfit: "Expected profit, not guaranteed profit",
        kelly: "Informational only",
      },
      display: {
        fairDecimalOdds: 2.083,
        fairAmericanOdds: 108,
        expectedValuePercent: 5.6,
        expectedProfit: 5.6,
        rawKellyPercent: 4.67,
        informationalKellyPercent: 4.67,
        fractionalKellyPercent: 1.17,
      },
    });
    if (result.status !== "available") throw new Error("expected available");
    expect(result.values.expectedValue).toBeCloseTo(0.056, 12);
    expect(result.values.expectedProfit).toBeCloseTo(5.6, 12);
    expect(result.values.rawKellyFraction).toBeCloseTo(
      0.046_666_666_666_666_67,
      12,
    );
    expect(result.values.fractionalKellyFraction).toBeCloseTo(
      0.011_666_666_666_666_667,
      12,
    );
    expect(result.values.expectedValue).not.toBe(
      result.display.expectedValuePercent,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
    expect(Object.isFrozen(result.display)).toBe(true);
    expect(Object.isFrozen(result.labels)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
  });

  it.each([
    [
      "favorite positive EV",
      { fairProbability: 0.65, offeredAmerican: -150, stake: 100 },
      0.083_333_333_333_333_26,
      0.125,
    ],
    [
      "even break-even",
      { fairProbability: 0.5, offeredAmerican: 100, stake: 100 },
      0,
      0,
    ],
    [
      "underdog break-even",
      { fairProbability: 0.4, offeredAmerican: 150, stake: 0 },
      0,
      0,
    ],
  ])("supports %s", (_, fixture, ev, rawKelly) => {
    const result = calculateFairValue({
      ...fixture,
      fractionalKellyMultiplier: 0.25,
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.values.expectedValue).toBeCloseTo(ev, 12);
    expect(result.values.rawKellyFraction).toBeCloseTo(rawKelly, 12);
    if (fixture.stake === 0) expect(result.values.expectedProfit).toBe(0);
  });

  it("exposes negative EV and raw Kelly while clamping informational Kelly", () => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: -110,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected available");
    expect(result.values.expectedValue).toBeLessThan(0);
    expect(result.values.expectedProfit).toBeLessThan(0);
    expect(result.values.rawKellyFraction).toBeCloseTo(-0.05, 12);
    expect(result.values.informationalKellyFraction).toBe(0);
    expect(result.values.fractionalKellyFraction).toBe(0);
    expect(result.display.informationalKellyPercent).toBe(0);
    expect(result.display.fractionalKellyPercent).toBe(0);
  });

  it("returns every invalid scalar as a stable typed issue without partial values", () => {
    const result = calculateFairValue({
      fairProbability: Number.NaN,
      offeredAmerican: 99,
      stake: -1,
      fractionalKellyMultiplier: 0,
    });
    expect(result).toMatchObject({
      status: "invalid",
      issues: [
        "invalid-fair-probability",
        "invalid-offered-odds",
        "invalid-stake",
        "invalid-fractional-kelly-multiplier",
      ],
      values: null,
      display: null,
    });
    expect(Object.isFrozen(result.inputs)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
  });

  it.each([
    { fairProbability: 0 },
    { fairProbability: 1 },
    { fairProbability: Number.NEGATIVE_INFINITY },
    { offeredAmerican: 0 },
    { offeredAmerican: -99 },
    { offeredAmerican: Number.POSITIVE_INFINITY },
    { stake: Number.NaN },
    { stake: Number.POSITIVE_INFINITY },
    { fractionalKellyMultiplier: Number.NaN },
    { fractionalKellyMultiplier: 1.01 },
  ])("rejects the invalid boundary $0", (change) => {
    const result = calculateFairValue({
      fairProbability: 0.48,
      offeredAmerican: 120,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
      ...change,
    });
    expect(result.status).toBe("invalid");
    expect(result.values).toBeNull();
    expect(result.display).toBeNull();
  });

  it("fails closed when finite inputs collapse or overflow numeric precision", () => {
    const collapsed = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: -Number.MAX_VALUE,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
    });
    expect(collapsed).toMatchObject({
      status: "invalid",
      issues: ["numeric-overflow"],
      values: null,
      display: null,
    });

    const overflowed = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: Number.MAX_VALUE,
      stake: Number.MAX_VALUE,
      fractionalKellyMultiplier: 0.25,
    });
    expect(overflowed).toMatchObject({
      status: "invalid",
      issues: ["numeric-overflow"],
      values: null,
      display: null,
    });

    const profitUnderflow = calculateFairValue({
      fairProbability: 0.48,
      offeredAmerican: 120,
      stake: Number.MIN_VALUE,
      fractionalKellyMultiplier: 0.25,
    });
    expect(profitUnderflow).toMatchObject({
      status: "invalid",
      issues: ["numeric-overflow"],
      values: null,
      display: null,
    });

    const kellyUnderflow = calculateFairValue({
      fairProbability: 0.48,
      offeredAmerican: 120,
      stake: 100,
      fractionalKellyMultiplier: Number.MIN_VALUE,
    });
    expect(kellyUnderflow).toMatchObject({
      status: "invalid",
      issues: ["numeric-overflow"],
      values: null,
      display: null,
    });

    const evCancellation = calculateFairValue({
      fairProbability: 0.490_196_078_431_372_6,
      offeredAmerican: 104,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
    });
    expect(evCancellation).toMatchObject({
      status: "invalid",
      issues: ["numeric-overflow"],
      values: null,
      display: null,
    });

    const exactBreakEven = calculateFairValue({
      fairProbability: 100 / 207,
      offeredAmerican: 107,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
    });
    expect(exactBreakEven.status).toBe("available");
    if (exactBreakEven.status !== "available")
      throw new Error("expected available");
    expect(exactBreakEven.values.expectedValue).toBe(0);

    const helperBreakEven = calculateFairValue({
      fairProbability: impliedProbability(107),
      offeredAmerican: 107,
      stake: 100,
      fractionalKellyMultiplier: 0.25,
    });
    expect(helperBreakEven.status).toBe("available");
    if (helperBreakEven.status !== "available")
      throw new Error("expected available");
    expect(helperBreakEven.values.expectedValue).toBe(0);
  });

  it("rounds display half-boundaries away from zero and normalizes negative zero", () => {
    const positive = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 100,
      stake: 1.125,
      fractionalKellyMultiplier: 0.25,
    });
    const negative = calculateFairValue({
      fairProbability: 0.25,
      offeredAmerican: 100,
      stake: 2.25,
      fractionalKellyMultiplier: 0.25,
    });
    expect(positive.status).toBe("available");
    expect(negative.status).toBe("available");
    if (positive.status !== "available" || negative.status !== "available")
      throw new Error("expected available");
    expect(positive.display.expectedProfit).toBe(0);
    expect(Object.is(positive.display.expectedProfit, -0)).toBe(false);
    expect(negative.values.expectedProfit).toBeCloseTo(-1.125, 12);
    expect(negative.display.expectedProfit).toBe(-1.13);

    const positiveHalf = calculateFairValue({
      fairProbability: 0.75,
      offeredAmerican: 100,
      stake: 2.25,
      fractionalKellyMultiplier: 0.25,
    });
    const positiveBelowHalf = calculateFairValue({
      fairProbability: 0.75,
      offeredAmerican: 100,
      stake: 2.249_999_999_999_999_6,
      fractionalKellyMultiplier: 0.25,
    });
    const canonicalDecimalHalf = calculateFairValue({
      fairProbability: 0.75,
      offeredAmerican: 100,
      stake: 2.01,
      fractionalKellyMultiplier: 0.25,
    });
    expect(positiveHalf.status).toBe("available");
    expect(positiveBelowHalf.status).toBe("available");
    expect(canonicalDecimalHalf.status).toBe("available");
    if (
      positiveHalf.status !== "available" ||
      positiveBelowHalf.status !== "available" ||
      canonicalDecimalHalf.status !== "available"
    )
      throw new Error("expected available");
    expect(positiveHalf.display.expectedProfit).toBe(1.13);
    expect(positiveBelowHalf.values.expectedProfit).toBeLessThan(1.125);
    expect(positiveBelowHalf.display.expectedProfit).toBe(1.12);
    expect(canonicalDecimalHalf.values.expectedProfit).toBe(1.005);
    expect(canonicalDecimalHalf.display.expectedProfit).toBe(1.01);
  });

  it("keeps large finite raw and display values available without rounding drift", () => {
    const integral = calculateFairValue({
      fairProbability: 0.75,
      offeredAmerican: 100,
      stake: 2e15,
      fractionalKellyMultiplier: 0.25,
    });
    const huge = calculateFairValue({
      fairProbability: 0.75,
      offeredAmerican: 100,
      stake: 1e307,
      fractionalKellyMultiplier: 0.25,
    });
    expect(integral.status).toBe("available");
    expect(huge.status).toBe("available");
    if (integral.status !== "available" || huge.status !== "available")
      throw new Error("expected available");
    expect(integral.display.expectedProfit).toBe(1e15);
    expect(huge.values.expectedProfit).toBe(5e306);
    expect(huge.display.expectedProfit).toBe(5e306);
  });

  it("preserves algebraic invariants across representative inputs", () => {
    for (const [fairProbability, offeredAmerican] of [
      [0.2, 500],
      [0.48, 120],
      [0.5, 100],
      [0.65, -150],
      [0.9, -500],
    ] as const) {
      const result = calculateFairValue({
        fairProbability,
        offeredAmerican,
        stake: 73.21,
        fractionalKellyMultiplier: 0.25,
      });
      expect(result.status).toBe("available");
      if (result.status !== "available") throw new Error("expected available");
      expect(1 / result.values.fairDecimalOdds).toBeCloseTo(
        fairProbability,
        12,
      );
      expect(result.values.expectedValue).toBeCloseTo(
        fairProbability * result.values.offeredDecimalOdds - 1,
        12,
      );
      expect(result.values.expectedProfit).toBeCloseTo(
        73.21 * result.values.expectedValue,
        12,
      );
      expect(result.values.rawKellyFraction).toBeCloseTo(
        result.values.expectedValue / (result.values.offeredDecimalOdds - 1),
        12,
      );
      expect(result.values.fractionalKellyFraction).toBeLessThanOrEqual(
        result.values.informationalKellyFraction,
      );
    }
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
