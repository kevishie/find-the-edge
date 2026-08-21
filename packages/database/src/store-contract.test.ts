import type {
  CanonicalEventBootstrap,
  EntityId,
  IngestionCheckpoint,
  IsoTimestamp,
  LeagueIngestionRun,
  SportKey,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import {
  DynamoConditionalConflict,
  DynamoEventIngestionStore,
  DynamoTransactionConflict,
  type DynamoGateway,
  type DynamoItem,
} from "./dynamodb-event-ingestion";
import {
  checkpointKey,
  continuationOutboxId,
  continuationPendingSortKey,
  stableDigest,
  validateCheckpointCommitLineage,
  validateContinuationLease,
  validateContinuationOutbox,
  EventDataConflict,
  type ContinuationOutbox,
  type EventIngestionStore,
} from "./event-ingestion";
import { MemoryEventIngestionStore } from "./memory-event-ingestion";

class ContractGateway implements DynamoGateway {
  readonly items = new Map<string, DynamoItem>();
  key(pk: string, sk: string) {
    return JSON.stringify([pk, sk]);
  }
  async get(pk: string, sk: string) {
    await Promise.resolve();
    return this.items.get(this.key(pk, sk)) ?? null;
  }
  async batchGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ) {
    await Promise.resolve();
    return keys.flatMap(({ pk, sk }) => {
      const item = this.items.get(this.key(pk, sk));
      return item ? [item] : [];
    });
  }
  async queryUpTo(pk: string, limit: number) {
    await Promise.resolve();
    return [...this.items.values()]
      .filter((item) => item.pk === pk)
      .sort((left, right) => left.sk.localeCompare(right.sk))
      .slice(0, limit);
  }
  async queryPage(pk: string, startSk: string | undefined, limit: number) {
    await Promise.resolve();
    const all = [...this.items.values()]
      .filter((item) => item.pk === pk && (!startSk || item.sk > startSk))
      .sort((left, right) => left.sk.localeCompare(right.sk));
    const items = all.slice(0, limit);
    return {
      items,
      ...(all.length > limit && items.length
        ? { lastEvaluatedSk: items.at(-1)!.sk }
        : {}),
    };
  }
  async transactGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ) {
    await Promise.resolve();
    return keys.map(({ pk, sk }) => this.items.get(this.key(pk, sk)) ?? null);
  }
  async queryAll(pk: string) {
    await Promise.resolve();
    return [...this.items.values()].filter((item) => item.pk === pk);
  }
  async insert(item: DynamoItem) {
    await Promise.resolve();
    const key = this.key(item.pk, item.sk);
    if (this.items.has(key)) return "exists" as const;
    this.items.set(key, item);
    return "inserted" as const;
  }
  async deleteOwnedReconciliationLock(
    pk: string,
    expectedEventId: string,
    expectedLeaseUntil?: string,
  ) {
    await Promise.resolve();
    const key = this.key(pk, "CURRENT");
    const item = this.items.get(key);
    const value = item?.value as
      { eventId?: string; leaseUntil?: string } | undefined;
    if (
      !item ||
      value?.eventId !== expectedEventId ||
      (expectedLeaseUntil !== undefined &&
        value.leaseUntil !== expectedLeaseUntil)
    )
      throw new DynamoConditionalConflict();
    this.items.delete(key);
  }
  async transact(writes: Parameters<DynamoGateway["transact"]>[0]) {
    await Promise.resolve();
    const targets = new Set<string>();
    for (const write of writes) {
      const target =
        write.kind === "insert" ||
        write.kind === "claim-identity" ||
        write.kind === "replace" ||
        write.kind === "put-projection" ||
        write.kind === "put-provider-event-fence" ||
        write.kind === "put-bootstrap-marker" ||
        write.kind === "renew-reconciliation-lock"
          ? this.key(write.item.pk, write.item.sk)
          : this.key(write.pk, write.sk);
      if (targets.has(target)) throw new Error("duplicate-transaction-target");
      targets.add(target);
    }
    const snapshot = new Map(this.items);
    for (const write of writes) {
      if (
        write.kind === "put-provider-event-fence" ||
        write.kind === "put-bootstrap-marker"
      ) {
        const current = snapshot.get(this.key(write.item.pk, write.item.sk))
          ?.value as { pagePositionDigest?: string } | undefined;
        if (
          current &&
          current.pagePositionDigest !== write.expectedPagePositionDigest
        )
          throw new DynamoConditionalConflict();
        snapshot.set(this.key(write.item.pk, write.item.sk), write.item);
        continue;
      }
      if (write.kind === "check-identity") {
        const current = snapshot.get(this.key(write.pk, write.sk))?.value as
          | { version?: number; candidateEventIds?: readonly string[] }
          | undefined;
        if (
          current?.version !== write.expectedVersion ||
          JSON.stringify(current.candidateEventIds) !==
            JSON.stringify(write.expectedCandidateEventIds)
        )
          throw new Error("identity-snapshot-moved");
        continue;
      }
      if (write.kind === "check-identity-absent") {
        if (snapshot.has(this.key(write.pk, write.sk)))
          throw new Error("identity-snapshot-created");
        continue;
      }
      if (write.kind === "check-event") {
        const current = snapshot.get(this.key(write.pk, write.sk))?.value as
          { version?: number; candidateIdentity?: string } | undefined;
        if (
          current?.version !== write.expectedVersion ||
          current.candidateIdentity !== write.expectedIdentity ||
          (write.expectedSnapshot !== undefined &&
            JSON.stringify(current) !== JSON.stringify(write.expectedSnapshot))
        )
          throw new Error("candidate-moved");
        continue;
      }
      if (write.kind === "delete") {
        const current = snapshot.get(this.key(write.pk, write.sk))?.value as
          { version?: number; eventId?: string } | string | undefined;
        if (
          write.expectedVersion !== undefined &&
          (typeof current !== "object" ||
            current?.version !== write.expectedVersion)
        )
          throw new Error("optimistic-conflict");
        if (
          write.expectedEventId !== undefined &&
          (typeof current === "string" ? current : current?.eventId) !==
            write.expectedEventId
        )
          throw new Error("identity-owner-conflict");
        snapshot.delete(this.key(write.pk, write.sk));
        continue;
      }
      if (write.kind === "check-reconciliation-lock") {
        const current = snapshot.get(this.key(write.pk, write.sk))?.value as
          { eventId?: string; leaseUntil?: string } | undefined;
        if (
          current?.eventId !== write.expectedToken ||
          !current.leaseUntil ||
          current.leaseUntil <= write.leaseAfter
        )
          throw new Error("reconciliation-ownership-lost");
        continue;
      }
      if (write.kind === "renew-reconciliation-lock") {
        const key = this.key(write.item.pk, write.item.sk);
        const current = snapshot.get(key)?.value as
          { eventId?: string } | undefined;
        if (current?.eventId !== write.expectedToken)
          throw new Error("reconciliation-ownership-lost");
        snapshot.set(key, write.item);
        continue;
      }
      const key = this.key(write.item.pk, write.item.sk);
      if (
        write.kind === "put-projection" &&
        write.expectedValue !== undefined &&
        JSON.stringify(snapshot.get(key)?.value) !==
          JSON.stringify(write.expectedValue)
      )
        throw new DynamoConditionalConflict();
      if (
        write.kind === "put-projection" &&
        write.requireAbsent &&
        snapshot.has(key)
      )
        throw new DynamoConditionalConflict();
      if (write.kind === "insert" && snapshot.has(key))
        throw new DynamoConditionalConflict();
      if (write.kind === "claim-identity" && snapshot.has(key)) {
        throw new DynamoConditionalConflict();
      }
      if (write.kind === "replace") {
        const current = snapshot.get(key)?.value as
          { version?: number } | undefined;
        if (current?.version !== write.expectedVersion)
          throw new Error("optimistic-conflict");
      }
      snapshot.set(key, write.item);
    }
    this.items.clear();
    for (const [key, value] of snapshot) this.items.set(key, value);
  }
  async compareAndSetCheckpoint(
    pk: string,
    expected: Parameters<DynamoGateway["compareAndSetCheckpoint"]>[1],
    next: IngestionCheckpoint,
  ) {
    await Promise.resolve();
    const key = this.key(pk, "CURRENT");
    const current = this.items.get(key)?.value as
      IngestionCheckpoint | undefined;
    if (JSON.stringify(current ?? null) !== JSON.stringify(expected))
      return false;
    this.items.set(key, { pk, sk: "CURRENT", value: next });
    return true;
  }
  async put(item: DynamoItem) {
    await Promise.resolve();
    this.items.set(this.key(item.pk, item.sk), item);
  }
  async transactCheckpoint(
    pk: string,
    expected: Parameters<DynamoGateway["transactCheckpoint"]>[1],
    next: IngestionCheckpoint,
    writes: Parameters<DynamoGateway["transactCheckpoint"]>[3],
  ) {
    const key = this.key(pk, "CURRENT");
    const current = this.items.get(key)?.value ?? null;
    if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    await this.transact(writes);
    this.items.set(key, { pk, sk: "CURRENT", value: next });
    return true;
  }
}

const observedAt = "2026-07-30T00:00:00.000Z" as IsoTimestamp;
const bootstrap: CanonicalEventBootstrap = {
  id: "canonical" as EntityId,
  canonicalKey: "one",
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  leagueId: "league" as EntityId,
  participantIds: ["a" as EntityId, "b" as EntityId],
  participantLabels: ["A", "B"],
  startsAt: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
  phase: "pregame",
  status: "scheduled",
  normalizedIdentity: "identity",
  revision: {
    providerId: "bootstrap",
    authorityRank: 100,
    updatedAt: observedAt,
    sequence: 1,
    token: "one",
  },
};

function pendingOutbox(
  checkpointScopeKey: string,
  cycle: number,
  epoch: number,
  state: "intent" | "claimed" | "delivered" = "intent",
): ContinuationOutbox {
  const position = {
    state: "cursor" as const,
    cursor: `offset:${cycle}:${epoch}`,
  };
  const predecessorRunId = stableDigest(`run:${cycle}:${epoch}`);
  const attemptId = stableDigest(
    JSON.stringify([
      predecessorRunId,
      checkpointScopeKey,
      cycle,
      epoch,
      position.cursor,
    ]),
  );
  const command = {
    attemptId,
    checkpointScope: "scope",
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    windowStart: observedAt,
    windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
    pageLimit: 100,
    maxPages: 20,
    expectedContinuation: { cycle, epoch, position },
  };
  const checkpoint: IngestionCheckpoint = {
    key: checkpointScopeKey,
    providerId: "provider",
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    checkpointScope: "scope",
    windowStart: observedAt,
    windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
    position,
    continuationCycle: cycle,
    continuationCount: epoch,
    bootstrapRequestCount: 0,
    lastRunId: predecessorRunId,
    updatedAt: observedAt,
  };
  const common = {
    id: continuationOutboxId(checkpoint, command),
    checkpointKey: checkpointScopeKey,
    providerId: "provider",
    predecessorRunId,
    command,
    cycle,
    epoch,
  };
  if (state === "intent") return { ...common, state, version: 1 };
  const claim = {
    claimantId: "worker",
    claimedAt: observedAt,
    leaseUntil: "2026-07-30T00:03:00.000Z" as IsoTimestamp,
  };
  if (state === "claimed") return { ...common, ...claim, state, version: 2 };
  return {
    ...common,
    ...claim,
    state,
    deliveredAt: observedAt,
    version: 3,
  };
}

function contract(name: string, create: () => EventIngestionStore) {
  describe(`${name} event-ingestion contract`, () => {
    it("reverse-resolves the original exact source mapping for backfill", async () => {
      const store = create();
      const backfillBootstrap = {
        ...bootstrap,
        id: "event:mlb%3Amlb:one" as EntityId,
        canonicalKey: "one",
      };
      await store.bootstrapCanonicalEvent(backfillBootstrap, observedAt);
      const source = {
        providerId: "sharpapi",
        providerEventId: backfillBootstrap.canonicalKey,
        sportKey: backfillBootstrap.sportKey,
        leagueKey: backfillBootstrap.leagueKey,
        normalizedIdentity: backfillBootstrap.normalizedIdentity,
        startsAt: backfillBootstrap.startsAt,
        status: backfillBootstrap.status,
        participantLabels: backfillBootstrap.participantLabels,
        revision: {
          providerId: "sharpapi",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "source-1",
        },
        observedAt,
      } as const;
      await store.ingestEvent(source);
      await expect(
        store.resolveCanonicalSourceBinding(backfillBootstrap.id, "sharpapi"),
      ).resolves.toMatchObject({
        canonicalEventId: backfillBootstrap.id,
        providerEventId: backfillBootstrap.canonicalKey,
        bindingKind: "source",
      });
      await expect(
        store.resolveCanonicalSourceBinding(
          backfillBootstrap.id,
          "other-provider",
        ),
      ).resolves.toBeNull();
    });

    it("does not churn the canonical version for fresher identical schedules", async () => {
      const store = create();
      await store.bootstrapCanonicalEvent(bootstrap, observedAt);
      const first = {
        providerId: "sharpapi",
        providerEventId: "stable-schedule",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        participantLabels: bootstrap.participantLabels,
        revision: {
          providerId: "sharpapi",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "stable-1",
        },
        observedAt,
      } as const;
      await expect(store.ingestEvent(first)).resolves.toMatchObject({
        kind: "updated",
      });
      const before = await store.resolveExactCanonicalBinding({
        providerId: first.providerId,
        providerEventId: first.providerEventId,
        sportKey: first.sportKey,
        leagueKey: first.leagueKey,
      });
      const refreshedAt = "2026-07-30T00:01:00.000Z" as IsoTimestamp;
      await expect(
        store.ingestEvent({
          ...first,
          revision: {
            ...first.revision,
            updatedAt: refreshedAt,
            sequence: 2,
            token: "stable-2",
          },
          observedAt: refreshedAt,
        }),
      ).resolves.toMatchObject({ kind: "skipped" });
      const after = await store.resolveExactCanonicalBinding({
        providerId: first.providerId,
        providerEventId: first.providerEventId,
        sportKey: first.sportKey,
        leagueKey: first.leagueKey,
      });
      expect(after?.version).toBe(before?.version);
    });

    it("serializes concurrent same-matchup reconciliation", async () => {
      const store = create();
      const reconciliation = (id: string, startsAt: string) => {
        const candidate = {
          ...bootstrap,
          id: `canonical-${id}` as EntityId,
          canonicalKey: id,
          startsAt: startsAt as IsoTimestamp,
          normalizedIdentity: `identity-${id}`,
          revision: {
            ...bootstrap.revision,
            providerId: "sharpapi",
            token: id,
          },
        };
        return {
          bootstrap: candidate,
          event: {
            providerId: "sharpapi",
            providerEventId: id,
            sportKey: candidate.sportKey,
            leagueKey: candidate.leagueKey,
            normalizedIdentity: candidate.normalizedIdentity,
            startsAt: candidate.startsAt,
            status: candidate.status,
            participantLabels: candidate.participantLabels,
            revision: candidate.revision,
            observedAt,
          },
        };
      };
      const outcomes = await Promise.all([
        store.reconcileScheduledEvent(
          reconciliation("book-1", "2026-08-01T00:00:00.000Z"),
        ),
        store.reconcileScheduledEvent(
          reconciliation("book-2", "2026-08-01T00:01:00.000Z"),
        ),
      ]);
      expect(outcomes.every(({ kind }) => kind !== "unresolved")).toBe(true);
      const bindings = await Promise.all(
        ["book-1", "book-2"].map((providerEventId) =>
          store.resolveExactCanonicalBinding({
            providerId: "sharpapi",
            providerEventId,
            sportKey: bootstrap.sportKey,
            leagueKey: bootstrap.leagueKey,
          }),
        ),
      );
      expect(bindings[0]?.id).toBe(bindings[1]?.id);
    });

    it("migrates stable MLB club identity onto a pre-deployment canonical event", async () => {
      const store = create();
      const legacy = {
        ...bootstrap,
        id: "legacy-mlb" as EntityId,
        participantIds: ["legacy-boston", "legacy-new-york"] as [
          EntityId,
          EntityId,
        ],
        participantLabels: ["Boston Red Sox", "New York Yankees"] as [
          string,
          string,
        ],
        normalizedIdentity: "legacy-full-label-identity",
      };
      await store.bootstrapCanonicalEvent(legacy, observedAt);
      const result = await store.reconcileScheduledEvent({
        event: {
          providerId: "sharpapi",
          providerEventId: "sharp-stable",
          sportKey: "mlb" as SportKey,
          leagueKey: "mlb",
          participantLabels: ["Red Sox", "Yankees"],
          participantIdentityIds: [
            "stable-redsox",
            "stable-yankees",
          ] as EntityId[],
          normalizedIdentity: "stable-club-identity",
          startsAt: legacy.startsAt,
          status: "scheduled",
          revision: {
            ...legacy.revision,
            providerId: "sharpapi",
            token: "stable",
          },
          observedAt,
        },
        bootstrap: {
          ...legacy,
          id: "new-duplicate-must-not-be-created" as EntityId,
          participantIds: ["stable-redsox", "stable-yankees"] as [
            EntityId,
            EntityId,
          ],
          participantLabels: ["Red Sox", "Yankees"],
          normalizedIdentity: "stable-club-identity",
          canonicalKey: "sharp-stable",
        },
      });
      expect(result).toMatchObject({ kind: "updated", eventId: "legacy-mlb" });
    });

    it("ignores a different soccer matchup in the same kickoff window", async () => {
      const store = create();
      const soccerBase = {
        ...bootstrap,
        sportKey: "soccer" as SportKey,
        leagueKey: "epl",
        leagueId: "epl" as EntityId,
        startsAt: "2026-08-01T14:00:00.000Z" as IsoTimestamp,
      };
      await store.bootstrapCanonicalEvent(
        {
          ...soccerBase,
          id: "arsenal-chelsea" as EntityId,
          canonicalKey: "arsenal-chelsea",
          participantIds: ["arsenal", "chelsea"] as [EntityId, EntityId],
          participantLabels: ["Arsenal", "Chelsea"],
          normalizedIdentity: "arsenal-chelsea",
        },
        observedAt,
      );
      await store.bootstrapCanonicalEvent(
        {
          ...soccerBase,
          id: "liverpool-everton" as EntityId,
          canonicalKey: "liverpool-everton",
          participantIds: ["liverpool", "everton"] as [EntityId, EntityId],
          participantLabels: ["Liverpool", "Everton"],
          normalizedIdentity: "liverpool-everton",
          revision: { ...soccerBase.revision, token: "liverpool-everton" },
        },
        observedAt,
      );

      await expect(
        store.findNearCanonicalCandidates({
          sportKey: "soccer" as SportKey,
          leagueKey: "epl",
          startsAt: soccerBase.startsAt,
          status: "scheduled",
          participantLabels: ["Arsenal", "Chelsea"],
          participantIdentityIds: ["arsenal", "chelsea"] as EntityId[],
        }),
      ).resolves.toEqual([expect.objectContaining({ id: "arsenal-chelsea" })]);
    });

    it("crosses Eastern midnight and ignores closed projections", async () => {
      const store = create();
      const beforeMidnight = {
        ...bootstrap,
        id: "midnight" as EntityId,
        startsAt: "2026-08-04T03:59:30.000Z" as IsoTimestamp,
        normalizedIdentity: "midnight-before",
      };
      await store.bootstrapCanonicalEvent(beforeMidnight, observedAt);
      await expect(
        store.findNearCanonicalCandidates({
          sportKey: bootstrap.sportKey,
          leagueKey: bootstrap.leagueKey,
          startsAt: "2026-08-04T04:00:30.000Z" as IsoTimestamp,
          status: "scheduled",
          participantLabels: bootstrap.participantLabels,
        }),
      ).resolves.toEqual([expect.objectContaining({ id: "midnight" })]);

      await store.bootstrapCanonicalEvent(
        {
          ...beforeMidnight,
          startsAt: "2026-08-04T05:00:00.000Z" as IsoTimestamp,
          normalizedIdentity: "midnight-corrected",
          revision: {
            ...beforeMidnight.revision,
            sequence: 2,
            token: "midnight-corrected",
          },
        },
        "2026-07-30T00:01:00.000Z" as IsoTimestamp,
      );
      await expect(
        store.findNearCanonicalCandidates({
          sportKey: bootstrap.sportKey,
          leagueKey: bootstrap.leagueKey,
          startsAt: "2026-08-04T03:59:30.000Z" as IsoTimestamp,
          status: "scheduled",
          participantLabels: bootstrap.participantLabels,
        }),
      ).resolves.toEqual([]);
    });
    it("finds only ordered scheduled candidates inside the inclusive near window", async () => {
      const store = create();
      const candidates = [
        { id: "near-zero", seconds: 0 },
        { id: "near-edge", seconds: 3_600 },
        { id: "outside", seconds: 3_601 },
      ] as const;
      for (const candidate of candidates)
        await store.bootstrapCanonicalEvent(
          {
            ...bootstrap,
            id: candidate.id as EntityId,
            canonicalKey: candidate.id,
            startsAt: new Date(
              Date.parse(bootstrap.startsAt) + candidate.seconds * 1_000,
            ).toISOString() as IsoTimestamp,
            normalizedIdentity: `identity-${candidate.id}`,
            revision: {
              ...bootstrap.revision,
              sequence: candidate.seconds + 1,
              token: candidate.id,
            },
          },
          observedAt,
        );
      await expect(
        store.findNearCanonicalCandidates({
          sportKey: bootstrap.sportKey,
          leagueKey: bootstrap.leagueKey,
          startsAt: bootstrap.startsAt,
          status: "scheduled",
          participantLabels: [" a ", "B"],
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "near-zero" }),
          expect.objectContaining({ id: "near-edge" }),
        ]),
      );
      const found = await store.findNearCanonicalCandidates({
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        startsAt: bootstrap.startsAt,
        status: "scheduled",
        participantLabels: ["A", "B"],
      });
      expect(found.map(({ id }) => id)).toEqual(["near-edge", "near-zero"]);
      expect(found.some(({ id }) => id === "outside")).toBe(false);
      await expect(
        store.findNearCanonicalCandidates({
          sportKey: bootstrap.sportKey,
          leagueKey: bootstrap.leagueKey,
          startsAt: bootstrap.startsAt,
          status: "scheduled",
          participantLabels: ["B", "A"],
        }),
      ).resolves.toEqual([]);
    });
    it("rejects bootstrap IDs and identities replayed at another page position", async () => {
      const store = create();
      const event = {
        id: bootstrap.id,
        normalizedIdentity: bootstrap.normalizedIdentity,
      };
      const markerCheckpointKey = checkpointKey({
        providerId: "provider",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        checkpointScope: "bootstrap-markers",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
      });
      await expect(
        store.recordBootstrapPageMarkers(
          markerCheckpointKey,
          { state: "start" },
          [event],
          "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        ),
      ).resolves.toBe("recorded");
      await expect(
        store.recordBootstrapPageMarkers(
          markerCheckpointKey,
          { state: "start" },
          [event],
          "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        ),
      ).resolves.toBe("same-position");
      await expect(
        store.recordBootstrapPageMarkers(
          markerCheckpointKey,
          { state: "cursor", cursor: "next" },
          [event],
          "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        ),
      ).rejects.toThrow("duplicate-bootstrap-position");
    });
    it("persists a page-scoped provider-event fence with replay parity", async () => {
      const store = create();
      await store.bootstrapCanonicalEvent(bootstrap, observedAt);
      const checkpointScopeKey = checkpointKey({
        providerId: "provider",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        checkpointScope: "scope",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
      });
      const input = {
        providerId: "provider",
        providerEventId: "durable-duplicate",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "durable-duplicate",
        },
        observedAt,
        providerEventFence: {
          checkpointKey: checkpointScopeKey,
          pagePosition: { state: "start" as const },
          windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        },
      };
      await expect(store.ingestEvent(input)).resolves.toMatchObject({
        kind: "updated",
      });
      await expect(
        store.getProviderEventFence(
          checkpointScopeKey,
          input.providerEventId,
          input.providerEventFence.pagePosition,
        ),
      ).resolves.toBe("same-page");
      const laterPosition = { state: "cursor" as const, cursor: "offset:1" };
      await expect(
        store.getProviderEventFence(
          checkpointScopeKey,
          input.providerEventId,
          laterPosition,
        ),
      ).resolves.toBe("duplicate");
      await expect(
        store.ingestEvent({
          ...input,
          providerEventFence: {
            ...input.providerEventFence,
            pagePosition: laterPosition,
          },
        }),
      ).rejects.toThrow("duplicate-provider-event");
      const dataConflict = await store
        .ingestEvent({
          ...input,
          status: "postponed",
        })
        .catch((error: unknown) => error);
      expect(dataConflict).toBeInstanceOf(EventDataConflict);
      expect(dataConflict).toMatchObject({
        reason: "provider-revision-content-conflict",
      });
    });

    it("keeps three-plus identity candidates bounded and ambiguous", async () => {
      const store = create();
      await store.bootstrapCanonicalEvent(bootstrap, observedAt);
      const candidate = (id: string) => ({
        id: id as EntityId,
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        leagueId: bootstrap.leagueId,
        participantIds: [...bootstrap.participantIds],
        startsAt: bootstrap.startsAt,
        phase: bootstrap.phase,
        evidence: [],
        status: bootstrap.status,
        revisions: {},
        updatedAt: observedAt,
        candidateIdentity: bootstrap.normalizedIdentity,
        bootstrapRevision: bootstrap.revision,
        version: 1,
      });
      const second = candidate("candidate-b");
      const third = candidate("candidate-c");
      const fourth = candidate("candidate-d");
      await expect(store.registerCandidate(second)).resolves.toBe("registered");
      await expect(store.registerCandidate(third)).resolves.toBe("registered");
      await expect(store.registerCandidate(fourth)).resolves.toBe(
        "already-registered",
      );
      await expect(store.registerCandidate(third)).resolves.toBe(
        "already-registered",
      );
      await expect(store.registerCandidate(fourth)).resolves.toBe(
        "already-registered",
      );
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          bootstrap.normalizedIdentity,
        ),
      ).resolves.toBe("ambiguous");
    });
    it("repairs bootstrap identity and keeps unresolved observations", async () => {
      const store = create();
      await expect(
        store.bootstrapCanonicalEvent(bootstrap, observedAt),
      ).resolves.toBe("created");
      await expect(
        store.bootstrapCanonicalEvent(bootstrap, observedAt),
      ).resolves.toBe("existing");
      await expect(
        store.bootstrapCanonicalEvent(
          { ...bootstrap, status: "cancelled" },
          observedAt,
        ),
      ).rejects.toThrow("bootstrap-revision-content-conflict");
      await expect(
        store.bootstrapCanonicalEvent(
          {
            ...bootstrap,
            normalizedIdentity: "moved",
            revision: { ...bootstrap.revision, sequence: 2, token: "two" },
          },
          observedAt,
        ),
      ).resolves.toBe("repaired");
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          bootstrap.normalizedIdentity,
        ),
      ).resolves.toBe("missing");
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          "moved",
        ),
      ).resolves.toBe("present");
      await expect(
        store.bootstrapCanonicalEvent(
          {
            ...bootstrap,
            normalizedIdentity: "forged",
            participantIds: ["a" as EntityId, "other" as EntityId],
          },
          observedAt,
        ),
      ).rejects.toThrow("bootstrap-content-mismatch");
      await expect(
        store.bootstrapCanonicalEvent(
          {
            ...bootstrap,
            normalizedIdentity: "stale",
            revision: {
              ...bootstrap.revision,
              updatedAt: "2026-07-29T00:00:00.000Z" as IsoTimestamp,
            },
          },
          observedAt,
        ),
      ).rejects.toThrow("bootstrap-stale");
      const input = {
        providerId: "provider",
        providerEventId: "missing",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        normalizedIdentity: "absent",
        startsAt: bootstrap.startsAt,
        status: "scheduled" as const,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "one",
        },
        observedAt,
      };
      await expect(store.ingestEvent(input)).resolves.toMatchObject({
        kind: "unresolved",
      });
      for (let index = 1; index <= 21; index++) {
        await expect(
          store.ingestEvent({
            ...input,
            observedAt: new Date(
              Date.parse(observedAt) + index * 1_000,
            ).toISOString() as IsoTimestamp,
          }),
        ).resolves.toMatchObject({ kind: "unresolved" });
      }
      // The original observation has fallen out of the bounded CURRENT
      // summary, but its idempotency marker still prevents a duplicate.
      await expect(store.ingestEvent(input)).resolves.toMatchObject({
        kind: "unresolved",
      });
      await expect(store.ingestEvent(input)).resolves.toMatchObject({
        kind: "unresolved",
      });
    });

    it("uses exact mappings before changed identity and preserves canonical ID", async () => {
      const store = create();
      await store.bootstrapCanonicalEvent(bootstrap, observedAt);
      const original = {
        providerId: "provider",
        providerEventId: "mapped",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: "scheduled" as const,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "one",
        },
        observedAt,
      };
      await store.ingestEvent(original);
      const mapping = await store.getExactMapping(original);
      expect(mapping?.canonicalEventId).toBe(bootstrap.id);
      await expect(
        store.resolveExactCanonicalBinding(original),
      ).resolves.toMatchObject({
        id: bootstrap.id,
        version: 2,
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
      });
      const postponed = {
        ...original,
        normalizedIdentity: "rescheduled",
        startsAt: "2026-08-02T00:00:00.000Z" as IsoTimestamp,
        status: "postponed",
        revision: {
          ...original.revision,
          updatedAt: "2026-07-31T00:00:00.000Z" as IsoTimestamp,
          sequence: 2,
        },
      } as const;
      await expect(store.ingestEvent(postponed)).resolves.toMatchObject({
        kind: "updated",
        eventId: bootstrap.id,
      });
      await expect(
        store.resolveExactCanonicalBinding(original),
      ).resolves.toMatchObject({
        id: bootstrap.id,
        version: 3,
        startsAt: postponed.startsAt,
      });
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          bootstrap.normalizedIdentity,
        ),
      ).resolves.toBe("missing");
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          postponed.normalizedIdentity,
        ),
      ).resolves.toBe("present");
      await expect(
        store.bootstrapCanonicalEvent(
          {
            ...bootstrap,
            id: "replacement" as EntityId,
            canonicalKey: "replacement",
            revision: {
              ...bootstrap.revision,
              token: "replacement",
            },
          },
          observedAt,
        ),
      ).resolves.toBe("created");
      await expect(store.ingestEvent(postponed)).resolves.toMatchObject({
        kind: "skipped",
        eventId: bootstrap.id,
      });
      await expect(
        store.ingestEvent({
          ...postponed,
          status: "cancelled",
          revision: {
            ...postponed.revision,
            updatedAt: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
            sequence: 3,
          },
        }),
      ).resolves.toMatchObject({
        kind: "updated",
        eventId: bootstrap.id,
      });
    });

    it("never steals a destination identity during a mapped reschedule", async () => {
      const store = create();
      await store.bootstrapCanonicalEvent(bootstrap, observedAt);
      await store.bootstrapCanonicalEvent(
        {
          ...bootstrap,
          id: "destination-owner" as EntityId,
          canonicalKey: "destination-owner",
          normalizedIdentity: "occupied",
          revision: { ...bootstrap.revision, token: "destination-owner" },
        },
        observedAt,
      );
      const original = {
        providerId: "provider",
        providerEventId: "mapped-conflict",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: "scheduled" as const,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "one",
        },
        observedAt,
      };
      await store.ingestEvent(original);
      const identityConflict = await store
        .ingestEvent({
          ...original,
          normalizedIdentity: "occupied",
          startsAt: "2026-08-02T00:00:00.000Z" as IsoTimestamp,
          revision: {
            ...original.revision,
            updatedAt: "2026-07-31T00:00:00.000Z" as IsoTimestamp,
            sequence: 2,
          },
        })
        .catch((error: unknown) => error);
      expect(identityConflict).toBeInstanceOf(EventDataConflict);
      expect(identityConflict).toMatchObject({
        reason: "identity-claim-conflict",
      });
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          bootstrap.normalizedIdentity,
        ),
      ).resolves.toBe("present");
      await expect(
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          "occupied",
        ),
      ).resolves.toBe("present");
    });

    it("allows only one winner for concurrent mapped identity moves", async () => {
      const store = create();
      await store.bootstrapCanonicalEvent(bootstrap, observedAt);
      const original = {
        providerId: "provider",
        providerEventId: "concurrent-move",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: "scheduled" as const,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "one",
        },
        observedAt,
      };
      await store.ingestEvent(original);
      const results = await Promise.allSettled([
        store.ingestEvent({
          ...original,
          normalizedIdentity: "move-a",
          revision: {
            ...original.revision,
            updatedAt: "2026-07-31T00:00:00.000Z" as IsoTimestamp,
            sequence: 2,
            token: "same-revision",
          },
        }),
        store.ingestEvent({
          ...original,
          normalizedIdentity: "move-b",
          revision: {
            ...original.revision,
            updatedAt: "2026-07-31T00:00:00.000Z" as IsoTimestamp,
            sequence: 2,
            token: "same-revision",
          },
        }),
      ]);
      expect(
        results.filter(
          (result) =>
            result.status === "fulfilled" && result.value.kind === "updated",
        ),
      ).toHaveLength(1);
      const states = await Promise.all([
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          "move-a",
        ),
        store.getCanonicalByIdentity(
          bootstrap.sportKey,
          bootstrap.leagueKey,
          "move-b",
        ),
      ]);
      expect(states.filter((state) => state === "present")).toHaveLength(1);
    });

    it("atomically records checkpoint, audit, and replayable continuation", async () => {
      const store = create();
      const checkpoint: IngestionCheckpoint = {
        key: checkpointKey({
          providerId: "provider",
          sportKey: "mlb" as SportKey,
          leagueKey: "mlb",
          checkpointScope: "scope",
          windowStart: observedAt,
          windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        }),
        providerId: "provider",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        checkpointScope: "scope",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        position: { state: "cursor", cursor: "next" },
        continuationCycle: 0,
        continuationCount: 1,
        bootstrapRequestCount: 1,
        lastRunId: "c".repeat(64),
        updatedAt: observedAt,
      };
      const run: LeagueIngestionRun = {
        id: checkpoint.lastRunId,
        attemptId: "attempt",
        sportKey: checkpoint.sportKey,
        leagueKey: checkpoint.leagueKey,
        providerId: checkpoint.providerId,
        startedAt: observedAt,
        finishedAt: observedAt,
        durationMs: 0,
        status: "continuation-queued",
        counters: {
          providerRequests: 1,
          pages: 1,
          bootstrapped: 0,
          repaired: 0,
          updated: 0,
          skipped: 0,
          unresolved: 0,
          quotaUsed: 1,
        },
        finalPosition: checkpoint.position,
        runRecordPersisted: true,
        checkpointKey: checkpoint.key,
      };
      const command = {
        attemptId: stableDigest(
          JSON.stringify([
            run.id,
            checkpoint.key,
            checkpoint.continuationCycle,
            checkpoint.continuationCount,
            (checkpoint.position as { cursor: string }).cursor,
          ]),
        ),
        checkpointScope: checkpoint.checkpointScope,
        sportKey: checkpoint.sportKey,
        leagueKey: checkpoint.leagueKey,
        windowStart: checkpoint.windowStart,
        windowEnd: checkpoint.windowEnd,
        pageLimit: 100,
        maxPages: 20,
        expectedContinuation: {
          cycle: checkpoint.continuationCycle,
          epoch: checkpoint.continuationCount,
          position: checkpoint.position as {
            state: "cursor";
            cursor: string;
          },
        },
      };
      await expect(
        store.commitCheckpoint(null, checkpoint, run),
      ).rejects.toThrow("missing-continuation-command");
      await expect(
        store.commitCheckpoint(null, checkpoint, run, {
          ...command,
          attemptId: "f".repeat(64),
        }),
      ).rejects.toThrow("invalid-continuation-lineage");
      const wrongCursor = {
        state: "cursor" as const,
        cursor: "other-cursor",
      };
      await expect(
        store.commitCheckpoint(null, checkpoint, run, {
          ...command,
          attemptId: stableDigest(
            JSON.stringify([
              run.id,
              checkpoint.key,
              checkpoint.continuationCycle,
              checkpoint.continuationCount,
              wrongCursor.cursor,
            ]),
          ),
          expectedContinuation: {
            ...command.expectedContinuation,
            position: wrongCursor,
          },
        }),
      ).rejects.toThrow("invalid-continuation-lineage");
      await expect(
        store.commitCheckpoint(null, checkpoint, run, command),
      ).resolves.toBe(true);
      await expect(
        store.commitCheckpoint(null, checkpoint, run, command),
      ).resolves.toBe(true);
      const otherCheckpoint: IngestionCheckpoint = {
        ...checkpoint,
        key: checkpointKey({
          providerId: checkpoint.providerId,
          sportKey: "soccer" as SportKey,
          leagueKey: "mls",
          checkpointScope: checkpoint.checkpointScope,
          windowStart: checkpoint.windowStart,
          windowEnd: checkpoint.windowEnd,
        }),
        sportKey: "soccer" as SportKey,
        leagueKey: "mls",
        lastRunId: "e".repeat(64),
      };
      const otherRun: LeagueIngestionRun = {
        ...run,
        id: otherCheckpoint.lastRunId,
        sportKey: otherCheckpoint.sportKey,
        leagueKey: otherCheckpoint.leagueKey,
        checkpointKey: otherCheckpoint.key,
      };
      await expect(
        store.commitCheckpoint(null, otherCheckpoint, otherRun, {
          ...command,
          attemptId: stableDigest(
            JSON.stringify([
              otherRun.id,
              otherCheckpoint.key,
              otherCheckpoint.continuationCycle,
              otherCheckpoint.continuationCount,
              (otherCheckpoint.position as { cursor: string }).cursor,
            ]),
          ),
          sportKey: otherCheckpoint.sportKey,
          leagueKey: otherCheckpoint.leagueKey,
        }),
      ).resolves.toBe(true);
      const pending = await store.claimPendingContinuation(
        "worker-a",
        observedAt,
        "2026-07-30T00:01:00.000Z" as IsoTimestamp,
        checkpoint.key,
      );
      expect(pending?.command).toEqual(command);
      expect(pending?.checkpointKey).toBe(checkpoint.key);
      await expect(
        store.claimPendingContinuation(
          "worker-other",
          observedAt,
          "2026-07-30T00:01:00.000Z" as IsoTimestamp,
          otherCheckpoint.key,
        ),
      ).resolves.toMatchObject({ checkpointKey: otherCheckpoint.key });
      await expect(
        store.claimPendingContinuation(
          "worker-b",
          observedAt,
          "2026-07-30T00:01:00.000Z" as IsoTimestamp,
          checkpoint.key,
        ),
      ).resolves.toBeNull();
      await store.markContinuationDelivered(
        pending!.id,
        checkpoint.key,
        pending!.cycle,
        pending!.epoch,
        "worker-a",
        observedAt,
      );
      await expect(
        store.claimPendingContinuation(
          "worker-c",
          observedAt,
          "2026-07-30T00:01:00.000Z" as IsoTimestamp,
          checkpoint.key,
        ),
      ).resolves.toBeNull();
    });

    it("replays a terminal checkpoint commit without constructing an outbox", async () => {
      const store = create();
      const key = checkpointKey({
        providerId: "provider",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        checkpointScope: "terminal",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
      });
      const checkpoint: IngestionCheckpoint = {
        key,
        providerId: "provider",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        checkpointScope: "terminal",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        position: { state: "terminal" },
        continuationCycle: 0,
        continuationCount: 0,
        bootstrapRequestCount: 0,
        lastRunId: "f".repeat(64),
        updatedAt: observedAt,
      };
      const run: LeagueIngestionRun = {
        id: checkpoint.lastRunId,
        attemptId: "terminal",
        sportKey: checkpoint.sportKey,
        leagueKey: checkpoint.leagueKey,
        providerId: checkpoint.providerId,
        startedAt: observedAt,
        finishedAt: observedAt,
        durationMs: 0,
        status: "succeeded",
        counters: {
          providerRequests: 1,
          pages: 1,
          bootstrapped: 0,
          repaired: 0,
          updated: 0,
          skipped: 0,
          unresolved: 0,
          quotaUsed: 1,
        },
        finalPosition: checkpoint.position,
        runRecordPersisted: true,
      };
      await expect(store.commitCheckpoint(null, checkpoint, run)).resolves.toBe(
        true,
      );
      await expect(store.commitCheckpoint(null, checkpoint, run)).resolves.toBe(
        true,
      );
    });
  });
}

describe("projection temporal fences", () => {
  const runRepeated = async (
    store: EventIngestionStore,
    rows: () => readonly DynamoItem[],
  ) => {
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const statuses = ["postponed", "scheduled", "cancelled"] as const;
    for (let index = 0; index < statuses.length; index++) {
      await store.ingestEvent({
        providerId: "provider",
        providerEventId: "repeated-clock",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: statuses[index]!,
        participantLabels: bootstrap.participantLabels,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: index + 1,
          token: `repeat-${index}`,
        },
        observedAt,
      });
    }
    const values = rows()
      .flatMap((row) =>
        row.value && typeof row.value === "object" && "family" in row.value
          ? [
              row.value as {
                family: string;
                visibleFrom: string;
                visibleUntil: string | null;
              },
            ]
          : [],
      )
      .filter((row) => row.family === "sport")
      .sort((left, right) => left.visibleFrom.localeCompare(right.visibleFrom));
    expect(values).toHaveLength(4);
    expect(new Set(values.map((row) => row.visibleFrom)).size).toBe(4);
    for (let index = 1; index < values.length; index++)
      expect(Date.parse(values[index]!.visibleFrom)).toBeGreaterThan(
        Date.parse(values[index - 1]!.visibleFrom),
      );
    expect(values.filter((row) => row.visibleUntil === null)).toHaveLength(1);
  };

  it("stays strictly monotonic across three repeated timestamps in memory", async () => {
    const store = new MemoryEventIngestionStore();
    await runRepeated(store, () => [...store.eventReadItems.values()]);
  });

  it("stays strictly monotonic across three repeated timestamps in Dynamo", async () => {
    const gateway = new ContractGateway();
    await runRepeated(new DynamoEventIngestionStore(gateway), () => [
      ...gateway.items.values(),
    ]);
  });
});

contract("memory", () => new MemoryEventIngestionStore());
contract("dynamo", () => new DynamoEventIngestionStore(new ContractGateway()));

const reconciliationInput = (providerEventId: string) => {
  const candidate = {
    ...bootstrap,
    id: `canonical-${providerEventId}` as EntityId,
    canonicalKey: providerEventId,
    normalizedIdentity: `identity-${providerEventId}`,
    revision: {
      ...bootstrap.revision,
      providerId: "sharpapi",
      token: providerEventId,
    },
  };
  return {
    bootstrap: candidate,
    event: {
      providerId: "sharpapi",
      providerEventId,
      sportKey: candidate.sportKey,
      leagueKey: candidate.leagueKey,
      normalizedIdentity: candidate.normalizedIdentity,
      startsAt: candidate.startsAt,
      status: candidate.status,
      participantLabels: candidate.participantLabels,
      revision: candidate.revision,
      observedAt,
    },
  };
};

describe("dynamo reconciliation ownership fencing", () => {
  it("classifies acquisition service failures without exposing their detail", async () => {
    class AcquisitionFailureGateway extends ContractGateway {
      override insert() {
        const error = new Error("sensitive-acquisition-detail");
        error.name = "ValidationException";
        return Promise.reject(error);
      }
    }
    const failure: unknown = await new DynamoEventIngestionStore(
      new AcquisitionFailureGateway(),
    )
      .reconcileScheduledEvent(reconciliationInput("acquisition-failure"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "event-reconciliation-acquisition-storage-validation",
    );
    expect((failure as Error).cause).toMatchObject({
      message: "sensitive-acquisition-detail",
    });
  });

  it("classifies execution service failures without exposing their detail", async () => {
    class ExecutionFailureGateway extends ContractGateway {
      override queryAll() {
        return Promise.reject(new Error("sensitive-execution-detail"));
      }
    }
    const failure: unknown = await new DynamoEventIngestionStore(
      new ExecutionFailureGateway(),
    )
      .reconcileScheduledEvent(reconciliationInput("execution-failure"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "event-reconciliation-execution-failed",
    );
    expect((failure as Error).cause).toMatchObject({
      message: "sensitive-execution-detail",
    });
  });

  it.each([new DynamoConditionalConflict(), new DynamoTransactionConflict()])(
    "preserves bounded reconciliation conflict diagnostics",
    async (conflict) => {
      class ConflictGateway extends ContractGateway {
        override queryAll() {
          return Promise.reject(conflict);
        }
      }
      const failure: unknown = await new DynamoEventIngestionStore(
        new ConflictGateway(),
      )
        .reconcileScheduledEvent(reconciliationInput("execution-conflict"))
        .catch((error: unknown) => error);
      expect(failure).toBe(conflict);
    },
  );

  it("preserves closed reconciliation integrity diagnostics", async () => {
    const conflict = new Error("near-canonical-projection-stale");
    class IntegrityFailureGateway extends ContractGateway {
      override queryAll() {
        return Promise.reject(conflict);
      }
    }
    const failure: unknown = await new DynamoEventIngestionStore(
      new IntegrityFailureGateway(),
    )
      .reconcileScheduledEvent(reconciliationInput("integrity-failure"))
      .catch((error: unknown) => error);
    expect(failure).toBe(conflict);
  });

  it("serializes bootstrap writes with heartbeat renewal for the same lease", async () => {
    class SerializedGateway extends ContractGateway {
      activeLockTransactions = 0;
      overlap = false;
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        const lockRelated = writes.some(
          ({ kind }) =>
            kind === "check-reconciliation-lock" ||
            kind === "renew-reconciliation-lock",
        );
        if (lockRelated) {
          this.activeLockTransactions += 1;
          this.overlap ||= this.activeLockTransactions > 1;
          await new Promise((resolve) => setTimeout(resolve, 12));
        }
        try {
          return await super.transact(writes);
        } finally {
          if (lockRelated) this.activeLockTransactions -= 1;
        }
      }
    }
    const gateway = new SerializedGateway();
    const store = new DynamoEventIngestionStore(gateway, {
      leaseMs: 100,
      heartbeatMs: 5,
    });
    const result = await store.reconcileScheduledEvent(
      reconciliationInput("serialized"),
    );
    expect(typeof result.kind).toBe("string");
    expect(gateway.overlap).toBe(false);
  });

  it("retries transient renewal transaction conflicts without losing ownership", async () => {
    class ConflictingRenewalGateway extends ContractGateway {
      renewalAttempts = 0;
      override async queryAll(pk: string) {
        await new Promise((resolve) => setTimeout(resolve, 45));
        return super.queryAll(pk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        if (writes.some(({ kind }) => kind === "renew-reconciliation-lock")) {
          this.renewalAttempts += 1;
          if (this.renewalAttempts <= 2) throw new DynamoTransactionConflict();
        }
        return super.transact(writes);
      }
    }
    const gateway = new ConflictingRenewalGateway();
    const store = new DynamoEventIngestionStore(gateway, {
      leaseMs: 100,
      heartbeatMs: 5,
    });
    const result = await store.reconcileScheduledEvent(
      reconciliationInput("renewal-conflict"),
    );
    expect(typeof result.kind).toBe("string");
    expect(gateway.renewalAttempts).toBeGreaterThan(2);
  });

  it("retries transient fenced-write transaction conflicts under the same lease", async () => {
    class ConflictingWriteGateway extends ContractGateway {
      writeAttempts = 0;
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        if (
          writes.some(({ kind }) => kind === "check-reconciliation-lock") &&
          !writes.some(({ kind }) => kind === "renew-reconciliation-lock")
        ) {
          this.writeAttempts += 1;
          if (this.writeAttempts <= 2) throw new DynamoTransactionConflict();
        }
        return super.transact(writes);
      }
    }
    const gateway = new ConflictingWriteGateway();
    const result = await new DynamoEventIngestionStore(gateway, {
      leaseMs: 1_000,
      heartbeatMs: 100,
    }).reconcileScheduledEvent(reconciliationInput("write-conflict"));
    expect(typeof result.kind).toBe("string");
    expect(gateway.writeAttempts).toBeGreaterThan(2);
  });

  it("renews a still-owned lease before a fenced write after half its duration", async () => {
    let now = Date.parse("2026-08-04T12:00:00.000Z");
    class HalfLeaseGateway extends ContractGateway {
      renewals = 0;
      advanced = false;
      override async get(pk: string, sk: string) {
        if (!this.advanced && pk.startsWith("MAPPING#")) {
          this.advanced = true;
          now += 60;
        }
        return super.get(pk, sk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        this.renewals += writes.filter(
          ({ kind }) => kind === "renew-reconciliation-lock",
        ).length;
        return super.transact(writes);
      }
    }
    const gateway = new HalfLeaseGateway();
    const outcome = await new DynamoEventIngestionStore(gateway, {
      clock: () => new Date(now),
      leaseMs: 100,
      heartbeatMs: 90,
    }).reconcileScheduledEvent(reconciliationInput("half-lease-renewal"));
    expect(typeof outcome.kind).toBe("string");
    expect(gateway.renewals).toBeGreaterThan(0);
  });

  it("does not renew or resurrect a lease after its deadline", async () => {
    class ExpiringRenewalGateway extends ContractGateway {
      renewalAttempts = 0;
      override async queryAll(pk: string) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return super.queryAll(pk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        if (writes.some(({ kind }) => kind === "renew-reconciliation-lock")) {
          this.renewalAttempts += 1;
          throw new DynamoTransactionConflict();
        }
        return super.transact(writes);
      }
    }
    const gateway = new ExpiringRenewalGateway();
    const store = new DynamoEventIngestionStore(gateway, {
      leaseMs: 20,
      heartbeatMs: 5,
    });
    await expect(
      store.reconcileScheduledEvent(reconciliationInput("expired-renewal")),
    ).rejects.toThrow("event-reconciliation-ownership-lost");
    expect(gateway.renewalAttempts).toBeLessThanOrEqual(3);
  });

  it("rejects a renewal response that arrives after the prior lease expired", async () => {
    class LateRenewalGateway extends ContractGateway {
      override async queryAll(pk: string) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return super.queryAll(pk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        if (writes.some(({ kind }) => kind === "renew-reconciliation-lock"))
          await new Promise((resolve) => setTimeout(resolve, 25));
        return super.transact(writes);
      }
    }
    const store = new DynamoEventIngestionStore(new LateRenewalGateway(), {
      leaseMs: 20,
      heartbeatMs: 5,
    });
    await expect(
      store.reconcileScheduledEvent(reconciliationInput("late-renewal")),
    ).rejects.toThrow("event-reconciliation-ownership-lost");
  });

  it("stops queued renewals after a terminal renewal failure", async () => {
    class FailedRenewalGateway extends ContractGateway {
      renewalAttempts = 0;
      override async queryAll(pk: string) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return super.queryAll(pk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        if (writes.some(({ kind }) => kind === "renew-reconciliation-lock")) {
          this.renewalAttempts += 1;
          throw new Error("renewal-service-failure");
        }
        return super.transact(writes);
      }
    }
    const gateway = new FailedRenewalGateway();
    const store = new DynamoEventIngestionStore(gateway, {
      leaseMs: 100,
      heartbeatMs: 5,
    });
    await expect(
      store.reconcileScheduledEvent(reconciliationInput("renewal-failure")),
    ).rejects.toThrow("event-reconciliation-renewal-failed");
    expect(gateway.renewalAttempts).toBe(1);
  });

  it("renews a lease during a long-running candidate read", async () => {
    class SlowGateway extends ContractGateway {
      renewals = 0;
      override async queryAll(pk: string) {
        await new Promise((resolve) => setTimeout(resolve, 45));
        return super.queryAll(pk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        this.renewals += writes.filter(
          ({ kind }) => kind === "renew-reconciliation-lock",
        ).length;
        return super.transact(writes);
      }
    }
    const gateway = new SlowGateway();
    const store = new DynamoEventIngestionStore(gateway, {
      leaseMs: 30,
      heartbeatMs: 5,
    });
    const outcome = await store.reconcileScheduledEvent(
      reconciliationInput("slow-source"),
    );
    expect(["updated", "skipped"]).toContain(outcome.kind);
    expect(gateway.renewals).toBeGreaterThan(0);
  });

  it("rejects the final write after lease takeover", async () => {
    class TakeoverGateway extends ContractGateway {
      override async queryAll(pk: string) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return super.queryAll(pk);
      }
      override async transact(
        writes: Parameters<DynamoGateway["transact"]>[0],
      ) {
        if (
          writes.some(
            (write) =>
              write.kind === "delete" &&
              write.pk.startsWith("EVENT_RECONCILIATION#"),
          )
        )
          throw new DynamoConditionalConflict();
        if (writes.some(({ kind }) => kind === "renew-reconciliation-lock")) {
          const lock = [...this.items.values()].find((item) =>
            item.pk.startsWith("EVENT_RECONCILIATION#"),
          );
          if (lock) {
            this.items.set(this.key(lock.pk, lock.sk), {
              ...lock,
              value: {
                ...(lock.value as object),
                eventId: "takeover-token",
              },
            });
            throw new DynamoConditionalConflict();
          }
        }
        return super.transact(writes);
      }
    }
    const store = new DynamoEventIngestionStore(new TakeoverGateway(), {
      leaseMs: 20,
      heartbeatMs: 5,
    });
    await expect(
      store.reconcileScheduledEvent(reconciliationInput("taken-over")),
    ).rejects.toThrow("event-reconciliation-ownership-lost");
  });

  it("surfaces token loss during cleanup", async () => {
    class CleanupConflictGateway extends ContractGateway {
      override async deleteOwnedReconciliationLock(
        pk: string,
        expectedEventId: string,
        expectedLeaseUntil?: string,
      ) {
        if (pk.startsWith("EVENT_RECONCILIATION#")) {
          const lock = this.items.get(this.key(pk, "CURRENT"));
          if (lock) {
            this.items.set(this.key(pk, "CURRENT"), {
              ...lock,
              value: { ...(lock.value as object), eventId: "new-owner" },
            });
            throw new DynamoConditionalConflict();
          }
        }
        return super.deleteOwnedReconciliationLock(
          pk,
          expectedEventId,
          expectedLeaseUntil,
        );
      }
    }
    const store = new DynamoEventIngestionStore(new CleanupConflictGateway());
    await expect(
      store.reconcileScheduledEvent(reconciliationInput("cleanup-conflict")),
    ).rejects.toThrow("event-reconciliation-ownership-lost");
  });

  it("retries transient transaction conflicts while releasing the lease", async () => {
    class CleanupRetryGateway extends ContractGateway {
      cleanupAttempts = 0;
      override async deleteOwnedReconciliationLock(
        pk: string,
        expectedEventId: string,
        expectedLeaseUntil?: string,
      ) {
        if (pk.startsWith("EVENT_RECONCILIATION#")) {
          this.cleanupAttempts += 1;
          if (this.cleanupAttempts <= 2) throw new DynamoTransactionConflict();
        }
        return super.deleteOwnedReconciliationLock(
          pk,
          expectedEventId,
          expectedLeaseUntil,
        );
      }
    }
    const gateway = new CleanupRetryGateway();
    const outcome = await new DynamoEventIngestionStore(
      gateway,
    ).reconcileScheduledEvent(reconciliationInput("cleanup-retry"));
    expect(typeof outcome.kind).toBe("string");
    expect(gateway.cleanupAttempts).toBe(3);
  });

  it("preserves non-ownership failures while releasing the lease", async () => {
    class CleanupServiceFailureGateway extends ContractGateway {
      override async deleteOwnedReconciliationLock(
        pk: string,
        expectedEventId: string,
        expectedLeaseUntil?: string,
      ) {
        if (pk.startsWith("EVENT_RECONCILIATION#"))
          return Promise.reject(new Error("cleanup-service-failure"));
        return super.deleteOwnedReconciliationLock(
          pk,
          expectedEventId,
          expectedLeaseUntil,
        );
      }
    }
    await expect(
      new DynamoEventIngestionStore(
        new CleanupServiceFailureGateway(),
      ).reconcileScheduledEvent(reconciliationInput("cleanup-service")),
    ).rejects.toThrow("event-reconciliation-cleanup-failed");
  });
});

describe("dynamo identity-claim reads", () => {
  it("repairs an equal bootstrap replay through a versioned tombstone replace", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const ownerPk = `IDENTITY_OWNER#${stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    )}`;
    gateway.items.set(gateway.key(ownerPk, "CURRENT"), {
      pk: ownerPk,
      sk: "CURRENT",
      value: {
        candidateEventIds: [],
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        conflictCount: 0,
        overflow: false,
        version: 2,
      },
    });
    await expect(
      store.bootstrapCanonicalEvent(bootstrap, observedAt),
    ).resolves.toBe("repaired");
    expect(gateway.items.get(gateway.key(ownerPk, "CURRENT"))?.value).toEqual({
      candidateEventIds: [bootstrap.id],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 1,
      overflow: false,
      version: 3,
    });
  });

  it("preserves bootstrap operational failures", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    gateway.transact = async () => {
      await Promise.resolve();
      throw new Error("network-unavailable");
    };
    await expect(
      store.bootstrapCanonicalEvent(bootstrap, observedAt),
    ).rejects.toThrow("network-unavailable");
  });

  it("is read-only and rejects malformed or dangling claims", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    const ownerPk = `IDENTITY_OWNER#${stableDigest(
      JSON.stringify([bootstrap.sportKey, bootstrap.leagueKey, "legacy"]),
    )}`;
    gateway.items.set(gateway.key(ownerPk, "CURRENT"), {
      pk: ownerPk,
      sk: "CURRENT",
      value: {
        candidateEventIds: ["missing"],
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: "legacy",
        conflictCount: 1,
        overflow: false,
        version: 1,
      },
    });
    const before = gateway.items.size;
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        "legacy",
      ),
    ).rejects.toThrow("dangling-identity-aggregate");
    expect(gateway.items.size).toBe(before);
    gateway.items.set(gateway.key(ownerPk, "CURRENT"), {
      pk: ownerPk,
      sk: "CURRENT",
      value: {
        candidateEventIds: ["missing"],
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: "legacy",
        conflictCount: 1,
        overflow: false,
        version: 1,
        unexpected: true,
      },
    });
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        "legacy",
      ),
    ).rejects.toThrow("invalid-identity-claim");
    gateway.items.delete(gateway.key(ownerPk, "CURRENT"));
    gateway.items.set(
      gateway.key(
        `IDENTITY#${stableDigest(
          JSON.stringify([bootstrap.sportKey, bootstrap.leagueKey, "legacy"]),
        )}`,
        "EVENT#legacy",
      ),
      {
        pk: `IDENTITY#${stableDigest(
          JSON.stringify([bootstrap.sportKey, bootstrap.leagueKey, "legacy"]),
        )}`,
        sk: "EVENT#legacy",
        value: "legacy",
      },
    );
    const legacySize = gateway.items.size;
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        "legacy",
      ),
    ).resolves.toBe("missing");
    expect(gateway.items.size).toBe(legacySize);
  });

  it("ignores an ownerless obsolete identity row", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const ownerPk = `IDENTITY_OWNER#${stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    )}`;
    gateway.items.delete(gateway.key(ownerPk, "CURRENT"));
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ),
    ).resolves.toBe("missing");
    expect(gateway.items.has(gateway.key(ownerPk, "CURRENT"))).toBe(false);
    await expect(
      store.ingestEvent({
        providerId: "provider",
        providerEventId: "legacy-link",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "legacy-link",
        },
        observedAt,
      }),
    ).resolves.toMatchObject({ kind: "unresolved" });
    expect(gateway.items.has(gateway.key(ownerPk, "CURRENT"))).toBe(false);
  });

  it("classifies contradictory owner/index state as ambiguous everywhere", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const identityDigest = stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    );
    const original = gateway.items.get(
      gateway.key(`EVENT#${bootstrap.id}`, "CURRENT"),
    )!;
    gateway.items.set(gateway.key("EVENT#contradiction", "CURRENT"), {
      pk: "EVENT#contradiction",
      sk: "CURRENT",
      value: { ...(original.value as object), id: "contradiction" },
    });
    gateway.items.set(
      gateway.key(`IDENTITY#${identityDigest}`, "EVENT#contradiction"),
      {
        pk: `IDENTITY#${identityDigest}`,
        sk: "EVENT#contradiction",
        value: "contradiction",
      },
    );
    const aggregateKey = gateway.key(
      `IDENTITY_OWNER#${identityDigest}`,
      "CURRENT",
    );
    const aggregate = gateway.items.get(aggregateKey)!;
    gateway.items.set(aggregateKey, {
      ...aggregate,
      value: {
        ...(aggregate.value as object),
        candidateEventIds: [bootstrap.id, "contradiction"],
        conflictCount: 2,
        overflow: false,
        version: 2,
      },
    });
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ),
    ).resolves.toBe("ambiguous");
    await expect(
      store.bootstrapCanonicalEvent(bootstrap, observedAt),
    ).rejects.toThrow("bootstrap-identity-already-exists");
    await expect(
      store.ingestEvent({
        providerId: "provider",
        providerEventId: "ambiguous",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        revision: {
          providerId: "provider",
          authorityRank: 1,
          updatedAt: observedAt,
          sequence: 1,
          token: "ambiguous",
        },
        observedAt,
      }),
    ).resolves.toMatchObject({
      kind: "unresolved",
      reason: "ambiguous-candidates",
    });
  });

  it("ignores obsolete identity rows when the aggregate is valid", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const digest = stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    );
    const original = gateway.items.get(
      gateway.key(`EVENT#${bootstrap.id}`, "CURRENT"),
    )!;
    gateway.items.set(gateway.key("EVENT#other", "CURRENT"), {
      pk: "EVENT#other",
      sk: "CURRENT",
      value: { ...(original.value as object), id: "other" },
    });
    gateway.items.delete(
      gateway.key(`IDENTITY#${digest}`, `EVENT#${bootstrap.id}`),
    );
    gateway.items.set(gateway.key(`IDENTITY#${digest}`, "EVENT#other"), {
      pk: `IDENTITY#${digest}`,
      sk: "EVENT#other",
      value: "other",
    });
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ),
    ).resolves.toBe("present");
    await expect(
      store.bootstrapCanonicalEvent(bootstrap, observedAt),
    ).resolves.toBe("existing");
    await expect(
      store.ingestEvent({
        providerId: "provider",
        providerEventId: "corrupt",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        revision: {
          providerId: "provider",
          authorityRank: 1,
          updatedAt: observedAt,
          sequence: 1,
          token: "corrupt",
        },
        observedAt,
      }),
    ).resolves.toMatchObject({ eventId: bootstrap.id });
  });

  it("fences a transfer interleaved after identity resolution", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const originalTransact = gateway.transact.bind(gateway);
    let interleaved = false;
    gateway.transact = async (writes) => {
      if (
        !interleaved &&
        writes.some((write) => write.kind === "check-identity")
      ) {
        interleaved = true;
        const check = writes.find((write) => write.kind === "check-identity");
        if (check?.kind === "check-identity") {
          const key = gateway.key(check.pk, check.sk);
          const item = gateway.items.get(key)!;
          gateway.items.set(key, {
            ...item,
            value: {
              ...(item.value as object),
              version: check.expectedVersion + 1,
            },
          });
        }
      }
      return originalTransact(writes);
    };
    const input = {
      providerId: "provider",
      providerEventId: "snapshot-race",
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      startsAt: bootstrap.startsAt,
      status: bootstrap.status,
      revision: {
        providerId: "provider",
        authorityRank: 101,
        updatedAt: observedAt,
        sequence: 1,
        token: "snapshot-race",
      },
      observedAt,
    } as const;
    await expect(store.ingestEvent(input)).rejects.toThrow(
      "identity-snapshot-moved",
    );
    await expect(store.getExactMapping(input)).resolves.toBeNull();
  });

  it("atomically fences canonical proof used for legacy fingerprint backfill", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const input = {
      providerId: "bootstrap",
      providerEventId: "legacy-fingerprint",
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      startsAt: bootstrap.startsAt,
      status: bootstrap.status,
      revision: bootstrap.revision,
      observedAt,
    } as const;
    await expect(store.ingestEvent(input)).resolves.toMatchObject({
      kind: "skipped",
      eventId: bootstrap.id,
    });
    const revisionKey = gateway.key(
      `EVENT#${bootstrap.id}`,
      `PROVIDER_REVISION#${stableDigest("bootstrap")}`,
    );
    gateway.items.set(revisionKey, {
      pk: `EVENT#${bootstrap.id}`,
      sk: `PROVIDER_REVISION#${stableDigest("bootstrap")}`,
      value: { ...bootstrap.revision, version: 1 },
    });
    const originalTransact = gateway.transact.bind(gateway);
    let interleaved = false;
    gateway.transact = async (writes) => {
      if (
        !interleaved &&
        writes.some(
          (write) =>
            write.kind === "replace" &&
            write.item.sk.startsWith("PROVIDER_REVISION#"),
        )
      ) {
        interleaved = true;
        const canonicalKey = gateway.key(`EVENT#${bootstrap.id}`, "CURRENT");
        const canonical = gateway.items.get(canonicalKey)!;
        gateway.items.set(canonicalKey, {
          ...canonical,
          value: {
            ...(canonical.value as object),
            status: "in_progress",
          },
        });
      }
      return originalTransact(writes);
    };
    await expect(store.ingestEvent(input)).rejects.toThrow("candidate-moved");
    expect(gateway.items.get(revisionKey)?.value).toEqual({
      ...bootstrap.revision,
      version: 1,
    });
  });

  it("backfills only when legacy row, input, and canonical proof share one revision", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const input = {
      providerId: "bootstrap",
      providerEventId: "legacy-revision-match",
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      startsAt: bootstrap.startsAt,
      status: bootstrap.status,
      revision: bootstrap.revision,
      observedAt,
    } as const;
    await store.ingestEvent(input);
    const revisionKey = gateway.key(
      `EVENT#${bootstrap.id}`,
      `PROVIDER_REVISION#${stableDigest("bootstrap")}`,
    );
    const legacy = (revision: typeof bootstrap.revision) => ({
      pk: `EVENT#${bootstrap.id}`,
      sk: `PROVIDER_REVISION#${stableDigest("bootstrap")}`,
      value: { ...revision, version: 1 },
    });
    gateway.items.set(revisionKey, legacy(bootstrap.revision));
    await expect(store.ingestEvent(input)).resolves.toMatchObject({
      kind: "skipped",
    });
    expect(gateway.items.get(revisionKey)?.value).toHaveProperty(
      "materialFingerprint",
    );

    const revision2 = { ...bootstrap.revision, sequence: 2, token: "r2" };
    const revision3 = { ...bootstrap.revision, sequence: 3, token: "r3" };
    const canonicalKey = gateway.key(`EVENT#${bootstrap.id}`, "CURRENT");
    const setCanonicalRevision = (revision: typeof bootstrap.revision) => {
      const item = gateway.items.get(canonicalKey)!;
      gateway.items.set(canonicalKey, {
        ...item,
        value: {
          ...(item.value as object),
          bootstrapRevision: revision,
          authoritativeRevision: revision,
        },
      });
    };
    const higherRank = { ...bootstrap.revision, authorityRank: 101 };
    gateway.items.set(revisionKey, legacy(bootstrap.revision));
    setCanonicalRevision(higherRank);
    await store.ingestEvent({ ...input, revision: higherRank });
    expect(gateway.items.get(revisionKey)?.value).toEqual({
      ...bootstrap.revision,
      version: 1,
    });

    gateway.items.set(revisionKey, legacy(higherRank));
    setCanonicalRevision(bootstrap.revision);
    await store.ingestEvent(input);
    expect(gateway.items.get(revisionKey)?.value).toEqual({
      ...higherRank,
      version: 1,
    });

    gateway.items.set(revisionKey, legacy(bootstrap.revision));
    setCanonicalRevision(revision2);
    await store.ingestEvent({ ...input, revision: revision2 });
    expect(gateway.items.get(revisionKey)?.value).toEqual({
      ...bootstrap.revision,
      version: 1,
    });

    gateway.items.set(revisionKey, legacy(revision2));
    setCanonicalRevision(revision3);
    await store.ingestEvent(input);
    expect(gateway.items.get(revisionKey)?.value).toEqual({
      ...revision2,
      version: 1,
    });
  });

  it("retries when an identity aggregate changes during a read", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const aggregatePk = `IDENTITY_OWNER#${stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    )}`;
    const originalGet = gateway.get.bind(gateway);
    let aggregateReads = 0;
    gateway.get = async (pk, sk) => {
      if (pk === aggregatePk && sk === "CURRENT" && ++aggregateReads === 2) {
        const key = gateway.key(pk, sk);
        const item = gateway.items.get(key)!;
        gateway.items.set(key, {
          ...item,
          value: { ...(item.value as object), version: 2 },
        });
      }
      return originalGet(pk, sk);
    };
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ),
    ).resolves.toBe("present");
    expect(aggregateReads).toBe(4);
  });

  it("fences an unresolved write when a unique aggregate appears", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    const originalTransact = gateway.transact.bind(gateway);
    let interleaved = false;
    gateway.transact = async (writes) => {
      const absence = writes.find(
        (write) => write.kind === "check-identity-absent",
      );
      if (!interleaved && absence?.kind === "check-identity-absent") {
        interleaved = true;
        gateway.items.set(gateway.key(absence.pk, absence.sk), {
          pk: absence.pk,
          sk: absence.sk,
          value: {
            candidateEventIds: [bootstrap.id],
            sportKey: bootstrap.sportKey,
            leagueKey: bootstrap.leagueKey,
            normalizedIdentity: bootstrap.normalizedIdentity,
            conflictCount: 1,
            overflow: false,
            version: 1,
          },
        });
      }
      return originalTransact(writes);
    };
    await expect(
      store.ingestEvent({
        providerId: "provider",
        providerEventId: "unresolved-race",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        revision: {
          providerId: "provider",
          authorityRank: 1,
          updatedAt: observedAt,
          sequence: 1,
          token: "unresolved-race",
        },
        observedAt,
      }),
    ).rejects.toThrow("identity-snapshot-created");
  });
});

describe("memory identity aggregate", () => {
  it("requires full revision equality for legacy fingerprint backfill", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const input = {
      providerId: "bootstrap",
      providerEventId: "memory-legacy-revision",
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      startsAt: bootstrap.startsAt,
      status: bootstrap.status,
      revision: bootstrap.revision,
      observedAt,
    } as const;
    await store.ingestEvent(input);
    const revisionKey = stableDigest(
      JSON.stringify([bootstrap.id, "bootstrap"]),
    );
    const setCanonicalRevision = (revision: typeof bootstrap.revision) => {
      const current = store.events.get(bootstrap.id)!;
      store.events.set(bootstrap.id, {
        ...current,
        bootstrapRevision: revision,
        authoritativeRevision: revision,
      });
    };
    store.providerRevisions.set(revisionKey, bootstrap.revision);
    await store.ingestEvent(input);
    expect(store.providerRevisions.get(revisionKey)).toHaveProperty(
      "materialFingerprint",
    );

    const higherRank = { ...bootstrap.revision, authorityRank: 101 };
    store.providerRevisions.set(revisionKey, bootstrap.revision);
    setCanonicalRevision(higherRank);
    await store.ingestEvent({ ...input, revision: higherRank });
    expect(store.providerRevisions.get(revisionKey)).toEqual(
      bootstrap.revision,
    );

    store.providerRevisions.set(revisionKey, higherRank);
    setCanonicalRevision(bootstrap.revision);
    await store.ingestEvent(input);
    expect(store.providerRevisions.get(revisionKey)).toEqual(higherRank);
  });

  it("repairs an equal bootstrap replay through a monotonic tombstone", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const key = stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    );
    store.identityAggregates.set(key, {
      candidateEventIds: [],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 0,
      overflow: false,
      version: 2,
    });
    await expect(
      store.bootstrapCanonicalEvent(bootstrap, observedAt),
    ).resolves.toBe("repaired");
    expect(store.identityAggregates.get(key)).toEqual({
      candidateEventIds: [bootstrap.id],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 1,
      overflow: false,
      version: 3,
    });
  });

  it("persists bounded overflow for a third candidate and stays idempotent", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const first = store.events.get(bootstrap.id);
    if (!first) throw new Error("missing-bootstrap-event");
    const second = { ...first, id: "candidate-b" as typeof first.id };
    const third = { ...first, id: "candidate-c" as typeof first.id };
    await expect(store.registerCandidate(second)).resolves.toBe("registered");
    const key = stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    );
    await expect(store.registerCandidate(third)).resolves.toBe("registered");
    expect(store.events.has(third.id)).toBe(false);
    expect(store.identityAggregates.get(key)).toMatchObject({
      candidateEventIds: [bootstrap.id, second.id].sort(),
      conflictCount: 3,
      overflow: true,
    });
    const version = store.identityAggregates.get(key)?.version;
    await expect(store.registerCandidate(third)).resolves.toBe(
      "already-registered",
    );
    expect(store.identityAggregates.get(key)?.version).toBe(version);
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ),
    ).resolves.toBe("ambiguous");
  });

  it("rejects candidate material conflicts and exhausted identity versions", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const canonical = store.events.get(bootstrap.id);
    if (!canonical) throw new Error("missing-bootstrap-event");
    await expect(
      store.registerCandidate({
        ...canonical,
        candidateIdentity: `${canonical.candidateIdentity}:different`,
      }),
    ).rejects.toThrow("canonical-candidate-conflict");
    const key = stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    );
    store.identityAggregates.set(key, {
      candidateEventIds: [],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 0,
      overflow: false,
      version: Number.MAX_SAFE_INTEGER,
    });
    const before = new Map(store.events);
    await expect(store.registerCandidate(canonical)).rejects.toThrow(
      "identity-version-exhausted",
    );
    expect(store.events).toEqual(before);
    expect(store.identityAggregates.get(key)?.version).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("treats a durable aggregate tombstone as unresolved", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const key = stableDigest(
      JSON.stringify([
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ]),
    );
    const initialVersion = store.identityAggregates.get(key)?.version;
    store.identityAggregates.set(key, {
      candidateEventIds: [],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 0,
      overflow: false,
      version: (initialVersion ?? 0) + 1,
    });
    await expect(
      store.getCanonicalByIdentity(
        bootstrap.sportKey,
        bootstrap.leagueKey,
        bootstrap.normalizedIdentity,
      ),
    ).resolves.toBe("missing");
    await expect(
      store.ingestEvent({
        providerId: "provider",
        providerEventId: "legacy-link",
        sportKey: bootstrap.sportKey,
        leagueKey: bootstrap.leagueKey,
        normalizedIdentity: bootstrap.normalizedIdentity,
        startsAt: bootstrap.startsAt,
        status: bootstrap.status,
        revision: {
          providerId: "provider",
          authorityRank: 101,
          updatedAt: observedAt,
          sequence: 1,
          token: "legacy-link",
        },
        observedAt,
      }),
    ).resolves.toMatchObject({ kind: "unresolved", reason: "no-candidate" });
    expect(store.identityAggregates.get(key)).toEqual({
      candidateEventIds: [],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 0,
      overflow: false,
      version: (initialVersion ?? 0) + 1,
    });
    const canonical = store.events.get(bootstrap.id);
    if (!canonical) throw new Error("missing-bootstrap-event");
    await expect(store.registerCandidate(canonical)).resolves.toBe(
      "registered",
    );
    expect(store.identityAggregates.get(key)).toEqual({
      candidateEventIds: [bootstrap.id],
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      conflictCount: 1,
      overflow: false,
      version: (initialVersion ?? 0) + 2,
    });
  });
});

describe("dynamo provider-event fence retention", () => {
  it("retains a fence for the one-year replay horizon", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    const windowEnd = "2026-08-01T00:00:00.000Z" as IsoTimestamp;
    const key = checkpointKey({
      providerId: "provider",
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      checkpointScope: "retention",
      windowStart: observedAt,
      windowEnd,
    });
    await store.ingestEvent({
      providerId: "provider",
      providerEventId: "retained",
      sportKey: bootstrap.sportKey,
      leagueKey: bootstrap.leagueKey,
      normalizedIdentity: bootstrap.normalizedIdentity,
      startsAt: bootstrap.startsAt,
      status: bootstrap.status,
      revision: {
        providerId: "provider",
        authorityRank: 101,
        updatedAt: observedAt,
        sequence: 1,
        token: "retained",
      },
      observedAt,
      providerEventFence: {
        checkpointKey: key,
        pagePosition: { state: "start" },
        windowEnd,
      },
    });
    const fence = [...gateway.items.values()].find((item) =>
      item.pk.startsWith("PROVIDER_EVENT_FENCE#"),
    );
    expect(fence?.expiresAt).toBe(
      Math.floor(Date.parse(windowEnd) / 1000) + 31_536_000,
    );
  });
});

describe("continuation pending storage invariants", () => {
  const key = checkpointKey({
    providerId: "provider",
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    checkpointScope: "scope",
    windowStart: observedAt,
    windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
  });

  it("orders a surviving rollover predecessor first in memory and blocks its successor while leased", async () => {
    const store = new MemoryEventIngestionStore();
    const predecessor = pendingOutbox(key, 7, Number.MAX_SAFE_INTEGER);
    const successor = pendingOutbox(key, 8, 1);
    for (const outbox of [successor, predecessor])
      store.continuations.set(
        continuationPendingSortKey(outbox.cycle, outbox.epoch, outbox.id),
        outbox,
      );
    await expect(
      store.claimPendingContinuation(
        "worker",
        observedAt,
        "2026-07-30T00:03:00.000Z" as IsoTimestamp,
        key,
      ),
    ).resolves.toMatchObject({
      id: predecessor.id,
      cycle: predecessor.cycle,
      epoch: predecessor.epoch,
    });
    await expect(
      store.claimPendingContinuation(
        "other",
        "2026-07-30T00:01:00.000Z" as IsoTimestamp,
        "2026-07-30T00:04:00.000Z" as IsoTimestamp,
        key,
      ),
    ).resolves.toBeNull();
  });

  it("orders a surviving rollover predecessor first in Dynamo and blocks its successor while leased", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    const predecessor = pendingOutbox(key, 7, Number.MAX_SAFE_INTEGER);
    const successor = pendingOutbox(key, 8, 1);
    for (const outbox of [successor, predecessor]) {
      const sk = continuationPendingSortKey(
        outbox.cycle,
        outbox.epoch,
        outbox.id,
      );
      gateway.items.set(gateway.key(`OUTBOX_PENDING#${key}`, sk), {
        pk: `OUTBOX_PENDING#${key}`,
        sk,
        value: outbox,
      });
    }
    await expect(
      store.claimPendingContinuation(
        "worker",
        observedAt,
        "2026-07-30T00:03:00.000Z" as IsoTimestamp,
        key,
      ),
    ).resolves.toMatchObject({
      id: predecessor.id,
      cycle: predecessor.cycle,
      epoch: predecessor.epoch,
    });
    await expect(
      store.claimPendingContinuation(
        "other",
        "2026-07-30T00:01:00.000Z" as IsoTimestamp,
        "2026-07-30T00:04:00.000Z" as IsoTimestamp,
        key,
      ),
    ).resolves.toBeNull();
  });

  it("rejects delivered rows from pending storage in both stores", async () => {
    const delivered = pendingOutbox(key, 0, 1, "delivered");
    const sk = continuationPendingSortKey(
      delivered.cycle,
      delivered.epoch,
      delivered.id,
    );
    const memory = new MemoryEventIngestionStore();
    memory.continuations.set(sk, delivered);
    await expect(memory.hasUndeliveredContinuation(key)).rejects.toThrow(
      "invalid-pending-continuation-state",
    );
    const gateway = new ContractGateway();
    gateway.items.set(gateway.key(`OUTBOX_PENDING#${key}`, sk), {
      pk: `OUTBOX_PENDING#${key}`,
      sk,
      value: delivered,
    });
    const dynamo = new DynamoEventIngestionStore(gateway);
    await expect(dynamo.hasUndeliveredContinuation(key)).rejects.toThrow(
      "invalid-pending-continuation-state",
    );
  });

  it("rejects non-delivered rows from delivered storage in both stores", async () => {
    const intent = pendingOutbox(key, 0, 1);
    const memory = new MemoryEventIngestionStore();
    memory.deliveredContinuations.set(intent.id, intent);
    await expect(
      memory.markContinuationDelivered(
        intent.id,
        key,
        intent.cycle,
        intent.epoch,
        "worker",
        observedAt,
      ),
    ).rejects.toThrow("invalid-delivered-continuation-state");
    const gateway = new ContractGateway();
    gateway.items.set(gateway.key(`OUTBOX_DELIVERED#${key}`, intent.id), {
      pk: `OUTBOX_DELIVERED#${key}`,
      sk: intent.id,
      value: intent,
    });
    await expect(
      new DynamoEventIngestionStore(gateway).markContinuationDelivered(
        intent.id,
        key,
        intent.cycle,
        intent.epoch,
        "worker",
        observedAt,
      ),
    ).rejects.toThrow("invalid-delivered-continuation-state");
  });

  it("binds predecessor run lineage to the continuation attempt digest", () => {
    const outbox = pendingOutbox(key, 3, 9);
    const forgedPredecessorRunId = stableDigest("forged-predecessor");
    const position = outbox.command.expectedContinuation!.position;
    const forged = {
      ...outbox,
      predecessorRunId: forgedPredecessorRunId,
      id: stableDigest(
        JSON.stringify([
          outbox.checkpointKey,
          outbox.cycle,
          outbox.epoch,
          position,
          outbox.command.attemptId,
          forgedPredecessorRunId,
        ]),
      ),
    };
    expect(() => validateContinuationOutbox(forged)).toThrow(
      "invalid-continuation-outbox",
    );
  });

  it("validates only the requested workflow in memory scans", async () => {
    const requested = pendingOutbox(key, 0, 1);
    const otherKey = checkpointKey({
      providerId: "provider",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      checkpointScope: "other",
      windowStart: observedAt,
      windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
    });
    const store = new MemoryEventIngestionStore();
    store.continuations.set(
      continuationPendingSortKey(
        requested.cycle,
        requested.epoch,
        requested.id,
      ),
      requested,
    );
    store.continuations.set("malformed-other-workflow", {
      checkpointKey: otherKey,
    } as ContinuationOutbox);
    await expect(store.hasUndeliveredContinuation(key)).resolves.toBe(true);
    await expect(
      store.claimPendingContinuation(
        "worker",
        observedAt,
        "2026-07-30T00:03:00.000Z" as IsoTimestamp,
        key,
      ),
    ).resolves.toMatchObject({ id: requested.id });
  });

  it("bounds continuation leases to the delivery recovery window", () => {
    expect(() =>
      validateContinuationLease(
        "worker",
        observedAt,
        "2026-07-30T00:05:00.000Z" as IsoTimestamp,
      ),
    ).not.toThrow();
    expect(() =>
      validateContinuationLease(
        "worker",
        observedAt,
        "2026-07-30T00:05:00.001Z" as IsoTimestamp,
      ),
    ).toThrow("invalid-continuation-lease");
  });

  it("rejects terminal and cursor run-status contradictions", () => {
    const outbox = pendingOutbox(key, 0, 1);
    const position = outbox.command.expectedContinuation!.position;
    const checkpoint: IngestionCheckpoint = {
      key,
      providerId: outbox.providerId,
      sportKey: outbox.command.sportKey,
      leagueKey: outbox.command.leagueKey,
      checkpointScope: outbox.command.checkpointScope,
      windowStart: outbox.command.windowStart,
      windowEnd: outbox.command.windowEnd,
      position,
      continuationCycle: outbox.cycle,
      continuationCount: outbox.epoch,
      bootstrapRequestCount: 0,
      lastRunId: outbox.predecessorRunId,
      updatedAt: observedAt,
    };
    const run = {
      id: outbox.predecessorRunId,
      attemptId: "attempt",
      providerId: outbox.providerId,
      sportKey: checkpoint.sportKey,
      leagueKey: checkpoint.leagueKey,
      startedAt: observedAt,
      finishedAt: observedAt,
      durationMs: 0,
      counters: {
        providerRequests: 1,
        pages: 1,
        bootstrapped: 0,
        repaired: 0,
        updated: 0,
        skipped: 0,
        unresolved: 0,
        quotaUsed: 1,
      },
      finalPosition: position,
      runRecordPersisted: true,
      checkpointKey: key,
    } satisfies Omit<LeagueIngestionRun, "status">;
    expect(() =>
      validateCheckpointCommitLineage(
        checkpoint,
        { ...run, status: "succeeded" },
        outbox.command,
      ),
    ).toThrow("invalid-checkpoint-run-status");
    const terminal = {
      ...checkpoint,
      position: { state: "terminal" as const },
    };
    expect(() =>
      validateCheckpointCommitLineage(terminal, {
        ...run,
        finalPosition: terminal.position,
        status: "continuation-queued",
      }),
    ).toThrow("invalid-checkpoint-run-status");
  });
});

describe("pre-existing third identity candidate transition", () => {
  const candidate = (id: string) => ({
    id: id as EntityId,
    sportKey: bootstrap.sportKey,
    leagueKey: bootstrap.leagueKey,
    leagueId: bootstrap.leagueId,
    participantIds: [...bootstrap.participantIds],
    startsAt: bootstrap.startsAt,
    phase: bootstrap.phase,
    evidence: [],
    status: bootstrap.status,
    revisions: {},
    updatedAt: observedAt,
    candidateIdentity: bootstrap.normalizedIdentity,
    bootstrapRevision: bootstrap.revision,
    version: 1,
  });

  it("sets overflow in memory when the third canonical already exists", async () => {
    const store = new MemoryEventIngestionStore();
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    await store.registerCandidate(candidate("candidate-b"));
    const third = candidate("candidate-c");
    store.events.set(third.id, third);
    await expect(store.registerCandidate(third)).resolves.toBe("registered");
    const aggregate = [...store.identityAggregates.values()][0];
    expect(aggregate).toMatchObject({
      conflictCount: 3,
      overflow: true,
    });
  });

  it("sets overflow in Dynamo when the third canonical already exists", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    await store.bootstrapCanonicalEvent(bootstrap, observedAt);
    await store.registerCandidate(candidate("candidate-b"));
    const third = candidate("candidate-c");
    gateway.items.set(gateway.key(`EVENT#${third.id}`, "CURRENT"), {
      pk: `EVENT#${third.id}`,
      sk: "CURRENT",
      value: third,
    });
    await expect(store.registerCandidate(third)).resolves.toBe("registered");
    const aggregate = [...gateway.items.values()].find((item) =>
      item.pk.startsWith("IDENTITY_OWNER#"),
    );
    expect(aggregate?.value).toMatchObject({
      conflictCount: 3,
      overflow: true,
    });
  });
});

describe("dynamo outbox claim errors", () => {
  it("recovers an uncertain checkpoint commit after its outbox was delivered", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    const recoveryKey = checkpointKey({
      providerId: "provider",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      checkpointScope: "scope",
      windowStart: observedAt,
      windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
    });
    const seed = pendingOutbox(recoveryKey, 0, 1);
    const position = seed.command.expectedContinuation!.position;
    const checkpoint: IngestionCheckpoint = {
      key: recoveryKey,
      providerId: seed.providerId,
      sportKey: seed.command.sportKey,
      leagueKey: seed.command.leagueKey,
      checkpointScope: seed.command.checkpointScope,
      windowStart: seed.command.windowStart,
      windowEnd: seed.command.windowEnd,
      position,
      continuationCycle: seed.cycle,
      continuationCount: seed.epoch,
      bootstrapRequestCount: 0,
      lastRunId: seed.predecessorRunId,
      updatedAt: observedAt,
    };
    const run: LeagueIngestionRun = {
      id: seed.predecessorRunId,
      attemptId: "attempt",
      providerId: seed.providerId,
      sportKey: checkpoint.sportKey,
      leagueKey: checkpoint.leagueKey,
      startedAt: observedAt,
      finishedAt: observedAt,
      durationMs: 0,
      status: "continuation-queued",
      counters: {
        providerRequests: 1,
        pages: 1,
        bootstrapped: 0,
        repaired: 0,
        updated: 0,
        skipped: 0,
        unresolved: 0,
        quotaUsed: 1,
      },
      finalPosition: position,
      runRecordPersisted: true,
      checkpointKey: recoveryKey,
    };
    const transactCheckpoint = gateway.transactCheckpoint.bind(gateway);
    gateway.transactCheckpoint = async (...args) => {
      await transactCheckpoint(...args);
      const id = continuationOutboxId(checkpoint, seed.command);
      const pendingSk = continuationPendingSortKey(0, 1, id);
      gateway.items.delete(
        gateway.key(`OUTBOX_PENDING#${recoveryKey}`, pendingSk),
      );
      gateway.items.set(gateway.key(`OUTBOX_DELIVERED#${recoveryKey}`, id), {
        pk: `OUTBOX_DELIVERED#${recoveryKey}`,
        sk: id,
        value: {
          ...seed,
          id,
          state: "delivered",
          claimantId: "worker",
          claimedAt: observedAt,
          leaseUntil: "2026-07-30T00:03:00.000Z",
          deliveredAt: observedAt,
          version: 3,
        },
      });
      throw new Error("response-lost");
    };
    await expect(
      store.commitCheckpoint(null, checkpoint, run, seed.command),
    ).resolves.toBe(true);
  });

  it("claims the globally oldest continuation beyond one hundred rows", async () => {
    const gateway = new ContractGateway();
    const store = new DynamoEventIngestionStore(gateway);
    const orderedCheckpointKey = checkpointKey({
      providerId: "provider",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      checkpointScope: "scope",
      windowStart: observedAt,
      windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
    });
    for (let epoch = 101; epoch >= 1; epoch--) {
      const position = {
        state: "cursor" as const,
        cursor: `offset:${epoch}`,
      };
      const predecessorRunId = stableDigest(`run:${epoch}`);
      const cycle = 0;
      const command = {
        attemptId: stableDigest(
          JSON.stringify([
            predecessorRunId,
            orderedCheckpointKey,
            cycle,
            epoch,
            position.cursor,
          ]),
        ),
        checkpointScope: "scope",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        pageLimit: 100,
        maxPages: 20,
        expectedContinuation: { cycle, epoch, position },
      };
      const checkpoint = {
        key: orderedCheckpointKey,
        providerId: "provider",
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        checkpointScope: "scope",
        windowStart: observedAt,
        windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
        position,
        continuationCycle: cycle,
        continuationCount: epoch,
        bootstrapRequestCount: 0,
        lastRunId: predecessorRunId,
        updatedAt: observedAt,
      };
      const id = continuationOutboxId(checkpoint, command);
      const sk = continuationPendingSortKey(cycle, epoch, id);
      gateway.items.set(
        gateway.key(`OUTBOX_PENDING#${orderedCheckpointKey}`, sk),
        {
          pk: `OUTBOX_PENDING#${orderedCheckpointKey}`,
          sk,
          value: {
            id,
            checkpointKey: orderedCheckpointKey,
            providerId: "provider",
            predecessorRunId,
            command,
            cycle,
            epoch,
            state: "intent",
            version: 1,
          },
        },
      );
    }
    await expect(
      store.claimPendingContinuation(
        "worker",
        observedAt,
        "2026-07-30T00:03:00.000Z" as IsoTimestamp,
        orderedCheckpointKey,
      ),
    ).resolves.toMatchObject({ epoch: 1 });
  });

  it("does not disguise real persistence failures as claim contention", async () => {
    const gateway = new ContractGateway();
    const errorCheckpointKey = checkpointKey({
      providerId: "provider",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      checkpointScope: "scope",
      windowStart: observedAt,
      windowEnd: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
    });
    const errorPosition = { state: "cursor", cursor: "next" } as const;
    const errorCycle = 0;
    const errorEpoch = 1;
    const errorPredecessorRunId = "b".repeat(64);
    const errorAttemptId = stableDigest(
      JSON.stringify([
        errorPredecessorRunId,
        errorCheckpointKey,
        errorCycle,
        errorEpoch,
        errorPosition.cursor,
      ]),
    );
    const errorOutboxId = stableDigest(
      JSON.stringify([
        errorCheckpointKey,
        errorCycle,
        errorEpoch,
        errorPosition,
        errorAttemptId,
        errorPredecessorRunId,
      ]),
    );
    gateway.items.set(
      gateway.key(
        `OUTBOX_PENDING#${errorCheckpointKey}`,
        continuationPendingSortKey(errorCycle, errorEpoch, errorOutboxId),
      ),
      {
        pk: `OUTBOX_PENDING#${errorCheckpointKey}`,
        sk: continuationPendingSortKey(errorCycle, errorEpoch, errorOutboxId),
        value: {
          id: errorOutboxId,
          checkpointKey: errorCheckpointKey,
          providerId: "provider",
          predecessorRunId: errorPredecessorRunId,
          command: {
            attemptId: errorAttemptId,
            checkpointScope: "scope",
            sportKey: "mlb",
            leagueKey: "mlb",
            windowStart: observedAt,
            windowEnd: "2026-08-01T00:00:00.000Z",
            pageLimit: 100,
            maxPages: 20,
            expectedContinuation: {
              cycle: errorCycle,
              epoch: errorEpoch,
              position: errorPosition,
            },
          },
          cycle: errorCycle,
          epoch: errorEpoch,
          state: "intent",
          version: 1,
        },
      },
    );
    gateway.transact = async () => {
      await Promise.resolve();
      throw new Error("network-failed");
    };
    const store = new DynamoEventIngestionStore(gateway);
    await expect(
      store.claimPendingContinuation(
        "worker",
        observedAt,
        "2026-07-30T00:03:00.000Z" as IsoTimestamp,
        errorCheckpointKey,
      ),
    ).rejects.toThrow("network-failed");
  });
});
