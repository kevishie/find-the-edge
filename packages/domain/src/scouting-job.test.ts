import { describe, expect, it } from "vitest";
import {
  SCOUTING_MAX_ATTEMPTS,
  SCOUTING_WORKFLOW_INTENT,
  assertScoutingJobTransition,
  createScoutingAttemptId,
  createScoutingCommandDigest,
  createScoutingJobId,
  createScoutingSemanticDigest,
  isRetryableScoutingFailure,
  toPublicScoutingJob,
  validateScoutingDispatchCommand,
  validateScoutingDispatchOutbox,
  validateScoutingAttempt,
  validateScoutingJob,
  type ScoutingJob,
} from "./scouting-job";

const command = {
  schemaVersion: 1 as const,
  requesterId: "user-123",
  idempotencyKey: "request-123",
  eventId: "baseball:mlb:event-123",
  eventVersion: 7,
  workflowIntent: SCOUTING_WORKFLOW_INTENT,
};

describe("scouting job domain", () => {
  it("derives stable request and semantic identities", () => {
    expect(createScoutingCommandDigest(command)).toBe(
      createScoutingCommandDigest({ ...command }),
    );
    expect(createScoutingJobId(command)).toMatch(/^scout-job:[a-f0-9]{64}$/);
    expect(createScoutingAttemptId(createScoutingJobId(command), 1)).toMatch(
      /^scout-attempt:[a-f0-9]{64}$/,
    );
    expect(
      createScoutingSemanticDigest({
        ...command,
        idempotencyKey: "another-request",
      }),
    ).toBe(createScoutingSemanticDigest(command));
    expect(
      createScoutingJobId({ ...command, idempotencyKey: "another-request" }),
    ).not.toBe(createScoutingJobId(command));
  });

  it("enforces exact chronology and the fixed retry vocabulary", () => {
    expect(SCOUTING_MAX_ATTEMPTS).toBe(3);
    expect(() =>
      assertScoutingJobTransition("queued", "in_progress"),
    ).not.toThrow();
    expect(() =>
      assertScoutingJobTransition("in_progress", "completed"),
    ).not.toThrow();
    expect(() =>
      assertScoutingJobTransition("completed", "in_progress"),
    ).toThrow("scouting-job-transition-invalid");
    expect(isRetryableScoutingFailure("workflow-timeout")).toBe(true);
    expect(isRetryableScoutingFailure("fixture-contract-invalid")).toBe(false);
  });

  it("rejects impossible persisted job chronology", () => {
    const base = {
      schemaVersion: 1 as const,
      jobId: createScoutingJobId(command),
      requesterId: command.requesterId,
      eventId: command.eventId,
      eventVersion: command.eventVersion,
      workflowIntent: command.workflowIntent,
      commandDigest: createScoutingCommandDigest(command),
      semanticDigest: createScoutingSemanticDigest(command),
      currentAttemptId: createScoutingAttemptId(
        createScoutingJobId(command),
        1,
      ),
      attemptCount: 1,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:01:00.000Z",
    };
    expect(() =>
      validateScoutingJob({
        ...base,
        status: "completed",
        stateVersion: 1,
      }),
    ).toThrow("scouting-job-invalid");
    expect(() =>
      validateScoutingJob({
        ...base,
        status: "queued",
        stateVersion: 2,
      }),
    ).toThrow("scouting-job-invalid");
  });

  it("projects only safe public state", () => {
    const job: ScoutingJob = {
      schemaVersion: 1,
      jobId: createScoutingJobId(command),
      requesterId: command.requesterId,
      eventId: command.eventId,
      eventVersion: command.eventVersion,
      workflowIntent: command.workflowIntent,
      commandDigest: createScoutingCommandDigest(command),
      semanticDigest: createScoutingSemanticDigest(command),
      status: "failed_retryable",
      stateVersion: 3,
      currentAttemptId: createScoutingAttemptId(
        createScoutingJobId(command),
        1,
      ),
      attemptCount: 1,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:01:00.000Z",
      failureCode: "workflow-timeout",
    };
    expect(toPublicScoutingJob(job)).toEqual({
      schemaVersion: 1,
      jobId: job.jobId,
      eventId: job.eventId,
      eventVersion: 7,
      workflowIntent: "fixture-v1",
      status: "failed_retryable",
      stateVersion: 3,
      attemptNumber: 1,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      failure: { code: "workflow-timeout", retryable: true },
    });
    expect(JSON.stringify(toPublicScoutingJob(job))).not.toContain(
      "requesterId",
    );
  });

  it("rejects unknown command fields and inconsistent outbox chronology", () => {
    const records = {
      schemaVersion: 1 as const,
      jobId: createScoutingJobId(command),
      attemptId: createScoutingAttemptId(createScoutingJobId(command), 1),
      eventId: command.eventId,
      eventVersion: command.eventVersion,
      workflowIntent: SCOUTING_WORKFLOW_INTENT,
    };
    expect(() =>
      validateScoutingDispatchCommand({ ...records, executionArn: "secret" }),
    ).toThrow("scouting-dispatch-command-invalid");
    expect(() =>
      validateScoutingDispatchOutbox({
        schemaVersion: 1,
        outboxId: `scout-outbox:${"a".repeat(64)}`,
        jobId: records.jobId,
        attemptId: records.attemptId,
        command: records,
        messageGroupId: records.jobId,
        messageDeduplicationId: records.attemptId,
        status: "published",
        version: 1,
        createdAt: "2026-08-07T12:00:00.000Z",
        publishedAt: "2026-08-07T12:01:00.000Z",
      }),
    ).toThrow("scouting-outbox-invalid");
  });

  it("rejects hostile attempt lineage and chronology", () => {
    const jobId = createScoutingJobId(command);
    const attemptId = createScoutingAttemptId(jobId, 2);
    const base = {
      schemaVersion: 1 as const,
      attemptId,
      jobId,
      attemptNumber: 2,
      previousAttemptId: createScoutingAttemptId(jobId, 1),
      status: "completed" as const,
      stateVersion: 3,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:02:00.000Z",
      startedAt: "2026-08-07T12:01:00.000Z",
      finishedAt: "2026-08-07T12:02:00.000Z",
    };
    expect(validateScoutingAttempt(base)).toEqual(base);
    expect(() =>
      validateScoutingAttempt({
        ...base,
        previousAttemptId: createScoutingAttemptId(jobId, 3),
      }),
    ).toThrow("scouting-attempt-invalid");
    expect(() =>
      validateScoutingAttempt({ ...base, startedAt: undefined }),
    ).toThrow("scouting-attempt-invalid");
    expect(() =>
      validateScoutingAttempt({
        ...base,
        startedAt: "2026-08-07T12:03:00.000Z",
      }),
    ).toThrow("scouting-attempt-invalid");
    expect(() =>
      validateScoutingDispatchCommand({
        schemaVersion: 1,
        jobId,
        attemptId: `scout-attempt:${"f".repeat(64)}`,
        eventId: command.eventId,
        eventVersion: command.eventVersion,
        workflowIntent: SCOUTING_WORKFLOW_INTENT,
      }),
    ).toThrow("scouting-dispatch-command-invalid");
  });
});
