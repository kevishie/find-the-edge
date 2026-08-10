import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  SCOUTING_MAX_ATTEMPTS,
  assertScoutingJobTransition,
  assertScoutingTimestamp,
  createQueuedScoutingRecords,
  createScoutingAttemptId,
  createScoutingCommandDigest,
  createScoutingJobId,
  createScoutingOutboxId,
  createScoutingRequestReceiptId,
  isRetryableScoutingFailure,
  normalizeScoutingJobCommand,
  readScoutingAttemptRecord,
  readScoutingJobRecord,
  sha256Hex,
  validateScoutingAttempt,
  validateScoutingDispatchOutbox,
  validateScoutingJob,
  type ScoutingAttempt,
  type ScoutingDispatchOutbox,
  type ScoutingJob,
} from "@find-the-edge/domain";
import {
  ScoutingRepositoryError,
  assertScoutingFinishableStatus,
  type ScoutingClaimResult,
  type ScoutingCreateOutcome,
  type ScoutingCreateResult,
  type ScoutingFinishResult,
  type ScoutingJobRepository,
  type ScoutingRetryResult,
  type StoredScoutingAttempt,
  type StoredScoutingJob,
} from "./scouting-job-repository";

type StoredReceipt = {
  readonly requesterId: string;
  readonly idempotencyKey: string;
  readonly action: "create" | "retry";
  readonly digest: string;
  readonly jobId: string;
};

type StoredActiveLock = {
  readonly semanticDigest: string;
  readonly jobId: string;
  readonly attemptId: string;
};

type StoredSemanticMarker = StoredActiveLock & {
  readonly kind: "active" | "terminal";
};

type StoredEventPointer = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly materialVersion: number;
  readonly sportPk: string;
  readonly sportSk: string;
  readonly leaguePk: string;
  readonly leagueSk: string;
};

type EventInvalidFailureCode =
  "event-version-changed" | "event-no-longer-scheduled";

const jobKey = (jobId: string) => ({ pk: `SCOUT_JOB#${jobId}`, sk: "CURRENT" });
const attemptKey = (attemptId: string) => ({
  pk: `SCOUT_ATTEMPT#${attemptId}`,
  sk: "CURRENT",
});
const outboxKey = (outboxId: string) => ({
  pk: `SCOUT_OUTBOX#${outboxId}`,
  sk: "CURRENT",
});
const receiptKey = (receiptId: string) => ({
  pk: `SCOUT_REQUEST#${receiptId}`,
  sk: "CURRENT",
});
const activeKey = (semanticDigest: string) => ({
  pk: `SCOUT_ACTIVE#${semanticDigest}`,
  sk: "CURRENT",
});
const eventKey = (eventId: string) => ({
  pk: `EVENT_DETAIL#${eventId}`,
  sk: "CURRENT",
});

/**
 * Exact-key builders shared with the FTE-042 report repository so its atomic
 * completion transaction can cover the same job, attempt, active-lock, and
 * canonical event items. Additive exports only; behavior is unchanged.
 */
export const scoutingJobItemKey = jobKey;
export const scoutingAttemptItemKey = attemptKey;
export const scoutingActiveLockItemKey = activeKey;
export const scoutingEventDetailItemKey = eventKey;

const conditional = (error: unknown): boolean =>
  error instanceof Error &&
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    error.name,
  );

const safeTransactionConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  if (error.name !== "TransactionCanceledException") return false;
  const reasons = (
    error as Error & { CancellationReasons?: readonly { Code?: string }[] }
  ).CancellationReasons;
  return (
    !!reasons?.length &&
    reasons.every(({ Code }) =>
      [undefined, "None", "ConditionalCheckFailed"].includes(Code),
    )
  );
};

const retryReceiptId = (requesterId: string, idempotencyKey: string) =>
  sha256Hex(
    `fte:scouting-request:v1:${JSON.stringify({ requesterId, idempotencyKey })}`,
  );
const retryDigest = (
  jobId: string,
  requesterId: string,
  expectedStateVersion: number,
) =>
  sha256Hex(
    `fte:scouting-retry:v1:${JSON.stringify({ jobId, requesterId, expectedStateVersion })}`,
  );

const jobItem = (job: ScoutingJob) => ({
  ...jobKey(job.jobId),
  entityType: "scouting-job",
  value: job,
});
const attemptItem = (attempt: ScoutingAttempt) => ({
  ...attemptKey(attempt.attemptId),
  entityType: "scouting-attempt",
  value: attempt,
});
const outboxItem = (outbox: ScoutingDispatchOutbox) => ({
  ...outboxKey(outbox.outboxId),
  entityType: "scouting-dispatch-outbox",
  outboxStatus: outbox.status,
  value: outbox,
});

const eventFence = (tableName: string, pointer: StoredEventPointer) => ({
  ConditionCheck: {
    TableName: tableName,
    Key: eventKey(pointer.eventId),
    ConditionExpression: "#value=:pointer AND attribute_not_exists(expiresAt)",
    ExpressionAttributeNames: {
      "#value": "value",
    },
    ExpressionAttributeValues: {
      ":pointer": pointer,
    },
  },
});

const convergedRetry = (
  job: StoredScoutingJob,
  expectedStateVersion: number,
): boolean =>
  job.attemptCount > 1 &&
  ((job.status === "queued" && job.stateVersion === expectedStateVersion + 1) ||
    (job.status === "in_progress" &&
      job.stateVersion === expectedStateVersion + 2));

export class DynamoScoutingJobRepository implements ScoutingJobRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async rawGet(key: { readonly pk: string; readonly sk: string }) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    return result.Item;
  }

  private async eventPointer(
    eventId: string,
    eventVersion: number,
  ): Promise<
    | { readonly pointer: StoredEventPointer; readonly failureCode: null }
    | { readonly pointer: null; readonly failureCode: EventInvalidFailureCode }
  > {
    const item = await this.rawGet(eventKey(eventId));
    if (!item) return { pointer: null, failureCode: "event-version-changed" };
    const value = item["value"] as
      Partial<Record<keyof StoredEventPointer, unknown>> | undefined;
    if (
      Object.keys(item).sort().join("|") !== ["pk", "sk", "value"].join("|") ||
      item["pk"] !== `EVENT_DETAIL#${eventId}` ||
      item["sk"] !== "CURRENT" ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("|") !==
        [
          "eventId",
          "leaguePk",
          "leagueSk",
          "materialVersion",
          "schemaVersion",
          "sportPk",
          "sportSk",
        ].join("|") ||
      value.schemaVersion !== 1 ||
      value.eventId !== eventId ||
      !Number.isSafeInteger(value.materialVersion) ||
      Number(value.materialVersion) < 1 ||
      typeof value.sportPk !== "string" ||
      typeof value.sportSk !== "string" ||
      typeof value.leaguePk !== "string" ||
      typeof value.leagueSk !== "string"
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    const sport =
      /^EVENTS#SPORT#([a-z0-9][a-z0-9_-]{0,63})#STATUS#([a-z_]+)#DAY#(\d{4}-\d{2}-\d{2})$/.exec(
        value.sportPk,
      );
    const league =
      /^EVENTS#SPORT#([a-z0-9][a-z0-9_-]{0,63})#LEAGUE#([a-z0-9][a-z0-9_-]{0,63})#STATUS#([a-z_]+)#DAY#(\d{4}-\d{2}-\d{2})$/.exec(
        value.leaguePk,
      );
    const versionSuffix = `#${eventId}#${String(value.materialVersion).padStart(16, "0")}`;
    if (
      !sport ||
      !league ||
      sport[1] !== league[1] ||
      sport[2] !== league[3] ||
      sport[3] !== league[4] ||
      value.sportSk !== value.leagueSk ||
      !value.sportSk.endsWith(versionSuffix)
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    if (value.materialVersion !== eventVersion)
      return { pointer: null, failureCode: "event-version-changed" };
    if (sport[2] !== "scheduled")
      return { pointer: null, failureCode: "event-no-longer-scheduled" };
    return {
      pointer: value as StoredEventPointer,
      failureCode: null,
    };
  }

  private async semanticMarker(
    semanticDigest: string,
  ): Promise<StoredSemanticMarker | null> {
    const item = await this.rawGet(activeKey(semanticDigest));
    if (!item) return null;
    const value = item["value"] as Partial<StoredActiveLock> | undefined;
    const kind =
      item["entityType"] === "scouting-active-lock"
        ? "active"
        : item["entityType"] === "scouting-active-tombstone"
          ? "terminal"
          : null;
    if (
      Object.keys(item).sort().join("|") !==
        ["entityType", "pk", "sk", "value"].join("|") ||
      !kind ||
      !value ||
      Object.keys(value).sort().join("|") !==
        ["attemptId", "jobId", "semanticDigest"].join("|") ||
      value.semanticDigest !== semanticDigest ||
      typeof value.jobId !== "string" ||
      !/^scout-job:[a-f0-9]{64}$/.test(value.jobId) ||
      typeof value.attemptId !== "string" ||
      !Array.from({ length: SCOUTING_MAX_ATTEMPTS }, (_, index) =>
        createScoutingAttemptId(value.jobId as string, index + 1),
      ).includes(value.attemptId)
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    return { ...(value as StoredActiveLock), kind };
  }

  /**
   * Reads schema-v2 rows (completed with a report pointer) and schema-v1 rows
   * alike; a completed schema-v1 row stays an explicit legacy reportless
   * completion — never corrupt, never silently migrated.
   */
  async getJob(jobId: string): Promise<StoredScoutingJob | null> {
    if (!/^scout-job:[a-f0-9]{64}$/.test(jobId)) return null;
    const item = await this.rawGet(jobKey(jobId));
    if (!item) return null;
    if (item["entityType"] !== "scouting-job")
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    try {
      const read = readScoutingJobRecord(item["value"]);
      if (read.job.jobId !== jobId)
        throw new Error("scouting-job-key-mismatch");
      return read.job;
    } catch {
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    }
  }

  async getJobForRequester(
    jobId: string,
    requesterId: string,
  ): Promise<StoredScoutingJob | null> {
    const job = await this.getJob(jobId);
    return job?.requesterId === requesterId ? job : null;
  }

  async getCreateReplay(
    input: Parameters<ScoutingJobRepository["getCreateReplay"]>[0],
  ): Promise<StoredScoutingJob | null> {
    const probe = normalizeScoutingJobCommand({
      schemaVersion: 1,
      requesterId: input.requesterId,
      idempotencyKey: input.idempotencyKey,
      eventId: input.eventId,
      eventVersion: 1,
      workflowIntent: "fixture-v1",
    });
    const receipt = await this.receipt(createScoutingRequestReceiptId(probe));
    if (!receipt) return null;
    if (
      receipt.requesterId !== input.requesterId ||
      receipt.idempotencyKey !== input.idempotencyKey
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    if (receipt.action !== "create")
      throw new ScoutingRepositoryError("scouting-idempotency-conflict");
    const job = await this.getJob(receipt.jobId);
    if (!job || job.requesterId !== input.requesterId)
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    if (job.eventId !== input.eventId)
      throw new ScoutingRepositoryError("scouting-idempotency-conflict");
    const exactCommand = normalizeScoutingJobCommand({
      ...probe,
      eventVersion: job.eventVersion,
      workflowIntent: job.workflowIntent,
    });
    const commandDigest = createScoutingCommandDigest(exactCommand);
    if (
      receipt.digest !== commandDigest ||
      job.commandDigest !== commandDigest ||
      createScoutingJobId(exactCommand) !== job.jobId
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    return job;
  }

  async getAttempt(attemptId: string): Promise<StoredScoutingAttempt | null> {
    if (!/^scout-attempt:[a-f0-9]{64}$/.test(attemptId)) return null;
    const item = await this.rawGet(attemptKey(attemptId));
    if (!item) return null;
    if (item["entityType"] !== "scouting-attempt")
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    try {
      const read = readScoutingAttemptRecord(item["value"]);
      if (read.attempt.attemptId !== attemptId)
        throw new Error("scouting-attempt-key-mismatch");
      return read.attempt;
    } catch {
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    }
  }

  async getOutbox(outboxId: string): Promise<ScoutingDispatchOutbox | null> {
    if (!/^scout-outbox:[a-f0-9]{64}$/.test(outboxId)) return null;
    const item = await this.rawGet(outboxKey(outboxId));
    if (!item) return null;
    if (
      item["entityType"] !== "scouting-dispatch-outbox" ||
      item["outboxStatus"] !==
        (item["value"] as { status?: unknown } | undefined)?.status
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    try {
      const outbox = validateScoutingDispatchOutbox(item["value"]);
      if (outbox.outboxId !== outboxId)
        throw new Error("scouting-outbox-key-mismatch");
      return outbox;
    } catch {
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    }
  }

  private async receipt(receiptId: string): Promise<StoredReceipt | null> {
    const item = await this.rawGet(receiptKey(receiptId));
    if (!item) return null;
    const value = item["value"] as Partial<StoredReceipt> | undefined;
    if (
      Object.keys(item).sort().join("|") !==
        ["pk", "sk", "entityType", "value"].sort().join("|") ||
      item["entityType"] !== "scouting-request-receipt" ||
      !value ||
      Object.keys(value).sort().join("|") !==
        ["requesterId", "idempotencyKey", "action", "digest", "jobId"]
          .sort()
          .join("|") ||
      typeof value.requesterId !== "string" ||
      !/^[A-Za-z0-9._:@/-]{1,256}$/.test(value.requesterId) ||
      typeof value.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value.idempotencyKey) ||
      !["create", "retry"].includes(String(value.action)) ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      typeof value.jobId !== "string" ||
      !/^scout-job:[a-f0-9]{64}$/.test(value.jobId) ||
      retryReceiptId(value.requesterId, value.idempotencyKey) !== receiptId
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    return value as StoredReceipt;
  }

  private async records(
    jobId: string,
    outcome: ScoutingCreateOutcome,
  ): Promise<ScoutingCreateResult> {
    const job = await this.getJob(jobId);
    const attempt = job ? await this.getAttempt(job.currentAttemptId) : null;
    const outbox = attempt
      ? await this.getOutbox(createScoutingOutboxId(attempt.attemptId))
      : null;
    if (!job || !attempt || !outbox)
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    return { outcome, job, attempt, outbox };
  }

  private validateReceipt(
    receipt: StoredReceipt,
    expected: Omit<StoredReceipt, "jobId">,
  ) {
    if (
      receipt.requesterId !== expected.requesterId ||
      receipt.idempotencyKey !== expected.idempotencyKey ||
      receipt.action !== expected.action ||
      receipt.digest !== expected.digest
    )
      throw new ScoutingRepositoryError("scouting-idempotency-conflict");
  }

  async createJob(
    input: Parameters<ScoutingJobRepository["createJob"]>[0],
  ): Promise<ScoutingCreateResult> {
    const records = createQueuedScoutingRecords(input.command, input.createdAt);
    const receiptId = createScoutingRequestReceiptId(input.command);
    const receipt: StoredReceipt = {
      requesterId: input.command.requesterId,
      idempotencyKey: input.command.idempotencyKey,
      action: "create",
      digest: records.job.commandDigest,
      jobId: records.job.jobId,
    };
    const existingReceipt = await this.receipt(receiptId);
    if (existingReceipt) {
      this.validateReceipt(existingReceipt, {
        requesterId: receipt.requesterId,
        idempotencyKey: receipt.idempotencyKey,
        action: "create",
        digest: receipt.digest,
      });
      return this.records(existingReceipt.jobId, "request-replay");
    }
    const event = await this.eventPointer(
      records.job.eventId,
      records.job.eventVersion,
    );
    if (!event.pointer)
      throw new ScoutingRepositoryError("scouting-event-version-conflict");
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            eventFence(this.tableName, event.pointer),
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...receiptKey(receiptId),
                  entityType: "scouting-request-receipt",
                  value: receipt,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...activeKey(records.job.semanticDigest),
                  entityType: "scouting-active-lock",
                  value: {
                    semanticDigest: records.job.semanticDigest,
                    jobId: records.job.jobId,
                    attemptId: records.attempt.attemptId,
                  },
                },
                ConditionExpression:
                  "(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR #entityType=:terminalMarker",
                ExpressionAttributeNames: { "#entityType": "entityType" },
                ExpressionAttributeValues: {
                  ":terminalMarker": "scouting-active-tombstone",
                },
              },
            },
            ...[
              jobItem(records.job),
              attemptItem(records.attempt),
              outboxItem(records.outbox),
            ].map((Item) => ({
              Put: {
                TableName: this.tableName,
                Item,
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            })),
          ],
        }),
      );
      return { outcome: "created", ...records };
    } catch (error) {
      if (!safeTransactionConflict(error)) throw error;
    }

    const replay = await this.receipt(receiptId);
    if (replay) {
      this.validateReceipt(replay, {
        requesterId: receipt.requesterId,
        idempotencyKey: receipt.idempotencyKey,
        action: "create",
        digest: receipt.digest,
      });
      return this.records(replay.jobId, "request-replay");
    }
    const active = await this.semanticMarker(records.job.semanticDigest);
    if (!active) {
      const latestEvent = await this.eventPointer(
        records.job.eventId,
        records.job.eventVersion,
      );
      throw new ScoutingRepositoryError(
        latestEvent.pointer
          ? "scouting-record-corrupt"
          : "scouting-event-version-conflict",
      );
    }
    const winner = await this.records(active.jobId, "active-convergence");
    if (
      winner.job.semanticDigest !== records.job.semanticDigest ||
      (active.kind === "active"
        ? !["queued", "in_progress"].includes(winner.job.status)
        : ![
            "completed",
            "failed_retryable",
            "failed_terminal",
            "cancelled",
          ].includes(winner.job.status))
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    const convergedReceipt = { ...receipt, jobId: winner.job.jobId };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: jobKey(winner.job.jobId),
                ConditionExpression:
                  "#value.#jobId=:jobId AND #value.#semanticDigest=:semanticDigest",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#jobId": "jobId",
                  "#semanticDigest": "semanticDigest",
                },
                ExpressionAttributeValues: {
                  ":jobId": winner.job.jobId,
                  ":semanticDigest": winner.job.semanticDigest,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...receiptKey(receiptId),
                  entityType: "scouting-request-receipt",
                  value: convergedReceipt,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!safeTransactionConflict(error)) throw error;
      const racedReceipt = await this.receipt(receiptId);
      if (!racedReceipt)
        throw new ScoutingRepositoryError("scouting-record-corrupt");
      this.validateReceipt(racedReceipt, {
        requesterId: receipt.requesterId,
        idempotencyKey: receipt.idempotencyKey,
        action: "create",
        digest: receipt.digest,
      });
      if (racedReceipt.jobId !== winner.job.jobId)
        throw new ScoutingRepositoryError("scouting-record-corrupt");
    }
    return winner;
  }

  async claimAttempt(
    input: Parameters<ScoutingJobRepository["claimAttempt"]>[0],
  ): Promise<ScoutingClaimResult> {
    assertScoutingTimestamp(input.claimedAt);
    const [job, attempt] = await Promise.all([
      this.getJob(input.jobId),
      this.getAttempt(input.attemptId),
    ]);
    if (!job || !attempt || job.currentAttemptId !== input.attemptId)
      return { outcome: "stale", job, attempt };
    if (
      job.eventId !== input.eventId ||
      job.eventVersion !== input.eventVersion
    )
      return { outcome: "stale", job, attempt };
    if (job.status === "in_progress" && attempt.status === "in_progress")
      return { outcome: "duplicate", job, attempt };
    if (job.status !== "queued" || attempt.status !== "queued")
      return { outcome: "stale", job, attempt };
    const event = await this.eventPointer(input.eventId, input.eventVersion);
    if (!event.pointer)
      return {
        outcome: "event-invalid",
        job,
        attempt,
        failureCode: event.failureCode,
      };
    assertScoutingJobTransition(job.status, "in_progress");
    const nextJob = validateScoutingJob({
      ...job,
      status: "in_progress",
      stateVersion: job.stateVersion + 1,
      updatedAt: input.claimedAt,
    });
    const nextAttempt = validateScoutingAttempt({
      ...attempt,
      status: "in_progress",
      stateVersion: attempt.stateVersion + 1,
      updatedAt: input.claimedAt,
      startedAt: input.claimedAt,
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            eventFence(this.tableName, event.pointer),
            this.fencedJobPut(job, nextJob),
            this.fencedAttemptPut(attempt, nextAttempt),
          ],
        }),
      );
      return { outcome: "claimed", job: nextJob, attempt: nextAttempt };
    } catch (error) {
      if (!safeTransactionConflict(error)) throw error;
      const [latestJob, latestAttempt] = await Promise.all([
        this.getJob(input.jobId),
        this.getAttempt(input.attemptId),
      ]);
      if (
        latestJob?.currentAttemptId === input.attemptId &&
        latestJob.status === "queued" &&
        latestAttempt?.status === "queued"
      ) {
        const latestEvent = await this.eventPointer(
          input.eventId,
          input.eventVersion,
        );
        if (!latestEvent.pointer)
          return {
            outcome: "event-invalid",
            job: latestJob,
            attempt: latestAttempt,
            failureCode: latestEvent.failureCode,
          };
      }
      return latestJob?.currentAttemptId === input.attemptId &&
        latestJob.status === "in_progress" &&
        latestAttempt?.status === "in_progress"
        ? { outcome: "duplicate", job: latestJob, attempt: latestAttempt }
        : { outcome: "stale", job: latestJob, attempt: latestAttempt };
    }
  }

  private fencedJobPut(previous: StoredScoutingJob, next: ScoutingJob) {
    return {
      Put: {
        TableName: this.tableName,
        Item: jobItem(next),
        ConditionExpression:
          "#value.#stateVersion=:version AND #value.#status=:status AND #value.#currentAttemptId=:attemptId",
        ExpressionAttributeNames: {
          "#value": "value",
          "#stateVersion": "stateVersion",
          "#status": "status",
          "#currentAttemptId": "currentAttemptId",
        },
        ExpressionAttributeValues: {
          ":version": previous.stateVersion,
          ":status": previous.status,
          ":attemptId": previous.currentAttemptId,
        },
      },
    };
  }

  private fencedAttemptPut(
    previous: StoredScoutingAttempt,
    next: ScoutingAttempt,
  ) {
    return {
      Put: {
        TableName: this.tableName,
        Item: attemptItem(next),
        ConditionExpression:
          "#value.#stateVersion=:version AND #value.#status=:status AND #value.#jobId=:jobId",
        ExpressionAttributeNames: {
          "#value": "value",
          "#stateVersion": "stateVersion",
          "#status": "status",
          "#jobId": "jobId",
        },
        ExpressionAttributeValues: {
          ":version": previous.stateVersion,
          ":status": previous.status,
          ":jobId": previous.jobId,
        },
      },
    };
  }

  async finishAttempt(
    input: Parameters<ScoutingJobRepository["finishAttempt"]>[0],
  ): Promise<ScoutingFinishResult> {
    assertScoutingFinishableStatus(input.status);
    assertScoutingTimestamp(input.finishedAt);
    const [job, attempt] = await Promise.all([
      this.getJob(input.jobId),
      this.getAttempt(input.attemptId),
    ]);
    if (!job || !attempt || job.currentAttemptId !== input.attemptId)
      return { outcome: "stale", job, attempt };
    if (
      job.status === input.status &&
      attempt.status === input.status &&
      job.failureCode === input.failureCode &&
      attempt.failureCode === input.failureCode
    )
      return { outcome: "duplicate", job, attempt };
    const matchingSource = job.status === attempt.status;
    const canFinish = job.status === "in_progress" || job.status === "queued";
    if (!matchingSource || !canFinish)
      return { outcome: "stale", job, attempt };
    const active = await this.semanticMarker(job.semanticDigest);
    if (
      !active ||
      active.kind !== "active" ||
      active.jobId !== job.jobId ||
      active.attemptId !== attempt.attemptId
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    const failureCode = input.failureCode;
    if (
      (input.status === "cancelled") !== (failureCode === undefined) ||
      (input.status === "failed_retryable" &&
        (!failureCode || !isRetryableScoutingFailure(failureCode))) ||
      (input.status === "failed_terminal" &&
        (!failureCode || isRetryableScoutingFailure(failureCode)))
    )
      throw new Error("scouting-finish-invalid");
    assertScoutingJobTransition(job.status, input.status);
    const nextJobInput = {
      ...job,
      status: input.status,
      stateVersion: job.stateVersion + 1,
      updatedAt: input.finishedAt,
      ...(failureCode ? { failureCode } : {}),
    };
    const nextAttemptInput = {
      ...attempt,
      status: input.status,
      stateVersion: attempt.stateVersion + 1,
      updatedAt: input.finishedAt,
      finishedAt: input.finishedAt,
      ...(failureCode ? { failureCode } : {}),
    };
    const nextJob = validateScoutingJob(nextJobInput);
    const nextAttempt = validateScoutingAttempt(nextAttemptInput);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            this.fencedJobPut(job, nextJob),
            this.fencedAttemptPut(attempt, nextAttempt),
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...activeKey(job.semanticDigest),
                  entityType: "scouting-active-tombstone",
                  value: {
                    semanticDigest: job.semanticDigest,
                    jobId: job.jobId,
                    attemptId: attempt.attemptId,
                  },
                },
                ConditionExpression:
                  "#entityType=:activeMarker AND #value.#jobId=:jobId AND #value.#attemptId=:attemptId",
                ExpressionAttributeNames: {
                  "#entityType": "entityType",
                  "#value": "value",
                  "#jobId": "jobId",
                  "#attemptId": "attemptId",
                },
                ExpressionAttributeValues: {
                  ":activeMarker": "scouting-active-lock",
                  ":jobId": job.jobId,
                  ":attemptId": attempt.attemptId,
                },
              },
            },
          ],
        }),
      );
      return { outcome: "finished", job: nextJob, attempt: nextAttempt };
    } catch (error) {
      if (!safeTransactionConflict(error)) throw error;
      const [latestJob, latestAttempt] = await Promise.all([
        this.getJob(input.jobId),
        this.getAttempt(input.attemptId),
      ]);
      if (
        latestJob?.currentAttemptId === input.attemptId &&
        latestJob.status === input.status &&
        latestAttempt?.status === input.status &&
        latestJob.failureCode === input.failureCode &&
        latestAttempt.failureCode === input.failureCode
      )
        return { outcome: "duplicate", job: latestJob, attempt: latestAttempt };
      if (
        latestJob?.currentAttemptId === input.attemptId &&
        latestAttempt &&
        latestJob.status === latestAttempt.status &&
        (latestJob.status === "queued" || latestJob.status === "in_progress")
      ) {
        const latestActive = await this.semanticMarker(
          latestJob.semanticDigest,
        );
        if (
          !latestActive ||
          latestActive.kind !== "active" ||
          latestActive.jobId !== latestJob.jobId ||
          latestActive.attemptId !== latestAttempt.attemptId
        )
          throw new ScoutingRepositoryError("scouting-record-corrupt");
      }
      return { outcome: "stale", job: latestJob, attempt: latestAttempt };
    }
  }

  private makeRetryRecords(
    job: StoredScoutingJob,
    requestedAt: string,
  ): {
    readonly job: ScoutingJob;
    readonly attempt: ScoutingAttempt;
    readonly outbox: ScoutingDispatchOutbox;
  } {
    const attemptNumber = job.attemptCount + 1;
    const attemptId = createScoutingAttemptId(job.jobId, attemptNumber);
    const attempt = validateScoutingAttempt({
      schemaVersion: 1,
      attemptId,
      jobId: job.jobId,
      attemptNumber,
      previousAttemptId: job.currentAttemptId,
      status: "queued",
      stateVersion: 1,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    });
    const outboxId = createScoutingOutboxId(attemptId);
    const outbox = validateScoutingDispatchOutbox({
      schemaVersion: 1,
      outboxId,
      jobId: job.jobId,
      attemptId,
      command: {
        schemaVersion: 1,
        jobId: job.jobId,
        attemptId,
        eventId: job.eventId,
        eventVersion: job.eventVersion,
        workflowIntent: job.workflowIntent,
      },
      messageGroupId: job.jobId,
      messageDeduplicationId: attemptId,
      status: "pending",
      version: 1,
      createdAt: requestedAt,
    });
    const { failureCode, ...withoutFailure } = job;
    void failureCode;
    const nextJob = validateScoutingJob({
      ...withoutFailure,
      status: "queued",
      stateVersion: job.stateVersion + 1,
      currentAttemptId: attemptId,
      attemptCount: attemptNumber,
      updatedAt: requestedAt,
    });
    return { job: nextJob, attempt, outbox };
  }

  async retryJob(
    input: Parameters<ScoutingJobRepository["retryJob"]>[0],
  ): Promise<ScoutingRetryResult> {
    assertScoutingTimestamp(input.requestedAt);
    if (
      !/^[A-Za-z0-9._:@/-]{1,256}$/.test(input.requesterId) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedStateVersion) ||
      input.expectedStateVersion < 1
    )
      throw new Error("scouting-retry-command-invalid");
    const receiptId = retryReceiptId(input.requesterId, input.idempotencyKey);
    const digest = retryDigest(
      input.jobId,
      input.requesterId,
      input.expectedStateVersion,
    );
    const receipt: StoredReceipt = {
      requesterId: input.requesterId,
      idempotencyKey: input.idempotencyKey,
      action: "retry",
      digest,
      jobId: input.jobId,
    };
    const replay = await this.receipt(receiptId);
    if (replay) {
      this.validateReceipt(replay, {
        requesterId: receipt.requesterId,
        idempotencyKey: receipt.idempotencyKey,
        action: "retry",
        digest,
      });
      const records = await this.records(replay.jobId, "request-replay");
      return { ...records, outcome: "request-replay" };
    }
    const job = await this.getJob(input.jobId);
    if (!job) throw new ScoutingRepositoryError("scouting-job-not-found");
    if (job.requesterId !== input.requesterId)
      throw new ScoutingRepositoryError("scouting-job-owner-mismatch");
    if (convergedRetry(job, input.expectedStateVersion))
      return this.persistConvergedRetryReceipt(receiptId, receipt, job);
    if (job.status !== "failed_retryable")
      throw new ScoutingRepositoryError("scouting-retry-not-allowed");
    if (job.stateVersion !== input.expectedStateVersion)
      throw new ScoutingRepositoryError("scouting-retry-not-allowed");
    if (job.attemptCount >= SCOUTING_MAX_ATTEMPTS)
      throw new ScoutingRepositoryError("scouting-retry-limit-reached");
    const event = await this.eventPointer(job.eventId, job.eventVersion);
    if (!event.pointer)
      throw new ScoutingRepositoryError("scouting-event-version-conflict");
    assertScoutingJobTransition(job.status, "queued");
    const records = this.makeRetryRecords(job, input.requestedAt);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            eventFence(this.tableName, event.pointer),
            this.fencedJobPut(job, records.job),
            {
              Put: {
                TableName: this.tableName,
                Item: attemptItem(records.attempt),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: outboxItem(records.outbox),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...activeKey(job.semanticDigest),
                  entityType: "scouting-active-lock",
                  value: {
                    semanticDigest: job.semanticDigest,
                    jobId: job.jobId,
                    attemptId: records.attempt.attemptId,
                  },
                },
                ConditionExpression:
                  "(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR (#entityType=:terminalMarker AND #value.#jobId=:jobId AND #value.#attemptId=:previousAttemptId)",
                ExpressionAttributeNames: {
                  "#entityType": "entityType",
                  "#value": "value",
                  "#jobId": "jobId",
                  "#attemptId": "attemptId",
                },
                ExpressionAttributeValues: {
                  ":terminalMarker": "scouting-active-tombstone",
                  ":jobId": job.jobId,
                  ":previousAttemptId": job.currentAttemptId,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...receiptKey(receiptId),
                  entityType: "scouting-request-receipt",
                  value: receipt,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return { outcome: "retried", ...records };
    } catch (error) {
      if (!safeTransactionConflict(error)) throw error;
      const racedReceipt = await this.receipt(receiptId);
      if (racedReceipt) {
        this.validateReceipt(racedReceipt, {
          requesterId: receipt.requesterId,
          idempotencyKey: receipt.idempotencyKey,
          action: "retry",
          digest,
        });
        const replayRecords = await this.records(
          racedReceipt.jobId,
          "request-replay",
        );
        return { ...replayRecords, outcome: "request-replay" };
      }
      const latest = await this.getJob(input.jobId);
      if (
        latest &&
        latest.attemptCount === job.attemptCount + 1 &&
        convergedRetry(latest, input.expectedStateVersion)
      )
        return this.persistConvergedRetryReceipt(receiptId, receipt, latest);
      const latestEvent = await this.eventPointer(
        job.eventId,
        job.eventVersion,
      );
      if (!latestEvent.pointer)
        throw new ScoutingRepositoryError("scouting-event-version-conflict");
      throw new ScoutingRepositoryError("scouting-retry-not-allowed");
    }
  }

  private async persistConvergedRetryReceipt(
    receiptId: string,
    receipt: StoredReceipt,
    job: StoredScoutingJob,
  ): Promise<ScoutingRetryResult> {
    const attempt = await this.getAttempt(job.currentAttemptId);
    const outbox = attempt
      ? await this.getOutbox(createScoutingOutboxId(attempt.attemptId))
      : null;
    if (!attempt || !outbox)
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: jobKey(job.jobId),
                ConditionExpression:
                  "#value.#status=:status AND #value.#stateVersion=:version AND #value.#currentAttemptId=:attemptId",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#status": "status",
                  "#stateVersion": "stateVersion",
                  "#currentAttemptId": "currentAttemptId",
                },
                ExpressionAttributeValues: {
                  ":status": job.status,
                  ":version": job.stateVersion,
                  ":attemptId": attempt.attemptId,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: activeKey(job.semanticDigest),
                ConditionExpression:
                  "#value.#semanticDigest=:semanticDigest AND #value.#jobId=:jobId AND #value.#attemptId=:attemptId",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#semanticDigest": "semanticDigest",
                  "#jobId": "jobId",
                  "#attemptId": "attemptId",
                },
                ExpressionAttributeValues: {
                  ":semanticDigest": job.semanticDigest,
                  ":jobId": job.jobId,
                  ":attemptId": attempt.attemptId,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...receiptKey(receiptId),
                  entityType: "scouting-request-receipt",
                  value: receipt,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!safeTransactionConflict(error)) throw error;
      const replay = await this.receipt(receiptId);
      if (!replay)
        throw new ScoutingRepositoryError("scouting-retry-not-allowed");
      this.validateReceipt(replay, {
        requesterId: receipt.requesterId,
        idempotencyKey: receipt.idempotencyKey,
        action: "retry",
        digest: receipt.digest,
      });
    }
    return { outcome: "concurrent-convergence", job, attempt, outbox };
  }

  async markOutboxPublished(
    input: Parameters<ScoutingJobRepository["markOutboxPublished"]>[0],
  ): Promise<ScoutingDispatchOutbox> {
    assertScoutingTimestamp(input.publishedAt);
    const outbox = await this.getOutbox(input.outboxId);
    if (!outbox || outbox.attemptId !== input.attemptId)
      throw new ScoutingRepositoryError("scouting-outbox-conflict");
    if (outbox.status === "published") return outbox;
    if (outbox.version !== input.expectedVersion)
      throw new ScoutingRepositoryError("scouting-outbox-conflict");
    const next = validateScoutingDispatchOutbox({
      ...outbox,
      status: "published",
      version: outbox.version + 1,
      publishedAt: input.publishedAt,
    });
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: outboxKey(input.outboxId),
          UpdateExpression: "SET #value=:value, #outboxStatus=:published",
          ConditionExpression:
            "#entityType=:entityType AND #outboxStatus=:pending AND #value.#attemptId=:attemptId AND #value.#version=:version",
          ExpressionAttributeNames: {
            "#value": "value",
            "#entityType": "entityType",
            "#outboxStatus": "outboxStatus",
            "#attemptId": "attemptId",
            "#version": "version",
          },
          ExpressionAttributeValues: {
            ":value": next,
            ":entityType": "scouting-dispatch-outbox",
            ":pending": "pending",
            ":published": "published",
            ":attemptId": input.attemptId,
            ":version": input.expectedVersion,
          },
        }),
      );
      return next;
    } catch (error) {
      if (!conditional(error)) throw error;
      const latest = await this.getOutbox(input.outboxId);
      if (
        latest?.status === "published" &&
        latest.attemptId === input.attemptId
      )
        return latest;
      throw new ScoutingRepositoryError("scouting-outbox-conflict");
    }
  }
}
