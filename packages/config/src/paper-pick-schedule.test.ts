import { describe, expect, it } from "vitest";
import {
  disabledPaperPickSchedulePolicy,
  validatePaperPickSchedulePolicy,
} from "./paper-pick-schedule";

const valid = () => ({
  ...disabledPaperPickSchedulePolicy,
  enabled: true,
  killSwitch: "open" as const,
  limits: {
    events: 8,
    concurrency: 2,
    modelCalls: 8,
    inputTokens: 10000,
    outputTokens: 4000,
    costMicros: 500000,
  },
  allowlist: [
    {
      sportKey: "baseball",
      leagueKey: "mlb",
      strategyId: "ml",
      strategyVersion: "1",
      marketKey: "moneyline",
      mode: "shadow" as const,
    },
  ],
});
describe("paper-pick schedule policy", () => {
  it("exports a killed, disabled, empty default", () => {
    expect(disabledPaperPickSchedulePolicy).toMatchObject({
      enabled: false,
      killSwitch: "killed",
      allowlist: [],
    });
  });
  it("accepts an exact bounded policy and rejects unsafe variants", () => {
    expect(validatePaperPickSchedulePolicy(valid()).enabled).toBe(true);
    expect(() =>
      validatePaperPickSchedulePolicy({
        ...valid(),
        limits: { ...valid().limits, costMicros: Infinity },
      }),
    ).toThrow("cost-limit-invalid");
    expect(() =>
      validatePaperPickSchedulePolicy({
        ...valid(),
        allowlist: [...valid().allowlist, ...valid().allowlist],
      }),
    ).toThrow("allowlist-duplicate");
    expect(() =>
      validatePaperPickSchedulePolicy({ ...valid(), killSwitch: "killed" }),
    ).toThrow("enabled-policy-not-runnable");
  });
});
