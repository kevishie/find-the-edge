import { createTeamSportGradingAdapter } from "../shared/grading";
export const soccerPaperGradingAdapter = createTeamSportGradingAdapter(
  "soccer",
  ["regulation", "overtime"],
);
