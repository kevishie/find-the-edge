import { describe, expect, it } from "vitest";

import {
  defaultOpportunityRankingPolicy,
  validateOpportunityRankingPolicy,
} from "./opportunity-ranking-policy";

describe("opportunity ranking policy", () => {
  it("publishes the approved v1 formula and total-order precedence", () => {
    expect(
      validateOpportunityRankingPolicy(defaultOpportunityRankingPolicy),
    ).toMatchObject({
      id: "find-the-edge-opportunity-ranking",
      version: "1.0.0",
      confidence: {
        scale: { minimum: 0, maximum: 100 },
        aggregation: "minimum-component",
        componentOrder: ["freshness", "coverage", "agreement"],
      },
      order: [
        "expected-value-desc",
        "confidence-desc",
        "freshness-desc",
        "sportsbook-coverage-desc",
        "logical-opportunity-id-asc",
      ],
      maximumFilterAgeMinutes: 15,
      maximumPhysicalRows: 200,
    });
  });

  it("rejects altered thresholds, order, and unbounded operational limits", () => {
    for (const policy of [
      {
        ...defaultOpportunityRankingPolicy,
        order: [...defaultOpportunityRankingPolicy.order].reverse(),
      },
      {
        ...defaultOpportunityRankingPolicy,
        confidence: {
          ...defaultOpportunityRankingPolicy.confidence,
          aggregation: "average-component",
        },
      },
      { ...defaultOpportunityRankingPolicy, maximumPhysicalRows: 201 },
      { ...defaultOpportunityRankingPolicy, cursorTtlMs: 0 },
    ])
      expect(() => validateOpportunityRankingPolicy(policy as never)).toThrow(
        "opportunity-ranking-policy-invalid",
      );
  });

  it("deep-freezes every policy component under its published version", () => {
    const validated = validateOpportunityRankingPolicy(
      structuredClone(defaultOpportunityRankingPolicy),
    );
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.order)).toBe(true);
    expect(Object.isFrozen(validated.confidence)).toBe(true);
    expect(Object.isFrozen(validated.confidence.componentOrder)).toBe(true);
    expect(Object.isFrozen(validated.confidence.buckets)).toBe(true);
    expect(
      validated.confidence.buckets.every((entry) => Object.isFrozen(entry)),
    ).toBe(true);
  });
});
