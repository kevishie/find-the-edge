import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createCalculationProvenance,
  createOpportunityCandidate,
  OPPORTUNITY_QUALIFICATION_VERSION,
  type OpportunityCandidateInput,
} from "@find-the-edge/domain";
import { DynamoOpportunityCandidateRepository } from "./dynamodb-opportunity-candidate-repository";

const input = (): OpportunityCandidateInput => ({
  logicalIdentity: {
    canonicalEventId: "event-1",
    canonicalEventVersion: 1,
    sportKey: "mlb",
    marketKey: "moneyline",
    selectionKey: "team-a",
    point: null,
    targetSportsbookId: "hardrock",
    strategyId: "find-the-edge",
    strategyVersion: "2.1.0",
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
    sportModule: { id: "mlb", version: "1.0.0" },
    strategy: { id: "find-the-edge", version: "2.1.0" },
    evaluationPolicy: { id: "policy", version: "1" },
    calculation: createCalculationProvenance({
      algorithm: {
        id: "opportunity-qualification",
        version: OPPORTUNITY_QUALIFICATION_VERSION,
      },
      input: { state: "missing" },
      precisionPolicyVersion: "display-v1",
    }),
  },
});

describe("Dynamo opportunity candidate repository", () => {
  it("strongly rereads and verifies an exact conditional replay", async () => {
    const intended = createOpportunityCandidate(input());
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("condition"), {
          name: "ConditionalCheckFailedException",
        }),
      )
      .mockResolvedValueOnce({ Item: { value: intended } });
    const repository = new DynamoOpportunityCandidateRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    const result = await repository.persist(input());
    expect(result).toEqual({ outcome: "duplicate", candidate: intended });
    const replayRead = send.mock.calls[1]?.[0] as
      { readonly input: { readonly ConsistentRead?: boolean } } | undefined;
    expect(replayRead?.input.ConsistentRead).toBe(true);
  });

  it("rejects a conditional conflict with mismatched content", async () => {
    const changed = input();
    const wrong = createOpportunityCandidate({
      ...changed,
      evaluatedAt: "2026-08-06T12:01:00.000Z",
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("condition"), {
          name: "ConditionalCheckFailedException",
        }),
      )
      .mockResolvedValueOnce({ Item: { value: wrong } });
    const repository = new DynamoOpportunityCandidateRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await expect(repository.persist(input())).rejects.toThrow(
      "opportunity-candidate-replay-conflict",
    );
  });

  it("rejects a stored value whose occurrence identity does not match the requested key", async () => {
    const stored = createOpportunityCandidate(input());
    const repository = new DynamoOpportunityCandidateRepository(
      {
        send: vi.fn().mockResolvedValue({ Item: { value: stored } }),
      } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await expect(
      repository.get("opportunity-occurrence:wrong"),
    ).rejects.toThrow("opportunity-candidate-key-mismatch");
  });
});
