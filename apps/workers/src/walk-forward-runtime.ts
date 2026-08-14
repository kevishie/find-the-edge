import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDbStrategyExperimentRepository,
  EventCursorCodec,
} from "@find-the-edge/database";
import type {
  ExperimentWindow,
  PromotionGatePolicy,
  StrategyPerformanceEvidence,
} from "@find-the-edge/domain";
import { WalkForwardExperimentBuilder } from "./walk-forward-experiment.js";

interface RequestRecord {
  baselineStrategyId: string;
  baselineVersion: string;
  challengerStrategyId: string;
  challengerVersion: string;
  trainWindowId: string;
  tuneWindowId: string;
  holdoutWindowId: string;
  baselineEvidenceId: string;
  challengerEvidenceId: string;
  policyId: string;
}
const tableName = process.env["FTE_EVENT_TABLE_NAME"] ?? "";
if (!tableName) throw new Error("walk-forward-runtime-configuration-invalid");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repository = new DynamoDbStrategyExperimentRepository(
  client,
  tableName,
  new EventCursorCodec({
    current: { id: "walk-forward-internal-v1", secret: randomBytes(32) },
  }),
);
const get = async <T>(pk: string, sk = "RECORD"): Promise<T> => {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk },
      // Experiment decisions must bind to authoritative stored evidence.
      ConsistentRead: true,
    }),
  );
  if (!result.Item?.["value"])
    throw new Error("walk-forward-authoritative-evidence-unavailable");
  return result.Item["value"] as T;
};

/** Accepts only an immutable request identity; all metrics and evidence are loaded from durable authoritative records. */
export const handler = async (event: { requestId?: unknown }) => {
  if (
    typeof event.requestId !== "string" ||
    !/^[a-zA-Z0-9:_-]{1,256}$/.test(event.requestId)
  )
    throw new Error("walk-forward-request-invalid");
  const request = await get<RequestRecord>(
    `WALK_FORWARD_REQUEST#${event.requestId}`,
  );
  const [
    baseline,
    challenger,
    train,
    tune,
    holdout,
    baselineEvidence,
    challengerEvidence,
    policy,
  ] = await Promise.all([
    repository.getArtifact(request.baselineStrategyId, request.baselineVersion),
    repository.getArtifact(
      request.challengerStrategyId,
      request.challengerVersion,
    ),
    get<ExperimentWindow>(`EXPERIMENT_WINDOW#${request.trainWindowId}`),
    get<ExperimentWindow>(`EXPERIMENT_WINDOW#${request.tuneWindowId}`),
    get<ExperimentWindow>(`EXPERIMENT_WINDOW#${request.holdoutWindowId}`),
    get<StrategyPerformanceEvidence>(
      `STRATEGY_PERFORMANCE_EVIDENCE#${request.baselineEvidenceId}`,
    ),
    get<StrategyPerformanceEvidence>(
      `STRATEGY_PERFORMANCE_EVIDENCE#${request.challengerEvidenceId}`,
    ),
    get<PromotionGatePolicy>(`STRATEGY_GATE_POLICY#${request.policyId}`),
  ]);
  if (!baseline || !challenger)
    throw new Error("walk-forward-artifact-unavailable");
  return new WalkForwardExperimentBuilder({ repository }).build({
    baseline,
    challenger,
    train,
    tune,
    holdout,
    baselineEvidence,
    challengerEvidence,
    policy,
  });
};
