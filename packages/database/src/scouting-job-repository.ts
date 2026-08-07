import {
  SCOUTING_MAX_ATTEMPTS,
  assertScoutingTimestamp,
  assertScoutingJobTransition,
  createQueuedScoutingRecords,
  createScoutingAttemptId,
  createScoutingCommandDigest,
  createScoutingJobId,
  createScoutingOutboxId,
  createScoutingRequestReceiptId,
  isRetryableScoutingFailure,
  normalizeScoutingJobCommand,
  sha256Hex,
  validateScoutingAttempt,
  validateScoutingDispatchOutbox,
  validateScoutingJob,
  type ScoutingAttempt,
  type ScoutingDispatchOutbox,
  type ScoutingFailureCode,
  type ScoutingJob,
  type ScoutingJobCommand,
} from "@find-the-edge/domain";

export interface ScoutingJobRecords {
  readonly job: ScoutingJob;
  readonly attempt: ScoutingAttempt;
  readonly outbox: ScoutingDispatchOutbox;
}

export type ScoutingCreateOutcome =
  "created" | "request-replay" | "active-convergence";

export interface ScoutingCreateResult extends ScoutingJobRecords {
  readonly outcome: ScoutingCreateOutcome;
}

export interface ScoutingEventInvalidClaimResult {
  readonly outcome: "event-invalid";
  readonly job: ScoutingJob;
  readonly attempt: ScoutingAttempt;
  readonly failureCode: "event-version-changed" | "event-no-longer-scheduled";
}

export type ScoutingClaimResult =
  | {
      readonly outcome: "claimed" | "duplicate" | "stale";
      readonly job: ScoutingJob | null;
      readonly attempt: ScoutingAttempt | null;
    }
  | ScoutingEventInvalidClaimResult;

export interface ScoutingFinishResult {
  readonly outcome: "finished" | "duplicate" | "stale";
  readonly job: ScoutingJob | null;
  readonly attempt: ScoutingAttempt | null;
}

export interface ScoutingRetryResult extends ScoutingJobRecords {
  readonly outcome: "retried" | "request-replay" | "concurrent-convergence";
}

export interface ScoutingJobRepository {
  createJob(input: {
    readonly command: ScoutingJobCommand;
    readonly createdAt: string;
  }): Promise<ScoutingCreateResult>;
  getJob(jobId: string): Promise<ScoutingJob | null>;
  getJobForRequester(
    jobId: string,
    requesterId: string,
  ): Promise<ScoutingJob | null>;
  getCreateReplay(input: {
    readonly requesterId: string;
    readonly idempotencyKey: string;
    readonly eventId: string;
  }): Promise<ScoutingJob | null>;
  getAttempt(attemptId: string): Promise<ScoutingAttempt | null>;
  getOutbox(outboxId: string): Promise<ScoutingDispatchOutbox | null>;
  claimAttempt(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly eventId: string;
    readonly eventVersion: number;
    readonly claimedAt: string;
  }): Promise<ScoutingClaimResult>;
  finishAttempt(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly status:
      "completed" | "failed_retryable" | "failed_terminal" | "cancelled";
    readonly failureCode?: ScoutingFailureCode;
    readonly finishedAt: string;
  }): Promise<ScoutingFinishResult>;
  retryJob(input: {
    readonly jobId: string;
    readonly requesterId: string;
    readonly idempotencyKey: string;
    readonly expectedStateVersion: number;
    readonly requestedAt: string;
  }): Promise<ScoutingRetryResult>;
  markOutboxPublished(input: {
    readonly outboxId: string;
    readonly attemptId: string;
    readonly expectedVersion: number;
    readonly publishedAt: string;
  }): Promise<ScoutingDispatchOutbox>;
}

export type ScoutingRepositoryErrorCode =
  | "scouting-idempotency-conflict"
  | "scouting-event-version-conflict"
  | "scouting-job-not-found"
  | "scouting-job-owner-mismatch"
  | "scouting-retry-not-allowed"
  | "scouting-retry-limit-reached"
  | "scouting-outbox-conflict"
  | "scouting-record-corrupt";

export class ScoutingRepositoryError extends Error {
  override readonly name = "ScoutingRepositoryError";
  constructor(readonly code: ScoutingRepositoryErrorCode) {
    super(code);
  }
}

export interface ScoutingEventFence {
  verifyScheduled(
    eventId: string,
    eventVersion: number,
  ): Promise<boolean | "event-version-changed" | "event-no-longer-scheduled">;
}

type Receipt = {
  readonly requesterId: string;
  readonly idempotencyKey: string;
  readonly action: "create" | "retry";
  readonly digest: string;
  readonly jobId: string;
};

const clone = <T>(value: T): T => structuredClone(value);
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
const terminal = new Set([
  "completed",
  "failed_retryable",
  "failed_terminal",
  "cancelled",
]);
const eventFenceFailure = (
  result: Awaited<ReturnType<ScoutingEventFence["verifyScheduled"]>>,
): ScoutingEventInvalidClaimResult["failureCode"] | null =>
  result === true
    ? null
    : result === "event-no-longer-scheduled"
      ? result
      : "event-version-changed";

const convergedRetry = (
  job: ScoutingJob,
  expectedStateVersion: number,
): boolean =>
  job.attemptCount > 1 &&
  ((job.status === "queued" && job.stateVersion === expectedStateVersion + 1) ||
    (job.status === "in_progress" &&
      job.stateVersion === expectedStateVersion + 2));

export class MemoryScoutingJobRepository implements ScoutingJobRepository {
  private readonly jobs = new Map<string, ScoutingJob>();
  private readonly attempts = new Map<string, ScoutingAttempt>();
  private readonly outboxes = new Map<string, ScoutingDispatchOutbox>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly active = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventFence: ScoutingEventFence = {
      verifyScheduled: () => Promise.resolve(true),
    },
  ) {}

  private locked<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async createJob(input: {
    readonly command: ScoutingJobCommand;
    readonly createdAt: string;
  }): Promise<ScoutingCreateResult> {
    return this.locked(async () => {
      const records = createQueuedScoutingRecords(
        input.command,
        input.createdAt,
      );
      const receiptId = createScoutingRequestReceiptId(input.command);
      const existingReceipt = this.receipts.get(receiptId);
      if (existingReceipt) {
        if (
          existingReceipt.action !== "create" ||
          existingReceipt.digest !== records.job.commandDigest
        )
          throw new ScoutingRepositoryError("scouting-idempotency-conflict");
        return this.records(existingReceipt.jobId, "request-replay");
      }
      const activeJobId = this.active.get(records.job.semanticDigest);
      if (activeJobId) {
        const existing = this.jobs.get(activeJobId);
        if (!existing || terminal.has(existing.status))
          throw new ScoutingRepositoryError("scouting-record-corrupt");
        this.receipts.set(receiptId, {
          requesterId: input.command.requesterId,
          idempotencyKey: input.command.idempotencyKey,
          action: "create",
          digest: records.job.commandDigest,
          jobId: activeJobId,
        });
        return this.records(activeJobId, "active-convergence");
      }
      if (
        eventFenceFailure(
          await this.eventFence.verifyScheduled(
            input.command.eventId,
            input.command.eventVersion,
          ),
        )
      )
        throw new ScoutingRepositoryError("scouting-event-version-conflict");
      this.jobs.set(records.job.jobId, clone(records.job));
      this.attempts.set(records.attempt.attemptId, clone(records.attempt));
      this.outboxes.set(records.outbox.outboxId, clone(records.outbox));
      this.active.set(records.job.semanticDigest, records.job.jobId);
      this.receipts.set(receiptId, {
        requesterId: input.command.requesterId,
        idempotencyKey: input.command.idempotencyKey,
        action: "create",
        digest: records.job.commandDigest,
        jobId: records.job.jobId,
      });
      return { outcome: "created", ...clone(records) };
    });
  }

  private records(
    jobId: string,
    outcome: ScoutingCreateOutcome,
  ): ScoutingCreateResult {
    const job = this.jobs.get(jobId);
    const attempt = job ? this.attempts.get(job.currentAttemptId) : undefined;
    const outbox = attempt
      ? this.outboxes.get(createScoutingOutboxId(attempt.attemptId))
      : undefined;
    if (!job || !attempt || !outbox)
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    return {
      outcome,
      job: clone(job),
      attempt: clone(attempt),
      outbox: clone(outbox),
    };
  }

  async getJob(jobId: string) {
    await this.queue;
    const value = this.jobs.get(jobId);
    return value ? clone(value) : null;
  }

  async getJobForRequester(jobId: string, requesterId: string) {
    const value = await this.getJob(jobId);
    return value?.requesterId === requesterId ? value : null;
  }

  async getCreateReplay(
    input: Parameters<ScoutingJobRepository["getCreateReplay"]>[0],
  ) {
    const probe = normalizeScoutingJobCommand({
      schemaVersion: 1,
      requesterId: input.requesterId,
      idempotencyKey: input.idempotencyKey,
      eventId: input.eventId,
      eventVersion: 1,
      workflowIntent: "fixture-v1",
    });
    await this.queue;
    const receipt = this.receipts.get(createScoutingRequestReceiptId(probe));
    if (!receipt) return null;
    if (
      receipt.requesterId !== input.requesterId ||
      receipt.idempotencyKey !== input.idempotencyKey
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    if (receipt.action !== "create")
      throw new ScoutingRepositoryError("scouting-idempotency-conflict");
    const job = this.jobs.get(receipt.jobId);
    if (!job || job.requesterId !== input.requesterId)
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    if (job.eventId !== input.eventId)
      throw new ScoutingRepositoryError("scouting-idempotency-conflict");
    const exactCommand = normalizeScoutingJobCommand({
      ...probe,
      eventVersion: job.eventVersion,
      workflowIntent: job.workflowIntent,
    });
    if (
      createScoutingCommandDigest(exactCommand) !== receipt.digest ||
      createScoutingCommandDigest(exactCommand) !== job.commandDigest ||
      createScoutingJobId(exactCommand) !== job.jobId
    )
      throw new ScoutingRepositoryError("scouting-record-corrupt");
    return clone(job);
  }

  async getAttempt(attemptId: string) {
    await this.queue;
    const value = this.attempts.get(attemptId);
    return value ? clone(value) : null;
  }

  async getOutbox(outboxId: string) {
    await this.queue;
    const value = this.outboxes.get(outboxId);
    return value ? clone(value) : null;
  }

  async claimAttempt(
    input: Parameters<ScoutingJobRepository["claimAttempt"]>[0],
  ) {
    return this.locked(async (): Promise<ScoutingClaimResult> => {
      assertScoutingTimestamp(input.claimedAt);
      const job = this.jobs.get(input.jobId);
      const attempt = this.attempts.get(input.attemptId);
      if (!job || !attempt || job.currentAttemptId !== input.attemptId)
        return {
          outcome: "stale",
          job: job ? clone(job) : null,
          attempt: attempt ? clone(attempt) : null,
        };
      if (
        job.eventId !== input.eventId ||
        job.eventVersion !== input.eventVersion
      )
        return { outcome: "stale", job: clone(job), attempt: clone(attempt) };
      const failureCode = eventFenceFailure(
        await this.eventFence.verifyScheduled(
          input.eventId,
          input.eventVersion,
        ),
      );
      if (failureCode)
        return {
          outcome: "event-invalid",
          job: clone(job),
          attempt: clone(attempt),
          failureCode,
        };
      if (job.status === "in_progress" && attempt.status === "in_progress")
        return {
          outcome: "duplicate",
          job: clone(job),
          attempt: clone(attempt),
        };
      if (job.status !== "queued" || attempt.status !== "queued")
        return { outcome: "stale", job: clone(job), attempt: clone(attempt) };
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
      this.jobs.set(job.jobId, nextJob);
      this.attempts.set(attempt.attemptId, nextAttempt);
      return {
        outcome: "claimed",
        job: clone(nextJob),
        attempt: clone(nextAttempt),
      };
    });
  }

  async finishAttempt(
    input: Parameters<ScoutingJobRepository["finishAttempt"]>[0],
  ) {
    return this.locked((): ScoutingFinishResult => {
      assertScoutingTimestamp(input.finishedAt);
      const job = this.jobs.get(input.jobId);
      const attempt = this.attempts.get(input.attemptId);
      if (!job || !attempt || job.currentAttemptId !== input.attemptId)
        return {
          outcome: "stale",
          job: job ? clone(job) : null,
          attempt: attempt ? clone(attempt) : null,
        };
      if (
        job.status === input.status &&
        attempt.status === input.status &&
        job.failureCode === input.failureCode &&
        attempt.failureCode === input.failureCode
      )
        return {
          outcome: "duplicate",
          job: clone(job),
          attempt: clone(attempt),
        };
      const matchingSource = job.status === attempt.status;
      const canFinish =
        job.status === "in_progress" ||
        (job.status === "queued" && input.status !== "completed");
      if (!matchingSource || !canFinish)
        return { outcome: "stale", job: clone(job), attempt: clone(attempt) };
      if (this.active.get(job.semanticDigest) !== job.jobId)
        throw new ScoutingRepositoryError("scouting-record-corrupt");
      const failureCode = input.failureCode;
      if (
        (input.status === "completed" || input.status === "cancelled") !==
          (failureCode === undefined) ||
        (input.status === "failed_retryable" &&
          (!failureCode || !isRetryableScoutingFailure(failureCode))) ||
        (input.status === "failed_terminal" &&
          (!failureCode || isRetryableScoutingFailure(failureCode)))
      )
        throw new Error("scouting-finish-invalid");
      assertScoutingJobTransition(job.status, input.status);
      const nextJob = validateScoutingJob({
        ...job,
        status: input.status,
        stateVersion: job.stateVersion + 1,
        updatedAt: input.finishedAt,
        ...(failureCode ? { failureCode } : {}),
      });
      const nextAttempt = validateScoutingAttempt({
        ...attempt,
        status: input.status,
        stateVersion: attempt.stateVersion + 1,
        updatedAt: input.finishedAt,
        finishedAt: input.finishedAt,
        ...(failureCode ? { failureCode } : {}),
      });
      this.jobs.set(job.jobId, nextJob);
      this.attempts.set(attempt.attemptId, nextAttempt);
      if (this.active.get(job.semanticDigest) === job.jobId)
        this.active.delete(job.semanticDigest);
      return {
        outcome: "finished",
        job: clone(nextJob),
        attempt: clone(nextAttempt),
      };
    });
  }

  async retryJob(input: Parameters<ScoutingJobRepository["retryJob"]>[0]) {
    return this.locked(async (): Promise<ScoutingRetryResult> => {
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
      const existingReceipt = this.receipts.get(receiptId);
      if (existingReceipt) {
        if (
          existingReceipt.action !== "retry" ||
          existingReceipt.digest !== digest
        )
          throw new ScoutingRepositoryError("scouting-idempotency-conflict");
        return {
          ...this.records(existingReceipt.jobId, "request-replay"),
          outcome: "request-replay",
        };
      }
      const job = this.jobs.get(input.jobId);
      if (!job) throw new ScoutingRepositoryError("scouting-job-not-found");
      if (job.requesterId !== input.requesterId)
        throw new ScoutingRepositoryError("scouting-job-owner-mismatch");
      if (convergedRetry(job, input.expectedStateVersion)) {
        const attempt = this.attempts.get(job.currentAttemptId)!;
        const outbox = this.outboxes.get(
          createScoutingOutboxId(attempt.attemptId),
        )!;
        this.receipts.set(receiptId, {
          requesterId: input.requesterId,
          idempotencyKey: input.idempotencyKey,
          action: "retry",
          digest,
          jobId: job.jobId,
        });
        return {
          outcome: "concurrent-convergence",
          job: clone(job),
          attempt: clone(attempt),
          outbox: clone(outbox),
        };
      }
      if (job.status !== "failed_retryable")
        throw new ScoutingRepositoryError("scouting-retry-not-allowed");
      if (job.stateVersion !== input.expectedStateVersion)
        throw new ScoutingRepositoryError("scouting-retry-not-allowed");
      if (job.attemptCount >= SCOUTING_MAX_ATTEMPTS)
        throw new ScoutingRepositoryError("scouting-retry-limit-reached");
      const activeJobId = this.active.get(job.semanticDigest);
      if (activeJobId)
        throw new ScoutingRepositoryError(
          activeJobId === job.jobId
            ? "scouting-record-corrupt"
            : "scouting-retry-not-allowed",
        );
      if (
        eventFenceFailure(
          await this.eventFence.verifyScheduled(job.eventId, job.eventVersion),
        )
      )
        throw new ScoutingRepositoryError("scouting-event-version-conflict");
      const previousAttempt = this.attempts.get(job.currentAttemptId);
      if (!previousAttempt)
        throw new ScoutingRepositoryError("scouting-record-corrupt");
      const attemptNumber = job.attemptCount + 1;
      const attemptId = createScoutingAttemptId(job.jobId, attemptNumber);
      const attempt = validateScoutingAttempt({
        schemaVersion: 1,
        attemptId,
        jobId: job.jobId,
        attemptNumber,
        previousAttemptId: previousAttempt.attemptId,
        status: "queued",
        stateVersion: 1,
        createdAt: input.requestedAt,
        updatedAt: input.requestedAt,
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
        createdAt: input.requestedAt,
      });
      assertScoutingJobTransition(job.status, "queued");
      const { failureCode: priorFailureCode, ...jobWithoutFailure } = job;
      void priorFailureCode;
      const nextJob = validateScoutingJob({
        ...jobWithoutFailure,
        status: "queued",
        stateVersion: job.stateVersion + 1,
        currentAttemptId: attemptId,
        attemptCount: attemptNumber,
        updatedAt: input.requestedAt,
      });
      this.jobs.set(job.jobId, nextJob);
      this.attempts.set(attemptId, attempt);
      this.outboxes.set(outboxId, outbox);
      this.active.set(job.semanticDigest, job.jobId);
      this.receipts.set(receiptId, {
        requesterId: input.requesterId,
        idempotencyKey: input.idempotencyKey,
        action: "retry",
        digest,
        jobId: job.jobId,
      });
      return {
        outcome: "retried",
        job: clone(nextJob),
        attempt: clone(attempt),
        outbox: clone(outbox),
      };
    });
  }

  async markOutboxPublished(
    input: Parameters<ScoutingJobRepository["markOutboxPublished"]>[0],
  ) {
    return this.locked(() => {
      assertScoutingTimestamp(input.publishedAt);
      const outbox = this.outboxes.get(input.outboxId);
      if (!outbox || outbox.attemptId !== input.attemptId)
        throw new ScoutingRepositoryError("scouting-outbox-conflict");
      if (outbox.status === "published") return clone(outbox);
      if (outbox.version !== input.expectedVersion)
        throw new ScoutingRepositoryError("scouting-outbox-conflict");
      const next = validateScoutingDispatchOutbox({
        ...outbox,
        status: "published",
        version: outbox.version + 1,
        publishedAt: input.publishedAt,
      });
      this.outboxes.set(outbox.outboxId, next);
      return clone(next);
    });
  }
}
