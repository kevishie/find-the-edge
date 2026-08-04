import { scheduledPerformanceCohort } from "@find-the-edge/config";
import type { CohortBuilder } from "./cohort-builder.js";
import type { PerformanceReportBuilder } from "./performance-report.js";
import type {
  CohortRepository,
  StoredPerformanceReport,
} from "@find-the-edge/database";
import type { PerformanceReportMetrics } from "@find-the-edge/odds";
import type { RetrospectiveBuilder } from "./retrospective-builder.js";

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

async function reportForCohort(repository: CohortRepository, cohortId: string) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  let found: StoredPerformanceReport<PerformanceReportMetrics> | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await repository.listReports<PerformanceReportMetrics>({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const matches = page.items.filter((report) => report.cohortId === cohortId);
    if (matches.length > 1 || (found && matches.length))
      throw new Error("performance-cohort-report-duplicate");
    if (matches[0]) found = matches[0];
    if (!page.nextCursor) return found;
    if (seen.has(page.nextCursor))
      throw new Error("performance-report-cursor-cycle");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("performance-report-pagination-limit");
}

/** EventBridge-compatible runtime with no caller-controlled cohort policy. */
export function createPerformanceScheduledHandler(dependencies: {
  readonly cohorts: CohortBuilder;
  readonly reports: PerformanceReportBuilder;
  readonly repository: CohortRepository;
  readonly retrospectives?: RetrospectiveBuilder;
  readonly clock?: () => Date;
}) {
  return async (event?: { readonly time?: string }) => {
    const eventTime = event?.time;
    const now = eventTime
      ? new Date(eventTime)
      : (dependencies.clock ?? (() => new Date()))();
    if (
      !Number.isFinite(now.getTime()) ||
      (eventTime && now.toISOString() !== eventTime)
    )
      throw new Error("performance-schedule-time-invalid");
    const policy = scheduledPerformanceCohort(now);
    const cohort = await dependencies.cohorts.build({
      definition: policy.definition,
      cutoff: policy.cutoff,
    });
    const priorReport = await reportForCohort(
      dependencies.repository,
      cohort.cohortId,
    );
    const report: StoredPerformanceReport<PerformanceReportMetrics> =
      priorReport ??
      (await dependencies.reports.build({
        cohort,
        revision: await nextPerformanceRevision(dependencies.repository),
        createdAt: now.toISOString(),
      }));
    const retrospective =
      dependencies.retrospectives && cohort.members.length
        ? await dependencies.retrospectives.build({
            cohort,
            report,
            createdAt: now.toISOString(),
          })
        : undefined;
    return {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      cohortId: cohort.cohortId,
      reportId: report.reportId,
      ...(retrospective
        ? { retrospectiveVersionId: retrospective.versionId }
        : {}),
    };
  };
}
