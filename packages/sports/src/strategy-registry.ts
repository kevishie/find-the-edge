import type { SportKey } from "@find-the-edge/domain";

import { mlbFindTheEdgeStrategy } from "./mlb/definition";
import type { StrategyDefinition } from "./shared/contracts";
import { soccerFindTheEdgeStrategy } from "./soccer/definition";

export class StrategyRegistry {
  readonly #strategies = new Map<SportKey, StrategyDefinition>();

  register(strategy: StrategyDefinition): void {
    if (this.#strategies.has(strategy.sportKey)) {
      throw new Error(`Strategy already registered: ${strategy.sportKey}`);
    }
    this.#strategies.set(strategy.sportKey, strategy);
  }

  find(sportKey: SportKey | string): StrategyDefinition | undefined {
    return this.#strategies.get(sportKey as SportKey);
  }
}

export const strategyRegistry = new StrategyRegistry();
strategyRegistry.register(mlbFindTheEdgeStrategy);
strategyRegistry.register(soccerFindTheEdgeStrategy);
