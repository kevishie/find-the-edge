import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoScoutingJobRepository,
  type ScoutingJobRepository,
} from "@find-the-edge/database";
import { validateScoutingDispatchOutbox } from "@find-the-edge/domain";
import type {
  AttributeValue,
  DynamoDBStreamEvent,
  DynamoDBStreamHandler,
} from "aws-lambda";

export interface ScoutingOutboxMetricSink {
  emit(
    name: "OutboxPublished" | "OutboxFailure" | "OutboxLagMilliseconds",
    value: number,
  ): void;
}

const metrics: ScoutingOutboxMetricSink = {
  emit() {},
};

const scalar = (value: AttributeValue): unknown => {
  if ("S" in value) return value.S;
  if ("N" in value) return Number(value.N);
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("M" in value)
    return Object.fromEntries(
      Object.entries(value.M ?? {}).map(([key, child]) => [key, scalar(child)]),
    );
  if ("L" in value) return (value.L ?? []).map(scalar);
  throw new Error("scouting-stream-attribute-invalid");
};

const keyString = (
  keys: Readonly<Record<string, AttributeValue>> | undefined,
  key: string,
) => {
  const value = keys?.[key];
  return value && "S" in value ? value.S : undefined;
};

export const isScoutingOutboxPendingChange = (
  record: DynamoDBStreamEvent["Records"][number],
) =>
  (record.eventName === "INSERT" || record.eventName === "MODIFY") &&
  keyString(record.dynamodb?.Keys, "pk")?.startsWith("SCOUT_OUTBOX#") ===
    true &&
  keyString(record.dynamodb?.Keys, "sk") === "CURRENT" &&
  keyString(record.dynamodb?.NewImage?.["value"]?.M, "status") !== "published";

export const createScoutingOutboxHandler = (
  client: Pick<SQSClient, "send">,
  queueUrl: string,
  repository: Pick<ScoutingJobRepository, "markOutboxPublished">,
  metricSink: ScoutingOutboxMetricSink = metrics,
  now: () => number = Date.now,
): DynamoDBStreamHandler => {
  if (!queueUrl || queueUrl.length > 2_048)
    throw new Error("scouting-outbox-configuration-invalid");
  return async (event) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      if (!isScoutingOutboxPendingChange(record)) continue;
      const sequence = record.dynamodb?.SequenceNumber;
      if (!sequence) throw new Error("scouting-outbox-sequence-missing");
      try {
        const keys = record.dynamodb?.Keys;
        const image = record.dynamodb?.NewImage;
        if (!image) throw new Error("scouting-outbox-image-missing");
        const pk = keyString(keys, "pk");
        const sk = keyString(keys, "sk");
        if (keyString(image, "pk") !== pk || keyString(image, "sk") !== sk)
          throw new Error("scouting-outbox-key-mismatch");
        const rawValue = image["value"];
        if (!rawValue) throw new Error("scouting-outbox-value-missing");
        const outbox = validateScoutingDispatchOutbox(scalar(rawValue));
        if (outbox.status !== "pending")
          throw new Error("scouting-outbox-not-pending");
        if (pk !== `SCOUT_OUTBOX#${outbox.outboxId}`)
          throw new Error("scouting-outbox-key-mismatch");
        const result = await client.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(outbox.command),
            MessageGroupId: outbox.messageGroupId,
            MessageDeduplicationId: outbox.messageDeduplicationId,
          }),
        );
        if (!result.MessageId)
          throw new Error("scouting-outbox-publish-incomplete");
        await repository.markOutboxPublished({
          outboxId: outbox.outboxId,
          attemptId: outbox.attemptId,
          expectedVersion: outbox.version,
          publishedAt: new Date(now()).toISOString(),
        });
        const created = record.dynamodb?.ApproximateCreationDateTime;
        if (typeof created === "number")
          metricSink.emit(
            "OutboxLagMilliseconds",
            Math.max(0, Math.min(1_209_600_000, now() - created * 1_000)),
          );
        metricSink.emit("OutboxPublished", 1);
      } catch {
        metricSink.emit("OutboxFailure", 1);
        console.error(
          JSON.stringify({
            event: "ScoutingOutboxFailure",
            sequenceNumber: sequence.slice(0, 128),
          }),
        );
        batchItemFailures.push({ itemIdentifier: sequence });
      }
    }
    return { batchItemFailures };
  };
};

let runtime: DynamoDBStreamHandler | undefined;
// Two parameters, never three: Lambda reads the declared arity and Node 24
// refuses a callback-style handler outright. See fixture-odds-projection-lambda.
export const handler: DynamoDBStreamHandler = async (event) => {
  if (!runtime) {
    const queueUrl = process.env["FTE_SCOUTING_QUEUE_URL"] ?? "";
    const tableName = process.env["FTE_EVENT_TABLE"] ?? "";
    if (!tableName) throw new Error("scouting-outbox-configuration-invalid");
    const repository = new DynamoScoutingJobRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName,
    );
    runtime = createScoutingOutboxHandler(
      new SQSClient({}),
      queueUrl,
      repository,
    );
  }
  return runtime(event, undefined as never, undefined as never);
};
