import {
  createEvaluationAttempt,
  type EvaluationAttemptInput,
  type EvaluationAttemptRecord,
} from "@find-the-edge/domain";

export interface EvaluationAttemptRepository {
  persist(input: EvaluationAttemptInput): Promise<{
    readonly outcome: "created" | "duplicate";
    readonly attempt: EvaluationAttemptRecord;
  }>;
  get(attemptId: string): Promise<EvaluationAttemptRecord | null>;
}
export class MemoryEvaluationAttemptRepository implements EvaluationAttemptRepository {
  private readonly records = new Map<string, EvaluationAttemptRecord>();
  persist(input: EvaluationAttemptInput) {
    const attempt = createEvaluationAttempt(input);
    const existing = this.records.get(attempt.attemptId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(attempt))
        return Promise.reject(new Error("evaluation-attempt-replay-conflict"));
      return Promise.resolve({
        outcome: "duplicate" as const,
        attempt: structuredClone(existing),
      });
    }
    this.records.set(attempt.attemptId, structuredClone(attempt));
    return Promise.resolve({
      outcome: "created" as const,
      attempt: structuredClone(attempt),
    });
  }
  get(attemptId: string) {
    const found = this.records.get(attemptId);
    return Promise.resolve(found ? structuredClone(found) : null);
  }
}
