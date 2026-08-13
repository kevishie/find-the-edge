import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoScoutingJobRepository,
  DynamoScoutingReportRepository,
  type ScoutingJobRepository,
} from "@find-the-edge/database";
import type { Handler } from "aws-lambda";
import type { ScoutingFailureCode } from "@find-the-edge/domain";

import {
  createScoutingWorkflow,
  logScoutingWorkflowLifecycle,
  scoutingWorkflowMetrics,
  type ScoutingFixtureWorkflow,
  type ScoutingWorkflowMetricSink,
  type ScoutingWorkflowReportStore,
  type ScoutingWorkflowResult,
} from "./scouting-workflow";

/**
 * What the factory actually returns: a plain async function of the event.
 * Declaring it as `Handler` was a lie that mattered — `Handler`'s call
 * signature carries the callback parameters, which pushed the exported
 * handler to an arity Lambda refuses to boot under Node 24.
 */
export type ScoutingWorkflowRuntime = (
  event: unknown,
) => Promise<ScoutingWorkflowResult>;

export const createScoutingWorkflowHandler = (
  repository: Pick<ScoutingJobRepository, "claimAttempt" | "finishAttempt">,
  reports: ScoutingWorkflowReportStore,
  fixture?: ScoutingFixtureWorkflow,
  now?: () => string,
  metricSink: ScoutingWorkflowMetricSink = scoutingWorkflowMetrics,
): ScoutingWorkflowRuntime => {
  const run = createScoutingWorkflow(
    repository,
    reports,
    fixture,
    now,
    metricSink,
  );
  return async (event) => {
    const failure = parseFailureFinalizer(event);
    if (!failure) return run(event);
    const finish = await repository.finishAttempt({
      jobId: failure.jobId,
      attemptId: failure.attemptId,
      status: "failed_retryable",
      failureCode: failure.failureCode,
      finishedAt: (now ?? (() => new Date().toISOString()))(),
    });
    if (finish.outcome === "stale") {
      metricSink.emit("AttemptStale");
      return { outcome: "stale" };
    }
    metricSink.emit("AttemptFailedRetryable");
    logScoutingWorkflowLifecycle({
      outcome: "failed_retryable",
      jobId: failure.jobId,
      attemptId: failure.attemptId,
      failureCode: failure.failureCode,
    });
    return { outcome: "failed_retryable", failureCode: failure.failureCode };
  };
};

interface ScoutingFailureFinalizer {
  readonly schemaVersion: 1;
  readonly action: "finalize-failure";
  readonly jobId: string;
  readonly attemptId: string;
  readonly failureCode: "workflow-timeout" | "workflow-temporarily-unavailable";
}

const finalizerCodes: ReadonlySet<ScoutingFailureCode> = new Set([
  "workflow-timeout",
  "workflow-temporarily-unavailable",
]);

const parseFailureFinalizer = (
  input: unknown,
): ScoutingFailureFinalizer | undefined => {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !("action" in input)
  )
    return undefined;
  const value = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(value).sort().join("|") !==
      ["action", "attemptId", "failureCode", "jobId", "schemaVersion"]
        .sort()
        .join("|") ||
    value["schemaVersion"] !== 1 ||
    value["action"] !== "finalize-failure" ||
    typeof value["jobId"] !== "string" ||
    !/^scout-job:[a-f0-9]{64}$/.test(value["jobId"]) ||
    typeof value["attemptId"] !== "string" ||
    !/^scout-attempt:[a-f0-9]{64}$/.test(value["attemptId"]) ||
    !finalizerCodes.has(value["failureCode"] as ScoutingFailureCode)
  )
    throw new Error("scouting-failure-finalizer-invalid");
  return Object.freeze(value as unknown as ScoutingFailureFinalizer);
};

let runtime: ScoutingWorkflowRuntime | undefined;
// Two parameters, never three: Lambda reads the declared arity and Node 24
// refuses a callback-style handler outright. See fixture-odds-projection-lambda.
export const handler: Handler<unknown, ScoutingWorkflowResult> = async (
  event,
) => {
  if (!runtime) {
    const tableName = process.env["FTE_EVENT_TABLE"] ?? "";
    if (!tableName) throw new Error("scouting-workflow-configuration-invalid");
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    runtime = createScoutingWorkflowHandler(
      new DynamoScoutingJobRepository(client, tableName),
      new DynamoScoutingReportRepository(client, tableName),
    );
  }
  return runtime(event);
};
