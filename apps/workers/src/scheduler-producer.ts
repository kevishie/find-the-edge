import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { EventBridgeEvent } from "aws-lambda";

const client = new SQSClient({});
const DAY_MS = 86_400_000;

type Sender = Pick<SQSClient, "send">;

export const createSchedulerHandler =
  (sender: Sender) =>
  async (
    event: EventBridgeEvent<"Scheduled Event", Record<string, never>>,
  ): Promise<void> => {
    const queueUrl = process.env["FTE_UPCOMING_QUEUE_URL"];
    if (!queueUrl) throw new Error("missing-upcoming-queue-url");
    const now = new Date(event.time);
    if (!Number.isFinite(now.getTime()))
      throw new Error("invalid-schedule-time");
    // EventBridge runs hourly. Each hour is a refresh generation over the
    // same rolling daily horizon, so terminal checkpoints never turn later
    // same-day additions/reschedules/cancellations into redundant no-ops.
    const refreshGeneration = Math.floor(now.getTime() / 3_600_000);
    const generationInstant = new Date(refreshGeneration * 3_600_000);
    const windowStart = generationInstant.toISOString();
    const windowEnd = new Date(
      generationInstant.getTime() + 7 * DAY_MS,
    ).toISOString();
    const generationId = generationInstant.toISOString().replace(/[^0-9]/g, "");
    const checkpointScope = `scheduled-refresh-${refreshGeneration}-${generationId}`;
    const commands = [
      { sportKey: "mlb", leagueKey: "mlb" },
      { sportKey: "soccer", leagueKey: "mls" },
    ].map((league, index) => {
      const body = JSON.stringify({
        ...league,
        attemptId: `scheduled-refresh-${generationId}:${league.sportKey}:${league.leagueKey}`,
        checkpointScope,
        windowStart,
        windowEnd,
        pageLimit: 100,
        maxPages: 20,
      });
      return {
        Id: String(index),
        MessageBody: body,
        MessageGroupId: `${league.sportKey}:${league.leagueKey}`,
        // Stable beyond SQS's five-minute deduplication cache. A delayed
        // partial-batch retry therefore reaches the same downstream attempt.
        MessageDeduplicationId: `scheduled-refresh-${generationId}:${league.sportKey}:${league.leagueKey}`,
      };
    });
    const result = await sender.send(
      new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: commands }),
    );
    const expectedIds = new Set(commands.map((command) => command.Id));
    const successfulIds = result.Successful?.map((item) => item.Id) ?? [];
    if (
      result.Failed?.length ||
      successfulIds.length !== commands.length ||
      new Set(successfulIds).size !== successfulIds.length ||
      successfulIds.some((id) => !id || !expectedIds.has(id)) ||
      result.Successful?.some((item) => !item.MessageId)
    )
      throw new Error("schedule-publish-failed");
  };

export const handler = createSchedulerHandler(client);
