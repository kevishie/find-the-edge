import { describe, expect, it } from "vitest";
import {
  qualifyOpportunity,
  type OpportunityQualificationInput,
} from "./opportunity-qualification";

const input = (): OpportunityQualificationInput => ({
  eventStatus: "scheduled",
  marketApproved: true,
  targetSportsbookId: "hardrock",
  targetProviderHealthy: true,
  comparisonProviderHealth: {
    draftkings: true,
    fanduel: true,
    betmgm: true,
    caesars: true,
  },
  selectionKeys: ["team-a", "team-b"],
  candidateIndex: 0,
  target: {
    sportsbookId: "hardrock",
    state: "active",
    ageMinutes: 2,
    americanOdds: [125, -145],
  },
  comparisons: [
    {
      sportsbookId: "draftkings",
      state: "active",
      ageMinutes: 2,
      americanOdds: [-105, -115],
    },
    {
      sportsbookId: "fanduel",
      state: "active",
      ageMinutes: 2,
      americanOdds: [-102, -118],
    },
    {
      sportsbookId: "betmgm",
      state: "active",
      ageMinutes: 2,
      americanOdds: [-104, -116],
    },
    {
      sportsbookId: "caesars",
      state: "active",
      ageMinutes: 2,
      americanOdds: [-101, -119],
    },
  ],
  policy: {
    comparisonWeights: { draftkings: 1, fanduel: 1, betmgm: 1, caesars: 1 },
    minimumComparisonBooks: 3,
    maximumPriceAgeMinutes: 15,
    outlierThreshold: 0.08,
    disagreementWarningThreshold: 0.05,
    disagreementBlockThreshold: 0.1,
    minimumExpectedValue: 0.02,
  },
});

describe("opportunity qualification", () => {
  it("qualifies market-only EV at exact full precision", () => {
    const result = qualifyOpportunity(input());
    expect(result.status).toBe("qualified");
    expect(result.reasonCodes).toEqual([]);
    expect(result.includedComparisonSportsbookIds).toHaveLength(4);
    expect(result.values.expectedValue).toBeGreaterThan(0.02);
    expect(result.provenance?.root.algorithm.id).toBe(
      "opportunity-qualification",
    );
  });

  it("fails closed at EV and disagreement equality boundaries", () => {
    const baseline = qualifyOpportunity(input());
    const evBoundary = input();
    const atEv = qualifyOpportunity({
      ...evBoundary,
      policy: {
        ...evBoundary.policy,
        minimumExpectedValue: baseline.values.expectedValue!,
      },
    });
    expect(atEv.reasonCodes).not.toContain("ev-below-threshold");
    const divergent = input();
    const result = qualifyOpportunity({
      ...divergent,
      policy: {
        ...divergent.policy,
        disagreementBlockThreshold: 0.001,
        disagreementWarningThreshold: 0,
      },
    });
    expect(result.reasonCodes).toContain("market-disagreement-blocked");
  });

  it.each([
    ["missing", "target-missing"],
    ["stale", "target-stale"],
    ["suspended", "target-unavailable"],
    ["incomplete", "target-incomplete"],
    ["incoherent", "target-incoherent"],
  ] as const)("disqualifies a %s target", (state, reason) => {
    const value = input();
    const result = qualifyOpportunity({
      ...value,
      target: { ...value.target!, state },
    });
    expect(result.status).toBe("disqualified");
    expect(result.reasonCodes).toContain(reason);
  });

  it("excludes unhealthy comparisons and preserves the three-book gate", () => {
    const value = input();
    const result = qualifyOpportunity({
      ...value,
      comparisonProviderHealth: {
        ...value.comparisonProviderHealth,
        draftkings: false,
        fanduel: false,
      },
    });
    expect(result.reasonCodes).toContain("comparison-provider-unhealthy");
    expect(result.reasonCodes).toContain("insufficient-comparison-books");
  });

  it("does not globally block one unhealthy book when three healthy books agree", () => {
    const value = input();
    const result = qualifyOpportunity({
      ...value,
      comparisonProviderHealth: {
        ...value.comparisonProviderHealth,
        draftkings: false,
      },
    });
    expect(result.status).toBe("qualified");
    expect(result.reasonCodes).not.toContain("comparison-provider-unhealthy");
    expect(result.includedComparisonSportsbookIds).toHaveLength(3);
    expect(result.excludedComparisonBooks).toContainEqual({
      sportsbookId: "draftkings",
      reasonCodes: ["provider-unhealthy"],
    });
  });

  it.each([
    ["stale", "stale"],
    ["suspended", "suspended"],
    ["incomplete", "incomplete"],
    ["incoherent", "incoherent"],
  ] as const)("excludes %s comparison evidence", (state, exclusion) => {
    const value = input();
    const comparisons = value.comparisons.map((book) => ({ ...book }));
    comparisons[0] = { ...comparisons[0]!, state };
    comparisons[1] = { ...comparisons[1]!, state };
    const result = qualifyOpportunity({ ...value, comparisons });
    expect(result.status).toBe("disqualified");
    expect(result.reasonCodes).toContain("insufficient-comparison-books");
    expect(result.excludedComparisonBooks[0]?.reasonCodes).toContain(exclusion);
  });

  it("keeps warning-threshold disagreement nonblocking", () => {
    const value = input();
    const result = qualifyOpportunity({
      ...value,
      policy: {
        ...value.policy,
        disagreementWarningThreshold: 0.001,
        disagreementBlockThreshold: 0.1,
      },
    });
    expect(result.warningCodes).toContain("market-disagreement-warning");
    expect(result.reasonCodes).not.toContain("market-disagreement-blocked");
  });

  it("is deterministic across comparison permutations and excludes target", () => {
    const value = input();
    const first = qualifyOpportunity(value);
    const second = qualifyOpportunity({
      ...value,
      comparisons: [...value.comparisons].reverse(),
    });
    expect(second).toEqual(first);
    expect(first.includedComparisonSportsbookIds).not.toContain("hardrock");
  });

  it("supports a complete three-way market", () => {
    const value = input();
    const result = qualifyOpportunity({
      ...value,
      selectionKeys: ["home", "draw", "away"],
      candidateIndex: 1,
      target: {
        sportsbookId: "hardrock",
        state: "active",
        ageMinutes: 2,
        americanOdds: [180, 260, 210],
      },
      comparisons: [
        {
          sportsbookId: "draftkings",
          state: "active",
          ageMinutes: 2,
          americanOdds: [150, 240, 190],
        },
        {
          sportsbookId: "fanduel",
          state: "active",
          ageMinutes: 2,
          americanOdds: [155, 235, 195],
        },
        {
          sportsbookId: "betmgm",
          state: "active",
          ageMinutes: 2,
          americanOdds: [152, 238, 192],
        },
        {
          sportsbookId: "caesars",
          state: "active",
          ageMinutes: 2,
          americanOdds: [154, 236, 194],
        },
      ],
    });
    expect(result.values.consensusProbability).not.toBeNull();
    expect(result.provenance).not.toBeNull();
    expect(result.reasonCodes).not.toContain("insufficient-comparison-books");
  });

  it("retains outlier evidence as a warning while using three sound books", () => {
    const value = input();
    const comparisons = value.comparisons.map((book) => ({ ...book }));
    comparisons[0] = {
      ...comparisons[0]!,
      americanOdds: [900, -5000],
    };
    const result = qualifyOpportunity({ ...value, comparisons });
    expect(result.warningCodes).toContain("comparison-outlier-excluded");
    expect(result.excludedComparisonBooks).toContainEqual({
      sportsbookId: "draftkings",
      reasonCodes: ["outlier"],
    });
    expect(result.includedComparisonSportsbookIds).toHaveLength(3);
  });

  it("fails closed when safe calculation provenance cannot be constructed", () => {
    const value = input();
    const result = qualifyOpportunity({
      ...value,
      selectionKeys: ["name@example.com", "team-b"],
    });
    expect(result.status).toBe("disqualified");
    expect(result.reasonCodes).toContain("calculation-provenance-unavailable");
    expect(result.provenance).toBeNull();
  });
});
