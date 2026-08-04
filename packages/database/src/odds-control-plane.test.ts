import { describe, expect, it } from "vitest";
/* eslint-disable @typescript-eslint/require-await -- fake AWS client implements the SDK's async send contract */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoOddsControlPlaneStore,
  MemoryOddsControlPlaneStore,
  type OddsControlPlaneStore,
} from "./odds-control-plane";
class FakeDocumentClient {
  readonly rows = new Map<string, Record<string, unknown>>();
  async send(command: { input: Record<string, unknown> }) {
    const input = command.input;
    const key = input["Key"] as { pk: string; sk: string } | undefined;
    const item = input["Item"] as
      { pk: string; sk: string; value: unknown } | undefined;
    const id = (v: { pk: string; sk: string }) => `${v.pk}|${v.sk}`;
    if (command.constructor.name === "DeleteCommand" && key) {
      const row = this.rows.get(id(key));
      if (
        input["ConditionExpression"] &&
        (row?.["value"] as Record<string, unknown> | undefined)?.["runId"] !==
          (input["ExpressionAttributeValues"] as Record<string, unknown>)[
            ":run"
          ]
      ) {
        const error = new Error("conditional");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.rows.delete(id(key));
      return {};
    }
    if (item) {
      const k = id(item);
      const existing = this.rows.get(k);
      const expected = (
        input["ExpressionAttributeValues"] as
          Record<string, unknown> | undefined
      )?.[":expected"];
      if (
        input["ConditionExpression"] &&
        existing &&
        (expected === undefined ||
          (existing["value"] as Record<string, unknown>)["version"] !==
            expected)
      ) {
        const error = new Error("conditional");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.rows.set(k, structuredClone(item));
      return {};
    }
    if (key && input["UpdateExpression"]) {
      const row = this.rows.get(id(key));
      if (!row) {
        const error = new Error("conditional");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      const value = row["value"] as Record<string, unknown>;
      value["committedAt"] = (
        input["ExpressionAttributeValues"] as Record<string, string>
      )[":a"];
      return {};
    }
    if (key) return { Item: structuredClone(this.rows.get(id(key))) };
    throw new Error("unsupported");
  }
}
const stores = (): readonly OddsControlPlaneStore[] => {
  const client = new FakeDocumentClient();
  return [
    new MemoryOddsControlPlaneStore(),
    new DynamoOddsControlPlaneStore(
      client as unknown as DynamoDBDocumentClient,
      "table",
    ),
  ];
};
describe("odds control plane store", () => {
  it("blocks ambiguous automatic recall until the durable request lease expires", async () => {
    const s = new MemoryOddsControlPlaneStore();
    const attempt = {
      attemptId: "r:start",
      runId: "r",
      pageToken: "start",
      requestedAt: "2026-08-03T00:00:00.000Z",
      leaseUntil: "2026-08-03T00:05:00.000Z",
      state: "reserved" as const,
    };
    expect(await s.reserveAttempt(attempt)).toBe(true);
    expect(
      await s.reserveAttempt({
        ...attempt,
        requestedAt: "2026-08-03T00:04:59.000Z",
      }),
    ).toBe(false);
    expect(
      await s.reserveAttempt({
        ...attempt,
        requestedAt: "2026-08-03T00:05:00.000Z",
        leaseUntil: "2026-08-03T00:10:00.000Z",
      }),
    ).toBe(true);
  });

  it("prevents stale checkpoint, health, run and continuation writers from regressing state", async () => {
    const s = new MemoryOddsControlPlaneStore();
    const newer = "2026-08-03T00:10:00.000Z";
    const older = "2026-08-03T00:05:00.000Z";
    await s.putCheckpoint({
      leagueKey: "mlb",
      providerId: "sharpapi",
      completedAt: newer,
      nextDueAt: newer,
      runId: "new",
    });
    await expect(
      s.putCheckpoint({
        leagueKey: "mlb",
        providerId: "sharpapi",
        completedAt: older,
        nextDueAt: older,
        runId: "old",
      }),
    ).rejects.toThrow("checkpoint-transition-conflict");
    expect((await s.getCheckpoint("mlb"))?.runId).toBe("new");
    await s.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 2,
      updatedAt: newer,
    });
    await expect(
      s.putHealth({
        providerId: "sharpapi",
        healthKey: "sharpapi:mlb:odds",
        healthy: false,
        consecutiveSuccesses: 0,
        updatedAt: older,
      }),
    ).rejects.toThrow("health-transition-conflict");
    expect((await s.getHealth("sharpapi:mlb:odds"))?.healthy).toBe(true);
    await s.putContinuation({
      leagueKey: "mlb",
      providerId: "sharpapi",
      runId: "new",
      updatedAt: newer,
      evidenceCommitted: true,
      quotaCost: 2,
    });
    await expect(
      s.putContinuation({
        leagueKey: "mlb",
        providerId: "sharpapi",
        runId: "old",
        updatedAt: older,
      }),
    ).rejects.toThrow("continuation-transition-conflict");
    expect(await s.getContinuation("mlb")).toMatchObject({
      runId: "new",
      evidenceCommitted: true,
      quotaCost: 2,
    });
    await expect(s.clearContinuation("mlb", "old")).rejects.toThrow(
      "continuation-transition-conflict",
    );
  });
  it("atomically preserves quota reserve and permits a new continuation after deletion", async () => {
    const s = new MemoryOddsControlPlaneStore();
    await s.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 2,
      quotaRemaining: 102,
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(
      await s.reserveQuota(
        "sharpapi:mlb:odds",
        100,
        2,
        "2026-08-03T00:01:00.000Z",
      ),
    ).toBe(true);
    expect(
      await s.reserveQuota(
        "sharpapi:mlb:odds",
        100,
        1,
        "2026-08-03T00:02:00.000Z",
      ),
    ).toBe(false);
    await s.putContinuation({
      leagueKey: "mlb",
      runId: "one",
      providerId: "sharpapi",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    await s.clearContinuation("mlb", "one");
    await s.putContinuation({
      leagueKey: "mlb",
      runId: "two",
      providerId: "sharpapi",
      updatedAt: "2026-08-03T00:03:00.000Z",
    });
    expect((await s.getContinuation("mlb"))?.runId).toBe("two");
  });
  it("atomically resets an authoritative request window without treating RPM as quota", async () => {
    const s = new MemoryOddsControlPlaneStore();
    await s.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 10,
        remaining: 0,
        resetsAt: "2026-08-03T00:01:00.000Z",
      },
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(
      await s.reserveQuota(
        "sharpapi:mlb:odds",
        2,
        1,
        "2026-08-03T00:00:30.000Z",
      ),
    ).toBe(false);
    expect(
      await s.reserveQuota(
        "sharpapi:mlb:odds",
        2,
        1,
        "2026-08-03T00:01:00.000Z",
      ),
    ).toBe(false);
    expect((await s.getHealth("sharpapi:mlb:odds"))?.rateWindow).toMatchObject({
      limit: 10,
    });
    expect(
      (await s.getHealth("sharpapi:mlb:odds"))?.rateWindow?.remaining,
    ).toBeUndefined();
  });
  it("reserves attempts and seals pages exactly once while gaps remain immutable", async () => {
    const s = new MemoryOddsControlPlaneStore();
    const a = {
      attemptId: "a",
      runId: "r",
      pageToken: "start",
      requestedAt: "2026-08-03T00:00:00.000Z",
    };
    expect(await s.reserveAttempt(a)).toBe(true);
    expect(await s.reserveAttempt(a)).toBe(false);
    const page = {
      runId: "r",
      pageToken: "start",
      nextPageToken: "two",
      responseDigest: "d",
      normalizedItems: [{ safe: true }],
      gaps: [],
      quotaCost: 1,
      sealedAt: a.requestedAt,
    };
    expect(await s.sealPage(page)).toBe(true);
    expect(await s.sealPage(page)).toBe(false);
    await expect(s.sealPage({ ...page, responseDigest: "x" })).rejects.toThrow(
      "sealed-page-conflict",
    );
    await s.commitPage("r", "start", a.requestedAt);
    expect((await s.getPage("r", "start"))?.committedAt).toBe(a.requestedAt);
    const gap = {
      gapId: "g",
      runId: "r",
      leagueKey: "mlb",
      providerId: "sharpapi",
      policyVersion: "v",
      bookRole: "offered" as const,
      sourceState: "missing" as const,
      reason: "missing" as const,
      observedAt: a.requestedAt,
    };
    expect(await s.putGap(gap)).toBe(true);
    expect(await s.putGap(gap)).toBe(false);
  });
});
describe("memory/Dynamo control-plane parity", () => {
  for (const [index, s] of stores().entries())
    it(`persists run, health, checkpoint, attempts and pages (${index})`, async () => {
      const at = "2026-08-03T00:00:00.000Z";
      const run = {
        runId: "r",
        leagueKey: "mlb",
        providerId: "sharpapi",
        policyVersion: "v",
        status: "running" as const,
        startedAt: at,
        updatedAt: at,
        evidenceCommitted: false,
        quotaCost: 0,
      };
      await s.putRun(run);
      expect(await s.getRun("r")).toEqual({ ...run, version: 1 });
      await s.putHealth({
        providerId: "sharpapi",
        healthy: true,
        consecutiveSuccesses: 2,
        quotaRemaining: 200,
        updatedAt: at,
      });
      expect((await s.getHealth("sharpapi"))?.quotaRemaining).toBe(200);
      await s.putCheckpoint({
        leagueKey: "mlb",
        providerId: "sharpapi",
        completedAt: at,
        nextDueAt: at,
        runId: "r",
      });
      expect((await s.getCheckpoint("mlb"))?.runId).toBe("r");
      await s.putContinuation({
        leagueKey: "mlb",
        providerId: "sharpapi",
        runId: "r",
        updatedAt: at,
      });
      expect((await s.getContinuation("mlb"))?.runId).toBe("r");
      await s.clearContinuation("mlb");
      expect(await s.getContinuation("mlb")).toBeNull();
      expect(
        await s.reserveAttempt({
          attemptId: "a",
          runId: "r",
          pageToken: "start",
          requestedAt: at,
        }),
      ).toBe(true);
      expect(
        await s.reserveAttempt({
          attemptId: "a",
          runId: "r",
          pageToken: "start",
          requestedAt: at,
        }),
      ).toBe(false);
      const page = {
        runId: "r",
        pageToken: "start",
        responseDigest: "digest",
        normalizedItems: [],
        gaps: [],
        quotaCost: 1,
        sealedAt: at,
      };
      expect(await s.sealPage(page)).toBe(true);
      expect(await s.sealPage(page)).toBe(false);
      await s.commitPage("r", "start", at);
      await s.commitPage("r", "start", at);
      await expect(
        s.commitPage("r", "start", "2026-08-03T00:01:00.000Z"),
      ).rejects.toThrow("page-transition-conflict");
      expect((await s.getPage("r", "start"))?.committedAt).toBe(at);
    });
});

describe("atomic paid-call guards", () => {
  it("grants one bounded probe after an authoritative window expires", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 0,
      rateWindow: {
        limit: 60,
        remaining: 0,
        resetsAt: "2026-08-04T11:59:00.000Z",
      },
      updatedAt: "2026-08-04T11:58:00.000Z",
    });
    const attempt = (attemptId: string) => ({
      attemptId,
      runId: attemptId,
      pageToken: "start",
      requestedAt: "2026-08-04T12:00:00.000Z",
    });
    expect(
      await store.reserveQuotaAttempt(
        "sharpapi:mlb:odds",
        10,
        1,
        attempt("probe-1"),
      ),
    ).toBe(true);
    expect(
      await store.reserveQuotaAttempt(
        "sharpapi:mlb:odds",
        10,
        1,
        attempt("probe-2"),
      ),
    ).toBe(false);
  });

  it("targets the nested rate-window remaining field in DynamoDB", async () => {
    let updateInput: Record<string, unknown> | undefined;
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        if (command.constructor.name === "GetCommand")
          return {
            Item: {
              value: {
                providerId: "sharpapi",
                healthKey: "sharpapi:mlb:odds",
                healthy: true,
                consecutiveSuccesses: 1,
                rateWindow: { limit: 60, remaining: 41 },
                updatedAt: "2026-08-04T12:00:00.000Z",
              },
            },
          };
        updateInput = command.input;
        return {};
      },
    };
    const store = new DynamoOddsControlPlaneStore(
      client as unknown as DynamoDBDocumentClient,
      "table",
    );
    expect(
      await store.reserveQuota(
        "sharpapi:mlb:odds",
        10,
        1,
        "2026-08-04T12:00:01.000Z",
      ),
    ).toBe(true);
    expect(updateInput?.["ExpressionAttributeNames"]).toEqual(
      expect.objectContaining({ "#window": "rateWindow", "#q": "remaining" }),
    );
  });

  it("CAS-fences a Dynamo reset probe against newly authoritative remaining", async () => {
    let transaction: Record<string, unknown> | undefined;
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        if (command.constructor.name === "GetCommand")
          return {
            Item: {
              value: {
                version: 7,
                providerId: "sharpapi",
                healthKey: "sharpapi:mlb:odds",
                healthy: true,
                consecutiveSuccesses: 1,
                rateWindow: { limit: 60 },
                updatedAt: "2026-08-04T12:00:00.000Z",
              },
            },
          };
        transaction = command.input;
        const error = new Error("authoritative remaining won race");
        error.name = "TransactionCanceledException";
        throw error;
      },
    };
    const store = new DynamoOddsControlPlaneStore(
      client as unknown as DynamoDBDocumentClient,
      "table",
    );
    expect(
      await store.reserveQuotaAttempt("sharpapi:mlb:odds", 10, 1, {
        attemptId: "probe-race",
        runId: "probe-race",
        pageToken: "start",
        requestedAt: "2026-08-04T12:00:01.000Z",
      }),
    ).toBe(false);
    const update = (
      transaction?.["TransactItems"] as Array<{
        Update?: Record<string, unknown>;
      }>
    )[0]?.Update;
    expect(update?.["ConditionExpression"]).toContain(
      "attribute_not_exists(#v.#window.#remaining)",
    );
    expect(update?.["ExpressionAttributeValues"]).toEqual(
      expect.objectContaining({ ":expectedVersion": 7 }),
    );
  });

  it("reserves quota and a unique attempt together", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const at = "2026-08-03T00:00:00.000Z";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 10,
      updatedAt: at,
    });
    const attempt = {
      attemptId: "attempt-1",
      runId: "run-1",
      pageToken: "start",
      requestedAt: at,
    };
    expect(
      await store.reserveQuotaAttempt("sharpapi:mlb:odds", 5, 2, attempt),
    ).toBe(true);
    expect((await store.getHealth("sharpapi:mlb:odds"))?.quotaRemaining).toBe(
      8,
    );
    expect(
      await store.reserveQuotaAttempt("sharpapi:mlb:odds", 5, 2, attempt),
    ).toBe(false);
    expect((await store.getHealth("sharpapi:mlb:odds"))?.quotaRemaining).toBe(
      8,
    );
  });

  it("reconciles estimated cost without double charging or understating", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const at = "2026-08-03T00:00:00.000Z";
    await store.putHealth({
      providerId: "the-odds-api",
      healthKey: "fallback:quota",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 10,
      updatedAt: at,
    });
    expect(
      await store.reserveQuotaAttempt("fallback:quota", 0, 3, {
        attemptId: "quota-reconcile",
        runId: "run",
        pageToken: "start",
        requestedAt: at,
      }),
    ).toBe(true);
    await store.reconcileQuota("fallback:quota", 3, 1, undefined, at);
    expect((await store.getHealth("fallback:quota"))?.quotaRemaining).toBe(9);
    await store.reconcileQuota("fallback:quota", 0, 0, 4, at);
    expect((await store.getHealth("fallback:quota"))?.quotaRemaining).toBe(4);
  });

  it("never replaces a terminal attempt after its lease", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const at = "2026-08-03T00:00:00.000Z";
    await store.reserveAttempt({
      attemptId: "terminal",
      runId: "run-1",
      pageToken: "start",
      requestedAt: at,
      leaseUntil: "2026-08-03T00:01:00.000Z",
    });
    await store.completeAttempt({
      attemptId: "terminal",
      runId: "run-1",
      pageToken: "start",
      requestedAt: at,
      completedAt: at,
    });
    expect(
      await store.reserveAttempt({
        attemptId: "terminal",
        runId: "run-1",
        pageToken: "start",
        requestedAt: "2026-08-03T01:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("elects one continuation owner under concurrent invocations", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const at = "2026-08-03T00:00:00.000Z";
    const [first, second] = await Promise.all([
      store.claimContinuation({
        leagueKey: "mlb",
        runId: "run-a",
        providerId: "sharpapi",
        updatedAt: at,
        ownerId: "owner-a",
        leaseUntil: "2026-08-03T00:05:00.000Z",
      }),
      store.claimContinuation({
        leagueKey: "mlb",
        runId: "run-b",
        providerId: "the-odds-api",
        updatedAt: at,
        ownerId: "owner-b",
        leaseUntil: "2026-08-03T00:05:00.000Z",
      }),
    ]);
    expect(first.runId).toBe(second.runId);
    expect(["run-a", "run-b"]).toContain(first.runId);
    const takeover = await store.claimContinuation({
      ...first,
      runId: first.runId,
      updatedAt: "2026-08-03T00:06:00.000Z",
      ownerId: "owner-b",
      leaseUntil: "2026-08-03T00:11:00.000Z",
    });
    expect(takeover.ownerId).toBe("owner-b");
  });

  it("adopts a legacy ownerless continuation exactly once", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putContinuation({
      leagueKey: "mlb",
      runId: "legacy-run",
      providerId: "sharpapi",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const adopted = await store.claimContinuation({
      leagueKey: "mlb",
      runId: "legacy-run",
      providerId: "sharpapi",
      updatedAt: "2026-08-03T00:01:00.000Z",
      ownerId: "owner-a",
      leaseUntil: "2026-08-03T00:06:00.000Z",
    });
    expect(adopted.ownerId).toBe("owner-a");
    const blocked = await store.claimContinuation({
      ...adopted,
      ownerId: "owner-b",
      updatedAt: "2026-08-03T00:02:00.000Z",
    });
    expect(blocked.ownerId).toBe("owner-a");
  });

  it("rejects a stale owner clearing a continuation after takeover", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const first = await store.claimContinuation({
      leagueKey: "mlb",
      runId: "run-a",
      providerId: "sharpapi",
      updatedAt: "2026-08-03T00:00:00.000Z",
      ownerId: "owner-a",
      leaseUntil: "2026-08-03T00:01:00.000Z",
    });
    const takeover = await store.claimContinuation({
      ...first,
      ownerId: "owner-b",
      updatedAt: "2026-08-03T00:02:00.000Z",
      leaseUntil: "2026-08-03T00:07:00.000Z",
    });
    await expect(
      store.clearContinuation("mlb", "run-a", "owner-a", first.version),
    ).rejects.toThrow("continuation-transition-conflict");
    await store.clearContinuation("mlb", "run-a", "owner-b", takeover.version);
    expect(await store.getContinuation("mlb")).toBeNull();
  });

  it("preserves concurrent reservations while reconciling reported quota", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 100,
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(
      await store.reserveQuota(key, 0, 1, "2026-08-03T00:00:01.000Z"),
    ).toBe(true);
    expect(
      await store.reserveQuota(key, 0, 1, "2026-08-03T00:00:02.000Z"),
    ).toBe(true);
    await store.reconcileQuota(key, 1, 1, 99, "2026-08-03T00:00:03.000Z");
    expect((await store.getHealth(key))?.quotaRemaining).toBe(98);
    await store.reconcileQuota(key, 1, 1, 99, "2026-08-03T00:00:04.000Z");
    expect((await store.getHealth(key))?.quotaRemaining).toBe(98);
  });

  it("commits page and durable run evidence as one operation", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const at = "2026-08-03T00:00:00.000Z";
    await store.putRun({
      runId: "run-1",
      leagueKey: "mlb",
      providerId: "sharpapi",
      policyVersion: "v1",
      status: "running",
      startedAt: at,
      updatedAt: at,
      evidenceCommitted: false,
      quotaCost: 0,
    });
    await store.sealPage({
      runId: "run-1",
      pageToken: "start",
      responseDigest: "digest",
      normalizedItems: [],
      gaps: [],
      quotaCost: 1,
      sealedAt: at,
    });
    await store.commitEvidencePage("run-1", "start", at);
    expect((await store.getPage("run-1", "start"))?.committedAt).toBe(at);
    expect((await store.getRun("run-1"))?.evidenceCommitted).toBe(true);
  });
});

describe("versioned compare-and-swap parity", () => {
  for (const [index, store] of stores().entries())
    it(`accepts exact replay and rejects equal-time material conflicts (${index})`, async () => {
      const at = "2026-08-03T00:00:00.000Z";
      const run = {
        runId: `version-run-${index}`,
        leagueKey: "mlb",
        providerId: "sharpapi",
        policyVersion: "v1",
        status: "running" as const,
        startedAt: at,
        updatedAt: at,
        evidenceCommitted: false,
        quotaCost: 0,
      };
      await store.putRun(run);
      await store.putRun(run);
      const stored = await store.getRun(run.runId);
      expect(stored?.version).toBe(1);
      await expect(store.putRun({ ...run, status: "failed" })).rejects.toThrow(
        "run-transition-conflict",
      );
      await store.putRun({ ...stored!, status: "completed" });
      expect((await store.getRun(run.runId))?.version).toBe(2);

      await store.putCheckpoint({
        leagueKey: `version-league-${index}`,
        providerId: "sharpapi",
        completedAt: at,
        nextDueAt: at,
        runId: run.runId,
      });
      const checkpoint = await store.getCheckpoint(`version-league-${index}`);
      await store.putCheckpoint({ ...checkpoint!, nextDueAt: `${at}-next` });
      expect(
        (await store.getCheckpoint(`version-league-${index}`))?.version,
      ).toBe(2);

      await store.putHealth({
        providerId: "sharpapi",
        healthKey: `version-health-${index}`,
        healthy: true,
        consecutiveSuccesses: 1,
        updatedAt: at,
      });
      const health = await store.getHealth(`version-health-${index}`);
      await store.putHealth({ ...health!, consecutiveSuccesses: 2 });
      expect((await store.getHealth(`version-health-${index}`))?.version).toBe(
        2,
      );

      await store.putContinuation({
        leagueKey: `version-continuation-${index}`,
        runId: run.runId,
        providerId: "sharpapi",
        updatedAt: at,
      });
      const continuation = await store.getContinuation(
        `version-continuation-${index}`,
      );
      await store.putContinuation({ ...continuation!, quotaCost: 1 });
      expect(
        (await store.getContinuation(`version-continuation-${index}`))?.version,
      ).toBe(2);
    });
});
