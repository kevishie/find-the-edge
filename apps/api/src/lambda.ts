import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  DynamoIdentityRepository,
  DynamoEntitlementRepository,
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
  DynamoClvRepository,
  DynamoRankedOpportunityRepository,
  DynamoOddsControlPlaneStore,
  DynamoScoutingJobRepository,
  DynamoScoutingReportRepository,
  DynamoWatchlistRepository,
  OpportunityCursorCodec,
  boardPartition,
  readEventProjectionReadiness,
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
import { requiresProductAccess } from "./product-access";
import { buildProviderStatusPage } from "./provider-status";
import { createScoutingHttpHandler } from "./scouting-handler";
import { loadIdentitySecrets } from "./identity-secrets";
import { loadBillingSecrets, type BillingSecrets } from "./billing-secrets";
import { createStripeRestClient } from "./stripe-client";
import { createSnsSmsSender } from "./sms-sender";
import { loadSecretRing } from "./secrets";
import { encodeApiResponse } from "./http-compression";
import {
  authorizationContextFromGateway,
  isOwnedSessionAuthorization,
  memoizeIdentityAccountLookup,
  resolveOwnedSessionAuthorization,
  UNAUTHORIZED_CONTEXT,
} from "./authorization-context";
import { withEventApiLambdaBoundary } from "./lambda-boundary";
interface LambdaEvent {
  readonly routeKey?: string;
  readonly rawPath?: string;
  readonly pathParameters?: {
    readonly eventId?: string;
    readonly sportKey?: string;
    readonly opportunityId?: string;
    readonly jobId?: string;
    readonly reportId?: string;
    readonly versionNumber?: string;
  };
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly http?: { readonly sourceIp?: string };
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
// SMS goes out over SNS direct publish: the account's origination identity
// is already registered at the account and region level, so the client needs
// no configuration and the stack provisions no messaging resource.
const identitySecretId = process.env["FTE_IDENTITY_SECRET_ID"] ?? "";
// Billing is optional configuration on purpose: a stage without a Stripe
// secret still deploys and still serves every route except billing.
const stripeSecretId = process.env["FTE_STRIPE_SECRET_ID"] ?? "";
const webBaseUrl = process.env["FTE_WEB_BASE_URL"] ?? "";
/**
 * The origin a sign-in code is bound to for WebOTP autofill. It is derived
 * from this stage's own configured web origin — the same value CORS allows —
 * and never from a request header, because a code bound to a host the caller
 * supplied is a code the caller's site can autofill. A stage without the
 * variable sends the unbound text, which still works everywhere it did.
 */
const webOtpHost = ((): string | undefined => {
  try {
    return new URL(webBaseUrl).host;
  } catch {
    return undefined;
  }
})();
/**
 * FTE-073's rollout switch. Entitlement is only reachable through Stripe
 * checkout, so a stage with no billing secret has no entitled accounts and
 * enforcing there would refuse every request including our own. The flag
 * therefore ships off and is turned on per stage once billing is live. Only
 * the exact string "true" enables it: a typo must fail closed to "open",
 * never to a half-configured gate.
 */
const productAccessEnforced =
  process.env["FTE_PRODUCT_ACCESS_ENFORCED"] === "true";
const sms = createSnsSmsSender(new SNSClient({}));
/**
 * The route keys billing owns. `POST /billing/webhook` is public — Stripe
 * calls it and proves itself with a signature over the raw body — and the
 * rest verify our own session token inside the handler.
 */
const BILLING_ROUTES: Readonly<
  Record<
    string,
    | "billing-webhook"
    | "billing-entitlement"
    | "billing-checkout"
    | "billing-portal"
  >
> = {
  "POST /billing/webhook": "billing-webhook",
  "GET /billing/entitlement": "billing-entitlement",
  "POST /billing/checkout": "billing-checkout",
  "POST /billing/portal": "billing-portal",
};
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
  const ready = await readEventProjectionReadiness(gateway);
  readinessCache = {
    ready,
    expiresAt: Date.now() + (ready ? 60_000 : 5_000),
  };
  return ready;
};
const handleEvent = async (event: LambdaEvent) => {
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
  const identityRepository = memoizeIdentityAccountLookup(
    new DynamoIdentityRepository(documentClient, tableName),
  );
  const route =
    BILLING_ROUTES[event.routeKey ?? ""] ??
    (event.routeKey === "POST /auth/otp/request"
      ? "auth-otp-request"
      : event.routeKey === "POST /auth/otp/verify"
        ? "auth-otp-verify"
        : event.routeKey === "POST /auth/session/refresh"
          ? "auth-session-refresh"
          : event.routeKey === "POST /auth/session/revoke"
            ? "auth-session-revoke"
            : event.routeKey === "GET /watchlist"
              ? "watchlist-list"
              : event.routeKey === "POST /watchlist"
                ? "watchlist-add"
                : event.routeKey === "DELETE /watchlist/{eventId}"
                  ? "watchlist-remove"
                  : event.routeKey === "POST /events/{eventId}/scout"
                    ? "scout-create"
                    : event.routeKey === "GET /scout-jobs/{jobId}"
                      ? "scout-status"
                      : event.routeKey === "POST /scout-jobs/{jobId}/retry"
                        ? "scout-retry"
                        : event.routeKey === "GET /scout-jobs/{jobId}/report"
                          ? "scout-report-by-job"
                          : event.routeKey ===
                              "GET /scout-reports/{reportId}/versions"
                            ? "scout-report-versions"
                            : event.routeKey ===
                                "GET /scout-reports/{reportId}/versions/{versionNumber}"
                              ? "scout-report-version"
                              : event.routeKey === "GET /providers/status"
                                ? "provider-status"
                                : event.routeKey ===
                                    "GET /sports/{sportKey}/opportunities"
                                  ? "opportunity-list"
                                  : event.routeKey ===
                                      "GET /sports/{sportKey}/opportunities/{opportunityId}"
                                    ? "opportunity-detail"
                                    : event.routeKey ===
                                        "GET /sports/{sportKey}/arbitrage"
                                      ? "arbitrage-list"
                                      : event.routeKey ===
                                          "GET /sports/{sportKey}/clv"
                                        ? "clv-list"
                                        : event.routeKey ===
                                            "GET /strategy-experiments"
                                          ? "experiment-list"
                                          : event.routeKey ===
                                              "GET /strategy-experiments/{eventId}"
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
                                                  : event.routeKey ===
                                                      "GET /retrospectives"
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
                                                            : event.routeKey?.startsWith(
                                                                  "GET /games",
                                                                )
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
                                                                          : "list");
  const eventId = event.pathParameters?.eventId;
  const eventIdAlternatives = eventIdCandidates(
    event.rawPath,
    event.routeKey,
    eventId,
  );
  const sportKey = event.pathParameters?.sportKey;
  const opportunityId = event.pathParameters?.opportunityId;
  const jobId = event.pathParameters?.jobId;
  const reportId = event.pathParameters?.reportId;
  const versionNumber = event.pathParameters?.versionNumber;
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
  const authorization = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  const gatewayAuthorization = authorizationContextFromGateway(
    event.requestContext?.authorizer?.jwt,
  );
  const ownedSessionAuthorization =
    requiresProductAccess(route) && isOwnedSessionAuthorization(authorization);
  const stripeSignature = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === "stripe-signature",
  )?.[1];
  const sourceIp = event.requestContext?.http?.sourceIp;
  /**
   * The raw request body, byte for byte. API Gateway base64-encodes a body it
   * judges binary; decoding here is the only transformation applied, and it
   * is lossless. Nothing on this path parses or re-serializes the body, which
   * is what lets the Stripe webhook verify a signature over it.
   */
  const rawBody =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded === true
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
  const billingRoute = route.startsWith("billing-");
  // The identity service is only built for the routes that need it, so a
  // stage without the secret still serves every other route. Billing shares
  // the signing ring: its authenticated routes verify our own token.
  const identity =
    route === "auth-otp-request" ||
    route === "auth-otp-verify" ||
    route === "auth-session-refresh" ||
    route === "auth-session-revoke" ||
    billingRoute ||
    // Enforcement needs the ring on every product route, not just the auth
    // ones. While the flag is off, the secret load stays on the auth path
    // alone and product routes pay nothing for it.
    (productAccessEnforced && requiresProductAccess(route)) ||
    // This is preparation for the authorizer cutover only. API Gateway still
    // enforces Cognito in deployed stages, but a request that reaches the
    // adapter with an fte1 credential must be verified here and fail closed.
    ownedSessionAuthorization
      ? await loadIdentitySecrets(secrets, identitySecretId)
      : undefined;
  const requestAuthorization = ownedSessionAuthorization
    ? identity
      ? ((await resolveOwnedSessionAuthorization({
          ...(authorization ? { authorization } : {}),
          signingKeys: identity.signingKeys,
          identity: identityRepository,
          now: new Date(),
        })) ?? UNAUTHORIZED_CONTEXT)
      : UNAUTHORIZED_CONTEXT
    : gatewayAuthorization;
  let billingSecrets: BillingSecrets | undefined;
  if (billingRoute && stripeSecretId && webBaseUrl)
    try {
      billingSecrets = await loadBillingSecrets(secrets, stripeSecretId);
    } catch {
      // The stage has no Stripe secret yet, or it is malformed. Billing
      // routes answer 503; every other route is untouched.
      billingSecrets = undefined;
    }
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
    new DynamoClvRepository(documentClient, tableName),
    new DynamoScoutingReportRepository(documentClient, tableName),
    new DynamoWatchlistRepository(documentClient, tableName),
    identityRepository,
    identity
      ? {
          sms,
          otpPepper: identity.otpPepper,
          accountPepper: identity.accountPepper,
          signingKeys: identity.signingKeys,
          ...(webOtpHost ? { webOtpHost } : {}),
        }
      : undefined,
    new DynamoEntitlementRepository(documentClient, tableName),
    // The only place a Stripe network client is constructed, and the only
    // place the secret key is read.
    billingSecrets && identity
      ? {
          signingKeys: identity.signingKeys,
          webhookSecret: billingSecrets.webhookSecret,
          priceId: billingSecrets.priceId,
          ...(billingSecrets.annualPriceId
            ? { annualPriceId: billingSecrets.annualPriceId }
            : {}),
          stripe: createStripeRestClient({
            secretKey: billingSecrets.secretKey,
          }),
          appBaseUrl: webBaseUrl,
        }
      : undefined,
    identity
      ? { signingKeys: identity.signingKeys, enforced: productAccessEnforced }
      : undefined,
  )({
    route,
    ...(requestAuthorization.subject
      ? { subject: requestAuthorization.subject }
      : {}),
    ...(requestAuthorization.scopes
      ? { scopes: requestAuthorization.scopes }
      : {}),
    reviewerAuthorized: requestAuthorization.reviewerAuthorized,
    strategyPromoterAuthorized: requestAuthorization.strategyPromoterAuthorized,
    ...(eventId ? { eventId } : {}),
    ...(eventIdAlternatives.length > 0 ? { eventIdAlternatives } : {}),
    ...(sportKey ? { sportKey } : {}),
    ...(opportunityId ? { opportunityId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(reportId ? { reportId } : {}),
    ...(versionNumber ? { versionNumber } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(event.requestContext?.requestId
      ? { requestId: event.requestContext.requestId }
      : {}),
    ...(query ? { query } : {}),
    method: event.routeKey?.startsWith("POST ")
      ? "POST"
      : event.routeKey?.startsWith("DELETE ")
        ? "DELETE"
        : "GET",
    ...(contentType ? { contentType } : {}),
    ...(authorization ? { authorization } : {}),
    ...(sourceIp ? { sourceIp } : {}),
    ...(stripeSignature ? { stripeSignature } : {}),
    ...(rawBody ? { body: rawBody } : {}),
  });
  return encodeApiResponse(apiResponse, acceptEncoding);
};

export const handler = (event: LambdaEvent) =>
  withEventApiLambdaBoundary(() => handleEvent(event));
