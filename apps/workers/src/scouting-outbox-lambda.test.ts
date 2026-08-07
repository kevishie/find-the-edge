import {
  createQueuedScoutingRecords,
  type ScoutingJobCommand,
} from "@find-the-edge/domain";
import type { AttributeValue, DynamoDBStreamEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

import {
  createScoutingOutboxHandler,
  isScoutingOutboxPendingChange,
} from "./scouting-outbox-lambda";

const invoke = (
  handler: ReturnType<typeof createScoutingOutboxHandler>,
  event: unknown,
) => (handler as unknown as (input: unknown) => Promise<unknown>)(event);

const input: ScoutingJobCommand = {
  schemaVersion: 1,
  requesterId: "requester-1",
  idempotencyKey: "request-1",
  eventId: "event:soccer:mls:test",
  eventVersion: 3,
  workflowIntent: "fixture-v1",
};
const outbox = createQueuedScoutingRecords(
  input,
  "2026-08-07T12:00:00.000Z",
).outbox;

const attribute = (value: unknown): AttributeValue => {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (value === null) return { NULL: true };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  return {
    M: Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        attribute(child),
      ]),
    ),
  };
};

const text = (value: string): AttributeValue => ({ S: value });
const publicationStore = () => ({
  markOutboxPublished: vi.fn(
    (input: {
      outboxId: string;
      attemptId: string;
      expectedVersion: number;
      publishedAt: string;
    }) => {
      void input;
      return Promise.resolve({
        ...outbox,
        status: "published" as const,
        version: 2,
        publishedAt: "2026-08-07T12:00:01.000Z",
      });
    },
  ),
});
const streamRecord = (
  overrides: Partial<DynamoDBStreamEvent["Records"][number]> = {},
): DynamoDBStreamEvent["Records"][number] => ({
  eventID: "stream-record-1",
  eventName: "INSERT",
  eventSource: "aws:dynamodb",
  awsRegion: "us-east-1",
  eventVersion: "1.1",
  eventSourceARN: "arn:aws:dynamodb:us-east-1:123:table/events/stream/x",
  dynamodb: {
    SequenceNumber: "100",
    Keys: {
      pk: text(`SCOUT_OUTBOX#${outbox.outboxId}`),
      sk: text("CURRENT"),
    },
    NewImage: {
      pk: text(`SCOUT_OUTBOX#${outbox.outboxId}`),
      sk: text("CURRENT"),
      value: attribute(outbox),
    },
  },
  ...overrides,
});

describe("scouting outbox stream relay", () => {
  it("publishes an exact outbox insert with stable FIFO identities", async () => {
    const send = vi.fn((command: unknown) => {
      void command;
      return Promise.resolve({ MessageId: "message-1" });
    });
    const repository = publicationStore();
    const handler = createScoutingOutboxHandler(
      { send } as never,
      "https://sqs.us-east-1.amazonaws.com/123/scouting.fifo",
      repository,
    );

    await expect(
      invoke(handler, { Records: [streamRecord()] }),
    ).resolves.toEqual({ batchItemFailures: [] });
    const message = (
      send.mock.calls[0]?.[0] as { input: Record<string, unknown> }
    ).input;
    expect(message).toMatchObject({
      MessageGroupId: outbox.messageGroupId,
      MessageDeduplicationId: outbox.messageDeduplicationId,
    });
    expect(JSON.parse(String(message["MessageBody"]))).toEqual(outbox.command);
    const publication = repository.markOutboxPublished.mock.calls[0]?.[0];
    expect(publication).toMatchObject({
      outboxId: outbox.outboxId,
      attemptId: outbox.attemptId,
      expectedVersion: 1,
    });
    expect(publication?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores unrelated table inserts and outbox modifications", async () => {
    const send = vi.fn();
    const handler = createScoutingOutboxHandler(
      { send } as never,
      "queue",
      publicationStore(),
    );
    const unrelated = streamRecord({
      dynamodb: {
        ...streamRecord().dynamodb,
        Keys: { pk: text("EVENT#one"), sk: text("CURRENT") },
      },
    });
    const modification = streamRecord({
      eventName: "MODIFY",
      dynamodb: {
        ...streamRecord().dynamodb,
        NewImage: {
          ...streamRecord().dynamodb?.NewImage,
          value: attribute({
            ...outbox,
            status: "published",
            version: 2,
            publishedAt: "2026-08-07T12:00:01.000Z",
          }),
        },
      },
    });

    await expect(
      invoke(handler, { Records: [unrelated, modification] }),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns malformed or incompletely published outboxes for stream retry", async () => {
    const send = vi.fn(() => Promise.resolve({}));
    const handler = createScoutingOutboxHandler(
      { send } as never,
      "queue",
      publicationStore(),
    );
    const malformed = streamRecord();
    delete malformed.dynamodb?.NewImage?.["value"];
    const incomplete = streamRecord({
      dynamodb: { ...streamRecord().dynamodb, SequenceNumber: "101" },
    });

    await expect(
      invoke(handler, { Records: [malformed, incomplete] }),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "100" }, { itemIdentifier: "101" }],
    });
  });

  it("recognizes only pending outbox inserts", () => {
    expect(isScoutingOutboxPendingChange(streamRecord())).toBe(true);
    expect(
      isScoutingOutboxPendingChange(streamRecord({ eventName: "MODIFY" })),
    ).toBe(true);
    expect(
      isScoutingOutboxPendingChange(streamRecord({ eventName: "REMOVE" })),
    ).toBe(false);
  });
});
