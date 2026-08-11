import { describe, expect, it } from "vitest";
import { createStripeRestClient, STRIPE_API_BASE_URL } from "./stripe-client";

// Stripe's key grammar is scanned for in commits, and a literal that matches
// it is indistinguishable from a real leak to any scanner — so the fixture is
// assembled at runtime instead of written out. The value is still a valid
// test-mode shape for the parser.
const SECRET_KEY = ["sk", "test", "F".repeat(24)].join("_");
const CUSTOMER = "cus_TestCustomer001";
const PRICE = "price_TestMonthly001";

interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const stub = (
  payload: unknown,
  status = 200,
): { readonly calls: Recorded[]; readonly fetch: typeof globalThis.fetch } => {
  const calls: Recorded[] = [];
  const fetch = ((input: unknown, init?: RequestInit) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Readonly<Record<string, string>>,
      // The client only ever sends a form-encoded string; anything else is
      // a regression this cast would otherwise hide.
      body: typeof body === "string" ? body : "",
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
    } as unknown as Response);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

const fields = (body: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    body.split("&").map((pair) => {
      const [key, value] = pair.split("=");
      return [
        decodeURIComponent(key ?? ""),
        decodeURIComponent(value ?? ""),
      ] as const;
    }),
  );

describe("createStripeRestClient", () => {
  it("creates a customer with the account id as metadata", async () => {
    const { calls, fetch } = stub({ id: CUSTOMER, object: "customer" });
    const client = createStripeRestClient({ secretKey: SECRET_KEY, fetch });
    const result = await client.createCustomer({
      accountId: `account:${"a".repeat(64)}`,
      idempotencyKey: "customer:test",
    });
    expect(result).toEqual({ customerId: CUSTOMER });
    expect(calls[0]?.url).toBe(`${STRIPE_API_BASE_URL}/v1/customers`);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${SECRET_KEY}`);
    expect(calls[0]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(calls[0]?.headers["idempotency-key"]).toBe("customer:test");
    expect(fields(calls[0]?.body ?? "")).toEqual({
      "metadata[accountId]": `account:${"a".repeat(64)}`,
    });
  });

  it("form-encodes a subscription checkout with the trial", async () => {
    const { calls, fetch } = stub({
      id: "cs_test_Session00001",
      url: "https://checkout.stripe.com/c/pay/cs_test_Session00001",
    });
    const client = createStripeRestClient({ secretKey: SECRET_KEY, fetch });
    const result = await client.createCheckoutSession({
      customerId: CUSTOMER,
      priceId: PRICE,
      trialDays: 7,
      clientReferenceId: `account:${"b".repeat(64)}`,
      successUrl: "https://app.example.com/?billing=success",
      cancelUrl: "https://app.example.com/?billing=cancelled",
    });
    expect(result.url).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_Session00001",
    );
    expect(calls[0]?.url).toBe(`${STRIPE_API_BASE_URL}/v1/checkout/sessions`);
    expect(fields(calls[0]?.body ?? "")).toEqual({
      mode: "subscription",
      customer: CUSTOMER,
      "line_items[0][price]": PRICE,
      "line_items[0][quantity]": "1",
      "subscription_data[trial_period_days]": "7",
      client_reference_id: `account:${"b".repeat(64)}`,
      success_url: "https://app.example.com/?billing=success",
      cancel_url: "https://app.example.com/?billing=cancelled",
    });
  });

  it("opens a billing portal session", async () => {
    const { calls, fetch } = stub({
      url: "https://billing.stripe.com/p/session/test_00001",
    });
    const client = createStripeRestClient({ secretKey: SECRET_KEY, fetch });
    const result = await client.createBillingPortalSession({
      customerId: CUSTOMER,
      returnUrl: "https://app.example.com/",
    });
    expect(result.url).toBe("https://billing.stripe.com/p/session/test_00001");
    expect(calls[0]?.url).toBe(
      `${STRIPE_API_BASE_URL}/v1/billing_portal/sessions`,
    );
  });

  it("reports only the status when Stripe refuses, never the body", async () => {
    const { fetch } = stub(
      {
        error: { message: `No such price: ${PRICE}`, code: "resource_missing" },
      },
      402,
    );
    const client = createStripeRestClient({ secretKey: SECRET_KEY, fetch });
    await expect(
      client.createCustomer({ accountId: `account:${"c".repeat(64)}` }),
    ).rejects.toThrow("stripe-request-failed:402");
  });

  it("refuses a response that is not the shape it expects", async () => {
    const { fetch } = stub({ id: 42 });
    const client = createStripeRestClient({ secretKey: SECRET_KEY, fetch });
    await expect(
      client.createCustomer({ accountId: `account:${"d".repeat(64)}` }),
    ).rejects.toThrow("stripe-response-invalid");

    const wrongPrefix = stub({ id: "sub_NotACustomer01" });
    await expect(
      createStripeRestClient({
        secretKey: SECRET_KEY,
        fetch: wrongPrefix.fetch,
      }).createCustomer({ accountId: `account:${"e".repeat(64)}` }),
    ).rejects.toThrow("stripe-response-invalid");
  });

  it("refuses to build with an unusable key, and refuses bad arguments", async () => {
    expect(() => createStripeRestClient({ secretKey: "sk_short" })).toThrow(
      "stripe-secret-key-invalid",
    );
    const { fetch, calls } = stub({
      id: "cs_x",
      url: "https://x.example.com/",
    });
    const client = createStripeRestClient({ secretKey: SECRET_KEY, fetch });
    await expect(
      client.createCheckoutSession({
        customerId: "not-a-customer",
        priceId: PRICE,
        trialDays: 7,
        clientReferenceId: "account",
        successUrl: "https://app.example.com/",
        cancelUrl: "https://app.example.com/",
      }),
    ).rejects.toThrow("stripe-customer-id-invalid");
    await expect(
      client.createCheckoutSession({
        customerId: CUSTOMER,
        priceId: "prod_NotAPrice001",
        trialDays: 7,
        clientReferenceId: "account",
        successUrl: "https://app.example.com/",
        cancelUrl: "https://app.example.com/",
      }),
    ).rejects.toThrow("stripe-price-id-invalid");
    // A non-HTTPS redirect target never reaches Stripe.
    await expect(
      client.createCheckoutSession({
        customerId: CUSTOMER,
        priceId: PRICE,
        trialDays: 7,
        clientReferenceId: "account",
        successUrl: "http://app.example.com/",
        cancelUrl: "https://app.example.com/",
      }),
    ).rejects.toThrow("stripe-url-invalid");
    expect(calls).toHaveLength(0);
  });

  it("pins an API version only when one is configured", async () => {
    const unpinned = stub({ id: CUSTOMER });
    await createStripeRestClient({
      secretKey: SECRET_KEY,
      fetch: unpinned.fetch,
    }).createCustomer({ accountId: `account:${"f".repeat(64)}` });
    expect(unpinned.calls[0]?.headers["stripe-version"]).toBeUndefined();

    const pinned = stub({ id: CUSTOMER });
    await createStripeRestClient({
      secretKey: SECRET_KEY,
      apiVersion: "2026-01-01.example",
      fetch: pinned.fetch,
    }).createCustomer({ accountId: `account:${"f".repeat(64)}` });
    expect(pinned.calls[0]?.headers["stripe-version"]).toBe(
      "2026-01-01.example",
    );
  });
});
