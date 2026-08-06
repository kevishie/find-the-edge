import { describe, expect, it } from "vitest";
import { expectedValue } from "./index";
import { qualifyEvaluation } from "./qualification";

const input = () => ({
  targetSportsbookId: "hardrock",
  offeredAmerican: 120,
  offeredAgeMinutes: 2,
  candidateIndex: 0,
  modelProbability: {
    estimate: 0.55,
    low: 0.52,
    high: 0.58,
    uncertainty: 0.03,
  },
  books: [
    {
      sportsbookId: "circa",
      ageMinutes: 2,
      americanOdds: [110, -120],
    },
    {
      sportsbookId: "pinnacle",
      ageMinutes: 3,
      americanOdds: [105, -115],
    },
  ],
  outcomeCount: 2 as const,
  policy: {
    comparisonWeights: { circa: 1.25, pinnacle: 1 },
    minimumComparisonBooks: 2,
    maximumPriceAgeMinutes: 15,
    outlierThreshold: 0.12,
    disagreementWarningThreshold: 0.05,
    disagreementBlockThreshold: 0.1,
    maximumUncertainty: 0.1,
    minimumEdge: 0.01,
    minimumExpectedValue: 0.02,
  },
});

describe("deterministic qualification", () => {
  it("qualifies conservative positive EV and ignores model-authored arithmetic by construction", () => {
    const result = qualifyEvaluation(input());
    expect(result.decision).toBe("play");
    expect(result.conservativeProbability).toBe(0.52);
    expect(result.expectedValue).toBeCloseTo(0.144);
    expect(result.expectedValue).toBe(
      expectedValue(result.conservativeProbability, input().offeredAmerican),
    );
    expect(result.calculationVersion).toBe("deterministic-qualification-v1");
    const directNoVig = (odds: readonly number[]) => {
      const raw = odds.map((american) =>
        american > 0 ? 100 / (american + 100) : -american / (-american + 100),
      );
      const total = raw.reduce((sum, probability) => sum + probability, 0);
      return raw.map((probability) => probability / total);
    };
    const expected =
      (directNoVig(input().books[0]!.americanOdds)[0]! * 1.25 +
        directNoVig(input().books[1]!.americanOdds)[0]!) /
      2.25;
    expect(result.noVigProbability).toBeCloseTo(expected, 12);
    expect(result.includedSportsbookIds).toEqual(["circa", "pinnacle"]);
    expect(result.includedWeights).toEqual({ circa: 1.25, pinnacle: 1 });
  });
  it.each([
    [0, -1],
    [1, 1.2],
  ])(
    "preserves qualification-v1 arithmetic at probability boundary %s",
    (conservativeProbability, expected) => {
      const result = qualifyEvaluation({
        ...input(),
        modelProbability: {
          ...input().modelProbability,
          low: conservativeProbability,
        },
      });
      expect(result.calculationVersion).toBe("deterministic-qualification-v1");
      expect(result.expectedValue).toBeCloseTo(expected, 12);
    },
  );
  it.each([
    [
      "negative EV",
      {
        modelProbability: {
          estimate: 0.4,
          low: 0.35,
          high: 0.45,
          uncertainty: 0.05,
        },
      },
      "ev-below-threshold",
    ],
    [
      "uncertainty",
      {
        modelProbability: {
          estimate: 0.55,
          low: 0.4,
          high: 0.7,
          uncertainty: 0.15,
        },
      },
      "uncertainty-above-threshold",
    ],
    ["stale offered", { offeredAgeMinutes: 20 }, "stale-offered-price"],
    ["sparse", { books: [input().books[0]!] }, "insufficient-comparison-books"],
    [
      "reduced analysis",
      { analysisMaturity: "reduced" as const },
      "analysis-reduced",
    ],
  ])("returns No Bet for %s", (_, change, reason) => {
    const result = qualifyEvaluation({ ...input(), ...change });
    expect(result.decision).toBe("no-bet");
    expect(result.reasons).toContain(reason);
  });
  it("supports complete three-way vectors", () => {
    const result = qualifyEvaluation({
      ...input(),
      offeredAmerican: 250,
      candidateIndex: 1,
      outcomeCount: 3,
      policy: {
        ...input().policy,
        comparisonWeights: { a: 1, b: 1 },
      },
      books: [
        {
          sportsbookId: "a",
          ageMinutes: 1,
          americanOdds: [140, 250, 210],
        },
        {
          sportsbookId: "b",
          ageMinutes: 1,
          americanOdds: [145, 245, 205],
        },
      ],
    });
    expect(result.noVigProbability).toBeGreaterThan(0);
  });
  it("keeps sparse qualification fail-closed and exposes no partial consensus", () => {
    const result = qualifyEvaluation({
      ...input(),
      policy: {
        ...input().policy,
        comparisonWeights: {
          ...input().policy.comparisonWeights,
          missing: 1,
        },
        minimumComparisonBooks: 3,
      },
    });
    expect(result).toMatchObject({
      decision: "no-bet",
      noVigProbability: 0,
      marketDisagreement: 0,
      includedSportsbookIds: ["circa", "pinnacle"],
    });
    expect(result.reasons).toContain("insufficient-comparison-books");
    expect(result.reasons).not.toContain("market-disagreement-warning");
    expect(result.reasons).not.toContain("market-disagreement-blocked");
  });
  it("is invariant to comparison-book ordering", () => {
    const left = qualifyEvaluation(input());
    const right = qualifyEvaluation({
      ...input(),
      books: [...input().books].reverse(),
    });
    expect(right).toEqual(left);
  });
  it("preserves the versioned upper median for an even comparison roster", () => {
    const result = qualifyEvaluation({
      ...input(),
      policy: {
        ...input().policy,
        comparisonWeights: { a: 1, b: 1 },
        outlierThreshold: 0.14,
        disagreementWarningThreshold: 0.5,
        disagreementBlockThreshold: 0.6,
      },
      books: [
        {
          sportsbookId: "a",
          ageMinutes: 1,
          americanOdds: [100, 100],
        },
        {
          sportsbookId: "b",
          ageMinutes: 1,
          americanOdds: [-400, 300],
        },
      ],
    });

    expect(result.includedSportsbookIds).toEqual([]);
    expect(result.reasons).toContain("comparison-outlier-excluded");
  });
  it("rejects duplicate books and malformed vectors", () => {
    expect(() =>
      qualifyEvaluation({
        ...input(),
        books: [input().books[0]!, input().books[0]!],
      }),
    ).toThrow("duplicate-comparison-book");
    expect(() =>
      qualifyEvaluation({
        ...input(),
        books: [{ ...input().books[0]!, americanOdds: [110] }],
      }),
    ).toThrow("comparison-vector-invalid");
    expect(() =>
      qualifyEvaluation({
        ...input(),
        books: [
          { ...input().books[0]!, sportsbookId: "CIRCA" },
          input().books[0]!,
        ],
      }),
    ).toThrow("duplicate-comparison-book");
  });
  it("never includes the target sportsbook in qualification consensus", () => {
    const baseline = qualifyEvaluation(input());
    const contaminated = qualifyEvaluation({
      ...input(),
      books: [
        ...input().books,
        {
          sportsbookId: "HARDROCK",
          ageMinutes: Number.NaN,
          americanOdds: [-50],
        },
      ],
    });

    expect(contaminated.noVigProbability).toBe(baseline.noVigProbability);
    expect(contaminated.includedSportsbookIds).toEqual(
      baseline.includedSportsbookIds,
    );
  });
  it("reports outlier exclusion without disqualifying enough remaining books", () => {
    const result = qualifyEvaluation({
      ...input(),
      policy: {
        ...input().policy,
        comparisonWeights: {
          ...input().policy.comparisonWeights,
          outlier: 1,
        },
        minimumComparisonBooks: 2,
        outlierThreshold: 0.03,
      },
      books: [
        ...input().books,
        {
          sportsbookId: "outlier",
          ageMinutes: 1,
          americanOdds: [-400, 300],
        },
      ],
    });
    expect(result.reasons).toContain("comparison-outlier-excluded");
    expect(result.includedSportsbookIds).not.toContain("outlier");
  });
  it("excludes a book that diverges on a non-candidate outcome", () => {
    const result = qualifyEvaluation({
      ...input(),
      offeredAmerican: 250,
      candidateIndex: 1,
      outcomeCount: 3,
      policy: {
        ...input().policy,
        comparisonWeights: { a: 1, b: 1, "divergent-home": 1 },
        minimumComparisonBooks: 2,
        outlierThreshold: 0.08,
      },
      books: [
        {
          sportsbookId: "a",
          ageMinutes: 1,
          americanOdds: [140, 250, 210],
        },
        {
          sportsbookId: "b",
          ageMinutes: 1,
          americanOdds: [145, 245, 205],
        },
        {
          sportsbookId: "divergent-home",
          ageMinutes: 1,
          americanOdds: [-400, 250, 210],
        },
      ],
    });
    expect(result.includedSportsbookIds).not.toContain("divergent-home");
    expect(result.reasons).toContain("comparison-outlier-excluded");
  });
  it.each([
    ["warns", [-127, 127], "play", "market-disagreement-warning"],
    ["blocks", [-156, 156], "no-bet", "market-disagreement-blocked"],
  ] as const)(
    "%s on configured market disagreement",
    (_, odds, decision, reason) => {
      const result = qualifyEvaluation({
        ...input(),
        policy: {
          ...input().policy,
          comparisonWeights: { a: 1, b: 1 },
          outlierThreshold: 0.5,
          disagreementWarningThreshold: 0.05,
          disagreementBlockThreshold: 0.1,
          minimumEdge: -1,
          minimumExpectedValue: 0,
        },
        books: [
          {
            sportsbookId: "a",
            ageMinutes: 1,
            americanOdds: [100, 100],
          },
          {
            sportsbookId: "b",
            ageMinutes: 1,
            americanOdds: odds,
          },
        ],
      });
      expect(result.decision).toBe(decision);
      expect(result.reasons).toContain(reason);
    },
  );
});
