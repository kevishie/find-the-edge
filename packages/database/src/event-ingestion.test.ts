import type {
  CanonicalEventBootstrap,
  EntityId,
  IsoTimestamp,
  SportKey,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import {
  compareAuthority,
  identityKey,
  mappingId,
  stableDigest,
  validateIdentityClaim,
} from "./event-ingestion";
import { MemoryEventIngestionStore } from "./memory-event-ingestion";
const time = "2026-07-30T00:00:00.000Z" as IsoTimestamp;
const bootstrap: CanonicalEventBootstrap = {
  id: "e" as EntityId,
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  leagueId: "l" as EntityId,
  participantIds: ["a" as EntityId, "b" as EntityId],
  participantLabels: ["A", "B"],
  startsAt: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
  phase: "pregame",
  status: "scheduled",
  normalizedIdentity: "old",
  canonicalKey: "one",
  revision: {
    providerId: "bootstrap",
    authorityRank: 0,
    updatedAt: time,
    sequence: 1,
    token: "one",
  },
};
describe("memory ingestion", () => {
  it("uses fixed-size collision-resistant persistence keys", () => {
    expect(stableDigest("one")).toMatch(/^[a-f0-9]{64}$/);
    expect(stableDigest("one")).not.toBe(stableDigest("two"));
    expect(
      identityKey("mlb" as SportKey, "mlb", "x".repeat(10_000)),
    ).toHaveLength(64);
    expect(
      mappingId({
        providerId: "p".repeat(10_000),
        providerEventId: "e".repeat(10_000),
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
      }),
    ).toHaveLength(64);
  });

  it("bounds unresolved CURRENT while retaining append-only observations", async () => {
    const store = new MemoryEventIngestionStore();
    for (let index = 0; index < 25; index++)
      await store.ingestEvent({
        providerId: "provider",
        providerEventId: "missing",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        normalizedIdentity: "missing",
        startsAt: bootstrap.startsAt,
        status: "scheduled",
        revision: {
          providerId: "provider",
          authorityRank: 1,
          updatedAt: time,
          sequence: index,
          token: String(index),
        },
        observedAt:
          `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` as IsoTimestamp,
      });
    expect([...store.unresolved.values()][0]?.observations).toHaveLength(20);
    expect(store.unresolvedObservations.size).toBe(25);
  });

  it("rejects malformed durable checkpoints", async () => {
    const store = new MemoryEventIngestionStore();
    store.checkpoints.set("key", {
      key: "key",
      position: { state: "terminal" },
    } as never);
    await expect(store.getCheckpoint("key")).rejects.toThrow(
      "invalid-checkpoint",
    );
  });
  it("uses freshness and never cross-provider token chronology for authority ties", () => {
    const older = {
      providerId: "z",
      authorityRank: 10,
      updatedAt: "2026-07-29T00:00:00.000Z" as IsoTimestamp,
      sequence: 999,
      token: "zzz",
    };
    const newer = {
      providerId: "a",
      authorityRank: 10,
      updatedAt: time,
      sequence: 1,
      token: "aaa",
    };
    expect(compareAuthority(newer, older)).toBeGreaterThan(0);
    expect(compareAuthority(older, newer)).toBeLessThan(0);
  });
  it("strictly validates bounded identity overflow aggregates", () => {
    const value = {
      candidateEventIds: ["a", "b"],
      sportKey: "mlb",
      leagueKey: "mlb",
      normalizedIdentity: "identity",
      conflictCount: 3,
      overflow: true,
      version: 4,
    };
    expect(
      validateIdentityClaim(value, "mlb" as SportKey, "mlb", "identity"),
    ).toEqual(value);
    expect(() =>
      validateIdentityClaim(
        { ...value, conflictCount: 2 },
        "mlb" as SportKey,
        "mlb",
        "identity",
      ),
    ).toThrow("invalid-identity-claim");
    expect(() =>
      validateIdentityClaim(
        { ...value, unexpected: true },
        "mlb" as SportKey,
        "mlb",
        "identity",
      ),
    ).toThrow("invalid-identity-claim");
  });
  it("moves identity indexes and orders revisions per provider", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, time);
    const base = {
      providerEventId: "p1",
      sportKey: bootstrap.sportKey,
      leagueKey: "mlb",
      normalizedIdentity: "old",
      startsAt: bootstrap.startsAt,
      status: "scheduled" as const,
      observedAt: time,
    };
    await store.ingestEvent({
      ...base,
      providerId: "a",
      revision: {
        providerId: "a",
        authorityRank: 10,
        updatedAt: time,
        sequence: 1,
        token: "a",
      },
    });
    await store.ingestEvent({
      ...base,
      providerId: "b",
      providerEventId: "p2",
      revision: {
        providerId: "b",
        authorityRank: 20,
        updatedAt: "2020-01-01T00:00:00.000Z" as IsoTimestamp,
        sequence: 1,
        token: "a",
      },
    });
    await store.ingestEvent({
      ...base,
      providerId: "a",
      status: "cancelled",
      revision: {
        providerId: "a",
        authorityRank: 10,
        updatedAt: "2030-01-01T00:00:00.000Z" as IsoTimestamp,
        sequence: 2,
        token: "future-but-lower-authority",
      },
    });
    await store.ingestEvent({
      ...base,
      providerId: "b",
      providerEventId: "p2",
      normalizedIdentity: "new",
      startsAt: "2026-08-02T00:00:00.000Z" as IsoTimestamp,
      revision: {
        providerId: "b",
        authorityRank: 20,
        updatedAt: "2020-01-02T00:00:00.000Z" as IsoTimestamp,
        sequence: 1,
        token: "a",
      },
    });
    expect(
      await store.getCanonicalByIdentity(bootstrap.sportKey, "mlb", "old"),
    ).toBe("missing");
    expect(
      await store.getCanonicalByIdentity(bootstrap.sportKey, "mlb", "new"),
    ).toBe("present");
    expect(store.events.get("e")?.startsAt).toBe("2026-08-02T00:00:00.000Z");
    expect(store.events.get("e")?.status).toBe("scheduled");
  });
});
