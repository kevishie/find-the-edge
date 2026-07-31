import {
  checkpointKey,
  MemoryEventIngestionStore,
  stableDigest,
} from "@find-the-edge/database";
import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import {
  defaultFeedCoverageRegistry,
  FixtureMlbScheduleAdapter,
  normalizedUpcomingEventIdentity,
  ScheduleAdapterRegistry,
} from "@find-the-edge/providers";
import { describe, expect, it } from "vitest";
import { UpcomingEventIngestionOrchestrator } from "./upcoming-event-orchestrator";
const command = {
  attemptId: "one",
  checkpointScope: "august",
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  windowStart: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
  windowEnd: "2026-08-03T00:00:00.000Z" as IsoTimestamp,
  pageLimit: 1,
  maxPages: 1,
};
describe("orchestrator", () => {
  it("accounts bootstrap and exposes bounded continuation", async () => {
    const adapter = new FixtureMlbScheduleAdapter(),
      store = new MemoryEventIngestionStore();
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => new Date("2026-07-30T00:00:00.000Z"),
    );
    await expect(worker.execute(command)).resolves.toMatchObject({
      status: "delivery-required",
    });
    const run = [...store.runs.values()][0]!;
    expect(run.status).toBe("delivery-required");
    expect(run.counters.providerRequests).toBe(2);
    expect(run.counters.bootstrapped).toBe(1);
    expect(run.finalPosition?.state).toBe("cursor");
    expect(store.continuations.size).toBe(1);
    const pendingCommand = [...store.continuations.values()][0]!.command;
    const resumed = await new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => new Date("2026-07-30T00:03:00.000Z"),
      { publish: async () => Promise.resolve() },
    ).execute(pendingCommand);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.counters.bootstrapped).toBe(1);
    expect(store.events.size).toBe(2);
  });

  it("queues a fresh idempotent continuation before the receive budget boundary", async () => {
    class EndlessAdapter extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(request: { cursor?: string }) {
        await Promise.resolve();
        const position = Number(request.cursor?.split(":")[1] ?? 0);
        return {
          events: [],
          nextCursor: `offset:${position + 1}`,
          providerRequests: 1,
          quotaUsed: 1,
        };
      }
    }
    const store = new MemoryEventIngestionStore();
    const published: unknown[] = [];
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new EndlessAdapter()]),
      store,
      () => new Date("2026-07-30T00:00:00.000Z"),
      {
        publish: async (next) => {
          await Promise.resolve();
          published.push(next);
        },
      },
    );
    await expect(worker.execute(command)).resolves.toMatchObject({
      status: "continuation-queued",
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ maxPages: 1 });
    expect([...store.checkpoints.values()][0]?.continuationCount).toBe(1);
  });

  it("rolls the safe-integer epoch without reusing continuation identity", async () => {
    class EndlessAdapter extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(request: { cursor?: string }) {
        await Promise.resolve();
        const position = Number(request.cursor?.split(":")[1] ?? 0);
        return {
          events: [],
          nextCursor: `offset:${position + 1}`,
          providerRequests: 1,
          quotaUsed: 1,
        };
      }
    }
    const adapter = new EndlessAdapter();
    const store = new MemoryEventIngestionStore();
    const key = checkpointKey({
      providerId: adapter.descriptor.id,
      ...command,
    });
    const priorRunId = "a".repeat(64);
    store.checkpoints.set(key, {
      key,
      providerId: adapter.descriptor.id,
      sportKey: command.sportKey,
      leagueKey: command.leagueKey,
      checkpointScope: command.checkpointScope,
      windowStart: command.windowStart,
      windowEnd: command.windowEnd,
      position: { state: "cursor", cursor: "offset:1" },
      continuationCycle: 7,
      continuationCount: Number.MAX_SAFE_INTEGER,
      bootstrapRequestCount: 0,
      lastRunId: priorRunId,
      updatedAt: "2026-07-30T00:00:00.000Z" as IsoTimestamp,
    });
    const attemptId = stableDigest(
      JSON.stringify([priorRunId, key, 7, Number.MAX_SAFE_INTEGER, "offset:1"]),
    );
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => new Date("2026-07-30T00:01:00.000Z"),
    );
    await expect(
      worker.execute({
        ...command,
        attemptId,
        expectedContinuation: {
          cycle: 7,
          epoch: Number.MAX_SAFE_INTEGER,
          position: { state: "cursor", cursor: "offset:1" },
        },
      }),
    ).resolves.toMatchObject({ status: "delivery-required" });
    expect(store.checkpoints.get(key)?.continuationCount).toBe(1);
    expect(store.checkpoints.get(key)?.continuationCycle).toBe(8);
    const rolled = [...store.continuations.values()][0]!;
    expect(rolled.command.attemptId).not.toBe(attemptId);
    expect(rolled.command.expectedContinuation?.epoch).toBe(1);
    expect(rolled.command.expectedContinuation?.cycle).toBe(8);
    await expect(
      worker.execute({
        ...command,
        attemptId,
        expectedContinuation: {
          cycle: 7,
          epoch: Number.MAX_SAFE_INTEGER,
          position: { state: "cursor", cursor: "offset:1" },
        },
      }),
    ).resolves.toMatchObject({ status: "no-op" });
    await expect(
      worker.drainPendingContinuation(key, " invalid "),
    ).rejects.toMatchObject({ code: "invalid-command" });
  });

  it("continues beyond the former hard boundary without DLQ churn", async () => {
    class EndlessAdapter extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(request: { cursor?: string }) {
        await Promise.resolve();
        const position = Number(request.cursor?.split(":")[1] ?? 0);
        return {
          events: [],
          nextCursor: `offset:${position + 1}`,
          providerRequests: 1,
          quotaUsed: 1,
        };
      }
    }
    const adapter = new EndlessAdapter();
    const store = new MemoryEventIngestionStore();
    const key = checkpointKey({
      providerId: adapter.descriptor.id,
      ...command,
    });
    store.checkpoints.set(key, {
      key,
      providerId: adapter.descriptor.id,
      sportKey: command.sportKey,
      leagueKey: command.leagueKey,
      checkpointScope: command.checkpointScope,
      windowStart: command.windowStart,
      windowEnd: command.windowEnd,
      position: { state: "cursor", cursor: "offset:1" },
      continuationCycle: 0,
      continuationCount: 20,
      bootstrapRequestCount: 1,
      lastRunId: "a".repeat(64),
      updatedAt: "2026-07-30T00:00:00.000Z" as IsoTimestamp,
    });
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      undefined,
      { publish: async () => Promise.resolve() },
    );
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "invalid-command",
    });
  });

  it("no-ops a late continuation from an older checkpoint epoch", async () => {
    const adapter = new FixtureMlbScheduleAdapter();
    const store = new MemoryEventIngestionStore();
    const key = checkpointKey({
      providerId: adapter.descriptor.id,
      ...command,
    });
    store.checkpoints.set(key, {
      key,
      providerId: adapter.descriptor.id,
      sportKey: command.sportKey,
      leagueKey: command.leagueKey,
      checkpointScope: command.checkpointScope,
      windowStart: command.windowStart,
      windowEnd: command.windowEnd,
      position: { state: "cursor", cursor: "offset:2" },
      continuationCycle: 0,
      continuationCount: 2,
      bootstrapRequestCount: 0,
      lastRunId: "a".repeat(64),
      updatedAt: "2026-07-30T00:00:00.000Z" as IsoTimestamp,
    });
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
    );
    await expect(
      worker.execute({
        ...command,
        expectedContinuation: {
          cycle: 0,
          epoch: 1,
          position: { state: "cursor", cursor: "offset:1" },
        },
      }),
    ).resolves.toMatchObject({ status: "no-op" });
    await expect(
      worker.execute({
        ...command,
        expectedContinuation: {
          cycle: 0,
          epoch: 1,
          position: { state: "cursor", cursor: "offset:1" },
        },
      }),
    ).resolves.toMatchObject({ status: "no-op" });
    expect([...store.runs.values()]).toHaveLength(1);
    expect([...store.runs.values()][0]?.status).toBe("no-op");
    expect(store.checkpoints.get(key)?.position).toEqual({
      state: "cursor",
      cursor: "offset:2",
    });
  });

  it("replays a transactional continuation outbox after a publish crash", async () => {
    const adapter = new FixtureMlbScheduleAdapter();
    const store = new MemoryEventIngestionStore();
    let publishes = 0;
    let now = new Date("2026-07-30T00:00:00.000Z");
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => now,
      {
        publish: async () => {
          await Promise.resolve();
          publishes += 1;
          if (publishes === 1) throw new Error("crash");
        },
      },
    );
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "continuation-delivery-failed",
    });
    expect([...store.continuations.values()][0]?.deliveredAt).toBeUndefined();
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "invalid-command",
    });
    expect(publishes).toBe(1);
    now = new Date("2026-07-30T00:02:01.000Z");
    const pendingCommand = [...store.continuations.values()][0]!.command;
    await expect(worker.execute(pendingCommand)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(
      [...store.deliveredContinuations.values()][0]?.deliveredAt,
    ).toBeDefined();
    expect(store.continuations.size).toBe(0);
    expect(publishes).toBe(2);
  });

  it("rejects provider revisions too far in the future", async () => {
    class FutureAdapter extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(
        request: Parameters<FixtureMlbScheduleAdapter["listUpcomingEvents"]>[0],
      ) {
        const page = await super.listUpcomingEvents(request);
        return {
          ...page,
          events: page.events.map((event) => ({
            ...event,
            revision: {
              ...event.revision,
              updatedAt: "2030-01-01T00:00:00.000Z" as IsoTimestamp,
            },
          })),
        };
      }
    }
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new FutureAdapter()]),
      new MemoryEventIngestionStore(),
      () => new Date("2026-07-30T00:00:00.000Z"),
    );
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "invalid-provider-output",
    });
  });

  it("rejects duplicate bootstrap records across bootstrap pages", async () => {
    class DuplicateBootstrapAdapter extends FixtureMlbScheduleAdapter {
      override async listCanonicalBootstrap(
        request: Parameters<
          FixtureMlbScheduleAdapter["listCanonicalBootstrap"]
        >[0],
      ) {
        const first = await super.listCanonicalBootstrap({
          sportKey: request.sportKey,
          leagueKey: request.leagueKey,
          windowStart: request.windowStart,
          windowEnd: request.windowEnd,
          limit: request.limit,
          identities: request.identities,
          providerId: request.providerId,
          authorityRank: request.authorityRank,
        });
        return request.cursor
          ? first
          : { ...first, nextCursor: "offset:duplicate" };
      }
    }
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new DuplicateBootstrapAdapter()]),
      new MemoryEventIngestionStore(),
      () => new Date("2026-07-30T00:00:00.000Z"),
    );
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "invalid-provider-output",
    });
  });

  it("rejects a provider event duplicated across separate continuation executions", async () => {
    class CrossContinuationDuplicateAdapter extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(
        request: Parameters<FixtureMlbScheduleAdapter["listUpcomingEvents"]>[0],
      ) {
        const first = await super.listUpcomingEvents({
          sportKey: request.sportKey,
          leagueKey: request.leagueKey,
          windowStart: request.windowStart,
          windowEnd: request.windowEnd,
          limit: request.limit,
        });
        if (!request.cursor)
          return { ...first, nextCursor: "offset:duplicate" };
        return {
          events: first.events,
          providerRequests: first.providerRequests,
          quotaUsed: first.quotaUsed,
        };
      }
    }
    const adapter = new CrossContinuationDuplicateAdapter();
    const store = new MemoryEventIngestionStore();
    const firstWorker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => new Date("2026-07-30T00:00:00.000Z"),
    );
    await expect(firstWorker.execute(command)).resolves.toMatchObject({
      status: "delivery-required",
    });
    expect(store.providerEventFences.size).toBe(1);
    const checkpointBefore = [...store.checkpoints.values()][0]!;
    await expect(
      new UpcomingEventIngestionOrchestrator(
        defaultFeedCoverageRegistry,
        new ScheduleAdapterRegistry([adapter]),
        store,
        () => new Date("2026-07-30T00:03:00.000Z"),
        { publish: async () => Promise.resolve() },
      ).execute(command),
    ).rejects.toMatchObject({ code: "invalid-command" });
    expect([...store.checkpoints.values()][0]?.position).toEqual(
      checkpointBefore.position,
    );
    expect(store.providerEventFences.size).toBe(1);
  });

  it("rejects non-canonical and extra command fields", async () => {
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new FixtureMlbScheduleAdapter()]),
      new MemoryEventIngestionStore(),
    );
    await expect(
      worker.execute({ ...command, leagueKey: "MLB" }),
    ).rejects.toMatchObject({ code: "invalid-command" });
    await expect(
      worker.execute({ ...command, unexpected: true }),
    ).rejects.toMatchObject({ code: "invalid-command" });
  });

  it("uses the full page budget before publishing and replays as a no-op", async () => {
    const adapter = new FixtureMlbScheduleAdapter();
    const store = new MemoryEventIngestionStore();
    const published: unknown[] = [];
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => new Date("2026-07-30T00:00:00.000Z"),
      {
        publish: async (next) => {
          await Promise.resolve();
          published.push(next);
        },
      },
    );
    const first = await worker.execute({ ...command, maxPages: 2 });
    expect(first.status).toBe("succeeded");
    expect(first.finalPosition).toEqual({ state: "terminal" });
    // Each locally consumed continuation has its own audit/run counters.
    expect(first.counters.pages).toBe(1);
    expect(published).toEqual([]);
    const replay = await worker.execute({
      ...command,
      attemptId: "replay",
      maxPages: 2,
    });
    expect(replay.status).toBe("no-op");
    expect(replay.counters.providerRequests).toBe(0);
  });

  it("detects a cursor cycle across separate continuation executions", async () => {
    class CyclingAdapter extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(request: { cursor?: string }) {
        await Promise.resolve();
        return {
          events: [],
          nextCursor:
            request.cursor === undefined
              ? "cycle-a"
              : request.cursor === "cycle-a"
                ? "cycle-b"
                : "cycle-a",
          providerRequests: 1,
          quotaUsed: 0,
        };
      }
    }
    const published: unknown[] = [];
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new CyclingAdapter()]),
      new MemoryEventIngestionStore(),
      () => new Date("2026-07-30T00:00:00.000Z"),
      {
        publish: async (next) => {
          published.push(next);
          await Promise.resolve();
        },
      },
    );
    await worker.execute(command);
    await worker.execute(published[0]);
    await expect(worker.execute(published[1])).rejects.toMatchObject({
      code: "cursor-stalled",
    });
  });

  it("keeps the predecessor recoverable until the successor commit succeeds", async () => {
    class FailingSuccessorStore extends MemoryEventIngestionStore {
      commits = 0;
      override async commitCheckpoint(
        ...args: Parameters<MemoryEventIngestionStore["commitCheckpoint"]>
      ) {
        this.commits += 1;
        if (this.commits === 2) return false;
        return super.commitCheckpoint(...args);
      }
    }
    const store = new FailingSuccessorStore();
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new FixtureMlbScheduleAdapter()]),
      store,
      () => new Date("2026-07-30T00:00:00.000Z"),
      { publish: async () => Promise.resolve() },
    );
    await expect(
      worker.execute({ ...command, maxPages: 2 }),
    ).rejects.toMatchObject({ code: "checkpoint-conflict" });
    expect([...store.continuations.values()]).toHaveLength(1);
    expect([...store.continuations.values()][0]?.state).toBe("claimed");
    expect(store.deliveredContinuations.size).toBe(0);
  });

  it("durably accounts each bounded bootstrap retry after a transient failure", async () => {
    class BootstrapFailure extends FixtureMlbScheduleAdapter {
      bootstrapCalls = 0;
      override async listCanonicalBootstrap(): Promise<never> {
        this.bootstrapCalls += 1;
        await Promise.resolve();
        throw new Error("transport");
      }
    }
    const adapter = new BootstrapFailure();
    const store = new MemoryEventIngestionStore();
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
      () => new Date("2026-07-30T00:00:00.000Z"),
    );
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "provider-failed",
    });
    await expect(
      store.getCheckpoint([...store.checkpoints.keys()][0]!),
    ).resolves.toBeTruthy();
    await expect(worker.execute(command)).rejects.toMatchObject({
      code: "provider-failed",
    });
    expect(adapter.bootstrapCalls).toBe(2);
    const checkpoint = [...store.checkpoints.values()][0];
    expect(checkpoint?.bootstrapRequestCount).toBe(2);
    expect(checkpoint?.bootstrapQuotaUsed).toBe(2);
    expect(checkpoint?.bootstrapReservation?.status).toBe("failed");
  });

  it("classifies provider, output, checkpoint, and cursor failures", async () => {
    class ProviderFailure extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents(): Promise<never> {
        await Promise.resolve();
        throw new Error("secret");
      }
    }
    class InvalidOutput extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents() {
        await Promise.resolve();
        return {} as never;
      }
    }
    class StalledCursor extends FixtureMlbScheduleAdapter {
      override async listUpcomingEvents() {
        await Promise.resolve();
        return {
          events: [],
          nextCursor: "",
          providerRequests: 1,
          quotaUsed: 0,
        };
      }
    }
    for (const [adapter, code] of [
      [new ProviderFailure(), "provider-failed"],
      [new InvalidOutput(), "invalid-provider-output"],
      [new StalledCursor(), "cursor-stalled"],
    ] as const) {
      const store = new MemoryEventIngestionStore();
      const worker = new UpcomingEventIngestionOrchestrator(
        defaultFeedCoverageRegistry,
        new ScheduleAdapterRegistry([adapter]),
        store,
      );
      await expect(worker.execute(command)).rejects.toMatchObject({ code });
      expect([...store.runs.values()][0]?.status).toBe("failed");
    }
    const conflictStore = new MemoryEventIngestionStore();
    conflictStore.compareAndSetCheckpoint = async () => {
      await Promise.resolve();
      return false;
    };
    const conflictWorker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new FixtureMlbScheduleAdapter()]),
      conflictStore,
    );
    await expect(conflictWorker.execute(command)).rejects.toMatchObject({
      code: "checkpoint-conflict",
    });
  });

  it("requires the success run record with claimed canonical identity", async () => {
    const adapter = new FixtureMlbScheduleAdapter();
    const store = new MemoryEventIngestionStore();
    const schedule = await adapter.listUpcomingEvents({
      sportKey: command.sportKey,
      leagueKey: command.leagueKey,
      windowStart: command.windowStart,
      windowEnd: command.windowEnd,
      limit: 1,
    });
    const bootstrap = await adapter.listCanonicalBootstrap({
      sportKey: command.sportKey,
      leagueKey: command.leagueKey,
      windowStart: command.windowStart,
      windowEnd: command.windowEnd,
      limit: 100,
      identities: schedule.events.map(normalizedUpcomingEventIdentity),
      providerId: adapter.descriptor.id,
      authorityRank: adapter.authorityRank,
    });
    await store.bootstrapCanonicalEvent(
      bootstrap.events[0]!,
      command.windowStart,
    );
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      store,
    );
    await worker.execute({ ...command, maxPages: 2 });
    expect(store.unresolved.size).toBe(0);

    const auditStore = new MemoryEventIngestionStore();
    auditStore.putRun = async () => {
      await Promise.resolve();
      throw new Error("audit unavailable");
    };
    const auditWorker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([adapter]),
      auditStore,
      undefined,
      { publish: async () => Promise.resolve() },
    );
    await expect(
      auditWorker.execute({ ...command, maxPages: 2 }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(auditStore.runs.size).toBe(2);
    expect([...auditStore.checkpoints.values()][0]?.lastRunId).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("records setup and persistence failures durably", async () => {
    const setupStore = new MemoryEventIngestionStore();
    const worker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new FixtureMlbScheduleAdapter()]),
      setupStore,
    );
    await expect(
      worker.execute({
        ...command,
        sportKey: "unknown" as SportKey,
      }),
    ).rejects.toMatchObject({ code: "coverage-unavailable" });
    expect([...setupStore.runs.values()][0]?.failureCode).toBe(
      "coverage-unavailable",
    );

    const persistenceStore = new MemoryEventIngestionStore();
    persistenceStore.getCheckpoint = async () => {
      await Promise.resolve();
      throw new Error("database unavailable");
    };
    const persistenceWorker = new UpcomingEventIngestionOrchestrator(
      defaultFeedCoverageRegistry,
      new ScheduleAdapterRegistry([new FixtureMlbScheduleAdapter()]),
      persistenceStore,
    );
    await expect(persistenceWorker.execute(command)).rejects.toMatchObject({
      code: "persistence-failed",
    });
    expect([...persistenceStore.runs.values()][0]?.failureCode).toBe(
      "persistence-failed",
    );
  });
});
