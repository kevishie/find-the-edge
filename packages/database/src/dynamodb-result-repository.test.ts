import { describe, expect, it } from "vitest";
import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import { DynamoResultRepository } from "./dynamodb-result-repository";
import {
  MemoryResultRepository,
  normalizeCompletedResult,
} from "./result-repository";
const at = (v: string) => v as IsoTimestamp;
const input = () => ({
  providerId: "p",
  providerEventId: "pe",
  canonicalEventId: "event" as never,
  canonicalEventVersion: 1,
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  state: "final" as const,
  scoreScope: "regulation" as const,
  scores: [
    { participantId: "b" as never, score: 2 },
    { participantId: "a" as never, score: 1 },
  ],
  providerRevision: {
    providerId: "p",
    authorityRank: 1,
    updatedAt: at("2026-08-03T20:00:00.000Z"),
    sequence: 1,
    token: "r",
  },
  providerTimestamp: at("2026-08-03T20:00:00.000Z"),
  retrievedAt: at("2026-08-03T20:01:00.000Z"),
  sourceProvenance: "p:results",
});
class Fake {
  items = new Map<string, Record<string, unknown>>();
  failCurrent = true;
  queryPages: unknown[] = [];
  raceCurrent?: ReturnType<typeof normalizeCompletedResult>;
  queryCalls = 0;
  key(v: Record<string, unknown>) {
    return `${String(v["pk"])}|${String(v["sk"])}`;
  }
  send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) {
    const name = command.constructor.name,
      input = command.input;
    if (name === "PutCommand") {
      const item = input["Item"] as Record<string, unknown>,
        key = this.key(item);
      if (String(item["sk"]) === "CURRENT" && this.failCurrent) {
        this.failCurrent = false;
        return Promise.reject(new Error("transient"));
      }
      if (String(item["sk"]) === "CURRENT" && this.raceCurrent) {
        this.items.set(key, { ...item, value: this.raceCurrent });
        delete this.raceCurrent;
        const e = new Error("conditional");
        e.name = "ConditionalCheckFailedException";
        return Promise.reject(e);
      }
      const previous = this.items.get(key);
      if (
        input["ConditionExpression"] &&
        previous &&
        String(item["sk"]) !== "CURRENT"
      ) {
        const e = new Error("conditional");
        e.name = "ConditionalCheckFailedException";
        return Promise.reject(e);
      }
      this.items.set(key, item);
      return Promise.resolve(previous ? { Attributes: previous } : {});
    }
    if (name === "GetCommand")
      return Promise.resolve({
        Item: this.items.get(this.key(input["Key"] as Record<string, unknown>)),
      });
    if (name === "QueryCommand") {
      this.queryCalls++;
      return Promise.resolve(this.queryPages.shift() ?? { Items: [] });
    }
    if (name === "DeleteCommand") return Promise.resolve({});
    throw new Error(name);
  }
}
describe("Dynamo result repository", () => {
  it("repairs current after history succeeded and current failed", async () => {
    const fake = new Fake(),
      repo = new DynamoResultRepository(fake as never, "t");
    await expect(repo.persist(input())).rejects.toThrow("transient");
    expect((await repo.persist(input())).history).toBe("duplicate");
    expect(await repo.current("event")).not.toBeNull();
    const replay = await repo.persist({
      ...input(),
      retrievedAt: at("2026-08-03T20:02:00.000Z"),
    });
    expect(replay).toMatchObject({
      history: "duplicate",
      current: "stale",
      observation: { retrievedAt: "2026-08-03T20:01:00.000Z" },
    });
    const exact = await repo.exact("event", replay.observation.id);
    expect(exact?.id).toBe(replay.observation.id);
    expect(fake.queryCalls).toBe(0);
  });
  it("replays unresolved idempotently and detects conflicts", async () => {
    const fake = new Fake();
    fake.failCurrent = false;
    const repo = new DynamoResultRepository(fake as never, "t"),
      u = {
        providerId: "p",
        providerEventId: "missing",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        state: "cancelled" as const,
        scoreScope: "unknown" as const,
        providerRevision: {
          providerId: "p",
          authorityRank: 1,
          updatedAt: at("2026-08-03T20:00:00.000Z"),
          sequence: 1,
          token: "r",
        },
        providerTimestamp: at("2026-08-03T20:00:00.000Z"),
        retrievedAt: at("2026-08-03T20:01:00.000Z"),
        sourceProvenance: "p:results",
        reason: "event-unmapped" as const,
      };
    const persisted = await repo.persistUnresolved(u);
    await expect(repo.persistUnresolved(persisted)).resolves.toMatchObject({
      id: persisted.id,
    });
    await expect(
      repo.persistUnresolved({
        ...u,
        retrievedAt: at("2026-08-03T20:02:00.000Z"),
      }),
    ).resolves.toMatchObject({ retrievedAt: "2026-08-03T20:01:00.000Z" });
  });
  it("returns LastEvaluatedKey cursors for history and unresolved pages", async () => {
    const fake = new Fake();
    fake.failCurrent = false;
    fake.queryPages = [
      {
        Items: [],
        LastEvaluatedKey: { pk: "RESULT#event", sk: "HISTORY#next" },
      },
      {
        Items: [],
        LastEvaluatedKey: { pk: "UNRESOLVED_RESULT#p", sk: "ITEM#next" },
      },
    ];
    const repo = new DynamoResultRepository(fake as never, "t"),
      history = await repo.historyPage("event", 100),
      unresolved = await repo.unresolvedPage("p", 100);
    expect(history.nextCursor).toBeTruthy();
    expect(unresolved.nextCursor).toBeTruthy();
    await expect(
      repo.historyPage("other-event", 100, history.nextCursor),
    ).rejects.toThrow("result-page-cursor-invalid");
    await expect(
      repo.unresolvedPage("other-provider", 100, unresolved.nextCursor),
    ).rejects.toThrow("result-page-cursor-invalid");
  });
  it("classifies atomic corrections and stores globally sortable history keys", async () => {
    const fake = new Fake();
    fake.failCurrent = false;
    const repo = new DynamoResultRepository(fake as never, "t");
    expect((await repo.persist(input())).current).toBe("finalized");
    expect(
      (
        await repo.persist({
          ...input(),
          providerRevision: {
            ...input().providerRevision,
            sequence: 2,
            token: "s",
          },
        })
      ).current,
    ).toBe("corrected");
    const keys = [...fake.items.keys()].filter((key) =>
      key.includes("|HISTORY#"),
    );
    expect(keys).toEqual([...keys].sort());
  });
  it("matches memory canonical replay behavior for reordered nested objects", async () => {
    const fake = new Fake();
    fake.failCurrent = false;
    const repo = new DynamoResultRepository(fake as never, "t");
    const first = {
      ...input(),
      detail: {
        schemaId: "mlb.result.test",
        schemaVersion: "1",
        value: { a: 1, b: 2 },
      },
    };
    const inserted = await repo.persist(first);
    const replay = await repo.persist({
      ...first,
      detail: {
        value: { b: 2, a: 1 },
        schemaVersion: "1",
        schemaId: "mlb.result.test",
      },
    });
    expect(replay).toMatchObject({
      history: "duplicate",
      observation: { id: inserted.observation.id },
    });
  });
  it("rejects same-authority content conflicts before history/current advancement", async () => {
    const fake = new Fake();
    fake.failCurrent = false;
    const repo = new DynamoResultRepository(fake as never, "t");
    await repo.persist(input());
    await expect(
      repo.persist({
        ...input(),
        scores: [
          { participantId: "a" as never, score: 1 },
          { participantId: "b" as never, score: 99 },
        ],
      }),
    ).rejects.toThrow("result-authority-conflict");
    expect((await repo.current("event"))?.scores?.[1]?.score).toBe(2);
    expect(
      [...fake.items.keys()].filter((key) => key.includes("HISTORY#")),
    ).toHaveLength(1);
  });
  it("deduplicates canonical version bumps with first-seen metadata", async () => {
    const fake = new Fake();
    fake.failCurrent = false;
    const repo = new DynamoResultRepository(fake as never, "t");
    await repo.persist(input());
    await expect(
      repo.persist({ ...input(), canonicalEventVersion: 7 }),
    ).resolves.toMatchObject({
      history: "duplicate",
      current: "stale",
      observation: { canonicalEventVersion: 1 },
    });
  });
  it("converges with memory by rejecting a concurrent same-authority conflict", async () => {
    const conflicting = {
      ...input(),
      scores: [
        { participantId: "a" as never, score: 1 },
        { participantId: "b" as never, score: 99 },
      ],
    };
    const memory = new MemoryResultRepository();
    await memory.persist(conflicting);
    await expect(memory.persist(input())).rejects.toThrow(
      "result-authority-conflict",
    );

    for (const [incoming, competing, winningScore] of [
      [input(), conflicting, 99],
      [conflicting, input(), 2],
    ] as const) {
      const fake = new Fake();
      fake.failCurrent = false;
      fake.raceCurrent = normalizeCompletedResult(competing);
      const dynamo = new DynamoResultRepository(fake as never, "t");
      await expect(dynamo.persist(incoming)).rejects.toThrow(
        "result-authority-conflict",
      );
      expect((await dynamo.current("event"))?.scores?.[1]?.score).toBe(
        winningScore,
      );
    }
  });
});
