import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { EventBridgeEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createSchedulerHandler } from "./scheduler-producer";

const event = {
  id: "scheduled-id",
  time: "2026-07-30T12:34:56.000Z",
} as EventBridgeEvent<"Scheduled Event", Record<string, never>>;

describe("scheduler producer", () => {
  it("publishes one stable non-overlapping FIFO bucket idempotently", async () => {
    process.env["FTE_UPCOMING_QUEUE_URL"] = "queue";
    let captured: SendMessageBatchCommand | undefined;
    const sender = {
      send: async (command: SendMessageBatchCommand) => {
        await Promise.resolve();
        captured = command;
        return {
          Successful: [
            { Id: "0", MessageId: "a" },
            { Id: "1", MessageId: "b" },
          ],
          Failed: [],
        };
      },
    };
    await createSchedulerHandler(sender as never)(event);
    if (!captured) throw new Error("command-not-captured");
    const input = captured.input;
    if (!input.Entries) throw new Error("entries-not-captured");
    expect(input.Entries).toHaveLength(2);
    const bodies = input.Entries.map(
      (item) =>
        JSON.parse(item.MessageBody ?? "") as {
          windowStart: string;
          windowEnd: string;
        },
    );
    expect(new Set(bodies.map((body) => body.windowStart)).size).toBe(1);
    const first = bodies[0];
    if (!first) throw new Error("body-not-captured");
    expect(first.windowStart).toBe("2026-07-30T12:00:00.000Z");
    expect(Date.parse(first.windowEnd) - Date.parse(first.windowStart)).toBe(
      7 * 86_400_000,
    );
    expect(input.Entries.every((item) => item.MessageDeduplicationId)).toBe(
      true,
    );
  });

  it("rejects partial or incomplete SDK success", async () => {
    process.env["FTE_UPCOMING_QUEUE_URL"] = "queue";
    const send = vi.fn().mockResolvedValue({
      Successful: [{ Id: "0", MessageId: "a" }],
      Failed: [],
    });
    await expect(
      createSchedulerHandler({ send } as never)(event),
    ).rejects.toThrow("schedule-publish-failed");
    send.mockResolvedValue({
      Successful: [
        { Id: "0", MessageId: "a" },
        { Id: "unexpected", MessageId: "b" },
      ],
      Failed: [],
    });
    await expect(
      createSchedulerHandler({ send } as never)(event),
    ).rejects.toThrow("schedule-publish-failed");
  });

  it("uses an hour-floor refresh generation and stable same-hour identity", async () => {
    process.env["FTE_UPCOMING_QUEUE_URL"] = "queue";
    const captured: SendMessageBatchCommand[] = [];
    const sender = {
      send: async (command: SendMessageBatchCommand) => {
        await Promise.resolve();
        captured.push(command);
        return {
          Successful: command.input.Entries?.map((entry) => ({
            Id: entry.Id,
            MessageId: entry.Id,
          })),
          Failed: [],
        };
      },
    };
    const handler = createSchedulerHandler(sender as never);
    await handler(event);
    await handler({
      ...event,
      id: "retry-after-five-minutes",
      time: "2026-07-30T12:59:59.000Z",
    });
    await handler({
      ...event,
      id: "next-hour",
      time: "2026-07-30T13:34:56.000Z",
    });
    await handler({
      ...event,
      id: "tomorrow",
      time: "2026-07-31T12:34:56.000Z",
    });
    expect(captured[1]?.input.Entries).toEqual(captured[0]?.input.Entries);
    const today = JSON.parse(
      captured[0]?.input.Entries?.[0]?.MessageBody ?? "",
    ) as { checkpointScope: string; windowEnd: string };
    const nextHour = JSON.parse(
      captured[2]?.input.Entries?.[0]?.MessageBody ?? "",
    ) as { checkpointScope: string; windowEnd: string };
    const tomorrow = JSON.parse(
      captured[3]?.input.Entries?.[0]?.MessageBody ?? "",
    ) as { checkpointScope: string; windowEnd: string };
    expect(nextHour.checkpointScope).not.toBe(today.checkpointScope);
    expect(Date.parse(nextHour.windowEnd) - Date.parse(today.windowEnd)).toBe(
      3_600_000,
    );
    expect(tomorrow.checkpointScope).not.toBe(today.checkpointScope);
    expect(Date.parse(tomorrow.windowEnd)).toBeGreaterThan(
      Date.parse(today.windowEnd),
    );
    expect(
      captured[0]?.input.Entries?.every(
        (entry) =>
          entry.MessageGroupId === "mlb:mlb" ||
          entry.MessageGroupId === "soccer:mls",
      ),
    ).toBe(true);
  });
});
