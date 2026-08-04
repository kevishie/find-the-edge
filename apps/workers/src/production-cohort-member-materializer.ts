import type {
  CohortMember,
  PaperBetRecord,
  PaperEvaluationRecord,
} from "@find-the-edge/domain";
import type {
  ExactOddsSnapshotIndex,
  PaperGradeRepository,
} from "@find-the-edge/database";
import {
  selectClosingOdds,
  type ClosingCandidate,
} from "@find-the-edge/database";
import type { CohortMemberMaterializer } from "./day-indexed-cohort-member-source.js";

export interface BoundedClosingCandidateSource {
  list(input: {
    readonly opening: ClosingCandidate;
    readonly from: string;
    readonly to: string;
    readonly limit: number;
  }): Promise<readonly ClosingCandidate[]>;
}

export class ProductionCohortMemberMaterializer implements CohortMemberMaterializer {
  constructor(
    private readonly grades: PaperGradeRepository,
    private readonly snapshots: ExactOddsSnapshotIndex,
    private readonly closingCandidates: BoundedClosingCandidateSource,
  ) {}
  async resolve(input: {
    readonly paperBet: PaperBetRecord;
    readonly evaluation: PaperEvaluationRecord;
    readonly cutoff: string;
  }): Promise<{
    readonly member: CohortMember;
    readonly americanOdds: number;
  } | null> {
    const grade = await this.grades.current(input.paperBet.paperBetId);
    if (!grade || grade.gradedAt > input.cutoff) return null;
    const opening = await this.snapshots.get(
      input.paperBet.offeredOdds.snapshotId,
    );
    if (!opening || opening.observedAt > input.cutoff) return null;
    const scheduledStart = input.evaluation.manifest.scheduledStartAt;
    let closing: ClosingCandidate | null = null;
    if (scheduledStart) {
      const candidates = await this.closingCandidates.list({
        opening,
        from: new Date(Date.parse(scheduledStart) - 900_000).toISOString(),
        to: scheduledStart < input.cutoff ? scheduledStart : input.cutoff,
        limit: 100,
      });
      closing = selectClosingOdds({
        scheduledStart,
        opening,
        candidates,
      }).snapshot;
    }
    return {
      member: {
        paperBetId: input.paperBet.paperBetId,
        evaluationId: input.evaluation.evaluationId,
        gradeId: grade.gradeId,
        resultObservationId: grade.resultObservationId,
        openingSnapshotId: opening.snapshotId,
        closingSnapshotId: closing?.snapshotId ?? null,
      },
      americanOdds: opening.americanOdds,
    };
  }
}
