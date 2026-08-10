import { describe, expect, it } from "vitest";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "../fixture-odds";
import {
  americanToDecimalOdds,
  computeMarketArbitrage,
  createArbitrageFinding,
  normalizeArbitrageFinding,
  type ArbitrageFinding,
  type ArbitrageFindingInput,
} from "./arbitrage-finding";

const evaluatedAt = "2026-08-06T12:05:00.000Z";
const quote = (
  sportsbookId: string,
  selectionKey: string,
  odds: number,
  marketKey = "moneyline",
) => {
  const normalized = normalizeFixtureOddsObservation({
    canonicalEventId: "event-1",
    canonicalEventVersion: 2,
    sportKey: "mlb",
    marketKey,
    selectionKey,
    sportsbookId,
    americanOdds: odds,
    observedAt: "2026-08-06T12:00:00.000Z",
    retrievedAt: "2026-08-06T12:00:01.000Z",
  });
  return {
    ...normalized,
    point: null,
    selectionAvailability: {
      identity: normalized.partitionKey,
      evidenceId: `availability-${sportsbookId}-${selectionKey}`,
      state: "active" as const,
      observedAt: "2026-08-06T12:00:01.000Z",
    },
    groupAvailability: {
      identity: fixtureOddsGroupAvailabilityIdentity(normalized),
      evidenceId: `group-availability-${sportsbookId}`,
      state: "active" as const,
      observedAt: "2026-08-06T12:00:01.000Z",
    },
  };
};

const input = (): ArbitrageFindingInput => ({
  canonicalEventId: "event-1",
  canonicalEventVersion: 2,
  sportKey: "mlb",
  leagueKey: "mlb",
  marketKey: "moneyline",
  startsAt: "2026-08-06T17:00:00.000Z",
  evaluatedAt,
  legs: [
    {
      selectionKey: "team-a",
      point: null,
      best: quote("novig", "team-a", 125),
      competing: [quote("hardrock", "team-a", 110)],
    },
    {
      selectionKey: "team-b",
      point: null,
      best: quote("prophetx", "team-b", -115),
      competing: [quote("hardrock", "team-b", -135)],
    },
  ],
  excludedBooks: [{ sportsbookId: "kalshi", reasonCodes: ["stale"] }],
  policy: {
    id: "find-the-edge-arbitrage",
    version: "1.0.0",
    lowHoldThreshold: 1.01,
    maximumPriceAgeMinutes: 15,
  },
});

describe("market arbitrage computation", () => {
  it("finds a true two-way arbitrage across books", () => {
    // +125 and -115: 1/2.25 + 115/215 = 0.4444 + 0.5349 = 0.9793 < 1.
    const computation = computeMarketArbitrage(
      [
        [quote("hardrock", "team-a", 110), quote("novig", "team-a", 125)],
        [quote("hardrock", "team-b", -135), quote("prophetx", "team-b", -115)],
      ],
      1.01,
    );
    expect(computation?.classification).toBe("arbitrage");
    expect(
      computation?.bestPerOutcome.map(({ sportsbookId }) => sportsbookId),
    ).toEqual(["novig", "prophetx"]);
    expect(computation?.sumInverseDecimal).toBeCloseTo(0.97934, 4);
    expect(computation?.holdPercentage).toBeLessThan(0);
  });

  it("classifies a three-way market by its summed inverse decimals", () => {
    // 1/3.6 + 1/3.6 + 1/2.3 = 0.9903 — a three-way arbitrage.
    const computation = computeMarketArbitrage(
      [
        [quote("novig", "home", 260)],
        [quote("prophetx", "draw", 260)],
        [quote("hardrock", "away", 130)],
      ],
      1.01,
    );
    expect(computation?.classification).toBe("arbitrage");
  });

  it("marks sums between 1 and the threshold low-hold and beyond it null", () => {
    // -102/-102: 2 * (102/202) = 1.00990... < 1.01 → low-hold.
    const lowHold = computeMarketArbitrage(
      [[quote("novig", "team-a", -102)], [quote("prophetx", "team-b", -102)]],
      1.01,
    );
    expect(lowHold?.classification).toBe("low-hold");
    // -105/-105 holds 2.44% → not material.
    const held = computeMarketArbitrage(
      [[quote("novig", "team-a", -105)], [quote("prophetx", "team-b", -105)]],
      1.01,
    );
    expect(held?.classification).toBeNull();
    expect(held?.holdPercentage).toBeGreaterThan(1);
  });

  it("rejects malformed odds and empty outcomes", () => {
    expect(() => americanToDecimalOdds(50)).toThrow(
      "arbitrage-american-odds-invalid",
    );
    expect(
      computeMarketArbitrage([[quote("novig", "team-a", 125)], []], 1.01),
    ).toBeNull();
  });
});

describe("arbitrage findings", () => {
  it("creates a self-verifying finding that survives normalization", () => {
    const finding = createArbitrageFinding(input());
    expect(finding.classification).toBe("arbitrage");
    expect(finding.sumInverseDecimal).toBeLessThan(1);
    expect(finding.findingId).toMatch(/^arb:[a-f0-9]{64}$/);
    expect(finding.expiresAt).toBe("2026-08-06T12:20:00.000Z");
    expect(normalizeArbitrageFinding(finding)).toEqual(finding);
  });

  it("rejects tampered stored odds and prices better than best", () => {
    const finding = createArbitrageFinding(input());
    const tampered = JSON.parse(JSON.stringify(finding)) as ArbitrageFinding;
    (tampered.legs[0]!.best as { americanOdds: number }).americanOdds = 150;
    expect(() => normalizeArbitrageFinding(tampered)).toThrow();
    const contradicted = input();
    expect(() =>
      createArbitrageFinding({
        ...contradicted,
        legs: [
          {
            ...contradicted.legs[0]!,
            competing: [quote("bovada", "team-a", 140)],
          },
          contradicted.legs[1]!,
        ],
      }),
    ).toThrow("arbitrage-leg-best-price-contradicted");
  });

  it("rejects incoherent point vectors and immaterial markets", () => {
    const base = input();
    expect(() =>
      createArbitrageFinding({
        ...base,
        legs: [base.legs[0]!, { ...base.legs[1]!, point: 1.5 }],
      }),
    ).toThrow("arbitrage-point-vector-invalid");
    expect(() =>
      createArbitrageFinding({
        ...base,
        legs: [
          {
            selectionKey: "team-a",
            point: null,
            best: quote("novig", "team-a", -105),
            competing: [],
          },
          {
            selectionKey: "team-b",
            point: null,
            best: quote("prophetx", "team-b", -105),
            competing: [],
          },
        ],
      }),
    ).toThrow("arbitrage-not-material");
  });

  it("rejects quotes with inactive availability or stale evidence", () => {
    const base = input();
    const inactive = {
      ...base.legs[0]!.best,
      selectionAvailability: {
        ...base.legs[0]!.best.selectionAvailability!,
        state: "suspended" as const,
      },
    };
    expect(() =>
      createArbitrageFinding({
        ...base,
        legs: [{ ...base.legs[0]!, best: inactive }, base.legs[1]!],
      }),
    ).toThrow("arbitrage-quote-availability-invalid");
    expect(() =>
      createArbitrageFinding({
        ...base,
        evaluatedAt: "2026-08-06T12:10:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      createArbitrageFinding({
        ...base,
        evaluatedAt: "2026-08-06T12:16:00.000Z",
      }),
    ).toThrow("arbitrage-quote-time-invalid");
  });
});
