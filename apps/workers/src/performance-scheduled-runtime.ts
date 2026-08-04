import { scheduledPerformanceCohort } from "@find-the-edge/config";
import type { CohortBuilder } from "./cohort-builder.js";
import type { PerformanceReportBuilder } from "./performance-report.js";
import type { CohortRepository } from "@find-the-edge/database";

export async function nextPerformanceRevision(repository: CohortRepository) {
  let cursor: string | undefined;
  let maximum = 0;
  const seen = new Set<string>();
  do {
    const page = await repository.listReports({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const report of page.items)
      maximum = Math.max(maximum, report.revision);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor))
      throw new Error("report-revision-cursor-cycle");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return maximum + 1;
}

/** EventBridge-compatible runtime with no caller-controlled cohort policy. */
export function createPerformanceScheduledHandler(dependencies: {
  readonly cohorts: CohortBuilder;
  readonly reports: PerformanceReportBuilder;
  readonly repository: CohortRepository;
  readonly clock?: () => Date;
}) {
  return async () => {
    const now = (dependencies.clock ?? (() => new Date()))();
    const policy = scheduledPerformanceCohort(now);
    const cohort = await dependencies.cohorts.build({
      definition: policy.definition,
      cutoff: policy.cutoff,
    });
    const report = await dependencies.reports.build({
      cohort,
      revision: await nextPerformanceRevision(dependencies.repository),
      createdAt: now.toISOString(),
    });
    return {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      cohortId: cohort.cohortId,
      reportId: report.reportId,
    };
  };
}
