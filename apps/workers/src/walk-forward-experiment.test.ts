import { describe, expect, it } from "vitest";
import { MemoryStrategyExperimentRepository } from "@find-the-edge/database";
import {
  freezeExperimentWindow,
  freezePromotionPolicy,
  freezeStrategyEvidence,
  type StrategyArtifact,
} from "@find-the-edge/domain";
import { WalkForwardExperimentBuilder } from "./walk-forward-experiment.js";
describe("walk-forward experiment", () => {
  it("materializes real paired evidence and stops for human approval", async () => {
    const repo = new MemoryStrategyExperimentRepository(),
      artifact = (version: string): StrategyArtifact => ({
        strategyId: "fte",
        version,
        digest: version.repeat(64),
        deployedRevision: version,
        deployed: true,
        frozenAt: "2026-01-01T00:00:00.000Z",
      }),
      baseline = artifact("a"),
      challenger = artifact("b"),
      window = (from: string, to: string, id: string) =>
        freezeExperimentWindow({
          startsAt: from,
          endsAt: to,
          eventIds: [id],
          memberIds: [id],
        }),
      train = window(
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        "t",
      ),
      tune = window(
        "2026-02-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "u",
      ),
      holdout = window(
        "2026-03-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
        "h",
      ),
      evidence = (strategy: StrategyArtifact) =>
        freezeStrategyEvidence({
          strategy,
          reportId: `performance-report:${"d".repeat(64)}`,
          reportRevision: 1,
          eventIds: ["h"],
          memberIds: ["h"],
          resultEvidenceIds: ["result-real"],
          metrics: {
            sample: 1,
            roi: 1,
            "roi-lower-bound": 1,
            clv: 1,
            "calibration-error": 0,
            drawdown: 0,
            "baseline-regression": 1,
          },
        }),
      policy = freezePromotionPolicy({
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
    const result = await new WalkForwardExperimentBuilder({
      repository: repo,
      now: () => new Date("2026-04-02T00:00:00.000Z"),
    }).build({
      baseline,
      challenger,
      train,
      tune,
      holdout,
      baselineEvidence: evidence(baseline),
      challengerEvidence: evidence(challenger),
      policy,
    });
    expect(result.state).toBe("awaiting-approval");
    expect(await repo.listAudit(result.experimentId)).toEqual([]);
    const reused = await new WalkForwardExperimentBuilder({
      repository: repo,
      now: () => new Date("2026-04-03T00:00:00.000Z"),
    }).build({
      baseline,
      challenger,
      train,
      tune,
      holdout,
      baselineEvidence: evidence(baseline),
      challengerEvidence: evidence(challenger),
      policy,
    });
    expect(reused.state).toBe("failed");
    expect(reused.failureReasons).toEqual([
      "holdout-evidence-reused",
      "tune-evidence-reused",
    ]);
    expect(await repo.getExperiment(reused.experimentId)).toEqual(reused);
  });
});
