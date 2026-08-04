import { describe, expect, it } from "vitest";
import {
  createRetrospectiveVersion,
  freezeRetrospectiveEvidence,
  transitionRetrospective,
} from "./retrospective.js";

const hex = (character: string) => character.repeat(64);
const evidence = () =>
  freezeRetrospectiveEvidence({
    evaluationCutoff: "2026-01-02T00:00:00.000Z",
    refs: [
      {
        id: "grade",
        kind: "grade",
        layer: "post-decision",
        decisionCutoff: "2026-01-01T00:00:00.000Z",
        observedAt: "2026-01-02T00:00:00.000Z",
        digest: hex("b"),
      },
      {
        id: "evaluation",
        kind: "evaluation",
        layer: "decision-time",
        decisionCutoff: "2026-01-01T00:00:00.000Z",
        observedAt: "2025-12-31T00:00:00.000Z",
        digest: hex("a"),
      },
    ],
  });
const version = () =>
  createRetrospectiveVersion({
    cohortId: `cohort:${hex("a")}`,
    reportId: `performance-report:${hex("b")}`,
    reportRevision: 1,
    version: 1,
    createdAt: "2026-01-03T00:00:00.000Z",
    evidence: evidence(),
    slices: [
      {
        dimension: "outcome",
        value: "lost",
        memberCount: 1,
        wins: 0,
        losses: 1,
        pushes: 0,
        voids: 0,
        unresolved: 0,
        units: -1,
        roi: -1,
      },
    ],
    observations: [
      {
        id: "obs",
        taxonomyCode: "false-positive",
        layer: "post-decision",
        summary:
          "Qualified loss merits review; outcome alone does not establish error.",
        evidenceRefIds: ["grade"],
        memberIds: ["member"],
        confidence: "review-only",
      },
    ],
    candidates: [],
    memberCount: 1,
  });

describe("retrospective domain", () => {
  it("is deterministic across evidence input order and preserves caution", () => {
    expect(version()).toEqual(version());
    expect(version().caution).toBe("single-member");
    expect(version().falseNegativeEvaluation).toBe("not-evaluable");
  });
  it("blocks hindsight in decision-time claims", () => {
    const original = version();
    expect(() =>
      createRetrospectiveVersion({
        ...original,
        predecessorVersionId: null,
        observations: [
          {
            id: "bad",
            taxonomyCode: "model",
            layer: "decision-time",
            summary: "Result informed claim",
            evidenceRefIds: ["grade"],
            memberIds: [],
            confidence: "review-only",
          },
        ],
      }),
    ).toThrow("retrospective-observation-invalid");
  });
  it("applies one legal non-executable review transition", () => {
    const changed = transitionRetrospective(version(), {
      reviewerId: "reviewer",
      reasonCode: "approve",
      decidedAt: "2026-01-04T00:00:00.000Z",
      idempotencyKey: "request-1",
      expectedState: "draft",
      expectedStateVersion: 1,
    });
    expect(changed.version.state).toBe("approved");
    expect(
      changed.version.candidates.every((candidate) => !candidate.executable),
    ).toBe(true);
    expect(() =>
      transitionRetrospective(changed.version, {
        reviewerId: "reviewer",
        reasonCode: "reject",
        decidedAt: "2026-01-04T00:00:00.000Z",
        idempotencyKey: "request-2",
        expectedState: "approved",
        expectedStateVersion: 2,
      }),
    ).toThrow("retrospective-transition-invalid");
  });
  it("runtime-validates observation enums, candidate identity, and review reasons", () => {
    const original = version();
    expect(() =>
      createRetrospectiveVersion({
        ...original,
        observations: [
          { ...original.observations[0]!, layer: "unknown" as never },
        ],
      }),
    ).toThrow("retrospective-observation-invalid");
    const candidate = {
      kind: "strategy" as const,
      summary: "Review an independently evidenced candidate.",
      sourceObservationIds: ["obs"],
      predecessorCandidateId: null,
    };
    expect(() =>
      createRetrospectiveVersion({
        ...original,
        candidates: [candidate, candidate],
      }),
    ).toThrow("retrospective-candidate-duplicate");
    expect(() =>
      transitionRetrospective(original, {
        reviewerId: "reviewer",
        reasonCode: "unknown" as never,
        decidedAt: "2026-01-04T00:00:00.000Z",
        idempotencyKey: "request-invalid",
        expectedState: "draft",
        expectedStateVersion: 1,
      }),
    ).toThrow("retrospective-review-conflict");
  });
});
