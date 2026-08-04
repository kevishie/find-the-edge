import { describe, expect, it } from "vitest";
import {
  EvaluationTerminalConflictError,
  MemoryEvaluationTerminalRepository,
} from "./evaluation-terminal-repository";

describe("evaluation terminal claims", () => {
  it("converges identical concurrent claims and rejects conflicting terminals", async () => {
    const repository = new MemoryEvaluationTerminalRepository();
    const claim = {
      semanticInputHash: "a".repeat(64),
      terminalKind: "attempt" as const,
      terminalId: `evaluation-attempt:${"b".repeat(64)}`,
    };
    expect(await repository.claim(claim)).toBe("created");
    expect(await repository.claim(claim)).toBe("duplicate");
    await expect(
      repository.claim({
        ...claim,
        terminalKind: "evaluation",
        terminalId: `evaluation:${"c".repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(EvaluationTerminalConflictError);
  });
});
