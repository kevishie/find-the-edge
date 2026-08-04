import { describe, expect, it, vi } from "vitest";
import { createEvaluationAttempt } from "@find-the-edge/domain";
import { DynamoEvaluationAttemptRepository } from "./dynamodb-evaluation-attempt-repository";

const input = {
  semanticInputHash: "d".repeat(64),
  status: "failed" as const,
  reasonCodes: ["model-disabled"],
  sportKey: "mlb",
  leagueKey: "mlb",
  eventId: "event",
  strategy: { id: "fte", version: "1" },
  model: { id: "model", version: "1" },
  createdAt: "2026-08-04T00:00:00.000Z",
};
describe("Dynamo attempt repository", () => {
  it("uses a conditional append", async () => {
    const commands: { readonly input: Readonly<Record<string, unknown>> }[] =
      [];
    const send = vi.fn(
      (command: { readonly input: Readonly<Record<string, unknown>> }) => {
        commands.push(command);
        return Promise.resolve({});
      },
    );
    const repository = new DynamoEvaluationAttemptRepository(
      { send } as never,
      "table",
    );
    expect((await repository.persist(input)).outcome).toBe("created");
    expect(commands[0]!.input).toMatchObject({
      TableName: "table",
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });
  it("strongly verifies a conditional duplicate", async () => {
    const first = new Error("conditional");
    first.name = "ConditionalCheckFailedException";
    let calls = 0;
    const commands: { readonly input: Readonly<Record<string, unknown>> }[] =
      [];
    const send = vi.fn(
      (command: { readonly input: Readonly<Record<string, unknown>> }) => {
        commands.push(command);
        calls += 1;
        if (calls === 1) return Promise.reject(first);
        return Promise.resolve({
          Item: { value: createEvaluationAttempt(input) },
        });
      },
    );
    const repository = new DynamoEvaluationAttemptRepository(
      { send } as never,
      "table",
    );
    await expect(repository.persist(input)).resolves.toMatchObject({
      outcome: "duplicate",
    });
    expect(commands[1]!.input["ConsistentRead"]).toBe(true);
  });
});
