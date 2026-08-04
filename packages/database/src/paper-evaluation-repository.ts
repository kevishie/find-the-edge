import {
  clonePaperEvaluationValue,
  createPaperEvaluation,
  assertEvaluationId,
  assertPaperBetId,
  normalizePaperBetRecord,
  normalizePaperEvaluationRecord,
  stablePaperEvaluationValue,
  type PaperBetRecord,
  type PaperEvaluationInput,
  type PaperEvaluationPair,
  type PaperEvaluationRecord,
} from "@find-the-edge/domain";

export class PaperEvaluationReplayConflictError extends Error {
  override readonly name = "PaperEvaluationReplayConflictError";
}
export type PaperEvaluationPersistResult =
  | { readonly outcome: "created"; readonly pair: PaperEvaluationPair }
  | { readonly outcome: "duplicate"; readonly pair: PaperEvaluationPair };
export interface PaperEvaluationRepository {
  persist(input: PaperEvaluationInput): Promise<PaperEvaluationPersistResult>;
  getEvaluation(evaluationId: string): Promise<PaperEvaluationRecord | null>;
  getPaperBet(paperBetId: string): Promise<PaperBetRecord | null>;
}

const retryValue = (value: PaperEvaluationRecord | PaperBetRecord) => {
  const material: Record<string, unknown> = { ...value };
  delete material["createdAt"];
  return stablePaperEvaluationValue(material);
};
const same = (
  a: PaperEvaluationRecord | PaperBetRecord,
  b: PaperEvaluationRecord | PaperBetRecord,
) => retryValue(a) === retryValue(b);
export const verifyPaperEvaluationReplay = (
  intended: PaperEvaluationPair,
  evaluation: PaperEvaluationRecord | null,
  paperBet: PaperBetRecord | null,
): PaperEvaluationPair => {
  const normalizedEvaluation = evaluation
    ? normalizePaperEvaluationRecord(evaluation)
    : null;
  const normalizedPaperBet = paperBet
    ? normalizePaperBetRecord(paperBet)
    : null;
  if (!normalizedEvaluation || !same(normalizedEvaluation, intended.evaluation))
    throw new PaperEvaluationReplayConflictError("evaluation-replay-conflict");
  if (intended.paperBet === null) {
    if (normalizedPaperBet !== null)
      throw new PaperEvaluationReplayConflictError("unexpected-paper-bet");
  } else if (
    !normalizedPaperBet ||
    !same(normalizedPaperBet, intended.paperBet)
  ) {
    throw new PaperEvaluationReplayConflictError("paper-bet-replay-conflict");
  }
  return clonePaperEvaluationValue({
    evaluation: normalizedEvaluation,
    paperBet: normalizedPaperBet,
  });
};

export class MemoryPaperEvaluationRepository implements PaperEvaluationRepository {
  private readonly evaluations = new Map<string, PaperEvaluationRecord>();
  private readonly paperBets = new Map<string, PaperBetRecord>();

  persist(input: PaperEvaluationInput): Promise<PaperEvaluationPersistResult> {
    try {
      const intended = createPaperEvaluation(input);
      const key = intended.evaluation.evaluationId;
      const existing = this.evaluations.get(key);
      if (existing) {
        const pair = verifyPaperEvaluationReplay(
          intended,
          existing,
          this.paperBets.get(`paper-bet:${intended.evaluation.inputHash}`) ??
            null,
        );
        return Promise.resolve({ outcome: "duplicate", pair });
      }
      // A paper-only state is corruption and must never be completed opportunistically.
      const paperBetKey = `paper-bet:${intended.evaluation.inputHash}`;
      if (this.paperBets.has(paperBetKey))
        throw new PaperEvaluationReplayConflictError("partial-paper-bet-state");
      const stored = clonePaperEvaluationValue(intended);
      this.evaluations.set(key, stored.evaluation);
      if (stored.paperBet) this.paperBets.set(paperBetKey, stored.paperBet);
      return Promise.resolve({
        outcome: "created",
        pair: clonePaperEvaluationValue(stored),
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("paper-evaluation-persist-failed"),
      );
    }
  }
  getEvaluation(evaluationId: string) {
    try {
      const canonicalId = assertEvaluationId(evaluationId);
      const value = this.evaluations.get(canonicalId);
      return Promise.resolve(
        value
          ? clonePaperEvaluationValue(normalizePaperEvaluationRecord(value))
          : null,
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("evaluation-read-failed"),
      );
    }
  }
  getPaperBet(paperBetId: string) {
    try {
      const canonicalId = assertPaperBetId(paperBetId);
      const value = this.paperBets.get(canonicalId);
      return Promise.resolve(
        value
          ? clonePaperEvaluationValue(normalizePaperBetRecord(value))
          : null,
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("paper-bet-read-failed"),
      );
    }
  }
}
