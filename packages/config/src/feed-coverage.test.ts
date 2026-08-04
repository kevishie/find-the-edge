import { describe, expect, it } from "vitest";
import {
  oddsCollectionPolicyVersion,
  productionOddsCollectionPolicies,
} from "./feed-coverage";
describe("production odds policy", () => {
  it("is Sharp-primary, independently budgeted and adaptive", () => {
    expect(oddsCollectionPolicyVersion).toContain("control-plane");
    expect(productionOddsCollectionPolicies).toHaveLength(2);
    for (const policy of productionOddsCollectionPolicies) {
      expect(policy.baseCadenceSeconds).toBe(3600);
      expect(policy.nearStart.cadenceSeconds).toBeLessThan(
        policy.baseCadenceSeconds,
      );
      expect(
        policy.providers.map((p) => [p.providerId, p.role, p.quotaReserve]),
      ).toEqual([
        ["sharpapi", "primary", 100],
        ["the-odds-api", "fallback", 50],
      ]);
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
});
