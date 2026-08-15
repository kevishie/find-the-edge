import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoOddsControlPlaneStore,
  DynamoProviderLandingRepository,
  instrumentDynamoCapacity,
} from "@find-the-edge/database";
import {
  fetchSharpApiCatalog,
  fetchSharpApiUniversalEventsPage,
  fetchSharpApiUniversalOddsPage,
  SharpApiError,
} from "@find-the-edge/providers";
import type { Context } from "aws-lambda";

import { emitDynamoCapacityMetrics } from "./dynamo-capacity-metrics";
import {
  runProviderLanding,
  SharedSharpApiAccountRateCoordinator,
  type ProviderLandingMetricSink,
} from "./provider-landing";

export const parseProviderLandingSecret = (value: string | undefined) => {
  if (!value) throw new Error("provider-landing-secret-missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const apiKey = (parsed as Record<string, unknown>)["apiKey"];
      if (
        typeof apiKey === "string" &&
        apiKey.length > 0 &&
        apiKey.length <= 512 &&
        apiKey === apiKey.trim()
      )
        return apiKey;
      throw new Error("provider-landing-secret-invalid");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "provider-landing-secret-invalid"
    )
      throw error;
  }
  if (value.length > 0 && value.length <= 512 && value === value.trim())
    return value;
  throw new Error("provider-landing-secret-invalid");
};

export const createProviderLandingMetricSink = (
  stage: string,
): ProviderLandingMetricSink => ({
  emit(metric, value, dimensions) {
    const Stream = dimensions["stream"] ?? "unknown";
    const Outcome = dimensions["outcome"] ?? dimensions["reason"] ?? "unknown";
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/ProviderLanding",
              Dimensions: [["Stage", "Stream", "Outcome"]],
              Metrics: [
                {
                  Name: metric,
                  Unit: metric.endsWith("AgeSeconds") ? "Seconds" : "Count",
                },
              ],
            },
          ],
        },
        Stage: stage,
        Stream,
        Outcome,
        [metric]: value,
      })}\n`,
    );
  },
});

export const providerLandingTerminalReason = (error: unknown) => {
  if (
    error instanceof SharpApiError &&
    (["configuration", "not-entitled", "unauthorized"].includes(error.code) ||
      (error.code === "provider-rejected" && !error.retryable))
  )
    return error.code;
  if (
    error instanceof Error &&
    [
      "provider-landing-account-terminal",
      "provider-landing-configuration-invalid",
      "provider-landing-secret-missing",
      "provider-landing-secret-invalid",
    ].includes(error.message)
  )
    return error.message === "provider-landing-account-terminal"
      ? ("account-terminal" as const)
      : ("configuration" as const);
  if (error instanceof Error && error.name === "ResourceNotFoundException")
    return "configuration" as const;
  return null;
};

export const settleProviderLandingTerminalFailure = async (
  error: unknown,
  accountRate: SharedSharpApiAccountRateCoordinator | undefined,
  metrics: ProviderLandingMetricSink,
  failedAt = new Date(),
) => {
  const reason = providerLandingTerminalReason(error);
  if (!reason) throw error;
  // Provider-origin terminal failures have already updated shared account
  // health at the orchestration boundary. Only local secret/configuration
  // failures reach here without that durable circuit-breaker transition.
  if (
    accountRate &&
    reason === "configuration" &&
    !(error instanceof SharpApiError)
  )
    await accountRate.terminal("configuration", failedAt);
  // Terminal provider/account failures are actionable once, but retrying the
  // same credentials twice in the same EventBridge delivery is pure noise.
  metrics.emit("ProviderLandingTerminalFailure", 1, {
    stream: "account",
    outcome: "terminal",
  });
  process.stdout.write(
    `${JSON.stringify({ event: "provider-landing-terminal", reason })}\n`,
  );
  return { terminal: true as const, reason };
};

const inferredMetricStage = () => {
  const configured = process.env["FTE_AWS_STAGE"];
  if (configured) return configured;
  const functionName = process.env["AWS_LAMBDA_FUNCTION_NAME"] ?? "";
  return (
    functionName.match(/(?:^|-)(staging|prod|dev)(?:-|$)/)?.[1] ?? "unknown"
  );
};

export const handler = async (event: unknown, context: Context) => {
  void event;
  const tableName = process.env["FTE_EVENT_TABLE"];
  const secretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const stage = process.env["FTE_AWS_STAGE"];
  const metrics = createProviderLandingMetricSink(inferredMetricStage());
  let accountRate: SharedSharpApiAccountRateCoordinator | undefined;
  try {
    if (!tableName || !secretId || !stage)
      throw new Error("provider-landing-configuration-invalid");
    const client = instrumentDynamoCapacity(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      emitDynamoCapacityMetrics,
    );
    const store = new DynamoProviderLandingRepository(client, tableName);
    accountRate = new SharedSharpApiAccountRateCoordinator(
      new DynamoOddsControlPlaneStore(client, tableName),
    );
    const secrets = new SecretsManagerClient({});
    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const apiKey = parseProviderLandingSecret(secret.SecretString);
    const summary = await runProviderLanding({
      source: {
        fetchCatalog: () => fetchSharpApiCatalog(apiKey),
        fetchEvents: (offset) =>
          fetchSharpApiUniversalEventsPage(apiKey, offset),
        fetchOdds: (cursor) => fetchSharpApiUniversalOddsPage(apiKey, cursor),
      },
      store,
      accountRate,
      metrics,
      eventPageBudget: 100,
      oddsPageBudget: 100,
      // The slow universal odds route is allowed a 25-second request window;
      // preserve enough time afterward for throttled batch-write backoff and
      // both halves of the sealed-page checkpoint commit.
      shouldContinue: () => context.getRemainingTimeInMillis() > 60_000,
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "provider-landing-run-complete",
        streams: Object.fromEntries(
          (
            [
              ["catalog", summary.catalog],
              ["events", summary.events],
              ["odds", summary.odds],
            ] as const
          ).map(([stream, checkpoint]) => [
            stream,
            checkpoint
              ? {
                  status: checkpoint.status,
                  slot: checkpoint.slot,
                  sweepId: checkpoint.sweepId,
                  lastCompletedSlot: checkpoint.lastCompletedSlot ?? null,
                  lastCompletedSweepId: checkpoint.lastCompletedSweepId ?? null,
                  pages: checkpoint.counts.pages,
                  sourceRows: checkpoint.counts.sourceRows,
                  landedRows: checkpoint.counts.landedRows,
                  quarantinedRows: checkpoint.counts.quarantinedRows,
                  warningRows: checkpoint.counts.warningRows ?? 0,
                }
              : null,
          ]),
        ),
      })}\n`,
    );
    return summary;
  } catch (error) {
    return settleProviderLandingTerminalFailure(error, accountRate, metrics);
  }
};
