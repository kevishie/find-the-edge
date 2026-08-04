import {
  createPaperGrade,
  stablePaperGradeValue,
  type PaperGradeInput,
  type PaperGradeRecord,
} from "@find-the-edge/domain";
export class PaperGradeConflictError extends Error {
  override readonly name = "PaperGradeConflictError";
}
export interface PaperGradePage {
  readonly items: readonly PaperGradeRecord[];
  readonly nextCursor?: string;
}
export interface PaperGradeRepository {
  persist(input: PaperGradeInput): Promise<{
    outcome: "created" | "duplicate" | "stale";
    grade: PaperGradeRecord;
  }>;
  current(paperBetId: string): Promise<PaperGradeRecord | null>;
  historyPage(
    paperBetId: string,
    limit: number,
    cursor?: string,
  ): Promise<PaperGradePage>;
}
const stable = stablePaperGradeValue;
export class MemoryPaperGradeRepository implements PaperGradeRepository {
  private readonly grades = new Map<string, PaperGradeRecord>();
  private readonly currents = new Map<string, PaperGradeRecord>();
  async persist(input: PaperGradeInput) {
    await Promise.resolve();
    const grade = createPaperGrade(input),
      existing = this.grades.get(grade.gradeId);
    if (existing) {
      if (stable(existing) !== stable(grade))
        throw new PaperGradeConflictError("grade-replay-conflict");
      return {
        outcome: "duplicate" as const,
        grade: structuredClone(existing),
      };
    }
    const current = this.currents.get(grade.paperBetId);
    if (current && grade.resultAuthority <= current.resultAuthority)
      return { outcome: "stale" as const, grade };
    if (
      current
        ? grade.supersedesGradeId !== current.gradeId ||
          grade.correctionOrdinal !== current.correctionOrdinal + 1
        : grade.supersedesGradeId !== undefined || grade.correctionOrdinal !== 0
    )
      throw new PaperGradeConflictError("grade-current-conflict");
    this.grades.set(grade.gradeId, structuredClone(grade));
    this.currents.set(grade.paperBetId, structuredClone(grade));
    return { outcome: "created" as const, grade: structuredClone(grade) };
  }
  current(paperBetId: string) {
    const value = this.currents.get(paperBetId);
    return Promise.resolve(value ? structuredClone(value) : null);
  }
  async historyPage(paperBetId: string, limit: number, cursor?: string) {
    await Promise.resolve();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("grade-page-invalid");
    const values = [...this.grades.values()]
      .filter((g) => g.paperBetId === paperBetId)
      .sort((a, b) => a.correctionOrdinal - b.correctionOrdinal);
    const start = cursor
      ? values.findIndex((v) => v.gradeId === cursor) + 1
      : 0;
    if (cursor && start === 0) throw new Error("grade-cursor-invalid");
    const items = values.slice(start, start + limit);
    return {
      items: structuredClone(items),
      ...(start + items.length < values.length
        ? { nextCursor: items.at(-1)!.gradeId }
        : {}),
    };
  }
}
