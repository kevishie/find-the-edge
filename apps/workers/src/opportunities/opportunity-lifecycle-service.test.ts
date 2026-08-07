import { describe, expect, it, vi } from "vitest";
import {
  MemoryOpportunityCandidateRepository,
  MemoryOpportunityLifecycleRepository,
  type OpportunityLifecycleEventEvidenceSource,
  type OpportunityLifecycleRepository,
  type RankedOpportunityRepository,
} from "@find-the-edge/database";
import {
  createCalculationProvenance,
  createOpportunityCandidate,
  OPPORTUNITY_QUALIFICATION_VERSION,
  type OpportunityCandidateInput,
  type OpportunityLifecycleHead,
} from "@find-the-edge/domain";
import { OpportunityLifecycleService } from "./opportunity-lifecycle-service";

const input = (): OpportunityCandidateInput => ({
  logicalIdentity: {
    canonicalEventId: "event-1",
    canonicalEventVersion: 1,
    sportKey: "mlb",
    marketKey: "moneyline",
    selectionKey: "team-a",
    point: null,
    targetSportsbookId: "hardrock",
    strategyId: "strategy",
    strategyVersion: "1",
  },
  evaluatedAt: "2026-08-06T12:00:00.000Z",
  qualificationGates: {
    eventStatus: "scheduled",
    marketApproved: true,
    minimumComparisonBooks: 3,
    maximumPriceAgeMinutes: 15,
    minimumExpectedValue: 0.02,
    disagreementWarningThreshold: 0.08,
    disagreementBlockThreshold: 0.15,
  },
  status: "disqualified",
  reasonCodes: [
    "insufficient-comparison-books",
    "target-missing",
    "target-provider-unhealthy",
  ],
  warningCodes: [],
  values: {
    targetAmericanOdds: null,
    targetImpliedProbability: null,
    consensusProbability: null,
    fairAmericanOdds: null,
    expectedValue: null,
    marketDisagreement: null,
  },
  targetEvidence: [],
  comparisonEvidence: [],
  includedComparisonSportsbookIds: [],
  excludedComparisonBooks: [],
  providerHealth: [],
  versions: {
    sportModule: { id: "mlb", version: "1" },
    strategy: { id: "strategy", version: "1" },
    evaluationPolicy: { id: "policy", version: "1" },
    calculation: createCalculationProvenance({
      algorithm: {
        id: "opportunity-qualification",
        version: OPPORTUNITY_QUALIFICATION_VERSION,
      },
      input: { missing: true },
      precisionPolicyVersion: "display-v1",
    }),
  },
});
const eventSource = (): OpportunityLifecycleEventEvidenceSource => ({
  read: vi.fn().mockResolvedValue({
    evidence: {
      availability: "current",
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "mlb",
      status: "scheduled",
      startsAt: "2026-08-06T20:00:00.000Z",
      observedAt: "2026-08-06T11:59:00.000Z",
      identity: "EVENT_DETAIL#event-1#CURRENT",
      evidenceId: "event-1@1",
    },
    fence: {
      pk: "EVENT_DETAIL#event-1",
      sk: "CURRENT",
      expectedMaterialVersion: 1,
    },
  }),
});
const activeHead = (
  candidate: ReturnType<typeof createOpportunityCandidate>,
): OpportunityLifecycleHead => ({
  schemaVersion: "opportunity-lifecycle-v1",
  logicalOpportunityId: candidate.logicalOpportunityId,
  canonicalEventId: candidate.logicalIdentity.canonicalEventId,
  canonicalEventVersion: candidate.logicalIdentity.canonicalEventVersion,
  sportKey: candidate.logicalIdentity.sportKey,
  state: "active",
  stateVersion: 1,
  latestCandidateOccurrenceId: candidate.occurrenceId,
  latestCandidateEvaluatedAt: candidate.evaluatedAt,
  reasonCodes: [],
  candidateReasonCodes: [],
  expiresAt: "2026-08-06T12:15:00.000Z",
  eventEvidence: {
    availability: "current",
    canonicalEventId: "event-1",
    canonicalEventVersion: 1,
    sportKey: "mlb",
    status: "scheduled",
    startsAt: "2026-08-06T20:00:00.000Z",
    observedAt: "2026-08-06T11:59:00.000Z",
    identity: "EVENT_DETAIL#event-1#CURRENT",
    evidenceId: "event-1@1",
  },
  transitionedAt: "2026-08-06T12:00:00.000Z",
  lastTransitionId: "transition-1",
  lastCommandId: `candidate:${candidate.occurrenceId}:event-1@1`,
});

describe("opportunity lifecycle service", () => {
  it("projects a persisted occurrence without mutating it and converges replay", async () => {
    const candidates = new MemoryOpportunityCandidateRepository();
    const persisted = await candidates.persist(input());
    const lifecycle = new MemoryOpportunityLifecycleRepository();
    const emit = vi.fn();
    const service = new OpportunityLifecycleService({
      lifecycle,
      events: eventSource(),
      candidates,
      telemetry: { emit },
    });
    const before = structuredClone(persisted.candidate);
    const first = await service.projectCandidate(
      persisted.candidate,
      "2026-08-06T12:00:00.000Z",
    );
    const second = await service.projectCandidate(
      persisted.candidate,
      "2026-08-06T12:00:00.000Z",
    );
    expect(first.outcome).toBe("applied");
    expect(first.head.state).toBe("suspended");
    expect(second.outcome).toBe("duplicate");
    expect(persisted.candidate).toEqual(before);
    expect(
      await lifecycle.history(persisted.candidate.logicalOpportunityId),
    ).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("fails closed when exact event evidence is unavailable", async () => {
    const candidates = new MemoryOpportunityCandidateRepository();
    const candidate = createOpportunityCandidate(input());
    await candidates.persist(input());
    const service = new OpportunityLifecycleService({
      lifecycle: new MemoryOpportunityLifecycleRepository(),
      events: { read: vi.fn().mockRejectedValue(new Error("event-fence")) },
      candidates,
    });
    await expect(
      service.projectCandidate(candidate, "2026-08-06T12:00:00.000Z"),
    ).rejects.toThrow("event-fence");
  });

  it("idempotently repairs a missing rank projection on active replay", async () => {
    const candidate = createOpportunityCandidate(input());
    const head = activeHead(candidate);
    const reconcileRankProjection = vi
      .fn<OpportunityLifecycleRepository["reconcileRankProjection"]>()
      .mockResolvedValue("projected");
    const lifecycle = {
      get: vi.fn().mockResolvedValue(head),
      apply: vi.fn().mockResolvedValue({ outcome: "duplicate", head }),
      reconcileRankProjection,
    } as unknown as OpportunityLifecycleRepository;
    const service = new OpportunityLifecycleService({
      lifecycle,
      events: eventSource(),
      candidates: new MemoryOpportunityCandidateRepository(),
    });

    await expect(
      service.projectCandidate(candidate, "2026-08-06T12:00:00.000Z"),
    ).resolves.toMatchObject({ outcome: "duplicate", head });
    expect(reconcileRankProjection).toHaveBeenCalledTimes(1);
    const reconciliation = reconcileRankProjection.mock.calls[0]?.[0];
    expect(reconciliation?.head).toEqual(head);
    expect(reconciliation?.candidate).toEqual(candidate);
    expect(reconciliation?.fence.expectedMaterialVersion).toBe(1);
  });

  it("fails closed when active replay rank repair loses its fence", async () => {
    const candidate = createOpportunityCandidate(input());
    const head = activeHead(candidate);
    const lifecycle = {
      get: vi.fn().mockResolvedValue(head),
      apply: vi.fn().mockResolvedValue({ outcome: "duplicate", head }),
      reconcileRankProjection: vi.fn().mockResolvedValue("conflict"),
    } as unknown as OpportunityLifecycleRepository;
    const service = new OpportunityLifecycleService({
      lifecycle,
      events: eventSource(),
      candidates: new MemoryOpportunityCandidateRepository(),
    });

    await expect(
      service.projectCandidate(candidate, "2026-08-06T12:00:00.000Z"),
    ).rejects.toThrow("opportunity-rank-projection-conflict");
  });

  it("backfills active pre-projection heads through the scheduled sweep path", async () => {
    const candidate = createOpportunityCandidate(input());
    const head = activeHead(candidate);
    const reconcileRankProjection = vi
      .fn<OpportunityLifecycleRepository["reconcileRankProjection"]>()
      .mockResolvedValue("projected");
    const lifecycle = {
      apply: vi.fn().mockResolvedValue({ outcome: "noop", head }),
      reconcileRankProjection,
    } as unknown as OpportunityLifecycleRepository;
    const candidates = {
      get: vi.fn().mockResolvedValue(candidate),
    } as unknown as MemoryOpportunityCandidateRepository;
    const service = new OpportunityLifecycleService({
      lifecycle,
      events: eventSource(),
      candidates,
    });

    await expect(
      service.sweepHead(head, "2026-08-06T12:00:00.000Z"),
    ).resolves.toMatchObject({ outcome: "noop", head });
    expect(reconcileRankProjection).toHaveBeenCalledTimes(1);
  });

  it("reconciles pre-existing active heads through bounded cursor pages", async () => {
    const reconcileActive = vi
      .fn<RankedOpportunityRepository["reconcileActive"]>()
      .mockResolvedValueOnce({
        discoveredCount: 2,
        projectedCount: 1,
        inactiveCount: 0,
        conflictCount: 1,
        failureCount: 0,
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        discoveredCount: 1,
        projectedCount: 1,
        inactiveCount: 0,
        conflictCount: 0,
        failureCount: 0,
        nextCursor: null,
      });
    const service = new OpportunityLifecycleService({
      lifecycle: new MemoryOpportunityLifecycleRepository(),
      events: eventSource(),
      candidates: new MemoryOpportunityCandidateRepository(),
      rankedOpportunities: { reconcileActive },
    });
    await expect(
      service.reconcileRankProjections({
        sportKey: "mlb",
        asOf: "2026-08-06T12:00:00.000Z",
        pageLimit: 20,
        maximumPages: 3,
      }),
    ).resolves.toEqual({
      discoveredCount: 3,
      projectedCount: 2,
      inactiveCount: 0,
      conflictCount: 1,
      failureCount: 0,
      nextCursor: null,
    });
    expect(reconcileActive).toHaveBeenNthCalledWith(2, {
      sportKey: "mlb",
      asOf: "2026-08-06T12:00:00.000Z",
      limit: 20,
      cursor: "next-page",
    });
  });
});
