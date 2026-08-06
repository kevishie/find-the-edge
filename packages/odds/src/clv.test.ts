import { describe, expect, it } from "vitest";

import {
  calculateClosingConsensusClv,
  closingLineValue,
  type ClosingConsensusClvInput,
} from "./clv";
import type { ConsensusBookInput } from "./index";

const book = (
  sportsbookId: string,
  americanOdds: readonly [number, number],
): ConsensusBookInput => ({
  sportsbookId,
  ageMinutes: 0,
  status: "active",
  selections: [
    { selectionKey: "away", americanOdds: americanOdds[0] },
    { selectionKey: "home", americanOdds: americanOdds[1] },
  ],
});

const input = (): ClosingConsensusClvInput => ({
  placedAmericanOdds: 120,
  selectionKey: "home",
  closingConsensusInput: {
    targetSportsbookId: "hardrock",
    selectionKeys: ["away", "home"],
    policy: {
      comparisonWeights: { a: 1, b: 1 },
      minimumBooks: 2,
      maximumAgeMinutes: 15,
      outlierThreshold: 0.5,
    },
    books: [
      book("hardrock", [-900, 500]),
      book("a", [-110, -110]),
      book("b", [-120, -120]),
    ],
  },
});

describe("closing line value", () => {
  it("matches the positive underdog golden with positive meaning beat the close", () => {
    const result = closingLineValue(120, 0.5);
    expect(result).toMatchObject({
      calculationVersion: "closing-line-value-v1",
      placedAmericanOdds: 120,
      placedDecimalOdds: 2.2,
      closingFairProbability: 0.5,
    });
    expect(result.placedImpliedProbability).toBeCloseTo(
      0.454_545_454_545_454_53,
      12,
    );
    expect(result.priceClv).toBeCloseTo(0.1, 12);
    expect(result.probabilityClv).toBeCloseTo(0.045_454_545_454_545_47, 12);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["zero", -110, 11 / 21, 0],
    ["negative favorite", -110, 0.5, -0.045_454_545_454_545_414],
    ["positive favorite", -150, 0.65, 0.083_333_333_333_333_26],
  ] as const)(
    "calculates %s price CLV",
    (_, odds, closingProbability, expected) => {
      const result = closingLineValue(odds, closingProbability);
      expect(result.priceClv).toBeCloseTo(expected, 12);
      expect(result.probabilityClv).toBeCloseTo(
        closingProbability - result.placedImpliedProbability,
        12,
      );
    },
  );

  it("strictly rejects invalid odds and closing probabilities", () => {
    expect(() => closingLineValue(99, 0.5)).toThrow(RangeError);
    expect(() => closingLineValue(100, 0)).toThrow(RangeError);
    expect(() => closingLineValue(100, 1)).toThrow(RangeError);
    expect(() => closingLineValue(100, Number.NaN)).toThrow(RangeError);
  });
});

describe("selected closing comparison consensus CLV", () => {
  it("selects the aligned closing probability, excludes the target, and freezes nested evidence", () => {
    const result = calculateClosingConsensusClv(input());

    expect(result).toMatchObject({
      calculationVersion: "closing-consensus-clv-v1",
      status: "available",
      issues: [],
      selectionKey: "home",
      values: {
        calculationVersion: "closing-line-value-v1",
      },
      consensus: {
        calculationVersion: "weighted-consensus-v1",
        status: "available",
        includedSportsbookIds: ["a", "b"],
        exclusions: [{ sportsbookId: "hardrock", reason: "target-sportsbook" }],
      },
    });
    expect(result.values?.priceClv).toBeCloseTo(0.1, 12);
    expect(result.values?.probabilityClv).toBeCloseTo(
      0.045_454_545_454_545_47,
      12,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
    expect(Object.isFrozen(result.consensus)).toBe(true);
    if (result.consensus === null) throw new Error("expected consensus");
    expect(
      Object.isFrozen(result.consensus.contributions[0]?.probabilities),
    ).toBe(true);
  });

  it("is invariant to closing-book ordering", () => {
    const left = calculateClosingConsensusClv(input());
    const fixture = input();
    const right = calculateClosingConsensusClv({
      ...fixture,
      closingConsensusInput: {
        ...fixture.closingConsensusInput,
        books: [...fixture.closingConsensusInput.books].reverse(),
      },
    });
    expect(right).toEqual(left);
  });

  it("fails closed with nested sparse consensus and no numeric or same-book fallback", () => {
    const fixture = input();
    const result = calculateClosingConsensusClv({
      ...fixture,
      closingConsensusInput: {
        ...fixture.closingConsensusInput,
        policy: {
          ...fixture.closingConsensusInput.policy,
          comparisonWeights: { a: 1, b: 1, missing: 1 },
          minimumBooks: 3,
        },
      },
    });

    expect(result).toMatchObject({
      status: "unavailable",
      issues: ["closing-consensus-unavailable"],
      values: null,
      consensus: {
        status: "unavailable",
        probabilities: null,
        issues: ["insufficient-books", "target-sportsbook"],
      },
    });
  });

  it("reports invalid placed odds even when closing consensus is sparse", () => {
    const fixture = input();
    const result = calculateClosingConsensusClv({
      ...fixture,
      placedAmericanOdds: 99,
      closingConsensusInput: {
        ...fixture.closingConsensusInput,
        policy: {
          ...fixture.closingConsensusInput.policy,
          comparisonWeights: { a: 1, b: 1, missing: 1 },
          minimumBooks: 3,
        },
      },
    });

    expect(result).toMatchObject({
      status: "invalid",
      issues: ["invalid-placed-odds"],
      values: null,
      consensus: null,
    });

    const numericOverflow = calculateClosingConsensusClv({
      ...fixture,
      placedAmericanOdds: -Number.MAX_VALUE,
      closingConsensusInput: {
        ...fixture.closingConsensusInput,
        policy: {
          ...fixture.closingConsensusInput.policy,
          comparisonWeights: { a: 1, b: 1, missing: 1 },
          minimumBooks: 3,
        },
      },
    });
    expect(numericOverflow).toMatchObject({
      status: "invalid",
      issues: ["numeric-overflow"],
      values: null,
      consensus: null,
    });
  });

  it("fails closed when the selected outcome is absent", () => {
    const result = calculateClosingConsensusClv({
      ...input(),
      selectionKey: "draw",
    });
    expect(result).toMatchObject({
      status: "unavailable",
      issues: ["selection-not-found"],
      values: null,
      consensus: { status: "available" },
    });
  });

  it("returns typed invalid states for invalid consensus or placed odds", () => {
    const fixture = input();
    const invalidConsensus = calculateClosingConsensusClv({
      ...fixture,
      closingConsensusInput: {
        ...fixture.closingConsensusInput,
        selectionKeys: ["home", "home"],
      },
    });
    expect(invalidConsensus).toMatchObject({
      status: "invalid",
      issues: ["closing-consensus-invalid"],
      values: null,
      consensus: { status: "invalid" },
    });

    const invalidOdds = calculateClosingConsensusClv({
      ...input(),
      placedAmericanOdds: 99,
    });
    expect(invalidOdds).toMatchObject({
      status: "invalid",
      issues: ["invalid-placed-odds"],
      values: null,
      consensus: null,
    });
  });
});
