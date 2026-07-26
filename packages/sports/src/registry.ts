import type { SportKey } from "@find-the-edge/domain";

import { mlbModule } from "./mlb/definition";
import { ncaafModule, nflModule, tennisModule } from "./planned/definitions";
import type { SportModule } from "./shared/contracts";
import { soccerModule } from "./soccer/definition";

export class SportRegistry {
  readonly #modules = new Map<SportKey, SportModule>();

  register(module: SportModule): void {
    if (this.#modules.has(module.key)) {
      throw new Error(`Sport module already registered: ${module.key}`);
    }
    this.#modules.set(module.key, module);
  }

  get(key: SportKey | string): SportModule {
    const module = this.#modules.get(key as SportKey);
    if (!module) throw new Error(`Unknown sport module: ${key}`);
    return module;
  }

  list(): SportModule[] {
    return [...this.#modules.values()];
  }
}

export const sportRegistry = new SportRegistry();
for (const module of [
  mlbModule,
  soccerModule,
  tennisModule,
  nflModule,
  ncaafModule,
]) {
  sportRegistry.register(module);
}
