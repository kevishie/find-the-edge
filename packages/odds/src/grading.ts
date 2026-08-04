import { americanToDecimal } from "./index.js";

export type DeterministicGrade =
  | {
      readonly outcome: "won" | "lost" | "push" | "void";
      readonly reason: DeterministicGradeReason;
      readonly profit: number;
      readonly payout: number;
      readonly roi: number;
    }
  | {
      readonly outcome: "unresolved";
      readonly reason: DeterministicGradeReason;
      readonly profit: 0;
      readonly payout: 1;
      readonly roi: 0;
    };
export interface GradeScores {
  readonly away: number;
  readonly home: number;
}
export type DeterministicGradeReason =
  | "moneyline-final"
  | "spread-final"
  | "cancelled"
  | "no-contest"
  | "postponed"
  | "scores-missing"
  | "spread-evidence-missing"
  | "two-way-tie"
  | "sport-mismatch"
  | "event-mismatch"
  | "event-version-mismatch"
  | "result-scope-mismatch"
  | "participant-mismatch"
  | "selection-mismatch"
  | "legacy-grading-terms-missing"
  | "sport-grading-unsupported";
const unresolved = (reason: DeterministicGradeReason): DeterministicGrade => ({
  outcome: "unresolved",
  reason,
  profit: 0,
  payout: 1,
  roi: 0,
});
const settle = (
  outcome: "won" | "lost" | "push" | "void",
  americanOdds: number,
  reason: DeterministicGradeReason,
): DeterministicGrade => {
  if (outcome === "won") {
    const profit = americanToDecimal(americanOdds) - 1;
    return { outcome, reason, profit, payout: profit + 1, roi: profit };
  }
  if (outcome === "lost")
    return { outcome, reason, profit: -1, payout: 0, roi: -1 };
  return { outcome, reason, profit: 0, payout: 1, roi: 0 };
};
export function gradeMoneyline(input: {
  scores?: GradeScores;
  selected: "away" | "home" | "draw";
  outcomeCount: 2 | 3;
  americanOdds: number;
  terminalState: "final" | "postponed" | "cancelled" | "no-contest";
}): DeterministicGrade {
  if (
    input.terminalState === "cancelled" ||
    input.terminalState === "no-contest"
  )
    return settle("void", input.americanOdds, input.terminalState);
  if (input.terminalState === "postponed") return unresolved("postponed");
  if (!input.scores) return unresolved("scores-missing");
  const winner =
    input.scores.away === input.scores.home
      ? "draw"
      : input.scores.away > input.scores.home
        ? "away"
        : "home";
  if (winner === "draw" && input.outcomeCount === 2)
    return unresolved("two-way-tie");
  return settle(
    winner === input.selected ? "won" : "lost",
    input.americanOdds,
    "moneyline-final",
  );
}
export function gradeSpread(input: {
  scores?: GradeScores;
  selected: "away" | "home";
  point: number;
  americanOdds: number;
  terminalState: "final" | "postponed" | "cancelled" | "no-contest";
}): DeterministicGrade {
  if (
    input.terminalState === "cancelled" ||
    input.terminalState === "no-contest"
  )
    return settle("void", input.americanOdds, input.terminalState);
  if (input.terminalState === "postponed") return unresolved("postponed");
  if (!input.scores || !Number.isFinite(input.point))
    return unresolved("spread-evidence-missing");
  const adjusted =
    (input.selected === "away"
      ? input.scores.away - input.scores.home
      : input.scores.home - input.scores.away) + input.point;
  return settle(
    adjusted > 0 ? "won" : adjusted < 0 ? "lost" : "push",
    input.americanOdds,
    "spread-final",
  );
}
