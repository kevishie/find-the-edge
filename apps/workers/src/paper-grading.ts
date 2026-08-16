import {
  createPaperGrade,
  stablePaperEvaluationValue,
} from "@find-the-edge/domain";
import {
  PaperGradeConflictError,
  PaperGradingEvidenceError,
  resultAuthoritySortKey,
  type PaperEvaluationRepository,
  type PaperGradeRepository,
  type PaperGradingEvidenceRepository,
} from "@find-the-edge/database";
import type { DeterministicGrade } from "@find-the-edge/odds";
import {
  mlbPaperGradingAdapter,
  soccerPaperGradingAdapter,
  type SportPaperGradingAdapter,
} from "@find-the-edge/sports";
export interface PaperGradingCounters {
  discovered: number;
  graded: number;
  regraded: number;
  duplicate: number;
  unresolved: number;
  stale: number;
  failed: number;
  failureReasons: Readonly<Record<PaperGradingFailureReason, number>>;
  failureAudits: readonly PaperGradingFailureAudit[];
}
export interface PaperGradingFailureAudit {
  readonly paperBetId: string;
  readonly code: PaperGradingFailureReason;
}
export type PaperGradingFailureReason =
  "evidence-invalid" | "grade-conflict" | "index-invalid" | "unexpected";
const emptyFailureReasons = (): Record<PaperGradingFailureReason, number> => ({
  "evidence-invalid": 0,
  "grade-conflict": 0,
  "index-invalid": 0,
  unexpected: 0,
});
const failureReason = (error: unknown): PaperGradingFailureReason => {
  if (error instanceof PaperGradingEvidenceError) return "evidence-invalid";
  if (error instanceof PaperGradeConflictError) return "grade-conflict";
  if (error instanceof Error && error.message === "paper-event-index-mismatch")
    return "index-invalid";
  return "unexpected";
};
export const embeddedPaperGradingTelemetry = {
  emit(counters: Readonly<PaperGradingCounters>) {
    for (const audit of counters.failureAudits)
      process.stdout.write(
        `${JSON.stringify({
          event: "PaperGradingFailure",
          paperBetId: audit.paperBetId,
          code: audit.code,
        })}\n`,
      );
  },
};
const adapters: Record<string, SportPaperGradingAdapter> = {
  mlb: mlbPaperGradingAdapter,
  soccer: soccerPaperGradingAdapter,
};
export class PaperGradingService {
  constructor(
    readonly evaluations: Pick<
      PaperEvaluationRepository,
      "listPaperBetsByEvent"
    >,
    readonly evidence: PaperGradingEvidenceRepository,
    readonly grades: PaperGradeRepository,
    readonly telemetry: {
      emit(counters: Readonly<PaperGradingCounters>): void;
    } = embeddedPaperGradingTelemetry,
  ) {}
  async gradeCurrentResult(
    eventId: string,
    resultObservationId: string,
  ): Promise<PaperGradingCounters> {
    const counters = {
      discovered: 0,
      graded: 0,
      regraded: 0,
      duplicate: 0,
      unresolved: 0,
      stale: 0,
      failed: 0,
      failureReasons: emptyFailureReasons(),
      failureAudits: [] as PaperGradingFailureAudit[],
    };
    let cursor: string | undefined;
    do {
      const page = await this.evaluations.listPaperBetsByEvent({
        eventId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const paper of page.items) {
        counters.discovered++;
        try {
          const exact = await this.evidence.read(
              paper.paperBetId,
              resultObservationId,
            ),
            terms = exact.evaluation.manifest.gradingTerms,
            adapter = adapters[exact.evaluation.manifest.sportKey];
          if (
            stablePaperEvaluationValue(paper) !==
              stablePaperEvaluationValue(exact.paperBet) ||
            exact.paperBet.evaluationId !== exact.evaluation.evaluationId ||
            exact.evaluation.manifest.eventId !== eventId
          )
            throw new Error("paper-event-index-mismatch");
          let outcome: DeterministicGrade;
          if (!terms)
            outcome = {
              outcome: "unresolved" as const,
              reason: adapter
                ? "legacy-grading-terms-missing"
                : "sport-grading-unsupported",
              profit: 0,
              payout: 1,
              roi: 0,
            };
          else if (!adapter)
            outcome = {
              outcome: "unresolved" as const,
              reason: "sport-grading-unsupported",
              profit: 0,
              payout: 1,
              roi: 0,
            };
          else
            outcome = adapter.grade({
              eventId: exact.evaluation.manifest.eventId,
              terms,
              selectionKey: exact.evaluation.manifest.selectionKey,
              americanOdds: exact.odds.americanOdds,
              result: exact.result,
            });
          const current = await this.grades.current(exact.paperBet.paperBetId);
          const isExactReplay =
            current?.resultObservationId === resultObservationId;
          const grade = createPaperGrade({
            paperBetId: exact.paperBet.paperBetId,
            evaluationId: exact.evaluation.evaluationId,
            eventId: exact.evaluation.manifest.eventId,
            resultObservationId,
            resultAuthority: resultAuthoritySortKey(exact.result),
            oddsPartitionKey: exact.odds.partitionKey,
            oddsSortKey: exact.odds.sortKey,
            oddsSnapshotId: exact.odds.snapshotId,
            outcome: outcome.outcome,
            reason: outcome.reason,
            profit: outcome.profit,
            payout: outcome.payout,
            roi: outcome.roi,
            ...(isExactReplay
              ? current.supersedesGradeId
                ? { supersedesGradeId: current.supersedesGradeId }
                : {}
              : current
                ? { supersedesGradeId: current.gradeId }
                : {}),
            correctionOrdinal: isExactReplay
              ? current.correctionOrdinal
              : current
                ? current.correctionOrdinal + 1
                : 0,
            gradedAt: exact.result.retrievedAt,
          });
          const persisted = await this.grades.persist(grade);
          if (persisted.outcome === "duplicate") counters.duplicate++;
          else if (persisted.outcome === "stale") counters.stale++;
          else {
            if (current) counters.regraded++;
            else if (grade.outcome !== "unresolved") counters.graded++;
            if (grade.outcome === "unresolved") counters.unresolved++;
          }
        } catch (error) {
          counters.failed++;
          const code = failureReason(error);
          counters.failureReasons[code]++;
          counters.failureAudits.push({ paperBetId: paper.paperBetId, code });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    try {
      this.telemetry?.emit({ ...counters });
    } catch {
      // Metrics cannot change authoritative grading outcomes.
    }
    return counters;
  }
}
