import { describe, expect, it } from "vitest";
import {
  LIVE_ODDS_MONTHLY_RESERVE,
  liveOddsRefreshDue,
  liveOddsRefreshIntervalMinutes,
} from "./live-odds-ingestion";

describe("live odds cadence", () => {
  it("tightens MLB to 15 minutes in the lineup window and keeps normal discovery hourly", () => {
    expect(liveOddsRefreshIntervalMinutes("mlb", 75)).toBe(15);
    expect(liveOddsRefreshIntervalMinutes("mlb", 180)).toBe(60);
    expect(liveOddsRefreshIntervalMinutes("mls", 75)).toBe(30);
    expect(liveOddsRefreshIntervalMinutes("nfl", 75)).toBe(360);
  });

  it("honors the durable reserve before a paid odds call", () => {
    const now = new Date("2026-08-02T20:00:00.000Z");
    expect(
      liveOddsRefreshDue({
        now,
        leagueKey: "mlb",
        startsAt: ["2026-08-02T21:00:00.000Z"],
        state: {
          lastOddsRefreshAt: "2026-08-02T19:40:00.000Z",
          quotaRemaining: 400,
        },
      }),
    ).toBe(true);
    expect(
      liveOddsRefreshDue({
        now,
        leagueKey: "mlb",
        startsAt: ["2026-08-02T21:00:00.000Z"],
        state: {
          lastOddsRefreshAt: "2026-08-02T19:00:00.000Z",
          quotaRemaining: LIVE_ODDS_MONTHLY_RESERVE,
        },
      }),
    ).toBe(false);
  });
});
