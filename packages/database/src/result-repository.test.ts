import { describe, expect, it } from "vitest";
import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import {
  compareResultAuthority,
  MemoryResultRepository,
} from "./result-repository";
const at = (value: string) => value as IsoTimestamp;
const result = (
  sequence: number,
  score = 4,
  providerTimestamp = `2026-08-03T2${sequence}:00:00.000Z`,
) => ({
  providerId: "fixture-development",
  providerEventId: "mlb-1",
  canonicalEventId: "event-1" as never,
  canonicalEventVersion: 2,
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  state: "final" as const,
  scoreScope: "regulation" as const,
  scores: [
    { participantId: "away" as never, score: 2 },
    { participantId: "home" as never, score },
  ],
  providerRevision: {
    providerId: "fixture-development",
    authorityRank: 10,
    updatedAt: at(providerTimestamp),
    sequence,
    token: `r${sequence}`,
  },
  providerTimestamp: at(providerTimestamp),
  retrievedAt: at("2026-08-03T23:00:00.000Z"),
  sourceProvenance: "fixture-development:results",
});
describe("result repository", () => {
  it("keeps exact replays idempotent and appends corrections", async () => {
    const repo = new MemoryResultRepository();
    expect((await repo.persist(result(1))).current).toBe("finalized");
    expect((await repo.persist(result(1))).history).toBe("duplicate");
    expect(
      (
        await repo.persist({
          ...result(1),
          retrievedAt: at("2026-08-03T23:30:00.000Z"),
        })
      ).history,
    ).toBe("duplicate");
    expect((await repo.persist(result(2, 5))).current).toBe("corrected");
    const history = (await repo.historyPage("event-1", 100)).items;
    expect(history).toHaveLength(2);
    expect(history[0]?.retrievedAt).toBe("2026-08-03T23:00:00.000Z");
    expect((await repo.current("event-1"))?.scores?.[1]?.score).toBe(5);
  });
  it("retains older evidence without regressing current", async () => {
    const repo = new MemoryResultRepository();
    await repo.persist(result(2, 5));
    expect((await repo.persist(result(1, 4))).current).toBe("stale");
    expect((await repo.historyPage("event-1", 100)).items).toHaveLength(2);
  });
  it("fails closed on conflicting content at the same provider authority", async () => {
    const repo = new MemoryResultRepository();
    await repo.persist(result(1, 4));
    await expect(repo.persist(result(1, 9))).rejects.toThrow(
      "result-authority-conflict",
    );
    expect((await repo.current("event-1"))?.scores?.[1]?.score).toBe(4);
    expect((await repo.historyPage("event-1", 100)).items).toHaveLength(1);
  });
  it("deduplicates a canonical schedule version bump and preserves first-seen version", async () => {
    const repo = new MemoryResultRepository();
    await repo.persist(result(1));
    const replay = await repo.persist({
      ...result(1),
      canonicalEventVersion: 99,
    });
    expect(replay).toMatchObject({
      history: "duplicate",
      current: "stale",
      observation: { canonicalEventVersion: 2 },
    });
    expect((await repo.historyPage("event-1", 100)).items).toHaveLength(1);
  });
  it("canonicalizes nested object key order for deterministic replay identity", async () => {
    const repo = new MemoryResultRepository();
    const first = {
      ...result(1),
      detail: {
        schemaId: "mlb.result.test",
        schemaVersion: "1",
        value: { a: 1, b: { c: 2, d: 3 } },
      },
    };
    const second = {
      ...first,
      detail: {
        schemaVersion: "1",
        value: { b: { d: 3, c: 2 }, a: 1 },
        schemaId: "mlb.result.test",
      },
      providerRevision: {
        token: first.providerRevision.token,
        sequence: first.providerRevision.sequence,
        updatedAt: first.providerRevision.updatedAt,
        authorityRank: first.providerRevision.authorityRank,
        providerId: first.providerRevision.providerId,
      },
    };
    const inserted = await repo.persist(first);
    const replay = await repo.persist(second);
    expect(replay).toMatchObject({
      history: "duplicate",
      observation: { id: inserted.observation.id },
    });
    expect((await repo.historyPage("event-1", 100)).items).toHaveLength(1);
  });
  it("makes unresolved observations queryable", async () => {
    const repo = new MemoryResultRepository();
    const unresolved = {
      providerId: "fixture-development",
      providerEventId: "missing",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      state: "cancelled",
      scoreScope: "unknown",
      detail: {
        schemaId: "mlb.result.test",
        schemaVersion: "1",
        value: { note: "full" },
      },
      providerRevision: {
        providerId: "fixture-development",
        authorityRank: 1,
        updatedAt: at("2026-08-03T20:00:00.000Z"),
        sequence: 1,
        token: "x",
      },
      providerTimestamp: at("2026-08-03T20:00:00.000Z"),
      retrievedAt: at("2026-08-03T20:01:00.000Z"),
      sourceProvenance: "fixture-development:results",
      reason: "event-unmapped",
    } as const;
    const firstSeen = await repo.persistUnresolved(unresolved);
    const replayed = await repo.persistUnresolved({
      ...firstSeen,
      retrievedAt: at("2026-08-03T20:02:00.000Z"),
    });
    expect(replayed.id).toBe(firstSeen.id);
    await expect(
      repo.persistUnresolved({ ...unresolved, unexpected: true } as never),
    ).rejects.toThrow("unresolved-result-fields-invalid");
    expect(
      (await repo.unresolvedPage("fixture-development", 100)).items,
    ).toMatchObject([
      {
        scoreScope: "unknown",
        retrievedAt: "2026-08-03T20:01:00.000Z",
        detail: { value: { note: "full" } },
      },
    ]);
  });
  it("uses last-sort-key pagination across concurrent earlier inserts", async () => {
    const repo = new MemoryResultRepository();
    await repo.persist(result(1));
    await repo.persist(result(3, 6));
    const first = await repo.historyPage("event-1", 1);
    await repo.persist(result(0, 3));
    const second = await repo.historyPage("event-1", 1, first.nextCursor);
    expect(first.items[0]?.providerRevision.sequence).toBe(1);
    expect(second.items[0]?.providerRevision.sequence).toBe(3);
  });
  it("validates repository inputs and opaque pagination", async () => {
    const repo = new MemoryResultRepository();
    await expect(
      repo.persist({
        ...result(1),
        scores: [{ participantId: "a" as never, score: -1 }],
      }),
    ).rejects.toThrow("result-score-state-contradiction");
    await expect(
      repo.persist({
        ...result(1),
        providerRevision: { ...result(1).providerRevision, authorityRank: -1 },
      }),
    ).rejects.toThrow("result-revision-invalid");
    await expect(
      repo.persist({ ...result(1), unexpected: true } as never),
    ).rejects.toThrow("result-observation-fields-invalid");
    await expect(
      repo.persist({
        ...result(1),
        scores: [
          { participantId: "a" as never, score: 1, unexpected: true },
          { participantId: "b" as never, score: 2 },
        ],
      } as never),
    ).rejects.toThrow("result-score-state-contradiction");
    await expect(
      repo.persist({
        ...result(1),
        providerRevision: { ...result(1).providerRevision, token: "é" },
      }),
    ).rejects.toThrow("result-revision-invalid");
    await expect(
      repo.persist({
        ...result(1),
        providerRevision: { ...result(1).providerRevision, unexpected: true },
      } as never),
    ).rejects.toThrow("result-revision-invalid");
    await expect(
      repo.persist({
        ...result(1),
        providerTimestamp: at("2026-08-04T00:00:00.000Z"),
      }),
    ).rejects.toThrow("result-timestamp-invalid");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    for (const value of [undefined, circular])
      await expect(
        repo.persist({
          ...result(1),
          detail: { schemaId: "mlb.result.test", schemaVersion: "1", value },
        }),
      ).rejects.toThrow("result-score-state-contradiction");
    await expect(
      repo.persist({
        ...result(1),
        state: "cancelled",
        scoreScope: "regulation",
        scores: undefined,
      } as never),
    ).rejects.toThrow("result-score-state-contradiction");
    await expect(repo.historyPage("event-1", 0)).rejects.toThrow(
      "result-page-limit-invalid",
    );
    await expect(
      repo.historyPage("event-1", 1, "not-a-valid-cursor"),
    ).rejects.toThrow("result-page-cursor-invalid");
  });
  it("orders authority globally across opaque pages with bytewise token comparison", async () => {
    const repo = new MemoryResultRepository();
    await repo.persist(result(2, 5));
    await repo.persist(result(1, 4));
    const first = await repo.historyPage("event-1", 1);
    const second = await repo.historyPage("event-1", 1, first.nextCursor);
    await expect(
      repo.historyPage("event-2", 1, first.nextCursor),
    ).rejects.toThrow("result-page-cursor-invalid");
    await expect(
      repo.unresolvedPage("fixture-development", 1, first.nextCursor),
    ).rejects.toThrow("result-page-cursor-invalid");
    expect([
      first.items[0]?.providerRevision.sequence,
      second.items[0]?.providerRevision.sequence,
    ]).toEqual([1, 2]);
    expect(
      compareResultAuthority(result(1) as never, {
        ...result(1),
        providerRevision: { ...result(1).providerRevision, token: "z" },
        id: "x",
      }),
    ).toBeLessThan(0);
  });
});
