import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoBettingSplitRepository,
  DynamoEventIngestionStore,
  DynamoFixtureOddsAdapter,
  DynamoExactOddsSnapshotRepository,
  DynamoOddsControlPlaneStore,
} from "@find-the-edge/database";
import {
  runFocusedSharpOddsIngestion,
  runProductionOddsControlPlane,
} from "./production-odds-control-plane";
import { embeddedOddsControlPlaneMetrics } from "./odds-control-plane";
import { decideOddsRetry } from "./odds-control-plane";

export function parseProviderApiSecret(value: string | undefined): string {
  if (!value) throw new Error("provider-api-secret-missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const key = (parsed as Record<string, unknown>)["apiKey"];
      if (
        typeof key === "string" &&
        key.trim() === key &&
        key.length > 0 &&
        key.length <= 512
      )
        return key;
      throw new Error("provider-api-secret-invalid");
    }
  } catch {
    /* allow a plain secret string */
  }
  if (value.trim() === value && value.length > 0 && value.length <= 512)
    return value;
  throw new Error("provider-api-secret-invalid");
}

export function parseLiveOddsInvocation(event: unknown): {
  readonly forceRefresh: boolean;
  readonly sqs?: {
    readonly messageId: string;
    readonly receiveCount: number;
    readonly receiptHandle?: string;
  };
  readonly focused?: {
    readonly leagueKey:
      "mlb" | "mls" | "epl" | "liga-mx" | "uefa-champions-league";
    readonly providerEventId: string;
  };
} {
  if (event === undefined || event === null) return { forceRefresh: false };
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("live-odds-invocation-invalid");
  const record = event as Record<string, unknown>;
  if (record["mode"] === "focused") {
    const leagueKey = record["leagueKey"];
    const providerEventId = record["providerEventId"];
    if (
      Reflect.ownKeys(record).length !== 3 ||
      !["mlb", "mls", "epl", "liga-mx", "uefa-champions-league"].includes(
        String(leagueKey),
      ) ||
      typeof providerEventId !== "string" ||
      providerEventId.trim() !== providerEventId ||
      providerEventId.length === 0 ||
      providerEventId.length > 256
    )
      throw new Error("live-odds-invocation-invalid");
    return {
      forceRefresh: false,
      focused: {
        leagueKey: leagueKey as
          "mlb" | "mls" | "epl" | "liga-mx" | "uefa-champions-league",
        providerEventId,
      },
    };
  }
  if (Array.isArray(record["Records"])) {
    const records = record["Records"];
    if (
      records.length !== 1 ||
      !records[0] ||
      typeof records[0] !== "object" ||
      (records[0] as Record<string, unknown>)["eventSource"] !== "aws:sqs"
    )
      throw new Error("live-odds-invocation-invalid");
    const message = records[0] as Record<string, unknown>;
    const attributes = message["attributes"] as
      Record<string, unknown> | undefined;
    const messageId = message["messageId"];
    const receiptHandle = message["receiptHandle"];
    const receiveCount = Number(attributes?.["ApproximateReceiveCount"] ?? 1);
    if (
      typeof messageId !== "string" ||
      messageId.length === 0 ||
      !Number.isInteger(receiveCount) ||
      receiveCount < 1
    )
      throw new Error("live-odds-invocation-invalid");
    return {
      forceRefresh: false,
      sqs: {
        messageId,
        receiveCount,
        ...(typeof receiptHandle === "string" && receiptHandle.length > 0
          ? { receiptHandle }
          : {}),
      },
    };
  }
  if (!Object.prototype.hasOwnProperty.call(record, "forceRefresh"))
    return { forceRefresh: false };
  if (Reflect.ownKeys(record).length !== 1 || record["forceRefresh"] !== true)
    throw new Error("live-odds-invocation-invalid");
  return { forceRefresh: true };
}

export const liveOddsSummaryRetryDecision = (summary: unknown) => {
  const pending: unknown[] = [summary];
  let visited = 0;
  while (pending.length > 0 && visited < 1_000) {
    const item = pending.shift();
    visited += 1;
    if (Array.isArray(item)) {
      for (const value of item as unknown[]) pending.push(value);
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    for (const value of Object.values(record))
      if (value && typeof value === "object") pending.push(value);
    if (
      record["status"] !== "failed" &&
      record["status"] !== "skipped" &&
      record["status"] !== "retryable"
    )
      continue;
    const reason = record["reason"];
    if (typeof reason !== "string") continue;
    const normalized = reason.startsWith("schedule-")
      ? reason.slice("schedule-".length)
      : reason;
    if (
      [
        "provider-unavailable",
        "rate-limited",
        "provider-cooldown",
        "quota-reserve",
        "provider-request-ambiguous",
      ].includes(normalized)
    )
      return {
        reason: normalized,
        ...(typeof record["retryAt"] === "string"
          ? { retryAt: record["retryAt"] }
          : {}),
      };
  }
  return undefined;
};
export const liveOddsSummaryRetryReason = (summary: unknown) =>
  liveOddsSummaryRetryDecision(summary)?.reason;

export const boundedRetryVisibilitySeconds = (
  retryAt: unknown,
  now = new Date(),
) => {
  if (typeof retryAt !== "string") return undefined;
  const delay = Math.ceil((Date.parse(retryAt) - now.getTime()) / 1_000);
  if (!Number.isFinite(delay) || delay <= 0) return undefined;
  return Math.min(43_200, Math.max(1, delay));
};

export const liveOddsErrorRetryDecision = (
  error: unknown,
  attempt: number,
  now = new Date(),
) => {
  const providerRetryAt =
    error instanceof Error &&
    "retryAt" in error &&
    typeof (error as { retryAt?: unknown }).retryAt === "string"
      ? (error as { retryAt: string }).retryAt
      : undefined;
  const decision = decideOddsRetry({
    error,
    attempt,
    now,
    maxAttempts: 5,
    ...(providerRetryAt ? { providerRetryAt } : {}),
  });
  return providerRetryAt ? { ...decision, retryAt: providerRetryAt } : decision;
};

const extendRetryVisibility = async (
  sqs: NonNullable<ReturnType<typeof parseLiveOddsInvocation>["sqs"]>,
  retryAt: unknown,
) => {
  const queueUrl = process.env["FTE_LIVE_ODDS_QUEUE_URL"];
  const visibilityTimeout = boundedRetryVisibilitySeconds(retryAt);
  if (!queueUrl || !sqs.receiptHandle || visibilityTimeout === undefined)
    return;
  await new SQSClient({}).send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: sqs.receiptHandle,
      VisibilityTimeout: visibilityTimeout,
    }),
  );
};

export const handler = async (event?: unknown) => {
  const invocation = parseLiveOddsInvocation(event);
  const tableName = process.env["FTE_EVENT_TABLE"];
  const sharpSecretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const sharpEnabled = process.env["FTE_SHARP_API_ENABLED"] === "true";
  if (!tableName || !sharpEnabled || !sharpSecretId)
    throw new Error("live-odds-configuration-invalid");
  const secrets = new SecretsManagerClient({});
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const eventStore = new DynamoEventIngestionStore(
    new AwsDynamoGateway(client, tableName),
  );
  const oddsStore = new DynamoFixtureOddsAdapter(
    new AwsFixtureOddsGateway(client, tableName),
    new DynamoExactOddsSnapshotRepository(client, tableName),
  );
  const provider = "odds-control-plane";
  const sharpSecret = await secrets.send(
    new GetSecretValueCommand({ SecretId: sharpSecretId }),
  );
  const sharpApiKey = parseProviderApiSecret(sharpSecret.SecretString);
  const common = {
    events: eventStore,
    odds: oddsStore,
    control: new DynamoOddsControlPlaneStore(client, tableName),
    sharpApiKey,
    metrics: embeddedOddsControlPlaneMetrics,
  };
  let summary;
  try {
    summary = invocation.focused
      ? await runFocusedSharpOddsIngestion({
          ...common,
          request: invocation.focused,
        })
      : await runProductionOddsControlPlane({
          ...common,
          splits: new DynamoBettingSplitRepository(client, tableName),
          ...(invocation.forceRefresh ? { forceRefresh: true } : {}),
        });
  } catch (error) {
    if (!invocation.sqs) throw error;
    const decision = liveOddsErrorRetryDecision(
      error,
      invocation.sqs.receiveCount,
    );
    embeddedOddsControlPlaneMetrics.emit("OddsCommandOutcome", 1, {
      class: decision.class,
      action: decision.action,
      reason: decision.reason,
    });
    if (decision.action === "stop")
      return { batchItemFailures: [] as readonly never[] };
    if (decision.action !== "exhausted")
      await extendRetryVisibility(invocation.sqs, decision.retryAt);
    // Returning the item identifier is explicit retry ownership. On the fifth
    // receive SQS redrive moves it to the configured odds DLQ.
    return {
      batchItemFailures: [{ itemIdentifier: invocation.sqs.messageId }],
    };
  }
  process.stdout.write(
    `${JSON.stringify({ event: "live-odds-ingestion-complete", provider, summary })}\n`,
  );
  if (invocation.sqs) {
    const retryDecision = liveOddsSummaryRetryDecision(summary);
    if (retryDecision) {
      const retryReason = retryDecision.reason;
      if (invocation.sqs.receiveCount < 5)
        await extendRetryVisibility(invocation.sqs, retryDecision.retryAt);
      embeddedOddsControlPlaneMetrics.emit("OddsCommandOutcome", 1, {
        class:
          retryReason === "provider-request-ambiguous"
            ? "ambiguous"
            : "transient",
        action: invocation.sqs.receiveCount >= 5 ? "exhausted" : "retry",
        reason: retryReason,
      });
      return {
        batchItemFailures: [{ itemIdentifier: invocation.sqs.messageId }],
      };
    }
    return { batchItemFailures: [] as readonly never[] };
  }
  return summary;
};
