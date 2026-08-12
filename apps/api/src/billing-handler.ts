import type {
  EntitlementRepository,
  IdentityRepository,
} from "@find-the-edge/database";
import {
  applyStripeEvent,
  entitlementView,
  ENTITLEMENT_TRIAL_DAYS,
  normalizeStripeEvent,
  STRIPE_EVENT_UNSUPPORTED,
  verifySessionToken,
  verifyStripeSignature,
  type EntitlementState,
  type SessionKeyRing,
  type StripeEventType,
} from "@find-the-edge/domain";
import type { StripeClient } from "./stripe-client";

export type BillingHttpRoute =
  | "billing-webhook"
  | "billing-entitlement"
  | "billing-checkout"
  | "billing-portal";

export interface BillingHttpRequest {
  readonly route: BillingHttpRoute;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly contentType?: string;
  /**
   * The body exactly as it arrived. The webhook route hashes these bytes, so
   * nothing between the gateway and here may reparse, reformat, or
   * re-serialize it — an equivalent JSON value with different bytes has a
   * different signature and would be rejected.
   */
  readonly body?: string;
  /** Raw `Authorization` header; the webhook route never reads it. */
  readonly authorization?: string;
  /** Raw `Stripe-Signature` header; only the webhook route reads it. */
  readonly stripeSignature?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
}

export interface BillingHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface BillingRuntime {
  /** FTE-070's ring. The entitlement, checkout, and portal routes verify our
   * own token in the handler; there is no gateway authorizer in front. */
  readonly signingKeys: SessionKeyRing;
  readonly webhookSecret: string;
  readonly priceId: string;
  readonly stripe: StripeClient;
  /** Origin the checkout and portal flows return to. Server-configured; a
   * client-supplied return URL would be an open redirect. */
  readonly appBaseUrl: string;
  readonly trialDays?: number;
  /** Absent means this stage sells only the monthly plan. */
  readonly annualPriceId?: string;
  readonly signatureToleranceSeconds?: number;
  readonly now?: () => Date;
}

export type BillingOutcome =
  | "applied"
  | "duplicate"
  | "ignored-older"
  | "ignored-unhandled"
  | "ignored-unknown-customer"
  | "superseded"
  | "invalid-signature"
  | "invalid-request"
  | "entitlement"
  | "checkout-created"
  | "portal-created"
  | "billing-account-missing"
  | "provider-error"
  | "unauthorized";

/**
 * What the billing path is allowed to say about itself: a stable outcome, the
 * Stripe event type, the resulting state, and the account id. Never a card,
 * never a payload, never a Stripe secret.
 */
export interface BillingObservation {
  readonly outcome: BillingOutcome;
  readonly eventType: StripeEventType | null;
  readonly state: EntitlementState | null;
  readonly accountId: string | null;
}

export interface BillingHttpResult {
  readonly response: BillingHttpResponse;
  readonly observation: BillingObservation;
}

/** Stripe events are small; anything past this is not one worth hashing. */
export const BILLING_WEBHOOK_MAX_BYTES = 262_144;

const response = (statusCode: number, body: unknown): BillingHttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const UNAUTHORIZED = Object.freeze({ error: "unauthorized" });
const INVALID_REQUEST = Object.freeze({ error: "invalid-request" });

/** The only two plans this product sells. A name, never a price. */
export const CHECKOUT_PLANS = ["monthly", "annual"] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

/**
 * The plan a checkout body asks for, or null when the body is anything this
 * route does not understand. An empty body still means monthly, so a caller
 * that predates the choice keeps working exactly as before.
 */
const checkoutPlan = (request: {
  readonly body?: string;
}): CheckoutPlan | null => {
  const body = request.body;
  if (body === undefined || body === "" || body === "{}") return "monthly";
  if (body.length > 64) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "plan") return null;
  const plan = (parsed as { plan?: unknown }).plan;
  return CHECKOUT_PLANS.includes(plan as CheckoutPlan)
    ? (plan as CheckoutPlan)
    : null;
};
/** One shape for every signature failure: bad secret, tampered payload,
 * stale timestamp, missing header. Stripe needs no more, and neither does
 * anybody probing the endpoint. */
const INVALID_SIGNATURE = Object.freeze({ error: "invalid-signature" });

const observation = (
  outcome: BillingOutcome,
  extra: {
    readonly eventType?: StripeEventType | null;
    readonly state?: EntitlementState | null;
    readonly accountId?: string | null;
  } = {},
): BillingObservation => ({
  outcome,
  eventType: extra.eventType ?? null,
  state: extra.state ?? null,
  accountId: extra.accountId ?? null,
});

/** `Bearer <token>`, scheme case-insensitive, exactly two parts. */
const bearerToken = (authorization: string | undefined): string | null => {
  if (typeof authorization !== "string" || authorization.length > 2048)
    return null;
  const parts = authorization.split(" ").filter((part) => part.length > 0);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer"
    ? (parts[1] ?? null)
    : null;
};

const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";

const baseUrl = (value: string): string => {
  if (
    typeof value !== "string" ||
    !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(value)
  )
    throw new Error("billing-app-base-url-invalid");
  return value;
};

export const createBillingHttpHandler =
  (
    entitlements: EntitlementRepository,
    identity: IdentityRepository,
    runtime: BillingRuntime,
  ) =>
  async (request: BillingHttpRequest): Promise<BillingHttpResult> => {
    const now = (runtime.now?.() ?? new Date()).toISOString();
    if (request.route === "billing-webhook") {
      const rejected = (
        outcome: "invalid-signature" | "invalid-request",
      ): BillingHttpResult => ({
        response: response(
          400,
          outcome === "invalid-signature" ? INVALID_SIGNATURE : INVALID_REQUEST,
        ),
        observation: observation(outcome),
      });
      if (
        request.method !== "POST" ||
        !isJson(request.contentType) ||
        Object.keys(request.query ?? {}).length > 0 ||
        typeof request.body !== "string" ||
        request.body.length === 0 ||
        Buffer.byteLength(request.body) > BILLING_WEBHOOK_MAX_BYTES
      )
        return rejected("invalid-request");
      // The signature is checked before the payload is even parsed: an
      // unsigned body is not input this service has agreed to read.
      const signature = verifyStripeSignature({
        payload: request.body,
        header: request.stripeSignature ?? "",
        secret: runtime.webhookSecret,
        now,
        ...(runtime.signatureToleranceSeconds === undefined
          ? {}
          : { toleranceSeconds: runtime.signatureToleranceSeconds }),
      });
      if (signature.outcome !== "valid") return rejected("invalid-signature");
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body);
      } catch {
        return rejected("invalid-request");
      }
      let event;
      try {
        event = normalizeStripeEvent(parsed);
      } catch (error) {
        // A signed event of a type this product does not act on is a
        // successful no-op, not a failure: answering 400 would make Stripe
        // retry it for days and eventually disable the endpoint.
        if (
          error instanceof Error &&
          error.message === STRIPE_EVENT_UNSUPPORTED
        )
          return {
            response: response(200, {
              schemaVersion: "billing-webhook-v1",
              status: "ignored",
            }),
            observation: observation("ignored-unhandled"),
          };
        return rejected("invalid-request");
      }
      const accountId = await entitlements.findAccountByStripeCustomer(
        event.customerId,
      );
      if (!accountId)
        // A customer this deployment has never linked — most often a staging
        // endpoint receiving another environment's events. Nothing to apply,
        // and nothing for Stripe to retry.
        return {
          response: response(200, {
            schemaVersion: "billing-webhook-v1",
            status: "ignored",
          }),
          observation: observation("ignored-unknown-customer", {
            eventType: event.type,
          }),
        };
      const current = await entitlements.get(accountId);
      const application = applyStripeEvent(current, event, now, accountId);
      // The reducer already refused duplicates and out-of-order events; the
      // conditional write is the second fence, for two deliveries that read
      // the same record concurrently and both decided to apply.
      const persisted =
        application.outcome === "applied"
          ? await entitlements.save(application.next)
          : true;
      const outcome: BillingOutcome =
        application.outcome === "applied" && !persisted
          ? "superseded"
          : application.outcome;
      return {
        response: response(200, {
          schemaVersion: "billing-webhook-v1",
          status: outcome === "superseded" ? "ignored-older" : outcome,
        }),
        observation: observation(outcome, {
          eventType: event.type,
          state: application.next.state,
          accountId,
        }),
      };
    }
    // Every remaining route is authenticated with our own session token. The
    // gateway puts no authorizer in front of them, so this is the only check
    // and it must be total.
    const unauthorized: BillingHttpResult = {
      response: response(401, UNAUTHORIZED),
      observation: observation("unauthorized"),
    };
    const token = bearerToken(request.authorization);
    if (!token || Object.keys(request.query ?? {}).length > 0)
      return unauthorized;
    const verified = verifySessionToken(token, runtime.signingKeys, now);
    if (verified.outcome !== "valid") return unauthorized;
    // The account row is the authority on revocation: a bumped token version,
    // or a deleted account, ends the session here as it does on refresh.
    const account = await identity.getAccount(verified.payload.accountId);
    if (!account || account.tokenVersion !== verified.payload.tokenVersion)
      return unauthorized;
    const accountId = account.accountId;
    if (request.route === "billing-entitlement") {
      if (request.method !== "GET" || request.body) return unauthorized;
      const record = await entitlements.get(accountId);
      const view = entitlementView(record, now);
      // Deliberately only these three fields. A Stripe customer or
      // subscription id in a browser response is an identifier for somebody
      // else's system, and this product has no reason to hand one out.
      return {
        response: response(200, {
          schemaVersion: "billing-entitlement-v1",
          state: view.state,
          accessUntil: view.accessUntil,
          hasAccess: view.hasAccess,
        }),
        observation: observation("entitlement", {
          state: view.state,
          accountId,
        }),
      };
    }
    // Checkout takes exactly one thing from the caller, and it is a plan
    // NAME, never a price. "monthly" and "annual" are the only two words this
    // route understands; each is resolved to a price id held server-side, so
    // a caller can pick between the plans we sell and cannot invent one. The
    // trial length and return URL stay entirely server-side. Portal still
    // takes nothing at all.
    const plan = checkoutPlan(request);
    if (
      request.method !== "POST" ||
      plan === null ||
      (request.route === "billing-portal" && plan !== "monthly")
    )
      return {
        response: response(400, INVALID_REQUEST),
        observation: observation("invalid-request", { accountId }),
      };
    // A stage without an annual price does not offer the annual plan. Saying
    // so is the honest failure; charging monthly for a yearly promise is not.
    if (plan === "annual" && !runtime.annualPriceId)
      return {
        response: response(400, INVALID_REQUEST),
        observation: observation("invalid-request", { accountId }),
      };
    const origin = baseUrl(runtime.appBaseUrl);
    const record = await entitlements.get(accountId);
    try {
      if (request.route === "billing-portal") {
        if (!record?.stripeCustomerId)
          return {
            response: response(409, { error: "billing-account-missing" }),
            observation: observation("billing-account-missing", { accountId }),
          };
        const portal = await runtime.stripe.createBillingPortalSession({
          customerId: record.stripeCustomerId,
          returnUrl: `${origin}/`,
        });
        return {
          response: response(200, {
            schemaVersion: "billing-portal-v1",
            url: portal.url,
          }),
          observation: observation("portal-created", { accountId }),
        };
      }
      let customerId = record?.stripeCustomerId ?? null;
      if (!customerId) {
        const created = await runtime.stripe.createCustomer({
          accountId,
          // One customer per account, however many times checkout is opened:
          // a retried call returns the customer the first one created.
          idempotencyKey: `customer:${accountId}`,
        });
        // The pointer is written first and its winner is authoritative, so a
        // second customer created by a racing request is abandoned rather
        // than allowed to capture the account's webhooks.
        const owner = await entitlements.linkStripeCustomer(
          accountId,
          created.customerId,
        );
        customerId =
          owner === accountId
            ? created.customerId
            : ((await entitlements.get(accountId))?.stripeCustomerId ??
              created.customerId);
        await entitlements.attachStripeCustomer(accountId, customerId, now);
      }
      const session = await runtime.stripe.createCheckoutSession({
        customerId,
        priceId:
          plan === "annual" && runtime.annualPriceId
            ? runtime.annualPriceId
            : runtime.priceId,
        trialDays: runtime.trialDays ?? ENTITLEMENT_TRIAL_DAYS,
        clientReferenceId: accountId,
        successUrl: `${origin}/?billing=success`,
        cancelUrl: `${origin}/?billing=cancelled`,
      });
      return {
        response: response(200, {
          schemaVersion: "billing-checkout-v1",
          url: session.url,
        }),
        observation: observation("checkout-created", { accountId }),
      };
    } catch {
      // Stripe was unreachable or refused the call. The caller learns that
      // billing is unavailable and nothing else — a provider error message
      // can quote request parameters back.
      return {
        response: response(502, { error: "billing-provider-unavailable" }),
        observation: observation("provider-error", { accountId }),
      };
    }
  };
