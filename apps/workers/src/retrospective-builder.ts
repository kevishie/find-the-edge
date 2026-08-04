import {
  freezeRetrospectiveEvidence,
  sha256Hex,
  stableCohortValue,
  type FrozenCohort,
  type RetrospectiveEvidenceRef,
  type RetrospectiveVersion,
} from "@find-the-edge/domain";
import type {
  PerformanceEvidenceRepository,
  RetrospectiveRepository,
  StoredPerformanceReport,
} from "@find-the-edge/database";
import type { PerformanceReportMetrics } from "@find-the-edge/odds";
import {
  buildRetrospective,
  type RetrospectiveMemberReview,
} from "@find-the-edge/scouting";
import type { PerformanceMetricSink } from "./cohort-builder";

export interface RetrospectiveEvidenceSource {
  resolve(
    member: FrozenCohort["members"][number],
    cutoff: string,
  ): Promise<{
    readonly member: RetrospectiveMemberReview;
    readonly refs: readonly RetrospectiveEvidenceRef[];
  }>;
}
export class ExactRetrospectiveEvidenceAdapter implements RetrospectiveEvidenceSource {
  constructor(private readonly source: PerformanceEvidenceRepository) {}
  async resolve(member: FrozenCohort["members"][number], cutoff: string) {
    const frozen = await this.source.resolve(member, cutoff),
      manifest = frozen.evaluation.manifest;
    const reference = (
      id: string,
      kind: string,
      layer: RetrospectiveEvidenceRef["layer"],
      decisionCutoff: string,
      observedAt: string,
      material: unknown,
    ): RetrospectiveEvidenceRef => ({
      id,
      kind,
      layer,
      decisionCutoff,
      observedAt,
      digest: sha256Hex(stableCohortValue(material)),
    });
    const refs: RetrospectiveEvidenceRef[] = [
      reference(
        frozen.evaluation.evaluationId,
        "evaluation",
        "decision-time",
        frozen.evaluation.createdAt,
        frozen.evaluation.createdAt,
        frozen.evaluation,
      ),
      reference(
        frozen.opening.snapshotId,
        "opening-odds",
        "decision-time",
        frozen.evaluation.createdAt,
        frozen.opening.observedAt,
        frozen.opening,
      ),
      reference(
        frozen.grade.gradeId,
        "grade",
        "post-decision",
        frozen.evaluation.createdAt,
        frozen.grade.gradedAt,
        frozen.grade,
      ),
      reference(
        frozen.grade.resultObservationId,
        "result",
        "post-decision",
        frozen.evaluation.createdAt,
        frozen.grade.gradedAt,
        { id: frozen.grade.resultObservationId, gradeId: frozen.grade.gradeId },
      ),
      ...(frozen.closing
        ? [
            reference(
              frozen.closing.snapshotId,
              "closing-odds",
              "post-decision",
              frozen.evaluation.createdAt,
              frozen.closing.observedAt,
              frozen.closing,
            ),
          ]
        : []),
    ];
    return {
      member: {
        memberId: member.paperBetId,
        sport: String(manifest.sportKey),
        league: manifest.leagueKey,
        market: manifest.marketKey,
        outcome: frozen.grade.outcome,
        profit: frozen.grade.profit,
        evidenceRefIds: refs.map((ref) => ref.id),
      },
      refs,
    };
  }
}

export class RetrospectiveBuilder {
  constructor(
    private readonly evidence: RetrospectiveEvidenceSource,
    private readonly repository: RetrospectiveRepository,
    private readonly metrics?: PerformanceMetricSink,
  ) {}
  async build(input: {
    readonly cohort: FrozenCohort;
    readonly report: StoredPerformanceReport<PerformanceReportMetrics>;
    readonly createdAt: string;
  }): Promise<RetrospectiveVersion> {
    const started = Date.now();
    try {
      if (
        input.report.cohortId !== input.cohort.cohortId ||
        input.report.cutoff !== input.cohort.cutoff
      )
        throw new Error("retrospective-report-binding-invalid");
      const resolved: Awaited<
        ReturnType<RetrospectiveEvidenceSource["resolve"]>
      >[] = [];
      const checkpoints = new Map<
        string,
        Awaited<ReturnType<RetrospectiveEvidenceSource["resolve"]>>
      >();
      const resolveWithRetry = async (
        member: FrozenCohort["members"][number],
      ) => {
        const completed = checkpoints.get(member.paperBetId);
        if (completed) return completed;
        let failure: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1)
          try {
            const value = await this.evidence.resolve(
              member,
              input.cohort.cutoff,
            );
            checkpoints.set(member.paperBetId, value);
            return value;
          } catch (error) {
            failure = error;
          }
        throw failure;
      };
      for (let offset = 0; offset < input.cohort.members.length; offset += 10)
        resolved.push(
          ...(await Promise.all(
            input.cohort.members
              .slice(offset, offset + 10)
              .map((member) => resolveWithRetry(member)),
          )),
        );
      const refsById = new Map<string, RetrospectiveEvidenceRef>();
      for (const ref of resolved.flatMap((item) => item.refs)) {
        const existing = refsById.get(ref.id);
        if (existing && stableCohortValue(existing) !== stableCohortValue(ref))
          throw new Error("retrospective-evidence-id-conflict");
        refsById.set(ref.id, ref);
      }
      const refs = [...refsById.values()];
      const evidence = freezeRetrospectiveEvidence({
        evaluationCutoff: input.cohort.cutoff,
        refs,
      });
      const retrospectiveId = `retrospective:${sha256Hex(stableCohortValue({ cohortId: input.cohort.cohortId }))}`;
      const replay = await this.repository.getByReport(
        retrospectiveId,
        input.report.reportId,
      );
      if (replay) {
        const rebuilt = buildRetrospective({
          cohortId: input.cohort.cohortId,
          reportId: input.report.reportId,
          reportRevision: input.report.revision,
          version: replay.version,
          ...(replay.predecessorVersionId
            ? { predecessorVersionId: replay.predecessorVersionId }
            : {}),
          createdAt: replay.createdAt,
          evidence,
          members: resolved.map((item) => item.member),
          reportMetrics: {
            units: input.report.metrics.units,
            roi: input.report.metrics.roi,
          },
        });
        if (stableCohortValue(rebuilt) !== stableCohortValue(replay))
          throw new Error("retrospective-replay-content-conflict");
        this.metrics?.emit({
          RetrospectiveReplays: 1,
          RetrospectiveLatency: Date.now() - started,
        });
        return replay;
      }
      let stored: RetrospectiveVersion | undefined;
      for (let attempt = 0; attempt < 3 && !stored; attempt += 1) {
        const predecessor = await this.repository.getCurrent(retrospectiveId);
        const value = buildRetrospective({
          cohortId: input.cohort.cohortId,
          reportId: input.report.reportId,
          reportRevision: input.report.revision,
          version: (predecessor?.version ?? 0) + 1,
          ...(predecessor
            ? { predecessorVersionId: predecessor.versionId }
            : {}),
          createdAt: input.createdAt,
          evidence,
          members: resolved.map((item) => item.member),
          reportMetrics: {
            units: input.report.metrics.units,
            roi: input.report.metrics.roi,
          },
        });
        try {
          stored = await this.repository.putVersion(value);
        } catch (error) {
          const racedReplay = await this.repository.getByReport(
            retrospectiveId,
            input.report.reportId,
          );
          if (racedReplay) {
            this.metrics?.emit({
              RetrospectiveReplays: 1,
              RetrospectiveLatency: Date.now() - started,
            });
            return racedReplay;
          }
          if (attempt === 2) throw error;
        }
      }
      if (!stored) throw new Error("retrospective-version-race-exhausted");
      this.metrics?.emit({
        RetrospectivesBuilt: 1,
        RetrospectiveMembers: stored.memberCount,
        RetrospectiveCandidates: stored.candidates.length,
        RetrospectiveLatency: Date.now() - started,
      });
      return stored;
    } catch (error) {
      this.metrics?.emit({
        RetrospectiveFailures: 1,
        ...(error instanceof Error &&
        (error.message.includes("invalid") ||
          error.message.includes("conflict") ||
          error.message.includes("binding"))
          ? { RetrospectiveValidationFailures: 1 }
          : {}),
        RetrospectiveLatency: Date.now() - started,
      });
      throw error;
    }
  }
}
