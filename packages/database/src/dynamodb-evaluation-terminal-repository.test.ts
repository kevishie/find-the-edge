import { describe, expect, it, vi } from "vitest";
import { DynamoEvaluationTerminalRepository } from "./dynamodb-evaluation-terminal-repository";

const claim = {
  semanticInputHash: "a".repeat(64),
  terminalKind: "evaluation" as const,
  terminalId: `evaluation:${"b".repeat(64)}`,
};
describe("Dynamo evaluation terminal claims", () => {
  it("conditionally creates and strongly verifies exact duplicates", async () => {
    const conditional = new Error("conditional");
    conditional.name = "ConditionalCheckFailedException";
    const commands: { readonly input: Readonly<Record<string, unknown>> }[] =
      [];
    let calls = 0;
    const send = vi.fn(
      (command: { readonly input: Readonly<Record<string, unknown>> }) => {
        commands.push(command);
        calls += 1;
        return calls === 1
          ? Promise.reject(conditional)
          : Promise.resolve({ Item: { value: claim } });
      },
    );
    const repository = new DynamoEvaluationTerminalRepository(
      { send } as never,
      "table",
    );
    await expect(repository.claim(claim)).resolves.toBe("duplicate");
    expect(commands[1]!.input["ConsistentRead"]).toBe(true);
  });
});
