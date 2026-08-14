import {
  IDENTITY_AUTHORIZATION_CAPABILITIES,
  identityAuthorizationCapabilities,
  SESSION_TOKEN_MAX_LENGTH,
  verifySessionToken,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import type {
  IdentityAuthorizationRepository,
  IdentityRepository,
} from "@find-the-edge/database";

/**
 * The shape the HTTP adapter already supplies to product handlers. Keeping
 * both authorizers behind one shape lets the infrastructure cutover happen
 * later without teaching every handler about token formats.
 */
export interface HandlerAuthorizationContext {
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly reviewerAuthorized: boolean;
  readonly strategyPromoterAuthorized: boolean;
}

/** Product scopes an ordinary signed-in account owns. Elevated workflow
 * scopes stay absent until a server-owned role record is requested. */
export const OWNED_SESSION_SCOPES = Object.freeze([
  "events/events:read",
  "events/scouting:read",
  "events/scouting:write",
]);

export const UNAUTHORIZED_CONTEXT: HandlerAuthorizationContext = Object.freeze({
  reviewerAuthorized: false,
  strategyPromoterAuthorized: false,
});

interface GatewayJwtAuthorization {
  readonly claims?: Record<string, unknown>;
  readonly scopes?: readonly string[];
}

export const ORDINARY_OWNED_ROUTE_KEYS = Object.freeze([
  "GET /events",
  "POST /events/{eventId}/scout",
  "GET /scout-jobs/{jobId}",
  "POST /scout-jobs/{jobId}/retry",
  "GET /scout-jobs/{jobId}/report",
  "GET /scout-reports/{reportId}/versions",
  "GET /scout-reports/{reportId}/versions/{versionNumber}",
  "GET /watchlist",
  "POST /watchlist",
  "DELETE /watchlist/{eventId}",
] as const);

export const ELEVATED_OWNED_ROUTE_KEYS = Object.freeze([
  "POST /retrospectives/{eventId}/review",
  "POST /strategy-experiments/{eventId}/approve",
  "POST /strategy-experiments/{eventId}/promote",
  "POST /strategy-experiments/{eventId}/rollback",
] as const);

const ordinaryOwnedRouteKeys = new Set<string>(ORDINARY_OWNED_ROUTE_KEYS);
const elevatedOwnedRouteKeys = new Set<string>(ELEVATED_OWNED_ROUTE_KEYS);

export const authorizationHeaderFromLambdaHeaders = (
  headers: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined =>
  Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];

export interface LambdaRequestAuthorizationInput {
  readonly routeKey?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly gatewayJwt?: GatewayJwtAuthorization;
  readonly productRoute: boolean;
  readonly capabilitiesRoute: boolean;
  readonly includeElevatedAuthorization: boolean;
  readonly ownedRuntime?: {
    readonly signingKeys: SessionKeyRing;
    readonly identity: Pick<IdentityRepository, "getAccount">;
    readonly identityAuthorization?: Pick<
      IdentityAuthorizationRepository,
      "get"
    >;
    readonly now: Date;
  };
}

export const shouldResolveOwnedLambdaAuthorization = (
  input: Pick<
    LambdaRequestAuthorizationInput,
    "routeKey" | "headers" | "productRoute" | "capabilitiesRoute"
  >,
): boolean =>
  (ordinaryOwnedRouteKeys.has(input.routeKey ?? "") ||
    elevatedOwnedRouteKeys.has(input.routeKey ?? "") ||
    input.productRoute ||
    input.capabilitiesRoute) &&
  isOwnedSessionAuthorization(
    authorizationHeaderFromLambdaHeaders(input.headers),
  );

/**
 * Production Lambda authorization seam. Ordinary detached routes accept only
 * a verified owned bearer, even if a synthetic request context contains stale
 * gateway claims. Routes outside that exact cutover inventory retain the
 * legacy projection until their own migration slice.
 */
export async function authorizationContextFromLambdaRequest(
  input: LambdaRequestAuthorizationInput,
): Promise<HandlerAuthorizationContext> {
  const ordinaryOwnedRoute = ordinaryOwnedRouteKeys.has(input.routeKey ?? "");
  const elevatedOwnedRoute = elevatedOwnedRouteKeys.has(input.routeKey ?? "");
  const authorization = authorizationHeaderFromLambdaHeaders(input.headers);
  const resolveOwned = shouldResolveOwnedLambdaAuthorization(input);
  if (resolveOwned) {
    if (!input.ownedRuntime) return UNAUTHORIZED_CONTEXT;
    return (
      (await resolveOwnedSessionAuthorization({
        ...(authorization ? { authorization } : {}),
        signingKeys: input.ownedRuntime.signingKeys,
        identity: input.ownedRuntime.identity,
        ...(input.includeElevatedAuthorization
          ? {
              includeElevatedAuthorization: true,
              ...(input.ownedRuntime.identityAuthorization
                ? {
                    identityAuthorization:
                      input.ownedRuntime.identityAuthorization,
                  }
                : {}),
            }
          : {}),
        now: input.ownedRuntime.now,
      })) ?? UNAUTHORIZED_CONTEXT
    );
  }
  if (ordinaryOwnedRoute || elevatedOwnedRoute || input.capabilitiesRoute)
    return UNAUTHORIZED_CONTEXT;
  return authorizationContextFromGateway(input.gatewayJwt);
}

export const handlerAuthorizationFields = (
  authorization: HandlerAuthorizationContext,
) => ({
  ...(authorization.subject ? { subject: authorization.subject } : {}),
  ...(authorization.scopes ? { scopes: authorization.scopes } : {}),
  reviewerAuthorized: authorization.reviewerAuthorized,
  strategyPromoterAuthorized: authorization.strategyPromoterAuthorized,
});

/** Preserve the legacy Cognito projection as a rollback seam. This function
 * is intentionally claim-aware; every detached owned-session route is
 * inventoried above and never consults these client-adjacent values. */
export function authorizationContextFromGateway(
  jwt: GatewayJwtAuthorization | undefined,
): HandlerAuthorizationContext {
  const claims = jwt?.claims;
  const subject =
    typeof claims?.["sub"] === "string" ? claims["sub"] : undefined;
  const claimScope = claims?.["scope"];
  const scopes =
    jwt?.scopes ??
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
  return {
    ...(subject ? { subject } : {}),
    ...(scopes ? { scopes } : {}),
    reviewerAuthorized,
    strategyPromoterAuthorized,
  };
}

/**
 * Classify before verification so a malformed credential that clearly
 * claims the owned-token namespace cannot fall back to gateway claims.
 * This examines only the small scheme/prefix boundary; the full bounded
 * grammar remains the verifier's responsibility.
 */
export const isOwnedSessionAuthorization = (
  authorization: string | undefined,
): boolean =>
  typeof authorization === "string" &&
  /^\s*Bearer\s+fte1(?:\.|\s|$)/i.test(authorization);

const bearer = (authorization: string | undefined): string | null => {
  if (
    typeof authorization !== "string" ||
    authorization.length > SESSION_TOKEN_MAX_LENGTH + 16
  )
    return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
};

/**
 * Share one account read across the owned authorization projection and the
 * entitlement gate. The wrapper is request-scoped in the Lambda adapter, so
 * it cannot retain a revoked account across requests or execution reuse.
 */
export function memoizeIdentityAccountLookup<
  T extends Pick<IdentityRepository, "getAccount">,
>(identity: T): T {
  const accounts = new Map<
    string,
    ReturnType<IdentityRepository["getAccount"]>
  >();
  return new Proxy(identity, {
    get(target, property) {
      if (property === "getAccount")
        return (accountId: string) => {
          const existing = accounts.get(accountId);
          if (existing) return existing;
          const pending = target.getAccount(accountId);
          accounts.set(accountId, pending);
          return pending;
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: readonly unknown[]) =>
            Reflect.apply(value, target, args) as unknown
        : value;
    },
  });
}

export interface OwnedSessionAuthorizationInput {
  readonly authorization?: string;
  readonly signingKeys: SessionKeyRing;
  readonly identity: Pick<IdentityRepository, "getAccount">;
  /**
   * Elevated authority has a separate server-owned source. Ordinary product
   * routes omit this flag and therefore do not pay for or trust a role read.
   */
  readonly includeElevatedAuthorization?: boolean;
  readonly identityAuthorization?: Pick<IdentityAuthorizationRepository, "get">;
  readonly now: Date;
}

/**
 * Resolve a trusted owned-session context. Invalid credentials return no
 * context, while repository errors propagate to the Lambda's safe 500 path.
 * No error includes the token or account id.
 */
export async function resolveOwnedSessionAuthorization(
  input: OwnedSessionAuthorizationInput,
): Promise<HandlerAuthorizationContext | null> {
  const token = bearer(input.authorization);
  if (!token) return null;
  const verification = verifySessionToken(
    token,
    input.signingKeys,
    input.now.toISOString(),
  );
  if (verification.outcome !== "valid") return null;
  let account: Awaited<ReturnType<IdentityRepository["getAccount"]>>;
  try {
    account = await input.identity.getAccount(verification.payload.accountId);
  } catch {
    // Upstream errors may include the requested DynamoDB key. Do not retain a
    // cause object that a future logger or serializer could expose.
    throw new Error("owned-session-authorization-unavailable");
  }
  if (
    !account ||
    account.accountId !== verification.payload.accountId ||
    account.tokenVersion !== verification.payload.tokenVersion
  )
    return null;
  if (!input.includeElevatedAuthorization)
    return {
      subject: account.accountId,
      scopes: OWNED_SESSION_SCOPES,
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    };
  if (!input.identityAuthorization)
    throw new Error("owned-session-authorization-unavailable");
  let authorizationRecord: Awaited<
    ReturnType<IdentityAuthorizationRepository["get"]>
  >;
  try {
    authorizationRecord = await input.identityAuthorization.get(
      account.accountId,
    );
  } catch {
    // Keep malformed rows, Dynamo keys, and SDK details behind the same safe
    // adapter error used for an unreadable account authority.
    throw new Error("owned-session-authorization-unavailable");
  }
  if (
    authorizationRecord &&
    authorizationRecord.accountId !== account.accountId
  )
    throw new Error("owned-session-authorization-unavailable");
  let elevatedScopes: ReturnType<typeof identityAuthorizationCapabilities>;
  try {
    elevatedScopes = identityAuthorizationCapabilities(
      authorizationRecord?.roles ?? [],
    );
  } catch {
    // Defend the boundary even when a non-Dynamo repository violates its
    // declared contract. A malformed role set must never become authority.
    throw new Error("owned-session-authorization-unavailable");
  }
  return {
    subject: account.accountId,
    scopes: Object.freeze([...OWNED_SESSION_SCOPES, ...elevatedScopes]),
    reviewerAuthorized: elevatedScopes.includes(
      IDENTITY_AUTHORIZATION_CAPABILITIES[0],
    ),
    strategyPromoterAuthorized: elevatedScopes.includes(
      IDENTITY_AUTHORIZATION_CAPABILITIES[1],
    ),
  };
}
