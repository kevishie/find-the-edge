import { describe, expect, it } from "vitest";
import {
  MemoryStrategyExperimentRepository,
  StrategyExperimentConflictError,
} from "./strategy-experiment-repository.js";
import {
  createStrategyExperiment,
  freezeExperimentWindow,
  freezePromotionPolicy,
  freezeStrategyEvidence,
  type StrategyArtifact,
} from "@find-the-edge/domain";
const a = (version: string): StrategyArtifact => ({
  strategyId: "fte",
  version,
  digest: version.repeat(64),
  deployedRevision: version,
  deployed: true,
  frozenAt: "2026-01-01T00:00:00.000Z",
});
const policy = freezePromotionPolicy({
  id: "p",
  version: "1",
  rules: [
    "sample",
    "roi",
    "roi-lower-bound",
    "clv",
    "calibration-error",
    "drawdown",
    "baseline-regression",
  ].map((metric) => ({
    metric: metric as never,
    operator: "gte" as const,
    threshold: 0,
  })),
});
const make = () => {
  const baseline = a("a"),
    challenger = a("b"),
    train = freezeExperimentWindow({
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-02-01T00:00:00.000Z",
      eventIds: ["t"],
      memberIds: ["t"],
    }),
    tune = freezeExperimentWindow({
      startsAt: "2026-02-01T00:00:00.000Z",
      endsAt: "2026-03-01T00:00:00.000Z",
      eventIds: ["u"],
      memberIds: ["u"],
    }),
    holdout = freezeExperimentWindow({
      startsAt: "2026-03-01T00:00:00.000Z",
      endsAt: "2026-04-01T00:00:00.000Z",
      eventIds: ["h"],
      memberIds: ["h"],
    });
  const evidence = (strategy: StrategyArtifact) =>
    freezeStrategyEvidence({
      strategy,
      reportId: `performance-report:${"c".repeat(64)}`,
      reportRevision: 1,
      eventIds: ["h"],
      memberIds: ["h"],
      resultEvidenceIds: ["r"],
      metrics: {
        sample: 1,
        roi: 1,
        "roi-lower-bound": 1,
        clv: 1,
        "calibration-error": 1,
        drawdown: 1,
        "baseline-regression": 1,
      },
    });
  return {
    baseline,
    challenger,
    experiment: createStrategyExperiment({
      baseline,
      challenger,
      train,
      tune,
      holdout,
      baselineEvidence: evidence(baseline),
      challengerEvidence: evidence(challenger),
      policy,
      priorEvidenceDigests: [],
      createdAt: "2026-04-02T00:00:00.000Z",
    }),
  };
};
describe("strategy experiment repository", () => {
  it("preserves immutable evidence and exact approval replay", async () => {
    const repo = new MemoryStrategyExperimentRepository(),
      { baseline, challenger, experiment } = make();
    await repo.putArtifact(baseline);
    await repo.putArtifact(challenger);
    await repo.putExperiment(experiment);
    await expect(
      repo.putExperiment({
        ...experiment,
        createdAt: "2026-04-03T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(StrategyExperimentConflictError);
    const input = {
      experimentId: experiment.experimentId,
      promoterId: "human",
      reason: "evidence reviewed",
      decidedAt: "2026-04-03T00:00:00.000Z",
      idempotencyKey: "approval-1",
      expectedStateVersion: 1,
      expectedDigest: experiment.contentDigest,
      artifactDigest: challenger.digest,
    };
    const first = await repo.approve(input);
    expect(await repo.approve(input)).toEqual(first);
    const activation = await repo.activate({
      experimentId: experiment.experimentId,
      strategyId: "fte",
      artifactVersion: "b",
      artifactDigest: challenger.digest,
      kind: "promotion",
      effectiveAt: "2026-04-04T00:00:00.000Z",
      actorId: "human",
      reason: "promote",
      idempotencyKey: "activate-1",
      expectedActivationId: null,
    });
    expect(
      (await repo.resolveActive("fte", "2026-04-05T00:00:00.000Z"))
        ?.activationId,
    ).toBe(activation.activationId);
  });
});
