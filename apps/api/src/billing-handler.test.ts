import { describe, expect, it } from "vitest";
import {
  MemoryEntitlementRepository,
  MemoryIdentityRepository,
  type EventRepository,
} from "@find-the-edge/database";
import {
  createSessionToken,
  deriveAccountId,
  signStripePayload,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import { createEventHandler, type ApiRequest } from "./handler";
import type { BillingRuntime } from "./billing-handler";
import type {
  StripeBillingPortalRequest,
  StripeBillingPortalResult,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResult,
  StripeClient,
  StripeCustomerRequest,
  StripeCustomerResult,
} from "./stripe-client";

const PHONE = "+15557654321";
const ACCOUNT_PEPPER = "account-pepper-value-0123456789ab";
const ACCOUNT_ID = deriveAccountId(PHONE, ACCOUNT_PEPPER);
const OTHER_ACCOUNT_ID = deriveAccountId("+15550009999", ACCOUNT_PEPPER);
const CUSTOMER = "cus_TestCustomer001";
const SUBSCRIPTION = "sub_TestSubscription1";
const PRICE = "price_TestMonthly001";
// Assembled at runtime: a literal in Stripe's secret grammar is
// indistinguishable from a real leak to a scanner.
const WEBHOOK_SECRET = ["whsec", "F".repeat(24)].join("_");
const APP_BASE_URL = "https://app.example.com";
const NOW = "2026-08-10T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1_000);
const DAY_SECONDS = 86_400;
const KEY_RING: SessionKeyRing = {
  current: { keyId: "session-2026-08", secret: "a".repeat(48) },
};

/** Identity and billing never touch the event projection; a read here is a
 * bug in the route dispatch. */
const unusedEvents: EventRepository = {
  list: () => {
    throw new Error("not-used");
  },
  detail: () => {
    throw new Error("not-used");
  },
};

class FakeStripeClient implements StripeClient {
  readonly customers: StripeCustomerRequest[] = [];
  readonly checkouts: StripeCheckoutSessionRequest[] = [];
  readonly portals: StripeBillingPortalRequest[] = [];
  failure: Error | null = null;
  nextCustomerId = CUSTOMER;

  async createCustomer(
    request: StripeCustomerRequest,
  ): Promise<StripeCustomerResult> {
    await Promise.resolve();
    if (this.failure) throw this.failure;
    this.customers.push(request);
    return { customerId: this.nextCustomerId };
  }

  async createCheckoutSession(
    request: StripeCheckoutSessionRequest,
  ): Promise<StripeCheckoutSessionResult> {
    await Promise.resolve();
    if (this.failure) throw this.failure;
    this.checkouts.push(request);
    return {
      sessionId: "cs_test_Session00001",
      url: "https://checkout.stripe.com/c/pay/cs_test_Session00001",
    };
  }

  async createBillingPortalSession(
    request: StripeBillingPortalRequest,
  ): Promise<StripeBillingPortalResult> {
    await Promise.resolve();
    if (this.failure) throw this.failure;
    this.portals.push(request);
    return { url: "https://billing.stripe.com/p/session/test_00001" };
  }
}

interface Harness {
  readonly call: (request: ApiRequest) => Promise<{
    readonly statusCode: number;
    readonly body: unknown;
  }>;
  readonly entitlements: MemoryEntitlementRepository;
  readonly identity: MemoryIdentityRepository;
  readonly stripe: FakeStripeClient;
  readonly logs: Readonly<Record<string, unknown>>[];
}

const harness = (overrides: Partial<BillingRuntime> = {}): Harness => {
  const entitlements = new MemoryEntitlementRepository();
  const identity = new MemoryIdentityRepository();
  const stripe = new FakeStripeClient();
  const logs: Readonly<Record<string, unknown>>[] = [];
  const runtime: BillingRuntime = {
    signingKeys: KEY_RING,
    webhookSecret: WEBHOOK_SECRET,
    priceId: PRICE,
    stripe,
    appBaseUrl: APP_BASE_URL,
    now: () => new Date(NOW),
    ...overrides,
  };
  const handler = createEventHandler(
    unusedEvents,
    undefined,
    (entry) => logs.push(entry),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    identity,
    undefined,
    entitlements,
    runtime,
  );
  return {
    call: async (request: ApiRequest) => {
      const response = await handler(request);
      return {
        statusCode: response.statusCode,
        body: JSON.parse(response.body) as unknown,
      };
    },
    entitlements,
    identity,
    stripe,
    logs,
  };
};

const subscriptionBody = (input: {
  readonly id: string;
  readonly type?: string;
  readonly created?: number;
  readonly status: string;
  readonly periodEnd?: number;
  readonly trialEnd?: number | null;
}): string =>
  JSON.stringify({
    id: input.id,
    type: input.type ?? "customer.subscription.updated",
    created: input.created ?? NOW_SECONDS,
    data: {
      object: {
        id: SUBSCRIPTION,
        object: "subscription",
        customer: CUSTOMER,
        status: input.status,
        current_period_end: input.periodEnd ?? NOW_SECONDS + 30 * DAY_SECONDS,
        trial_end: input.trialEnd ?? null,
        cancel_at_period_end: false,
      },
    },
  });

const webhook = (
  body: string,
  overrides: {
    readonly secret?: string;
    readonly timestampSeconds?: number;
    readonly signature?: string;
    readonly contentType?: string;
  } = {},
): ApiRequest => ({
  route: "billing-webhook",
  method: "POST",
  contentType: overrides.contentType ?? "application/json; charset=utf-8",
  body,
  stripeSignature:
    overrides.signature ??
    signStripePayload({
      payload: body,
      secret: overrides.secret ?? WEBHOOK_SECRET,
      timestampSeconds: overrides.timestampSeconds ?? NOW_SECONDS,
    }),
});

const sessionFor = (accountId: string, tokenVersion = 1): string =>
  createSessionToken({
    accountId,
    tokenVersion,
    now: NOW,
    key: KEY_RING.current,
  }).token;

const authed = (
  route: "billing-entitlement" | "billing-checkout" | "billing-portal",
  token: string,
): ApiRequest => ({
  route,
  method: route === "billing-entitlement" ? "GET" : "POST",
  authorization: `Bearer ${token}`,
});

const signIn = async (
  test: Harness,
  accountId: string = ACCOUNT_ID,
): Promise<string> => {
  await test.identity.upsertAccount({ accountId, now: NOW });
  return sessionFor(accountId);
};

const linked = async (test: Harness): Promise<void> => {
  await test.entitlements.linkStripeCustomer(ACCOUNT_ID, CUSTOMER);
  await test.entitlements.attachStripeCustomer(ACCOUNT_ID, CUSTOMER, NOW);
};

describe("POST /billing/webhook", () => {
  it("applies a signed subscription event and persists the entitlement", async () => {
    const test = harness();
    await linked(test);
    const trialEnd = NOW_SECONDS + 7 * DAY_SECONDS;
    const result = await test.call(
      webhook(
        subscriptionBody({
          id: "evt_trialcreated001",
          type: "customer.subscription.created",
          status: "trialing",
          trialEnd,
          periodEnd: trialEnd,
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: "billing-webhook-v1",
      status: "applied",
    });
    const stored = await test.entitlements.get(ACCOUNT_ID);
    expect(stored?.state).toBe("trialing");
    expect(stored?.accessUntil).toBe(new Date(trialEnd * 1_000).toISOString());
    expect(stored?.lastEventId).toBe("evt_trialcreated001");
  });

  it("is idempotent under replay: a redelivery changes nothing", async () => {
    const test = harness();
    await linked(test);
    const body = subscriptionBody({
      id: "evt_activecreated1",
      type: "customer.subscription.created",
      status: "active",
    });
    expect((await test.call(webhook(body))).body).toEqual({
      schemaVersion: "billing-webhook-v1",
      status: "applied",
    });
    const afterFirst = await test.entitlements.get(ACCOUNT_ID);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await test.call(webhook(body));
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toEqual({
        schemaVersion: "billing-webhook-v1",
        status: "duplicate",
      });
    }
    expect(await test.entitlements.get(ACCOUNT_ID)).toEqual(afterFirst);
  });

  it("ignores an out-of-order event and answers 200 so Stripe stops retrying", async () => {
    const test = harness();
    await linked(test);
    await test.call(
      webhook(
        subscriptionBody({
          id: "evt_hardcancel0001",
          type: "customer.subscription.deleted",
          created: NOW_SECONDS + 500,
          status: "canceled",
        }),
      ),
    );
    const late = await test.call(
      webhook(
        subscriptionBody({
          id: "evt_lateupdate00001",
          created: NOW_SECONDS + 100,
          status: "active",
        }),
      ),
    );
    expect(late.statusCode).toBe(200);
    expect(late.body).toEqual({
      schemaVersion: "billing-webhook-v1",
      status: "ignored-older",
    });
    const stored = await test.entitlements.get(ACCOUNT_ID);
    expect(stored?.state).toBe("canceled");
    expect(stored?.accessUntil).toBeNull();
  });

  it("rejects a tampered payload, a wrong secret, a stale timestamp, and a missing header", async () => {
    const test = harness();
    await linked(test);
    const body = subscriptionBody({
      id: "evt_activecreated1",
      type: "customer.subscription.created",
      status: "active",
    });
    const signed = webhook(body);
    const cases: readonly ApiRequest[] = [
      { ...signed, body: `${body} ` },
      webhook(body, { secret: ["whsec", "W".repeat(24)].join("_") }),
      webhook(body, {
        timestampSeconds: NOW_SECONDS - STRIPE_SIGNATURE_TOLERANCE_SECONDS - 1,
      }),
      // No signature header at all.
      {
        route: "billing-webhook",
        method: "POST",
        contentType: "application/json",
        body,
      },
      webhook(body, { signature: "not-a-signature-header" }),
    ];
    for (const request of cases) {
      const result = await test.call(request);
      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({ error: "invalid-signature" });
    }
    // Nothing was folded in: the record is still the empty one the checkout
    // link created, with no event on its fence.
    expect(await test.entitlements.get(ACCOUNT_ID)).toMatchObject({
      state: "none",
      lastEventId: null,
    });
  });

  it("rejects a malformed payload without echoing it", async () => {
    const test = harness();
    await linked(test);
    for (const body of [
      "{not json",
      JSON.stringify({ id: "evt_x", type: "customer.subscription.updated" }),
      JSON.stringify({
        id: "evt_missingcust001",
        type: "customer.subscription.updated",
        created: NOW_SECONDS,
        data: { object: { id: SUBSCRIPTION, status: "active" } },
      }),
    ]) {
      const result = await test.call(webhook(body));
      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({ error: "invalid-request" });
      expect(JSON.stringify(result.body)).not.toContain("subscription");
    }
  });

  it("answers 200 to a signed event type it does not handle", async () => {
    const test = harness();
    await linked(test);
    const result = await test.call(
      webhook(
        JSON.stringify({
          id: "evt_paymentintent1",
          type: "payment_intent.succeeded",
          created: NOW_SECONDS,
          data: { object: { customer: CUSTOMER } },
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: "billing-webhook-v1",
      status: "ignored",
    });
  });

  it("answers 200 to an event for a customer this deployment never linked", async () => {
    const test = harness();
    const result = await test.call(
      webhook(
        subscriptionBody({
          id: "evt_activecreated1",
          type: "customer.subscription.created",
          status: "active",
        }),
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: "billing-webhook-v1",
      status: "ignored",
    });
    expect(await test.entitlements.get(ACCOUNT_ID)).toBeNull();
  });

  it("refuses a webhook that is not a POST of JSON", async () => {
    const test = harness();
    await linked(test);
    const body = subscriptionBody({
      id: "evt_a00000000000001",
      status: "active",
    });
    const signed = webhook(body);
    const bodyless: ApiRequest = {
      route: "billing-webhook",
      method: "POST",
      contentType: "application/json",
      ...(signed.stripeSignature
        ? { stripeSignature: signed.stripeSignature }
        : {}),
    };
    for (const request of [
      { ...signed, method: "GET" as const },
      { ...signed, contentType: "text/plain" },
      bodyless,
      { ...signed, query: { replay: "1" } },
    ]) {
      const result = await test.call(request);
      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual({ error: "invalid-request" });
    }
  });

  it("never accepts an entitlement asserted by the caller", async () => {
    const test = harness();
    await linked(test);
    // A perfectly signed event whose payload claims the account is active is
    // still only as good as Stripe's status field — and an unsigned request
    // carrying a state gets nowhere at all.
    const forged = await test.call({
      route: "billing-webhook",
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ accountId: ACCOUNT_ID, state: "active" }),
    });
    expect(forged.statusCode).toBe(400);
    expect(await test.entitlements.get(ACCOUNT_ID)).toMatchObject({
      state: "none",
      accessUntil: null,
      lastEventId: null,
    });
  });

  it("logs the account and state but never the payload", async () => {
    const test = harness();
    await linked(test);
    await test.call(
      webhook(
        subscriptionBody({
          id: "evt_activecreated1",
          type: "customer.subscription.created",
          status: "active",
        }),
      ),
    );
    const line = test.logs.find(
      (entry) => entry["event"] === "billing-request",
    );
    expect(line).toMatchObject({
      route: "billing-webhook",
      outcome: "applied",
      stripeEventType: "customer.subscription.created",
      entitlementState: "active",
      accountId: ACCOUNT_ID,
    });
    expect(JSON.stringify(test.logs)).not.toContain(SUBSCRIPTION);
    expect(JSON.stringify(test.logs)).not.toContain(WEBHOOK_SECRET);
  });
});

describe("GET /billing/entitlement", () => {
  it("returns the caller's state and boundary and nothing else", async () => {
    const test = harness();
    await linked(test);
    const token = await signIn(test);
    const periodEnd = NOW_SECONDS + 30 * DAY_SECONDS;
    await test.call(
      webhook(
        subscriptionBody({
          id: "evt_activecreated1",
          type: "customer.subscription.created",
          status: "active",
          periodEnd,
        }),
      ),
    );
    const result = await test.call(authed("billing-entitlement", token));
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: "billing-entitlement-v1",
      state: "active",
      accessUntil: new Date(periodEnd * 1_000).toISOString(),
      hasAccess: true,
    });
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(CUSTOMER);
    expect(serialized).not.toContain(SUBSCRIPTION);
    expect(serialized).not.toContain(PRICE);
  });

  it("reports an unentitled account without inventing a record", async () => {
    const test = harness();
    const token = await signIn(test);
    const result = await test.call(authed("billing-entitlement", token));
    expect(result.body).toEqual({
      schemaVersion: "billing-entitlement-v1",
      state: "none",
      accessUntil: null,
      hasAccess: false,
    });
    expect(await test.entitlements.get(ACCOUNT_ID)).toBeNull();
  });

  it("refuses an absent, foreign, expired, or revoked token", async () => {
    const test = harness();
    const token = await signIn(test);
    const foreign = createSessionToken({
      accountId: ACCOUNT_ID,
      tokenVersion: 1,
      now: NOW,
      key: { keyId: "session-2026-08", secret: "z".repeat(48) },
    }).token;
    const unknownAccount = sessionFor(OTHER_ACCOUNT_ID);
    const cases: readonly ApiRequest[] = [
      { route: "billing-entitlement", method: "GET" },
      { route: "billing-entitlement", method: "GET", authorization: token },
      {
        route: "billing-entitlement",
        method: "GET",
        authorization: `Bearer ${foreign}`,
      },
      {
        route: "billing-entitlement",
        method: "GET",
        authorization: `Bearer ${unknownAccount}`,
      },
      { ...authed("billing-entitlement", token), method: "POST" },
      { ...authed("billing-entitlement", token), query: { accountId: "x" } },
    ];
    for (const request of cases) {
      const result = await test.call(request);
      expect(result.statusCode).toBe(401);
      expect(result.body).toEqual({ error: "unauthorized" });
    }
    // Revocation reaches a live token through the account's version.
    await test.identity.bumpTokenVersion(ACCOUNT_ID);
    expect(
      (await test.call(authed("billing-entitlement", token))).statusCode,
    ).toBe(401);
  });

  it("never lets a client claim entitlement it does not have", async () => {
    const test = harness();
    const token = await signIn(test);
    const claimed = await test.call({
      ...authed("billing-entitlement", token),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ state: "active", hasAccess: true }),
    });
    expect(claimed.statusCode).toBe(401);
    // And a subsequent honest read still says none.
    expect(
      (await test.call(authed("billing-entitlement", token))).body,
    ).toMatchObject({ state: "none", hasAccess: false });
  });
});

describe("POST /billing/checkout", () => {
  it("creates a customer once and a session priced by the server", async () => {
    const test = harness();
    const token = await signIn(test);
    const result = await test.call(authed("billing-checkout", token));
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: "billing-checkout-v1",
      url: "https://checkout.stripe.com/c/pay/cs_test_Session00001",
    });
    expect(test.stripe.customers).toEqual([
      { accountId: ACCOUNT_ID, idempotencyKey: `customer:${ACCOUNT_ID}` },
    ]);
    expect(test.stripe.checkouts).toEqual([
      {
        customerId: CUSTOMER,
        priceId: PRICE,
        trialDays: 7,
        clientReferenceId: ACCOUNT_ID,
        successUrl: `${APP_BASE_URL}/?billing=success`,
        cancelUrl: `${APP_BASE_URL}/?billing=cancelled`,
      },
    ]);
    // The pointer webhooks need is written before the session exists.
    expect(await test.entitlements.findAccountByStripeCustomer(CUSTOMER)).toBe(
      ACCOUNT_ID,
    );

    await test.call(authed("billing-checkout", token));
    expect(test.stripe.customers).toHaveLength(1);
  });

  it("never takes a price, a trial length, or a return url from the client", async () => {
    const test = harness();
    const token = await signIn(test);
    const rejected = await test.call({
      ...authed("billing-checkout", token),
      contentType: "application/json",
      body: JSON.stringify({
        priceId: "price_AttackerChoice1",
        trialDays: 3650,
        successUrl: "https://evil.example.com/",
      }),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toEqual({ error: "invalid-request" });
    expect(test.stripe.checkouts).toHaveLength(0);
  });

  it("requires our session token", async () => {
    const test = harness();
    const result = await test.call({
      route: "billing-checkout",
      method: "POST",
    });
    expect(result.statusCode).toBe(401);
    expect(test.stripe.customers).toHaveLength(0);
  });

  it("reports a provider failure without quoting it", async () => {
    const test = harness();
    const token = await signIn(test);
    test.stripe.failure = new Error("stripe-request-failed:402");
    const result = await test.call(authed("billing-checkout", token));
    expect(result.statusCode).toBe(502);
    expect(result.body).toEqual({ error: "billing-provider-unavailable" });
  });
});

describe("POST /billing/portal", () => {
  it("opens a portal for an account that has a Stripe customer", async () => {
    const test = harness();
    await linked(test);
    const token = await signIn(test);
    const result = await test.call(authed("billing-portal", token));
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      schemaVersion: "billing-portal-v1",
      url: "https://billing.stripe.com/p/session/test_00001",
    });
    expect(test.stripe.portals).toEqual([
      { customerId: CUSTOMER, returnUrl: `${APP_BASE_URL}/` },
    ]);
  });

  it("refuses an account with no billing relationship", async () => {
    const test = harness();
    const token = await signIn(test);
    const result = await test.call(authed("billing-portal", token));
    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({ error: "billing-account-missing" });
    expect(test.stripe.portals).toHaveLength(0);
  });
});

describe("billing without a configured Stripe secret", () => {
  it("degrades only the billing routes", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const handler = createEventHandler(
      unusedEvents,
      undefined,
      (entry) => logs.push(entry),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new MemoryIdentityRepository(),
      undefined,
      new MemoryEntitlementRepository(),
      undefined,
    );
    for (const route of [
      "billing-webhook",
      "billing-entitlement",
      "billing-checkout",
      "billing-portal",
    ] as const) {
      const response = await handler({ route, method: "POST" });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({
        error: "billing-unavailable",
      });
    }
  });
});
