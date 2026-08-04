import {
  createStrategyExperiment,
  type ExperimentWindow,
  type PromotionGatePolicy,
  type StrategyArtifact,
  type StrategyExperiment,
  type StrategyPerformanceEvidence,
} from "@find-the-edge/domain";
import type { StrategyExperimentRepository } from "@find-the-edge/database";

export interface WalkForwardTelemetry {
  emit(event: {
    metric: "success" | "failed" | "leakage" | "gate-failed";
    count: number;
  }): void;
}
export class WalkForwardExperimentBuilder {
  constructor(
    private readonly dependencies: {
      repository: StrategyExperimentRepository;
      telemetry?: WalkForwardTelemetry;
      now?: () => Date;
    },
  ) {}
  async build(input: {
    baseline: StrategyArtifact;
    challenger: StrategyArtifact;
    train: ExperimentWindow;
    tune: ExperimentWindow;
    holdout: ExperimentWindow;
    baselineEvidence: StrategyPerformanceEvidence;
    challengerEvidence: StrategyPerformanceEvidence;
    policy: PromotionGatePolicy;
    lineageDigests?: readonly string[];
  }): Promise<StrategyExperiment> {
    const priorEvidenceDigests = (
      await Promise.all(
        [input.tune.digest, input.holdout.digest].map(async (digest) =>
          (await this.dependencies.repository.hasConsumedEvidence(
            input.challenger.strategyId,
            digest,
          ))
            ? digest
            : null,
        ),
      )
    ).filter((value): value is string => value !== null);
    const experiment = createStrategyExperiment({
      ...input,
      priorEvidenceDigests,
      createdAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
    });
    await this.dependencies.repository.putArtifact(input.baseline);
    await this.dependencies.repository.putArtifact(input.challenger);
    await this.dependencies.repository.putExperiment(experiment);
    const metric =
      experiment.state === "failed"
        ? experiment.failureReasons.length
          ? "leakage"
          : "gate-failed"
        : "success";
    try {
      this.dependencies.telemetry?.emit({ metric, count: 1 });
    } catch {
      /* safe telemetry */
    }
    return experiment;
  }
}
