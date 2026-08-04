import {
  sha256Hex,
  stableCohortValue,
  type SportKey,
} from "@find-the-edge/domain";
import type { StrategyArtifact } from "@find-the-edge/domain";

import { mlbFindTheEdgeStrategy } from "./mlb/definition";
import type { StrategyDefinition } from "./shared/contracts";
import { soccerFindTheEdgeStrategy } from "./soccer/definition";

export class StrategyRegistry {
  readonly #strategies = new Map<SportKey, StrategyDefinition>();
  readonly #artifacts = new Map<string, StrategyArtifact>();

  register(strategy: StrategyDefinition): void {
    if (this.#strategies.has(strategy.sportKey)) {
      throw new Error(`Strategy already registered: ${strategy.sportKey}`);
    }
    this.#strategies.set(strategy.sportKey, strategy);
  }

  find(sportKey: SportKey | string): StrategyDefinition | undefined {
    return this.#strategies.get(sportKey as SportKey);
  }

  registerArtifact(artifact: StrategyArtifact): void {
    const key = `${artifact.strategyId}\0${artifact.version}`;
    const current = this.#artifacts.get(key);
    if (current && current.digest !== artifact.digest)
      throw new Error("strategy-artifact-version-conflict");
    this.#artifacts.set(key, Object.freeze({ ...artifact }));
  }

  findArtifact(
    strategyId: string,
    version: string,
  ): StrategyArtifact | undefined {
    return this.#artifacts.get(`${strategyId}\0${version}`);
  }
}

export const strategyRegistry = new StrategyRegistry();
strategyRegistry.register(mlbFindTheEdgeStrategy);
strategyRegistry.register(soccerFindTheEdgeStrategy);
for (const strategy of [mlbFindTheEdgeStrategy, soccerFindTheEdgeStrategy])
  strategyRegistry.registerArtifact({
    strategyId: strategy.id,
    version: strategy.version,
    digest: sha256Hex(stableCohortValue(strategy)),
    deployedRevision: `registry-${strategy.version}`,
    deployed: true,
    frozenAt: "2026-08-04T00:00:00.000Z",
  });
