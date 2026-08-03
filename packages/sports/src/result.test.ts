import { describe, expect, it } from "vitest";
import { mlbResultValidator } from "./mlb/result";
import { soccerResultValidator } from "./soccer/result";
describe("sport result validators", () => {
  it("accepts MLB extra innings and soccer regulation finals", () => {
    const scores = [
      { participantId: "a" as never, score: 2 },
      { participantId: "b" as never, score: 3 },
    ];
    expect(
      mlbResultValidator.validateResult({
        state: "final",
        scoreScope: "extra-innings",
        scores,
      }).valid,
    ).toBe(true);
    expect(
      soccerResultValidator.validateResult({
        state: "final",
        scoreScope: "regulation",
        scores,
      }).valid,
    ).toBe(true);
  });
  it("rejects inferred scopes and contradictory terminal scores", () => {
    const scores = [
      { participantId: "a" as never, score: 0 },
      { participantId: "b" as never, score: 0 },
    ];
    expect(
      mlbResultValidator.validateResult({
        state: "final",
        scoreScope: "overtime",
        scores,
      }).valid,
    ).toBe(false);
    for (const validator of [mlbResultValidator, soccerResultValidator])
      expect(
        validator.validateResult({
          state: "postponed",
          scoreScope: "regulation",
        }).valid,
      ).toBe(false);
    expect(
      soccerResultValidator.validateResult({
        state: "cancelled",
        scoreScope: "unknown",
        scores,
      }).valid,
    ).toBe(false);
  });
});
