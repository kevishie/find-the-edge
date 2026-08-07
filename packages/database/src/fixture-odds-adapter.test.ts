import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
/* eslint-disable @typescript-eslint/require-await -- fake AWS clients implement the SDK async send contract */
import { describe, expect, it, vi } from "vitest";
import {
  type FixtureOddsAvailabilityEvidence,
  type IsoTimestamp,
  FixtureOddsStateCorruptionError,
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "@find-the-edge/domain";
import {
  DynamoFixtureOddsAdapter,
  AwsFixtureOddsGateway,
  FixtureOddsBindingConflictError,
  FixtureOddsStorageError,
  FixtureOddsTransactionCanceledError,
  validateFixtureOddsSnapshotItem,
  type FixtureOddsCurrentWrite,
  type FixtureOddsDynamoGateway,
  type FixtureOddsItem,
  type FixtureOddsSnapshotTransaction,
} from "./fixture-odds-adapter";
import { mappingId } from "./event-ingestion";
import { DynamoExactOddsSnapshotRepository } from "./exact-odds-snapshot-repository";
import { FixtureOddsCurrentProjector } from "./fixture-odds-projector";

const input = (observedAt = "2026-08-01T12:00:00.000Z", odds = -110) => ({
  providerId: "fixture",
  providerEventId: "mlb-1",
  leagueKey: "mlb",
  observation: {
    canonicalEventId: "event-1",
    canonicalEventVersion: 3,
    sportKey: "baseball",
    marketKey: "moneyline",
    selectionKey: "home",
    selectionLabel: "Home",
    sportsbookId: "fixture-book",
    sportsbookLabel: "Fixture Book",
    americanOdds: odds,
    observedAt,
    retrievedAt: "2026-08-01T12:01:00.000Z",
  },
});

class ConditionHarness implements FixtureOddsDynamoGateway {
  readonly items = new Map<string, FixtureOddsItem>();
  readonly transactions: FixtureOddsSnapshotTransaction[] = [];
  readonly currents: FixtureOddsCurrentWrite[] = [];
  readonly availability = new Map<string, FixtureOddsAvailabilityEvidence>();
  beforeSnapshot?: (request: FixtureOddsSnapshotTransaction) => void;
  beforeCurrent?: (request: FixtureOddsCurrentWrite) => void;
  snapshotFailure?: FixtureOddsTransactionCanceledError;
  currentFailure?: FixtureOddsTransactionCanceledError;
  getFailure?: Error;
  key(pk: string, sk: string) {
    return JSON.stringify([pk, sk]);
  }
  seed(pk: string, sk: string, value: unknown) {
    this.items.set(this.key(pk, sk), { pk, sk, value } as FixtureOddsItem);
  }
  getExact(pk: string, sk: string) {
    if (this.getFailure) throw this.getFailure;
    return Promise.resolve(this.items.get(this.key(pk, sk)) ?? null);
  }
  transactSnapshot(request: FixtureOddsSnapshotTransaction) {
    this.transactions.push(request);
    this.beforeSnapshot?.(request);
    if (this.snapshotFailure) throw this.snapshotFailure;
    const mapping = this.items.get(
      this.key(request.mapping.key.pk, request.mapping.key.sk),
    );
    const event = this.items.get(
      this.key(request.canonicalEvent.key.pk, request.canonicalEvent.key.sk),
    );
    const matches = (
      actual: FixtureOddsItem | undefined,
      expected: Readonly<Record<string, string | number>>,
    ) =>
      !!actual &&
      Object.entries(expected).every(
        ([key, value]) =>
          (actual.value as unknown as Record<string, unknown>)[key] === value,
      );
    const reasons = [
      matches(mapping, request.mapping.expected)
        ? "None"
        : "ConditionalCheckFailed",
      matches(event, request.canonicalEvent.expected)
        ? "None"
        : "ConditionalCheckFailed",
      this.items.has(this.key(request.snapshot.pk, request.snapshot.sk))
        ? "ConditionalCheckFailed"
        : "None",
    ] as const;
    if (reasons.some((code) => code !== "None"))
      throw new FixtureOddsTransactionCanceledError(
        reasons.map((code) => ({ code })),
      );
    this.items.set(
      this.key(request.snapshot.pk, request.snapshot.sk),
      request.snapshot,
    );
    return Promise.resolve();
  }
  putCurrent(request: FixtureOddsCurrentWrite) {
    this.currents.push(request);
    this.beforeCurrent?.(request);
    if (this.currentFailure) throw this.currentFailure;
    const key = this.key(request.item.pk, request.item.sk);
    const existing = this.items.get(key)?.value;
    if (existing) {
      const old = existing;
      const wins =
        old.observedAt < request.advanceAfter.observedAt ||
        (old.observedAt === request.advanceAfter.observedAt &&
          old.snapshotId < request.advanceAfter.snapshotId);
      if (!wins)
        throw new FixtureOddsTransactionCanceledError([
          { code: "ConditionalCheckFailed" },
        ]);
    }
    this.items.set(key, request.item);
    return Promise.resolve();
  }
  getAvailability(partitionKey: string) {
    return Promise.resolve(this.availability.get(partitionKey) ?? null);
  }
  putAvailability(value: FixtureOddsAvailabilityEvidence) {
    this.availability.set(value.identity, value);
    return Promise.resolve();
  }
}

function boundHarness() {
  const gateway = new ConditionHarness();
  const value = input();
  const mid = mappingId({
    ...value,
    sportKey: value.observation.sportKey as never,
  });
  gateway.seed(`MAPPING#${mid}`, "CURRENT", {
    id: mid,
    providerId: value.providerId,
    providerEventId: value.providerEventId,
    canonicalEventId: "event-1",
    sportKey: "baseball",
    leagueKey: "mlb",
  });
  gateway.seed("EVENT#event-1", "CURRENT", {
    id: "event-1",
    version: 3,
    sportKey: "baseball",
    leagueKey: "mlb",
  });
  return gateway;
}

describe("DynamoFixtureOddsAdapter", () => {
  it("makes equal-time blocking availability win concurrent Dynamo writes", async () => {
    let row: Record<string, unknown> | undefined;
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        if (command.constructor.name === "GetCommand") return { Item: row };
        const item = command.input["Item"] as Record<string, unknown>;
        const incoming = item["availabilityPriority"] as number;
        const current = row?.["availabilityPriority"] as number | undefined;
        if (current !== undefined && current > incoming) {
          const error = new Error("conditional");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        row = structuredClone(item);
        return {};
      },
    };
    const gateway = new AwsFixtureOddsGateway(
      client as unknown as DynamoDBDocumentClient,
      "table",
    );
    const common = {
      identity: "selection",
      observedAt: "2026-08-04T12:00:00.000Z" as IsoTimestamp,
      reason: "race",
    };
    await Promise.allSettled([
      gateway.putAvailability({
        ...common,
        state: "suspended",
        evidenceId: "a-blocking",
      }),
      gateway.putAvailability({
        ...common,
        state: "active",
        evidenceId: "z-active",
      }),
    ]);
    expect(await gateway.getAvailability("selection")).toMatchObject({
      state: "suspended",
    });
  });

  it("keeps blocked prices historical and restores actionable current only with newer active evidence", async () => {
    const gateway = boundHarness();
    const adapter = new DynamoFixtureOddsAdapter(gateway);
    const persisted = await adapter.persist(input());
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(persisted.value);
    await adapter.persistAvailability({
      identity: groupIdentity,
      state: "active",
      observedAt: persisted.value.observedAt,
      evidenceId: "group-active-1",
      reason: "complete-market",
    });
    expect(
      await adapter.getActionableCurrent(persisted.value.partitionKey),
    ).not.toBeNull();
    await adapter.persistAvailability({
      identity: persisted.value.partitionKey,
      state: "suspended",
      observedAt: "2026-08-01T12:02:00.000Z",
      evidenceId: "suspended-1",
      reason: "suspended",
    });
    expect(
      await adapter.getActionableCurrent(persisted.value.partitionKey),
    ).toBeNull();
    await adapter.persist(input("2026-08-01T12:03:00.000Z", -105));
    await adapter.persistAvailability({
      identity: groupIdentity,
      state: "active",
      observedAt: "2026-08-01T12:03:00.000Z",
      evidenceId: "group-active-2",
      reason: "complete-market",
    });
    expect(
      await adapter.getActionableCurrent(persisted.value.partitionKey),
    ).toMatchObject({
      americanOdds: -105,
    });
  });
  it("rejects post-start evidence and fences the canonical status/start", async () => {
    const gateway = boundHarness();
    gateway.seed("EVENT#event-1", "CURRENT", {
      id: "event-1",
      version: 3,
      sportKey: "baseball",
      leagueKey: "mlb",
      status: "scheduled",
      startsAt: "2026-08-01T13:00:00.000Z",
    });
    const adapter = new DynamoFixtureOddsAdapter(gateway);
    await adapter.persist({
      ...input(),
      expectedStatus: "scheduled",
      expectedStartsAt: "2026-08-01T13:00:00.000Z",
    });
    expect(gateway.transactions[0]?.canonicalEvent.expected).toMatchObject({
      status: "scheduled",
      startsAt: "2026-08-01T13:00:00.000Z",
    });
    await expect(
      adapter.persist({
        ...input("2026-08-01T13:00:00.000Z"),
        expectedStatus: "scheduled",
        expectedStartsAt: "2026-08-01T13:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(FixtureOddsBindingConflictError);
    await expect(
      adapter.persist({
        ...input(),
        expectedStatus: "scheduled",
        expectedStartsAt: "2026-08-01T13:00:00.000Z",
        observation: {
          ...input().observation,
          retrievedAt: "2026-08-01T13:00:00.000Z",
        },
      }),
    ).rejects.toBeInstanceOf(FixtureOddsBindingConflictError);
  });
  it("uses exact DATA002 binding keys and protected condition shapes", async () => {
    const gateway = boundHarness();
    const result = await new DynamoFixtureOddsAdapter(gateway).persist(input());
    expect(result).toMatchObject({ snapshot: "created", current: "advanced" });
    const request = gateway.transactions[0]!;
    expect(request.mapping).toMatchObject({
      key: { sk: "CURRENT" },
      expected: {
        providerId: "fixture",
        providerEventId: "mlb-1",
        canonicalEventId: "event-1",
        sportKey: "baseball",
        leagueKey: "mlb",
      },
    });
    expect(request.mapping.key.pk).toMatch(/^MAPPING#[a-f0-9]{64}$/);
    expect(request.canonicalEvent).toEqual({
      key: { pk: "EVENT#event-1", sk: "CURRENT" },
      expected: {
        id: "event-1",
        version: 3,
        sportKey: "baseball",
        leagueKey: "mlb",
      },
    });
  });

  it("rejects mapping and canonical races without storing a snapshot", async () => {
    for (const changed of ["mapping", "event"] as const) {
      const gateway = boundHarness();
      gateway.beforeSnapshot = (request) => {
        const target =
          changed === "mapping"
            ? request.mapping.key
            : request.canonicalEvent.key;
        gateway.seed(target.pk, target.sk, { changed: true });
      };
      await expect(
        new DynamoFixtureOddsAdapter(gateway).persist(input()),
      ).rejects.toBeInstanceOf(FixtureOddsBindingConflictError);
      const snapshot = normalizeFixtureOddsObservation(input().observation);
      expect(
        await gateway.getExact(snapshot.partitionKey, snapshot.sortKey),
      ).toBeNull();
    }
  });

  it("converges an identical create race through one exact reread", async () => {
    const gateway = boundHarness();
    gateway.beforeSnapshot = (request) =>
      gateway.items.set(
        gateway.key(request.snapshot.pk, request.snapshot.sk),
        request.snapshot,
      );
    await expect(
      new DynamoFixtureOddsAdapter(gateway).persist(input()),
    ).resolves.toMatchObject({ snapshot: "existing", current: "advanced" });
  });

  it("repairs an interrupted exact-id mirror on retry without duplicating history", async () => {
    const gateway = boundHarness();
    let failHistory = true;
    const mirrored = new Map<string, Record<string, unknown>>();
    const send = vi.fn((raw: unknown) => {
      const command = raw as {
        constructor: { name: string };
        input: Record<string, unknown>;
      };
      if (command.constructor.name === "PutCommand") {
        const item = command.input["Item"] as Record<string, unknown>;
        const identity = `${String(item["pk"])}|${String(item["sk"])}`;
        if (String(item["pk"]).startsWith("ODDS_HISTORY#") && failHistory) {
          failHistory = false;
          return Promise.reject(new Error("mirror-unavailable"));
        }
        if (mirrored.has(identity)) {
          const error = new Error("already exists");
          error.name = "ConditionalCheckFailedException";
          return Promise.reject(error);
        }
        mirrored.set(identity, item);
        return Promise.resolve({});
      }
      if (command.constructor.name === "GetCommand") {
        const key = command.input["Key"] as Record<string, unknown>;
        return Promise.resolve({
          Item: mirrored.get(`${String(key["pk"])}|${String(key["sk"])}`),
        });
      }
      return Promise.reject(new Error("unexpected-command"));
    });
    const mirror = new DynamoExactOddsSnapshotRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "events",
    );
    const adapter = new DynamoFixtureOddsAdapter(gateway, mirror);
    await expect(adapter.persist(input())).rejects.toBeInstanceOf(
      FixtureOddsStorageError,
    );
    const normalized = normalizeFixtureOddsObservation(input().observation);
    expect(
      (await gateway.getExact(normalized.partitionKey, "CURRENT"))?.value
        .snapshotId,
    ).toBe(normalized.snapshotId);
    await expect(adapter.persist(input())).resolves.toMatchObject({
      snapshot: "existing",
      current: "retained",
    });
    expect(
      [...gateway.items.values()].filter(
        (item) => item.pk === normalized.partitionKey && item.sk !== "CURRENT",
      ),
    ).toHaveLength(1);
    expect(
      send.mock.calls
        .map(
          ([command]) =>
            (command as { input?: { Item?: { pk?: string } } }).input?.Item?.pk,
        )
        .filter(Boolean),
    ).toEqual([
      "ODDS_SNAPSHOTS_BY_ID",
      `ODDS_HISTORY#${normalized.canonicalEventId}`,
      "ODDS_SNAPSHOTS_BY_ID",
      `ODDS_HISTORY#${normalized.canonicalEventId}`,
    ]);
    await expect(mirror.get(normalized.snapshotId)).resolves.toMatchObject({
      snapshotId: normalized.snapshotId,
      americanOdds: normalized.americanOdds,
    });
    expect(
      (await gateway.getExact(normalized.partitionKey, "CURRENT"))?.value
        .snapshotId,
    ).toBe(normalized.snapshotId);
  });

  it("does not translate an exact-index content conflict into retryable storage", async () => {
    const gateway = boundHarness();
    const adapter = new DynamoFixtureOddsAdapter(gateway, {
      put: () =>
        Promise.reject(
          new FixtureOddsStateCorruptionError("snapshot-index-conflict"),
        ),
    });
    await expect(adapter.persist(input())).rejects.toBeInstanceOf(
      FixtureOddsStateCorruptionError,
    );
    const normalized = normalizeFixtureOddsObservation(input().observation);
    await expect(
      gateway.getExact(normalized.partitionKey, "CURRENT"),
    ).resolves.toBeNull();
  });

  it("detects immutable snapshot content collisions", async () => {
    const gateway = boundHarness();
    gateway.beforeSnapshot = (request) =>
      gateway.items.set(gateway.key(request.snapshot.pk, request.snapshot.sk), {
        ...request.snapshot,
        value: { ...request.snapshot.value, americanOdds: -999 },
      });
    await expect(
      new DynamoFixtureOddsAdapter(gateway).persist(input()),
    ).rejects.toThrow(/stored odds row is forged|identity maps/);
  });

  it("validates snapshots when DynamoDB reorders provenance map fields", () => {
    const snapshot = normalizeFixtureOddsObservation({
      ...input().observation,
      provenance: {
        providerId: "sharpapi",
        policyVersion: "v1",
        bookRole: "collected",
        sourceState: "active",
      },
    });
    const reordered = {
      ...snapshot,
      provenance: {
        sourceState: snapshot.provenance!.sourceState,
        providerId: snapshot.provenance!.providerId,
        bookRole: snapshot.provenance!.bookRole,
        policyVersion: snapshot.provenance!.policyVersion,
      },
    };

    expect(
      validateFixtureOddsSnapshotItem(
        { pk: snapshot.partitionKey, sk: snapshot.sortKey, value: reordered },
        snapshot.partitionKey,
        snapshot.sortKey,
      ),
    ).toEqual(snapshot);
  });

  it("accepts reordered immutable index maps and validates indexed reads", async () => {
    const snapshot = normalizeFixtureOddsObservation({
      ...input().observation,
      provenance: {
        providerId: "sharpapi",
        policyVersion: "v1",
        bookRole: "collected",
        sourceState: "stale",
      },
    });
    const reordered = {
      ...snapshot,
      provenance: {
        sourceState: snapshot.provenance!.sourceState,
        providerId: snapshot.provenance!.providerId,
        bookRole: snapshot.provenance!.bookRole,
        policyVersion: snapshot.provenance!.policyVersion,
      },
    };
    const send = vi.fn((raw: unknown) => {
      const command = raw as { constructor: { name: string } };
      if (command.constructor.name === "PutCommand") {
        const error = new Error("already exists");
        error.name = "ConditionalCheckFailedException";
        return Promise.reject(error);
      }
      return Promise.resolve({ Item: { value: reordered } });
    });
    const repository = new DynamoExactOddsSnapshotRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "events",
    );

    await expect(repository.prepare(snapshot)).resolves.toBeUndefined();
    await expect(repository.get(snapshot.snapshotId)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId,
      state: "suspended",
    });
  });

  it("stores late history independently while retaining the newer CURRENT", async () => {
    const gateway = boundHarness();
    const adapter = new DynamoFixtureOddsAdapter(gateway);
    await adapter.persist(input("2026-08-01T13:00:00.000Z", 120));
    const late = await adapter.persist(input("2026-08-01T12:00:00.000Z", -110));
    expect(late).toMatchObject({ snapshot: "created", current: "retained" });
    const normalizedLate = late.value;
    expect(
      await gateway.getExact(
        normalizedLate.partitionKey,
        normalizedLate.sortKey,
      ),
    ).not.toBeNull();
    const current = await gateway.getExact(
      normalizedLate.partitionKey,
      "CURRENT",
    );
    expect(current?.value.observedAt).toBe("2026-08-01T13:00:00.000Z");
  });

  it("converges synchronous and replayed stream projection in any delivery order", async () => {
    const gateway = boundHarness();
    const writer = new DynamoFixtureOddsAdapter(gateway);
    const projector = new FixtureOddsCurrentProjector(gateway);
    const older = await writer.persist(input("2026-08-01T12:00:00.000Z", -110));
    const newer = await writer.persist(input("2026-08-01T13:00:00.000Z", 120));
    await expect(
      projector.project({
        pk: newer.value.partitionKey,
        sk: newer.value.sortKey,
        value: newer.value,
      }),
    ).resolves.toMatchObject({ decision: "retained" });
    await expect(
      projector.project({
        pk: older.value.partitionKey,
        sk: older.value.sortKey,
        value: older.value,
      }),
    ).resolves.toMatchObject({ decision: "retained" });
    expect(
      (await gateway.getExact(newer.value.partitionKey, "CURRENT"))?.value
        .snapshotId,
    ).toBe(newer.value.snapshotId);
  });

  it("uses A1 snapshot-id ordering for equal observed times", async () => {
    const first = input("2026-08-01T12:00:00.000Z", -110);
    const second = input("2026-08-01T12:00:00.000Z", 130);
    const expected = [first, second]
      .map((value) => normalizeFixtureOddsObservation(value.observation))
      .sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : 1))[1]!;
    const gateway = boundHarness();
    const adapter = new DynamoFixtureOddsAdapter(gateway);
    await adapter.persist(first);
    await adapter.persist(second);
    expect(
      (await gateway.getExact(expected.partitionKey, "CURRENT"))?.value
        .snapshotId,
    ).toBe(expected.snapshotId);
  });

  it("converges a CURRENT race on the deterministic winning snapshot", async () => {
    const gateway = boundHarness();
    const contender = normalizeFixtureOddsObservation(
      input("2026-08-01T14:00:00.000Z", 140).observation,
    );
    gateway.beforeCurrent = (request) => {
      gateway.items.set(
        gateway.key(contender.partitionKey, contender.sortKey),
        { pk: contender.partitionKey, sk: contender.sortKey, value: contender },
      );
      gateway.items.set(gateway.key(request.item.pk, "CURRENT"), {
        pk: request.item.pk,
        sk: "CURRENT",
        value: contender,
      });
    };
    await expect(
      new DynamoFixtureOddsAdapter(gateway).persist(input()),
    ).resolves.toMatchObject({ snapshot: "created", current: "retained" });
    expect(
      (await gateway.getExact(contender.partitionKey, "CURRENT"))?.value
        .snapshotId,
    ).toBe(contender.snapshotId);
  });

  it("propagates nonconditional cancellation categories", async () => {
    for (const code of [
      "TransactionConflict",
      "ThrottlingError",
      "ValidationError",
      "AccessDenied",
      "Mystery",
    ]) {
      const gateway = boundHarness();
      gateway.snapshotFailure = new FixtureOddsTransactionCanceledError([
        { code },
        { code: "None" },
        { code: "None" },
      ]);
      await expect(
        new DynamoFixtureOddsAdapter(gateway).persist(input()),
      ).rejects.toBeInstanceOf(FixtureOddsStorageError);
    }
  });

  it("does not misclassify mixed conditional and throttling cancellation", async () => {
    const gateway = boundHarness();
    gateway.snapshotFailure = new FixtureOddsTransactionCanceledError([
      { code: "ConditionalCheckFailed" },
      { code: "None" },
      { code: "ThrottlingError" },
    ]);
    await expect(
      new DynamoFixtureOddsAdapter(gateway).persist(input()),
    ).rejects.toBeInstanceOf(FixtureOddsStorageError);
  });

  it("rejects a conditional snapshot loss with no exact visible winner", async () => {
    const gateway = boundHarness();
    gateway.snapshotFailure = new FixtureOddsTransactionCanceledError([
      { code: "None" },
      { code: "None" },
      { code: "ConditionalCheckFailed" },
    ]);
    await expect(
      new DynamoFixtureOddsAdapter(gateway).persist(input()),
    ).rejects.toBeInstanceOf(FixtureOddsBindingConflictError);
  });

  it("gives a simultaneous binding and snapshot condition loss binding precedence", async () => {
    const gateway = boundHarness();
    gateway.snapshotFailure = new FixtureOddsTransactionCanceledError([
      { code: "ConditionalCheckFailed" },
      { code: "None" },
      { code: "ConditionalCheckFailed" },
    ]);
    await expect(
      new DynamoFixtureOddsAdapter(gateway).persist(input()),
    ).rejects.toBeInstanceOf(FixtureOddsBindingConflictError);
  });

  it("rejects truncated or reordered cancellation reason vectors", async () => {
    for (const reasons of [
      [{ code: "ConditionalCheckFailed" }],
      [
        { code: "None" },
        { code: "ConditionalCheckFailed" },
        { code: "None" },
        { code: "None" },
      ],
    ]) {
      const gateway = boundHarness();
      gateway.snapshotFailure = new FixtureOddsTransactionCanceledError(
        reasons,
      );
      await expect(
        new DynamoFixtureOddsAdapter(gateway).persist(input()),
      ).rejects.toBeInstanceOf(FixtureOddsStorageError);
    }
  });

  it("does not treat missing or empty cancellation codes as None", async () => {
    for (const first of [{}, { code: "" }]) {
      const gateway = boundHarness();
      gateway.snapshotFailure = new FixtureOddsTransactionCanceledError([
        first,
        { code: "None" },
        { code: "ConditionalCheckFailed" },
      ] as unknown as ConstructorParameters<
        typeof FixtureOddsTransactionCanceledError
      >[0]);
      await expect(
        new DynamoFixtureOddsAdapter(gateway).persist(input()),
      ).rejects.toBeInstanceOf(FixtureOddsStorageError);
    }
  });

  it("wraps failed snapshot and CURRENT recovery reads", async () => {
    for (const phase of ["snapshot", "current"] as const) {
      const gateway = boundHarness();
      if (phase === "snapshot")
        gateway.snapshotFailure = new FixtureOddsTransactionCanceledError([
          { code: "None" },
          { code: "None" },
          { code: "ConditionalCheckFailed" },
        ]);
      else
        gateway.currentFailure = new FixtureOddsTransactionCanceledError([
          { code: "ConditionalCheckFailed" },
        ]);
      gateway.getFailure = new Error("read-down");
      await expect(
        new DynamoFixtureOddsAdapter(gateway).persist(input()),
      ).rejects.toMatchObject({ name: "FixtureOddsStorageError" });
    }
  });

  it("rejects malformed rows and orphan CURRENT pointers but accepts property reordering", async () => {
    const malformed = boundHarness();
    malformed.beforeSnapshot = (request) =>
      malformed.seed(
        request.snapshot.pk,
        request.snapshot.sk,
        Object.defineProperty({}, "x", { get: () => 1, enumerable: true }),
      );
    await expect(
      new DynamoFixtureOddsAdapter(malformed).persist(input()),
    ).rejects.toMatchObject({ name: "FixtureOddsStateCorruptionError" });

    const reordered = boundHarness();
    reordered.beforeSnapshot = (request) => {
      const reversed = Object.fromEntries(
        Object.entries(request.snapshot.value).reverse(),
      );
      reordered.seed(request.snapshot.pk, request.snapshot.sk, reversed);
    };
    await expect(
      new DynamoFixtureOddsAdapter(reordered).persist(input()),
    ).resolves.toMatchObject({ snapshot: "existing" });

    const orphan = boundHarness();
    const contender = normalizeFixtureOddsObservation(
      input("2026-08-01T14:00:00.000Z", 140).observation,
    );
    orphan.beforeCurrent = (request) =>
      orphan.items.set(orphan.key(request.item.pk, "CURRENT"), {
        pk: request.item.pk,
        sk: "CURRENT",
        value: contender,
      });
    await expect(
      new DynamoFixtureOddsAdapter(orphan).persist(input()),
    ).rejects.toMatchObject({ name: "FixtureOddsStateCorruptionError" });
  });
});

describe("AwsFixtureOddsGateway", () => {
  it("emits consistent exact reads and exact transaction/current conditions", async () => {
    const send = vi.fn().mockResolvedValue({});
    const gateway = new AwsFixtureOddsGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "events",
    );
    await gateway.getExact("pk", "sk");
    const snapshot = normalizeFixtureOddsObservation(input().observation);
    await gateway.transactSnapshot({
      mapping: {
        key: { pk: "mapping", sk: "CURRENT" },
        expected: { canonicalEventId: "event-1" },
      },
      canonicalEvent: {
        key: { pk: "event", sk: "CURRENT" },
        expected: { version: 3 },
      },
      snapshot: {
        pk: snapshot.partitionKey,
        sk: snapshot.sortKey,
        value: snapshot,
      },
    });
    await gateway.putCurrent({
      item: { pk: snapshot.partitionKey, sk: "CURRENT", value: snapshot },
      advanceAfter: {
        observedAt: snapshot.observedAt,
        snapshotId: snapshot.snapshotId,
      },
    });
    const getInput = (
      send.mock.calls[0]![0] as { input: Record<string, unknown> }
    ).input;
    expect(getInput).toMatchObject({
      TableName: "events",
      Key: { pk: "pk", sk: "sk" },
      ConsistentRead: true,
    });
    const transaction = (
      send.mock.calls[1]![0] as { input: { TransactItems: unknown[] } }
    ).input;
    expect(transaction.TransactItems).toHaveLength(3);
    expect(transaction).toMatchObject({
      TransactItems: [
        { ConditionCheck: { Key: { pk: "mapping", sk: "CURRENT" } } },
        { ConditionCheck: { Key: { pk: "event", sk: "CURRENT" } } },
        { Put: { ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    });
    const putInput = (
      send.mock.calls[2]![0] as { input: Record<string, unknown> }
    ).input;
    expect(putInput.ConditionExpression).toContain(
      "#value.#snapshotId < :snapshotId",
    );
  });

  it("translates SDK cancellation reasons without hiding nontransaction errors", async () => {
    const canceled = Object.assign(new Error("cancel"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "None" },
        { Code: "None" },
        { Code: "ConditionalCheckFailed", Message: "lost" },
      ],
    });
    const send = vi.fn().mockRejectedValue(canceled);
    const gateway = new AwsFixtureOddsGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "events",
    );
    await expect(
      gateway.transactSnapshot({
        mapping: { key: { pk: "m", sk: "CURRENT" }, expected: { id: "x" } },
        canonicalEvent: {
          key: { pk: "e", sk: "CURRENT" },
          expected: { id: "e" },
        },
        snapshot: {
          pk: "o",
          sk: "s",
          value: normalizeFixtureOddsObservation(input().observation),
        },
      }),
    ).rejects.toMatchObject({
      name: "FixtureOddsTransactionCanceledError",
      reasons: [
        { code: "None" },
        { code: "None" },
        { code: "ConditionalCheckFailed", message: "lost" },
      ],
    });
  });
});
