import { describe, expect, it } from "vitest";
import {
  oddsCollectionPolicyVersion,
  productionOddsCollectionPolicies,
} from "./feed-coverage";
import { defaultEvaluationPolicy } from "./evaluation-policy";

const PRO_ENTITLED_ODDS_BOOKS = new Set([
  "hardrock",
  "draftkings",
  "fanduel",
  "betmgm",
  "caesars",
]);

describe("production odds policy", () => {
  it("is Sharp-primary, independently budgeted and adaptive", () => {
    expect(oddsCollectionPolicyVersion).toContain("control-plane");
    expect(productionOddsCollectionPolicies).toHaveLength(5);
    for (const policy of productionOddsCollectionPolicies) {
      expect(policy.baseCadenceSeconds).toBe(3600);
      expect(policy.nearStart.cadenceSeconds).toBeLessThan(
        policy.baseCadenceSeconds,
      );
      expect(
        policy.providers.map((p) => [p.providerId, p.role, p.quotaReserve]),
      ).toEqual([["sharpapi", "primary", 100]]);
      expect(Object.isFrozen(policy)).toBe(true);
      const provider = policy.providers[0]!;
      expect(provider.books[defaultEvaluationPolicy.targetSportsbookId]).toBe(
        "offered",
      );
      const comparisons = Object.entries(provider.books)
        .filter(([, role]) => role === "comparison")
        .map(([book]) => book)
        .sort();
      expect(comparisons).toEqual(
        Object.keys(defaultEvaluationPolicy.comparisonWeights).sort(),
      );
      expect(comparisons.length).toBeGreaterThanOrEqual(
        defaultEvaluationPolicy.minimumComparisonBooks,
      );
      expect(
        Object.keys(provider.books).every((book) =>
          PRO_ENTITLED_ODDS_BOOKS.has(book),
        ),
      ).toBe(true);
      expect(provider.books).not.toHaveProperty("circa");
      expect(provider.books).not.toHaveProperty("pinnacle");
    }
  });
});
