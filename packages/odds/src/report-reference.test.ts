import {
  calculationInputHash,
  normalizeFixtureOddsObservation,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";

import {
  calculateClosingConsensusClv,
  calculateFairValue,
  calculateLineMovement,
  calculateWeightedConsensus,
  closingLineValue,
  qualifyEvaluation,
  removeVig,
  scoreMarketDisagreement,
} from "./index";
import {
  createReportCalculationReference,
  ReportCalculationReferenceError,
  validateReportCalculationReference,
} from "./report-reference";

const snapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "hardrock",
  americanOdds: 120,
  observedAt: "2026-08-07T20:00:00.000Z",
  retrievedAt: "2026-08-07T20:00:01.000Z",
});

const circaSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "circa",
  americanOdds: 110,
  observedAt: "2026-08-07T19:59:58.000Z",
  retrievedAt: "2026-08-07T20:00:00.000Z",
});

const pinnacleSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "pinnacle",
  americanOdds: 105,
  observedAt: "2026-08-07T19:59:57.000Z",
  retrievedAt: "2026-08-07T20:00:00.000Z",
});

const circaClubBSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-b",
  sportsbookId: "circa",
  americanOdds: -120,
  observedAt: "2026-08-07T19:59:58.000Z",
  retrievedAt: "2026-08-07T20:00:00.000Z",
});

const pinnacleClubBSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-b",
  sportsbookId: "pinnacle",
  americanOdds: -115,
  observedAt: "2026-08-07T19:59:57.000Z",
  retrievedAt: "2026-08-07T20:00:00.000Z",
});

const openingSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "hardrock",
  americanOdds: 120,
  observedAt: "2026-08-07T19:00:00.000Z",
  retrievedAt: "2026-08-07T19:00:01.000Z",
});

const latestSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "hardrock",
  americanOdds: 110,
  observedAt: "2026-08-07T20:00:00.000Z",
  retrievedAt: "2026-08-07T20:00:01.000Z",
});

const consensusInput = {
  targetSportsbookId: "hardrock",
  selectionKeys: ["club-a", "club-b"],
  books: [
    {
      sportsbookId: "circa",
      ageMinutes: 1,
      status: "active" as const,
      selections: [
        { selectionKey: "club-a", americanOdds: 110 },
        { selectionKey: "club-b", americanOdds: -120 },
      ],
    },
    {
      sportsbookId: "pinnacle",
      ageMinutes: 2,
      status: "active" as const,
      selections: [
        { selectionKey: "club-a", americanOdds: 105 },
        { selectionKey: "club-b", americanOdds: -115 },
      ],
    },
  ],
  policy: {
    comparisonWeights: { circa: 1.25, pinnacle: 1 },
    minimumBooks: 2,
    maximumAgeMinutes: 15,
    outlierThreshold: 0.2,
  },
};

const qualificationInput = {
  targetSportsbookId: "hardrock",
  offeredAmerican: 120,
  offeredAgeMinutes: 2,
  candidateIndex: 0,
  modelProbability: {
    estimate: 0.5,
    low: 0.5,
    high: 0.5,
    uncertainty: 0,
  },
  books: [
    { sportsbookId: "circa", ageMinutes: 1, americanOdds: [110, -120] },
    { sportsbookId: "pinnacle", ageMinutes: 2, americanOdds: [105, -115] },
  ],
  outcomeCount: 2 as const,
  policy: {
    comparisonWeights: { circa: 1.25, pinnacle: 1 },
    minimumComparisonBooks: 2,
    maximumPriceAgeMinutes: 15,
    outlierThreshold: 0.2,
    disagreementWarningThreshold: 0.05,
    disagreementBlockThreshold: 0.1,
    maximumUncertainty: 0.1,
    minimumEdge: 0.01,
    minimumExpectedValue: 0.01,
  },
};

const disagreementInput = {
  selectionKeys: ["club-a", "club-b"],
  contributions: [
    { sportsbookId: "circa", probabilities: removeVig([110, -120]) },
    { sportsbookId: "pinnacle", probabilities: removeVig([105, -115]) },
  ],
  warningThreshold: 0.03,
  blockThreshold: 0.1,
};

function referenceInput(
  kind: Parameters<typeof createReportCalculationReference>[0]["kind"],
  result: unknown,
  snapshots = [snapshot],
  suppliedCalculationInput?: unknown,
) {
  const resultRecord = result as Record<string, unknown>;
  const calculationInput =
    suppliedCalculationInput ??
    (kind === "consensus"
      ? consensusInput
      : kind === "fair-value"
        ? resultRecord["inputs"]
        : kind === "qualification"
          ? qualificationInput
          : kind === "line-movement"
            ? {
                significantProbabilityChange: 0.01,
                maximumGapMinutes:
                  (resultRecord["gap"] as { thresholdMinutes?: number } | null)
                    ?.thresholdMinutes ?? 60,
                observations: snapshots.map((item) => ({
                  observationId: item.snapshotId,
                  state: "active" as const,
                  americanOdds: item.americanOdds,
                  ...(item.point === undefined ? {} : { point: item.point }),
                  observedAt: item.observedAt,
                  retrievedAt: item.retrievedAt,
                })),
              }
            : kind === "market-disagreement"
              ? disagreementInput
              : resultRecord["calculationVersion"] ===
                  "closing-consensus-clv-v1"
                ? {
                    placedAmericanOdds: 120,
                    selectionKey: "club-a",
                    closingConsensusInput: consensusInput,
                  }
                : {
                    placedAmericanOdds: resultRecord["placedAmericanOdds"],
                    closingFairProbability:
                      resultRecord["closingFairProbability"],
                  });
  return {
    id: `reference-${kind}`,
    kind,
    canonicalEventId: "event-1",
    canonicalEventVersion: "1",
    sportKey: "soccer",
    marketKey: "moneyline",
    selectionKey: "club-a",
    snapshots,
    calculationInput,
    result,
  };
}

describe("report calculation references", () => {
  it("projects a trusted result and exact snapshot identity without recalculation", () => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    });
    const reference = createReportCalculationReference({
      id: "fair-club-a",
      kind: "fair-value",
      canonicalEventId: "event-1",
      canonicalEventVersion: "1",
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      snapshots: [snapshot],
      calculationInput: result.inputs,
      result,
    });
    expect(reference.raw["values"]).toEqual(result.values);
    expect(reference.display).toEqual(result.display);
    expect(reference.provenance).toEqual(result.provenance);
    expect(reference.referenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(reference.raw)).toBe(true);
  });

  it("rejects snapshot and calculation-kind mismatches", () => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    });
    const input = {
      id: "fair-club-a",
      kind: "fair-value" as const,
      canonicalEventId: "event-1",
      canonicalEventVersion: "1",
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      snapshots: [snapshot],
      calculationInput: result.inputs,
      result,
    };
    expect(() =>
      createReportCalculationReference({ ...input, selectionKey: "club-b" }),
    ).toThrow("snapshot-mismatch");
    expect(() =>
      createReportCalculationReference({ ...input, kind: "qualification" }),
    ).toThrow("version-mismatch");
  });

  it.each([
    { ...snapshot, sortKey: undefined },
    { ...snapshot, sortKey: 42 },
    { ...snapshot, snapshotId: "f".repeat(64) },
    { ...snapshot, undocumented: "not-an-identity-field" },
  ])(
    "rejects malformed or forged snapshot identities with bounded errors",
    (candidate) => {
      const result = calculateFairValue({
        fairProbability: 0.5,
        offeredAmerican: 120,
        stake: 10,
        fractionalKellyMultiplier: 0.25,
      });
      expect(() =>
        createReportCalculationReference({
          id: "fair-club-a",
          kind: "fair-value",
          canonicalEventId: "event-1",
          canonicalEventVersion: "1",
          sportKey: "soccer",
          marketKey: "moneyline",
          selectionKey: "club-a",
          snapshots: [candidate] as never,
          calculationInput: result.inputs,
          result,
        }),
      ).toThrow(ReportCalculationReferenceError);
    },
  );

  it("projects only the documented snapshot identity fields", () => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    });
    const reference = createReportCalculationReference({
      id: "fair-club-a",
      kind: "fair-value",
      canonicalEventId: "event-1",
      canonicalEventVersion: "1",
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      snapshots: [snapshot],
      calculationInput: result.inputs,
      result,
    });
    expect(Object.keys(reference.snapshotIdentities[0]!).sort()).toEqual(
      [
        "canonicalEventId",
        "canonicalEventVersion",
        "americanOdds",
        "marketKey",
        "observedAt",
        "partitionKey",
        "retrievedAt",
        "selectionKey",
        "snapshotId",
        "sortKey",
        "sportKey",
        "sportsbookId",
      ].sort(),
    );
  });

  it("rejects wrong result schemas, malformed provenance, and runtime kinds", () => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    });
    const input = {
      id: "fair-club-a",
      kind: "fair-value" as const,
      canonicalEventId: "event-1",
      canonicalEventVersion: "1",
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      snapshots: [snapshot],
      calculationInput: result.inputs,
      result,
    };
    expect(() =>
      createReportCalculationReference({
        ...input,
        result: { ...result, undocumented: true },
      }),
    ).toThrow(ReportCalculationReferenceError);
    expect(() =>
      createReportCalculationReference({
        ...input,
        result: {
          ...result,
          provenance: { ...result.provenance, root: { algorithm: null } },
        },
      }),
    ).toThrow(ReportCalculationReferenceError);
    expect(() =>
      createReportCalculationReference({
        ...input,
        kind: "made-up-kind",
      } as never),
    ).toThrow(ReportCalculationReferenceError);
  });

  it("accepts every supported deterministic result schema", () => {
    const consensus = calculateWeightedConsensus(consensusInput);
    const qualification = qualifyEvaluation({
      targetSportsbookId: "hardrock",
      offeredAmerican: 120,
      offeredAgeMinutes: 2,
      candidateIndex: 0,
      modelProbability: {
        estimate: 0.5,
        low: 0.5,
        high: 0.5,
        uncertainty: 0,
      },
      books: [
        { sportsbookId: "circa", ageMinutes: 1, americanOdds: [110, -120] },
        { sportsbookId: "pinnacle", ageMinutes: 2, americanOdds: [105, -115] },
      ],
      outcomeCount: 2,
      policy: {
        comparisonWeights: { circa: 1.25, pinnacle: 1 },
        minimumComparisonBooks: 2,
        maximumPriceAgeMinutes: 15,
        outlierThreshold: 0.2,
        disagreementWarningThreshold: 0.05,
        disagreementBlockThreshold: 0.1,
        maximumUncertainty: 0.1,
        minimumEdge: 0.01,
        minimumExpectedValue: 0.01,
      },
    });
    const movementInput = {
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 60,
      observations: [
        {
          observationId: openingSnapshot.snapshotId,
          state: "active",
          americanOdds: 120,
          observedAt: "2026-08-07T19:00:00.000Z",
          retrievedAt: "2026-08-07T19:00:01.000Z",
        },
        {
          observationId: latestSnapshot.snapshotId,
          state: "active",
          americanOdds: 110,
          observedAt: "2026-08-07T20:00:00.000Z",
          retrievedAt: "2026-08-07T20:00:01.000Z",
        },
      ],
    } as const;
    const movement = calculateLineMovement(movementInput);
    const disagreement = scoreMarketDisagreement(disagreementInput);
    const directClv = closingLineValue(120, 0.5);
    const consensusClv = calculateClosingConsensusClv({
      placedAmericanOdds: 120,
      selectionKey: "club-a",
      closingConsensusInput: consensusInput,
    });
    for (const [kind, result] of [
      ["consensus", consensus],
      ["qualification", qualification],
      ["line-movement", movement],
      ["market-disagreement", disagreement],
      ["clv", directClv],
      ["clv", consensusClv],
    ] as const) {
      const snapshots =
        kind === "line-movement"
          ? [openingSnapshot, latestSnapshot]
          : kind === "market-disagreement"
            ? [
                circaSnapshot,
                circaClubBSnapshot,
                pinnacleSnapshot,
                pinnacleClubBSnapshot,
              ]
            : kind === "consensus" ||
                kind === "qualification" ||
                result === consensusClv
              ? [snapshot, circaSnapshot, pinnacleSnapshot]
              : [snapshot];
      expect(
        createReportCalculationReference(
          referenceInput(kind, result, snapshots),
        ),
      ).toMatchObject({ kind });
    }
  });

  it.each([
    [
      "fair-value display",
      (result: ReturnType<typeof calculateFairValue>) => ({
        ...result,
        display:
          result.display === null
            ? null
            : { ...result.display, expectedValuePercent: "999.00%" },
      }),
    ],
    [
      "fair-value nested type",
      (result: ReturnType<typeof calculateFairValue>) => ({
        ...result,
        values:
          result.values === null
            ? null
            : { ...result.values, expectedValue: "not-a-number" },
      }),
    ],
    [
      "fair-value issue enum",
      (result: ReturnType<typeof calculateFairValue>) => ({
        ...result,
        issues: ["invented-issue"],
      }),
    ],
    [
      "fair-value null invariant",
      (result: ReturnType<typeof calculateFairValue>) => ({
        ...result,
        status: "invalid",
      }),
    ],
  ])("rejects malformed deep result data: %s", (_label, mutate) => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    });
    expect(() =>
      createReportCalculationReference(
        referenceInput("fair-value", mutate(result)),
      ),
    ).toThrow(ReportCalculationReferenceError);
  });

  it("rejects invalid closing-consensus status and nested result fields", () => {
    const result = calculateClosingConsensusClv({
      placedAmericanOdds: 120,
      selectionKey: "club-a",
      closingConsensusInput: consensusInput,
    });
    expect(() =>
      createReportCalculationReference(
        referenceInput("clv", { ...result, status: "insufficient-data" }),
      ),
    ).toThrow(ReportCalculationReferenceError);
    expect(() =>
      createReportCalculationReference(
        referenceInput("clv", {
          ...result,
          values:
            result.values === null
              ? null
              : { ...result.values, placedDecimalOdds: "2.2" },
        }),
      ),
    ).toThrow(ReportCalculationReferenceError);
  });

  it("rehydrates and canonicalizes a complete trusted reference", () => {
    const result = qualifyEvaluation({
      targetSportsbookId: "hardrock",
      offeredAmerican: 120,
      offeredAgeMinutes: 2,
      candidateIndex: 0,
      modelProbability: {
        estimate: 0.5,
        low: 0.5,
        high: 0.5,
        uncertainty: 0,
      },
      books: [
        { sportsbookId: "circa", ageMinutes: 1, americanOdds: [110, -120] },
        {
          sportsbookId: "pinnacle",
          ageMinutes: 2,
          americanOdds: [105, -115],
        },
      ],
      outcomeCount: 2,
      policy: {
        comparisonWeights: { circa: 1.25, pinnacle: 1 },
        minimumComparisonBooks: 2,
        maximumPriceAgeMinutes: 15,
        outlierThreshold: 0.2,
        disagreementWarningThreshold: 0.05,
        disagreementBlockThreshold: 0.1,
        maximumUncertainty: 0.1,
        minimumEdge: 0.01,
        minimumExpectedValue: 0.01,
      },
    });
    const reference = createReportCalculationReference(
      referenceInput("qualification", result, [
        snapshot,
        circaSnapshot,
        pinnacleSnapshot,
      ]),
    );
    const rehydrated = validateReportCalculationReference({
      ...reference,
      snapshotIdentities: [...reference.snapshotIdentities].reverse(),
    });
    expect(rehydrated).toEqual(reference);
    expect(Object.isFrozen(rehydrated.snapshotIdentities[0])).toBe(true);
  });

  it("rejects tampering even when an attacker recomputes the outer hash", () => {
    const result = calculateFairValue({
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    });
    const reference = createReportCalculationReference(
      referenceInput("fair-value", result),
    );
    const material = {
      ...reference,
      raw: {
        ...reference.raw,
        values: {
          ...(reference.raw["values"] as Record<string, unknown>),
          expectedValue: 999,
        },
      },
    };
    const hashMaterial = Object.fromEntries(
      Object.entries(material).filter(([key]) => key !== "referenceHash"),
    );
    const forged = {
      ...hashMaterial,
      referenceHash: calculationInputHash(
        "report-calculation-reference-v1",
        hashMaterial,
      ),
    };
    expect(() => validateReportCalculationReference(forged)).toThrow(
      ReportCalculationReferenceError,
    );
    expect(() =>
      validateReportCalculationReference({
        ...reference,
        snapshotIdentities: reference.snapshotIdentities.map((identity) => ({
          ...identity,
          americanOdds: 999,
        })),
      }),
    ).toThrow(ReportCalculationReferenceError);
  });

  it("binds exposed books, observations, and selections to snapshot evidence", () => {
    const qualification = qualifyEvaluation({
      targetSportsbookId: "hardrock",
      offeredAmerican: 120,
      offeredAgeMinutes: 2,
      candidateIndex: 0,
      modelProbability: {
        estimate: 0.5,
        low: 0.5,
        high: 0.5,
        uncertainty: 0,
      },
      books: [
        { sportsbookId: "circa", ageMinutes: 1, americanOdds: [110, -120] },
        {
          sportsbookId: "pinnacle",
          ageMinutes: 2,
          americanOdds: [105, -115],
        },
      ],
      outcomeCount: 2,
      policy: {
        comparisonWeights: { circa: 1.25, pinnacle: 1 },
        minimumComparisonBooks: 2,
        maximumPriceAgeMinutes: 15,
        outlierThreshold: 0.2,
        disagreementWarningThreshold: 0.05,
        disagreementBlockThreshold: 0.1,
        maximumUncertainty: 0.1,
        minimumEdge: 0.01,
        minimumExpectedValue: 0.01,
      },
    });
    expect(() =>
      createReportCalculationReference(
        referenceInput("qualification", qualification),
      ),
    ).toThrow("sportsbook-evidence-mismatch");

    const duplicateCircaSnapshot = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "circa",
      americanOdds: 110,
      observedAt: "2026-08-07T19:59:55.000Z",
      retrievedAt: "2026-08-07T19:59:59.000Z",
    });
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "qualification",
          qualification,
          [snapshot, circaSnapshot, duplicateCircaSnapshot, pinnacleSnapshot],
          qualificationInput,
        ),
      ),
    ).toThrow("qualification-snapshot-duplicate");

    const unattachedMovementInput = {
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 60,
      observations: [
        {
          observationId: "unattached-opening",
          state: "active",
          americanOdds: 120,
          observedAt: "2026-08-07T19:00:00.000Z",
          retrievedAt: "2026-08-07T19:00:01.000Z",
        },
        {
          observationId: latestSnapshot.snapshotId,
          state: "active",
          americanOdds: 110,
          observedAt: "2026-08-07T20:00:00.000Z",
          retrievedAt: "2026-08-07T20:00:01.000Z",
        },
      ],
    } as const;
    const movement = calculateLineMovement(unattachedMovementInput);
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "line-movement",
          movement,
          [openingSnapshot, latestSnapshot],
          unattachedMovementInput,
        ),
      ),
    ).toThrow("observation-evidence-mismatch");

    const crossBookLatest = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "circa",
      americanOdds: 110,
      observedAt: "2026-08-07T20:00:00.000Z",
      retrievedAt: "2026-08-07T20:00:01.000Z",
    });
    const crossBookMovementInput = {
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 60,
      observations: [openingSnapshot, crossBookLatest].map((item) => ({
        observationId: item.snapshotId,
        state: "active" as const,
        americanOdds: item.americanOdds,
        observedAt: item.observedAt,
        retrievedAt: item.retrievedAt,
      })),
    };
    const crossBookMovement = calculateLineMovement(crossBookMovementInput);
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "line-movement",
          crossBookMovement,
          [openingSnapshot, crossBookLatest],
          crossBookMovementInput,
        ),
      ),
    ).toThrow("movement-sportsbook-mismatch");

    const consensusClv = calculateClosingConsensusClv({
      placedAmericanOdds: 120,
      selectionKey: "club-a",
      closingConsensusInput: consensusInput,
    });
    expect(() =>
      createReportCalculationReference(
        referenceInput("clv", { ...consensusClv, selectionKey: "club-b" }, [
          snapshot,
          circaSnapshot,
          pinnacleSnapshot,
        ]),
      ),
    ).toThrow("selection-evidence-mismatch");
  });

  it("rejects internally inconsistent consensus, qualification, disagreement, and CLV data", () => {
    const consensus = calculateWeightedConsensus(consensusInput);
    const qualification = qualifyEvaluation({
      targetSportsbookId: "hardrock",
      offeredAmerican: 120,
      offeredAgeMinutes: 2,
      candidateIndex: 0,
      modelProbability: {
        estimate: 0.5,
        low: 0.5,
        high: 0.5,
        uncertainty: 0,
      },
      books: [
        { sportsbookId: "circa", ageMinutes: 1, americanOdds: [110, -120] },
        {
          sportsbookId: "pinnacle",
          ageMinutes: 2,
          americanOdds: [105, -115],
        },
      ],
      outcomeCount: 2,
      policy: {
        comparisonWeights: { circa: 1.25, pinnacle: 1 },
        minimumComparisonBooks: 2,
        maximumPriceAgeMinutes: 15,
        outlierThreshold: 0.2,
        disagreementWarningThreshold: 0.05,
        disagreementBlockThreshold: 0.1,
        maximumUncertainty: 0.1,
        minimumEdge: 0.01,
        minimumExpectedValue: 0.01,
      },
    });
    const disagreement = scoreMarketDisagreement(disagreementInput);
    const clv = closingLineValue(120, 0.5);
    for (const input of [
      referenceInput("consensus", { ...consensus, probabilities: [0.9, 0.1] }, [
        circaSnapshot,
        pinnacleSnapshot,
      ]),
      referenceInput(
        "qualification",
        {
          ...qualification,
          decision: "play",
          reasons: ["positive-ev-qualified", "stale-offered-price"],
        },
        [snapshot, circaSnapshot, pinnacleSnapshot],
      ),
      referenceInput("market-disagreement", { ...disagreement, score: 0.9 }, [
        circaSnapshot,
        circaClubBSnapshot,
        pinnacleSnapshot,
        pinnacleClubBSnapshot,
      ]),
      referenceInput("clv", { ...clv, priceClv: clv.priceClv + 0.2 }),
    ]) {
      expect(() => createReportCalculationReference(input)).toThrow(
        ReportCalculationReferenceError,
      );
    }
  });

  it("accepts a line-change unavailable result and rejects forged movement relations", () => {
    const pointOpening = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "hardrock",
      americanOdds: 120,
      point: -1.5,
      observedAt: "2026-08-07T19:00:00.000Z",
      retrievedAt: "2026-08-07T19:00:01.000Z",
    });
    const pointLatest = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "hardrock",
      americanOdds: 110,
      point: -2,
      observedAt: "2026-08-07T20:00:00.000Z",
      retrievedAt: "2026-08-07T20:00:01.000Z",
    });
    const result = calculateLineMovement({
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 60,
      observations: [
        {
          observationId: pointOpening.snapshotId,
          state: "active",
          americanOdds: 120,
          point: -1.5,
          observedAt: "2026-08-07T19:00:00.000Z",
          retrievedAt: "2026-08-07T19:00:01.000Z",
        },
        {
          observationId: pointLatest.snapshotId,
          state: "active",
          americanOdds: 110,
          point: -2,
          observedAt: "2026-08-07T20:00:00.000Z",
          retrievedAt: "2026-08-07T20:00:01.000Z",
        },
      ],
    });
    const input = referenceInput("line-movement", result, [
      pointOpening,
      pointLatest,
    ]);
    expect(createReportCalculationReference(input).status).toBe("unavailable");
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "line-movement",
          {
            ...result,
            pointMovement: {
              ...result.pointMovement,
              delta: -0.25,
            },
          },
          [pointOpening, pointLatest],
        ),
      ),
    ).toThrow(ReportCalculationReferenceError);
  });

  it("accepts authenticated consensus exclusions without weakening issue checks", () => {
    const inputWithTarget = {
      ...consensusInput,
      books: [
        {
          sportsbookId: "hardrock",
          ageMinutes: 1,
          status: "active" as const,
          selections: [
            { selectionKey: "club-a", americanOdds: 120 },
            { selectionKey: "club-b", americanOdds: -130 },
          ],
        },
        ...consensusInput.books,
      ],
    };
    const result = calculateWeightedConsensus(inputWithTarget);
    const reference = createReportCalculationReference(
      referenceInput(
        "consensus",
        result,
        [snapshot, circaSnapshot, pinnacleSnapshot],
        inputWithTarget,
      ),
    );
    expect(reference.status).toBe("available");
    expect(reference.raw["exclusions"]).toContainEqual({
      sportsbookId: "hardrock",
      reason: "target-sportsbook",
    });
  });

  it("accepts authentic invalid consensus states without inventing insufficient-books", () => {
    const invalidMarketInput = {
      ...consensusInput,
      selectionKeys: ["club-a"],
    };
    const invalidMarket = calculateWeightedConsensus(invalidMarketInput);
    expect(invalidMarket).toMatchObject({
      status: "invalid",
      issues: ["invalid-market"],
    });
    expect(
      createReportCalculationReference(
        referenceInput(
          "consensus",
          invalidMarket,
          [circaSnapshot, pinnacleSnapshot],
          invalidMarketInput,
        ),
      ).status,
    ).toBe("invalid");

    const secondCircaSnapshot = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "circa",
      americanOdds: 115,
      observedAt: "2026-08-07T19:59:56.000Z",
      retrievedAt: "2026-08-07T19:59:59.000Z",
    });
    const duplicateInput = {
      ...consensusInput,
      books: [
        consensusInput.books[0]!,
        {
          ...consensusInput.books[0]!,
          selections: [
            { selectionKey: "club-a", americanOdds: 115 },
            { selectionKey: "club-b", americanOdds: -125 },
          ],
        },
      ],
    };
    const duplicate = calculateWeightedConsensus(duplicateInput);
    expect(duplicate).toMatchObject({
      status: "invalid",
      issues: ["duplicate-sportsbook"],
    });
    expect(
      createReportCalculationReference(
        referenceInput(
          "consensus",
          duplicate,
          [circaSnapshot, secondCircaSnapshot],
          duplicateInput,
        ),
      ).status,
    ).toBe("invalid");
  });

  it("binds fair-value and qualification arithmetic to their provenance inputs", () => {
    const fairInput = {
      fairProbability: 0.5,
      offeredAmerican: 120,
      stake: 10,
      fractionalKellyMultiplier: 0.25,
    };
    const fair = calculateFairValue(fairInput);
    expect(() =>
      createReportCalculationReference(
        referenceInput("fair-value", fair, [snapshot], {
          ...fairInput,
          fairProbability: 0.51,
        }),
      ),
    ).toThrow("recalculation-mismatch");

    const qualified = qualifyEvaluation(qualificationInput);
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "qualification",
          qualified,
          [snapshot, circaSnapshot, pinnacleSnapshot],
          {
            ...qualificationInput,
            modelProbability: {
              ...qualificationInput.modelProbability,
              low: 0.51,
            },
          },
        ),
      ),
    ).toThrow("recalculation-mismatch");
  });

  it("accepts move-and-return semantics and binds movement to exact snapshots", () => {
    const middle = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "hardrock",
      americanOdds: 115,
      point: -2,
      observedAt: "2026-08-07T19:30:00.000Z",
      retrievedAt: "2026-08-07T19:30:01.000Z",
    });
    const returned = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "hardrock",
      americanOdds: 110,
      point: -1.5,
      observedAt: "2026-08-07T20:00:00.000Z",
      retrievedAt: "2026-08-07T20:00:01.000Z",
    });
    const opening = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      sportsbookId: "hardrock",
      americanOdds: 120,
      point: -1.5,
      observedAt: "2026-08-07T19:00:00.000Z",
      retrievedAt: "2026-08-07T19:00:01.000Z",
    });
    const input = {
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 60,
      observations: [opening, middle, returned].map((item) => ({
        observationId: item.snapshotId,
        state: "active" as const,
        americanOdds: item.americanOdds,
        ...(item.point === undefined ? {} : { point: item.point }),
        observedAt: item.observedAt,
        retrievedAt: item.retrievedAt,
      })),
    };
    const result = calculateLineMovement(input);
    expect(result.pointMovement).toMatchObject({ delta: 0, changed: true });
    expect(
      createReportCalculationReference(
        referenceInput(
          "line-movement",
          result,
          [opening, middle, returned],
          input,
        ),
      ).status,
    ).toBe("unavailable");
    expect(() =>
      createReportCalculationReference(
        referenceInput("line-movement", result, [opening, middle, returned], {
          ...input,
          significantProbabilityChange: 0.2,
        }),
      ),
    ).toThrow("recalculation-mismatch");
  });

  it("binds disagreement vectors and closing consensus probability to calculator inputs", () => {
    const disagreement = scoreMarketDisagreement(disagreementInput);
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "market-disagreement",
          disagreement,
          [
            circaSnapshot,
            circaClubBSnapshot,
            pinnacleSnapshot,
            pinnacleClubBSnapshot,
          ],
          {
            ...disagreementInput,
            contributions: [
              { sportsbookId: "circa", probabilities: [0.6, 0.4] },
              disagreementInput.contributions[1]!,
            ],
          },
        ),
      ),
    ).toThrow("vector-mismatch");

    const consensusClvInput = {
      placedAmericanOdds: 120,
      selectionKey: "club-a",
      closingConsensusInput: consensusInput,
    };
    const clv = calculateClosingConsensusClv(consensusClvInput);
    expect(() =>
      createReportCalculationReference(
        referenceInput(
          "clv",
          clv,
          [snapshot, circaSnapshot, pinnacleSnapshot],
          { ...consensusClvInput, selectionKey: "club-b" },
        ),
      ),
    ).toThrow(ReportCalculationReferenceError);
  });
});
