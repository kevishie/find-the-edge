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
import {
  isOpportunityLifecycleHeadActive,
  normalizeOpportunityLifecycleHead,
  normalizeOpportunityLifecycleTransition,
  opportunityCandidateExpiresAt,
  reduceOpportunityLifecycle,
  type OpportunityLifecycleEventEvidence,
} from "./opportunity-lifecycle";

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
  warningCodes: [],
  values: {
    targetAmericanOdds: 120,
    targetImpliedProbability: 0.4545,
    consensusProbability: 0.5,
    fairAmericanOdds: 100,
    expectedValue: 0.1,
    marketDisagreement: 0.02,
  },
  targetEvidence: [
    snapshot("hardrock", "team-a", 120),
    snapshot("hardrock", "team-b", -130),
  ],
  comparisonEvidence: ["draftkings", "fanduel", "betmgm"].flatMap((book) => [
    snapshot(book, "team-a", 110),
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
      input: { candidate: true },
      precisionPolicyVersion: "display-v1",
    }),
  },
});

const event = (
  override: Partial<OpportunityLifecycleEventEvidence> = {},
): OpportunityLifecycleEventEvidence => ({
  availability: "current",
  canonicalEventId: "event-1",
  canonicalEventVersion: 2,
  sportKey: "mlb",
  status: "scheduled",
  startsAt: "2026-08-06T20:00:00.000Z",
  observedAt: "2026-08-06T12:04:00.000Z",
  identity: "EVENT_DETAIL#event-1#CURRENT",
  evidenceId: "event-1@2@scheduled",
  ...override,
});

const project = (occurredAt = "2026-08-06T12:05:00.000Z", evidence = event()) =>
  reduceOpportunityLifecycle(null, {
    commandId: `candidate-command-${occurredAt}`,
    cause: "candidate",
    candidate: createOpportunityCandidate(input()),
    eventEvidence: evidence,
    occurredAt,
  });

describe("opportunity lifecycle", () => {
  it("uses the oldest required evidence rather than evaluation time", () => {
    expect(
      opportunityCandidateExpiresAt(
        createOpportunityCandidate(input()),
        event(),
      ),
    ).toBe("2026-08-06T12:15:00.001Z");
  });

  it("enforces the exclusive expiration boundary on active reads", () => {
    const decision = project();
    if (decision.outcome !== "applied") throw new Error("not applied");
    expect(decision.head.state).toBe("active");
    expect(
      isOpportunityLifecycleHeadActive(
        decision.head,
        "2026-08-06T12:15:00.000Z",
      ),
    ).toBe(true);
    expect(
      isOpportunityLifecycleHeadActive(
        decision.head,
        "2026-08-06T12:15:00.001Z",
      ),
    ).toBe(false);
    const expired = reduceOpportunityLifecycle(decision.head, {
      commandId: "expiry-command",
      cause: "sweep",
      candidate: createOpportunityCandidate(input()),
      eventEvidence: event(),
      occurredAt: "2026-08-06T12:15:00.001Z",
    });
    expect(expired.outcome).toBe("applied");
    if (expired.outcome === "applied") {
      expect(expired.head.state).toBe("stale");
      expect(expired.head).not.toHaveProperty("activePk");
    }
  });

  it.each([
    ["postponed", "suspended"],
    ["unknown", "suspended"],
    ["started", "closed"],
    ["completed", "closed"],
    ["cancelled", "closed"],
  ] as const)("maps %s event state to %s", (status, expected) => {
    const decision = project("2026-08-06T12:05:00.000Z", event({ status }));
    expect(decision.outcome).toBe("applied");
    if (decision.outcome === "applied")
      expect(decision.head.state).toBe(expected);
  });

  it("keeps fresh business failures disqualified", () => {
    const qualified = input();
    const candidate = createOpportunityCandidate({
      ...qualified,
      status: "disqualified",
      reasonCodes: ["ev-below-threshold"],
      values: { ...qualified.values, expectedValue: 0.01 },
    });
    const decision = reduceOpportunityLifecycle(null, {
      commandId: "business-disqualification",
      cause: "candidate",
      candidate,
      eventEvidence: event(),
      occurredAt: candidate.evaluatedAt,
    });
    expect(decision.outcome).toBe("applied");
    if (decision.outcome === "applied") {
      expect(decision.head.state).toBe("disqualified");
      expect(decision.head.candidateReasonCodes).toEqual([
        "ev-below-threshold",
      ]);
    }
  });

  it("closes exactly at start and never revives the logical opportunity", () => {
    const closed = project(
      "2026-08-06T20:00:00.000Z",
      event({ startsAt: "2026-08-06T20:00:00.000Z" }),
    );
    if (closed.outcome !== "applied") throw new Error("not applied");
    expect(closed.head.state).toBe("closed");
    const replay = reduceOpportunityLifecycle(closed.head, {
      commandId: "later-qualified",
      cause: "candidate",
      candidate: createOpportunityCandidate({
        ...input(),
        evaluatedAt: "2026-08-06T20:01:00.000Z",
      }),
      eventEvidence: event({ startsAt: "2026-08-07T20:00:00.000Z" }),
      occurredAt: "2026-08-06T20:01:00.000Z",
    });
    expect(replay.outcome).toBe("closed");
  });

  it("deduplicates commands and rejects equal-time competing occurrences", () => {
    const first = project();
    if (first.outcome !== "applied") throw new Error("not applied");
    const duplicate = reduceOpportunityLifecycle(first.head, {
      commandId: first.head.lastCommandId,
      cause: "candidate",
      candidate: createOpportunityCandidate(input()),
      eventEvidence: event(),
      occurredAt: "2026-08-06T12:05:01.000Z",
    });
    expect(duplicate.outcome).toBe("duplicate");
    const competingInput = input();
    const competing = {
      ...competingInput,
      values: { ...competingInput.values, expectedValue: 0.11 },
    };
    expect(() =>
      reduceOpportunityLifecycle(first.head, {
        commandId: "different-occurrence",
        cause: "candidate",
        candidate: createOpportunityCandidate(competing),
        eventEvidence: event(),
        occurredAt: "2026-08-06T12:05:01.000Z",
      }),
    ).toThrow("opportunity-lifecycle-equal-time-conflict");
  });

  it("never revives a swept occurrence or moves transition chronology backward", () => {
    const first = project();
    if (first.outcome !== "applied") throw new Error("not applied");
    const swept = reduceOpportunityLifecycle(first.head, {
      commandId: "sweep-expired",
      cause: "sweep",
      candidate: createOpportunityCandidate(input()),
      eventEvidence: event(),
      occurredAt: "2026-08-06T12:15:00.001Z",
    });
    if (swept.outcome !== "applied") throw new Error("not swept");
    expect(swept.head.state).toBe("stale");
    const replay = reduceOpportunityLifecycle(swept.head, {
      commandId: "candidate-redelivery",
      cause: "candidate",
      candidate: createOpportunityCandidate(input()),
      eventEvidence: event(),
      occurredAt: "2026-08-06T12:05:00.000Z",
    });
    expect(replay.outcome).toBe("ignored-older");
    expect(replay.head.state).toBe("stale");
    expect(replay.head.transitionedAt).toBe("2026-08-06T12:15:00.001Z");
  });

  it("suspends an older current event version and closes only a newer one", () => {
    const older = project(
      "2026-08-06T12:05:00.000Z",
      event({ canonicalEventVersion: 1 }),
    );
    const newer = project(
      "2026-08-06T12:05:00.000Z",
      event({ canonicalEventVersion: 3 }),
    );
    expect(older.outcome).toBe("applied");
    expect(newer.outcome).toBe("applied");
    if (older.outcome === "applied") expect(older.head.state).toBe("suspended");
    if (newer.outcome === "applied") expect(newer.head.state).toBe("closed");
  });

  it("ignores excluded health and rejects ambiguous required-book health", () => {
    const base = input();
    const withUnusedStale = createOpportunityCandidate({
      ...base,
      providerHealth: [
        ...base.providerHealth,
        {
          providerId: "other",
          sportsbookId: "unused",
          healthy: false,
          checkedAt: "2026-08-06T11:00:00.000Z",
          healthKey: "other:mlb:odds",
          evidenceId: "unused-health",
          leagueKey: "mlb",
          capability: "odds",
          recordVersion: 1,
          status: "stale",
        },
      ],
    });
    expect(opportunityCandidateExpiresAt(withUnusedStale, event())).toBe(
      "2026-08-06T12:15:00.001Z",
    );
    const active = reduceOpportunityLifecycle(null, {
      commandId: "unused-health",
      cause: "candidate",
      candidate: withUnusedStale,
      eventEvidence: event(),
      occurredAt: withUnusedStale.evaluatedAt,
    });
    expect(active.outcome === "applied" && active.head.state).toBe("active");

    const ambiguous = createOpportunityCandidate({
      ...base,
      providerHealth: [
        ...base.providerHealth,
        {
          ...base.providerHealth[0]!,
          providerId: "backup-provider",
          healthKey: "backup:mlb:odds",
          evidenceId: "backup-hardrock-health",
        },
      ],
    });
    expect(() => opportunityCandidateExpiresAt(ambiguous, event())).toThrow(
      "opportunity-expiration-health-ambiguous",
    );
  });

  it("guards version overflow and validates stored event and transition bindings", () => {
    const first = project();
    if (first.outcome !== "applied") throw new Error("not applied");
    expect(() =>
      reduceOpportunityLifecycle(
        { ...first.head, stateVersion: Number.MAX_SAFE_INTEGER },
        {
          commandId: "overflow-sweep",
          cause: "sweep",
          candidate: createOpportunityCandidate(input()),
          eventEvidence: event({ status: "postponed" }),
          occurredAt: "2026-08-06T12:06:00.000Z",
        },
      ),
    ).toThrow("opportunity-lifecycle-version-overflow");
    expect(() =>
      normalizeOpportunityLifecycleHead({
        ...first.head,
        eventEvidence: { ...first.head.eventEvidence, sportKey: "nba" },
      }),
    ).toThrow("stored-opportunity-lifecycle-invalid");
    expect(() =>
      normalizeOpportunityLifecycleTransition({
        ...first.transition,
        fromState: "active",
      }),
    ).toThrow("stored-opportunity-lifecycle-transition-invalid");
  });
});
