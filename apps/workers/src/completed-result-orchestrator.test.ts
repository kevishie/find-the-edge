import { describe, expect, it } from "vitest";
import type {
  CanonicalEvent,
  IsoTimestamp,
  SportKey,
} from "@find-the-edge/domain";
import { MemoryResultRepository } from "@find-the-edge/database";
import {
  CompletedResultsAdapterRegistry,
  FeedCoverageRegistry,
  FixtureCompletedResultsAdapter,
  fixtureDevelopmentProvider,
} from "@find-the-edge/providers";
import {
  defaultFeedCoveragePolicies,
  feedCoverageCatalogVersion,
} from "@find-the-edge/config";
import { CompletedResultOrchestrator } from "./completed-result-orchestrator";
const at = (v: string) => v as IsoTimestamp;
const sport = "mlb" as SportKey;
const event = {
  id: "event-1",
  sportKey: sport,
  leagueId: "league" as never,
  leagueKey: "mlb",
  participantIds: ["away", "home"] as never,
  startsAt: at("2026-08-03T20:00:00.000Z"),
  phase: "final",
  status: "completed",
  evidence: [],
  revisions: {},
  updatedAt: at("2026-08-03T22:00:00.000Z"),
  candidateIdentity: "x",
  version: 3,
} as unknown as CanonicalEvent;
const descriptor = fixtureDevelopmentProvider;
const raw = (providerEventId: string, sequence = 1) => ({
  providerEventId,
  sportKey: sport,
  leagueKey: "mlb",
  state: "final" as const,
  scoreScope: "regulation" as const,
  scores: [
    { providerParticipantId: "away", score: 2 },
    { providerParticipantId: "home", score: 4 + sequence },
  ],
  providerTimestamp: at(`2026-08-03T2${sequence}:00:00.000Z`),
  revision: {
    providerId: descriptor.id,
    authorityRank: 10,
    updatedAt: at(`2026-08-03T2${sequence}:00:00.000Z`),
    sequence,
    token: `r${sequence}`,
  },
});
describe("completed result orchestration", () => {
  it("finalizes exact mappings and retains unknown events", async () => {
    const adapter = new FixtureCompletedResultsAdapter(
      descriptor,
      sport,
      "mlb",
      [[raw("known"), raw("missing")]],
    );
    const repo = new MemoryResultRepository();
    const orchestrator = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      {
        resolveExactCanonicalBinding: (input) =>
          Promise.resolve(input.providerEventId === "known" ? event : null),
      },
      repo,
      {
        resolve: ({ providerParticipantIds }) =>
          Promise.resolve(
            providerParticipantIds
              .map((id) => ({
                providerParticipantId: id,
                canonicalParticipantId: id as never,
              }))
              .reverse(),
          ),
      },
    );
    const run = await orchestrator.execute({
      attemptId: "run",
      sportKey: sport,
      leagueKey: "mlb",
      windowStart: at("2026-08-01T00:00:00.000Z"),
      windowEnd: at("2026-08-04T00:00:00.000Z"),
      pageLimit: 10,
      maxPages: 2,
    });
    expect(run.status).toBe("succeeded");
    expect(run.counters).toMatchObject({ finalized: 1, unresolved: 1 });
    expect((await repo.unresolvedPage(descriptor.id, 100)).items).toHaveLength(
      1,
    );
    expect(
      (await repo.unresolvedPage(descriptor.id, 100)).items[0],
    ).toMatchObject({
      scoreScope: "regulation",
      scores: raw("missing").scores,
      sourceProvenance: `${descriptor.id}:results`,
    });
    expect((await repo.current("event-1"))?.scores).toEqual([
      { participantId: "away", score: 2 },
      { participantId: "home", score: 5 },
    ]);
    const replay = await orchestrator.execute({
      attemptId: "replay",
      sportKey: sport,
      leagueKey: "mlb",
      windowStart: at("2026-08-01T00:00:00.000Z"),
      windowEnd: at("2026-08-04T00:00:00.000Z"),
      pageLimit: 10,
      maxPages: 2,
    });
    expect(replay.counters).toMatchObject({ duplicate: 1, stale: 0 });
  });
  it("isolates checkpoint identities and rejects corrupt stored checkpoints before provider calls", async () => {
    let calls = 0;
    const adapter = {
      descriptor,
      sportKey: sport,
      leagueKey: "mlb",
      listCompletedResults: () => {
        calls++;
        return Promise.resolve({
          results: [],
          retrievedAt: at("2026-08-03T23:00:00.000Z"),
          providerRequests: 1,
          quotaUsed: 0,
        });
      },
    };
    const repo = new MemoryResultRepository();
    const base = {
      attemptId: "x",
      sportKey: sport,
      leagueKey: "mlb",
      windowStart: at("2026-08-01T00:00:00.000Z"),
      windowEnd: at("2026-08-04T00:00:00.000Z"),
      pageLimit: 10,
      maxPages: 1,
      mode: "scheduled" as const,
    };
    const key = `${descriptor.id}:mlb:mlb:scheduled`;
    const o = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(null) },
      repo,
      { resolve: () => Promise.resolve(null) },
    );
    for (const checkpoint of [
      "{bad",
      JSON.stringify({
        cursor: "x",
        windowStart: base.windowStart,
        windowEnd: base.windowEnd,
      }),
      JSON.stringify({
        cursor: " x",
        windowStart: base.windowStart,
        windowEnd: base.windowEnd,
        mode: "scheduled",
      }),
      JSON.stringify({
        cursor: "x",
        windowStart: "not-iso",
        windowEnd: base.windowEnd,
        mode: "scheduled",
      }),
      JSON.stringify({
        cursor: "x",
        windowStart: base.windowEnd,
        windowEnd: base.windowStart,
        mode: "scheduled",
      }),
      JSON.stringify({
        cursor: "x",
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: base.windowEnd,
        mode: "scheduled",
      }),
    ]) {
      await repo.saveCheckpoint(key, checkpoint);
      expect(await o.execute(base)).toMatchObject({
        status: "failed",
        failureCode: "checkpoint-invalid",
      });
    }
    expect(calls).toBe(0);
    await o.execute({
      ...base,
      attemptId: "manual",
      mode: "backfill",
      cursor: "caller",
    });
    expect(await repo.checkpoint(key)).toContain("2026-06-01");
  });
  it("handles invalid runtime commands and failed run persistence without throwing", async () => {
    const repo = new MemoryResultRepository();
    repo.saveRun = () => Promise.reject(new Error("down"));
    const o = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([]),
      { resolveExactCanonicalBinding: () => Promise.resolve(null) },
      repo,
      { resolve: () => Promise.resolve(null) },
    );
    expect(await o.execute(null)).toMatchObject({
      status: "failed",
      attemptId: "invalid-result-command",
    });
  });
  it("fails closed on a stalled cursor", async () => {
    const adapter = {
      descriptor,
      sportKey: sport,
      leagueKey: "mlb",
      listCompletedResults: () =>
        Promise.resolve({
          results: [],
          retrievedAt: at("2026-08-03T23:00:00.000Z"),
          providerRequests: 1,
          quotaUsed: 0,
          nextCursor: "same",
        }),
    };
    const orchestrator = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(null) },
      new MemoryResultRepository(),
      { resolve: () => Promise.resolve(null) },
    );
    const run = await orchestrator.execute({
      attemptId: "run",
      sportKey: sport,
      leagueKey: "mlb",
      windowStart: at("2026-08-01T00:00:00.000Z"),
      windowEnd: at("2026-08-04T00:00:00.000Z"),
      pageLimit: 10,
      maxPages: 3,
    });
    expect(run).toMatchObject({
      status: "failed",
      failureCode: "cursor-stalled",
    });
  });
  it("rejects invalid sport semantics before unresolved persistence", async () => {
    const invalid = { ...raw("unmapped"), scoreScope: "overtime" as const };
    const adapter = new FixtureCompletedResultsAdapter(
      descriptor,
      sport,
      "mlb",
      [[invalid]],
    );
    const repo = new MemoryResultRepository();
    const o = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(null) },
      repo,
      { resolve: () => Promise.resolve(null) },
    );
    expect(
      await o.execute({
        attemptId: "invalid-sport",
        sportKey: sport,
        leagueKey: "mlb",
        windowStart: at("2026-08-01T00:00:00.000Z"),
        windowEnd: at("2026-08-04T00:00:00.000Z"),
        pageLimit: 10,
        maxPages: 1,
      }),
    ).toMatchObject({ status: "failed", failureCode: "result-item-invalid" });
    expect((await repo.unresolvedPage(descriptor.id, 100)).items).toHaveLength(
      0,
    );
  });
  it("validates every page item before writing any authoritative result", async () => {
    const adapter = new FixtureCompletedResultsAdapter(
      descriptor,
      sport,
      "mlb",
      [[raw("first"), { ...raw("later"), scoreScope: "overtime" as const }]],
    );
    const repo = new MemoryResultRepository();
    const o = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(event) },
      repo,
      {
        resolve: ({ providerParticipantIds }) =>
          Promise.resolve(
            providerParticipantIds.map((id) => ({
              providerParticipantId: id,
              canonicalParticipantId: id as never,
            })),
          ),
      },
    );
    const run = await o.execute({
      attemptId: "atomic-page",
      sportKey: sport,
      leagueKey: "mlb",
      windowStart: at("2026-08-01T00:00:00.000Z"),
      windowEnd: at("2026-08-04T00:00:00.000Z"),
      pageLimit: 10,
      maxPages: 1,
    });
    expect(run).toMatchObject({
      status: "failed",
      failureCode: "result-item-invalid",
    });
    expect(await repo.current("event-1")).toBeNull();
  });
  it("rejects a later future-revision item with zero page writes", async () => {
    const later = raw("later");
    const adapter = new FixtureCompletedResultsAdapter(
      descriptor,
      sport,
      "mlb",
      [
        [
          raw("first"),
          {
            ...later,
            revision: {
              ...later.revision,
              updatedAt: at("2026-08-03T23:59:00.000Z"),
            },
          },
        ],
      ],
    );
    const repo = new MemoryResultRepository();
    const o = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(event) },
      repo,
      { resolve: () => Promise.resolve(null) },
    );
    expect(
      await o.execute({
        attemptId: "future-revision",
        sportKey: sport,
        leagueKey: "mlb",
        windowStart: at("2026-08-01T00:00:00.000Z"),
        windowEnd: at("2026-08-04T00:00:00.000Z"),
        pageLimit: 10,
        maxPages: 1,
      }),
    ).toMatchObject({ status: "failed", failureCode: "invalid-result" });
    expect(await repo.current("event-1")).toBeNull();
  });
  it("fails safely before persisting overflowing cumulative counters", async () => {
    let page = 0;
    const adapter = {
      descriptor,
      sportKey: sport,
      leagueKey: "mlb",
      listCompletedResults: () =>
        Promise.resolve({
          results: [],
          retrievedAt: at("2026-08-01T00:00:00.000Z"),
          providerRequests: Number.MAX_SAFE_INTEGER,
          quotaUsed: 0,
          ...(page++ === 0 ? { nextCursor: "next" } : {}),
        }),
    };
    const repo = new MemoryResultRepository();
    const o = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(null) },
      repo,
      { resolve: () => Promise.resolve(null) },
    );
    expect(
      await o.execute({
        attemptId: "overflow",
        sportKey: sport,
        leagueKey: "mlb",
        windowStart: at("2026-08-01T00:00:00.000Z"),
        windowEnd: at("2026-08-04T00:00:00.000Z"),
        pageLimit: 10,
        maxPages: 2,
      }),
    ).toMatchObject({
      status: "failed",
      failureCode: "result-counter-overflow",
    });
  });
  it("persists a continuation and resumes it on the next invocation", async () => {
    const adapter = new FixtureCompletedResultsAdapter(
      descriptor,
      sport,
      "mlb",
      [[], []],
    );
    const repo = new MemoryResultRepository();
    const orchestrator = new CompletedResultOrchestrator(
      new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        defaultFeedCoveragePolicies,
        [descriptor],
      ),
      new CompletedResultsAdapterRegistry([adapter]),
      { resolveExactCanonicalBinding: () => Promise.resolve(event) },
      repo,
      {
        resolve: () =>
          Promise.resolve([
            {
              providerParticipantId: "away",
              canonicalParticipantId: "away" as never,
            },
            {
              providerParticipantId: "home",
              canonicalParticipantId: "home" as never,
            },
          ]),
      },
    );
    const command = {
      attemptId: "continued",
      sportKey: sport,
      leagueKey: "mlb",
      windowStart: at("2026-08-01T00:00:00.000Z"),
      windowEnd: at("2026-08-04T00:00:00.000Z"),
      pageLimit: 10,
      maxPages: 1,
      mode: "scheduled" as const,
    };
    expect((await orchestrator.execute(command)).nextCursor).toBe("1");
    expect(
      (
        await orchestrator.execute({
          ...command,
          attemptId: "resumed",
          windowStart: at("2026-08-01T01:00:00.000Z"),
          windowEnd: at("2026-08-04T01:00:00.000Z"),
        })
      ).nextCursor,
    ).toBeUndefined();
    expect(repo.runs.map((run) => run.status)).toEqual([
      "continuation",
      "succeeded",
    ]);
  });
});
