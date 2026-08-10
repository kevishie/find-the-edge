import { describe, expect, it } from "vitest";
import { createCalculationProvenance } from "./calculation-provenance";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "./fixture-odds";
import {
  createOpportunityCandidate,
  normalizeOpportunityCandidate,
  OPPORTUNITY_QUALIFICATION_VERSION,
  type OpportunityCandidateInput,
} from "./opportunity-candidate";

const provenance = createCalculationProvenance({
  algorithm: {
    id: "opportunity-qualification",
    version: OPPORTUNITY_QUALIFICATION_VERSION,
  },
  input: { offeredAmerican: 120 },
  precisionPolicyVersion: "display-v1",
});
const snapshot = (sportsbookId: string, selectionKey: string, odds: number) => {
  const normalized = normalizeFixtureOddsObservation({
    canonicalEventId: "event-1",
    canonicalEventVersion: 2,
    sportKey: "mlb",
    marketKey: "moneyline",
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

const health = (sportsbookId: string) => ({
  providerId: "sharpapi",
  sportsbookId,
  healthy: true,
  checkedAt: "2026-08-06T12:05:00.000Z",
  healthKey: "sharpapi:mlb:odds",
  evidenceId: `sharpapi:mlb:odds@1@${sportsbookId}`,
  leagueKey: "mlb",
  capability: "odds" as const,
  recordVersion: 1,
  status: "healthy" as const,
});

function input(): OpportunityCandidateInput {
  return {
    logicalIdentity: {
      canonicalEventId: "event-1",
      canonicalEventVersion: 2,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "team-a",
      point: null,
      targetSportsbookId: "hardrock",
      strategyId: "find-the-edge",
      strategyVersion: "2.1.0",
    },
    evaluatedAt: "2026-08-06T12:05:00.000Z",
    qualificationGates: {
      eventStatus: "scheduled",
      marketApproved: true,
      minimumComparisonBooks: 3,
      maximumPriceAgeMinutes: 15,
      minimumExpectedValue: 0.02,
      disagreementWarningThreshold: 0.08,
      disagreementBlockThreshold: 0.15,
    },
    status: "qualified",
    reasonCodes: [],
    warningCodes: [],
    values: {
      targetAmericanOdds: 120,
      targetImpliedProbability: 0.454545454545,
      consensusProbability: 0.5,
      fairAmericanOdds: 100,
      expectedValue: 0.1,
      marketDisagreement: 0.02,
    },
    targetEvidence: [
      snapshot("hardrock", "team-a", 120),
      snapshot("hardrock", "team-b", -130),
    ],
    comparisonEvidence: [
      snapshot("draftkings", "team-a", 110),
      snapshot("draftkings", "team-b", -120),
      snapshot("fanduel", "team-a", 108),
      snapshot("fanduel", "team-b", -118),
      snapshot("betmgm", "team-a", 105),
      snapshot("betmgm", "team-b", -115),
    ],
    includedComparisonSportsbookIds: ["draftkings", "fanduel", "betmgm"],
    excludedComparisonBooks: [],
    providerHealth: ["hardrock", "draftkings", "fanduel", "betmgm"].map(health),
    versions: {
      sportModule: { id: "mlb", version: "1.0.0" },
      strategy: { id: "find-the-edge", version: "2.1.0" },
      evaluationPolicy: {
        id: "find-the-edge-evaluation",
        version: "2.0.0-provisional",
      },
      calculation: provenance,
    },
  };
}

describe("opportunity candidate", () => {
  it("converges identity and bytes across set and evidence permutations", () => {
    const first = createOpportunityCandidate(input());
    const changedOrder = input();
    const second = createOpportunityCandidate({
      ...changedOrder,
      warningCodes: [...changedOrder.warningCodes].reverse(),
      targetEvidence: [...changedOrder.targetEvidence].reverse(),
      comparisonEvidence: [...changedOrder.comparisonEvidence].reverse(),
      providerHealth: [...changedOrder.providerHealth].reverse(),
    });
    expect(second).toEqual(first);
    expect(normalizeOpportunityCandidate(structuredClone(first))).toEqual(
      first,
    );
  });

  it("keeps logical identity while producing a new occurrence for evidence changes", () => {
    const first = createOpportunityCandidate(input());
    const changed = input();
    const second = createOpportunityCandidate({
      ...changed,
      evaluatedAt: "2026-08-06T12:06:00.000Z",
    });
    expect(second.logicalOpportunityId).toBe(first.logicalOpportunityId);
    expect(second.occurrenceId).not.toBe(first.occurrenceId);
  });

  it("requires disqualifications to have closed blocking reasons", () => {
    const value = input();
    expect(() =>
      createOpportunityCandidate({
        ...value,
        status: "disqualified",
        reasonCodes: [],
      }),
    ).toThrow("opportunity-status-reasons-invalid");
    expect(() =>
      createOpportunityCandidate({
        ...value,
        status: "qualified",
        reasonCodes: ["ev-below-threshold"],
      }),
    ).toThrow("opportunity-status-reasons-invalid");
  });

  it("rejects incomplete qualified evidence and stored schema drift", () => {
    const value = input();
    expect(() =>
      createOpportunityCandidate({
        ...value,
        includedComparisonSportsbookIds: ["draftkings"],
      }),
    ).toThrow("opportunity-decision-evidence-invalid");
    const created = createOpportunityCandidate({
      ...value,
      status: "disqualified",
      reasonCodes: ["ev-below-threshold"],
      values: { ...value.values, expectedValue: 0.01 },
    });
    expect(() =>
      normalizeOpportunityCandidate({
        ...created,
        schemaVersion: "future" as typeof created.schemaVersion,
      }),
    ).toThrow("stored-opportunity-candidate-invalid");
  });

  it("bounds provider-health skew ahead of the evaluation instant", () => {
    const value = input();
    const shifted = (offsetMs: number) =>
      value.providerHealth.map((item) => ({
        ...item,
        checkedAt: new Date(
          Date.parse(value.evaluatedAt) + offsetMs,
        ).toISOString(),
      }));
    // Continuously rewritten health rows may be observed moments after the
    // evaluation instant; that is concurrency, not future-dated evidence.
    expect(
      createOpportunityCandidate({ ...value, providerHealth: shifted(30_000) })
        .providerHealth[0]?.checkedAt,
    ).toBe(new Date(Date.parse(value.evaluatedAt) + 30_000).toISOString());
    expect(() =>
      createOpportunityCandidate({
        ...value,
        providerHealth: shifted(5 * 60_000 + 1_000),
      }),
    ).toThrow("opportunity-provider-health-invalid");
  });

  it("rejects decision reasons and values contradicted by exact evidence", () => {
    const value = input();
    expect(() =>
      createOpportunityCandidate({
        ...value,
        status: "disqualified",
        reasonCodes: ["target-missing"],
      }),
    ).toThrow("opportunity-decision-evidence-invalid");
    expect(() =>
      createOpportunityCandidate({
        ...value,
        status: "disqualified",
        reasonCodes: ["insufficient-comparison-books"],
      }),
    ).toThrow("opportunity-decision-evidence-invalid");
    expect(() =>
      createOpportunityCandidate({
        ...value,
        status: "disqualified",
        reasonCodes: ["target-provider-unhealthy"],
      }),
    ).toThrow("opportunity-decision-evidence-invalid");
    expect(() =>
      createOpportunityCandidate({
        ...value,
        status: "disqualified",
        reasonCodes: ["ev-below-threshold"],
        values: { ...value.values, targetAmericanOdds: 130 },
      }),
    ).toThrow("opportunity-decision-evidence-invalid");
    expect(() =>
      createOpportunityCandidate({
        ...value,
        warningCodes: ["comparison-outlier-excluded"],
      }),
    ).toThrow("opportunity-decision-evidence-invalid");
  });
});
