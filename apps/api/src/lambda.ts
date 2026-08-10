import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  DynamoGamesRepository,
  DynamoBettingSplitRepository,
  DynamoEventRepository,
  DynamoCohortRepository,
  DynamoRetrospectiveRepository,
  EventCursorCodec,
  DynamoDbStrategyExperimentRepository,
  DynamoOddsHistoryRepository,
  DynamoOpportunityCandidateRepository,
  DynamoOpportunityLifecycleEventEvidenceSource,
  DynamoOpportunityLifecycleRepository,
  DynamoArbitrageBoardRepository,
  DynamoRankedOpportunityRepository,
  DynamoOddsControlPlaneStore,
  DynamoScoutingJobRepository,
  OpportunityCursorCodec,
  boardPartition,
  validateStoredBoard,
  type BoardKey,
} from "@find-the-edge/database";
import { impliedProbability } from "@find-the-edge/odds";
import {
  approvedDetailSportsbooks,
  approvedSportsbookCollection,
  defaultOpportunityRankingPolicy,
  sportsbookRegistry,
  productionProviderStatusCatalog,
} from "@find-the-edge/config";
import { createEventHandler, eventIdCandidates } from "./handler";
import { buildProviderStatusPage } from "./provider-status";
import { createScoutingHttpHandler } from "./scouting-handler";
import { loadSecretRing } from "./secrets";
import { encodeApiResponse } from "./http-compression";
interface LambdaEvent {
  readonly routeKey?: string;
  readonly rawPath?: string;
  readonly pathParameters?: {
    readonly eventId?: string;
    readonly sportKey?: string;
    readonly opportunityId?: string;
    readonly jobId?: string;
  };
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly authorizer?: {
      readonly jwt?: {
        readonly claims?: Record<string, unknown>;
        readonly scopes?: string[];
      };
    };
  };
}
const tableName = process.env["FTE_EVENT_TABLE_NAME"] ?? "";
const secretArn = process.env["FTE_EVENT_CURSOR_SECRET_ARN"] ?? "";
if (!tableName || !secretArn)
  throw new Error("missing-event-api-configuration");
// One client per process: a client created inside the handler opens a fresh
// TLS connection on every request, which is pure added latency.
const sharedDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({}),
);
const gateway = new AwsDynamoGateway(sharedDocumentClient, tableName);
const secrets = new SecretsManagerClient({});
// Projection readiness is a one-way latch in practice; probing it on every
// request added a storage read to every page load. A confirmed-ready answer is
// trusted for a minute, an unready answer only briefly so initialization is
// noticed promptly.
let readinessCache: { readonly ready: boolean; readonly expiresAt: number } = {
  ready: false,
  expiresAt: 0,
};
const projectionReady = async () => {
  if (readinessCache.expiresAt > Date.now()) return readinessCache.ready;
  const item = await gateway.get("EVENT_PROJECTIONS", "READINESS");
  const ready =
    !!item &&
    JSON.stringify(item.value) ===
      JSON.stringify({ schemaVersion: 1, state: "initialized" });
  readinessCache = {
    ready,
    expiresAt: Date.now() + (ready ? 60_000 : 5_000),
  };
  return ready;
};
export const handler = async (event: LambdaEvent) => {
  const ring = await loadSecretRing(secrets, secretArn);
  const cursorCodec = new EventCursorCodec(ring);
  const repository = new DynamoEventRepository(
    gateway,
    cursorCodec,
    projectionReady,
  );
  const approvedLabels = Object.fromEntries(
    sportsbookRegistry
      .filter(({ id }) => id in approvedSportsbookCollection)
      .map(({ id, name }) => [id, name]),
  );
  const detailSportsbooks = approvedDetailSportsbooks;
  const games = new DynamoGamesRepository(
    repository,
    gateway,
    detailSportsbooks,
  );
  const documentClient = sharedDocumentClient;
  const scoutingJobs = new DynamoScoutingJobRepository(
    documentClient,
    tableName,
  );
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const route =
    event.routeKey === "POST /events/{eventId}/scout"
      ? "scout-create"
      : event.routeKey === "GET /scout-jobs/{jobId}"
        ? "scout-status"
        : event.routeKey === "POST /scout-jobs/{jobId}/retry"
          ? "scout-retry"
          : event.routeKey === "GET /providers/status"
            ? "provider-status"
            : event.routeKey === "GET /sports/{sportKey}/opportunities"
              ? "opportunity-list"
              : event.routeKey ===
                  "GET /sports/{sportKey}/opportunities/{opportunityId}"
                ? "opportunity-detail"
                : event.routeKey === "GET /sports/{sportKey}/arbitrage"
                  ? "arbitrage-list"
                  : event.routeKey === "GET /strategy-experiments"
                    ? "experiment-list"
                    : event.routeKey === "GET /strategy-experiments/{eventId}"
                      ? "experiment-detail"
                      : event.routeKey ===
                          "POST /strategy-experiments/{eventId}/approve"
                        ? "experiment-approve"
                        : event.routeKey ===
                            "POST /strategy-experiments/{eventId}/promote"
                          ? "experiment-promote"
                          : event.routeKey ===
                              "POST /strategy-experiments/{eventId}/rollback"
                            ? "experiment-rollback"
                            : event.routeKey === "GET /retrospectives"
                              ? "retrospective-list"
                              : event.routeKey ===
                                  "GET /retrospectives/{eventId}"
                                ? "retrospective-detail"
                                : event.routeKey ===
                                    "GET /retrospectives/{eventId}/versions"
                                  ? "retrospective-versions"
                                  : event.routeKey ===
                                      "POST /retrospectives/{eventId}/review"
                                    ? "retrospective-review"
                                    : event.routeKey ===
                                        "GET /games/{eventId}/odds-history"
                                      ? "odds-history"
                                      : event.routeKey?.startsWith("GET /games")
                                        ? "games"
                                        : event.routeKey?.startsWith(
                                              "GET /splits",
                                            )
                                          ? "splits"
                                          : event.routeKey ===
                                              "GET /performance/reports"
                                            ? "performance-reports"
                                            : event.routeKey?.startsWith(
                                                  "GET /performance/reports/",
                                                )
                                              ? "performance-detail"
                                              : event.routeKey?.startsWith(
                                                    "GET /performance/cohorts/",
                                                  )
                                                ? "performance-members"
                                                : event.routeKey?.startsWith(
                                                      "GET /performance/cohorts",
                                                    )
                                                  ? "performance-list"
                                                  : event.routeKey?.includes(
                                                        "/{eventId}",
                                                      )
                                                    ? "detail"
                                                    : "list";
  const eventId = event.pathParameters?.eventId;
  const eventIdAlternatives = eventIdCandidates(
    event.rawPath,
    event.routeKey,
    eventId,
  );
  const sportKey = event.pathParameters?.sportKey;
  const opportunityId = event.pathParameters?.opportunityId;
  const jobId = event.pathParameters?.jobId;
  const subject =
    typeof claims?.["sub"] === "string" ? claims["sub"] : undefined;
  const authorizedScopes = event.requestContext?.authorizer?.jwt?.scopes;
  const claimScope = claims?.["scope"];
  const scopes =
    authorizedScopes ??
    (typeof claimScope === "string"
      ? claimScope.split(" ").filter(Boolean)
      : undefined);
  const groups = claims?.["cognito:groups"];
  const reviewerAuthorized =
    (Array.isArray(groups) && groups.includes("fte-retrospective-reviewers")) ||
    (typeof groups === "string" &&
      groups.split(",").includes("fte-retrospective-reviewers"));
  const strategyPromoterAuthorized =
    (Array.isArray(groups) && groups.includes("fte-strategy-promoters")) ||
    (typeof groups === "string" &&
      groups.split(",").includes("fte-strategy-promoters"));
  const query = event.queryStringParameters;
  const contentType = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "content-type",
  )?.[1];
  const idempotencyKey = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "idempotency-key",
  )?.[1];
  const acceptEncoding = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "accept-encoding",
  )?.[1];
  const apiResponse = await createEventHandler(
    repository,
    games,
    undefined,
    new DynamoBettingSplitRepository(sharedDocumentClient, tableName),
    new DynamoCohortRepository(documentClient, tableName),
    new DynamoRetrospectiveRepository(documentClient, tableName, cursorCodec),
    new DynamoDbStrategyExperimentRepository(
      documentClient,
      tableName,
      cursorCodec,
    ),
    new DynamoOddsHistoryRepository(
      documentClient,
      tableName,
      cursorCodec,
      approvedLabels,
      impliedProbability,
    ),
    new DynamoRankedOpportunityRepository(
      documentClient,
      tableName,
      defaultOpportunityRankingPolicy,
      new OpportunityCursorCodec(
        new EventCursorCodec(ring, defaultOpportunityRankingPolicy.cursorTtlMs),
      ),
      new DynamoOpportunityCandidateRepository(documentClient, tableName),
      new DynamoOpportunityLifecycleRepository(documentClient, tableName),
      repository,
      new DynamoOpportunityLifecycleEventEvidenceSource(gateway),
    ),
    () =>
      buildProviderStatusPage(
        productionProviderStatusCatalog,
        new DynamoOddsControlPlaneStore(documentClient, tableName),
      ),
    createScoutingHttpHandler(repository, scoutingJobs),
    async (key: BoardKey) => {
      const item = await gateway.get(boardPartition(key), "CURRENT");
      return item ? validateStoredBoard(item.value, new Date()) : null;
    },
    new DynamoArbitrageBoardRepository(documentClient, tableName),
  )({
    route,
    ...(subject ? { subject } : {}),
    ...(scopes ? { scopes } : {}),
    reviewerAuthorized,
    strategyPromoterAuthorized,
    ...(eventId ? { eventId } : {}),
    ...(eventIdAlternatives.length > 0 ? { eventIdAlternatives } : {}),
    ...(sportKey ? { sportKey } : {}),
    ...(opportunityId ? { opportunityId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(event.requestContext?.requestId
      ? { requestId: event.requestContext.requestId }
      : {}),
    ...(query ? { query } : {}),
    method: event.routeKey?.startsWith("POST ") ? "POST" : "GET",
    ...(contentType ? { contentType } : {}),
    ...(event.body ? { body: event.body } : {}),
  });
  return encodeApiResponse(apiResponse, acceptEncoding);
};
