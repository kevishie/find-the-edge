import { describe, expect, it } from "vitest";
import {
  SCOUTING_WORKFLOW_INTENT,
  createScoutingOutboxId,
  type ScoutingJobCommand,
} from "@find-the-edge/domain";
import {
  MemoryScoutingJobRepository,
  ScoutingRepositoryError,
} from "./scouting-job-repository";

const now = "2026-08-07T12:00:00.000Z";
const command: ScoutingJobCommand = {
  schemaVersion: 1,
  requesterId: "user-1",
  idempotencyKey: "create-1",
  eventId: "baseball:mlb:event-1",
  eventVersion: 4,
  workflowIntent: SCOUTING_WORKFLOW_INTENT,
};

describe("memory scouting job repository", () => {
  it("atomically creates and converges request and semantic duplicates", async () => {
    const repo = new MemoryScoutingJobRepository();
    const [first, second] = await Promise.all([
      repo.createJob({ command, createdAt: now }),
      repo.createJob({
        command: { ...command, idempotencyKey: "create-2" },
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
      repo.createJob({
        command: { ...command, eventVersion: 5 },
        createdAt: now,
      }),
    ).rejects.toMatchObject({
      code: "scouting-idempotency-conflict",
    } satisfies Partial<ScoutingRepositoryError>);
  });

  it("resolves a committed create replay before mutable event lookup", async () => {
    const repo = new MemoryScoutingJobRepository();
    const created = await repo.createJob({ command, createdAt: now });
    await expect(
      repo.getCreateReplay({
        requesterId: command.requesterId,
        idempotencyKey: command.idempotencyKey,
        eventId: command.eventId,
      }),
    ).resolves.toEqual(created.job);
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
  });

  it("fences event versions and stale attempts", async () => {
    let version = 4;
    const repo = new MemoryScoutingJobRepository({
      verifyScheduled: (_eventId, expected) =>
        Promise.resolve(expected === version),
    });
    const created = await repo.createJob({ command, createdAt: now });
    version = 5;
    await expect(
      repo.claimAttempt({
        jobId: created.job.jobId,
        attemptId: created.attempt.attemptId,
        eventId: command.eventId,
        eventVersion: 4,
        claimedAt: "2026-08-07T12:01:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "event-invalid",
      failureCode: "event-version-changed",
    });
    expect((await repo.getJob(created.job.jobId))?.status).toBe("queued");
  });

  it("keeps attempts immutable across a bounded, fenced retry", async () => {
    const repo = new MemoryScoutingJobRepository();
    const created = await repo.createJob({ command, createdAt: now });
    const claimed = await repo.claimAttempt({
      jobId: created.job.jobId,
      attemptId: created.attempt.attemptId,
      eventId: command.eventId,
      eventVersion: 4,
      claimedAt: "2026-08-07T12:01:00.000Z",
    });
    expect(claimed.outcome).toBe("claimed");
    await expect(
      repo.claimAttempt({
        jobId: created.job.jobId,
        attemptId: created.attempt.attemptId,
        eventId: command.eventId,
        eventVersion: 4,
        claimedAt: "2026-08-07T12:01:01.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "duplicate" });
    await repo.finishAttempt({
      jobId: created.job.jobId,
      attemptId: created.attempt.attemptId,
      status: "failed_retryable",
      failureCode: "workflow-timeout",
      finishedAt: "2026-08-07T12:02:00.000Z",
    });
    const [retryA, retryB] = await Promise.all([
      repo.retryJob({
        jobId: created.job.jobId,
        requesterId: command.requesterId,
        idempotencyKey: "retry-1",
        expectedStateVersion: 3,
        requestedAt: "2026-08-07T12:03:00.000Z",
      }),
      repo.retryJob({
        jobId: created.job.jobId,
        requesterId: command.requesterId,
        idempotencyKey: "retry-2",
        expectedStateVersion: 3,
        requestedAt: "2026-08-07T12:03:00.000Z",
      }),
    ]);
    expect(
      new Set([retryA.attempt.attemptId, retryB.attempt.attemptId]).size,
    ).toBe(1);
    expect(retryA.attempt.previousAttemptId).toBe(created.attempt.attemptId);
    expect((await repo.getAttempt(created.attempt.attemptId))?.status).toBe(
      "failed_retryable",
    );
    expect((await repo.getJob(created.job.jobId))?.attemptCount).toBe(2);
    await repo.claimAttempt({
      jobId: created.job.jobId,
      attemptId: retryA.attempt.attemptId,
      eventId: command.eventId,
      eventVersion: 4,
      claimedAt: "2026-08-07T12:04:00.000Z",
    });
    await expect(
      repo.retryJob({
        jobId: created.job.jobId,
        requesterId: command.requesterId,
        idempotencyKey: "retry-after-claim",
        expectedStateVersion: 3,
        requestedAt: "2026-08-07T12:04:01.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "concurrent-convergence",
      job: { status: "in_progress", stateVersion: 5 },
      attempt: { attemptNumber: 2, status: "in_progress" },
    });
    await repo.finishAttempt({
      jobId: created.job.jobId,
      attemptId: retryA.attempt.attemptId,
      status: "failed_retryable",
      failureCode: "workflow-timeout",
      finishedAt: "2026-08-07T12:05:00.000Z",
    });
    await expect(
      repo.retryJob({
        jobId: created.job.jobId,
        requesterId: command.requesterId,
        idempotencyKey: "delayed-first-retry",
        expectedStateVersion: 3,
        requestedAt: "2026-08-07T12:06:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "scouting-retry-not-allowed" });
    const third = await repo.retryJob({
      jobId: created.job.jobId,
      requesterId: command.requesterId,
      idempotencyKey: "retry-3",
      expectedStateVersion: 6,
      requestedAt: "2026-08-07T12:06:00.000Z",
    });
    await repo.claimAttempt({
      jobId: created.job.jobId,
      attemptId: third.attempt.attemptId,
      eventId: command.eventId,
      eventVersion: 4,
      claimedAt: "2026-08-07T12:07:00.000Z",
    });
    await repo.finishAttempt({
      jobId: created.job.jobId,
      attemptId: third.attempt.attemptId,
      status: "failed_retryable",
      failureCode: "workflow-timeout",
      finishedAt: "2026-08-07T12:08:00.000Z",
    });
    await expect(
      repo.retryJob({
        jobId: created.job.jobId,
        requesterId: command.requesterId,
        idempotencyKey: "retry-over-limit",
        expectedStateVersion: 9,
        requestedAt: "2026-08-07T12:09:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "scouting-retry-limit-reached" });
  });

  it("publishes the outbox with an exact version fence", async () => {
    const repo = new MemoryScoutingJobRepository();
    const created = await repo.createJob({ command, createdAt: now });
    const outboxId = createScoutingOutboxId(created.attempt.attemptId);
    const published = await repo.markOutboxPublished({
      outboxId,
      attemptId: created.attempt.attemptId,
      expectedVersion: 1,
      publishedAt: "2026-08-07T12:00:01.000Z",
    });
    expect(published).toMatchObject({ status: "published", version: 2 });
    await expect(
      repo.markOutboxPublished({
        outboxId,
        attemptId: created.attempt.attemptId,
        expectedVersion: 1,
        publishedAt: "2026-08-07T12:00:02.000Z",
      }),
    ).resolves.toEqual(published);
  });

  it("records a fenced workflow-start failure while the attempt is still queued", async () => {
    const repo = new MemoryScoutingJobRepository();
    const created = await repo.createJob({ command, createdAt: now });
    const result = await repo.finishAttempt({
      jobId: created.job.jobId,
      attemptId: created.attempt.attemptId,
      status: "failed_retryable",
      failureCode: "workflow-temporarily-unavailable",
      finishedAt: "2026-08-07T12:00:30.000Z",
    });
    expect(result).toMatchObject({
      outcome: "finished",
      job: { status: "failed_retryable" },
      attempt: {
        status: "failed_retryable",
        finishedAt: "2026-08-07T12:00:30.000Z",
      },
    });
    expect(result.attempt).not.toHaveProperty("startedAt");
  });

  it("does not let a retry overwrite another active semantic job", async () => {
    const repo = new MemoryScoutingJobRepository();
    const first = await repo.createJob({ command, createdAt: now });
    await repo.finishAttempt({
      jobId: first.job.jobId,
      attemptId: first.attempt.attemptId,
      status: "failed_retryable",
      failureCode: "workflow-temporarily-unavailable",
      finishedAt: "2026-08-07T12:01:00.000Z",
    });
    const winner = await repo.createJob({
      command: { ...command, idempotencyKey: "create-after-failure" },
      createdAt: "2026-08-07T12:02:00.000Z",
    });

    await expect(
      repo.retryJob({
        jobId: first.job.jobId,
        requesterId: command.requesterId,
        idempotencyKey: "retry-raced-by-create",
        expectedStateVersion: 2,
        requestedAt: "2026-08-07T12:03:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "scouting-retry-not-allowed" });
    await expect(
      repo.createJob({
        command: { ...command, idempotencyKey: "create-convergence-check" },
        createdAt: "2026-08-07T12:04:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "active-convergence",
      job: { jobId: winner.job.jobId },
    });
  });

  it("fails closed when the current active lock is missing", async () => {
    const repo = new MemoryScoutingJobRepository();
    const created = await repo.createJob({ command, createdAt: now });
    (repo as unknown as { active: Map<string, string> }).active.clear();

    await expect(
      repo.finishAttempt({
        jobId: created.job.jobId,
        attemptId: created.attempt.attemptId,
        status: "failed_retryable",
        failureCode: "workflow-timeout",
        finishedAt: "2026-08-07T12:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "scouting-record-corrupt" });
    await expect(repo.getJob(created.job.jobId)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("does not acknowledge a terminal replay with different failure metadata", async () => {
    const repo = new MemoryScoutingJobRepository();
    const created = await repo.createJob({ command, createdAt: now });
    await repo.finishAttempt({
      jobId: created.job.jobId,
      attemptId: created.attempt.attemptId,
      status: "failed_retryable",
      failureCode: "workflow-timeout",
      finishedAt: "2026-08-07T12:01:00.000Z",
    });

    await expect(
      repo.finishAttempt({
        jobId: created.job.jobId,
        attemptId: created.attempt.attemptId,
        status: "failed_retryable",
        failureCode: "workflow-temporarily-unavailable",
        finishedAt: "2026-08-07T12:02:00.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "stale" });
  });
});
