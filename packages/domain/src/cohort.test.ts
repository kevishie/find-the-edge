import { describe, expect, it } from "vitest";
import { freezeCohort, normalizeCohortDefinition } from "./cohort.js";

const definition = () => ({
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  filters: { sports: ["mlb", "mlb"], wagerMode: "paper" as const },
  policyVersions: {
    cohort: "cohort-v1" as const,
    performance: "performance-v1" as const,
    oddsBand: "odds-band-v1" as const,
    calibration: "calibration-deciles-v1" as const,
    clv: "clv-same-book-15m-v1" as const,
  },
});

describe("cohorts", () => {
  it("normalizes filters and freezes pagination-independent membership", () => {
    expect(normalizeCohortDefinition(definition()).filters.sports).toEqual([
      "mlb",
    ]);
    const member = (id: string) => ({
      paperBetId: `paper-bet:${id.repeat(64)}`,
      evaluationId: `evaluation:${id.repeat(64)}`,
      gradeId: `paper-grade:${id.repeat(64)}`,
      resultObservationId: `result:${id.repeat(64)}`,
      openingSnapshotId: id.repeat(64),
      closingSnapshotId: null,
    });
    const first = freezeCohort({
      definition: definition(),
      cutoff: "2026-08-02T00:00:00.000Z",
      members: [member("b"), member("a")],
    });
    const second = freezeCohort({
      definition: definition(),
      cutoff: first.cutoff,
      members: [member("a"), member("b")],
    });
    expect(first).toEqual(second);
  });

  it("rejects money mode until ownership is designed", () => {
    expect(() =>
      normalizeCohortDefinition({
        ...definition(),
        filters: { wagerMode: "money" },
      }),
    ).toThrow("cohort-definition-invalid");
  });
});
