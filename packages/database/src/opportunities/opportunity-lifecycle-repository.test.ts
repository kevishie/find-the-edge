import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createCalculationProvenance,
  createOpportunityCandidate,
  OPPORTUNITY_QUALIFICATION_VERSION,
  type OpportunityCandidateInput,
  type OpportunityLifecycleCommand,
} from "@find-the-edge/domain";
import { DynamoOpportunityLifecycleRepository } from "./dynamodb-opportunity-lifecycle-repository";
import { MemoryOpportunityLifecycleRepository } from "./opportunity-lifecycle-repository";

const candidateInput = (): OpportunityCandidateInput => ({
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
const candidate = () => createOpportunityCandidate(candidateInput());
const command = (): OpportunityLifecycleCommand => ({
  commandId: "candidate-command",
  cause: "candidate",
  candidate: candidate(),
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
  occurredAt: "2026-08-06T12:00:00.000Z",
});
const fence = {
  pk: "EVENT_DETAIL#event-1",
  sk: "CURRENT",
  expectedMaterialVersion: 1,
};

describe("opportunity lifecycle repository", () => {
  it("persists a CAS head and immutable transition in one transaction", async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const repository = new DynamoOpportunityLifecycleRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    const result = await repository.apply(command(), fence);
    expect(result.outcome).toBe("applied");
    const transaction = send.mock.calls[1]?.[0] as {
      input: { TransactItems: readonly unknown[] };
    };
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(JSON.stringify(transaction.input)).toContain("materialVersion");
    expect(JSON.stringify(transaction.input)).not.toContain("activePk");
  });

  it("converges duplicate commands without another transition version", async () => {
    const memory = new MemoryOpportunityLifecycleRepository();
    const first = await memory.apply(command(), fence);
    const second = await memory.apply(command(), fence);
    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("duplicate");
    expect(await memory.history(candidate().logicalOpportunityId)).toHaveLength(
      1,
    );
  });

  it("strongly filters lagging active-index rows", async () => {
    const memory = new MemoryOpportunityLifecycleRepository();
    const stored = await memory.apply(command(), fence);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            pk: `OPPORTUNITY_LIFECYCLE#${stored.head.logicalOpportunityId}`,
            sk: "HEAD",
          },
        ],
      })
      .mockResolvedValueOnce({ Item: { value: stored.head } });
    const repository = new DynamoOpportunityLifecycleRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    const page = await repository.discoverActive({
      sportKey: "mlb",
      asOf: "2026-08-06T12:00:00.000Z",
      limit: 10,
    });
    expect(page.items).toEqual([]);
    expect(page.staleActiveCount).toBe(1);
    expect(page.staleActiveKeys).toHaveLength(1);
    const reread = send.mock.calls[1]?.[0] as {
      input: { ConsistentRead?: boolean };
    };
    expect(reread.input.ConsistentRead).toBe(true);
  });

  it("reads every immutable history page", async () => {
    const memory = new MemoryOpportunityLifecycleRepository();
    const first = await memory.apply(command(), fence);
    const second = await memory.apply(
      {
        ...command(),
        commandId: "sweep-command",
        cause: "sweep",
        occurredAt: "2026-08-06T12:01:00.000Z",
        eventEvidence: {
          availability: "missing",
          canonicalEventId: "event-1",
          canonicalEventVersion: null,
          sportKey: null,
          status: null,
          startsAt: null,
          observedAt: null,
          identity: "EVENT_DETAIL#event-1#CURRENT",
          evidenceId: "event-1@missing",
        },
      },
      { ...fence, expectedMaterialVersion: null },
    );
    if (!first.transition || !second.transition)
      throw new Error("missing fixture transition");
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ value: first.transition }],
        LastEvaluatedKey: { pk: "page-1", sk: "transition-1" },
      })
      .mockResolvedValueOnce({ Items: [{ value: second.transition }] });
    const history = await new DynamoOpportunityLifecycleRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    ).history(candidate().logicalOpportunityId);
    expect(history.map(({ stateVersion }) => stateVersion)).toEqual([1, 2]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      (send.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({
      ExclusiveStartKey: { pk: "page-1", sk: "transition-1" },
    });
  });

  it("does not wrap memory pagination when a cursor sorts after every row", async () => {
    const memory = new MemoryOpportunityLifecycleRepository();
    const stored = await memory.apply(command(), fence);
    const fakeActive = {
      ...stored.head,
      state: "active",
      expiresAt: "2026-08-06T12:15:00.001Z",
      activePk: "ACTIVE_OPPORTUNITY#mlb",
      activeSk: `2026-08-06T12:15:00.001Z#${stored.head.logicalOpportunityId}`,
    } as const;
    (
      memory as unknown as {
        heads: Map<string, typeof fakeActive>;
      }
    ).heads.set(fakeActive.logicalOpportunityId, fakeActive);
    const page = await memory.discoverActive({
      sportKey: "mlb",
      asOf: "2026-08-06T12:00:00.000Z",
      through: "2026-08-06T13:00:00.000Z",
      limit: 10,
      cursor: "zzzz",
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("persists and strongly reloads durable sweep continuation", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { cursor: "next-page" } })
      .mockResolvedValueOnce({});
    const repository = new DynamoOpportunityLifecycleRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await expect(repository.getSweepCursor("mlb", "due")).resolves.toBe(
      "next-page",
    );
    await repository.setSweepCursor({
      sportKey: "mlb",
      mode: "due",
      cursor: null,
      updatedAt: "2026-08-06T12:00:00.000Z",
    });
    expect(
      (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({ ConsistentRead: true });
    expect(
      (send.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({
      Item: {
        pk: "OPPORTUNITY_LIFECYCLE_SWEEP#mlb",
        sk: "CHECKPOINT#due",
        cursor: null,
      },
    });
  });

  it("isolates a corrupt discovered head and continues the page", async () => {
    const stored = await new MemoryOpportunityLifecycleRepository().apply(
      command(),
      fence,
    );
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          { pk: "OPPORTUNITY_LIFECYCLE#corrupt", sk: "HEAD" },
          {
            pk: `OPPORTUNITY_LIFECYCLE#${stored.head.logicalOpportunityId}`,
            sk: "HEAD",
          },
        ],
      })
      .mockResolvedValueOnce({ Item: { value: { invalid: true } } })
      .mockResolvedValueOnce({ Item: { value: stored.head } });
    const page = await new DynamoOpportunityLifecycleRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    ).discoverActive({
      sportKey: "mlb",
      asOf: "2026-08-06T12:00:00.000Z",
      limit: 10,
    });
    expect(page.discoveryFailureCount).toBe(1);
    expect(page.discoveryFailureKeys).toHaveLength(1);
    expect(page.staleActiveCount).toBe(2);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
