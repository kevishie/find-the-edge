import { describe, expect, it } from "vitest";
import {
  assertPaperPickTransition,
  createPaperPickItemId,
  createPaperPickRunId,
} from "./paper-pick-run";
const input = {
  policyId: "schedule",
  policyVersion: "1",
  scheduledFor: "2026-08-04T12:00:00.000Z",
  sportKey: "baseball",
  leagueKey: "mlb",
  strategyId: "ml",
  strategyVersion: "1",
  marketKey: "moneyline",
  mode: "shadow" as const,
};
describe("paper-pick run domain", () => {
  it("derives stable identities and rejects illegal transitions", () => {
    const run = createPaperPickRunId(input);
    expect(createPaperPickRunId(input)).toBe(run);
    expect(createPaperPickItemId(run, "event-1", 1)).toBe(
      createPaperPickItemId(run, "event-1", 1),
    );
    expect(() => assertPaperPickTransition("complete", "running")).toThrow();
  });
});
