import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  AwsDynamoGateway,
  DynamoEventIngestionStore,
} from "@find-the-edge/database";
import {
  defaultFeedCoverageRegistry,
  FixtureMlbScheduleAdapter,
  FixtureMlsScheduleAdapter,
  ScheduleAdapterRegistry,
} from "@find-the-edge/providers";
import { createSqsHandler } from "./handler";
import { SqsContinuationPublisher } from "./sqs-continuation-publisher";
import { UpcomingEventIngestionOrchestrator } from "./upcoming-event-orchestrator";
const table = process.env["FTE_EVENT_TABLE"];
if (!table) throw new Error("FTE_EVENT_TABLE required");
const queueUrl = process.env["FTE_UPCOMING_QUEUE_URL"];
if (!queueUrl) throw new Error("FTE_UPCOMING_QUEUE_URL required");
const store = new DynamoEventIngestionStore(
  new AwsDynamoGateway(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
    table,
  ),
);
export const handler = createSqsHandler(
  new UpcomingEventIngestionOrchestrator(
    defaultFeedCoverageRegistry,
    new ScheduleAdapterRegistry([
      new FixtureMlbScheduleAdapter(),
      new FixtureMlsScheduleAdapter(),
    ]),
    store,
    undefined,
    new SqsContinuationPublisher(new SQSClient({}), queueUrl),
  ),
  (count) => {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/UpcomingEvents",
              Dimensions: [["FunctionName"]],
              Metrics: [{ Name: "FailedRecords", Unit: "Count" }],
            },
          ],
        },
        FunctionName: process.env["AWS_LAMBDA_FUNCTION_NAME"] ?? "unknown",
        FailedRecords: count,
      })}\n`,
    );
  },
);
