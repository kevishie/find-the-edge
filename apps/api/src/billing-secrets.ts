import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  isStripePriceId,
  STRIPE_WEBHOOK_SECRET_MIN_LENGTH,
} from "@find-the-edge/domain";

/**
 * Everything the billing routes need from Secrets Manager, and nothing else.
 * The price id lives here rather than in code or in a request body: it is the
 * single server-side answer to "what is this account being charged", so a
 * client can never name a different one.
 */
export interface BillingSecrets {
  /** Stripe's `sk_` or restricted `rk_` key. Outbound calls only. */
  readonly secretKey: string;
  /** The endpoint's `whsec_` signing secret. Inbound webhooks only. */
  readonly webhookSecret: string;
  readonly priceId: string;
}

const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,247}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9_-]{16,247}$/;

const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

/**
 * A malformed billing secret is refused outright. A service that cannot
 * verify a webhook signature must fail loudly rather than fall back to
 * accepting unsigned events.
 */
export const parseBillingSecrets = (raw: string): BillingSecrets => {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid-billing-secret");
  const item = parsed as Readonly<Record<string, unknown>>;
  if (!exact(item, ["secretKey", "webhookSecret", "priceId"]))
    throw new Error("invalid-billing-secret");
  const secretKey = item["secretKey"];
  const webhookSecret = item["webhookSecret"];
  const priceId = item["priceId"];
  if (
    typeof secretKey !== "string" ||
    !SECRET_KEY.test(secretKey) ||
    typeof webhookSecret !== "string" ||
    webhookSecret.length < STRIPE_WEBHOOK_SECRET_MIN_LENGTH ||
    !WEBHOOK_SECRET.test(webhookSecret) ||
    !isStripePriceId(priceId)
  )
    throw new Error("invalid-billing-secret");
  return Object.freeze({ secretKey, webhookSecret, priceId });
};

const cache = new Map<
  string,
  { readonly value: BillingSecrets; readonly expiresAt: number }
>();

/** Cached in process for a minute, like the identity ring: a secret read on
 * every webhook would add a round trip to a path Stripe retries. */
export const loadBillingSecrets = async (
  client: SecretsManagerClient,
  secretId: string,
  ttlMs = 60_000,
): Promise<BillingSecrets> => {
  const cached = cache.get(secretId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const output = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!output.SecretString) throw new Error("missing-billing-secret");
  const value = parseBillingSecrets(output.SecretString);
  cache.set(secretId, { value, expiresAt: Date.now() + ttlMs });
  return value;
};

/** Test hook: the module-scope cache otherwise bleeds between cases. */
export const clearBillingSecretsCache = (): void => cache.clear();
