import {
  composeProductAccess,
  hasProductAccess,
  identityAuthorizationCapabilities,
  verifySessionToken,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import type {
  EntitlementRepository,
  AdminAccessRepository,
  IdentityAuthorizationRepository,
  IdentityRepository,
} from "@find-the-edge/database";

/**
 * FTE-073. One list, consulted before any product route runs.
 *
 * The split is by what a route is FOR, not by what it costs to serve.
 * Everything carrying priced odds, derived edges, scouting work, or per-user
 * product state is paid. The routes left open are the ones that cannot be
 * paid for:
 *
 *  - `auth-*` is how a caller obtains a token at all.
 *  - `billing-*` is how a caller starts paying. Gating it behind payment
 *    would be a loop with no entrance. The webhook is Stripe itself, which
 *    authenticates with a signature over the raw body rather than a session.
 *  - `provider-status` backs the anonymous feed-health banner. It reports
 *    liveness and staleness only — never a price, a line, or an edge.
 */
const OPEN_ROUTES = new Set([
  "auth-otp-request",
  "auth-otp-verify",
  "auth-session-refresh",
  // Signing out must work even for a session the gate would refuse.
  "auth-session-revoke",
  // This route authenticates the owned bearer itself and reports authority,
  // not paid product data. Gating capability discovery behind entitlement
  // would make the browser unable to distinguish authorization from access.
  "auth-session-capabilities",
  "billing-webhook",
  "billing-entitlement",
  "billing-checkout",
  "billing-portal",
  "provider-status",
  "admin-users-list",
  "admin-access-grant",
  "admin-access-revoke",
]);

export const requiresProductAccess = (route: string): boolean =>
  !OPEN_ROUTES.has(route);

/**
 * Why a product read was refused. These strings reach the browser and are
 * the paywall's entire vocabulary: the client picks between "sign in" and
 * "subscribe" from this and nothing else.
 */
export type ProductAccessDenial =
  "unauthenticated" | "not-entitled" | "access-unavailable";

export type ProductAccessDecision =
  | { readonly allowed: true; readonly accountId?: string }
  | {
      readonly allowed: false;
      readonly denial: ProductAccessDenial;
      readonly accountId?: string;
    };

const bearer = (authorization: string | undefined): string | null => {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1]! : null;
};

export interface ProductAccessRuntime {
  readonly signingKeys: SessionKeyRing;
  /**
   * The rollout switch, and deliberately a server-side one.
   *
   * Entitlement is only reachable through Stripe checkout, so enforcing
   * before the billing secret exists would refuse every request including
   * our own. This stays false until billing is configured, at which point
   * turning it on is an environment change with no code motion. It is read
   * from configuration only: a client cannot set it, send it, or influence
   * it.
   */
  readonly enforced: boolean;
  readonly adminAccessEnabled?: boolean;
}

/**
 * The access decision, made entirely server-side. Nothing the client sends
 * participates: the account comes from a signature we verify, the token
 * version is confirmed against the stored account so a revoked session dies
 * here, the entitlement comes from storage, and the verdict comes from the
 * domain's `hasProductAccess`. A claim of entitlement in a body or a header
 * is never read.
 *
 * A storage failure propagates rather than being swallowed. Treating an
 * unreadable entitlement as "allowed" would turn a DynamoDB blip into free
 * access; treating it as "denied" would show a paywall to a paying customer
 * over an outage. Neither is a decision this function is entitled to make,
 * so it raises and the handler's error path answers 500.
 */
export async function decideProductAccess(
  request: { readonly route: string; readonly authorization?: string },
  runtime: ProductAccessRuntime,
  identity: IdentityRepository,
  entitlements: EntitlementRepository,
  now: Date,
  adminAccess?: Pick<AdminAccessRepository, "getByAccount">,
  identityAuthorization?: Pick<IdentityAuthorizationRepository, "get">,
): Promise<ProductAccessDecision> {
  if (!runtime.enforced || !requiresProductAccess(request.route))
    return { allowed: true };
  const token = bearer(request.authorization);
  if (!token) return { allowed: false, denial: "unauthenticated" };
  const verified = verifySessionToken(
    token,
    runtime.signingKeys,
    now.toISOString(),
  );
  if (verified.outcome !== "valid")
    return { allowed: false, denial: "unauthenticated" };
  const account = await identity.getAccount(verified.payload.accountId);
  if (!account || account.tokenVersion !== verified.payload.tokenVersion)
    return { allowed: false, denial: "unauthenticated" };
  if (!runtime.adminAccessEnabled) {
    const record = await entitlements.get(account.accountId);
    if (hasProductAccess(record, now.toISOString()))
      return { allowed: true, accountId: account.accountId };
    return {
      allowed: false,
      denial: "not-entitled",
      accountId: account.accountId,
    };
  }
  if (!adminAccess || !identityAuthorization)
    return {
      allowed: false,
      denial: "access-unavailable",
      accountId: account.accountId,
    };
  const [stripeResult, manualResult, authorizationResult] =
    await Promise.allSettled([
      entitlements.get(account.accountId),
      adminAccess.getByAccount(account.accountId),
      identityAuthorization.get(account.accountId),
    ]);
  const manual =
    manualResult.status === "fulfilled" &&
    manualResult.value?.manualGrant?.active === true;
  const superAdmin =
    authorizationResult.status === "fulfilled" &&
    identityAuthorizationCapabilities(
      authorizationResult.value?.roles ?? [],
    ).includes("accounts/access:manage");
  const stripe =
    stripeResult.status === "rejected"
      ? "unavailable"
      : hasProductAccess(stripeResult.value, now.toISOString())
        ? "active"
        : "inactive";
  const access = composeProductAccess({ superAdmin, stripe, manual });
  if (access.outcome === "granted")
    return { allowed: true, accountId: account.accountId };
  const sourceUnavailable =
    stripeResult.status === "rejected" ||
    manualResult.status === "rejected" ||
    authorizationResult.status === "rejected";
  return {
    allowed: false,
    denial:
      access.outcome === "unavailable" || sourceUnavailable
        ? "access-unavailable"
        : "not-entitled",
    accountId: account.accountId,
  };
}

/**
 * 401 says "prove who you are"; 402 says "we know who you are and this
 * account has not paid". Collapsing them would leave the browser guessing
 * between a sign-in form and a subscribe button.
 */
export const denialStatus = (denial: ProductAccessDenial): 401 | 402 | 503 =>
  denial === "unauthenticated" ? 401 : denial === "not-entitled" ? 402 : 503;

export const denialBody = (denial: ProductAccessDenial) => ({
  error:
    denial === "unauthenticated"
      ? "unauthorized"
      : denial === "not-entitled"
        ? "payment-required"
        : "access-unavailable",
  reason: denial,
});
