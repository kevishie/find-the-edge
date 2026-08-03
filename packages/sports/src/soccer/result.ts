import type { SportResultValidator } from "../shared/contracts";

export const soccerResultValidator: SportResultValidator = {
  validateResult(input) {
    const scores = input.scores;
    if (input.state !== "final" && scores !== undefined)
      return { valid: false, errors: ["terminal-state-has-score"] };
    if (input.state !== "final" && input.scoreScope !== "unknown")
      return { valid: false, errors: ["terminal-state-score-scope-invalid"] };
    if (
      input.state === "final" &&
      (scores === undefined ||
        scores.length !== 2 ||
        new Set(scores.map((score) => score.participantId)).size !== 2 ||
        scores.some(
          (score) => !Number.isSafeInteger(score.score) || score.score < 0,
        ))
    )
      return { valid: false, errors: ["final-score-invalid"] };
    if (
      input.state === "final" &&
      !["regulation", "overtime", "unknown"].includes(input.scoreScope)
    )
      return { valid: false, errors: ["soccer-score-scope-invalid"] };
    return { valid: true, value: input, errors: [] };
  },
};
