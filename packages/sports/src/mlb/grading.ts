import { createTeamSportGradingAdapter } from "../shared/grading";
export const mlbPaperGradingAdapter = createTeamSportGradingAdapter("mlb", [
  "regulation",
  "extra-innings",
]);
