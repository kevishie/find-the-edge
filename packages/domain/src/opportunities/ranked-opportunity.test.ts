import { describe, expect, it } from "vitest";
import { createCalculationProvenance } from "../calculation-provenance";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "../fixture-odds";
import {
  createOpportunityCandidate,
  OPPORTUNITY_QUALIFICATION_VERSION,
  type OpportunityCandidateInput,
} from "../opportunity-candidate";
import { reduceOpportunityLifecycle } from "./opportunity-lifecycle";
import {
  createRankedOpportunityProjection,
  normalizeRankedOpportunityDto,
  normalizeRankedOpportunityProjection,
  opportunityRankKey,
  toRankedOpportunityDto,
  type OpportunityRankingPolicyContract,
} from "./ranked-opportunity";

const policy: OpportunityRankingPolicyContract = {
  id: "find-the-edge-opportunity-ranking",
  version: "1.0.0",
  maximumFilterAgeMinutes: 15,
};
const snapshot = (sportsbookId: string, selectionKey: string, odds: number) => {
  const value = normalizeFixtureOddsObservation({
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
    ...value,
    point: null,
    selectionAvailability: {
      identity: value.partitionKey,
      evidenceId: `selection-${sportsbookId}-${selectionKey}`,
      state: "active" as const,
      observedAt: "2026-08-06T12:00:01.000Z",
    },
    groupAvailability: {
      identity: fixtureOddsGroupAvailabilityIdentity(value),
      evidenceId: `group-${sportsbookId}`,
      state: "active" as const,
      observedAt: "2026-08-06T12:00:01.000Z",
    },
  };
};
const input = (): OpportunityCandidateInput => ({
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
  warningCodes: ["market-disagreement-warning"],
  values: {
    targetAmericanOdds: 120,
    targetImpliedProbability: 0.4545,
    consensusProbability: 0.5,
    fairAmericanOdds: 100,
    expectedValue: 0.1,
    marketDisagreement: 0.08,
  },
  targetEvidence: [
    snapshot("hardrock", "team-a", 120),
    snapshot("hardrock", "team-b", -130),
  ],
  comparisonEvidence: ["draftkings", "fanduel", "betmgm"].flatMap((book) => [
    snapshot(book, "team-a", book === "draftkings" ? 115 : 110),
    snapshot(book, "team-b", -120),
  ]),
  includedComparisonSportsbookIds: ["draftkings", "fanduel", "betmgm"],
  excludedComparisonBooks: [],
  providerHealth: ["hardrock", "draftkings", "fanduel", "betmgm"].map(
    (sportsbookId) => ({
      providerId: "sharpapi",
      sportsbookId,
      healthy: true,
      checkedAt: "2026-08-06T12:05:00.000Z",
      healthKey: "sharpapi:mlb:odds",
      evidenceId: `health-${sportsbookId}`,
      leagueKey: "mlb",
      capability: "odds" as const,
      recordVersion: 1,
      status: "healthy" as const,
    }),
  ),
  versions: {
    sportModule: { id: "mlb", version: "1" },
    strategy: { id: "find-the-edge", version: "2.1.0" },
    evaluationPolicy: { id: "policy", version: "1" },
    calculation: createCalculationProvenance({
      algorithm: {
        id: "opportunity-qualification",
        version: OPPORTUNITY_QUALIFICATION_VERSION,
      },
      input: { ranked: true },
      precisionPolicyVersion: "display-v1",
    }),
  },
});
const fixture = () => {
  const candidate = createOpportunityCandidate(input());
  const decision = reduceOpportunityLifecycle(null, {
    commandId: "candidate-command",
    cause: "candidate",
    candidate,
    eventEvidence: {
      availability: "current",
      canonicalEventId: "event-1",
      canonicalEventVersion: 2,
      sportKey: "mlb",
      status: "scheduled",
      startsAt: "2026-08-06T20:00:00.000Z",
      observedAt: "2026-08-06T12:04:00.000Z",
      identity: "EVENT_DETAIL#event-1#CURRENT",
      evidenceId: "event-1@2",
    },
    occurredAt: candidate.evaluatedAt,
  });
  if (decision.outcome !== "applied") throw new Error("fixture-not-applied");
  return { candidate, head: decision.head };
};

describe("ranked opportunity", () => {
  it("derives conservative integer confidence and persists every component input", () => {
    const { candidate, head } = fixture();
    const projection = createRankedOpportunityProjection(
      candidate,
      head,
      policy,
    );
    expect(projection.confidence).toEqual({
      score: 46,
      bucket: "low",
      weakestComponent: "agreement",
      components: { freshness: 66, coverage: 100, agreement: 46 },
    });
    expect(projection.inputs).toMatchObject({
      oldestRequiredEvidenceAt: "2026-08-06T12:00:00.000Z",
      maximumPriceAgeMinutes: 15,
      includedComparisonBooks: 3,
      uniqueNonTargetComparisonBooksWithEvidence: 3,
      marketDisagreement: 0.08,
      disagreementBlockThreshold: 0.15,
    });
    expect(normalizeRankedOpportunityProjection(projection)).toEqual(
      projection,
    );
  });

  it("orders full precision EV, confidence, freshness, coverage, then stable ID", () => {
    const base = {
      expectedValue: 0.1,
      confidence: 80,
      freshness: 70,
      sportsbookCoverage: 75,
      logicalOpportunityId: `opportunity:${"a".repeat(64)}`,
    };
    const variants = [
      { ...base, expectedValue: 0.10000000000000002 },
      { ...base, confidence: 81 },
      { ...base, freshness: 71 },
      { ...base, sportsbookCoverage: 76 },
      { ...base, logicalOpportunityId: `opportunity:${"b".repeat(64)}` },
    ];
    for (const [index, better] of variants.entries()) {
      const left = opportunityRankKey(better);
      const right = opportunityRankKey(base);
      expect(left < right, String(index)).toBe(index < 4);
      if (index === 4) expect(right < left).toBe(true);
    }
  });

  it("builds a safe explanation and rejects extra internal fields", () => {
    const { candidate, head } = fixture();
    const projection = createRankedOpportunityProjection(
      candidate,
      head,
      policy,
    );
    const dto = toRankedOpportunityDto(
      projection,
      candidate,
      {
        id: "event-1",
        version: 2,
        sportKey: "mlb",
        leagueKey: "mlb",
        competition: { key: "mlb", state: "provisional" },
        participants: [
          { id: "team-a", label: "Team A" },
          { id: "team-b", label: "Team B" },
        ],
        startsAt: "2026-08-06T20:00:00.000Z",
        eastern: {
          timeZone: "America/New_York",
          calendarDay: "2026-08-06",
          display: "Aug 6, 2026, 4:00 PM",
        },
        status: "scheduled",
        freshness: "2026-08-06T12:04:00.000Z",
        metadata: {} as never,
      },
      "2026-08-06T12:05:00.000Z",
    );
    expect(dto).toMatchObject({
      target: { sportsbookId: "hardrock", americanOdds: 120 },
      bestComparison: { sportsbookId: "draftkings", americanOdds: 115 },
      contributingBooks: ["betmgm", "draftkings", "fanduel"],
      liveFreshness: { ageMinutes: 5 },
    });
    expect(JSON.stringify(dto)).not.toMatch(
      /partitionKey|sortKey|evidenceId|healthKey|activePk|rankPk/,
    );
    expect(() =>
      normalizeRankedOpportunityDto({ ...dto, rankPk: "leak" } as never),
    ).toThrow("ranked-opportunity-dto-invalid");
    expect(() =>
      normalizeRankedOpportunityDto({
        ...dto,
        confidence: { ...dto.confidence, score: 47 },
        dataQuality: { ...dto.dataQuality, score: 47 },
      }),
    ).toThrow("ranked-opportunity-dto-invalid");
    expect(() =>
      normalizeRankedOpportunityDto({
        ...dto,
        liveFreshness: { ...dto.liveFreshness, ageMinutes: 1 },
      }),
    ).toThrow("ranked-opportunity-dto-invalid");
  });

  it("does not count an excluded sportsbook that supplied no evidence", () => {
    const candidate = createOpportunityCandidate({
      ...input(),
      excludedComparisonBooks: [
        {
          sportsbookId: "caesars",
          reasonCodes: ["unavailable"],
          snapshots: [],
        },
      ],
    });
    const decision = reduceOpportunityLifecycle(null, {
      commandId: "candidate-command",
      cause: "candidate",
      candidate,
      eventEvidence: {
        availability: "current",
        canonicalEventId: "event-1",
        canonicalEventVersion: 2,
        sportKey: "mlb",
        status: "scheduled",
        startsAt: "2026-08-06T20:00:00.000Z",
        observedAt: "2026-08-06T12:04:00.000Z",
        identity: "EVENT_DETAIL#event-1#CURRENT",
        evidenceId: "event-1@2",
      },
      occurredAt: candidate.evaluatedAt,
    });
    if (decision.outcome !== "applied") throw new Error("fixture-not-applied");
    expect(
      createRankedOpportunityProjection(candidate, decision.head, policy).inputs
        .uniqueNonTargetComparisonBooksWithEvidence,
    ).toBe(3);
  });

  it("rejects nonfinite signals, inactive projections, and projection drift", () => {
    const { candidate, head } = fixture();
    expect(() =>
      opportunityRankKey({
        expectedValue: Number.POSITIVE_INFINITY,
        confidence: 100,
        freshness: 100,
        sportsbookCoverage: 100,
        logicalOpportunityId: candidate.logicalOpportunityId,
      }),
    ).toThrow("opportunity-rank-input-invalid");
    const { activePk: _activePk, activeSk: _activeSk, ...inactiveHead } = head;
    void _activePk;
    void _activeSk;
    expect(() =>
      createRankedOpportunityProjection(
        candidate,
        {
          ...inactiveHead,
          state: "stale",
          expiresAt: null,
        },
        policy,
      ),
    ).toThrow("opportunity-rank-source-invalid");
    const projection = createRankedOpportunityProjection(
      candidate,
      head,
      policy,
    );
    expect(() =>
      normalizeRankedOpportunityProjection({
        ...projection,
        rankKey: `${projection.rankKey}x`,
      }),
    ).toThrow("stored-ranked-opportunity-invalid");
  });
});
