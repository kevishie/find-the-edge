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
  fetchSharpApiSchedulePage,
  fetchSharpApiClosingLines,
  sharpApiLeagueByKey,
} from "@find-the-edge/providers";
import {
  instrumentDynamoCapacity,
  usableScheduleListings,
} from "@find-the-edge/database";
import { captureClosingLines } from "./closing-lines-capture";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoBettingSplitRepository,
  DynamoClosingLinesRepository,
  DynamoClvRepository,
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
import { emitDynamoCapacityMetrics } from "./dynamo-capacity-metrics";
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

/**
 * Intra-tick fast lane: EventBridge cannot tick faster than once a minute, so
 * the invocation itself re-runs the control plane until the budget is spent.
 * Each pass is fully checkpoint-gated — only leagues whose near-start cadence
 * is due pay for a refresh, and schedule, splits, and account collection stay
 * on their own checkpoints. The FIFO message group serializes ticks, so the
 * budget must stay below the tick interval. A zero budget (the default when
 * the environment does not opt in) disables the lane entirely.
 */
export const runLiveOddsFastLane = async (input: {
  readonly budgetMs: number;
  readonly pauseMs: number;
  readonly runPass: () => Promise<readonly { readonly pages: number }[]>;
  readonly materialize: () => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<number> => {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let passes = 0;
  while (
    Number.isFinite(input.budgetMs) &&
    input.pauseMs > 0 &&
    now() - startedAt + input.pauseMs <= input.budgetMs
  ) {
    await sleep(input.pauseMs);
    try {
      const summary = await input.runPass();
      const committedPages = summary.reduce(
        (total, result) => total + result.pages,
        0,
      );
      passes += 1;
      process.stdout.write(
        `${JSON.stringify({ event: "live-odds-fast-lane-pass", committedPages })}\n`,
      );
      if (committedPages > 0) await input.materialize();
    } catch (error) {
      // The tick's first pass already committed its evidence; a fast-lane
      // failure waits for the next tick instead of failing the invocation.
      process.stdout.write(
        `${JSON.stringify({
          event: "live-odds-fast-lane-failed",
          errorMessage:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        })}\n`,
      );
      break;
    }
  }
  return passes;
};

const runLiveOddsHandler = async (event?: unknown) => {
  const invocation = parseLiveOddsInvocation(event);
  const tableName = process.env["FTE_EVENT_TABLE"];
  const sharpSecretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const sharpEnabled = process.env["FTE_SHARP_API_ENABLED"] === "true";
  if (!tableName || !sharpEnabled || !sharpSecretId)
    throw new Error("live-odds-configuration-invalid");
  const secrets = new SecretsManagerClient({});
  const client = instrumentDynamoCapacity(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
    emitDynamoCapacityMetrics,
  );
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
  const closingLines = new DynamoClosingLinesRepository(client, tableName);
  const controlStore = new DynamoOddsControlPlaneStore(client, tableName);
  const accountRateHealthKey = "sharpapi:account:account";
  const closingCapabilityHealthKey = "sharpapi:account:closing";
  const provider = "odds-control-plane";
  const sharpSecret = await withBoundedInvocationStage(
    "live-odds-secret-read-failed",
    () => secrets.send(new GetSecretValueCommand({ SecretId: sharpSecretId })),
  );
  const sharpApiKey = parseProviderApiSecret(sharpSecret.SecretString);
  const common = {
    events: eventStore,
    odds: oddsStore,
    control: controlStore,
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
            closingLines,
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
  // The provider's live schedule is the authority on which scheduled listings
  // still exist; a fetch failure disables the filter for this run rather than
  // hiding anything. One sweep serves every materialization in this
  // invocation — the listing set cannot meaningfully change inside a tick.
  let mlbListingsSweep:
    Promise<ReturnType<typeof usableScheduleListings> | null> | undefined;
  const scheduleListings = (sportKey: string) => {
    // Scoped to MLB: the withdrawn-listing class has only been observed
    // there, the splits witness only exists there, and soccer club
    // naming ("Inter Miami CF", "St. Louis City SC") defeats the
    // nickname-anchored matcher — filtering soccer wiped real games.
    if (sportKey !== "mlb") return Promise.resolve(null);
    // A null result here disables the withdrawn-listing filter for this run,
    // which is the right failure direction but was previously indistinguishable
    // from "the schedule says every game is real". Ghost listings survived on
    // the board for days because nothing said which of the two had happened.
    // Every exit now names itself.
    const abandon = (reason: string, detail?: Record<string, unknown>) => {
      process.stdout.write(
        `${JSON.stringify({
          event: "schedule-sweep-unavailable",
          reason,
          ...detail,
        })}\n`,
      );
      return null;
    };
    mlbListingsSweep ??= (async () => {
      const league = sharpApiLeagueByKey("mlb");
      const events: {
        awayTeam?: string;
        homeTeam?: string;
        startsAt: string;
      }[] = [];
      let offset: number | undefined = 0;
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        let schedulePage: Awaited<ReturnType<typeof fetchSharpApiSchedulePage>>;
        try {
          schedulePage = await fetchSharpApiSchedulePage(
            league,
            sharpApiKey,
            offset,
          );
        } catch (error) {
          return abandon("fetch-failed", {
            pageNumber,
            offset,
            errorName: error instanceof Error ? error.name : "unknown",
            errorMessage: error instanceof Error ? error.message : "unknown",
          });
        }
        events.push(...schedulePage.events);
        if (!schedulePage.hasMore) {
          const listings = usableScheduleListings(events);
          process.stdout.write(
            `${JSON.stringify({
              event: "schedule-sweep-complete",
              pages: pageNumber + 1,
              events: events.length,
              listings: listings.length,
            })}\n`,
          );
          // An empty sweep is not evidence that every listing was withdrawn;
          // it is evidence that we learned nothing. Filtering on it would
          // erase the whole board.
          return listings.length > 0 ? listings : abandon("no-listings");
        }
        if (
          schedulePage.nextOffset === undefined ||
          schedulePage.nextOffset <= (offset ?? 0)
        )
          return abandon("pagination-stalled", {
            pageNumber,
            offset,
            nextOffset: schedulePage.nextOffset ?? null,
          });
        offset = schedulePage.nextOffset;
      }
      return abandon("page-limit-exceeded", { offset });
    })();
    return mlbListingsSweep;
  };
  // Materialize the default boards so the API serves a stored body instead of
  // re-running the projection per request. Never allowed to fail ingestion.
  const materializeDefaultBoards = async () => {
    try {
      const boardGateway = new AwsDynamoGateway(client, tableName);
      const boardEvents = new DynamoEventRepository(
        boardGateway,
        // The worker exhausts a bounded cursor chain under one snapshot, then
        // persists only a terminal board that still fits the public fifty-game
        // contract. These signatures remain internal and never reach a client.
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
      const boardGames = new DynamoGamesRepository(
        boardEvents,
        boardGateway,
        approvedDetailSportsbooks,
        closingLines,
      );
      try {
        let closingBlocked = false;
        const closingHealth = await controlStore.getHealth(
          closingCapabilityHealthKey,
        );
        if (
          !closingHealth ||
          closingHealth.failureClass === "terminal" ||
          (closingHealth?.cooldownUntil !== undefined &&
            Date.parse(closingHealth.cooldownUntil) > Date.now())
        )
          closingBlocked = true;
        const putClosingHealth = async (
          value: Omit<
            NonNullable<Awaited<ReturnType<typeof controlStore.getHealth>>>,
            "version"
          >,
        ) => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = await controlStore.getHealth(
              closingCapabilityHealthKey,
            );
            if (
              current?.failureClass === "terminal" &&
              value.failureClass !== "terminal"
            )
              return;
            try {
              await controlStore.putHealth({
                ...value,
                ...(current?.version === undefined
                  ? {}
                  : { version: current.version }),
              });
              return;
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !== "health-transition-conflict" ||
                attempt === 2
              )
                throw error;
            }
          }
        };
        const closing = await captureClosingLines(
          {
            games: boardGames,
            closingLines,
            clv: new DynamoClvRepository(client, tableName),
            sportsbookIds: approvedDetailSportsbooks.map(({ id }) => id),
            fetchClosing: (providerEventId) =>
              fetchSharpApiClosingLines(providerEventId, sharpApiKey),
            reserveQuota: async () => {
              if (closingBlocked) return false;
              const health = await controlStore.getHealth(accountRateHealthKey);
              if (
                !health?.healthy ||
                health.failureClass === "terminal" ||
                health.rateWindow?.remaining === undefined
              )
                return false;
              const limit = health.rateWindow.limit;
              const reserve =
                limit === undefined
                  ? 100
                  : Math.max(1, Math.min(100, Math.floor(limit / 2)));
              return controlStore.reserveAccountRate(
                accountRateHealthKey,
                reserve,
                1,
                new Date().toISOString(),
                {
                  ...(health.version === undefined
                    ? {}
                    : { version: health.version }),
                  ...(limit === undefined ? {} : { limit }),
                  ...(health.rateWindow.resetsAt === undefined
                    ? {}
                    : { resetsAt: health.rateWindow.resetsAt }),
                },
              );
            },
            reconcileQuota: async (metadata) =>
              Promise.all([
                controlStore.reconcileAccountRateWindow(
                  accountRateHealthKey,
                  1,
                  1,
                  metadata?.rateWindow,
                  new Date().toISOString(),
                ),
                putClosingHealth({
                  providerId: "sharpapi",
                  healthKey: closingCapabilityHealthKey,
                  healthy: true,
                  status: "healthy",
                  consecutiveSuccesses: 1,
                  lastSuccessfulAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }),
              ]).then(() => undefined),
            recordProviderFailure: async (error) => {
              closingBlocked = true;
              const observedAt = new Date().toISOString();
              if (error.code === "unauthorized") {
                await controlStore.blockAccountTerminal(
                  accountRateHealthKey,
                  "unauthorized",
                  observedAt,
                );
                return;
              }
              if (error.code === "rate-limited") {
                const accountHealth =
                  await controlStore.getHealth(accountRateHealthKey);
                const retryAt =
                  error.retryAt ??
                  accountHealth?.rateWindow?.resetsAt ??
                  new Date(Date.now() + 60_000).toISOString();
                await controlStore.blockAccountRateWindow(
                  accountRateHealthKey,
                  retryAt,
                  observedAt,
                );
                return;
              }
              if (error.code === "not-entitled") {
                await putClosingHealth({
                  providerId: "sharpapi",
                  healthKey: closingCapabilityHealthKey,
                  healthy: false,
                  status: "unhealthy",
                  consecutiveSuccesses: 0,
                  failureClass: "terminal",
                  failureReason: "not-entitled",
                  updatedAt: observedAt,
                });
                return;
              }
              const retryAt =
                error.retryAt ?? new Date(Date.now() + 60_000).toISOString();
              await putClosingHealth({
                providerId: "sharpapi",
                healthKey: closingCapabilityHealthKey,
                healthy: false,
                status: "unhealthy",
                consecutiveSuccesses: 0,
                failureClass: "transient",
                failureReason: error.code,
                retryAt,
                cooldownUntil: retryAt,
                expiresAt: Math.floor(Date.parse(retryAt) / 1_000) + 3_600,
                updatedAt: observedAt,
              });
            },
          },
          new Date(),
        );
        if (closing.captured > 0 || closing.failed > 0)
          process.stdout.write(
            `${JSON.stringify({ event: "closing-lines-capture", ...closing })}\n`,
          );
      } catch (error) {
        process.stdout.write(
          `${JSON.stringify({
            event: "closing-lines-capture-failed",
            errorName: error instanceof Error ? error.name : "unknown",
            errorMessage:
              error instanceof Error ? error.message.slice(0, 200) : "unknown",
          })}\n`,
        );
      }
      const boards = await materializeBoards({
        games: boardGames,
        splits: new DynamoBettingSplitRepository(client, tableName),
        put: (item) => boardGateway.put(item),
        now: new Date(),
        scheduleListings,
      });
      process.stdout.write(
        `${JSON.stringify({ event: "board-materialization", ...boards })}\n`,
      );
      // Provider health alone has twice proven blind to frozen persistence;
      // this measures the served data itself. An empty slate emits nothing,
      // so the alarm treats missing data as healthy.
      if (boards.scheduledOddsAgeSeconds !== null)
        process.stdout.write(
          `${JSON.stringify({
            _aws: {
              Timestamp: Date.now(),
              CloudWatchMetrics: [
                {
                  Namespace: "FindTheEdge/Boards",
                  Dimensions: [[]],
                  Metrics: [
                    {
                      Name: "ScheduledBoardOddsAgeSeconds",
                      Unit: "Seconds",
                    },
                  ],
                },
              ],
            },
            ScheduledBoardOddsAgeSeconds: boards.scheduledOddsAgeSeconds,
          })}\n`,
        );
      // Dropping a listing is the most consequential thing the board does and
      // it was counted, then discarded unread — so a reader reporting a short
      // board on 2026-08-12 could not be answered from telemetry at all. Split
      // by rule, because the total cannot tell four correctly-rejected churn
      // orphans from four deleted real games.
      for (const [reason, count] of Object.entries(boards.withdrawnByReason))
        if (count > 0)
          process.stdout.write(
            `${JSON.stringify({
              _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                  {
                    Namespace: "FindTheEdge/Boards",
                    Dimensions: [["reason"]],
                    Metrics: [{ Name: "BoardListingsDropped", Unit: "Count" }],
                  },
                ],
              },
              reason,
              BoardListingsDropped: count,
            })}\n`,
          );
      // A board that is never materialised serves from the live path forever
      // and nobody is told. On 2026-08-13 one Eastern day's soccer board went
      // six hours without being stored while every other board refreshed on
      // the three-minute cadence; the count existed and was returned unread,
      // exactly as the withdrawn-listing count had been.
      for (const { board, reason } of boards.skippedBoards)
        process.stdout.write(
          `${JSON.stringify({
            _aws: {
              Timestamp: Date.now(),
              CloudWatchMetrics: [
                {
                  Namespace: "FindTheEdge/Boards",
                  Dimensions: [["reason"]],
                  Metrics: [
                    { Name: "BoardMaterializationSkipped", Unit: "Count" },
                  ],
                },
              ],
            },
            reason,
            board,
            BoardMaterializationSkipped: 1,
          })}\n`,
        );
      // The share of upcoming games in a sport that carry a price. Board
      // freshness is blind to a sport with no prices at all — there is
      // nothing to be stale — and that is exactly how soccer sat priceless
      // for eleven hours behind green provider health. A sport with no
      // upcoming games emits nothing, so an empty slate stays healthy.
      for (const [sport, { upcoming, priced }] of Object.entries(
        boards.pricedBySport,
      ))
        if (upcoming > 0)
          process.stdout.write(
            `${JSON.stringify({
              _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                  {
                    Namespace: "FindTheEdge/Boards",
                    Dimensions: [["sport"]],
                    Metrics: [
                      { Name: "UpcomingGamesPricedShare", Unit: "Percent" },
                    ],
                  },
                ],
              },
              sport,
              UpcomingGamesPricedShare: (priced / upcoming) * 100,
            })}\n`,
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
  };
  if (!invocation.focused) {
    await materializeDefaultBoards();
    await runLiveOddsFastLane({
      budgetMs: Number(process.env["FTE_FAST_LANE_BUDGET_MS"] ?? "0"),
      pauseMs: Number(process.env["FTE_FAST_LANE_PAUSE_MS"] ?? "10000"),
      runPass: () =>
        runProductionOddsControlPlane({
          ...common,
          splits: new DynamoBettingSplitRepository(client, tableName),
        }),
      materialize: materializeDefaultBoards,
    });
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
