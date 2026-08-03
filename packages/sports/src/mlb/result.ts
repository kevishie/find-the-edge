import type { SportResultValidator } from "../shared/contracts";

export const mlbResultValidator: SportResultValidator = {
  validateResult(input) {
    const terminalWithoutScore = input.state !== "final";
    const scores = input.scores;
    const validScores =
      scores !== undefined &&
      scores.length === 2 &&
      new Set(scores.map((score) => score.participantId)).size === 2 &&
      scores.every(
        (score) => Number.isSafeInteger(score.score) && score.score >= 0,
      );
    if (terminalWithoutScore && scores !== undefined)
      return { valid: false, errors: ["terminal-state-has-score"] };
    if (terminalWithoutScore && input.scoreScope !== "unknown")
      return { valid: false, errors: ["terminal-state-score-scope-invalid"] };
    if (input.state === "final" && !validScores)
      return { valid: false, errors: ["final-score-invalid"] };
    if (
      input.state === "final" &&
      !["regulation", "extra-innings", "unknown"].includes(input.scoreScope)
    )
      return { valid: false, errors: ["mlb-score-scope-invalid"] };
    return { valid: true, value: input, errors: [] };
  },
};
