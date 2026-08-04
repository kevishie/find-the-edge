import { MemoryEventIngestionStore } from "@find-the-edge/database";
import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import { fixtureBootstrap } from "@find-the-edge/providers";
import { describe, expect, it } from "vitest";
import {
  reconcileScheduledProviderEvent,
  type ScheduledProviderEvent,
} from "./schedule-reconciliation";

const observedAt = "2026-08-04T12:00:00.000Z" as IsoTimestamp;
const event = (
  providerEventId: string,
  startsAt: string,
  labels: readonly [string, string] = ["Away Club", "Home Club"],
): ScheduledProviderEvent => ({
  providerEventId,
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  participantLabels: labels,
  startsAt: startsAt as IsoTimestamp,
  status: "scheduled",
  revision: {
    providerId: "sharpapi",
    authorityRank: 60,
    updatedAt: observedAt,
    sequence: 0,
    token: `${providerEventId}:${observedAt}`,
  },
});

const bootstrap = async (
  store: MemoryEventIngestionStore,
  value: ScheduledProviderEvent,
) => {
  await store.bootstrapCanonicalEvent(
    fixtureBootstrap(value, value.providerEventId),
    observedAt,
  );
};

describe("scheduled provider reconciliation", () => {
  for (const seconds of [0, 60, 120])
    it(`aliases an exact ordered matchup at ${seconds} seconds`, async () => {
      const store = new MemoryEventIngestionStore();
      const first = event("sharp_b1", "2026-08-04T20:00:00.000Z");
      await bootstrap(store, first);
      const second = event(
        "sharp_b2",
        new Date(Date.parse(first.startsAt) + seconds * 1_000).toISOString(),
      );
      const result = await reconcileScheduledProviderEvent(
        store,
        "sharpapi",
        second,
        observedAt,
      );
      expect(result.kind).toBe("updated");
      expect(store.events).toHaveLength(1);
      expect(store.mappings).toHaveLength(1);
      expect([...store.events.values()][0]?.startsAt).toBe(first.startsAt);
      const replay = await reconcileScheduledProviderEvent(
        store,
        "sharpapi",
        second,
        observedAt,
      );
      expect(replay.kind).toBe("skipped");
      expect(store.events).toHaveLength(1);
    });

  it("keeps a legitimate matchup outside the window separate", async () => {
    const store = new MemoryEventIngestionStore();
    await bootstrap(store, event("game-1", "2026-08-04T17:00:00.000Z"));
    const result = await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      event("game-2", "2026-08-04T17:02:01.000Z"),
      observedAt,
    );
    expect(["updated", "skipped"]).toContain(result.kind);
    expect(store.events).toHaveLength(2);
  });

  it("does not merge reversed participants", async () => {
    const store = new MemoryEventIngestionStore();
    await bootstrap(store, event("game-1", "2026-08-04T17:00:00.000Z"));
    await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      event("game-2", "2026-08-04T17:01:00.000Z", ["Home Club", "Away Club"]),
      observedAt,
    );
    expect(store.events).toHaveLength(2);
  });

  it("fails closed when more than one near candidate exists", async () => {
    const store = new MemoryEventIngestionStore();
    await bootstrap(store, event("game-1", "2026-08-04T17:00:00.000Z"));
    await bootstrap(store, event("game-2", "2026-08-04T17:04:00.000Z"));
    const result = await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      event("game-3", "2026-08-04T17:02:00.000Z"),
      observedAt,
    );
    expect(result).toEqual({
      kind: "unresolved",
      reason: "ambiguous-candidates",
    });
    expect(store.events).toHaveLength(2);
    expect(store.mappings).toHaveLength(0);
  });

  it("serializes concurrent book aliases into one canonical game", async () => {
    const store = new MemoryEventIngestionStore();
    const results = await Promise.all([
      reconcileScheduledProviderEvent(
        store,
        "sharpapi",
        event("book-1", "2026-08-04T17:00:00.000Z"),
        observedAt,
      ),
      reconcileScheduledProviderEvent(
        store,
        "sharpapi",
        event("book-2", "2026-08-04T17:01:00.000Z"),
        observedAt,
      ),
    ]);
    expect(results.every(({ kind }) => kind !== "unresolved")).toBe(true);
    expect(store.events).toHaveLength(1);
    expect(store.mappings).toHaveLength(2);
  });

  it("applies canonical-source corrections but freezes alias replays", async () => {
    const store = new MemoryEventIngestionStore();
    const source = event("source", "2026-08-04T17:00:00.000Z");
    await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      source,
      observedAt,
    );
    const correctedAt = "2026-08-04T12:05:00.000Z" as IsoTimestamp;
    await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      {
        ...source,
        startsAt: "2026-08-04T17:05:00.000Z" as IsoTimestamp,
        revision: {
          ...source.revision,
          updatedAt: correctedAt,
          sequence: 1,
          token: "source-correction",
        },
      },
      correctedAt,
    );
    expect([...store.events.values()][0]?.startsAt).toBe(
      "2026-08-04T17:05:00.000Z",
    );

    const alias = event("alias", "2026-08-04T17:06:00.000Z");
    await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      alias,
      correctedAt,
    );
    await reconcileScheduledProviderEvent(
      store,
      "sharpapi",
      {
        ...alias,
        startsAt: "2026-08-04T18:00:00.000Z" as IsoTimestamp,
        revision: {
          ...alias.revision,
          updatedAt: "2026-08-04T12:10:00.000Z" as IsoTimestamp,
          sequence: 2,
          token: "alias-replay",
        },
      },
      "2026-08-04T12:10:00.000Z" as IsoTimestamp,
    );
    expect([...store.events.values()][0]?.startsAt).toBe(
      "2026-08-04T17:05:00.000Z",
    );
  });
});
