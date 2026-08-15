import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import {
  DynamoProviderLandingRepository,
  PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION,
  PROVIDER_LANDING_MAX_CLOCK_SKEW_MS,
  PROVIDER_LANDING_SCHEMA_VERSION,
  isProviderLandingRecordCurrent,
  providerLandingKey,
  providerLandingPositionHash,
  type ProviderLandingCheckpoint,
  type ProviderLandingRecord,
} from "./provider-landing-repository";

const eventRecord = (
  overrides: Partial<ProviderLandingRecord> = {},
): ProviderLandingRecord => ({
  schemaVersion: PROVIDER_LANDING_SCHEMA_VERSION,
  providerId: "sharpapi",
  recordType: "event",
  recordId: "atp-player-a-player-b",
  sport: "tennis",
  sweepId: "events-2026-08-14T20:00:00.000Z",
  slot: 0,
  pageNumber: 1,
  retrievedAt: "2026-08-14T20:00:01.000Z",
  value: { league: "atp", status: "upcoming" },
  ...overrides,
});

const testPositionHash = (
  stream: ProviderLandingCheckpoint["stream"],
  position: ProviderLandingCheckpoint["position"],
  length: 32 | 64 = 32,
) => providerLandingPositionHash({ stream, position }, length);

const checkpoint = (
  overrides: Partial<ProviderLandingCheckpoint> = {},
): ProviderLandingCheckpoint => {
  const value: ProviderLandingCheckpoint = {
    schemaVersion: PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION,
    providerId: "sharpapi",
    stream: "events",
    version: 0,
    status: "running",
    sweepId: "events-2026-08-14T20:00:00.000Z",
    slot: 0,
    position: { offset: 200 },
    startedAt: "2026-08-14T20:00:00.000Z",
    updatedAt: "2026-08-14T20:00:02.000Z",
    counts: { pages: 1, sourceRows: 2, landedRows: 1, quarantinedRows: 1 },
    ...overrides,
  };
  if (
    value.status === "running" &&
    (value.stream === "events" || value.stream === "odds") &&
    overrides.visitedPositionHashes === undefined
  )
    return {
      ...value,
      visitedPositionHashes: [testPositionHash(value.stream, value.position)],
    };
  return value;
};

const completedCheckpoint = (
  overrides: Partial<ProviderLandingCheckpoint> = {},
): ProviderLandingCheckpoint => {
  const sweepId = overrides.sweepId ?? "events-2026-08-14T20:00:00.000Z";
  const lastCompletedAt =
    overrides.lastCompletedAt ?? "2026-08-14T20:30:00.000Z";
  const lastCompletedCounts = overrides.lastCompletedCounts ?? {
    pages: 1,
    sourceRows: 2,
    landedRows: 1,
    quarantinedRows: 1,
  };
  return checkpoint({
    status: "complete",
    position: null,
    sweepId,
    lastCompletedSlot: overrides.slot ?? 0,
    lastCompletedSweepId: sweepId,
    updatedAt: lastCompletedAt,
    counts: lastCompletedCounts,
    lastCompletedAt,
    lastCompletedCounts,
    ...overrides,
  });
};

describe("provider landing repository", () => {
  it("uses sport-scoped event keys and sharded odds keys without an allowlist", () => {
    expect(
      providerLandingKey(
        eventRecord({
          recordType: "catalog-league",
          recordId: "atp",
          sport: "tennis",
        }),
      ),
    ).toEqual({
      pk: "PROVIDER_LANDING#SHARPAPI#CATALOG#LEAGUE",
      sk: "SLOT#0#LEAGUE#tennis#atp",
    });
    expect(providerLandingKey(eventRecord())).toEqual({
      pk: "PROVIDER_LANDING#SHARPAPI#EVENT#tennis",
      sk: "SLOT#0#EVENT#atp-player-a-player-b",
    });
    const oddsKey = providerLandingKey(
      eventRecord({
        recordType: "odds",
        recordId: "price-1",
        sport: "new_provider_sport",
      }),
    );
    expect(oddsKey.pk).toMatch(
      /^PROVIDER_LANDING#SHARPAPI#ODDS#new_provider_sport#[a-f0-9]$/,
    );
    expect(oddsKey.sk).toBe("SLOT#0#PRICE#price-1");
  });

  it("uses sweep-start dates and bounded shards for quarantine keys", () => {
    const key = providerLandingKey(
      eventRecord({
        recordType: "quarantine",
        recordId: "events:2026-08-14T20:00:00.000Z:events:1:0",
        endpoint: "events",
        retrievedAt: "2026-08-15T00:00:01.000Z",
      }),
    );
    expect(key.pk).toMatch(
      /^PROVIDER_LANDING#SHARPAPI#QUARANTINE#events#2026-08-14#[a-f0-9]$/,
    );
  });

  it("rejects malformed and overlong encoded DynamoDB keys", async () => {
    expect(() =>
      providerLandingKey(eventRecord({ recordId: "bad\u0000id" })),
    ).toThrow("provider-landing-record-id-invalid");
    expect(() =>
      providerLandingKey(eventRecord({ recordId: "\ud800" })),
    ).toThrow("provider-landing-record-id-invalid");
    expect(() =>
      providerLandingKey(eventRecord({ recordId: "é".repeat(256) })),
    ).toThrow("provider-landing-sort-key-too-large");
    expect(() =>
      providerLandingKey(
        eventRecord({
          recordType: "future" as ProviderLandingRecord["recordType"],
        }),
      ),
    ).toThrow("provider-landing-record-type-invalid");
    expect(() =>
      providerLandingKey(
        eventRecord({
          recordType: "quarantine",
          endpoint: "events#unexpected" as NonNullable<
            ProviderLandingRecord["endpoint"]
          >,
        }),
      ),
    ).toThrow("provider-landing-quarantine-invalid");
    const repository = new DynamoProviderLandingRepository(
      { send: vi.fn() } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(
      repository.putRecords([
        eventRecord({
          endpoint: "events#unexpected" as NonNullable<
            ProviderLandingRecord["endpoint"]
          >,
        }),
      ]),
    ).rejects.toThrow("provider-landing-record-invalid");
    await expect(
      repository.putRecords([
        eventRecord({
          value: new Date() as unknown as Record<string, unknown>,
        }),
      ]),
    ).rejects.toThrow("provider-landing-record-invalid");
    await expect(
      repository.putRecords([
        eventRecord({ slot: 2 as ProviderLandingRecord["slot"] }),
      ]),
    ).rejects.toThrow("provider-landing-record-invalid");
  });

  it("batch-writes current records idempotently and retries unprocessed items", async () => {
    let writeCalls = 0;
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand) return Promise.resolve({});
      expect(command).toBeInstanceOf(BatchWriteCommand);
      writeCalls += 1;
      if (writeCalls === 1) {
        const input = (command as BatchWriteCommand).input;
        return Promise.resolve({
          UnprocessedItems: { Table: input.RequestItems?.["Table"] },
        });
      }
      return Promise.resolve({});
    });
    const sleep = vi.fn((delayMs: number) => {
      void delayMs;
      return Promise.resolve();
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
      { sleep, random: () => 0.5 },
    );
    const result = await repository.putRecords([
      eventRecord(),
      eventRecord({ value: { league: "atp", status: "live" } }),
    ]);
    expect(result).toEqual({
      crossPageDuplicateCount: 0,
      crossPageDuplicateRecordIds: [],
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(62);
    const writes = (send.mock.calls[2]?.[0] as BatchWriteCommand).input
      .RequestItems?.["Table"];
    expect(writes).toHaveLength(2);
    const current = writes?.find(
      ({ PutRequest }) => PutRequest?.Item?.["recordType"] === "event",
    );
    expect(current?.PutRequest?.Item?.["value"]).toEqual({
      league: "atp",
      status: "live",
    });
    expect(current?.PutRequest?.Item?.["pageNumber"]).toBe(1);
    expect(current?.PutRequest?.Item?.["expiresAt"]).toBe(1_794_513_601);
    expect(
      writes?.find(
        ({ PutRequest }) =>
          PutRequest?.Item?.["recordType"] === "provider-landing-identity",
      )?.PutRequest?.Item,
    ).toMatchObject({
      identityType: "event",
      recordId: "atp-player-a-player-b",
      currentPk: "PROVIDER_LANDING#SHARPAPI#EVENT#tennis",
      currentSk: "SLOT#0#EVENT#atp-player-a-player-b",
      expiresAt: 1_794_513_601,
    });
    const identity = writes?.find(
      ({ PutRequest }) =>
        PutRequest?.Item?.["recordType"] === "provider-landing-identity",
    )?.PutRequest?.Item;
    expect(identity?.["pk"]).toMatch(
      /^PROVIDER_LANDING#SHARPAPI#IDENTITY#EVENT#[a-f0-9]$/,
    );
    expect(identity?.["sk"]).toBe("SLOT#0#ID#atp-player-a-player-b");
  });

  it("keeps same-page replays idempotent", async () => {
    const record = eventRecord();
    const key = providerLandingKey(record);
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand)
        return Promise.resolve({
          Responses: {
            Table: [
              { ...key, sweepId: record.sweepId, slot: 0, pageNumber: 1 },
            ],
          },
        });
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.putRecords([record])).resolves.toEqual({
      crossPageDuplicateCount: 0,
      crossPageDuplicateRecordIds: [],
    });
    const write = send.mock.calls.find(
      ([command]) => command instanceof BatchWriteCommand,
    )?.[0] as BatchWriteCommand;
    expect(
      write.input.RequestItems?.["Table"]?.[0]?.PutRequest?.Item,
    ).toMatchObject({
      recordType: "event",
      recordId: record.recordId,
      pageNumber: 1,
    });
  });

  it("quarantines cross-page duplicates without overwriting current records", async () => {
    const duplicate = eventRecord({
      pageNumber: 2,
      retrievedAt: "2026-08-15T00:00:01.000Z",
    });
    const key = providerLandingKey(duplicate);
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand)
        return Promise.resolve({
          Responses: {
            Table: [
              { ...key, sweepId: duplicate.sweepId, slot: 0, pageNumber: 1 },
            ],
          },
        });
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.putRecords([duplicate])).resolves.toEqual({
      crossPageDuplicateCount: 1,
      crossPageDuplicateRecordIds: [duplicate.recordId],
    });
    const write = send.mock.calls.find(
      ([command]) => command instanceof BatchWriteCommand,
    )?.[0] as BatchWriteCommand;
    const item = write.input.RequestItems?.["Table"]?.[0]?.PutRequest?.Item;
    expect(item).toMatchObject({
      recordType: "quarantine",
      endpoint: "events",
      pageNumber: 2,
      value: {
        reason: "duplicate-provider-id-across-pages",
        providerRecordId: duplicate.recordId,
        originalPageNumber: 1,
        duplicatePageNumber: 2,
      },
    });
    expect(item?.["pk"]).toMatch(/#2026-08-14#[a-f0-9]$/);
    expect(item?.["expiresAt"]).toBe(1_789_344_001);
    expect(JSON.stringify(write.input)).not.toContain('"recordType":"event"');
  });

  it("strongly batch-gets current keys in chunks of at most one hundred", async () => {
    const send = vi.fn((command: unknown) => {
      void command;
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await repository.putRecords(
      Array.from({ length: 101 }, (_, index) =>
        eventRecord({ recordId: `event-${index}` }),
      ),
    );
    const reads = send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is BatchGetCommand =>
          command instanceof BatchGetCommand,
      );
    expect(reads).toHaveLength(3);
    expect(
      reads.map(({ input }) => input.RequestItems?.["Table"]?.Keys?.length),
    ).toEqual([100, 100, 2]);
    expect(
      reads.every(
        ({ input }) => input.RequestItems?.["Table"]?.ConsistentRead === true,
      ),
    ).toBe(true);
  });

  it("retries unprocessed strong reads with capped injected backoff", async () => {
    let readCalls = 0;
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand) {
        readCalls += 1;
        if (readCalls === 1)
          return Promise.resolve({
            UnprocessedKeys: {
              Table: { Keys: command.input.RequestItems?.["Table"]?.Keys },
            },
          });
      }
      return Promise.resolve({});
    });
    const sleep = vi.fn((delayMs: number) => {
      void delayMs;
      return Promise.resolve();
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
      { sleep, random: () => 0.5 },
    );
    await repository.putRecords([eventRecord()]);
    expect(readCalls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(62);
  });

  it("exhausts writes only after the full capped backoff sequence", async () => {
    let writeCalls = 0;
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand) return Promise.resolve({});
      writeCalls += 1;
      const input = (command as BatchWriteCommand).input;
      return Promise.resolve({
        UnprocessedItems: { Table: input.RequestItems?.["Table"] },
      });
    });
    const sleep = vi.fn((delayMs: number) => {
      void delayMs;
      return Promise.resolve();
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
      { sleep, random: () => 1 },
    );
    await expect(repository.putRecords([eventRecord()])).rejects.toThrow(
      "provider-landing-write-exhausted",
    );
    expect(writeCalls).toBe(5);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
      125, 250, 500, 1_000,
    ]);
  });

  it("rejects mixed-sweep or mixed-page write batches", async () => {
    const repository = new DynamoProviderLandingRepository(
      { send: vi.fn() } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(
      repository.putRecords([eventRecord(), eventRecord({ pageNumber: 2 })]),
    ).rejects.toThrow("provider-landing-record-batch-mixed");
    await expect(
      repository.putRecords([
        eventRecord(),
        eventRecord({ sweepId: "events-2026-08-14T21:00:00.000Z" }),
      ]),
    ).rejects.toThrow("provider-landing-record-batch-mixed");
    await expect(
      repository.putRecords([eventRecord(), eventRecord({ sport: "soccer" })]),
    ).rejects.toThrow("provider-landing-record-batch-identity-conflict");
    await expect(
      repository.putRecords([eventRecord(), eventRecord({ slot: 1 })]),
    ).rejects.toThrow("provider-landing-record-batch-mixed");
  });

  it("rejects corrupt current-record metadata before duplicate classification", async () => {
    const record = eventRecord();
    const key = providerLandingKey(record);
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand)
        return Promise.resolve({
          Responses: {
            Table: [{ ...key, sweepId: record.sweepId, pageNumber: "1" }],
          },
        });
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.putRecords([record])).rejects.toThrow(
      "provider-landing-current-record-corrupt",
    );
  });

  it("rejects corrupt identity pointers beyond DynamoDB UTF-8 byte limits", async () => {
    const record = eventRecord();
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand) {
        const identityKey = command.input.RequestItems?.["Table"]?.Keys?.find(
          (key) => String(key["pk"]).includes("#IDENTITY#"),
        );
        return Promise.resolve({
          Responses: {
            Table: [
              {
                ...identityKey,
                sweepId: record.sweepId,
                slot: 0,
                pageNumber: 1,
                currentPk: "😀".repeat(1_024),
                currentSk: `SLOT#0#EVENT#${record.recordId}`,
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.putRecords([record])).rejects.toThrow(
      "provider-landing-current-record-corrupt",
    );
  });

  it("bounds returned cross-page duplicate identifiers while retaining exact counts", async () => {
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand) {
        const keys = command.input.RequestItems?.["Table"]?.Keys ?? [];
        return Promise.resolve({
          Responses: {
            Table: keys
              .filter((key) => !String(key["pk"]).includes("#IDENTITY#"))
              .map((key) => ({
                ...key,
                sweepId: "events-2026-08-14T20:00:00.000Z",
                slot: 0,
                pageNumber: 1,
              })),
          },
        });
      }
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    const result = await repository.putRecords(
      Array.from({ length: 101 }, (_, index) =>
        eventRecord({ recordId: `event-${index}`, pageNumber: 2 }),
      ),
    );
    expect(result.crossPageDuplicateCount).toBe(101);
    expect(result.crossPageDuplicateRecordIds).toHaveLength(100);
  });

  it("quarantines cross-page identities even when their sport changes", async () => {
    const duplicate = eventRecord({ sport: "soccer", pageNumber: 2 });
    const send = vi.fn((command: unknown) => {
      if (command instanceof BatchGetCommand) {
        const identityKey = command.input.RequestItems?.["Table"]?.Keys?.find(
          (key) => String(key["pk"]).includes("#IDENTITY#"),
        );
        return Promise.resolve({
          Responses: {
            Table: [
              {
                ...identityKey,
                sweepId: duplicate.sweepId,
                slot: 0,
                pageNumber: 1,
                currentPk: "PROVIDER_LANDING#SHARPAPI#EVENT#tennis",
                currentSk: `SLOT#0#EVENT#${duplicate.recordId}`,
              },
            ],
          },
        });
      }
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.putRecords([duplicate])).resolves.toMatchObject({
      crossPageDuplicateCount: 1,
      crossPageDuplicateRecordIds: [duplicate.recordId],
    });
    const write = send.mock.calls.find(
      ([command]) => command instanceof BatchWriteCommand,
    )?.[0] as BatchWriteCommand;
    expect(JSON.stringify(write.input)).toContain(
      "duplicate-provider-id-across-pages",
    );
    expect(JSON.stringify(write.input)).not.toContain(
      "PROVIDER_LANDING#SHARPAPI#EVENT#soccer",
    );
  });

  it("strongly reads checkpoints and conditionally advances their version", async () => {
    const stored = checkpoint();
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetCommand)
        return Promise.resolve({ Item: { version: 0, value: stored } });
      return Promise.resolve({});
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.getCheckpoint("events")).resolves.toEqual(stored);
    expect((send.mock.calls[0]?.[0] as GetCommand).input).toMatchObject({
      ConsistentRead: true,
      Key: {
        pk: "PROVIDER_LANDING#SHARPAPI#CONTROL",
        sk: "CHECKPOINT#events",
      },
    });

    const next = completedCheckpoint({
      version: 1,
      counts: { pages: 2, sourceRows: 4, landedRows: 3, quarantinedRows: 1 },
      lastCompletedAt: "2026-08-14T20:00:03.000Z",
      lastCompletedCounts: {
        pages: 2,
        sourceRows: 4,
        landedRows: 3,
        quarantinedRows: 1,
      },
    });
    await repository.putCheckpoint(next, 0);
    const put = send.mock.calls[1]?.[0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input).toMatchObject({
      ConditionExpression: "#version = :expectedVersion",
      ExpressionAttributeValues: { ":expectedVersion": 0 },
    });
  });

  it("validates partition checkpoints after DynamoDB reorders map keys", async () => {
    const writtenPosition = { partition: 1, offset: 0 } as const;
    const stored = checkpoint({
      // DynamoDB document maps may return these fields in a different order
      // from the object the worker originally hashed.
      position: { offset: 0, partition: 1 },
      eventPartitions: [{ sport: "baseball" }, { sport: "football" }],
      eventPartitionSourceRows: 0,
      visitedPositionHashes: [
        providerLandingPositionHash({
          stream: "events",
          position: writtenPosition,
        }),
      ],
    });
    expect(
      providerLandingPositionHash({
        stream: "events",
        position: stored.position,
      }),
    ).toBe(stored.visitedPositionHashes?.[0]);

    const repository = new DynamoProviderLandingRepository(
      {
        send: vi.fn(() =>
          Promise.resolve({ Item: { version: stored.version, value: stored } }),
        ),
      } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.getCheckpoint("events")).resolves.toEqual(stored);
  });

  it("marks records current only for their completed matching sweep", () => {
    const completeEvents = completedCheckpoint();
    expect(isProviderLandingRecordCurrent(eventRecord(), completeEvents)).toBe(
      true,
    );
    expect(
      isProviderLandingRecordCurrent(
        eventRecord({ recordType: "catalog-sport" }),
        completedCheckpoint({ stream: "catalog" }),
      ),
    ).toBe(true);
    expect(
      isProviderLandingRecordCurrent(
        eventRecord({ recordType: "catalog-league" }),
        completedCheckpoint({ stream: "catalog" }),
      ),
    ).toBe(true);
    expect(
      isProviderLandingRecordCurrent(
        eventRecord({ recordType: "odds" }),
        completedCheckpoint({ stream: "odds" }),
      ),
    ).toBe(true);
    expect(
      isProviderLandingRecordCurrent(
        eventRecord({ recordType: "quarantine", endpoint: "events" }),
        completeEvents,
      ),
    ).toBe(false);
    expect(isProviderLandingRecordCurrent(eventRecord(), checkpoint())).toBe(
      false,
    );
    expect(
      isProviderLandingRecordCurrent(
        eventRecord(),
        completedCheckpoint({ stream: "odds" }),
      ),
    ).toBe(false);
    expect(
      isProviderLandingRecordCurrent(
        eventRecord({ sweepId: "events-2026-08-14T21:00:00.000Z" }),
        completeEvents,
      ),
    ).toBe(false);
    expect(
      isProviderLandingRecordCurrent(
        eventRecord({
          providerId: "other" as ProviderLandingRecord["providerId"],
        }),
        completeEvents,
      ),
    ).toBe(false);
    expect(isProviderLandingRecordCurrent(eventRecord(), null)).toBe(false);
  });

  it("keeps the completed generation visible during a new sweep and drops removed rows on commit", () => {
    const priorSweepId = "events-2026-08-14T20:00:00.000Z";
    const nextSweepId = "events-2026-08-14T21:00:00.000Z";
    const prior = eventRecord({ sweepId: priorSweepId });
    const removed = eventRecord({
      recordId: "removed-event",
      sweepId: priorSweepId,
    });
    const refreshed = eventRecord({ sweepId: nextSweepId, slot: 1 });
    expect(providerLandingKey(prior)).not.toEqual(
      providerLandingKey(refreshed),
    );

    const running = checkpoint({
      sweepId: nextSweepId,
      slot: 1,
      lastCompletedSlot: 0,
      lastCompletedSweepId: priorSweepId,
      lastCompletedAt: "2026-08-14T20:30:00.000Z",
      lastCompletedCounts: {
        pages: 1,
        sourceRows: 2,
        landedRows: 2,
        quarantinedRows: 0,
      },
    });
    expect(
      [prior, removed, refreshed]
        .filter((record) => isProviderLandingRecordCurrent(record, running))
        .map(({ recordId }) => recordId),
    ).toEqual([prior.recordId, removed.recordId]);

    const complete = completedCheckpoint({
      sweepId: nextSweepId,
      slot: 1,
      lastCompletedAt: "2026-08-14T21:30:00.000Z",
      lastCompletedCounts: {
        pages: 1,
        sourceRows: 1,
        landedRows: 1,
        quarantinedRows: 0,
      },
    });
    expect(
      [prior, removed, refreshed]
        .filter((record) => isProviderLandingRecordCurrent(record, complete))
        .map(({ recordId }) => recordId),
    ).toEqual([refreshed.recordId]);

    const reused = eventRecord({
      sweepId: "events-2026-08-14T22:00:00.000Z",
      slot: 0,
    });
    expect(providerLandingKey(reused)).toEqual(providerLandingKey(prior));
    expect(
      [prior, removed, reused]
        .filter((record) =>
          isProviderLandingRecordCurrent(
            record,
            completedCheckpoint({
              sweepId: reused.sweepId,
              slot: 0,
            }),
          ),
        )
        .map(({ recordId }) => recordId),
    ).toEqual([reused.recordId]);
  });

  it("accepts bounded checkpoint durability metadata", async () => {
    const send = vi.fn(() => Promise.resolve({}));
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(
      repository.putCheckpoint(
        checkpoint({
          counts: {
            pages: 1,
            sourceRows: 2,
            landedRows: 1,
            quarantinedRows: 1,
            warningRows: 2,
          },
          providerUpdatedAt: "2026-08-14T20:00:01.123456789Z",
          visitedPositionHashes: [
            testPositionHash("events", { offset: 200 }),
            "b".repeat(32),
          ],
          resumeAfter: "2026-08-14T20:01:00.000Z",
          pauseScope: "account",
          pendingPage: {
            positionHash: testPositionHash("events", { offset: 200 }, 64),
            pageHash: "d".repeat(64),
          },
        }),
        null,
      ),
    ).resolves.toBeUndefined();
    const plannedPosition = { partition: 1, offset: 200 } as const;
    await expect(
      repository.putCheckpoint(
        checkpoint({
          position: plannedPosition,
          eventPartitions: [
            { sport: "tennis", leagues: ["atp", "wta"] },
            { sport: "baseball", leagues: ["mlb"] },
          ],
          eventPartitionSourceRows: 200,
          visitedPositionHashes: [testPositionHash("events", plannedPosition)],
        }),
        null,
      ),
    ).resolves.toBeUndefined();
    await expect(
      repository.putCheckpoint(
        checkpoint({
          stream: "catalog",
          position: null,
          pendingPage: {
            positionHash: testPositionHash("catalog", null, 64),
            pageHash: "f".repeat(64),
          },
        }),
        null,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["unknown status", { status: "paused" }],
    ["events cursor", { position: { cursor: "cursor-1" } }],
    ["events unaligned offset", { position: { offset: 201 } }],
    [
      "planned events missing plan",
      { position: { partition: 0, offset: 0 }, eventPartitionSourceRows: 0 },
    ],
    [
      "planned events missing partition count",
      {
        position: { partition: 0, offset: 0 },
        eventPartitions: [{ sport: "tennis", leagues: ["atp"] }],
      },
    ],
    [
      "planned events partition out of range",
      {
        position: { partition: 1, offset: 0 },
        eventPartitions: [{ sport: "tennis", leagues: ["atp"] }],
        eventPartitionSourceRows: 0,
      },
    ],
    [
      "planned events duplicate league",
      {
        position: { partition: 0, offset: 0 },
        eventPartitions: [
          { sport: "tennis", leagues: ["atp", "wta"] },
          { sport: "tennis", leagues: ["atp"] },
        ],
        eventPartitionSourceRows: 0,
      },
    ],
    [
      "planned events empty filter member",
      {
        position: { partition: 0, offset: 0 },
        eventPartitions: [{ sport: "tennis", leagues: ["atp", "", "wta"] }],
        eventPartitionSourceRows: 0,
      },
    ],
    [
      "planned events overlapping sport-wide and league filters",
      {
        position: { partition: 0, offset: 0 },
        eventPartitions: [
          { sport: "tennis" },
          { sport: "tennis", leagues: ["atp"] },
        ],
        eventPartitionSourceRows: 0,
      },
    ],
    [
      "planned events oversized encoded filter",
      {
        position: { partition: 0, offset: 0 },
        eventPartitions: [
          {
            sport: "tennis",
            leagues: Array.from(
              { length: 50 },
              (_, index) => `${index}-${"x".repeat(120)}`,
            ),
          },
        ],
        eventPartitionSourceRows: 0,
      },
    ],
    ["odds offset", { stream: "odds", position: { offset: 200 } }],
    ["catalog offset", { stream: "catalog", position: { offset: 200 } }],
    [
      "excess warnings",
      {
        counts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
          warningRows: 3,
        },
      },
    ],
    [
      "duplicate position hashes",
      { visitedPositionHashes: ["a".repeat(32), "a".repeat(32)] },
    ],
    ["missing position history", { visitedPositionHashes: [] }],
    [
      "history missing current position",
      { visitedPositionHashes: ["a".repeat(32)] },
    ],
    ["uppercase position hash", { visitedPositionHashes: ["A".repeat(32)] }],
    ["invalid provider timestamp", { providerUpdatedAt: "not-an-instant" }],
    [
      "invalid provider calendar timestamp",
      { providerUpdatedAt: "2026-02-30T20:00:00.123456789Z" },
    ],
    [
      "invalid resume time",
      { resumeAfter: "not-an-instant", pauseScope: "stream" },
    ],
    ["noncanonical resume time", { resumeAfter: "9999", pauseScope: "stream" }],
    ["resume time without scope", { resumeAfter: "2026-08-14T20:01:00.000Z" }],
    ["pause without resume time", { pauseScope: "stream" }],
    [
      "unknown pause scope",
      {
        resumeAfter: "2026-08-14T20:01:00.000Z",
        pauseScope: "global",
      },
    ],
    ["updated before started", { updatedAt: "2026-08-14T19:59:59.000Z" }],
    ["sweep without timestamp", { sweepId: "events-bad" }],
    ["invalid generation slot", { slot: 2 }],
    ["scalar counts", { counts: 1 }],
    [
      "partial last-completion metadata",
      { lastCompletedAt: "2026-08-14T20:30:00.000Z" },
    ],
    [
      "complete checkpoint without last-completion metadata",
      {
        status: "complete",
        position: null,
      },
    ],
    [
      "complete checkpoint with mismatched last sweep",
      {
        status: "complete",
        position: null,
        lastCompletedSlot: 0,
        lastCompletedSweepId: "events-2026-08-14T19:00:00.000Z",
        lastCompletedAt: "2026-08-14T20:30:00.000Z",
        lastCompletedCounts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
        },
      },
    ],
    [
      "running checkpoint bound to its in-progress sweep",
      {
        lastCompletedSlot: 0,
        lastCompletedSweepId: "events-2026-08-14T20:00:00.000Z",
        lastCompletedAt: "2026-08-14T20:30:00.000Z",
        lastCompletedCounts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
        },
      },
    ],
    [
      "running checkpoint reusing its completed slot",
      {
        lastCompletedSlot: 0,
        lastCompletedSweepId: "events-2026-08-14T19:00:00.000Z",
        lastCompletedAt: "2026-08-14T20:30:00.000Z",
        lastCompletedCounts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
        },
      },
    ],
    [
      "complete checkpoint with mismatched last slot",
      {
        status: "complete",
        position: null,
        slot: 0,
        lastCompletedSlot: 1,
        lastCompletedSweepId: "events-2026-08-14T20:00:00.000Z",
        lastCompletedAt: "2026-08-14T20:30:00.000Z",
        lastCompletedCounts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
        },
      },
    ],
    [
      "complete checkpoint with stale completion time",
      {
        status: "complete",
        position: null,
        updatedAt: "2026-08-14T20:31:00.000Z",
        lastCompletedSlot: 0,
        lastCompletedSweepId: "events-2026-08-14T20:00:00.000Z",
        lastCompletedAt: "2026-08-14T20:30:00.000Z",
        lastCompletedCounts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
        },
      },
    ],
    [
      "complete checkpoint with stale completion counts",
      {
        status: "complete",
        position: null,
        updatedAt: "2026-08-14T20:30:00.000Z",
        counts: {
          pages: 2,
          sourceRows: 3,
          landedRows: 2,
          quarantinedRows: 1,
        },
        lastCompletedSlot: 0,
        lastCompletedSweepId: "events-2026-08-14T20:00:00.000Z",
        lastCompletedAt: "2026-08-14T20:30:00.000Z",
        lastCompletedCounts: {
          pages: 1,
          sourceRows: 2,
          landedRows: 1,
          quarantinedRows: 1,
        },
      },
    ],
    [
      "pending page on complete checkpoint",
      {
        status: "complete",
        position: null,
        pendingPage: {
          positionHash: "a".repeat(64),
          pageHash: "b".repeat(64),
        },
      },
    ],
    [
      "short pending page hash",
      {
        pendingPage: {
          positionHash: "a".repeat(63),
          pageHash: "b".repeat(64),
        },
      },
    ],
    [
      "pending page for another position",
      {
        pendingPage: {
          positionHash: "a".repeat(64),
          pageHash: "b".repeat(64),
        },
      },
    ],
  ])("rejects checkpoint metadata with %s", async (_label, overrides) => {
    const repository = new DynamoProviderLandingRepository(
      { send: vi.fn() } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(
      repository.putCheckpoint(
        checkpoint(overrides as Partial<ProviderLandingCheckpoint>),
        null,
      ),
    ).rejects.toThrow("provider-landing-checkpoint-invalid");
  });

  it("rejects future lifecycle timestamps beyond the documented clock skew", async () => {
    const observedAt = Date.now();
    const futureAt = new Date(
      observedAt + PROVIDER_LANDING_MAX_CLOCK_SKEW_MS + 60_000,
    ).toISOString();
    const futureSweep = `events:${futureAt}`;
    const future = completedCheckpoint({
      sweepId: futureSweep,
      startedAt: futureAt,
      updatedAt: futureAt,
      lastCompletedSweepId: futureSweep,
      lastCompletedAt: futureAt,
    });
    const putRepository = new DynamoProviderLandingRepository(
      { send: vi.fn() } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(putRepository.putCheckpoint(future, null)).rejects.toThrow(
      "provider-landing-checkpoint-invalid",
    );

    const getRepository = new DynamoProviderLandingRepository(
      {
        send: vi.fn(() =>
          Promise.resolve({ Item: { version: future.version, value: future } }),
        ),
      } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(getRepository.getCheckpoint("events")).rejects.toThrow(
      "provider-landing-checkpoint-invalid",
    );
  });

  it("claims exact positions once and distinguishes crash replay from a cycle", async () => {
    let stored: Record<string, unknown> | undefined;
    const send = vi.fn((command: { input: Record<string, unknown> }) => {
      if (command.constructor.name === "PutCommand") {
        if (stored) {
          const error = new Error("conditional");
          error.name = "ConditionalCheckFailedException";
          return Promise.reject(error);
        }
        stored = structuredClone(
          command.input["Item"] as Record<string, unknown>,
        );
        return Promise.resolve({});
      }
      if (command.constructor.name === "GetCommand")
        return Promise.resolve({ Item: structuredClone(stored) });
      return Promise.reject(new Error("unexpected-command"));
    });
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    const claimedAt = new Date().toISOString();
    const claim = {
      stream: "events" as const,
      sweepId: `events:${claimedAt}`,
      slot: 0 as const,
      positionHash: "a".repeat(32),
      pageNumber: 1,
      claimedAt,
    };
    await expect(repository.claimPosition(claim)).resolves.toBe("claimed");
    await expect(repository.claimPosition(claim)).resolves.toBe("replay");
    await expect(
      repository.claimPosition({ ...claim, pageNumber: 2 }),
    ).resolves.toBe("cycle");
    expect(stored).toMatchObject({
      providerId: "sharpapi",
      recordType: "provider-landing-position-claim",
      ...claim,
      expiresAt: Math.floor(Date.parse(claimedAt) / 1_000) + 90 * 24 * 60 * 60,
    });
  });

  it("reports malformed stored checkpoint envelopes as checkpoint corruption", async () => {
    const repository = new DynamoProviderLandingRepository(
      {
        send: vi.fn(() =>
          Promise.resolve({ Item: { version: 0, value: null } }),
        ),
      } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(repository.getCheckpoint("events")).rejects.toThrow(
      "provider-landing-checkpoint-invalid",
    );
  });

  it("refuses inconsistent reconciliation counts and oversized values", async () => {
    const repository = new DynamoProviderLandingRepository(
      { send: vi.fn() } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    await expect(
      repository.putCheckpoint(
        checkpoint({
          counts: {
            pages: 1,
            sourceRows: 3,
            landedRows: 1,
            quarantinedRows: 1,
          },
        }),
        null,
      ),
    ).rejects.toThrow("provider-landing-checkpoint-invalid");
    await expect(
      repository.putRecords([
        eventRecord({ value: { body: "x".repeat(310_000) } }),
      ]),
    ).rejects.toThrow("provider-landing-record-too-large");
  });

  it("rejects hand-built values that the DynamoDB document marshaller cannot preserve", async () => {
    const send = vi.fn();
    const repository = new DynamoProviderLandingRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Table",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    let accessorReads = 0;
    const accessorArray = [0];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return 1;
      },
    });
    const sparseArray = new Array<unknown>(2);
    sparseArray[1] = "present";
    let proxyReads = 0;
    const proxied = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          proxyReads += 1;
          return Object.prototype;
        },
      },
    );
    for (const value of [
      { number: Number.NaN },
      { number: Number.POSITIVE_INFINITY },
      { number: Number.MAX_SAFE_INTEGER + 1 },
      { text: "lone-surrogate-\ud800" },
      { nested: new Date("2026-08-14T20:00:00.000Z") },
      { nested: undefined },
      { nested: () => 1 },
      { nested: accessorArray },
      { nested: sparseArray },
      { nested: proxied },
      cyclic,
    ])
      await expect(
        repository.putRecords([eventRecord({ value })]),
      ).rejects.toThrow("provider-landing-record-invalid");
    expect(accessorReads).toBe(0);
    expect(proxyReads).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
