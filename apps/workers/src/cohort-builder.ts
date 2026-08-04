import {
  stableCohortValue,
  type CohortDefinition,
  type CohortMember,
  type FrozenCohort,
} from "@find-the-edge/domain";
import type { CohortRepository } from "@find-the-edge/database";
export interface CohortMemberSource {
  list(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly CohortMember[];
    readonly nextCursor?: string;
  }>;
}
export interface PerformanceMetricSink {
  emit(metric: Readonly<Record<string, string | number>>): void;
}
export class CohortBuilder {
  constructor(
    private readonly source: CohortMemberSource,
    private readonly repository: CohortRepository,
    private readonly metrics?: PerformanceMetricSink,
  ) {}
  async build(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly pageSize?: number;
  }): Promise<FrozenCohort> {
    const started = Date.now();
    try {
      const cohort = await this.buildCohort(input);
      this.metrics?.emit({ CohortBuildLatency: Date.now() - started });
      return cohort;
    } catch (error) {
      this.metrics?.emit({
        CohortBuildFailures: 1,
        CohortBuildLatency: Date.now() - started,
      });
      throw error;
    }
  }
  private async buildCohort(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly pageSize?: number;
  }): Promise<FrozenCohort> {
    const members: CohortMember[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.source.list({
        definition: input.definition,
        cutoff: input.cutoff,
        limit: input.pageSize ?? 50,
        ...(cursor ? { cursor } : {}),
      });
      members.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        throw new Error("cohort-source-cursor-cycle");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (new Set(members.map((m) => m.paperBetId)).size !== members.length)
      throw new Error("cohort-source-duplicate");
    const cohort = await this.repository.putCohort({
      definition: input.definition,
      cutoff: input.cutoff,
      members,
    });
    this.metrics?.emit(cohortBuildMetric(cohort));
    return cohort;
  }
}
export const cohortBuildMetric = (cohort: FrozenCohort) => ({
  CohortBuilds: 1,
  CohortMembers: cohort.members.length,
  CohortIdentity: cohort.cohortId,
  EvidenceDigest: cohort.membershipDigest,
  SafeMaterial: stableCohortValue({
    cutoff: cohort.cutoff,
    count: cohort.members.length,
  }),
});
