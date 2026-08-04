import { describe, expect, it, vi } from "vitest";
import { createPerformanceScheduledHandler } from "./performance-scheduled-runtime";

describe("performance scheduled runtime", () => {
  it("reuses the report when a retry follows a retrospective-only failure", async () => {
    const cohort = {
      cohortId: `cohort:${"a".repeat(64)}`,
      cutoff: "2026-08-04T00:00:00.000Z",
      members: [{ paperBetId: "paper-1" }],
    };
    const reports: unknown[] = [];
    const report = {
      reportId: `performance-report:${"b".repeat(64)}`,
      cohortId: cohort.cohortId,
      cutoff: cohort.cutoff,
      revision: 1,
      metrics: {},
    };
    const buildReport = vi.fn(() => {
      reports.push(report);
      return Promise.resolve(report);
    });
    const buildRetrospective = vi
      .fn()
      .mockRejectedValueOnce(new Error("retrospective-write-failed"))
      .mockResolvedValueOnce({
        versionId: `retrospective-version:${"c".repeat(64)}`,
      });
    const handler = createPerformanceScheduledHandler({
      cohorts: { build: vi.fn(() => Promise.resolve(cohort)) } as never,
      reports: { build: buildReport } as never,
      repository: {
        listReports: vi.fn(() => Promise.resolve({ items: [...reports] })),
      } as never,
      retrospectives: { build: buildRetrospective } as never,
    });
    const event = { time: "2026-08-04T00:00:00.000Z" };
    await expect(handler(event)).rejects.toThrow("retrospective-write-failed");
    await expect(handler(event)).resolves.toMatchObject({
      reportId: report.reportId,
    });
    expect(buildReport).toHaveBeenCalledTimes(1);
    expect(buildRetrospective).toHaveBeenCalledTimes(2);
  });
  it("exhausts every page and rejects duplicate cohort reports across pages", async () => {
    const cohort = {
      cohortId: `cohort:${"a".repeat(64)}`,
      cutoff: "2026-08-04T00:00:00.000Z",
      members: [],
    };
    const report = { cohortId: cohort.cohortId, reportId: "one", revision: 1 };
    let page = 0;
    const handler = createPerformanceScheduledHandler({
      cohorts: { build: vi.fn(() => Promise.resolve(cohort)) } as never,
      reports: { build: vi.fn() } as never,
      repository: {
        listReports: vi.fn(() =>
          Promise.resolve(
            page++ === 0
              ? { items: [report], nextCursor: "next" }
              : { items: [{ ...report, reportId: "two" }] },
          ),
        ),
      } as never,
    });
    await expect(handler({ time: "2026-08-04T00:00:00.000Z" })).rejects.toThrow(
      "performance-cohort-report-duplicate",
    );
  });
});
