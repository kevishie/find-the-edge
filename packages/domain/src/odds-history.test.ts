import { describe, expect, it } from "vitest";
import {
  ODDS_HISTORY_COVERAGE_STATUSES,
  ODDS_HISTORY_OBSERVATION_STATES,
  type OddsHistoryPageDto,
} from "./odds-history";

describe("odds history DTO", () => {
  it("publishes the exact observation and coverage states", () => {
    expect(ODDS_HISTORY_OBSERVATION_STATES).toEqual([
      "active",
      "suspended",
      "unavailable",
    ]);
    expect(ODDS_HISTORY_COVERAGE_STATUSES).toEqual([
      "available",
      "unavailable",
    ]);

    const page = {
      eventId: "event:mlb:history",
      generatedAt: "2026-08-05T13:00:00.000Z",
      markerScope: "page",
      series: [
        {
          marketKey: "moneyline",
          selectionKey: "participant:away",
          selectionLabel: "Away",
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          points: [
            {
              observationId: "a".repeat(64),
              state: "active",
              americanOdds: -110,
              impliedProbability: 11 / 21,
              observedAt: "2026-08-05T12:00:00.000Z",
              retrievedAt: "2026-08-05T12:00:01.000Z",
              isOpening: true,
              isCurrent: true,
            },
          ],
        },
      ],
      coverage: [
        {
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          status: "available",
        },
      ],
      nextCursor: null,
    } satisfies OddsHistoryPageDto;

    expect(page.series[0]?.points[0]?.observationId).toHaveLength(64);
  });
});
