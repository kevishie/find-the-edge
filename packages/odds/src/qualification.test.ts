import { describe, expect, it } from "vitest";
import { qualifyEvaluation } from "./qualification";

const input = () => ({
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
      weight: 1.25,
      ageMinutes: 2,
      americanOdds: [110, -120],
    },
    {
      sportsbookId: "pinnacle",
      weight: 1,
      ageMinutes: 3,
      americanOdds: [105, -115],
    },
  ],
  outcomeCount: 2 as const,
  policy: {
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
  });
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
      books: [
        {
          sportsbookId: "a",
          weight: 1,
          ageMinutes: 1,
          americanOdds: [140, 250, 210],
        },
        {
          sportsbookId: "b",
          weight: 1,
          ageMinutes: 1,
          americanOdds: [145, 245, 205],
        },
      ],
    });
    expect(result.noVigProbability).toBeGreaterThan(0);
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
  });
  it("reports outlier exclusion without disqualifying enough remaining books", () => {
    const result = qualifyEvaluation({
      ...input(),
      policy: {
        ...input().policy,
        minimumComparisonBooks: 2,
        outlierThreshold: 0.03,
      },
      books: [
        ...input().books,
        {
          sportsbookId: "outlier",
          weight: 1,
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
        minimumComparisonBooks: 2,
        outlierThreshold: 0.08,
      },
      books: [
        {
          sportsbookId: "a",
          weight: 1,
          ageMinutes: 1,
          americanOdds: [140, 250, 210],
        },
        {
          sportsbookId: "b",
          weight: 1,
          ageMinutes: 1,
          americanOdds: [145, 245, 205],
        },
        {
          sportsbookId: "divergent-home",
          weight: 1,
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
          outlierThreshold: 0.5,
          disagreementWarningThreshold: 0.05,
          disagreementBlockThreshold: 0.1,
          minimumEdge: -1,
          minimumExpectedValue: 0,
        },
        books: [
          {
            sportsbookId: "a",
            weight: 1,
            ageMinutes: 1,
            americanOdds: [100, 100],
          },
          {
            sportsbookId: "b",
            weight: 1,
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
