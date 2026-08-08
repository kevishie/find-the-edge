import { describe, expect, it } from "vitest";
import {
  oddsCollectionPolicyVersion,
  productionOddsCollectionPolicies,
  productionProviderStatusCatalog,
} from "./feed-coverage";
import { defaultEvaluationPolicy } from "./evaluation-policy";

describe("production odds policy", () => {
  it("publishes exact non-fixture provider status scopes", () => {
    expect(productionProviderStatusCatalog).toHaveLength(16);
    expect(productionProviderStatusCatalog[0]).toMatchObject({
      scopeId: "sharpapi:account",
      healthKey: "sharpapi:account:account",
    });
    expect(
      productionProviderStatusCatalog.every(
        (scope) =>
          scope.providerId === "sharpapi" &&
          !scope.healthKey.includes("fixture"),
      ),
    ).toBe(true);
    expect(Object.isFrozen(productionProviderStatusCatalog)).toBe(true);
    expect(
      productionProviderStatusCatalog.find(
        ({ capability }) => capability === "account",
      )?.expectedFreshnessSeconds,
    ).toBe(900);
    expect(
      productionProviderStatusCatalog
        .filter(({ capability }) => capability === "splits")
        .every(
          ({ expectedFreshnessSeconds }) => expectedFreshnessSeconds === 900,
        ),
    ).toBe(true);
  });

  it("is Sharp-primary, independently budgeted and adaptive", () => {
    expect(oddsCollectionPolicyVersion).toContain("control-plane");
    expect(productionOddsCollectionPolicies).toHaveLength(5);
    for (const policy of productionOddsCollectionPolicies) {
      expect(policy.baseCadenceSeconds).toBe(60);
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
      expect(provider.books.pinnacle).toBe("collected");
      expect(provider.books.circa).toBe("collected");
      expect(defaultEvaluationPolicy.comparisonWeights).not.toHaveProperty(
        "pinnacle",
      );
      expect(
        Object.keys(defaultEvaluationPolicy.comparisonWeights).every(
          (book) => provider.books[book] === "comparison",
        ),
      ).toBe(true);
      if (policy.leagueKey === "mlb")
        expect(provider.expectedBooks?.pinnacle).toEqual(["moneyline"]);
      else expect(provider.expectedBooks).not.toHaveProperty("pinnacle");
      expect(provider.expectedBooks).not.toHaveProperty("hardrock");
      expect(provider.expectedBooks).not.toHaveProperty("draftkings");
      expect(provider.expectedBooks).not.toHaveProperty("circa");
    }
  });
});
