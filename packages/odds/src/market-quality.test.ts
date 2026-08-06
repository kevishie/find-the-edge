import { describe, expect, it } from "vitest";

import {
  detectMarketOutliers,
  scoreMarketDisagreement,
  type MarketProbabilityContribution,
} from "./market-quality";

const contribution = (
  sportsbookId: string,
  probabilities: readonly number[],
): MarketProbabilityContribution => ({ sportsbookId, probabilities });

describe("market outlier audit", () => {
  it("excludes a whole three-way book when any outcome is strictly beyond its upper-median center", () => {
    const result = detectMarketOutliers({
      selectionKeys: ["away", "draw", "home"],
      contributions: [
        contribution("a", [0.3, 0.3, 0.4]),
        contribution("b", [0.31, 0.29, 0.4]),
        contribution("divergent", [0.45, 0.25, 0.3]),
      ],
      threshold: 0.08,
    });

    expect(result).toMatchObject({
      calculationVersion: "market-outlier-v1",
      status: "available",
      issues: [],
      centers: [0.31, 0.29, 0.4],
      outlierSportsbookIds: ["divergent"],
    });
    expect(
      result.books.find(({ sportsbookId }) => sportsbookId === "divergent"),
    ).toMatchObject({
      isOutlier: true,
      outlyingSelectionKeys: ["away", "home"],
      deviations: [
        expect.closeTo(0.14, 12),
        expect.closeTo(0.04, 12),
        expect.closeTo(0.1, 12),
      ],
    });
    expect(result.provenance?.root.algorithm.version).toBe("market-outlier-v1");
    expect(result.display.centers).toEqual(["31.00%", "29.00%", "40.00%"]);
  });

  it("preserves consensus-v1 upper medians for an even roster", () => {
    const result = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.8, 0.2]),
      ],
      threshold: 0.29,
    });

    expect(result.centers).toEqual([0.8, 0.5]);
    expect(result.outlierSportsbookIds).toEqual(["a", "b"]);
  });

  it("keeps exact-threshold deviations and is invariant to contribution order", () => {
    const probabilities = [0.56, 0.44] as const;
    const exactThreshold = probabilities[0] - 0.5;
    const input = {
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("c", probabilities),
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.5, 0.5]),
      ],
      threshold: exactThreshold,
    } as const;
    const before = structuredClone(input.contributions);

    const left = detectMarketOutliers(input);
    const right = detectMarketOutliers({
      ...input,
      contributions: [...input.contributions].reverse(),
    });

    expect(left.outlierSportsbookIds).toEqual([]);
    expect(right).toEqual(left);
    expect(input.contributions).toEqual(before);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.centers)).toBe(true);
    expect(Object.isFrozen(left.books)).toBe(true);
    expect(Object.isFrozen(left.books[0])).toBe(true);
    expect(Object.isFrozen(left.books[0]?.deviations)).toBe(true);
    expect(Object.isFrozen(left.books[0]?.outlyingSelectionKeys)).toBe(true);
  });

  it("keeps mathematically exact literal-threshold deviations", () => {
    const result = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.5, 0.5]),
        contribution("boundary", [0.42, 0.58]),
      ],
      threshold: 0.08,
    });

    expect(result.outlierSportsbookIds).toEqual([]);

    const genuinelyBeyond = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.5, 0.5]),
        contribution("beyond", [0.42 - 1e-15, 0.58 + 1e-15]),
      ],
      threshold: 0.08,
    });
    expect(genuinelyBeyond.outlierSportsbookIds).toEqual(["beyond"]);

    const tinyThreshold = Number.EPSILON / 2;
    const tinyMovement = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.5, 0.5]),
        contribution("tiny", [0.5 - Number.EPSILON, 0.5 + Number.EPSILON]),
      ],
      threshold: tinyThreshold,
    });
    expect(tinyMovement.outlierSportsbookIds).toEqual(["tiny"]);
  });

  it("returns deterministic sparse and invalid states", () => {
    const sparse = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [],
      threshold: 0.08,
    });
    expect(sparse).toMatchObject({
      status: "insufficient-data",
      issues: ["insufficient-vectors"],
      centers: null,
      outlierSportsbookIds: [],
    });

    const invalid = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [contribution("A", [0.5, 0.5]), contribution("a", [0.5])],
      threshold: 0.08,
    });
    expect(invalid).toMatchObject({
      status: "invalid",
      issues: ["duplicate-sportsbook", "invalid-contribution"],
      centers: null,
      books: [],
    });
    const invalidReordered = detectMarketOutliers({
      selectionKeys: ["away", "home"],
      contributions: [contribution("a", [0.5]), contribution("A", [0.5, 0.5])],
      threshold: 0.08,
    });
    expect(invalidReordered.provenance?.root.inputHash).toBe(
      invalid.provenance?.root.inputHash,
    );

    expect(
      detectMarketOutliers({
        selectionKeys: ["away", "home"],
        contributions: [contribution("impossible", [1, 1])],
        threshold: 0.08,
      }),
    ).toMatchObject({
      status: "invalid",
      issues: ["invalid-contribution"],
    });
  });
});

describe("market disagreement", () => {
  it("scores the largest range across every outcome and retains the decisive evidence", () => {
    const result = scoreMarketDisagreement({
      selectionKeys: ["away", "draw", "home"],
      contributions: [
        contribution("a", [0.3, 0.3, 0.4]),
        contribution("b", [0.35, 0.2, 0.45]),
        contribution("c", [0.25, 0.4, 0.35]),
      ],
      warningThreshold: 0.15,
      blockThreshold: 0.2,
    });

    expect(result).toMatchObject({
      calculationVersion: "market-disagreement-v1",
      status: "available",
      issues: [],
      score: 0.2,
      decisiveSelectionKey: "draw",
      classification: "block",
      contributingSportsbookIds: ["a", "b", "c"],
      ranges: [
        {
          selectionKey: "away",
          minimumProbability: 0.25,
          maximumProbability: 0.35,
        },
        {
          selectionKey: "draw",
          minimumProbability: 0.2,
          maximumProbability: 0.4,
        },
        {
          selectionKey: "home",
          minimumProbability: 0.35,
          maximumProbability: 0.45,
        },
      ],
    });
    expect(result.ranges.map(({ range }) => range)).toEqual([
      expect.closeTo(0.1, 12),
      expect.closeTo(0.2, 12),
      expect.closeTo(0.1, 12),
    ]);
    expect(result.provenance?.root.algorithm.version).toBe(
      "market-disagreement-v1",
    );
    expect(result.display.score).toBe("20.00%");
  });

  it("uses inclusive warning/block thresholds and deterministic first-selection ties", () => {
    const warningRange = 0.55 - 0.5;
    const warning = scoreMarketDisagreement({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.55, 0.45]),
      ],
      warningThreshold: warningRange,
      blockThreshold: 0.1,
    });
    expect(warning).toMatchObject({
      score: warningRange,
      decisiveSelectionKey: "away",
      classification: "warning",
    });

    const blockRange = 0.6 - 0.5;
    const blocked = scoreMarketDisagreement({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.6, 0.4]),
      ],
      warningThreshold: 0.05,
      blockThreshold: blockRange,
    });
    expect(blocked).toMatchObject({
      score: blockRange,
      classification: "block",
    });

    const literalBoundary = scoreMarketDisagreement({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.6, 0.4]),
      ],
      warningThreshold: 0.05,
      blockThreshold: 0.1,
    });
    expect(literalBoundary.classification).toBe("block");

    const genuinelyBelow = scoreMarketDisagreement({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.6 - 1e-15, 0.4 + 1e-15]),
      ],
      warningThreshold: 0.05,
      blockThreshold: 0.1,
    });
    expect(genuinelyBelow.classification).toBe("warning");

    const identicalWithTinyThreshold = scoreMarketDisagreement({
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("a", [0.5, 0.5]),
        contribution("b", [0.5, 0.5]),
      ],
      warningThreshold: Number.EPSILON / 2,
      blockThreshold: Number.EPSILON,
    });
    expect(identicalWithTinyThreshold.classification).toBe("none");
  });

  it("is permutation invariant and deeply immutable", () => {
    const input = {
      selectionKeys: ["away", "home"],
      contributions: [
        contribution("b", [0.48, 0.52]),
        contribution("a", [0.5, 0.5]),
      ],
      warningThreshold: 0.05,
      blockThreshold: 0.1,
    } as const;
    const left = scoreMarketDisagreement(input);
    const right = scoreMarketDisagreement({
      ...input,
      contributions: [...input.contributions].reverse(),
    });

    expect(right).toEqual(left);
    expect(left.classification).toBe("none");
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.issues)).toBe(true);
    expect(Object.isFrozen(left.ranges)).toBe(true);
    expect(Object.isFrozen(left.ranges[0])).toBe(true);
    expect(Object.isFrozen(left.contributingSportsbookIds)).toBe(true);
  });

  it("returns a null score for fewer than two complete vectors", () => {
    const result = scoreMarketDisagreement({
      selectionKeys: ["away", "home"],
      contributions: [contribution("a", [0.5, 0.5])],
      warningThreshold: 0.05,
      blockThreshold: 0.1,
    });
    expect(result).toMatchObject({
      status: "insufficient-data",
      issues: ["insufficient-vectors"],
      score: null,
      decisiveSelectionKey: null,
      classification: null,
      ranges: [],
    });
  });

  it("rejects malformed threshold relationships", () => {
    expect(() =>
      scoreMarketDisagreement({
        selectionKeys: ["away", "home"],
        contributions: [],
        warningThreshold: 0.1,
        blockThreshold: 0.05,
      }),
    ).toThrow(RangeError);
  });
});
