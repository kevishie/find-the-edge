import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  SESSION_SIGNING_KEY_MIN_LENGTH,
  type SessionKeyRing,
} from "@find-the-edge/domain";

export interface IdentitySecrets {
  readonly signingKeys: SessionKeyRing;
  /** Mixed into every OTP code hash. Rotatable: only live challenges break. */
  readonly otpPepper: string;
  /** Behind every account id. Permanent: rotating it renames every account. */
  readonly accountPepper: string;
}

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const exact = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

const secret = (value: unknown, minimum: number): string => {
  if (typeof value !== "string" || value.length < minimum || value.length > 512)
    throw new Error("invalid-identity-secret");
  return value;
};

const keyId = (value: unknown): string => {
  if (typeof value !== "string" || !KEY_ID.test(value))
    throw new Error("invalid-identity-secret");
  return value;
};

/**
 * Rotation shape mirrors the cursor secret ring: a current key that signs,
 * and an optional previous key that still verifies while old tokens age out.
 * A malformed secret is refused outright — a service that cannot verify its
 * own tokens must fail loudly, not fall back to something weaker.
 */
export const parseIdentitySecrets = (raw: string): IdentitySecrets => {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid-identity-secret");
  const item = parsed as Readonly<Record<string, unknown>>;
  const hasPrevious = ["previousKeyId", "previousSecret"].some(
    (key) => key in item,
  );
  if (
    !exact(item, [
      "currentKeyId",
      "currentSecret",
      "otpPepper",
      "accountPepper",
      ...(hasPrevious ? ["previousKeyId", "previousSecret"] : []),
    ])
  )
    throw new Error("invalid-identity-secret");
  const current = {
    keyId: keyId(item["currentKeyId"]),
    secret: secret(item["currentSecret"], SESSION_SIGNING_KEY_MIN_LENGTH),
  };
  const previous = hasPrevious
    ? {
        keyId: keyId(item["previousKeyId"]),
        secret: secret(item["previousSecret"], SESSION_SIGNING_KEY_MIN_LENGTH),
      }
    : undefined;
  if (previous && previous.keyId === current.keyId)
    throw new Error("invalid-identity-secret");
  return {
    signingKeys: previous ? { current, previous } : { current },
    otpPepper: secret(item["otpPepper"], 32),
    accountPepper: secret(item["accountPepper"], 32),
  };
};

const cache = new Map<
  string,
  { readonly value: IdentitySecrets; readonly expiresAt: number }
>();

/** Cached in process for a minute: a secret read on every sign-in would add
 * a round trip to the slowest path in the product. */
export const loadIdentitySecrets = async (
  client: SecretsManagerClient,
  secretId: string,
  ttlMs = 60_000,
): Promise<IdentitySecrets> => {
  const cached = cache.get(secretId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const output = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!output.SecretString) throw new Error("missing-identity-secret");
  const value = parseIdentitySecrets(output.SecretString);
  cache.set(secretId, { value, expiresAt: Date.now() + ttlMs });
  return value;
};

/** Test hook: the module-scope cache otherwise bleeds between cases. */
export const clearIdentitySecretsCache = (): void => cache.clear();
