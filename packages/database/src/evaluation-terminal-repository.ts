export interface EvaluationTerminalClaim {
  readonly semanticInputHash: string;
  readonly terminalKind: "attempt" | "evaluation";
  readonly terminalId: string;
}
export interface EvaluationTerminalRepository {
  claim(input: EvaluationTerminalClaim): Promise<"created" | "duplicate">;
}
export class EvaluationTerminalConflictError extends Error {
  override readonly name = "EvaluationTerminalConflictError";
}
export class MemoryEvaluationTerminalRepository implements EvaluationTerminalRepository {
  private readonly claims = new Map<string, EvaluationTerminalClaim>();
  claim(input: EvaluationTerminalClaim): Promise<"created" | "duplicate"> {
    const existing = this.claims.get(input.semanticInputHash);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        return Promise.reject(
          new EvaluationTerminalConflictError("evaluation-terminal-conflict"),
        );
      return Promise.resolve("duplicate");
    }
    this.claims.set(input.semanticInputHash, structuredClone(input));
    return Promise.resolve("created");
  }
}
