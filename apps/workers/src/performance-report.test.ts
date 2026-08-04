import { describe, expect, it } from "vitest";
import { MemoryCohortRepository } from "@find-the-edge/database";
import { PerformanceReportBuilder } from "./performance-report.js";
const definition = {
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  filters: { wagerMode: "paper" as const },
  policyVersions: {
    cohort: "cohort-v1" as const,
    performance: "performance-v1" as const,
    oddsBand: "odds-band-v1" as const,
    calibration: "calibration-deciles-v1" as const,
    clv: "clv-same-book-15m-v1" as const,
  },
};
describe("report builder", () =>
  it("is idempotent", async () => {
    const repo = new MemoryCohortRepository(),
      member = {
        paperBetId: `paper-bet:${"a".repeat(64)}`,
        evaluationId: `evaluation:${"a".repeat(64)}`,
        gradeId: `paper-grade:${"a".repeat(64)}`,
        resultObservationId: `result:${"a".repeat(64)}`,
        openingSnapshotId: "a".repeat(64),
        closingSnapshotId: null,
      },
      cohort = await repo.putCohort({
        definition,
        cutoff: "2026-08-02T00:00:00.000Z",
        members: [member],
      }),
      builder = new PerformanceReportBuilder(
        {
          resolve: () =>
            Promise.resolve({
              id: "p",
              createdAt: "2026-08-01T00:00:00.000Z",
              outcome: "won",
              profit: 1,
              americanOdds: 100,
              estimatedProbability: 0.55,
            }),
        },
        repo,
      ),
      input = { cohort, revision: 1, createdAt: "2026-08-02T00:00:00.000Z" };
    expect(await builder.build(input)).toEqual(await builder.build(input));
  }));
