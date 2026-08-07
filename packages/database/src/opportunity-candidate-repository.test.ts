import { describe, expect, it } from "vitest";
import {
  createCalculationProvenance,
  OPPORTUNITY_QUALIFICATION_VERSION,
} from "@find-the-edge/domain";
import { MemoryOpportunityCandidateRepository } from "./opportunity-candidate-repository";

const input = () => ({
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
    eventStatus: "scheduled" as const,
    marketApproved: true,
    minimumComparisonBooks: 3,
    maximumPriceAgeMinutes: 15,
    minimumExpectedValue: 0.02,
    disagreementWarningThreshold: 0.08,
    disagreementBlockThreshold: 0.15,
  },
  status: "disqualified" as const,
  reasonCodes: [
    "insufficient-comparison-books" as const,
    "target-missing" as const,
    "target-provider-unhealthy" as const,
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
      input: { status: "target-missing" },
      precisionPolicyVersion: "display-v1",
    }),
  },
});

describe("opportunity candidate repository", () => {
  it("converges exact retries and creates new occurrences for changed inputs", async () => {
    const repository = new MemoryOpportunityCandidateRepository();
    const created = await repository.persist(input());
    const duplicate = await repository.persist(input());
    expect(created.outcome).toBe("created");
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.candidate).toEqual(created.candidate);
    const changed = input();
    const next = await repository.persist({
      ...changed,
      evaluatedAt: "2026-08-06T12:01:00.000Z",
    });
    expect(next.outcome).toBe("created");
    expect(next.candidate.logicalOpportunityId).toBe(
      created.candidate.logicalOpportunityId,
    );
    expect(next.candidate.occurrenceId).not.toBe(
      created.candidate.occurrenceId,
    );
  });
});
