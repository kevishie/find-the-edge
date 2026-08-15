import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type AccountRateTerminalReason,
  type AccountRateCoordinationStore,
  DynamoOddsControlPlaneStore,
  DynamoProviderLandingRepository,
  instrumentDynamoCapacity,
} from "@find-the-edge/database";
import {
  fetchSharpApiAccount,
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
    ["configuration", "not-entitled", "unauthorized"].includes(error.code)
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

const SHARP_API_ACCOUNT_HEALTH_KEY = "sharpapi:account:account";
const ACCOUNT_PROBE_LEASE_MS = 60_000;
const ACCOUNT_PROBE_POLL_MS = 2_000;
const ACCOUNT_PROBE_POLL_ATTEMPTS = 6;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const recoverProviderLandingAccountWindow = async (input: {
  readonly control: AccountRateCoordinationStore;
  readonly fetchAccount: () => ReturnType<typeof fetchSharpApiAccount>;
  readonly now?: () => Date;
  readonly pause?: (milliseconds: number) => Promise<void>;
  readonly shouldContinue?: () => boolean;
}) => {
  const now = input.now ?? (() => new Date());
  const pause = input.pause ?? sleep;
  const shouldContinue = input.shouldContinue ?? (() => true);
  for (let attempt = 0; attempt < ACCOUNT_PROBE_POLL_ATTEMPTS; attempt += 1) {
    if (!shouldContinue()) return "unavailable" as const;
    const requestedAt = now();
    const probeUntil = new Date(
      requestedAt.getTime() + ACCOUNT_PROBE_LEASE_MS,
    ).toISOString();
    const claimVersion = await input.control.claimAccountRateProbe(
      SHARP_API_ACCOUNT_HEALTH_KEY,
      requestedAt.toISOString(),
      probeUntil,
    );
    if (claimVersion !== null)
      try {
        // Claiming consumes this provider window even when the invocation is
        // too close to its checkpoint-safety boundary to dispatch. Leaving
        // the durable lease in place prevents another consumer from turning
        // an abandoned claim into a duplicate paid probe.
        if (!shouldContinue()) return "unavailable" as const;
        const account = await input.fetchAccount();
        const observedWindow = account.responseMetadata?.rateWindow;
        if (!observedWindow) return "unavailable" as const;
        const completed = await input.control.completeAccountRateProbe(
          SHARP_API_ACCOUNT_HEALTH_KEY,
          probeUntil,
          claimVersion,
          observedWindow,
          now().toISOString(),
        );
        return completed ? ("recovered" as const) : ("unavailable" as const);
      } catch (error) {
        const failedAt = now();
        if (
          error instanceof SharpApiError &&
          (["configuration", "not-entitled", "unauthorized"].includes(
            error.code,
          ) ||
            (error.code === "provider-rejected" && !error.retryable))
        )
          await input.control.blockAccountTerminal(
            SHARP_API_ACCOUNT_HEALTH_KEY,
            error.code as AccountRateTerminalReason,
            failedAt.toISOString(),
          );
        else if (
          error instanceof SharpApiError &&
          error.code === "rate-limited"
        )
          await input.control.blockAccountRateWindow(
            SHARP_API_ACCOUNT_HEALTH_KEY,
            error.retryAt ??
              new Date(failedAt.getTime() + 60_000).toISOString(),
            failedAt.toISOString(),
          );
        if (
          error instanceof SharpApiError &&
          error.code === "provider-rejected" &&
          !error.retryable
        )
          throw new Error("provider-landing-account-terminal");
        throw error;
      }
    const winner = await input.control.getHealth(SHARP_API_ACCOUNT_HEALTH_KEY);
    if (
      winner?.rateWindow?.remaining !== undefined &&
      winner.rateWindow.resetsAt !== undefined &&
      Date.parse(winner.rateWindow.resetsAt) > now().getTime() + 10_000
    )
      return "observed" as const;
    if (attempt + 1 < ACCOUNT_PROBE_POLL_ATTEMPTS)
      await pause(ACCOUNT_PROBE_POLL_MS);
  }
  return "unavailable" as const;
};

export const handler = async (event: unknown, context: Context) => {
  void event;
  const tableName = process.env["FTE_EVENT_TABLE"];
  const secretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const stage = process.env["FTE_AWS_STAGE"];
  const metrics = createProviderLandingMetricSink(inferredMetricStage());
  let accountRate: SharedSharpApiAccountRateCoordinator | undefined;
  let apiKey: string | undefined;
  try {
    // The table binding is the only prerequisite for persisting terminal
    // account health. Construct that circuit breaker before reading/parsing
    // the provider secret so a broken secret cannot leave the shared account
    // state recoverable and trigger repeated paid attempts elsewhere.
    if (!tableName) throw new Error("provider-landing-configuration-invalid");
    const client = instrumentDynamoCapacity(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      emitDynamoCapacityMetrics,
    );
    const store = new DynamoProviderLandingRepository(client, tableName);
    const control = new DynamoOddsControlPlaneStore(client, tableName);
    accountRate = new SharedSharpApiAccountRateCoordinator(control, {
      recoverWindow: async () => {
        const recoveredApiKey = apiKey;
        if (!recoveredApiKey)
          throw new Error("provider-landing-configuration-invalid");
        const outcome = await recoverProviderLandingAccountWindow({
          control,
          fetchAccount: () => fetchSharpApiAccount(recoveredApiKey),
          shouldContinue: () => context.getRemainingTimeInMillis() > 60_000,
        });
        metrics.emit("ProviderLandingRecovery", 1, {
          stream: "account",
          outcome,
        });
      },
      now: () => new Date(),
      canRecoverWindow: () => context.getRemainingTimeInMillis() > 90_000,
      canDispatch: () => context.getRemainingTimeInMillis() > 60_000,
    });
    if (!secretId || !stage)
      throw new Error("provider-landing-configuration-invalid");
    const secrets = new SecretsManagerClient({});
    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const readyApiKey = parseProviderLandingSecret(secret.SecretString);
    apiKey = readyApiKey;
    const summary = await runProviderLanding({
      source: {
        fetchCatalog: () => fetchSharpApiCatalog(readyApiKey),
        fetchEvents: (filter, offset) =>
          fetchSharpApiUniversalEventsPage(readyApiKey, filter, offset),
        fetchOdds: (cursor) =>
          fetchSharpApiUniversalOddsPage(readyApiKey, cursor),
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
