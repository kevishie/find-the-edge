import { describe, expect, it } from "vitest";
import { MemoryEvaluationCandidateRepository } from "./evaluation-candidate-repository";
describe("evaluation candidates", () => {
  it("bounds exact tuples and rechecks start eligibility", async () => {
    const event = {
      eventId: "event",
      eventVersion: 1,
      sportKey: "baseball",
      leagueKey: "mlb",
      participantIds: ["away", "home"],
      startsAt: "2026-08-04T14:00:00.000Z",
      status: "scheduled" as const,
    };
    const repo = new MemoryEvaluationCandidateRepository([event]);
    expect(
      await repo.listEligible({
        sportKey: "soccer",
        leagueKey: "mls",
        from: "2026-08-04T12:00:00.000Z",
        until: "2026-08-05T12:00:00.000Z",
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      await repo.rereadEligible(event, "2026-08-04T14:00:00.000Z"),
    ).toBeNull();
  });
});
