import {
  createQueuedScoutingRecords,
  type ScoutingJobCommand,
} from "@find-the-edge/domain";
import type { SQSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

import { createScoutingDispatcherHandler } from "./scouting-dispatcher-lambda";

const queued = createQueuedScoutingRecords(
  {
    schemaVersion: 1,
    requesterId: "requester-1",
    idempotencyKey: "request-1",
    eventId: "event:soccer:mls:test",
    eventVersion: 3,
    workflowIntent: "fixture-v1",
  } satisfies ScoutingJobCommand,
  "2026-08-07T12:00:00.000Z",
);

const message = (body: unknown, messageId = "message-1") => ({
  messageId,
  receiptHandle: "receipt",
  body: typeof body === "string" ? body : JSON.stringify(body),
  attributes: {
    ApproximateReceiveCount: "1",
    SentTimestamp: "0",
    SenderId: "sender",
    ApproximateFirstReceiveTimestamp: "0",
  },
  messageAttributes: {},
  md5OfBody: "digest",
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:123:scouting.fifo",
  awsRegion: "us-east-1",
});

const invoke = (
  handler: ReturnType<typeof createScoutingDispatcherHandler>,
  records: ReturnType<typeof message>[],
) =>
  (handler as unknown as (event: SQSEvent) => Promise<unknown>)({
    Records: records,
  });

describe("scouting FIFO dispatcher", () => {
  it("starts a deterministic Standard execution with the exact command", async () => {
    const send = vi.fn((command: unknown) => {
      void command;
      return Promise.resolve({
        executionArn: "arn:execution",
        startDate: new Date(),
      });
    });
    const handler = createScoutingDispatcherHandler(
      { send } as never,
      "arn:aws:states:us-east-1:123:stateMachine:scouting",
    );

    await expect(
      invoke(handler, [message(queued.outbox.command)]),
    ).resolves.toEqual({
      batchItemFailures: [],
    });
    const first = (
      send.mock.calls[0]?.[0] as {
        input: Record<string, unknown>;
      }
    ).input;
    expect(first["stateMachineArn"]).toBe(
      "arn:aws:states:us-east-1:123:stateMachine:scouting",
    );
    expect(first["name"]).toMatch(/^scout-[a-f0-9]{64}$/);
    expect(JSON.parse(String(first["input"]))).toEqual(queued.outbox.command);

    await invoke(handler, [message(queued.outbox.command, "message-2")]);
    const second = (
      send.mock.calls[1]?.[0] as {
        input: Record<string, unknown>;
      }
    ).input;
    expect(second["name"]).toBe(first["name"]);
  });

  it.each(["RUNNING", "SUCCEEDED"] as const)(
    "acknowledges an existing %s deterministic execution",
    async (status) => {
      const duplicate = Object.assign(new Error("already exists"), {
        name: "ExecutionAlreadyExists",
      });
      const send = vi.fn((command: { constructor: { name: string } }) =>
        command.constructor.name === "StartExecutionCommand"
          ? Promise.reject(duplicate)
          : Promise.resolve({ status }),
      );
      const handler = createScoutingDispatcherHandler(
        { send } as never,
        "arn:aws:states:us-east-1:123:stateMachine:scouting",
      );

      await expect(
        invoke(handler, [message(queued.outbox.command)]),
      ).resolves.toEqual({ batchItemFailures: [] });
      const describe = (
        send.mock.calls[1]?.[0] as { input: Record<string, unknown> }
      ).input;
      expect(describe["executionArn"]).toMatch(
        /^arn:aws:states:us-east-1:123:execution:scouting:scout-[a-f0-9]{64}$/,
      );
    },
  );

  it.each([
    ["FAILED", "workflow-temporarily-unavailable"],
    ["ABORTED", "workflow-temporarily-unavailable"],
    ["TIMED_OUT", "workflow-timeout"],
  ] as const)(
    "recovers an existing %s execution through the fenced repository",
    async (status, failureCode) => {
      const duplicate = Object.assign(new Error("already exists"), {
        name: "ExecutionAlreadyExists",
      });
      const send = vi.fn((command: { constructor: { name: string } }) =>
        command.constructor.name === "StartExecutionCommand"
          ? Promise.reject(duplicate)
          : Promise.resolve({ status }),
      );
      const finishAttempt = vi.fn(() =>
        Promise.resolve({ outcome: "finished", job: null, attempt: null }),
      );
      const emit = vi.fn();
      const handler = createScoutingDispatcherHandler(
        { send } as never,
        "arn:aws:states:us-east-1:123:stateMachine:scouting",
        { finishAttempt } as never,
        { emit },
        () => Date.parse("2026-08-07T12:05:00.000Z"),
      );

      await expect(
        invoke(handler, [message(queued.outbox.command)]),
      ).resolves.toEqual({ batchItemFailures: [] });
      expect(finishAttempt).toHaveBeenCalledWith({
        jobId: queued.job.jobId,
        attemptId: queued.attempt.attemptId,
        status: "failed_retryable",
        failureCode,
        finishedAt: "2026-08-07T12:05:00.000Z",
      });
      expect(emit).toHaveBeenCalledWith("ExecutionRecovered");
    },
  );

  it("redrives an existing terminal execution when fenced recovery fails", async () => {
    const duplicate = Object.assign(new Error("already exists"), {
      name: "ExecutionAlreadyExists",
    });
    const send = vi.fn((command: { constructor: { name: string } }) =>
      command.constructor.name === "StartExecutionCommand"
        ? Promise.reject(duplicate)
        : Promise.resolve({ status: "FAILED" }),
    );
    const handler = createScoutingDispatcherHandler(
      { send } as never,
      "arn:aws:states:us-east-1:123:stateMachine:scouting",
      {
        finishAttempt: () => Promise.reject(new Error("database unavailable")),
      },
    );

    await expect(
      invoke(handler, [message(queued.outbox.command)]),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
  });

  it("returns malformed and service-failed messages for retry or DLQ", async () => {
    const send = vi.fn((command: unknown) => {
      void command;
      return Promise.reject(new Error("service unavailable"));
    });
    const handler = createScoutingDispatcherHandler({ send }, "arn");

    await expect(
      invoke(handler, [
        message("not-json", "bad"),
        message(queued.outbox.command, "down"),
      ]),
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: "bad" },
        { itemIdentifier: "down" },
      ],
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
