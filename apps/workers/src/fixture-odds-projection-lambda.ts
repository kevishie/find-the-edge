import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsFixtureOddsGateway,
  FixtureOddsCurrentProjector,
  type FixtureOddsItem,
} from "@find-the-edge/database";
import type {
  AttributeValue,
  DynamoDBStreamEvent,
  DynamoDBStreamHandler,
} from "aws-lambda";

export type ProjectionMetric =
  | "ProjectionProcessed"
  | "ProjectionAdvanced"
  | "ProjectionRetained"
  | "ProjectionFailure"
  | "ProjectionLagMilliseconds";

export interface ProjectionMetricSink {
  emit(name: ProjectionMetric, value: number): void;
}

const emfMetrics: ProjectionMetricSink = {
  emit(name, value) {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/OddsProjection",
              Dimensions: [[]],
              Metrics: [
                {
                  Name: name,
                  Unit: name.includes("Lag") ? "Milliseconds" : "Count",
                },
              ],
            },
          ],
        },
        [name]: value,
      }),
    );
  },
};

function scalar(value: AttributeValue): unknown {
  if ("S" in value) return value.S;
  if ("N" in value) return Number(value.N);
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("M" in value)
    return Object.fromEntries(
      Object.entries(value.M ?? {}).map(([key, child]) => [key, scalar(child)]),
    );
  if ("L" in value) return (value.L ?? []).map(scalar);
  throw new Error("unsupported-stream-attribute");
}

function image(value: Record<string, AttributeValue>): FixtureOddsItem {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, scalar(child)]),
  ) as unknown as FixtureOddsItem;
}

const keyString = (
  keys: Record<string, AttributeValue> | undefined,
  name: string,
) => {
  const value = keys?.[name];
  return value && "S" in value ? value.S : undefined;
};

export const isCanonicalSnapshotInsert = (
  record: DynamoDBStreamEvent["Records"][number],
) =>
  record.eventName === "INSERT" &&
  keyString(record.dynamodb?.Keys, "pk")?.startsWith("FIXTURE_ODDS#") ===
    true &&
  keyString(record.dynamodb?.Keys, "sk")?.startsWith("SNAPSHOT#") === true;

export const createFixtureOddsProjectionHandler =
  (
    projector: FixtureOddsCurrentProjector,
    metrics: ProjectionMetricSink = emfMetrics,
    now: () => number = Date.now,
  ): DynamoDBStreamHandler =>
  async (event) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      if (!isCanonicalSnapshotInsert(record)) continue;
      const identifier = record.dynamodb?.SequenceNumber;
      if (!identifier) throw new Error("snapshot-stream-sequence-missing");
      const envelopePk = keyString(record.dynamodb?.Keys, "pk");
      const envelopeSk = keyString(record.dynamodb?.Keys, "sk");
      try {
        if (!record.dynamodb?.NewImage)
          throw new Error("snapshot-stream-record-invalid");
        const created = record.dynamodb.ApproximateCreationDateTime;
        if (typeof created === "number")
          metrics.emit(
            "ProjectionLagMilliseconds",
            Math.max(0, Math.min(604_800_000, now() - created * 1000)),
          );
        const item = image(record.dynamodb.NewImage);
        if (item.pk !== envelopePk || item.sk !== envelopeSk)
          throw new Error("snapshot-stream-key-mismatch");
        const result = await projector.project(item);
        metrics.emit("ProjectionProcessed", 1);
        metrics.emit(
          result.decision === "advanced"
            ? "ProjectionAdvanced"
            : "ProjectionRetained",
          1,
        );
      } catch {
        metrics.emit("ProjectionFailure", 1);
        console.error(
          JSON.stringify({
            event: "FixtureOddsProjectionFailure",
            sequenceNumber: identifier.slice(0, 128),
            ...(envelopePk ? { pk: envelopePk.slice(0, 512) } : {}),
            ...(envelopeSk ? { sk: envelopeSk.slice(0, 512) } : {}),
          }),
        );
        batchItemFailures.push({ itemIdentifier: identifier });
      }
    }
    return { batchItemFailures };
  };

const tableName = process.env["FTE_EVENT_TABLE"];
const runtimeHandler = tableName
  ? createFixtureOddsProjectionHandler(
      new FixtureOddsCurrentProjector(
        new AwsFixtureOddsGateway(
          DynamoDBDocumentClient.from(new DynamoDBClient({})),
          tableName,
        ),
      ),
    )
  : undefined;

/**
 * Two parameters, never three. Lambda decides a handler is callback-based by
 * how many parameters it DECLARES, and Node 24 removed callback support — so a
 * third parameter here stops the function booting at all, on every invocation,
 * with `Runtime.CallbackHandlerDeprecated` before any of this code runs.
 *
 * That is not hypothetical: this function failed 2,312,637 of 2,312,637
 * invocations over the two days to 2026-08-13, with its errors and DLQ alarms
 * in ALARM since 08-07, because the parameter below was declared and unused.
 * The inner handler is async and ignores both context and callback.
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  if (!runtimeHandler)
    throw new Error("fixture-odds-projection-configuration-invalid");
  return runtimeHandler(event, undefined as never, undefined as never);
};
