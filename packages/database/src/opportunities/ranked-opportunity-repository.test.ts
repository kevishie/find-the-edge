import { describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  opportunityRankKey,
  opportunityRankPartition,
  type OpportunityLifecycleHead,
  type OpportunityRankingPolicyContract,
  type RankedOpportunityProjection,
} from "@find-the-edge/domain";
import { EventCursorCodec } from "../event-repository";
import {
  DynamoRankedOpportunityRepository,
  MemoryRankedOpportunityRepository,
  OpportunityCursorCodec,
  type RankedOpportunityFilter,
} from "./ranked-opportunity-repository";

const policy: OpportunityRankingPolicyContract & {
  readonly maximumPhysicalRows: number;
} = {
  id: "find-the-edge-opportunity-ranking",
  version: "1.0.0",
  maximumFilterAgeMinutes: 15,
  maximumPhysicalRows: 200,
};
const eventCursor = () =>
  new EventCursorCodec(
    { current: { id: "current", secret: Buffer.alloc(32, 17) } },
    60_000,
    0,
  );
const filter: RankedOpportunityFilter = {
  sportKey: "mlb",
  marketKey: "moneyline",
};
const key = {
  pk: `OPPORTUNITY_RANK#opportunity:${"a".repeat(64)}`,
  sk: "CURRENT",
  rankPk: "ACTIVE_OPPORTUNITY_RANK#find-the-edge-opportunity-ranking@1.0.0#mlb",
  rankSk: `R1#${"0".repeat(16)}#000#000#000#opportunity:${"a".repeat(64)}`,
};
const projection = (
  logicalOpportunityId: string,
  sportKey = "mlb",
  scoredAt = "2026-08-06T12:00:00.000Z",
): RankedOpportunityProjection => {
  const rankPartition = opportunityRankPartition(policy, sportKey);
  const rankKey = opportunityRankKey({
    expectedValue: 0.1,
    confidence: 100,
    freshness: 100,
    sportsbookCoverage: 100,
    logicalOpportunityId,
  });
  return {
    schemaVersion: "ranked-opportunity-projection-v1",
    rankingPolicy: { id: policy.id, version: policy.version },
    logicalOpportunityId,
    candidateOccurrenceId: `opportunity-occurrence:${"b".repeat(64)}`,
    lifecycleStateVersion: 1,
    canonicalEventId: "event-1",
    canonicalEventVersion: 1,
    sportKey,
    marketKey: "moneyline",
    selectionKey: "team-a",
    point: null,
    targetSportsbookId: "hardrock",
    scoredAt,
    expiresAt: "2026-08-06T12:15:00.001Z",
    expectedValue: 0.1,
    confidence: {
      score: 100,
      bucket: "high",
      weakestComponent: "freshness",
      components: { freshness: 100, coverage: 100, agreement: 100 },
    },
    inputs: {
      oldestRequiredEvidenceAt: scoredAt,
      maximumPriceAgeMinutes: 15,
      includedComparisonBooks: 1,
      uniqueNonTargetComparisonBooksWithEvidence: 1,
      marketDisagreement: 0,
      disagreementBlockThreshold: 0.15,
    },
    warningCodes: [],
    rankPartition,
    rankKey,
  };
};
const stored = (value: RankedOpportunityProjection) => ({
  pk: `OPPORTUNITY_RANK#${value.logicalOpportunityId}`,
  sk: "CURRENT",
  rankPk: value.rankPartition,
  rankSk: value.rankKey,
  value,
});

describe("ranked opportunity repository", () => {
  it("encrypts a cursor bound to exact filters, rank policy, and expiry", () => {
    const cursors = new OpportunityCursorCodec(eventCursor());
    const issued = new Date("2026-08-06T12:00:00.000Z");
    const token = cursors.encode(
      policy,
      filter,
      key,
      "2026-08-06T12:00:00.000Z",
      issued,
    );
    expect(token).not.toContain(key.rankSk);
    expect(cursors.decode(token, policy, filter, issued)).toEqual({
      key,
      asOf: "2026-08-06T12:00:00.000Z",
    });
    expect(() =>
      cursors.decode(token, policy, { ...filter, marketKey: "spread" }, issued),
    ).toThrow("invalid-cursor");
    expect(() =>
      cursors.decode(
        `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
        policy,
        filter,
        issued,
      ),
    ).toThrow("invalid-cursor");
    expect(() =>
      cursors.decode(
        token,
        policy,
        filter,
        new Date("2026-08-06T12:01:00.001Z"),
      ),
    ).toThrow();
  });

  it("strongly rejects a lagging keys-only row", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [key] })
      .mockResolvedValueOnce({});
    const repository = new DynamoRankedOpportunityRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
      policy,
      new OpportunityCursorCodec(eventCursor()),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => new Date("2026-08-06T12:00:00.000Z"),
    );
    const page = await repository.list({ sportKey: "mlb", limit: 10 });
    expect(page).toMatchObject({
      items: [],
      evaluationState: "complete",
      evaluatedCount: 1,
      staleCount: 1,
    });
    const strongRead = send.mock.calls[1]?.[0] as
      { input: { ConsistentRead?: boolean } } | undefined;
    expect(strongRead?.input.ConsistentRead).toBe(true);
  });

  it("caps physical evaluation honestly across index pages", async () => {
    let page = 0;
    const send = vi.fn((command: unknown) => {
      if (!(command instanceof QueryCommand))
        throw new Error("unexpected-strong-read");
      page += 1;
      return Promise.resolve({
        Items: Array.from({ length: 50 }, (_, index) => ({
          ...key,
          pk: `${key.pk}-${page}-${index}`,
          unexpected: true,
        })),
        LastEvaluatedKey: {
          ...key,
          pk: `${key.pk}-${page}-49`,
        },
      });
    });
    const repository = new DynamoRankedOpportunityRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
      policy,
      new OpportunityCursorCodec(eventCursor()),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => new Date("2026-08-06T12:00:00.000Z"),
    );
    const result = await repository.list({ sportKey: "mlb", limit: 10 });
    expect(result).toMatchObject({
      items: [],
      evaluationState: "partial",
      hasMoreUnknown: true,
      evaluatedCount: 200,
      staleCount: 200,
    });
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("rejects a detail row whose stored projection names another opportunity", async () => {
    const requestedId = `opportunity:${"a".repeat(64)}`;
    const other = projection(`opportunity:${"b".repeat(64)}`);
    const send = vi.fn().mockResolvedValue({
      Item: { ...stored(other), pk: `OPPORTUNITY_RANK#${requestedId}` },
    });
    const repository = new DynamoRankedOpportunityRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
      policy,
      new OpportunityCursorCodec(eventCursor()),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => new Date("2026-08-06T12:00:00.000Z"),
    );
    await expect(repository.detail("mlb", requestedId)).resolves.toBeNull();
  });

  it("excludes projections created after a continuation snapshot", async () => {
    const value = projection(
      `opportunity:${"a".repeat(64)}`,
      "mlb",
      "2026-08-06T12:00:01.000Z",
    );
    const item = stored(value);
    const send = vi.fn((command: unknown) => {
      if (command instanceof QueryCommand)
        return Promise.resolve({
          Items: [
            {
              pk: item.pk,
              sk: item.sk,
              rankPk: item.rankPk,
              rankSk: item.rankSk,
            },
          ],
        });
      if (command instanceof GetCommand) return Promise.resolve({ Item: item });
      throw new Error("unexpected-command");
    });
    const repository = new DynamoRankedOpportunityRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
      policy,
      new OpportunityCursorCodec(eventCursor()),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () => new Date("2026-08-06T12:00:00.000Z"),
    );
    await expect(
      repository.list({ sportKey: "mlb", limit: 10 }),
    ).resolves.toMatchObject({
      items: [],
      staleCount: 1,
    });
  });

  it("keeps memory lists sport-scoped and reports an exact 200-row end as complete", async () => {
    const repository = new MemoryRankedOpportunityRepository(policy);
    const records = (
      repository as unknown as {
        records: Map<string, Record<string, unknown>>;
      }
    ).records;
    records.set("soccer-only", {
      projection: { sportKey: "soccer", rankKey: "000" },
    });
    await expect(
      repository.list({ sportKey: "mlb", limit: 10 }),
    ).resolves.toMatchObject({
      items: [],
      evaluatedCount: 0,
    });

    for (let index = 0; index < 200; index += 1) {
      const id = `opportunity:${index.toString(16).padStart(64, "0")}`;
      const head: OpportunityLifecycleHead = {
        schemaVersion: "opportunity-lifecycle-v1",
        logicalOpportunityId: id,
        canonicalEventId: `event-${index}`,
        canonicalEventVersion: 1,
        sportKey: "mlb",
        state: "stale",
        stateVersion: 1,
        latestCandidateOccurrenceId: `opportunity-occurrence:${index
          .toString(16)
          .padStart(64, "0")}`,
        latestCandidateEvaluatedAt: "2026-08-06T12:00:00.000Z",
        reasonCodes: ["candidate-evidence-stale"],
        candidateReasonCodes: [],
        expiresAt: null,
        eventEvidence: {
          availability: "current",
          canonicalEventId: `event-${index}`,
          canonicalEventVersion: 1,
          sportKey: "mlb",
          status: "scheduled",
          startsAt: "2026-08-06T20:00:00.000Z",
          observedAt: "2026-08-06T12:00:00.000Z",
          identity: `EVENT_DETAIL#event-${index}#CURRENT`,
          evidenceId: `event-${index}@1`,
        },
        transitionedAt: "2026-08-06T12:00:00.000Z",
        lastTransitionId: `transition-${index}`,
        lastCommandId: `command-${index}`,
      };
      records.set(id, {
        projection: {
          sportKey: "mlb",
          rankKey: index.toString().padStart(4, "0"),
        },
        head,
      });
    }
    await expect(
      repository.list({ sportKey: "mlb", limit: 50 }),
    ).resolves.toMatchObject({
      items: [],
      evaluatedCount: 200,
      evaluationState: "complete",
      hasMoreUnknown: false,
      nextCursor: null,
    });
  });
});
