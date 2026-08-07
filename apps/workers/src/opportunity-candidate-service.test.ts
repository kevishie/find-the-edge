import { describe, expect, it, vi } from "vitest";
import { defaultEvaluationPolicy } from "@find-the-edge/config";
import {
  MemoryEvaluationCandidateRepository,
  MemoryOddsControlPlaneStore,
  MemoryOpportunityCandidateRepository,
  MemoryOpportunityEvidenceRepository,
  type OpportunityCandidateRepository,
  type OpportunityEvidenceResult,
} from "@find-the-edge/database";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "@find-the-edge/domain";
import {
  ControlPlaneOpportunityProviderHealthSource,
  OpportunityCandidateService,
  StaticOpportunityProviderHealthSource,
  type OpportunityCandidateTelemetry,
  type OpportunityCandidateLifecycleProjector,
  type OpportunityGenerationEvent,
  type OpportunityProviderHealthSource,
} from "./opportunity-candidate-service";

const evaluatedAt = "2026-08-06T12:05:00.000Z";
const event: OpportunityGenerationEvent = {
  eventId: "event-1",
  eventVersion: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  participantIds: ["team-a", "team-b"],
  startsAt: "2026-08-06T17:00:00.000Z",
  status: "scheduled",
  markets: [
    {
      marketKey: "moneyline",
      selections: [
        { selectionKey: "team-a", point: null },
        { selectionKey: "team-b", point: null },
      ],
    },
  ],
};

function evidence(): OpportunityEvidenceResult {
  const book = (
    sportsbookId: string,
    americanOdds: readonly [number, number],
  ) => {
    const snapshots = (["team-a", "team-b"] as const).map(
      (selectionKey, index) =>
        normalizeFixtureOddsObservation({
          canonicalEventId: "event-1",
          canonicalEventVersion: 1,
          sportKey: "mlb",
          marketKey: "moneyline",
          selectionKey,
          sportsbookId,
          americanOdds: americanOdds[index]!,
          observedAt: "2026-08-06T12:00:00.000Z",
          retrievedAt: "2026-08-06T12:00:01.000Z",
        }),
    );
    const selectionAvailability = snapshots.map((snapshot) => ({
      identity: snapshot.partitionKey,
      state: "active" as const,
      observedAt: snapshot.observedAt,
      evidenceId: snapshot.snapshotId,
      reason: "active-price",
    }));
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(snapshots[0]!);
    return {
      sportsbookId,
      state: "active" as const,
      snapshots,
      selectionAvailability,
      groupAvailability: {
        identity: groupIdentity,
        state: "active" as const,
        observedAt: snapshots[0]!.observedAt,
        evidenceId: `group-${sportsbookId}`,
        reason: "active-market",
      },
      ageMinutes: 5,
    };
  };
  return {
    target: book("hardrock", [125, -145]),
    comparisons: [
      book("draftkings", [-105, -115]),
      book("fanduel", [-102, -118]),
      book("betmgm", [-104, -116]),
      book("caesars", [-101, -119]),
    ],
  };
}

function threeWayEvidence(): OpportunityEvidenceResult {
  const book = (sportsbookId: string, americanOdds: readonly number[]) => {
    const snapshots = ["home", "draw", "away"].map((selectionKey, index) =>
      normalizeFixtureOddsObservation({
        canonicalEventId: "match-1",
        canonicalEventVersion: 1,
        sportKey: "soccer",
        marketKey: "moneyline",
        selectionKey,
        sportsbookId,
        americanOdds: americanOdds[index]!,
        observedAt: "2026-08-06T12:00:00.000Z",
        retrievedAt: "2026-08-06T12:00:01.000Z",
      }),
    );
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(snapshots[0]!);
    return {
      sportsbookId,
      state: "active" as const,
      snapshots,
      selectionAvailability: snapshots.map((snapshot) => ({
        identity: snapshot.partitionKey,
        state: "active" as const,
        observedAt: snapshot.observedAt,
        evidenceId: snapshot.snapshotId,
        reason: "active-price",
      })),
      groupAvailability: {
        identity: groupIdentity,
        state: "active" as const,
        observedAt: snapshots[0]!.observedAt,
        evidenceId: `group-${sportsbookId}`,
        reason: "active-market",
      },
      ageMinutes: 5,
    };
  };
  return {
    target: book("hardrock", [260, 400, 400]),
    comparisons: ["draftkings", "fanduel", "betmgm", "caesars"].map(
      (sportsbookId) => book(sportsbookId, [150, 250, 250]),
    ),
  };
}

function service(input?: {
  eligible?: readonly OpportunityGenerationEvent[];
  evidence?: MemoryOpportunityEvidenceRepository;
  candidates?: OpportunityCandidateRepository;
  providerHealth?: OpportunityProviderHealthSource;
  healthy?: boolean;
  emit?: OpportunityCandidateTelemetry["emit"];
  lifecycle?: OpportunityCandidateLifecycleProjector;
}) {
  const candidates =
    input?.candidates ?? new MemoryOpportunityCandidateRepository();
  return {
    candidates,
    value: new OpportunityCandidateService({
      eligibleEvents: new MemoryEvaluationCandidateRepository(
        input?.eligible ?? [event],
      ),
      evidence:
        input?.evidence ?? new MemoryOpportunityEvidenceRepository(evidence()),
      candidates,
      providerHealth:
        input?.providerHealth ??
        new StaticOpportunityProviderHealthSource(
          "sharpapi",
          input?.healthy ?? true,
        ),
      lifecycle:
        input?.lifecycle ??
        ({ projectCandidate: vi.fn().mockResolvedValue(undefined) } as const),
      ...(input?.emit ? { telemetry: { emit: input.emit } } : {}),
    }),
  };
}

describe("opportunity candidate service", () => {
  it("binds source-reported control-plane health to durable evidence", async () => {
    const control = new MemoryOddsControlPlaneStore();
    await control.putHealth({
      version: 0,
      healthKey: "sharpapi:mlb:odds",
      providerId: "sharpapi",
      healthy: true,
      status: "degraded",
      degraded: true,
      consecutiveSuccesses: 1,
      updatedAt: "2026-08-06T12:00:00.000Z",
    });
    const evidence = await new ControlPlaneOpportunityProviderHealthSource(
      control,
      "sharpapi",
    ).read({
      sportKey: "mlb",
      leagueKey: "mlb",
      sportsbookId: "draftkings",
      asOf: evaluatedAt,
    });
    expect(evidence).toEqual(
      expect.objectContaining({
        healthKey: "sharpapi:mlb:odds",
        recordVersion: 1,
        status: "degraded",
        healthy: false,
      }),
    );
  });
  it("persists every offered selection with exact evidence and safe telemetry", async () => {
    const emit = vi.fn<OpportunityCandidateTelemetry["emit"]>();
    const generated = await service({ emit }).value.generate({
      evaluatedAt,
      events: [event],
      evaluationPolicy: defaultEvaluationPolicy,
    });
    expect(generated.candidates).toHaveLength(2);
    expect(generated.createdCount).toBe(2);
    expect(generated.qualifiedCount).toBe(1);
    expect(generated.disqualifiedCount).toBe(1);
    expect(generated.candidates[0]?.targetEvidence).toHaveLength(2);
    expect(generated.candidates[0]?.comparisonEvidence).toHaveLength(8);
    expect(
      generated.candidates[0]?.versions.calculation.root.algorithm.id,
    ).toBe("opportunity-qualification");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ candidateCount: 2, sportKey: "mlb" }),
    );
  });

  it("converges IDs, bytes, and repository outcomes under retry", async () => {
    const instance = service();
    const first = await instance.value.generate({
      evaluatedAt,
      events: [event],
    });
    const second = await instance.value.generate({
      evaluatedAt,
      events: [event],
    });
    expect(first.candidates).toEqual(second.candidates);
    expect(second.createdCount).toBe(0);
    expect(second.duplicateCount).toBe(2);
  });

  it("generates every selection in a three-way market", async () => {
    const match: OpportunityGenerationEvent = {
      eventId: "match-1",
      eventVersion: 1,
      sportKey: "soccer",
      leagueKey: "mls",
      participantIds: ["home", "away"],
      startsAt: "2026-08-06T17:00:00.000Z",
      status: "scheduled",
      markets: [
        {
          marketKey: "moneyline",
          selections: [
            { selectionKey: "home", point: null },
            { selectionKey: "draw", point: null },
            { selectionKey: "away", point: null },
          ],
        },
      ],
    };
    const generated = await service({
      eligible: [match],
      evidence: new MemoryOpportunityEvidenceRepository(threeWayEvidence()),
    }).value.generate({ evaluatedAt, events: [match] });
    expect(generated.candidates).toHaveLength(3);
    expect(
      generated.candidates.map(
        ({ logicalIdentity }) => logicalIdentity.selectionKey,
      ),
    ).toEqual(["away", "draw", "home"]);
  });

  it("canonicalizes reversed selections and rejects empty market lists", async () => {
    const fixture = service();
    const first = await fixture.value.generate({
      evaluatedAt,
      events: [event],
    });
    const reversed = {
      ...event,
      markets: event.markets.map((market) => ({
        ...market,
        selections: [...market.selections].reverse(),
      })),
    };
    const replay = await fixture.value.generate({
      evaluatedAt,
      events: [reversed],
    });
    expect(replay.candidates.map(({ occurrenceId }) => occurrenceId)).toEqual(
      first.candidates.map(({ occurrenceId }) => occurrenceId),
    );
    await expect(
      fixture.value.generate({
        evaluatedAt,
        events: [{ ...event, markets: [] }],
      }),
    ).rejects.toThrow("opportunity-generation-command-invalid");
  });

  it("binds partial snapshots to availability by immutable identity", async () => {
    const partial = evidence();
    const generated = await service({
      evidence: new MemoryOpportunityEvidenceRepository({
        ...partial,
        target: {
          ...partial.target,
          state: "incomplete",
          snapshots: partial.target.snapshots.slice(1),
        },
      }),
    }).value.generate({ evaluatedAt, events: [event] });
    expect(generated.candidates).toHaveLength(2);
    expect(generated.qualifiedCount).toBe(0);
    expect(
      generated.candidates.every(({ reasonCodes }) =>
        reasonCodes.includes("target-incomplete"),
      ),
    ).toBe(true);
    expect(
      generated.candidates.every(({ targetEvidence }) =>
        targetEvidence.every(
          ({ partitionKey, selectionAvailability }) =>
            selectionAvailability?.identity === partitionKey,
        ),
      ),
    ).toBe(true);
  });

  it("rejects mixed versions of one provider-health record", async () => {
    let call = 0;
    const providerHealth: OpportunityProviderHealthSource = {
      read(input) {
        call += 1;
        return Promise.resolve({
          providerId: "sharpapi",
          sportsbookId: input.sportsbookId,
          healthy: call % 2 === 1,
          checkedAt: evaluatedAt,
          healthKey: "sharpapi:mlb:odds",
          evidenceId: `sharpapi:mlb:odds@${call}`,
          leagueKey: input.leagueKey,
          capability: "odds",
          recordVersion: call,
          status: call % 2 === 1 ? "healthy" : "degraded",
        });
      },
    };
    await expect(
      service({ providerHealth }).value.generate({
        evaluatedAt,
        events: [event],
      }),
    ).rejects.toThrow("opportunity-provider-health-inconsistent");
  });

  it("fails closed when provider-health evidence exceeds the price window", async () => {
    const providerHealth: OpportunityProviderHealthSource = {
      read(input) {
        return Promise.resolve({
          providerId: "sharpapi",
          sportsbookId: input.sportsbookId,
          healthy: true,
          checkedAt: "2026-08-06T11:00:00.000Z",
          healthKey: "sharpapi:mlb:odds",
          evidenceId: "sharpapi:mlb:odds@7@2026-08-06T11:00:00.000Z",
          leagueKey: input.leagueKey,
          capability: "odds",
          recordVersion: 7,
          status: "healthy",
        });
      },
    };
    const generated = await service({ providerHealth }).value.generate({
      evaluatedAt,
      events: [event],
    });
    expect(generated.qualifiedCount).toBe(0);
    expect(
      generated.candidates.every(
        ({ providerHealth, reasonCodes }) =>
          providerHealth.every(({ status }) => status === "stale") &&
          reasonCodes.includes("target-provider-unhealthy"),
      ),
    ).toBe(true);
  });

  it("emits bounded zero-success telemetry", async () => {
    const emit = vi.fn<OpportunityCandidateTelemetry["emit"]>();
    await service({ emit }).value.generate({ evaluatedAt, events: [] });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        sportKey: "none",
        candidateCount: 0,
      }),
    );
  });

  it("persists event and provider business gates as disqualifications", async () => {
    const generated = await service({
      eligible: [],
      healthy: false,
    }).value.generate({
      evaluatedAt,
      events: [event],
    });
    expect(generated.qualifiedCount).toBe(0);
    expect(
      generated.candidates.every(
        ({ reasonCodes }) =>
          reasonCodes.includes("event-not-scheduled") &&
          reasonCodes.includes("target-provider-unhealthy"),
      ),
    ).toBe(true);
    expect(generated.candidates[0]?.qualificationGates).toEqual({
      eventStatus: "not-scheduled",
      marketApproved: true,
      minimumComparisonBooks: 3,
      maximumPriceAgeMinutes: 15,
      minimumExpectedValue: 0.02,
      disagreementWarningThreshold: 0.05,
      disagreementBlockThreshold: 0.1,
    });
  });

  it("propagates transient evidence failure without fabricating a decision", async () => {
    const candidates = new MemoryOpportunityCandidateRepository();
    const broken = new MemoryOpportunityEvidenceRepository(() => {
      throw new Error("throttled");
    });
    const instance = service({ evidence: broken, candidates });
    await expect(
      instance.value.generate({ evaluatedAt, events: [event] }),
    ).rejects.toThrow("throttled");
  });

  it("persists before lifecycle projection and converges projection on redelivery", async () => {
    const candidates = new MemoryOpportunityCandidateRepository();
    const projectCandidate = vi
      .fn<OpportunityCandidateLifecycleProjector["projectCandidate"]>()
      .mockRejectedValueOnce(new Error("projection-temporary"))
      .mockResolvedValue(undefined);
    const instance = service({
      candidates,
      lifecycle: { projectCandidate },
    });
    await expect(
      instance.value.generate({ evaluatedAt, events: [event] }),
    ).rejects.toThrow("projection-temporary");
    const replay = await instance.value.generate({
      evaluatedAt,
      events: [event],
    });
    expect(replay.duplicateCount).toBe(1);
    expect(projectCandidate).toHaveBeenCalledTimes(3);
    expect(projectCandidate.mock.calls[0]?.[0].occurrenceId).toBe(
      projectCandidate.mock.calls[1]?.[0].occurrenceId,
    );
  });

  it("reports bounded partial progress when a later write fails", async () => {
    const backing = new MemoryOpportunityCandidateRepository();
    let writes = 0;
    const candidates: OpportunityCandidateRepository = {
      persist(input) {
        writes += 1;
        if (writes === 2) return Promise.reject(new Error("write-failed"));
        return backing.persist(input);
      },
      get(occurrenceId) {
        return backing.get(occurrenceId);
      },
    };
    const emit = vi.fn<OpportunityCandidateTelemetry["emit"]>();
    await expect(
      service({ candidates, emit }).value.generate({
        evaluatedAt,
        events: [event],
      }),
    ).rejects.toThrow("write-failed");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        failureClass: "persistence",
        sportKey: "mlb",
        candidateCount: 1,
      }),
    );
  });
});
