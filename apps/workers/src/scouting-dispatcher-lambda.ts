import {
  DescribeExecutionCommand,
  SFNClient,
  StartExecutionCommand,
  type DescribeExecutionCommandOutput,
  type StartExecutionCommandOutput,
} from "@aws-sdk/client-sfn";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoScoutingJobRepository,
  type ScoutingJobRepository,
} from "@find-the-edge/database";
import {
  sha256Hex,
  validateScoutingDispatchCommand,
  type ScoutingDispatchCommand,
  type ScoutingFailureCode,
} from "@find-the-edge/domain";
import type { SQSBatchResponse, SQSEvent, SQSHandler } from "aws-lambda";

export interface ScoutingDispatcherMetricSink {
  emit(
    name:
      | "ExecutionStarted"
      | "DuplicateDispatch"
      | "ExecutionRecovered"
      | "DispatchFailure",
  ): void;
}

type StartExecutionClient = {
  send(
    command: StartExecutionCommand | DescribeExecutionCommand,
  ): Promise<StartExecutionCommandOutput | DescribeExecutionCommandOutput>;
};

const metrics: ScoutingDispatcherMetricSink = {
  emit() {},
};

const executionName = (body: string) => `scout-${sha256Hex(body)}`;

const executionArn = (stateMachineArn: string, name: string): string => {
  const marker = ":stateMachine:";
  const markerIndex = stateMachineArn.indexOf(marker);
  if (markerIndex < 1) throw new Error("scouting-state-machine-arn-invalid");
  const prefix = stateMachineArn.slice(0, markerIndex);
  const stateMachineName = stateMachineArn
    .slice(markerIndex + marker.length)
    .split(":")[0];
  if (!stateMachineName) throw new Error("scouting-state-machine-arn-invalid");
  return `${prefix}:execution:${stateMachineName}:${name}`;
};

const errorName = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";

const logLifecycle = (input: {
  readonly outcome:
    | "started"
    | "existing-running"
    | "existing-succeeded"
    | "existing-recovered"
    | "failed";
  readonly command?: ScoutingDispatchCommand;
  readonly executionStatus?: string;
  readonly messageId: string;
  readonly failureCode?: ScoutingFailureCode;
}) => {
  console.log(
    JSON.stringify({
      event: "ScoutingDispatchLifecycle",
      outcome: input.outcome,
      messageId: input.messageId.slice(0, 128),
      ...(input.command
        ? {
            jobId: input.command.jobId,
            attemptId: input.command.attemptId,
          }
        : {}),
      ...(input.executionStatus
        ? { executionStatus: input.executionStatus }
        : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    }),
  );
};

export const createScoutingDispatcherHandler = (
  client: StartExecutionClient,
  stateMachineArn: string,
  repository?: Pick<ScoutingJobRepository, "finishAttempt">,
  metricSink: ScoutingDispatcherMetricSink = metrics,
  now: () => number = Date.now,
): SQSHandler => {
  if (!stateMachineArn || stateMachineArn.length > 2_048)
    throw new Error("scouting-dispatcher-configuration-invalid");

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    for (const record of event.Records) {
      let command: ScoutingDispatchCommand | undefined;
      try {
        command = validateScoutingDispatchCommand(
          JSON.parse(record.body) as unknown,
        );
        const input = JSON.stringify(command);
        await client.send(
          new StartExecutionCommand({
            stateMachineArn,
            name: executionName(input),
            input,
          }),
        );
        metricSink.emit("ExecutionStarted");
        logLifecycle({
          outcome: "started",
          command,
          messageId: record.messageId,
        });
      } catch (error) {
        if (errorName(error) === "ExecutionAlreadyExists" && command) {
          try {
            const name = executionName(JSON.stringify(command));
            const description = (await client.send(
              new DescribeExecutionCommand({
                executionArn: executionArn(stateMachineArn, name),
              }),
            )) as DescribeExecutionCommandOutput;
            const status = description.status;
            if (status === "RUNNING" || status === "SUCCEEDED") {
              metricSink.emit("DuplicateDispatch");
              logLifecycle({
                outcome:
                  status === "RUNNING"
                    ? "existing-running"
                    : "existing-succeeded",
                command,
                executionStatus: status,
                messageId: record.messageId,
              });
              continue;
            }
            if (
              status !== "FAILED" &&
              status !== "TIMED_OUT" &&
              status !== "ABORTED"
            )
              throw new Error("scouting-execution-status-invalid");
            if (!repository)
              throw new Error("scouting-dispatcher-repository-missing");
            const failureCode =
              status === "TIMED_OUT"
                ? "workflow-timeout"
                : "workflow-temporarily-unavailable";
            await repository.finishAttempt({
              jobId: command.jobId,
              attemptId: command.attemptId,
              status: "failed_retryable",
              failureCode,
              finishedAt: new Date(now()).toISOString(),
            });
            metricSink.emit("ExecutionRecovered");
            logLifecycle({
              outcome: "existing-recovered",
              command,
              executionStatus: status,
              messageId: record.messageId,
              failureCode,
            });
            continue;
          } catch {
            // Fall through to partial-batch failure so recovery is retried.
          }
        }
        metricSink.emit("DispatchFailure");
        logLifecycle({
          outcome: "failed",
          ...(command ? { command } : {}),
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
};

let runtime: SQSHandler | undefined;
// Two parameters, never three: Lambda reads the declared arity and Node 24
// refuses a callback-style handler outright. See fixture-odds-projection-lambda.
export const handler: SQSHandler = async (event) => {
  if (!runtime) {
    const stateMachineArn = process.env["FTE_SCOUTING_STATE_MACHINE_ARN"] ?? "";
    const tableName = process.env["FTE_EVENT_TABLE"] ?? "";
    if (!tableName)
      throw new Error("scouting-dispatcher-configuration-invalid");
    runtime = createScoutingDispatcherHandler(
      new SFNClient({}),
      stateMachineArn,
      new DynamoScoutingJobRepository(
        DynamoDBDocumentClient.from(new DynamoDBClient({})),
        tableName,
      ),
    );
  }
  return runtime(event, undefined as never, undefined as never);
};
