import type { SportKey } from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";

import { mlbModule } from "./mlb/definition";
import { SportRegistry, sportRegistry } from "./registry";
import { createDeclarativeSportModule } from "./shared/create-module";
import { validateStrategy } from "./shared/strategy";
import { strategyRegistry } from "./strategy-registry";

describe("sport registry", () => {
  it("registers the initial modules with honest maturity", () => {
    expect(
      sportRegistry
        .list()
        .map((module) => [module.key, module.metadata.maturity]),
    ).toEqual([
      ["mlb", "beta"],
      ["soccer", "experimental"],
      ["tennis", "planned"],
      ["nfl", "planned"],
      ["nba", "planned"],
      ["ncaaf", "planned"],
    ]);
  });

  it("adds a test sport without changing core domain code", () => {
    const registry = new SportRegistry();
    const module = createDeclarativeSportModule({
      ...mlbModule,
      key: "test-sport" as SportKey,
      metadata: { ...mlbModule.metadata, displayName: "Test Sport" },
    });
    registry.register(module);
    expect(registry.get("test-sport")).toBe(module);
  });

  it("rejects duplicate registration", () => {
    const registry = new SportRegistry();
    registry.register(mlbModule);
    expect(() => registry.register(mlbModule)).toThrow("already registered");
  });
});

describe("strategy validation", () => {
  it("accepts module-supported policy and rejects invented markets", () => {
    const valid = validateStrategy(
      {
        id: "test",
        sportKey: mlbModule.key,
        version: "1.0.0",
        approvedMarketKeys: ["moneyline"],
        prohibitedMarketKeys: ["spread"],
        minimumEv: 0.02,
        minimumComparisonBooks: 3,
        maximumPriceAgeMinutes: 15,
      },
      mlbModule,
    );
    expect(valid.valid).toBe(true);

    expect(
      validateStrategy(
        { ...valid.value!, approvedMarketKeys: ["invented_market"] },
        mlbModule,
      ).errors,
    ).toContain("Approved market is not defined by module: invented_market");
  });
});

describe("strategy registry", () => {
  it("resolves active strategies and leaves planned modules unpublished", () => {
    expect(strategyRegistry.find("mlb")?.version).toBe("2.1.0");
    expect(strategyRegistry.find("soccer")?.version).toBe("1.0.0-experimental");
    expect(strategyRegistry.find("tennis")).toBeUndefined();
  });
});
