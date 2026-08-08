import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { randomBytes } from "node:crypto";
import { approvedDetailSportsbooks } from "@find-the-edge/config";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoBettingSplitRepository,
  DynamoEventIngestionStore,
  DynamoEventRepository,
  DynamoFixtureOddsAdapter,
  DynamoExactOddsSnapshotRepository,
  DynamoGamesRepository,
  DynamoOddsControlPlaneStore,
  EventCursorCodec,
  materializeBoards,
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
  readonly maintenanceToken?: string;
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
  const maintenanceToken = record["maintenanceToken"];
  if (
    ![1, 2].includes(Reflect.ownKeys(record).length) ||
    Reflect.ownKeys(record).some(
      (key) => key !== "forceRefresh" && key !== "maintenanceToken",
    ) ||
    record["forceRefresh"] !== true ||
    (maintenanceToken !== undefined &&
      (typeof maintenanceToken !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          maintenanceToken,
        )))
  )
    throw new Error("live-odds-invocation-invalid");
  return {
    forceRefresh: true,
    ...(maintenanceToken ? { maintenanceToken } : {}),
  };
}

export const assertLiveOddsMaintenanceOwnership = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  token: string | undefined,
  now = new Date(),
) => {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: "ODDS_CONTROL#MAINTENANCE#feed-reset", sk: "CURRENT" },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) {
    if (token) throw new Error("live-odds-maintenance-token-invalid");
    return;
  }
  const value = result.Item["value"] as Record<string, unknown> | undefined;
  const owner = value?.["token"];
  const expiresAt = value?.["expiresAt"];
  if (
    typeof owner !== "string" ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  )
    throw new Error("live-odds-maintenance-active");
  if (Date.parse(expiresAt) <= now.getTime()) {
    if (token) throw new Error("live-odds-maintenance-token-invalid");
    return;
  }
  if (token !== owner) throw new Error("live-odds-maintenance-active");
};

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

const safeLiveOddsInvocationCodes = new Set([
  "account-attempt-reservation-conflict",
  "attempt-transition-conflict",
  "bootstrap-failed",
  "bootstrap-identity-already-exists",
  "bootstrap-identity-snapshot-mismatch",
  "bootstrap-response-conflict",
  "bootstrap-stale",
  "canonical-revision-provider-limit",
  "continuation-transition-conflict",
  "coverage-missing",
  "dangling-identity-aggregate",
  "evidence-transition-conflict",
  "event-projection-active-corrupt",
  "event-projection-active-missing",
  "event-projection-pointer-corrupt",
  "event-projection-pointer-missing",
  "focused-event-binding-unavailable",
  "focused-request-invalid",
  "health-transition-conflict",
  "identity-conflict-count-exhausted",
  "identity-register-conflict",
  "identity-snapshot-mismatch",
  "identity-snapshot-unstable",
  "invalid-provider-revision-row",
  "live-odds-control-plane-failed",
  "live-odds-secret-read-failed",
  "metric-transition-conflict",
  "mapping-canonical-missing",
  "mapping-canonical-scope-mismatch",
  "mapping-scope-mismatch",
  "live-odds-maintenance-active",
  "live-odds-maintenance-token-invalid",
  "multiple-current-event-projections",
  "near-canonical-projection-stale",
  "odds-metric-invalid",
  "page-limit-exceeded",
  "page-transition-conflict",
  "provider-page-material-mismatch",
  "provider-revision-scope-mismatch",
  "provider-request-ambiguous",
  "provider-response-unsealed",
  "provider-unavailable",
  "quota-reserve",
  "run-owned",
  "run-transition-conflict",
  "schedule-attempt-reservation-conflict",
  "schedule-conflict-disposition-invalid",
  "schedule-conflict-gap-invalid",
  "schedule-conflict-metric-pending",
  "schedule-conflict-page-commit-missing",
  "schedule-page-commit-missing",
  "schedule-stored-event-conflict",
  "sealed-page-conflict",
  "sealed-page-missing",
  "sharpapi-event-binding-unavailable",
  "sharpapi-pagination-invalid",
  "sharpapi-pagination-limit",
  "sharpapi-schedule-pagination-invalid",
  "sharpapi-schedule-pagination-limit",
  "sharpapi-splits-pagination-invalid",
  "sharpapi-splits-pagination-limit",
  "split-attempt-reservation-conflict",
  "stale-identity-aggregate",
]);

const boundedSingleLiveOddsInvocationError = (error: unknown) => {
  if (error instanceof Error) {
    const safeReconciliationCode =
      /^(?:invalid-event-reconciliation-lock|event-reconciliation-(?:lock-timeout|ownership-lost|failed|(?:acquisition|execution|renewal|cleanup)-(?:failed|storage-(?:validation|resource-missing|access-denied|transaction-cancelled|unavailable)))|dynamo-(?:conditional|transaction)-conflict)$/;
    if (safeReconciliationCode.test(error.message)) return error.message;
    if (safeLiveOddsInvocationCodes.has(error.message)) return error.message;
    if (
      error.name === "SharpApiError" &&
      [
        "configuration",
        "unauthorized",
        "not-entitled",
        "rate-limited",
        "provider-request-ambiguous",
        "provider-unavailable",
        "provider-rejected",
        "invalid-response",
      ].includes(error.message)
    )
      return `sharpapi-${error.message}`;
  }
  if (error instanceof TypeError) return "live-odds-runtime-type-error";
  if (error instanceof RangeError) return "live-odds-runtime-range-error";
  if (error instanceof SyntaxError) return "live-odds-runtime-syntax-error";
  if (error instanceof Error && error.name === "AbortError")
    return "live-odds-runtime-abort";
  return "live-odds-runtime-error";
};

export const boundedLiveOddsInvocationError = (error: unknown) => {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && !seen.has(current); depth += 1) {
    seen.add(current);
    const bounded = boundedSingleLiveOddsInvocationError(current);
    if (bounded !== "live-odds-runtime-error") return bounded;
    current = current instanceof Error ? current.cause : undefined;
  }
  return "live-odds-runtime-error";
};

const withBoundedInvocationStage = async <T>(
  stage: "live-odds-secret-read-failed" | "live-odds-control-plane-failed",
  operation: () => Promise<T>,
) => {
  try {
    return await operation();
  } catch (error) {
    if (boundedLiveOddsInvocationError(error) !== "live-odds-runtime-error")
      throw error;
    throw new Error(stage, { cause: error });
  }
};

const runLiveOddsHandler = async (event?: unknown) => {
  const invocation = parseLiveOddsInvocation(event);
  const tableName = process.env["FTE_EVENT_TABLE"];
  const sharpSecretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const sharpEnabled = process.env["FTE_SHARP_API_ENABLED"] === "true";
  if (!tableName || !sharpEnabled || !sharpSecretId)
    throw new Error("live-odds-configuration-invalid");
  const secrets = new SecretsManagerClient({});
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await assertLiveOddsMaintenanceOwnership(
    client,
    tableName,
    invocation.maintenanceToken,
  );
  const eventStore = new DynamoEventIngestionStore(
    new AwsDynamoGateway(client, tableName),
  );
  const oddsStore = new DynamoFixtureOddsAdapter(
    new AwsFixtureOddsGateway(client, tableName),
    new DynamoExactOddsSnapshotRepository(client, tableName),
  );
  const provider = "odds-control-plane";
  const sharpSecret = await withBoundedInvocationStage(
    "live-odds-secret-read-failed",
    () => secrets.send(new GetSecretValueCommand({ SecretId: sharpSecretId })),
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
    const focused = invocation.focused;
    summary = focused
      ? await withBoundedInvocationStage("live-odds-control-plane-failed", () =>
          runFocusedSharpOddsIngestion({
            ...common,
            request: focused,
          }),
        )
      : await withBoundedInvocationStage("live-odds-control-plane-failed", () =>
          runProductionOddsControlPlane({
            ...common,
            splits: new DynamoBettingSplitRepository(client, tableName),
            ...(invocation.forceRefresh ? { forceRefresh: true } : {}),
          }),
        );
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
  // Materialize the default boards so the API serves a stored body instead of
  // re-running the projection per request. Never allowed to fail ingestion.
  if (!invocation.focused) {
    try {
      const boardGateway = new AwsDynamoGateway(client, tableName);
      const boardEvents = new DynamoEventRepository(
        boardGateway,
        // The worker never returns a cursor from a fifty-game page; a page
        // that would need one is skipped, so this codec never signs anything
        // a client will see.
        new EventCursorCodec({
          current: { id: "board-materializer", secret: randomBytes(32) },
        }),
        async () => {
          const item = await boardGateway.get("EVENT_PROJECTIONS", "READINESS");
          return (
            !!item &&
            JSON.stringify(item.value) ===
              JSON.stringify({ schemaVersion: 1, state: "initialized" })
          );
        },
      );
      const boards = await materializeBoards({
        games: new DynamoGamesRepository(
          boardEvents,
          boardGateway,
          approvedDetailSportsbooks,
        ),
        splits: new DynamoBettingSplitRepository(client, tableName),
        put: (item) => boardGateway.put(item),
        now: new Date(),
      });
      process.stdout.write(
        `${JSON.stringify({ event: "board-materialization", ...boards })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          event: "board-materialization-failed",
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        })}\n`,
      );
    }
  }
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

export const handler = async (event?: unknown) => {
  try {
    return await runLiveOddsHandler(event);
  } catch (error) {
    throw new Error(boundedLiveOddsInvocationError(error), { cause: error });
  }
};
