import { MemoryScoutingJobRepository } from "@find-the-edge/database";
import type { ScoutingJobCommand } from "@find-the-edge/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createScoutingWorkflow,
  ScoutingFixtureFailure,
} from "./scouting-workflow";

const input: ScoutingJobCommand = {
  schemaVersion: 1,
  requesterId: "requester-1",
  idempotencyKey: "request-1",
  eventId: "event:soccer:mls:test",
  eventVersion: 3,
  workflowIntent: "fixture-v1",
};

const setup = async () => {
  const repository = new MemoryScoutingJobRepository();
  const records = await repository.createJob({
    command: input,
    createdAt: "2026-08-07T12:00:00.000Z",
  });
  return { repository, records };
};

describe("fixture-only scouting workflow", () => {
  it("claims and completes the exact queued attempt without returning a report", async () => {
    const { repository, records } = await setup();
    const run = createScoutingWorkflow(
      repository,
      undefined,
      () => "2026-08-07T12:01:00.000Z",
    );

    await expect(run(records.outbox.command)).resolves.toEqual({
      outcome: "completed",
    });
    await expect(repository.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "completed",
      stateVersion: 3,
    });
  });

  it("acknowledges stale attempts without running the fixture", async () => {
    const { repository, records } = await setup();
    await repository.claimAttempt({
      ...records.outbox.command,
      claimedAt: "2026-08-07T12:01:00.000Z",
    });
    await repository.finishAttempt({
      jobId: records.job.jobId,
      attemptId: records.attempt.attemptId,
      status: "completed",
      finishedAt: "2026-08-07T12:02:00.000Z",
    });
    const fixture = { run: vi.fn(() => Promise.resolve()) };

    await expect(
      createScoutingWorkflow(repository, fixture)(records.outbox.command),
    ).resolves.toEqual({ outcome: "stale" });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("fails an ambiguous duplicate claim so the state machine finalizer runs", async () => {
    const { repository, records } = await setup();
    await repository.claimAttempt({
      jobId: records.job.jobId,
      attemptId: records.attempt.attemptId,
      eventId: records.job.eventId,
      eventVersion: records.job.eventVersion,
      claimedAt: "2026-08-07T12:01:00.000Z",
    });
    const fixture = { run: vi.fn(() => Promise.resolve()) };

    await expect(
      createScoutingWorkflow(repository, fixture)(records.outbox.command),
    ).rejects.toMatchObject({
      name: "ScoutingWorkflowAmbiguousClaimError",
      message: "scouting-workflow-claim-ambiguous",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(repository.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "in_progress",
    });
  });

  it("terminalizes a queued attempt when its exact event fence is no longer valid", async () => {
    let eventVersion = input.eventVersion;
    const repository = new MemoryScoutingJobRepository({
      verifyScheduled: (_eventId, expectedVersion) =>
        Promise.resolve(expectedVersion === eventVersion),
    });
    const records = await repository.createJob({
      command: input,
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    eventVersion += 1;
    const fixture = { run: vi.fn(() => Promise.resolve()) };

    await expect(
      createScoutingWorkflow(
        repository,
        fixture,
        () => "2026-08-07T12:01:00.000Z",
      )(records.outbox.command),
    ).resolves.toEqual({
      outcome: "failed_terminal",
      failureCode: "event-version-changed",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(repository.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "failed_terminal",
      failureCode: "event-version-changed",
    });
  });

  it("emits bounded lifecycle metrics without using job identities as dimensions", async () => {
    const { repository, records } = await setup();
    const emit = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await createScoutingWorkflow(
        repository,
        undefined,
        () => "2026-08-07T12:01:00.000Z",
        { emit },
      )(records.outbox.command);
      expect(emit).toHaveBeenNthCalledWith(1, "AttemptClaimed");
      expect(emit).toHaveBeenNthCalledWith(2, "AttemptCompleted");
      expect(emit).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"event":"ScoutingWorkflowLifecycle"'),
      );
      expect(log.mock.calls.join("\n")).not.toContain(input.requesterId);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["fixture-transient-failure", "failed_retryable"],
    ["fixture-contract-invalid", "failed_terminal"],
  ] as const)("persists the safe %s classification", async (code, status) => {
    const { repository, records } = await setup();
    const run = createScoutingWorkflow(
      repository,
      { run: async () => Promise.reject(new ScoutingFixtureFailure(code)) },
      () => "2026-08-07T12:01:00.000Z",
    );

    await expect(run(records.outbox.command)).resolves.toEqual({
      outcome: status,
      failureCode: code,
    });
    await expect(
      repository.getAttempt(records.attempt.attemptId),
    ).resolves.toMatchObject({
      status,
      failureCode: code,
    });
  });

  it("redacts an unrecognized fixture exception into a safe terminal code", async () => {
    const { repository, records } = await setup();
    const run = createScoutingWorkflow(
      repository,
      { run: async () => Promise.reject(new Error("provider-secret")) },
      () => "2026-08-07T12:01:00.000Z",
    );

    await expect(run(records.outbox.command)).resolves.toEqual({
      outcome: "failed_terminal",
      failureCode: "workflow-terminal-failure",
    });
  });

  it("does not misclassify repository failures as fixture failures", async () => {
    const { repository, records } = await setup();
    const persistenceError = new Error("database-unavailable");
    const claimAttempt = vi.fn(async () => Promise.reject(persistenceError));
    const run = createScoutingWorkflow({
      claimAttempt,
      finishAttempt: repository.finishAttempt.bind(repository),
    });

    await expect(run(records.outbox.command)).rejects.toBe(persistenceError);
  });

  it("propagates terminal persistence failures instead of rewriting them", async () => {
    const { records } = await setup();
    const persistenceError = new Error("database-unavailable");
    const finishAttempt = vi.fn(async () => Promise.reject(persistenceError));
    const run = createScoutingWorkflow({
      claimAttempt: vi.fn(() =>
        Promise.resolve({
          outcome: "claimed" as const,
          job: records.job,
          attempt: records.attempt,
        }),
      ),
      finishAttempt,
    });

    await expect(run(records.outbox.command)).rejects.toBe(persistenceError);
    expect(finishAttempt).toHaveBeenCalledOnce();
  });
});
