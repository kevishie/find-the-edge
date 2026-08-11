import { isStripeCustomerId, isStripePriceId } from "@find-the-edge/domain";

export interface StripeCustomerRequest {
  /** Stored on the Stripe customer as metadata so a support conversation can
   * go from a Stripe dashboard row back to an account without a lookup
   * table. It is a peppered digest, not a phone number. */
  readonly accountId: string;
  readonly idempotencyKey?: string;
}

export interface StripeCustomerResult {
  readonly customerId: string;
}

export interface StripeCheckoutSessionRequest {
  readonly customerId: string;
  /** Always the server's price. There is no code path that reads one from a
   * request body. */
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly trialDays: number;
  readonly clientReferenceId: string;
  readonly idempotencyKey?: string;
}

export interface StripeCheckoutSessionResult {
  readonly sessionId: string;
  readonly url: string;
}

export interface StripeBillingPortalRequest {
  readonly customerId: string;
  readonly returnUrl: string;
}

export interface StripeBillingPortalResult {
  readonly url: string;
}

/**
 * The whole of this product's outbound Stripe surface. Everything else
 * Stripe knows arrives inbound, over the signed webhook.
 *
 * It is an interface so the handler never holds a network client: tests use a
 * fake, and the one real implementation is built in the lambda composition
 * root from a secret.
 */
export interface StripeClient {
  createCustomer(request: StripeCustomerRequest): Promise<StripeCustomerResult>;
  createCheckoutSession(
    request: StripeCheckoutSessionRequest,
  ): Promise<StripeCheckoutSessionResult>;
  createBillingPortalSession(
    request: StripeBillingPortalRequest,
  ): Promise<StripeBillingPortalResult>;
}

export interface StripeRestClientConfig {
  readonly secretKey: string;
  /**
   * Pin only when a payload shape has to be frozen for a migration. Left
   * unset, Stripe uses the account's default version, and the webhook
   * normalizer already reads both the old and the new spellings of the
   * fields this product depends on.
   */
  readonly apiVersion?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected in tests; production uses the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export const STRIPE_API_BASE_URL = "https://api.stripe.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s]*)?$/;

const assertHttpsUrl = (value: string): string => {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !HTTPS_URL.test(value)
  )
    throw new Error("stripe-url-invalid");
  return value;
};

/**
 * Stripe's REST API takes form-encoded bodies with bracketed keys. It is a
 * dozen lines to write and needs no dependency, which is why this file
 * exists instead of the SDK.
 */
const formBody = (fields: Readonly<Record<string, string>>): string =>
  Object.entries(fields)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");

const readString = (
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("stripe-response-invalid");
  return value;
};

export function createStripeRestClient(
  config: StripeRestClientConfig,
): StripeClient {
  if (
    typeof config.secretKey !== "string" ||
    config.secretKey.length < 16 ||
    config.secretKey.length > 512
  )
    throw new Error("stripe-secret-key-invalid");
  const baseUrl = config.baseUrl ?? STRIPE_API_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const send = config.fetch ?? globalThis.fetch;

  const call = async (
    path: string,
    fields: Readonly<Record<string, string>>,
    idempotencyKey?: string,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const response = await send(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        // The key never leaves this header: it is not logged, not echoed in
        // an error, and not carried into any response this service returns.
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(config.apiVersion ? { "stripe-version": config.apiVersion } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: formBody(fields),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      // The status is the whole diagnostic. Stripe's error body can quote
      // request parameters back, and this error travels into logs.
      throw new Error(`stripe-request-failed:${response.status}`);
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("stripe-response-invalid");
    return parsed as Readonly<Record<string, unknown>>;
  };

  return Object.freeze({
    async createCustomer(
      request: StripeCustomerRequest,
    ): Promise<StripeCustomerResult> {
      const payload = await call(
        "/v1/customers",
        { "metadata[accountId]": request.accountId },
        request.idempotencyKey,
      );
      const customerId = readString(payload, "id");
      if (!isStripeCustomerId(customerId))
        throw new Error("stripe-response-invalid");
      return { customerId };
    },

    async createCheckoutSession(
      request: StripeCheckoutSessionRequest,
    ): Promise<StripeCheckoutSessionResult> {
      if (!isStripeCustomerId(request.customerId))
        throw new Error("stripe-customer-id-invalid");
      if (!isStripePriceId(request.priceId))
        throw new Error("stripe-price-id-invalid");
      if (
        !Number.isSafeInteger(request.trialDays) ||
        request.trialDays < 0 ||
        request.trialDays > 365
      )
        throw new Error("stripe-trial-days-invalid");
      const payload = await call(
        "/v1/checkout/sessions",
        {
          mode: "subscription",
          customer: request.customerId,
          "line_items[0][price]": request.priceId,
          "line_items[0][quantity]": "1",
          ...(request.trialDays > 0
            ? {
                "subscription_data[trial_period_days]": String(
                  request.trialDays,
                ),
              }
            : {}),
          client_reference_id: request.clientReferenceId,
          success_url: assertHttpsUrl(request.successUrl),
          cancel_url: assertHttpsUrl(request.cancelUrl),
        },
        request.idempotencyKey,
      );
      return {
        sessionId: readString(payload, "id"),
        url: assertHttpsUrl(readString(payload, "url")),
      };
    },

    async createBillingPortalSession(
      request: StripeBillingPortalRequest,
    ): Promise<StripeBillingPortalResult> {
      if (!isStripeCustomerId(request.customerId))
        throw new Error("stripe-customer-id-invalid");
      const payload = await call("/v1/billing_portal/sessions", {
        customer: request.customerId,
        return_url: assertHttpsUrl(request.returnUrl),
      });
      return { url: assertHttpsUrl(readString(payload, "url")) };
    },
  });
}
