import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  SCOUTING_WORKFLOW_INTENT,
  completeScoutingAttemptWithReport,
  completeScoutingJobWithReport,
  createQueuedScoutingRecords,
  validateScoutingAttempt,
  validateScoutingDispatchOutbox,
  validateScoutingJob,
  type ScoutingJobCommand,
} from "@find-the-edge/domain";
import { DynamoScoutingJobRepository } from "./dynamodb-scouting-job-repository";

const now = "2026-08-07T12:00:00.000Z";
const command: ScoutingJobCommand = {
  schemaVersion: 1,
  requesterId: "user-1",
  idempotencyKey: "request-1",
  eventId: "baseball:mlb:event-1",
  eventVersion: 9,
  workflowIntent: SCOUTING_WORKFLOW_INTENT,
};

const eventPointerItem = (
  version = command.eventVersion,
  status = "scheduled",
) => ({
  pk: `EVENT_DETAIL#${command.eventId}`,
  sk: "CURRENT",
  value: {
    schemaVersion: 1,
    eventId: command.eventId,
    materialVersion: version,
    sportPk: `EVENTS#SPORT#baseball#STATUS#${status}#DAY#2026-08-07`,
    sportSk: `2026-08-07T20:00:00.000Z#${command.eventId}#${String(version).padStart(16, "0")}`,
    leaguePk: `EVENTS#SPORT#baseball#LEAGUE#mlb#STATUS#${status}#DAY#2026-08-07`,
    leagueSk: `2026-08-07T20:00:00.000Z#${command.eventId}#${String(version).padStart(16, "0")}`,
  },
});

const activeLockItem = (
  job: ReturnType<typeof createQueuedScoutingRecords>["job"],
  attemptId = job.currentAttemptId,
) => ({
  pk: `SCOUT_ACTIVE#${job.semanticDigest}`,
  sk: "CURRENT",
  entityType: "scouting-active-lock",
  value: {
    semanticDigest: job.semanticDigest,
    jobId: job.jobId,
    attemptId,
  },
});

type CommandLike = {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
};

class CreateTransactionClient {
  readonly commands: CommandLike[] = [];
  private readonly items = new Map<string, Record<string, unknown>>();

  constructor() {
    this.put(eventPointerItem());
  }

  private key(value: { readonly pk: string; readonly sk: string }) {
    return `${value.pk}\0${value.sk}`;
  }
  private put(value: Record<string, unknown>) {
    this.items.set(
      this.key(value as { pk: string; sk: string }),
      structuredClone(value),
    );
  }
  private fail(): never {
    const error = new Error("conditional transaction");
    error.name = "TransactionCanceledException";
    Object.assign(error, {
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    throw error;
  }

  async send(raw: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const commandValue = raw as CommandLike;
    this.commands.push(commandValue);
    if (commandValue.constructor.name === "GetCommand") {
      const key = commandValue.input["Key"] as { pk: string; sk: string };
      const item = this.items.get(this.key(key));
      return item ? { Item: structuredClone(item) } : {};
    }
    if (commandValue.constructor.name !== "TransactWriteCommand") return {};
    const actions = commandValue.input["TransactItems"] as readonly Record<
      string,
      {
        Key?: { pk: string; sk: string };
        Item?: Record<string, unknown>;
        ExpressionAttributeValues?: Record<string, unknown>;
      }
    >[];
    for (const action of actions) {
      if (action["Put"]?.Item) {
        const item = action["Put"].Item;
        if (this.items.has(this.key(item as { pk: string; sk: string })))
          this.fail();
      }
      const check = action["ConditionCheck"];
      if (check?.Key) {
        const checkKey = check.Key;
        const item = this.items.get(this.key(checkKey));
        if (!item) this.fail();
        const expected = check.ExpressionAttributeValues ?? {};
        const value = item["value"] as Record<string, unknown>;
        if (
          checkKey.pk.startsWith("EVENT_DETAIL#") &&
          JSON.stringify(value) !== JSON.stringify(expected[":pointer"])
        )
          this.fail();
        if (
          checkKey.pk.startsWith("SCOUT_ACTIVE#") &&
          (value["jobId"] !== expected[":jobId"] ||
            value["attemptId"] !== expected[":attemptId"])
        )
          this.fail();
        if (
          checkKey.pk.startsWith("SCOUT_JOB#") &&
          (value["jobId"] !== expected[":jobId"] ||
            value["semanticDigest"] !== expected[":semanticDigest"])
        )
          this.fail();
      }
    }
    for (const action of actions)
      if (action["Put"]?.Item) this.put(action["Put"].Item);
    return {};
  }
}

describe("Dynamo scouting job repository", () => {
  it("atomically converges equivalent concurrent creates using exact keys", async () => {
    const client = new CreateTransactionClient();
    const repo = new DynamoScoutingJobRepository(
      client as unknown as DynamoDBDocumentClient,
      "table",
    );
    const [first, second] = await Promise.all([
      repo.createJob({ command, createdAt: now }),
      repo.createJob({
        command: { ...command, idempotencyKey: "request-2" },
        createdAt: now,
      }),
    ]);
    expect(new Set([first.job.jobId, second.job.jobId]).size).toBe(1);
    expect([first.outcome, second.outcome].sort()).toEqual([
      "active-convergence",
      "created",
    ]);
    await expect(
      repo.createJob({ command, createdAt: now }),
    ).resolves.toMatchObject({
      outcome: "request-replay",
      job: { jobId: first.job.jobId },
    });
    await expect(
      repo.getCreateReplay({
        requesterId: command.requesterId,
        idempotencyKey: command.idempotencyKey,
        eventId: command.eventId,
      }),
    ).resolves.toEqual(first.job);
    await expect(
      repo.getCreateReplay({
        requesterId: command.requesterId,
        idempotencyKey: command.idempotencyKey,
        eventId: "baseball:mlb:different-event",
      }),
    ).rejects.toMatchObject({ code: "scouting-idempotency-conflict" });
    await expect(
      repo.getCreateReplay({
        requesterId: command.requesterId,
        idempotencyKey: "missing-request",
        eventId: command.eventId,
      }),
    ).resolves.toBeNull();
    await expect(
      repo.createJob({
        command: { ...command, eventVersion: 10 },
        createdAt: now,
      }),
    ).rejects.toMatchObject({ code: "scouting-idempotency-conflict" });
    const rendered = JSON.stringify(
      client.commands.map(({ constructor, input }) => ({
        name: constructor.name,
        input,
      })),
    );
    expect(rendered).toContain("EVENT_DETAIL#");
    expect(rendered).toContain("#STATUS#scheduled#");
    expect(rendered).toContain("SCOUT_REQUEST#");
    expect(rendered).toContain("SCOUT_ACTIVE#");
    expect(rendered).toContain("SCOUT_JOB#");
    expect(rendered).toContain("SCOUT_ATTEMPT#");
    expect(rendered).toContain("SCOUT_OUTBOX#");
    expect(rendered).toContain('"entityType":"scouting-dispatch-outbox"');
    expect(rendered).toContain('"outboxStatus":"pending"');
    expect(rendered).not.toContain("ScanCommand");
    expect(rendered).not.toContain("FilterExpression");
  });

  it("durably binds a create loser after its winner already completed", async () => {
    const queued = createQueuedScoutingRecords(command, now);
    const completedJob = validateScoutingJob({
      ...queued.job,
      status: "completed",
      stateVersion: 3,
      updatedAt: "2026-08-07T12:02:00.000Z",
    });
    const completedAttempt = validateScoutingAttempt({
      ...queued.attempt,
      status: "completed",
      stateVersion: 3,
      updatedAt: "2026-08-07T12:02:00.000Z",
      startedAt: "2026-08-07T12:01:00.000Z",
      finishedAt: "2026-08-07T12:02:00.000Z",
    });
    let transactionCount = 0;
    const client = {
      async send(raw: unknown) {
        await Promise.resolve();
        const value = raw as CommandLike;
        if (value.constructor.name === "TransactWriteCommand") {
          transactionCount += 1;
          if (transactionCount === 1) {
            const error = new Error("lost create race");
            error.name = "ConditionalCheckFailedException";
            throw error;
          }
          return {};
        }
        const key = value.input["Key"] as { pk: string };
        if (key.pk.startsWith("EVENT_DETAIL#"))
          return { Item: eventPointerItem() };
        if (key.pk.startsWith("SCOUT_REQUEST#")) return {};
        if (key.pk.startsWith("SCOUT_ACTIVE#"))
          return {
            Item: {
              ...activeLockItem(completedJob),
              entityType: "scouting-active-tombstone",
            },
          };
        if (key.pk.startsWith("SCOUT_JOB#"))
          return {
            Item: { entityType: "scouting-job", value: completedJob },
          };
        if (key.pk.startsWith("SCOUT_ATTEMPT#"))
          return {
            Item: {
              entityType: "scouting-attempt",
              value: completedAttempt,
            },
          };
        if (key.pk.startsWith("SCOUT_OUTBOX#"))
          return {
            Item: {
              entityType: "scouting-dispatch-outbox",
              outboxStatus: queued.outbox.status,
              value: queued.outbox,
            },
          };
        return {};
      },
    } as unknown as DynamoDBDocumentClient;

    await expect(
      new DynamoScoutingJobRepository(client, "table").createJob({
        command: { ...command, idempotencyKey: "concurrent-loser" },
        createdAt: now,
      }),
    ).resolves.toMatchObject({
      outcome: "active-convergence",
      job: { jobId: completedJob.jobId, status: "completed" },
    });
    expect(transactionCount).toBe(2);
  });

  it("fences claims by job, attempt, state version, and current event pointer", async () => {
    const records = createQueuedScoutingRecords(command, now);
    const commands: CommandLike[] = [];
    const client = {
      async send(raw: unknown) {
        await Promise.resolve();
        const value = raw as CommandLike;
        commands.push(value);
        if (value.constructor.name === "GetCommand") {
          const key = value.input["Key"] as { pk: string };
          if (key.pk.startsWith("EVENT_DETAIL#"))
            return { Item: eventPointerItem() };
          if (key.pk.startsWith("SCOUT_JOB#"))
            return { Item: { entityType: "scouting-job", value: records.job } };
          return {
            Item: { entityType: "scouting-attempt", value: records.attempt },
          };
        }
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoScoutingJobRepository(client, "table");
    await expect(
      repo.claimAttempt({
        jobId: records.job.jobId,
        attemptId: records.attempt.attemptId,
        eventId: command.eventId,
        eventVersion: command.eventVersion,
        claimedAt: "2026-08-07T12:01:00.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "claimed" });
    const transaction = commands.find(
      ({ constructor }) => constructor.name === "TransactWriteCommand",
    );
    const rendered = JSON.stringify(transaction?.input);
    expect(rendered).toContain("#value=:pointer");
    expect(rendered).toContain("#value.#currentAttemptId=:attemptId");
    expect(rendered).toContain("#value.#stateVersion=:version");
    expect(rendered).toContain('"status":"in_progress"');
    expect(rendered).not.toContain("ScanCommand");
  });

  it("atomically finishes the exact current attempt and releases its active lock", async () => {
    const queued = createQueuedScoutingRecords(command, now);
    const job = validateScoutingJob({
      ...queued.job,
      status: "in_progress",
      stateVersion: 2,
      updatedAt: "2026-08-07T12:01:00.000Z",
    });
    const attempt = validateScoutingAttempt({
      ...queued.attempt,
      status: "in_progress",
      stateVersion: 2,
      updatedAt: "2026-08-07T12:01:00.000Z",
      startedAt: "2026-08-07T12:01:00.000Z",
    });
    const commands: CommandLike[] = [];
    const client = {
      async send(raw: unknown) {
        await Promise.resolve();
        const value = raw as CommandLike;
        commands.push(value);
        if (value.constructor.name !== "GetCommand") return {};
        const key = value.input["Key"] as { pk: string };
        if (key.pk.startsWith("SCOUT_JOB#"))
          return { Item: { entityType: "scouting-job", value: job } };
        if (key.pk.startsWith("SCOUT_ATTEMPT#"))
          return { Item: { entityType: "scouting-attempt", value: attempt } };
        if (key.pk.startsWith("SCOUT_ACTIVE#"))
          return { Item: activeLockItem(job) };
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoScoutingJobRepository(client, "table");
    await expect(
      repo.finishAttempt({
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        status: "failed_terminal",
        failureCode: "fixture-contract-invalid",
        finishedAt: "2026-08-07T12:02:00.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "finished", job: { stateVersion: 3 } });
    const transaction = commands.find(
      ({ constructor }) => constructor.name === "TransactWriteCommand",
    );
    const rendered = JSON.stringify(transaction?.input);
    expect(rendered).toContain('"entityType":"scouting-active-tombstone"');
    expect(rendered).toContain("SCOUT_ACTIVE#");
    expect(rendered).toContain('"status":"failed_terminal"');
    expect(rendered).toContain('":version":2');
    expect(rendered).toContain('":attemptId":"' + attempt.attemptId + '"');
  });

  it("retries with event, state-version, active-lock, immutable attempt, receipt, and outbox fences", async () => {
    const queued = createQueuedScoutingRecords(command, now);
    const failedJob = validateScoutingJob({
      ...queued.job,
      status: "failed_retryable",
      stateVersion: 2,
      updatedAt: "2026-08-07T12:01:00.000Z",
      failureCode: "workflow-timeout",
    });
    const commands: CommandLike[] = [];
    const client = {
      async send(raw: unknown) {
        await Promise.resolve();
        const value = raw as CommandLike;
        commands.push(value);
        if (value.constructor.name !== "GetCommand") return {};
        const key = value.input["Key"] as { pk: string };
        if (key.pk.startsWith("SCOUT_JOB#"))
          return { Item: { entityType: "scouting-job", value: failedJob } };
        if (key.pk.startsWith("EVENT_DETAIL#"))
          return { Item: eventPointerItem() };
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoScoutingJobRepository(client, "table");
    const retried = await repo.retryJob({
      jobId: failedJob.jobId,
      requesterId: failedJob.requesterId,
      idempotencyKey: "retry-1",
      expectedStateVersion: 2,
      requestedAt: "2026-08-07T12:02:00.000Z",
    });
    expect(retried).toMatchObject({
      outcome: "retried",
      job: { status: "queued", stateVersion: 3, attemptCount: 2 },
      attempt: {
        attemptNumber: 2,
        previousAttemptId: queued.attempt.attemptId,
      },
      outbox: { status: "pending", version: 1 },
    });
    const transaction = commands.find(
      ({ constructor }) => constructor.name === "TransactWriteCommand",
    );
    const rendered = JSON.stringify(transaction?.input);
    expect(rendered).toContain("EVENT_DETAIL#");
    expect(rendered).toContain("SCOUT_ACTIVE#");
    expect(rendered).toContain("SCOUT_REQUEST#");
    expect(rendered).toContain("SCOUT_ATTEMPT#");
    expect(rendered).toContain("SCOUT_OUTBOX#");
    expect(rendered).toContain('":version":2');
    await expect(
      repo.retryJob({
        jobId: failedJob.jobId,
        requesterId: failedJob.requesterId,
        idempotencyKey: "late-retry",
        expectedStateVersion: 1,
        requestedAt: "2026-08-07T12:02:01.000Z",
      }),
    ).rejects.toMatchObject({ code: "scouting-retry-not-allowed" });
  });

  it("publishes only the exact pending outbox version", async () => {
    const records = createQueuedScoutingRecords(command, now);
    const commands: CommandLike[] = [];
    const client = {
      async send(raw: unknown) {
        await Promise.resolve();
        const value = raw as CommandLike;
        commands.push(value);
        if (value.constructor.name === "GetCommand")
          return {
            Item: {
              entityType: "scouting-dispatch-outbox",
              outboxStatus: "pending",
              value: records.outbox,
            },
          };
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoScoutingJobRepository(client, "table");
    const published = await repo.markOutboxPublished({
      outboxId: records.outbox.outboxId,
      attemptId: records.attempt.attemptId,
      expectedVersion: 1,
      publishedAt: "2026-08-07T12:00:01.000Z",
    });
    expect(validateScoutingDispatchOutbox(published)).toMatchObject({
      status: "published",
      version: 2,
    });
    const update = commands.find(
      ({ constructor }) => constructor.name === "UpdateCommand",
    );
    expect(JSON.stringify(update?.input)).toContain(
      "#entityType=:entityType AND #outboxStatus=:pending AND #value.#attemptId=:attemptId AND #value.#version=:version",
    );
  });

  it("fails closed on corrupt records and propagates non-conditional service cancellations", async () => {
    const records = createQueuedScoutingRecords(command, now);
    const corruptClient = {
      send: () =>
        Promise.resolve({
          Item: {
            entityType: "scouting-job",
            value: { ...records.job, stateVersion: 0 },
          },
        }),
    } as unknown as DynamoDBDocumentClient;
    await expect(
      new DynamoScoutingJobRepository(corruptClient, "table").getJob(
        records.job.jobId,
      ),
    ).rejects.toMatchObject({ code: "scouting-record-corrupt" });

    const cancellation = new Error("throughput cancellation");
    cancellation.name = "TransactionCanceledException";
    const cancelledClient = {
      send: () => Promise.reject(cancellation),
    } as unknown as DynamoDBDocumentClient;
    await expect(
      new DynamoScoutingJobRepository(cancelledClient, "table").createJob({
        command,
        createdAt: now,
      }),
    ).rejects.toBe(cancellation);

    const serviceError = new Error("throttled");
    serviceError.name = "ProvisionedThroughputExceededException";
    const serviceClient = {
      send: () => Promise.reject(serviceError),
    } as unknown as DynamoDBDocumentClient;
    await expect(
      new DynamoScoutingJobRepository(serviceClient, "table").createJob({
        command,
        createdAt: now,
      }),
    ).rejects.toBe(serviceError);
  });

  it("rejects loose receipt and active-lock shapes after a conditional collision", async () => {
    const conditionalError = () => {
      const error = new Error("condition");
      error.name = "ConditionalCheckFailedException";
      return error;
    };
    const receiptClient = {
      send(raw: unknown) {
        const value = raw as CommandLike;
        if (value.constructor.name === "TransactWriteCommand")
          return Promise.reject(conditionalError());
        const key = value.input["Key"] as { pk: string };
        if (key.pk.startsWith("EVENT_DETAIL#"))
          return Promise.resolve({ Item: eventPointerItem() });
        return Promise.resolve(
          key.pk.startsWith("SCOUT_REQUEST#")
            ? {
                Item: {
                  pk: key.pk,
                  sk: "CURRENT",
                  entityType: "scouting-request-receipt",
                  unexpected: true,
                  value: {
                    requesterId: command.requesterId,
                    idempotencyKey: command.idempotencyKey,
                    action: "create",
                    digest: "a".repeat(64),
                    jobId: `scout-job:${"b".repeat(64)}`,
                  },
                },
              }
            : {},
        );
      },
    } as unknown as DynamoDBDocumentClient;
    await expect(
      new DynamoScoutingJobRepository(receiptClient, "table").createJob({
        command,
        createdAt: now,
      }),
    ).rejects.toMatchObject({ code: "scouting-record-corrupt" });

    const activeClient = {
      send(raw: unknown) {
        const value = raw as CommandLike;
        if (value.constructor.name === "TransactWriteCommand")
          return Promise.reject(conditionalError());
        const key = value.input["Key"] as { pk: string };
        if (key.pk.startsWith("EVENT_DETAIL#"))
          return Promise.resolve({ Item: eventPointerItem() });
        if (key.pk.startsWith("SCOUT_ACTIVE#"))
          return Promise.resolve({
            Item: {
              pk: key.pk,
              sk: "CURRENT",
              entityType: "scouting-active-lock",
              value: {
                semanticDigest: "a".repeat(64),
                jobId: `scout-job:${"b".repeat(64)}`,
                attemptId: `scout-attempt:${"c".repeat(64)}`,
                extra: true,
              },
            },
          });
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    await expect(
      new DynamoScoutingJobRepository(activeClient, "table").createJob({
        command,
        createdAt: now,
      }),
    ).rejects.toMatchObject({ code: "scouting-record-corrupt" });
  });

  it("reads schema-v2 completed rows and refuses reportless completion", async () => {
    const queued = createQueuedScoutingRecords(command, now);
    const claimedJob = validateScoutingJob({
      ...queued.job,
      status: "in_progress",
      stateVersion: 2,
      updatedAt: "2026-08-07T12:01:00.000Z",
    });
    const claimedAttempt = validateScoutingAttempt({
      ...queued.attempt,
      status: "in_progress",
      stateVersion: 2,
      updatedAt: "2026-08-07T12:01:00.000Z",
      startedAt: "2026-08-07T12:01:00.000Z",
    });
    const binding = {
      reportId: `scout-report:${"a".repeat(64)}`,
      reportVersionId: `scout-report-version:${"b".repeat(64)}`,
      reportVersionNumber: 1,
    };
    const completedJob = completeScoutingJobWithReport(
      claimedJob,
      binding,
      "2026-08-07T12:02:00.000Z",
    );
    const completedAttempt = completeScoutingAttemptWithReport(
      claimedAttempt,
      binding,
      "2026-08-07T12:02:00.000Z",
    );
    const client = {
      send(raw: unknown) {
        const value = raw as CommandLike;
        if (value.constructor.name !== "GetCommand")
          return Promise.reject(new Error("unexpected-write"));
        const key = value.input["Key"] as { pk: string };
        if (key.pk.startsWith("SCOUT_JOB#"))
          return Promise.resolve({
            Item: { entityType: "scouting-job", value: completedJob },
          });
        if (key.pk.startsWith("SCOUT_ATTEMPT#"))
          return Promise.resolve({
            Item: { entityType: "scouting-attempt", value: completedAttempt },
          });
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoScoutingJobRepository(client, "table");

    // Schema-v2 rows written by the report completion transaction read back
    // with their report pointer intact.
    await expect(repo.getJob(completedJob.jobId)).resolves.toMatchObject({
      schemaVersion: 2,
      status: "completed",
      reportPointer: binding,
    });
    // A redelivered failure finalizer is acknowledged as stale, not corrupt.
    await expect(
      repo.finishAttempt({
        jobId: completedJob.jobId,
        attemptId: completedAttempt.attemptId,
        status: "failed_retryable",
        failureCode: "workflow-temporarily-unavailable",
        finishedAt: "2026-08-07T12:03:00.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "stale" });
    // The runtime fence rejects untyped reportless completion before any IO.
    const failingClient = {
      send: () => Promise.reject(new Error("must-not-touch-storage")),
    } as unknown as DynamoDBDocumentClient;
    await expect(
      new DynamoScoutingJobRepository(failingClient, "table").finishAttempt({
        jobId: completedJob.jobId,
        attemptId: completedAttempt.attemptId,
        status: "completed",
        finishedAt: "2026-08-07T12:03:00.000Z",
      } as never),
    ).rejects.toThrow("report-pointer-required");
  });
});
