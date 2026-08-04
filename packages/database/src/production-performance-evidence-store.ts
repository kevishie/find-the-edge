import type {
  PaperEvaluationRecord,
  PaperGradeRecord,
} from "@find-the-edge/domain";
import type { ClosingCandidate } from "./closing-odds-repository.js";
import type { ExactOddsSnapshotIndex } from "./exact-odds-snapshot-repository.js";
import type { PaperEvaluationRepository } from "./paper-evaluation-repository.js";
import type { PaperGradeRepository } from "./paper-grade-repository.js";
import type { ExactPerformanceEvidenceStore } from "./performance-evidence-repository.js";

export class ProductionPerformanceEvidenceStore implements ExactPerformanceEvidenceStore {
  constructor(
    private readonly evaluations: PaperEvaluationRepository,
    private readonly grades: PaperGradeRepository,
    private readonly snapshots: ExactOddsSnapshotIndex,
  ) {}
  getEvaluation(id: string): Promise<PaperEvaluationRecord | null> {
    return this.evaluations.getEvaluation(id);
  }
  async getGrade(
    paperBetId: string,
    id: string,
  ): Promise<PaperGradeRecord | null> {
    let cursor: string | undefined;
    do {
      const page = await this.grades.historyPage(paperBetId, 100, cursor);
      const match = page.items.find((grade) => grade.gradeId === id);
      if (match) return match;
      cursor = page.nextCursor;
    } while (cursor);
    return null;
  }
  getOdds(id: string): Promise<ClosingCandidate | null> {
    return this.snapshots.get(id);
  }
}
