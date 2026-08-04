import {
  normalizePaperBetRecord,
  normalizePaperEvaluationRecord,
  type CompletedEventResultObservation,
  type NormalizedFixtureOddsSnapshot,
  type PaperBetRecord,
  type PaperEvaluationRecord,
} from "@find-the-edge/domain";
import {
  validateFixtureOddsSnapshotItem,
  type FixtureOddsDynamoGateway,
} from "./fixture-odds-adapter";
import type { PaperEvaluationRepository } from "./paper-evaluation-repository";
import type { ResultRepository } from "./result-repository";

export interface ExactPaperGradingEvidence {
  readonly paperBet: PaperBetRecord;
  readonly evaluation: PaperEvaluationRecord;
  readonly odds: NormalizedFixtureOddsSnapshot;
  readonly result: CompletedEventResultObservation;
}
export class PaperGradingEvidenceError extends Error {
  override readonly name = "PaperGradingEvidenceError";
}
export class PaperGradingEvidenceRepository {
  constructor(
    readonly evaluations: Pick<
      PaperEvaluationRepository,
      "getEvaluation" | "getPaperBet"
    >,
    readonly odds: Pick<FixtureOddsDynamoGateway, "getExact">,
    readonly results: Pick<ResultRepository, "current" | "exact">,
  ) {}
  async read(
    paperBetId: string,
    resultObservationId: string,
  ): Promise<ExactPaperGradingEvidence> {
    const paperBet = await this.evaluations.getPaperBet(paperBetId);
    if (!paperBet) throw new PaperGradingEvidenceError("paper-bet-missing");
    const evaluation = await this.evaluations.getEvaluation(
      paperBet.evaluationId,
    );
    if (!evaluation || evaluation.decision !== "play")
      throw new PaperGradingEvidenceError("evaluation-missing-or-ineligible");
    normalizePaperBetRecord(paperBet);
    normalizePaperEvaluationRecord(evaluation);
    if (
      paperBet.inputHash !== evaluation.inputHash ||
      paperBet.offeredOdds.partitionKey !==
        evaluation.manifest.offeredOdds.partitionKey ||
      paperBet.offeredOdds.sortKey !==
        evaluation.manifest.offeredOdds.sortKey ||
      paperBet.offeredOdds.snapshotId !==
        evaluation.manifest.offeredOdds.snapshotId
    )
      throw new PaperGradingEvidenceError("paper-evidence-mismatch");
    if (/CURRENT/i.test(paperBet.offeredOdds.sortKey))
      throw new PaperGradingEvidenceError("mutable-odds-reference");
    const oddsItem = await this.odds.getExact(
      paperBet.offeredOdds.partitionKey,
      paperBet.offeredOdds.sortKey,
    );
    const exactOdds = validateFixtureOddsSnapshotItem(
      oddsItem,
      paperBet.offeredOdds.partitionKey,
      paperBet.offeredOdds.sortKey,
    );
    if (
      !exactOdds ||
      exactOdds.snapshotId !== paperBet.offeredOdds.snapshotId ||
      exactOdds.canonicalEventId !== evaluation.manifest.eventId ||
      exactOdds.sportKey !== evaluation.manifest.sportKey ||
      (evaluation.manifest.gradingTerms !== undefined &&
        exactOdds.canonicalEventVersion !==
          evaluation.manifest.gradingTerms.canonicalEventVersion) ||
      exactOdds.selectionKey !== evaluation.manifest.selectionKey ||
      exactOdds.marketKey !== evaluation.manifest.marketKey ||
      Date.parse(exactOdds.observedAt) > Date.parse(evaluation.createdAt) ||
      Date.parse(exactOdds.retrievedAt) > Date.parse(evaluation.createdAt)
    )
      throw new PaperGradingEvidenceError("odds-evidence-substituted");
    const current = await this.results.current(evaluation.manifest.eventId);
    if (!current || current.id !== resultObservationId)
      throw new PaperGradingEvidenceError("result-not-current");
    const result = await this.results.exact(
      evaluation.manifest.eventId,
      resultObservationId,
    );
    if (
      !result ||
      result.id !== current.id ||
      result.canonicalEventId !== evaluation.manifest.eventId ||
      result.sportKey !== evaluation.manifest.sportKey ||
      (evaluation.manifest.gradingTerms !== undefined &&
        result.canonicalEventVersion !==
          evaluation.manifest.gradingTerms.canonicalEventVersion)
    )
      throw new PaperGradingEvidenceError("result-evidence-missing");
    const currentFence = await this.results.current(
      evaluation.manifest.eventId,
    );
    if (!currentFence || currentFence.id !== result.id)
      throw new PaperGradingEvidenceError("result-current-changed");
    return { paperBet, evaluation, odds: exactOdds, result };
  }
}
