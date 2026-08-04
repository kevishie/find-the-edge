import {
  sha256Hex,
  stableCohortValue,
  type FrozenCohort,
} from "@find-the-edge/domain";
import type {
  CohortRepository,
  PerformanceEvidenceRepository,
  StoredPerformanceReport,
} from "@find-the-edge/database";
import {
  computePerformance,
  type PerformanceDecision,
  type PerformanceReportMetrics,
} from "@find-the-edge/odds";
import type { PerformanceMetricSink } from "./cohort-builder.js";
export interface PerformanceEvidenceSource {
  resolve(
    member: FrozenCohort["members"][number],
    cutoff: string,
  ): Promise<PerformanceDecision>;
}
export class ExactPerformanceEvidenceAdapter implements PerformanceEvidenceSource {
  constructor(private readonly evidence: PerformanceEvidenceRepository) {}
  async resolve(member: FrozenCohort["members"][number], cutoff: string) {
    const frozen = await this.evidence.resolve(member, cutoff),
      probability = frozen.evaluation.manifest.probability;
    const estimatedProbability = probability.point ?? probability.minimum;
    if (estimatedProbability === undefined)
      throw new Error("performance-probability-missing");
    return {
      id: member.paperBetId,
      createdAt: frozen.evaluation.createdAt,
      outcome: frozen.grade.outcome,
      profit: frozen.grade.profit,
      americanOdds: frozen.opening.americanOdds,
      estimatedProbability,
      ...(frozen.closing
        ? { closingAmericanOdds: frozen.closing.americanOdds }
        : {
            clvUnavailableReason:
              frozen.clvUnavailableReason ?? "closing-price-missing",
          }),
    };
  }
}
export class PerformanceReportBuilder {
  constructor(
    private readonly evidence: PerformanceEvidenceSource,
    private readonly repository: CohortRepository,
    private readonly telemetry?: PerformanceMetricSink,
  ) {}
  async build(input: {
    readonly cohort: FrozenCohort;
    readonly revision: number;
    readonly createdAt: string;
  }): Promise<StoredPerformanceReport<PerformanceReportMetrics>> {
    const started = Date.now();
    try {
      const report = await this.buildReport(input);
      this.telemetry?.emit({ PerformanceReportLatency: Date.now() - started });
      return report;
    } catch (error) {
      this.telemetry?.emit({
        PerformanceReportFailures: 1,
        PerformanceReportLatency: Date.now() - started,
      });
      throw error;
    }
  }
  private async buildReport(input: {
    readonly cohort: FrozenCohort;
    readonly revision: number;
    readonly createdAt: string;
  }): Promise<StoredPerformanceReport<PerformanceReportMetrics>> {
    const decisions: PerformanceDecision[] = [];
    for (let offset = 0; offset < input.cohort.members.length; offset += 10)
      decisions.push(
        ...(await Promise.all(
          input.cohort.members
            .slice(offset, offset + 10)
            .map((member) =>
              this.evidence.resolve(member, input.cohort.cutoff),
            ),
        )),
      );
    decisions.sort((a, b) => a.id.localeCompare(b.id));
    const evidenceDigest = sha256Hex(
      stableCohortValue({
        members: input.cohort.members,
        decisions,
        cutoff: input.cohort.cutoff,
        revision: input.revision,
      }),
    );
    const report = await this.repository.putReport({
      cohortId: input.cohort.cohortId,
      cutoff: input.cohort.cutoff,
      evidenceDigest,
      revision: input.revision,
      createdAt: input.createdAt,
      facets: {
        sports: input.cohort.definition.filters.sports ?? [],
        leagues: input.cohort.definition.filters.leagues ?? [],
        markets: input.cohort.definition.filters.markets ?? [],
        oddsBands: input.cohort.definition.filters.oddsBands ?? [],
        strategyVersions:
          input.cohort.definition.filters.strategyVersions ?? [],
        modelVersions: input.cohort.definition.filters.modelVersions ?? [],
      },
      metrics: computePerformance(decisions),
    });
    this.telemetry?.emit({
      PerformanceReports: 1,
      PerformanceDecisions: decisions.length,
      ReportIdentity: report.reportId,
      SampleCaution: report.metrics.sampleCaution,
      ...Object.fromEntries(
        Object.entries(report.metrics.clv.unavailableReasons).map(
          ([reason, count]) => [`ClvUnavailable_${reason}`, count],
        ),
      ),
      ...Object.fromEntries(
        (["won", "lost", "push", "void", "unresolved"] as const).map(
          (outcome) => [
            `Graded_${outcome}`,
            decisions.filter((decision) => decision.outcome === outcome).length,
          ],
        ),
      ),
    });
    return report;
  }
}
