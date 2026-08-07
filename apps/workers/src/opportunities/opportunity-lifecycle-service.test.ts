import { describe, expect, it, vi } from "vitest";
import {
  MemoryOpportunityCandidateRepository,
  MemoryOpportunityLifecycleRepository,
  type OpportunityLifecycleEventEvidenceSource,
} from "@find-the-edge/database";
import {
  createCalculationProvenance,
  createOpportunityCandidate,
  OPPORTUNITY_QUALIFICATION_VERSION,
  type OpportunityCandidateInput,
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
});
