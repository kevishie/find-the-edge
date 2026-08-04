import type {
  CohortMember,
  PaperEvaluationRecord,
  PaperGradeRecord,
} from "@find-the-edge/domain";
import {
  selectClosingOdds,
  type ClosingCandidate,
} from "./closing-odds-repository";
export interface ExactPerformanceEvidenceStore {
  getEvaluation(id: string): Promise<PaperEvaluationRecord | null>;
  getGrade(paperBetId: string, id: string): Promise<PaperGradeRecord | null>;
  getOdds(id: string): Promise<ClosingCandidate | null>;
}
export interface FrozenPerformanceEvidence {
  readonly member: CohortMember;
  readonly evaluation: PaperEvaluationRecord;
  readonly grade: PaperGradeRecord;
  readonly opening: ClosingCandidate;
  readonly closing: ClosingCandidate | null;
  readonly clvUnavailableReason: string | null;
}
export class PerformanceEvidenceCorruptError extends Error {
  override readonly name = "PerformanceEvidenceCorruptError";
}
export class PerformanceEvidenceRepository {
  constructor(private readonly store: ExactPerformanceEvidenceStore) {}
  async resolve(
    member: CohortMember,
    cutoff?: string,
  ): Promise<FrozenPerformanceEvidence> {
    const [evaluation, grade, opening, closing] = await Promise.all([
      this.store.getEvaluation(member.evaluationId),
      this.store.getGrade(member.paperBetId, member.gradeId),
      this.store.getOdds(member.openingSnapshotId),
      member.closingSnapshotId
        ? this.store.getOdds(member.closingSnapshotId)
        : Promise.resolve(null),
    ]);
    if (!evaluation || !grade || !opening)
      throw new PerformanceEvidenceCorruptError("performance-evidence-missing");
    if (
      evaluation.evaluationId !== member.evaluationId ||
      grade.gradeId !== member.gradeId ||
      grade.paperBetId !== member.paperBetId ||
      grade.evaluationId !== member.evaluationId ||
      grade.resultObservationId !== member.resultObservationId ||
      opening.snapshotId !== member.openingSnapshotId
    )
      throw new PerformanceEvidenceCorruptError(
        "performance-evidence-mismatch",
      );
    if (
      cutoff &&
      [
        evaluation.createdAt,
        grade.gradedAt,
        opening.observedAt,
        ...(closing ? [closing.observedAt] : []),
      ].some((value) => Date.parse(value) > Date.parse(cutoff))
    )
      throw new PerformanceEvidenceCorruptError(
        "performance-evidence-after-cutoff",
      );
    const manifest = evaluation.manifest;
    if (
      opening.eventId !== manifest.eventId ||
      opening.sportKey !== manifest.sportKey ||
      opening.marketKey !== manifest.marketKey ||
      opening.selectionKey !== manifest.selectionKey ||
      opening.snapshotId !== manifest.offeredOdds.snapshotId ||
      (manifest.gradingTerms &&
        opening.eventVersion !== manifest.gradingTerms.canonicalEventVersion) ||
      (manifest.gradingTerms?.market.kind === "spread" &&
        opening.point !== manifest.gradingTerms.market.point)
    )
      throw new PerformanceEvidenceCorruptError(
        "opening-evidence-binding-invalid",
      );
    const selected = selectClosingOdds({
      ...(evaluation.manifest.scheduledStartAt
        ? { scheduledStart: evaluation.manifest.scheduledStartAt }
        : {}),
      opening,
      candidates: closing ? [closing] : [],
    });
    if (
      member.closingSnapshotId &&
      selected.snapshot?.snapshotId !== member.closingSnapshotId
    )
      throw new PerformanceEvidenceCorruptError("closing-evidence-invalid");
    return {
      member,
      evaluation,
      grade,
      opening,
      closing: selected.snapshot,
      clvUnavailableReason: selected.unavailableReason,
    };
  }
}
