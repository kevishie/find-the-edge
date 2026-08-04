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
  listPaperBetsByEvent(input: {
    readonly eventId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly PaperBetRecord[];
    readonly nextCursor?: string;
  }>;
  listPaperBetsByDecisionDay(input: {
    readonly day: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly PaperBetRecord[];
    readonly nextCursor?: string;
  }>;
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
  private readonly eventPaperBets = new Map<string, Set<string>>();
  private readonly dayPaperBets = new Map<string, Set<string>>();

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
      if (stored.paperBet) {
        const eventId = stored.evaluation.manifest.eventId;
        const ids = this.eventPaperBets.get(eventId) ?? new Set<string>();
        ids.add(stored.paperBet.paperBetId);
        this.eventPaperBets.set(eventId, ids);
        const day = stored.paperBet.createdAt.slice(0, 10);
        const dayIds = this.dayPaperBets.get(day) ?? new Set<string>();
        dayIds.add(stored.paperBet.paperBetId);
        this.dayPaperBets.set(day, dayIds);
      }
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
  async listPaperBetsByEvent(input: {
    readonly eventId: string;
    readonly limit: number;
    readonly cursor?: string;
  }) {
    await Promise.resolve();
    if (
      !input.eventId ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("paper-bet-event-query-invalid");
    const ids = [...(this.eventPaperBets.get(input.eventId) ?? [])].sort();
    const start =
      input.cursor === undefined
        ? 0
        : ids.findIndex((id) => id === input.cursor) + 1;
    if (input.cursor !== undefined && start === 0)
      throw new Error("paper-bet-event-cursor-invalid");
    const page = ids.slice(start, start + input.limit);
    const items = page.map((paperBetId) =>
      clonePaperEvaluationValue(this.paperBets.get(paperBetId)!),
    );
    return {
      items,
      ...(start + page.length < ids.length
        ? { nextCursor: page[page.length - 1]! }
        : {}),
    };
  }
  async listPaperBetsByDecisionDay(input: {
    readonly day: string;
    readonly limit: number;
    readonly cursor?: string;
  }) {
    await Promise.resolve();
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("paper-bet-day-query-invalid");
    const ids = [...(this.dayPaperBets.get(input.day) ?? [])].sort();
    let cursorId: string | undefined;
    if (input.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString(),
        ) as { day?: unknown; id?: unknown };
        if (parsed.day !== input.day || typeof parsed.id !== "string")
          throw new Error();
        cursorId = assertPaperBetId(parsed.id);
      } catch {
        throw new Error("paper-bet-day-cursor-invalid");
      }
    }
    const start = cursorId === undefined ? 0 : ids.indexOf(cursorId) + 1;
    if (cursorId !== undefined && start === 0)
      throw new Error("paper-bet-day-cursor-invalid");
    const page = ids.slice(start, start + input.limit),
      items = page.map((id) =>
        clonePaperEvaluationValue(this.paperBets.get(id)!),
      );
    return {
      items,
      ...(start + page.length < ids.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ day: input.day, id: page.at(-1)! }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
}
