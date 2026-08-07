import { MemoryScoutingJobRepository } from "@find-the-edge/database";
import { describe, expect, it, vi } from "vitest";

import { createScoutingWorkflowHandler } from "./scouting-workflow-lambda";

const setup = async () => {
  const repository = new MemoryScoutingJobRepository();
  const records = await repository.createJob({
    command: {
      schemaVersion: 1,
      requesterId: "requester-1",
      idempotencyKey: "request-1",
      eventId: "event:soccer:mls:test",
      eventVersion: 3,
      workflowIntent: "fixture-v1",
    },
    createdAt: "2026-08-07T12:00:00.000Z",
  });
  return { repository, records };
};

const invoke = (
  handler: ReturnType<typeof createScoutingWorkflowHandler>,
  event: unknown,
) => (handler as unknown as (input: unknown) => Promise<unknown>)(event);

describe("scouting workflow Lambda boundary", () => {
  it.each(["workflow-timeout", "workflow-temporarily-unavailable"] as const)(
    "fences the allowlisted %s finalizer",
    async (failureCode) => {
      const { repository, records } = await setup();
      const emit = vi.fn();
      const handler = createScoutingWorkflowHandler(
        repository,
        undefined,
        () => "2026-08-07T12:01:00.000Z",
        { emit },
      );

      await expect(
        invoke(handler, {
          schemaVersion: 1,
          action: "finalize-failure",
          jobId: records.job.jobId,
          attemptId: records.attempt.attemptId,
          failureCode,
        }),
      ).resolves.toEqual({ outcome: "failed_retryable", failureCode });
      await expect(repository.getJob(records.job.jobId)).resolves.toMatchObject(
        {
          status: "failed_retryable",
          failureCode,
        },
      );
      expect(emit).toHaveBeenCalledWith("AttemptFailedRetryable");
    },
  );

  it("rejects expanded or non-allowlisted internal finalizers", async () => {
    const { repository, records } = await setup();
    const handler = createScoutingWorkflowHandler(repository);

    await expect(
      invoke(handler, {
        schemaVersion: 1,
        action: "finalize-failure",
        jobId: records.job.jobId,
        attemptId: records.attempt.attemptId,
        failureCode: "workflow-terminal-failure",
        rawError: "secret",
      }),
    ).rejects.toThrow("scouting-failure-finalizer-invalid");
  });
});
