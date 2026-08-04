import { describe, expect, it } from "vitest";

import {
  mlbAnalysisPolicy,
  mlbFindTheEdgeStrategy,
  mlbModule,
} from "./mlb/definition";
import { nbaModule, nflModule, tennisModule } from "./planned/definitions";
import { resolveAnalysisMarket } from "./shared/analysis";
import {
  soccerAnalysisPolicy,
  soccerFindTheEdgeStrategy,
  soccerModule,
} from "./soccer/definition";

describe("sport-owned analysis policies", () => {
  it("supports canonical MLB spread while preserving the legacy run-line alias", () => {
    expect(
      mlbModule.markets.find((market) => market.key === "spread")?.displayName,
    ).toBe("Run Line");
    expect(mlbModule.markets.some((market) => market.key === "run_line")).toBe(
      false,
    );
    expect(
      resolveAnalysisMarket(mlbAnalysisPolicy, "run_line", "two-way")
        ?.marketKey,
    ).toBe("spread");
    expect(mlbFindTheEdgeStrategy.prohibitedMarketKeys).toContain("spread");
    expect(
      mlbAnalysisPolicy.markets.some((market) => market.marketKey === "spread"),
    ).toBe(true);
  });

  it("models soccer two-way, three-way draw, and finite-point spread mechanics", () => {
    expect(
      resolveAnalysisMarket(soccerAnalysisPolicy, "moneyline", "two-way")
        ?.selectionKinds,
    ).not.toContain("draw");
    expect(
      resolveAnalysisMarket(soccerAnalysisPolicy, "moneyline", "three-way")
        ?.selectionKinds,
    ).toContain("draw");
    expect(
      resolveAnalysisMarket(soccerAnalysisPolicy, "spread", "two-way")
        ?.requiresPoint,
    ).toBe(true);
    expect(soccerModule.markets.some((market) => market.key === "spread")).toBe(
      true,
    );
    expect(
      soccerModule.markets.some((market) =>
        ["to_advance", "three_way_moneyline"].includes(market.key),
      ),
    ).toBe(false);
    expect(soccerFindTheEdgeStrategy.approvedMarketKeys).toContain("moneyline");
    expect(
      soccerAnalysisPolicy.markets.find(
        (market) => market.marketKey === "spread",
      )?.pointPolicy,
    ).toEqual({ minimum: -10, maximum: 10, increment: 0.25, precision: 2 });
  });

  it.each([tennisModule, nflModule, nbaModule])(
    "keeps $metadata.displayName planned and disabled",
    (module) => {
      expect(module.metadata.maturity).toBe("planned");
      expect(module.analysisPolicy).toMatchObject({
        enabled: false,
        plannedReason: "planned-module-disabled",
      });
      expect("validateScoutOutput" in module).toBe(false);
      expect(typeof module.validateLegacyScoutReport).toBe("function");
    },
  );
});
