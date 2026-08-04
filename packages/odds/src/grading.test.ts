import { describe, expect, it } from "vitest";
import { gradeMoneyline, gradeSpread } from "./grading";
describe("deterministic grading", () => {
  it.each([
    [
      {
        scores: { away: 5, home: 3 },
        selected: "away",
        outcomeCount: 2,
        americanOdds: 150,
        terminalState: "final",
      },
      "won",
      1.5,
    ],
    [
      {
        scores: { away: 3, home: 3 },
        selected: "away",
        outcomeCount: 2,
        americanOdds: -110,
        terminalState: "final",
      },
      "unresolved",
      0,
    ],
    [
      {
        scores: { away: 3, home: 3 },
        selected: "draw",
        outcomeCount: 3,
        americanOdds: 200,
        terminalState: "final",
      },
      "won",
      2,
    ],
  ] as const)("grades moneyline", (input, outcome, profit) => {
    const grade = gradeMoneyline(input);
    expect(grade.outcome).toBe(outcome);
    expect(grade.profit).toBe(profit);
  });
  it.each([
    [1.5, "won"],
    [1, "push"],
    [0.5, "lost"],
  ] as const)("grades spreads", (point, outcome) =>
    expect(
      gradeSpread({
        scores: { away: 4, home: 3 },
        selected: "home",
        point,
        americanOdds: -110,
        terminalState: "final",
      }).outcome,
    ).toBe(outcome),
  );
  it("voids cancellations and leaves postponements unresolved", () => {
    expect(
      gradeMoneyline({
        selected: "home",
        outcomeCount: 2,
        americanOdds: -110,
        terminalState: "cancelled",
      }).outcome,
    ).toBe("void");
    expect(
      gradeSpread({
        selected: "home",
        point: -1,
        americanOdds: -110,
        terminalState: "postponed",
      }).outcome,
    ).toBe("unresolved");
  });
});
