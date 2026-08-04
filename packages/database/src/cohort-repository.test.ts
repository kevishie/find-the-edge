import { describe, expect, it } from "vitest";
import { MemoryCohortRepository } from "./cohort-repository.js";
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
describe("cohort repository", () =>
  it("persists reports", async () => {
    const r = new MemoryCohortRepository(),
      c = await r.putCohort({
        definition,
        cutoff: "2026-08-02T00:00:00.000Z",
        members: [],
      });
    expect((await r.listCohorts({ limit: 1 })).items).toHaveLength(1);
    const p = await r.putReport({
      facets: {
        sports: [],
        leagues: [],
        markets: [],
        oddsBands: [],
        strategyVersions: [],
        modelVersions: [],
      },
      cohortId: c.cohortId,
      cutoff: c.cutoff,
      evidenceDigest: "a".repeat(64),
      revision: 1,
      createdAt: "2026-08-02T00:00:00.000Z",
      metrics: { roi: null },
    });
    expect((await r.getReport(p.reportId))?.metrics).toEqual({ roi: null });
  }));
