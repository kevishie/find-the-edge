import { describe, expect, it } from "vitest";
import { createEvaluationAttempt } from "./evaluation-attempt";

describe("evaluation attempt", () => {
  const input = {
    semanticInputHash: "a".repeat(64),
    status: "failed" as const,
    reasonCodes: ["model-disabled"],
    sportKey: "mlb",
    leagueKey: "mlb",
    eventId: "event-1",
    strategy: { id: "fte", version: "1" },
    model: { id: "model", version: "1" },
    createdAt: "2026-08-04T00:00:00.000Z",
  };
  it("has stable semantic identity independent of audit timestamp", () => {
    expect(createEvaluationAttempt(input).attemptId).toBe(
      createEvaluationAttempt({
        ...input,
        createdAt: "2026-08-04T00:01:00.000Z",
      }).attemptId,
    );
  });
  it("rejects unsafe metadata", () => {
    expect(() =>
      createEvaluationAttempt({ ...input, reasonCodes: ["api_key=x"] }),
    ).toThrow("attempt-metadata-invalid");
  });
});
