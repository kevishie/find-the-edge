import { describe, expect, it } from "vitest";
import { freezeRetrospectiveEvidence } from "@find-the-edge/domain";
import { buildRetrospective } from "./retrospective";
const h = (value: string) => value.repeat(64);
const evidence = freezeRetrospectiveEvidence({
  evaluationCutoff: "2026-01-02T00:00:00.000Z",
  refs: [
    {
      id: "evaluation",
      kind: "evaluation",
      layer: "decision-time",
      decisionCutoff: "2026-01-01T00:00:00.000Z",
      observedAt: "2025-12-31T00:00:00.000Z",
      digest: h("a"),
    },
    {
      id: "grade",
      kind: "grade",
      layer: "post-decision",
      decisionCutoff: "2026-01-01T00:00:00.000Z",
      observedAt: "2026-01-02T00:00:00.000Z",
      digest: h("b"),
    },
  ],
});
describe("retrospective construction", () => {
  it("is order-independent and does not label losses as false positives", () => {
    const base = {
      cohortId: `cohort:${h("a")}`,
      reportId: `performance-report:${h("b")}`,
      reportRevision: 1,
      version: 1,
      createdAt: "2026-01-03T00:00:00.000Z",
      evidence,
      reportMetrics: { units: 0, roi: 0 },
      members: [
        {
          memberId: "2",
          sport: "baseball",
          league: "mlb",
          market: "spread",
          outcome: "won" as const,
          profit: 1,
          evidenceRefIds: ["grade"],
        },
        {
          memberId: "1",
          sport: "baseball",
          league: "mlb",
          market: "spread",
          outcome: "lost" as const,
          profit: -1,
          evidenceRefIds: ["grade"],
        },
      ],
    };
    const first = buildRetrospective(base),
      second = buildRetrospective({
        ...base,
        members: [...base.members].reverse(),
      });
    expect(first.contentDigest).toBe(second.contentDigest);
    expect(
      first.observations.some((item) => item.taxonomyCode === "false-positive"),
    ).toBe(false);
    expect(first.falseNegativeEvaluation).toBe("not-evaluable");
    expect(first.candidates).toHaveLength(0);
  });
});
