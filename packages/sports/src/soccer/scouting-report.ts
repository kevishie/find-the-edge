import type { SportKey } from "@find-the-edge/domain";

import { defineSportScoutingReportContract } from "../shared/scouting-report";

const section = (
  key: string,
  title: string,
  allowedFactCategories: readonly string[],
  allowedCalculationKinds: readonly string[] = [],
  content: "narrative" | "deterministic" = "narrative",
  deterministicReferencePolicy?: "all-available" | "qualification-play-only",
) => ({
  key,
  title,
  availability: "evidence" as const,
  content,
  allowedFactCategories,
  allowedCalculationKinds,
  ...(deterministicReferencePolicy === undefined
    ? {}
    : { deterministicReferencePolicy }),
});

export const soccerScoutingReportContract = defineSportScoutingReportContract({
  schemaId: "scout-report/soccer",
  schemaVersion: "1",
  sportKey: "soccer" as SportKey,
  sections: [
    section("match-snapshot", "Match Snapshot", ["fixture"]),
    section("venue-weather", "Venue & Weather", ["venue"]),
    section("team-scouting", "Team Scouting", [
      "team-roster-profile",
      "statistics",
    ]),
    section("tactical-matchup", "Tactical Matchup", ["lineup", "statistics"]),
    section("player-matchups", "Player Matchups", [
      "team-roster-profile",
      "lineup",
      "injury-suspension",
    ]),
    section("x-factor-cinderella-check", "X-Factor / Cinderella Check", [
      "statistics",
      "injury-suspension",
    ]),
    section(
      "betting-market-analysis",
      "Betting Market Analysis",
      [],
      ["consensus", "fair-value", "market-disagreement"],
    ),
    section("line-movement", "Line Movement", [], ["line-movement"]),
    section(
      "advanced-metrics",
      "Advanced Metrics",
      ["statistics"],
      ["consensus", "fair-value"],
    ),
    section("historical-trends", "Historical Trends", ["statistics"]),
    section(
      "market-edge",
      "Market Edge",
      [],
      ["fair-value", "qualification", "market-disagreement"],
    ),
    section(
      "risk-assessment",
      "Risk Assessment",
      ["lineup", "injury-suspension", "statistics"],
      ["market-disagreement", "qualification"],
    ),
    section(
      "final-plays",
      "Final Plays",
      [],
      ["qualification"],
      "deterministic",
      "qualification-play-only",
    ),
    section(
      "nuke-or-pass",
      "Nuke or Pass",
      [],
      ["qualification"],
      "deterministic",
    ),
  ],
});
