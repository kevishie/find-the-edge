import { describe, expect, it } from "vitest";
import { MemoryEvaluationAttemptRepository } from "./evaluation-attempt-repository";

describe("attempt repository", () => {
  it("appends once and converges exact retries", async () => {
    const repository = new MemoryEvaluationAttemptRepository();
    const input = {
      semanticInputHash: "b".repeat(64),
      status: "abstained" as const,
      reasonCodes: ["evidence-stale"],
      sportKey: "mlb",
      leagueKey: "mlb",
      eventId: "e",
      strategy: { id: "s", version: "1" },
      model: { id: "m", version: "1" },
      createdAt: "2026-08-04T00:00:00.000Z",
    };
    expect((await repository.persist(input)).outcome).toBe("created");
    expect((await repository.persist(input)).outcome).toBe("duplicate");
  });
});
