import type { StrategyExperimentRepository } from "@find-the-edge/database";

export class StrategyPromotionService {
  constructor(private readonly repository: StrategyExperimentRepository) {}
  approve(input: Parameters<StrategyExperimentRepository["approve"]>[0]) {
    return this.repository.approve(input);
  }
  async promote(
    input: Omit<
      Parameters<StrategyExperimentRepository["activate"]>[0],
      "kind"
    >,
  ) {
    return this.repository.activate({ ...input, kind: "promotion" });
  }
  async rollback(
    input: Omit<
      Parameters<StrategyExperimentRepository["activate"]>[0],
      "kind"
    >,
  ) {
    return this.repository.activate({ ...input, kind: "rollback" });
  }
}
