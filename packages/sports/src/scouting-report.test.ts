import type { SportKey } from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";

import { nflModule } from "./planned/definitions";
import {
  createUnavailableScoutingReportContract,
  defineSportScoutingReportContract,
} from "./shared/scouting-report";
import { soccerScoutingReportContract } from "./soccer/scouting-report";

describe("sport-owned scouting report contracts", () => {
  it("publishes the exact soccer product order", () => {
    expect(
      soccerScoutingReportContract.sections.map(({ title }) => title),
    ).toEqual([
      "Match Snapshot",
      "Venue & Weather",
      "Team Scouting",
      "Tactical Matchup",
      "Player Matchups",
      "X-Factor / Cinderella Check",
      "Betting Market Analysis",
      "Line Movement",
      "Advanced Metrics",
      "Historical Trends",
      "Market Edge",
      "Risk Assessment",
      "Final Plays",
      "Nuke or Pass",
    ]);
    expect(
      soccerScoutingReportContract.sections
        .slice(-2)
        .every(({ content }) => content === "deterministic"),
    ).toBe(true);
    expect(Object.isFrozen(soccerScoutingReportContract.sections)).toBe(true);
  });

  it("keeps planned modules honestly unavailable", () => {
    expect(
      nflModule.scoutingReportContract.sections.every(
        ({ availability }) => availability === "unavailable-only",
      ),
    ).toBe(true);
    expect(
      nflModule.scoutingReportContract.sections.every(
        ({ allowedFactCategories }) => allowedFactCategories.length === 0,
      ),
    ).toBe(true);
  });

  it("rejects duplicate, accessor-rich, and dishonest unavailable sections", () => {
    const base = {
      schemaId: "scout-report/test",
      schemaVersion: "1",
      sportKey: "test" as SportKey,
      sections: [
        {
          key: "one",
          title: "One",
          availability: "evidence" as const,
          content: "narrative" as const,
          allowedFactCategories: ["facts"],
          allowedCalculationKinds: [],
        },
      ],
    };
    expect(() =>
      defineSportScoutingReportContract({
        ...base,
        sections: [...base.sections, base.sections[0]!],
      }),
    ).toThrow("section-invalid");
    const accessor = { ...base };
    Object.defineProperty(accessor, "sections", {
      enumerable: true,
      get: () => base.sections,
    });
    expect(() => defineSportScoutingReportContract(accessor)).toThrow(
      "invalid",
    );
    expect(() =>
      createUnavailableScoutingReportContract({
        sportKey: "test" as SportKey,
        schemaVersion: "1",
        sections: [{ key: "one", title: "One" }],
      }),
    ).not.toThrow();
  });
});
