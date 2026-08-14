import {
  SESSION_TOKEN_MAX_LENGTH,
  verifySessionToken,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import type { IdentityRepository } from "@find-the-edge/database";

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
 * scopes are deliberately absent and need a future server-owned role model. */
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

/** Preserve the legacy Cognito projection exactly while its authorizer is
 * still attached. This function is intentionally claim-aware; the owned
 * session path below never consults these client-adjacent values. */
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
  return {
    subject: account.accountId,
    scopes: OWNED_SESSION_SCOPES,
    reviewerAuthorized: false,
    strategyPromoterAuthorized: false,
  };
}
