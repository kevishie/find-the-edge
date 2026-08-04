import { describe, expect, it } from "vitest";
import {
  createStrategyExperiment,
  evaluatePromotionGates,
  freezeExperimentWindow,
  freezePromotionPolicy,
  freezeStrategyEvidence,
  type StrategyArtifact,
} from "./strategy-experiment.js";

const artifact = (version: string): StrategyArtifact => ({
  strategyId: "find-the-edge",
  version,
  digest: version.repeat(64).slice(0, 64),
  deployedRevision: `rev-${version}`,
  deployed: true,
  frozenAt: "2026-01-01T00:00:00.000Z",
});
const window = (startsAt: string, endsAt: string, id: string) =>
  freezeExperimentWindow({
    startsAt,
    endsAt,
    eventIds: [`event-${id}`],
    memberIds: [`member-${id}`],
  });
const policy = freezePromotionPolicy({
  id: "promotion",
  version: "1",
  rules: [
    { metric: "sample", operator: "gte", threshold: 1 },
    { metric: "roi", operator: "gte", threshold: 0 },
    { metric: "roi-lower-bound", operator: "gte", threshold: -1 },
    { metric: "clv", operator: "gt", threshold: 0 },
    { metric: "calibration-error", operator: "lte", threshold: 1 },
    { metric: "drawdown", operator: "lte", threshold: 1 },
    { metric: "baseline-regression", operator: "gte", threshold: 0 },
  ],
});
const evidence = (strategy: StrategyArtifact, eventId: string) =>
  freezeStrategyEvidence({
    strategy,
    reportId: `performance-report:${"a".repeat(64)}`,
    reportRevision: 1,
    eventIds: [eventId],
    memberIds: ["member-holdout"],
    resultEvidenceIds: ["result-1"],
    metrics: {
      sample: 1,
      roi: 0,
      "roi-lower-bound": -1,
      clv: 0.1,
      "calibration-error": 1,
      drawdown: 1,
      "baseline-regression": 0,
    },
  });

describe("strategy experiment", () => {
  it("is byte-reproducible and passes inclusive boundaries", () => {
    const train = window(
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        "train",
      ),
      tune = window(
        "2026-02-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "tune",
      ),
      holdout = window(
        "2026-03-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
        "holdout",
      ),
      baseline = artifact("a"),
      challenger = artifact("b");
    const input = {
      baseline,
      challenger,
      train,
      tune,
      holdout,
      baselineEvidence: evidence(baseline, "event-holdout"),
      challengerEvidence: evidence(challenger, "event-holdout"),
      policy,
      priorEvidenceDigests: [],
      createdAt: "2026-04-02T00:00:00.000Z",
    };
    expect(createStrategyExperiment(input)).toEqual(
      createStrategyExperiment(input),
    );
    expect(createStrategyExperiment(input).state).toBe("awaiting-approval");
  });
  it("fails closed for overlap, reuse, and missing metrics", () => {
    expect(
      evaluatePromotionGates(policy, {}).every(
        (gate) => !gate.passed && gate.reason === "metric-unavailable",
      ),
    ).toBe(true);
    const train = window(
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        "same",
      ),
      tune = window(
        "2026-02-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "tune",
      ),
      holdout = freezeExperimentWindow({
        startsAt: "2026-03-01T00:00:00.000Z",
        endsAt: "2026-04-01T00:00:00.000Z",
        eventIds: ["event-same"],
        memberIds: ["member-holdout"],
      }),
      baseline = artifact("a"),
      challenger = artifact("b");
    const result = createStrategyExperiment({
      baseline,
      challenger,
      train,
      tune,
      holdout,
      baselineEvidence: evidence(baseline, "event-same"),
      challengerEvidence: evidence(challenger, "event-same"),
      policy,
      priorEvidenceDigests: [tune.digest, holdout.digest],
      createdAt: "2026-04-02T00:00:00.000Z",
    });
    expect(result.state).toBe("failed");
    expect(result.failureReasons).toContain("window-overlap");
    expect(result.failureReasons).toContain("holdout-evidence-reused");
    expect(result.failureReasons).toContain("tune-evidence-reused");
  });
});
