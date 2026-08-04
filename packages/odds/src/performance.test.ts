import { describe, expect, it } from "vitest";
import { computePerformance, oddsBand, wilsonInterval } from "./performance.js";
describe("performance", () => {
  it("uses explicit denominators", () => {
    const at = "2026-08-01T00:00:00.000Z";
    const r = computePerformance([
      {
        id: "b",
        createdAt: at,
        outcome: "lost",
        profit: -1,
        americanOdds: -110,
        estimatedProbability: 0.55,
        closingAmericanOdds: -120,
      },
      {
        id: "a",
        createdAt: at,
        outcome: "won",
        profit: 0.8,
        americanOdds: -125,
        estimatedProbability: 0.6,
      },
      {
        id: "c",
        createdAt: at,
        outcome: "push",
        profit: 0,
        americanOdds: 100,
        estimatedProbability: 0.5,
      },
      {
        id: "d",
        createdAt: at,
        outcome: "void",
        profit: 0,
        americanOdds: 150,
        estimatedProbability: 0.4,
      },
      {
        id: "e",
        createdAt: at,
        outcome: "unresolved",
        profit: 0,
        americanOdds: 150,
        estimatedProbability: 0.4,
      },
    ]);
    expect(r.counts).toMatchObject({
      source: 5,
      won: 1,
      lost: 1,
      push: 1,
      void: 1,
      unresolved: 1,
      decisions: 2,
      resolvedExposure: 3,
    });
    expect(r.units).toBe(-0.2);
    expect(r.roi).toBeCloseTo(-0.066666666667);
    expect(r.winRate).toBe(0.5);
    expect(r.maximumDrawdown).toBe(1);
    expect(r.clv).toMatchObject({ eligible: 1, unavailable: 4 });
  });
  it("returns null for empty denominators", () => {
    const r = computePerformance([]);
    expect(r.roi).toBeNull();
    expect(r.winRate).toBeNull();
    expect(r.brierScore).toBeNull();
    expect(wilsonInterval(0, 0)).toBeNull();
  });
  it("assigns bands", () =>
    expect([-200, -110, -100, 109, 110, 200].map(oddsBand)).toEqual([
      "heavy-favorite",
      "favorite",
      "near-even",
      "near-even",
      "underdog",
      "longshot",
    ]));
});
