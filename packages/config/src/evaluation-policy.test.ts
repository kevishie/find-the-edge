import { describe, expect, it } from "vitest";
import {
  defaultEvaluationPolicy,
  validateEvaluationPolicy,
} from "./evaluation-policy";

describe("evaluation policy", () => {
  it("accepts the complete versioned policy", () => {
    expect(validateEvaluationPolicy(defaultEvaluationPolicy)).toBe(
      defaultEvaluationPolicy,
    );
    expect(defaultEvaluationPolicy).toMatchObject({
      version: "2.0.0-provisional",
      targetSportsbookId: "hardrock",
      minimumComparisonBooks: 3,
      maximumPriceAgeMinutes: 15,
      outlierThreshold: 0.08,
      disagreementWarningThreshold: 0.05,
      disagreementBlockThreshold: 0.1,
      fractionalKelly: 0.25,
      clvBenchmark: "closing-comparison-consensus",
      snapshotRetention: { mode: "indefinite-no-ttl", ttlDays: null },
    });
    expect(defaultEvaluationPolicy.comparisonWeights).toEqual({
      draftkings: 1,
      fanduel: 1,
      betmgm: 1,
      caesars: 1,
    });
    expect(
      defaultEvaluationPolicy.comparisonWeights[
        defaultEvaluationPolicy.targetSportsbookId
      ],
    ).toBeUndefined();
  });
  it.each([
    ["NaN freshness", { maximumPriceAgeMinutes: Number.NaN }],
    ["missing edge", { minimumEdge: Number.NaN }],
    ["bad uncertainty", { maximumUncertainty: 2 }],
    ["bad outlier", { outlierThreshold: 0 }],
    ["inverted disagreement boundaries", { disagreementBlockThreshold: 0.04 }],
    ["bad fractional Kelly", { fractionalKelly: 0 }],
    ["bad transform", { conservativeProbability: "estimate" }],
  ])("rejects %s", (_, change) => {
    expect(() =>
      validateEvaluationPolicy({
        ...defaultEvaluationPolicy,
        ...change,
      } as never),
    ).toThrow("evaluation-policy-threshold-invalid");
  });

  it.each([
    [
      "target included",
      {
        comparisonWeights: {
          ...defaultEvaluationPolicy.comparisonWeights,
          hardrock: 1,
        },
      },
    ],
    ["too few books", { comparisonWeights: { draftkings: 1, fanduel: 1 } }],
    [
      "case-variant target included",
      {
        comparisonWeights: {
          ...defaultEvaluationPolicy.comparisonWeights,
          HardRock: 1,
        },
      },
    ],
    ["missing comparison map", { comparisonWeights: null }],
  ])("rejects an invalid comparison roster: %s", (_, change) => {
    expect(() =>
      validateEvaluationPolicy({
        ...defaultEvaluationPolicy,
        ...change,
      } as never),
    ).toThrow("evaluation-policy-roster-invalid");
  });

  it("rejects missing retention with a bounded validation error", () => {
    expect(() =>
      validateEvaluationPolicy({
        ...defaultEvaluationPolicy,
        snapshotRetention: null,
      } as never),
    ).toThrow("evaluation-policy-threshold-invalid");
  });

  it("rejects invalid comparison weights", () => {
    expect(() =>
      validateEvaluationPolicy({
        ...defaultEvaluationPolicy,
        comparisonWeights: {
          ...defaultEvaluationPolicy.comparisonWeights,
          fanduel: 0,
        },
      }),
    ).toThrow("evaluation-policy-weight-invalid");
  });
});
