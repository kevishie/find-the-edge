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
  });
  it.each([
    ["NaN freshness", { maximumPriceAgeMinutes: Number.NaN }],
    ["missing edge", { minimumEdge: Number.NaN }],
    ["bad uncertainty", { maximumUncertainty: 2 }],
    ["bad outlier", { outlierThreshold: 0 }],
    ["bad transform", { conservativeProbability: "estimate" }],
  ])("rejects %s", (_, change) => {
    expect(() =>
      validateEvaluationPolicy({
        ...defaultEvaluationPolicy,
        ...change,
      } as never),
    ).toThrow("evaluation-policy-threshold-invalid");
  });
});
