import { describe, expect, it } from "vitest";

import {
  calculateLineMovement,
  exceedsMovementGap,
  isSignificantProbabilityMovement,
  type MovementObservation,
} from "./movement";

const observation = (
  observationId: string,
  americanOdds: number,
  observedAt: string,
  change: Partial<MovementObservation> = {},
): MovementObservation => ({
  observationId,
  state: "active",
  americanOdds,
  observedAt,
  retrievedAt: observedAt,
  ...change,
});

describe("line movement", () => {
  it("derives shortened direction from implied probability across the American sign boundary", () => {
    const result = calculateLineMovement({
      observations: [
        observation("open", 105, "2026-08-06T12:00:00.000Z"),
        observation("current", -105, "2026-08-06T12:05:00.000Z"),
      ],
      significantProbabilityChange: 0.02,
      maximumGapMinutes: 10,
    });

    expect(result).toMatchObject({
      calculationVersion: "line-movement-v1",
      status: "available",
      currentState: "active",
      activeObservationCount: 2,
      issues: [],
      openingObservationId: "open",
      latestObservationId: "current",
      pointMovement: {
        opening: null,
        latest: null,
        delta: null,
        changed: false,
      },
      gap: {
        maximumMinutes: 5,
        thresholdMinutes: 10,
        exceedsThreshold: false,
      },
      priceMovement: {
        openingAmericanOdds: 105,
        latestAmericanOdds: -105,
        americanOddsDelta: -210,
        direction: "shortened",
      },
    });
    if (result.priceMovement === null) throw new Error("expected movement");
    expect(result.priceMovement.impliedProbabilityDelta).toBeGreaterThan(0);
    expect(result.priceMovement.significant).toBe(true);
  });

  it("is invariant to input order, uses observed-time gaps, and freezes nested evidence", () => {
    const observations = [
      observation("middle", 120, "2026-08-06T12:04:00.000Z", {
        retrievedAt: "2026-08-06T12:20:00.000Z",
      }),
      observation("latest", 130, "2026-08-06T12:10:00.000Z"),
      observation("opening", 110, "2026-08-06T12:00:00.000Z"),
    ];
    const before = structuredClone(observations);
    const input = {
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 6,
    } as const;

    const left = calculateLineMovement({ observations, ...input });
    const right = calculateLineMovement({
      observations: [...observations].reverse(),
      ...input,
    });

    expect(right).toEqual(left);
    expect(observations).toEqual(before);
    expect(left.openingObservationId).toBe("opening");
    expect(left.latestObservationId).toBe("latest");
    expect(left.gap?.maximumMinutes).toBe(6);
    expect(left.gap?.exceedsThreshold).toBe(false);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.issues)).toBe(true);
    expect(Object.isFrozen(left.priceMovement)).toBe(true);
    expect(Object.isFrozen(left.pointMovement)).toBe(true);
    expect(Object.isFrozen(left.gap)).toBe(true);
  });

  it("reports point movement but does not compare prices across changed lines", () => {
    const result = calculateLineMovement({
      observations: [
        observation("open", -110, "2026-08-06T12:00:00.000Z", { point: -2.5 }),
        observation("latest", -105, "2026-08-06T12:03:00.000Z", { point: -3 }),
      ],
      significantProbabilityChange: 0,
      maximumGapMinutes: 3,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      issues: ["line-changed"],
      pointMovement: {
        opening: -2.5,
        latest: -3,
        delta: -0.5,
        changed: true,
      },
      priceMovement: null,
    });
  });

  it("does not compare prices when a line moves away and later returns", () => {
    const result = calculateLineMovement({
      observations: [
        observation("open", -110, "2026-08-06T12:00:00.000Z", { point: -1.5 }),
        observation("middle", -105, "2026-08-06T12:02:00.000Z", { point: -2 }),
        observation("latest", -115, "2026-08-06T12:04:00.000Z", {
          point: -1.5,
        }),
      ],
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 5,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      issues: ["line-changed"],
      pointMovement: {
        opening: -1.5,
        latest: -1.5,
        delta: 0,
        changed: true,
      },
      priceMovement: null,
    });
  });

  it.each([
    [
      "sparse",
      [observation("only", 100, "2026-08-06T12:00:00.000Z")],
      ["insufficient-active-observations"],
    ],
    [
      "suspended current evidence",
      [
        observation("open", 100, "2026-08-06T12:00:00.000Z"),
        observation("middle", -105, "2026-08-06T12:01:00.000Z"),
        observation("current", -105, "2026-08-06T12:02:00.000Z", {
          state: "suspended",
        }),
      ],
      ["current-observation-inactive"],
    ],
    [
      "unavailable-only evidence",
      [
        observation("current", 100, "2026-08-06T12:00:00.000Z", {
          state: "unavailable",
        }),
      ],
      ["current-observation-inactive", "insufficient-active-observations"],
    ],
  ] as const)(
    "returns typed unavailable movement for %s",
    (_, observations, issues) => {
      const result = calculateLineMovement({
        observations,
        significantProbabilityChange: 0.01,
        maximumGapMinutes: 5,
      });

      expect(result.status).toBe("unavailable");
      expect(result.issues).toEqual(issues);
      expect(result.priceMovement).toBeNull();
      expect(result.currentState).toBe(observations.at(-1)?.state);
    },
  );

  it("uses exact inclusive significance and strict gap boundaries", () => {
    expect(isSignificantProbabilityMovement(-0.05, 0.05)).toBe(true);
    expect(isSignificantProbabilityMovement(0.049_999, 0.05)).toBe(false);
    expect(exceedsMovementGap(15, 15)).toBe(false);
    expect(exceedsMovementGap(15.000_001, 15)).toBe(true);

    const unchanged = calculateLineMovement({
      observations: [
        observation("open", -110, "2026-08-06T12:00:00.000Z"),
        observation("latest", -110, "2026-08-06T12:15:00.001Z"),
      ],
      significantProbabilityChange: 0,
      maximumGapMinutes: 15,
    });
    expect(unchanged.priceMovement).toMatchObject({
      direction: "unchanged",
      significant: true,
    });
    expect(unchanged.gap?.exceedsThreshold).toBe(true);
    expect(unchanged.issues).toEqual(["history-gap-exceeded"]);
  });

  it("returns a frozen invalid result for malformed observations and rejects malformed thresholds", () => {
    const invalid = calculateLineMovement({
      observations: [
        observation("bad", 99, "not-a-date"),
        observation("bad", 100, "2026-08-06T12:00:00.000Z"),
      ],
      significantProbabilityChange: 0.01,
      maximumGapMinutes: 5,
    });
    expect(invalid).toMatchObject({
      status: "invalid",
      issues: ["invalid-observation"],
      priceMovement: null,
    });
    expect(Object.isFrozen(invalid)).toBe(true);

    expect(() =>
      calculateLineMovement({
        observations: [],
        significantProbabilityChange: Number.NaN,
        maximumGapMinutes: 5,
      }),
    ).toThrow(RangeError);
    expect(() => exceedsMovementGap(1, -1)).toThrow(RangeError);
  });

  it.each([
    [
      "noncanonical timestamp",
      [
        observation("open", -110, "2026-02-31T12:00:00.000Z"),
        observation("latest", -110, "2026-03-03T12:01:00.000Z"),
      ],
    ],
    [
      "invalid inactive odds",
      [
        observation("open", -110, "2026-08-06T12:00:00.000Z"),
        observation("latest", 99, "2026-08-06T12:01:00.000Z", {
          state: "suspended",
        }),
      ],
    ],
    [
      "overflowing odds delta",
      [
        observation("open", Number.MAX_VALUE, "2026-08-06T12:00:00.000Z"),
        observation("latest", -Number.MAX_VALUE, "2026-08-06T12:01:00.000Z"),
      ],
    ],
    [
      "collapsed extreme negative odds probability",
      [
        observation("open", -Number.MAX_VALUE, "2026-08-06T12:00:00.000Z"),
        observation("latest", -Number.MAX_VALUE, "2026-08-06T12:01:00.000Z"),
      ],
    ],
    [
      "overflowing point delta",
      [
        observation("open", -110, "2026-08-06T12:00:00.000Z", {
          point: Number.MAX_VALUE,
        }),
        observation("latest", -110, "2026-08-06T12:01:00.000Z", {
          point: -Number.MAX_VALUE,
        }),
      ],
    ],
  ] as const)("rejects %s", (_, observations) => {
    expect(
      calculateLineMovement({
        observations,
        significantProbabilityChange: 0.01,
        maximumGapMinutes: 5,
      }),
    ).toMatchObject({ status: "invalid", issues: ["invalid-observation"] });
  });
});
