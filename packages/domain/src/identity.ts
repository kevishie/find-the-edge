import { sha256BytesHex, sha256Hex } from "./fixture-odds.js";

export const IDENTITY_ACCOUNT_SCHEMA_VERSION = "identity-account-v1" as const;
export const OTP_CHALLENGE_SCHEMA_VERSION = "otp-challenge-v1" as const;
export const SESSION_TOKEN_SCHEMA_VERSION = "fte-session-v1" as const;

/** Token grammar marker; it is signed, so a v1 token can never be replayed
 * against a future format that reads the same segments differently. */
const SESSION_TOKEN_PREFIX = "fte1";

/** Codes are six digits: short enough to type from a lock screen, and only
 * safe because the challenge expires, is single use, and locks out. */
export const OTP_CODE_LENGTH = 6;
export const OTP_CHALLENGE_TTL_MS = 5 * 60_000;
/** After five wrong codes the challenge is dead; a sixth guess can never
 * succeed even with the right code. 10^6 / 5 guesses is the brute-force
 * bound per challenge, and the request rate limit bounds the challenges. */
export const OTP_MAX_ATTEMPTS = 5;
/** A repeat request inside this window returns the live challenge instead of
 * sending a second message, so a double-tapped button costs one SMS. */
export const OTP_RESEND_WINDOW_MS = 30_000;
/** Sessions are short because the browser keeps the token in localStorage
 * (FTE-071); the refresh path trades a short lifetime for continuity. */
export const SESSION_TOKEN_TTL_MS = 60 * 60_000;
export const SESSION_TOKEN_MAX_LENGTH = 1024;
/** Signing keys are raw secrets, not passwords: anything shorter than 32
 * characters is rejected rather than stretched. */
export const SESSION_SIGNING_KEY_MIN_LENGTH = 32;

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/** Per-number and per-source-IP budgets. The number budget bounds SMS cost
 * and message spam at one person; the IP budget bounds an attacker walking a
 * block of numbers from one host. */
export const OTP_REQUEST_PHONE_RATE_LIMIT: RateLimitPolicy = Object.freeze({
  limit: 5,
  windowMs: 15 * 60_000,
});
export const OTP_REQUEST_IP_RATE_LIMIT: RateLimitPolicy = Object.freeze({
  limit: 20,
  windowMs: 60 * 60_000,
});
export const OTP_VERIFY_PHONE_RATE_LIMIT: RateLimitPolicy = Object.freeze({
  limit: 10,
  windowMs: 15 * 60_000,
});
export const OTP_VERIFY_IP_RATE_LIMIT: RateLimitPolicy = Object.freeze({
  limit: 60,
  windowMs: 60 * 60_000,
});

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_32 = /^[a-f0-9]{32}$/;
const OTP_CODE = /^[0-9]{6}$/;
const ACCOUNT_ID = /^account:[a-f0-9]{64}$/;
/**
 * E.164 and nothing else: a leading `+`, a non-zero country digit, and eight
 * to fifteen digits in total. The phone number is the account key, so a
 * lenient parser would let two spellings of one number become two accounts —
 * or worse, let one person's code reach another person's handset. Formatting
 * is the client's job; the service only accepts the canonical form.
 */
const E164 = /^\+[1-9][0-9]{7,14}$/;

const instant = (value: unknown, code: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(code);
  return value;
};

export const isE164PhoneNumber = (value: unknown): value is string =>
  typeof value === "string" && E164.test(value);

/** Surrounding whitespace is a paste artefact and is dropped; every other
 * deviation — spaces, dashes, parentheses, leading zeroes, a missing `+` —
 * is rejected rather than repaired. */
export function normalizePhoneNumber(input: unknown): string {
  if (typeof input !== "string" || input.length > 32)
    throw new Error("identity-phone-invalid");
  const trimmed = input.trim();
  if (!isE164PhoneNumber(trimmed)) throw new Error("identity-phone-invalid");
  return trimmed;
}

/** Last two digits only, for a support conversation. Never a full number,
 * and never enough to identify anybody on its own. */
export const phoneSuffixHint = (phone: string): string =>
  `**${normalizePhoneNumber(phone).slice(-2)}`;

/**
 * A stable, non-reversible handle for one phone number, for log correlation.
 * The pepper is what makes it non-reversible: without it the ten-digit
 * search space is exhausted in seconds.
 */
export const phoneDigest = (phone: string, pepper: string): string =>
  sha256Hex(
    `fte:identity-phone-digest:v1|${assertPepper(pepper)}|${normalizePhoneNumber(phone)}`,
  ).slice(0, 32);

const assertPepper = (pepper: unknown): string => {
  if (typeof pepper !== "string" || pepper.length < 16)
    throw new Error("identity-pepper-invalid");
  return pepper;
};

/**
 * The account id is derived from the phone number, so sign-in needs no
 * lookup table from number to account and the durable account row stores no
 * phone number at all. It is peppered because a bare digest of a ten-digit
 * number is reversible by exhaustion; this pepper is therefore permanent —
 * rotating it renames every account. Rotate the session signing key and the
 * OTP pepper instead.
 */
export const deriveAccountId = (phone: string, pepper: string): string =>
  `account:${sha256Hex(
    `fte:identity-account:v1|${assertPepper(pepper)}|${normalizePhoneNumber(phone)}`,
  )}`;

export const isAccountId = (value: unknown): value is string =>
  typeof value === "string" && ACCOUNT_ID.test(value);

/**
 * The durable half of an identity: no phone number, no code, no message
 * history. `tokenVersion` is the revocation fence — bumping it invalidates
 * every token already issued for the account.
 */
export interface IdentityAccount {
  readonly schemaVersion: typeof IDENTITY_ACCOUNT_SCHEMA_VERSION;
  readonly accountId: string;
  readonly tokenVersion: number;
  readonly createdAt: string;
  readonly lastSignedInAt: string;
}

export interface IdentityAccountInput {
  readonly accountId: string;
  readonly createdAt: string;
  readonly lastSignedInAt?: string;
  readonly tokenVersion?: number;
}

export function createIdentityAccount(
  input: IdentityAccountInput,
): IdentityAccount {
  if (!isAccountId(input.accountId))
    throw new Error("identity-account-id-invalid");
  const tokenVersion = input.tokenVersion ?? 1;
  if (
    !Number.isSafeInteger(tokenVersion) ||
    tokenVersion < 1 ||
    tokenVersion > 1_000_000_000
  )
    throw new Error("identity-token-version-invalid");
  const createdAt = instant(input.createdAt, "identity-created-at-invalid");
  const lastSignedInAt = instant(
    input.lastSignedInAt ?? input.createdAt,
    "identity-last-signed-in-invalid",
  );
  if (Date.parse(lastSignedInAt) < Date.parse(createdAt))
    throw new Error("identity-last-signed-in-invalid");
  return Object.freeze({
    schemaVersion: IDENTITY_ACCOUNT_SCHEMA_VERSION,
    accountId: input.accountId,
    tokenVersion,
    createdAt,
    lastSignedInAt,
  });
}

/** Stored accounts are re-derived, never trusted. */
export function normalizeIdentityAccount(stored: unknown): IdentityAccount {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    (stored as { schemaVersion?: unknown }).schemaVersion !==
      IDENTITY_ACCOUNT_SCHEMA_VERSION
  )
    throw new Error("stored-identity-account-invalid");
  const value = stored as Partial<IdentityAccount>;
  try {
    return createIdentityAccount({
      accountId: value.accountId ?? "",
      createdAt: value.createdAt ?? "",
      ...(value.lastSignedInAt === undefined
        ? {}
        : { lastSignedInAt: value.lastSignedInAt }),
      ...(value.tokenVersion === undefined
        ? {}
        : { tokenVersion: value.tokenVersion }),
    });
  } catch {
    throw new Error("stored-identity-account-invalid");
  }
}

/**
 * The transient half: one live challenge per number. It carries the hash of
 * the code and never the code, so a dump of this table cannot be replayed
 * into a sign-in. `salt` is per challenge and public; the pepper is server
 * side and is not stored with the row, so an attacker needs both the table
 * and the runtime secret before a 10^6 dictionary is even worth building.
 */
export interface OtpChallenge {
  readonly schemaVersion: typeof OTP_CHALLENGE_SCHEMA_VERSION;
  readonly challengeId: string;
  readonly phone: string;
  readonly salt: string;
  readonly codeHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly attemptCount: number;
  readonly consumedAt: string | null;
}

export interface OtpChallengeInput {
  readonly phone: string;
  /** Six digits. Hashed immediately; never stored and never returned. */
  readonly code: string;
  /** 32 hex characters of fresh randomness from the caller. */
  readonly salt: string;
  readonly pepper: string;
  readonly now: string;
  readonly ttlMs?: number;
}

export const isOtpCode = (value: unknown): value is string =>
  typeof value === "string" && OTP_CODE.test(value);

const challengeIdOf = (phone: string, issuedAt: string, salt: string): string =>
  `otp:${sha256Hex(
    JSON.stringify(["fte:otp-challenge-id:v1", phone, issuedAt, salt]),
  )}`;

/**
 * The stored verifier. The challenge id and the salt both enter the digest,
 * so the same code issued twice — to the same number, even in the same
 * millisecond — produces different hashes, and a hash is meaningless outside
 * the challenge it belongs to.
 */
export const otpCodeHash = (input: {
  readonly pepper: string;
  readonly challengeId: string;
  readonly salt: string;
  readonly phone: string;
  readonly code: string;
}): string =>
  sha256Hex(
    JSON.stringify([
      "fte:otp-code:v1",
      assertPepper(input.pepper),
      input.challengeId,
      input.salt,
      input.phone,
      input.code,
    ]),
  );

export function createOtpChallenge(input: OtpChallengeInput): OtpChallenge {
  const phone = normalizePhoneNumber(input.phone);
  if (!isOtpCode(input.code)) throw new Error("identity-otp-code-invalid");
  if (typeof input.salt !== "string" || !HEX_32.test(input.salt))
    throw new Error("identity-otp-salt-invalid");
  const pepper = assertPepper(input.pepper);
  const issuedAt = instant(input.now, "identity-otp-issued-at-invalid");
  const ttlMs = input.ttlMs ?? OTP_CHALLENGE_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 30_000 ||
    ttlMs > OTP_CHALLENGE_TTL_MS
  )
    throw new Error("identity-otp-ttl-invalid");
  const challengeId = challengeIdOf(phone, issuedAt, input.salt);
  return Object.freeze({
    schemaVersion: OTP_CHALLENGE_SCHEMA_VERSION,
    challengeId,
    phone,
    salt: input.salt,
    codeHash: otpCodeHash({
      pepper,
      challengeId,
      salt: input.salt,
      phone,
      code: input.code,
    }),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    attemptCount: 0,
    consumedAt: null,
  });
}

/**
 * Stored challenges are re-derived, never trusted: the challenge id must
 * still follow from the number, the issue time, and the salt, so a row whose
 * identity was edited in storage is rejected rather than verified against.
 */
export function normalizeOtpChallenge(stored: unknown): OtpChallenge {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    (stored as { schemaVersion?: unknown }).schemaVersion !==
      OTP_CHALLENGE_SCHEMA_VERSION
  )
    throw new Error("stored-otp-challenge-invalid");
  const value = stored as Partial<OtpChallenge>;
  try {
    const phone = normalizePhoneNumber(value.phone);
    const salt = value.salt ?? "";
    if (!HEX_32.test(salt)) throw new Error("stored-otp-challenge-invalid");
    const issuedAt = instant(value.issuedAt, "stored-otp-challenge-invalid");
    const expiresAt = instant(value.expiresAt, "stored-otp-challenge-invalid");
    const ttlMs = Date.parse(expiresAt) - Date.parse(issuedAt);
    const attemptCount = value.attemptCount ?? 0;
    const consumedAt = value.consumedAt ?? null;
    if (
      typeof value.codeHash !== "string" ||
      !HEX_64.test(value.codeHash) ||
      value.challengeId !== challengeIdOf(phone, issuedAt, salt) ||
      ttlMs <= 0 ||
      ttlMs > OTP_CHALLENGE_TTL_MS ||
      !Number.isSafeInteger(attemptCount) ||
      attemptCount < 0 ||
      attemptCount > 1_000 ||
      (consumedAt !== null &&
        instant(consumedAt, "stored-otp-challenge-invalid") !== consumedAt)
    )
      throw new Error("stored-otp-challenge-invalid");
    return Object.freeze({
      schemaVersion: OTP_CHALLENGE_SCHEMA_VERSION,
      challengeId: value.challengeId,
      phone,
      salt,
      codeHash: value.codeHash,
      issuedAt,
      expiresAt,
      attemptCount,
      consumedAt,
    });
  } catch {
    throw new Error("stored-otp-challenge-invalid");
  }
}

export type OtpVerificationOutcome =
  "verified" | "expired" | "consumed" | "mismatch" | "locked";

export type OtpVerificationResult =
  | {
      readonly outcome: "verified";
      /** The same challenge with `consumedAt` set; the caller still has to
       * win the single-use conditional write in storage. */
      readonly challenge: OtpChallenge;
    }
  | { readonly outcome: Exclude<OtpVerificationOutcome, "verified"> };

/**
 * Length-safe constant-time comparison. It reads every position of the
 * longer string and folds the length difference into the same accumulator,
 * so neither the number of matching leading characters nor the length of the
 * candidate is observable in the running time.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const a = index < left.length ? left.charCodeAt(index) : 0;
    const b = index < right.length ? right.charCodeAt(index) : 0;
    difference |= a ^ b;
  }
  return difference === 0;
}

/**
 * Every rejection costs the same work: the candidate is hashed and compared
 * before any state is inspected, so "no such code" and "wrong code" are
 * indistinguishable from the outside, and the branch order below only
 * decides which neutral reason the server records for itself.
 */
export function verifyOtpChallenge(
  challenge: OtpChallenge,
  code: unknown,
  now: string,
  pepper: string,
): OtpVerificationResult {
  const stored = normalizeOtpChallenge(challenge);
  const at = instant(now, "identity-otp-verified-at-invalid");
  const candidate = otpCodeHash({
    pepper,
    challengeId: stored.challengeId,
    salt: stored.salt,
    phone: stored.phone,
    code: typeof code === "string" ? code.slice(0, 64) : "",
  });
  const matches = constantTimeEquals(candidate, stored.codeHash);
  if (stored.consumedAt !== null) return { outcome: "consumed" };
  if (stored.attemptCount >= OTP_MAX_ATTEMPTS) return { outcome: "locked" };
  if (Date.parse(at) >= Date.parse(stored.expiresAt))
    return { outcome: "expired" };
  if (!matches) return { outcome: "mismatch" };
  return {
    outcome: "verified",
    challenge: Object.freeze({ ...stored, consumedAt: at }),
  };
}

/** The attempt counter the storage layer increments after a wrong code. */
export const withFailedOtpAttempt = (challenge: OtpChallenge): OtpChallenge =>
  Object.freeze({
    ...normalizeOtpChallenge(challenge),
    attemptCount: challenge.attemptCount + 1,
  });

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const encodeBase64Url = (bytes: Uint8Array): string => {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    const remaining = bytes.length - index;
    out += BASE64URL_ALPHABET[(triple >>> 18) & 63];
    out += BASE64URL_ALPHABET[(triple >>> 12) & 63];
    if (remaining > 1) out += BASE64URL_ALPHABET[(triple >>> 6) & 63];
    if (remaining > 2) out += BASE64URL_ALPHABET[triple & 63];
  }
  return out;
};

/** Strict: unpadded base64url only, and the decode must re-encode to the
 * exact same text, so no two spellings of one payload can ever verify. */
const decodeBase64Url = (text: string): Uint8Array | null => {
  if (text.length === 0 || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of text) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value < 0) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >>> bits) & 0xff;
      written += 1;
    }
  }
  const decoded = bytes.subarray(0, written);
  return encodeBase64Url(decoded) === text ? decoded : null;
};

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
};

const HMAC_BLOCK_BYTES = 64;

/**
 * HMAC-SHA256 over the dependency-free digest this package already ships.
 * `node:crypto` is deliberately not imported: `@find-the-edge/domain` is
 * bundled into the browser app, and a Node builtin here breaks that build.
 * The implementation is verified against `node:crypto.createHmac` in the
 * tests, including the over-length-key path.
 */
export function hmacSha256Hex(secret: string, message: string): string {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  const key = new Uint8Array(HMAC_BLOCK_BYTES);
  key.set(
    secretBytes.length > HMAC_BLOCK_BYTES
      ? hexToBytes(sha256BytesHex(secretBytes))
      : secretBytes,
  );
  const messageBytes = encoder.encode(message);
  const inner = new Uint8Array(HMAC_BLOCK_BYTES + messageBytes.length);
  for (let index = 0; index < HMAC_BLOCK_BYTES; index += 1)
    inner[index] = key[index]! ^ 0x36;
  inner.set(messageBytes, HMAC_BLOCK_BYTES);
  const outer = new Uint8Array(HMAC_BLOCK_BYTES + 32);
  for (let index = 0; index < HMAC_BLOCK_BYTES; index += 1)
    outer[index] = key[index]! ^ 0x5c;
  outer.set(hexToBytes(sha256BytesHex(inner)), HMAC_BLOCK_BYTES);
  return sha256BytesHex(outer);
}

export interface SessionSigningKey {
  readonly keyId: string;
  readonly secret: string;
}

/** Rotation-ready: tokens name the key that signed them, so a new current
 * key can be introduced while the previous one still verifies. */
export interface SessionKeyRing {
  readonly current: SessionSigningKey;
  readonly previous?: SessionSigningKey;
}

export interface SessionTokenPayload {
  readonly schemaVersion: typeof SESSION_TOKEN_SCHEMA_VERSION;
  readonly keyId: string;
  readonly accountId: string;
  readonly tokenVersion: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SessionTokenInput {
  readonly accountId: string;
  readonly tokenVersion: number;
  readonly now: string;
  readonly ttlMs?: number;
  readonly key: SessionSigningKey;
}

export interface SessionToken {
  readonly token: string;
  readonly payload: SessionTokenPayload;
  readonly expiresAt: string;
}

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const assertSigningKey = (key: SessionSigningKey): SessionSigningKey => {
  if (
    !key ||
    typeof key.keyId !== "string" ||
    !KEY_ID.test(key.keyId) ||
    typeof key.secret !== "string" ||
    key.secret.length < SESSION_SIGNING_KEY_MIN_LENGTH ||
    key.secret.length > 512
  )
    throw new Error("identity-signing-key-invalid");
  return key;
};

/** One spelling per payload: fixed field order, no optional fields, no
 * whitespace. Verification re-encodes what it parsed and demands the exact
 * same text, so a smuggled extra claim cannot ride along inside a payload
 * whose signature covers only what this function emits. */
const canonicalSessionPayload = (payload: SessionTokenPayload): string =>
  JSON.stringify({
    schemaVersion: payload.schemaVersion,
    keyId: payload.keyId,
    accountId: payload.accountId,
    tokenVersion: payload.tokenVersion,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });

const signSegment = (secret: string, encodedPayload: string): string =>
  hmacSha256Hex(secret, `${SESSION_TOKEN_PREFIX}.${encodedPayload}`);

export function createSessionToken(input: SessionTokenInput): SessionToken {
  const key = assertSigningKey(input.key);
  if (!isAccountId(input.accountId))
    throw new Error("identity-account-id-invalid");
  if (
    !Number.isSafeInteger(input.tokenVersion) ||
    input.tokenVersion < 1 ||
    input.tokenVersion > 1_000_000_000
  )
    throw new Error("identity-token-version-invalid");
  const issuedAt = instant(input.now, "identity-session-issued-at-invalid");
  const ttlMs = input.ttlMs ?? SESSION_TOKEN_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 60_000 ||
    ttlMs > 24 * 60 * 60_000
  )
    throw new Error("identity-session-ttl-invalid");
  const payload: SessionTokenPayload = Object.freeze({
    schemaVersion: SESSION_TOKEN_SCHEMA_VERSION,
    keyId: key.keyId,
    accountId: input.accountId,
    tokenVersion: input.tokenVersion,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
  });
  const encoded = encodeBase64Url(
    new TextEncoder().encode(canonicalSessionPayload(payload)),
  );
  return Object.freeze({
    token: `${SESSION_TOKEN_PREFIX}.${encoded}.${signSegment(key.secret, encoded)}`,
    payload,
    expiresAt: payload.expiresAt,
  });
}

export type SessionVerificationOutcome =
  "valid" | "malformed" | "unknown-key" | "bad-signature" | "expired";

export type SessionVerification =
  | { readonly outcome: "valid"; readonly payload: SessionTokenPayload }
  | {
      readonly outcome: Exclude<SessionVerificationOutcome, "valid">;
    };

const parseSessionPayload = (text: string): SessionTokenPayload | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const value = parsed as Record<string, unknown>;
  if (
    value["schemaVersion"] !== SESSION_TOKEN_SCHEMA_VERSION ||
    typeof value["keyId"] !== "string" ||
    !KEY_ID.test(value["keyId"]) ||
    !isAccountId(value["accountId"]) ||
    !Number.isSafeInteger(value["tokenVersion"]) ||
    (value["tokenVersion"] as number) < 1 ||
    typeof value["issuedAt"] !== "string" ||
    typeof value["expiresAt"] !== "string"
  )
    return null;
  let payload: SessionTokenPayload;
  try {
    payload = Object.freeze({
      schemaVersion: SESSION_TOKEN_SCHEMA_VERSION,
      keyId: value["keyId"],
      accountId: value["accountId"],
      tokenVersion: value["tokenVersion"] as number,
      issuedAt: instant(value["issuedAt"], "identity-session-payload-invalid"),
      expiresAt: instant(
        value["expiresAt"],
        "identity-session-payload-invalid",
      ),
    });
  } catch {
    return null;
  }
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt))
    return null;
  // Field smuggling: anything the canonical encoder would not have written
  // — an extra claim, a reordered object, a different number spelling —
  // fails here even before the signature is considered.
  return canonicalSessionPayload(payload) === text ? payload : null;
};

export function verifySessionToken(
  token: unknown,
  ring: SessionKeyRing,
  now: string,
): SessionVerification {
  assertSigningKey(ring.current);
  if (ring.previous !== undefined) assertSigningKey(ring.previous);
  const at = instant(now, "identity-session-verified-at-invalid");
  if (typeof token !== "string" || token.length > SESSION_TOKEN_MAX_LENGTH)
    return { outcome: "malformed" };
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== SESSION_TOKEN_PREFIX ||
    !HEX_64.test(parts[2] ?? "")
  )
    return { outcome: "malformed" };
  const decoded = decodeBase64Url(parts[1] ?? "");
  if (!decoded) return { outcome: "malformed" };
  const payload = parseSessionPayload(new TextDecoder().decode(decoded));
  if (!payload) return { outcome: "malformed" };
  const key = [ring.current, ring.previous].find(
    (candidate) => candidate?.keyId === payload.keyId,
  );
  if (!key) return { outcome: "unknown-key" };
  if (
    !constantTimeEquals(signSegment(key.secret, parts[1] ?? ""), parts[2] ?? "")
  )
    return { outcome: "bad-signature" };
  if (Date.parse(at) >= Date.parse(payload.expiresAt))
    return { outcome: "expired" };
  return { outcome: "valid", payload };
}

export type SessionRefreshResult =
  | {
      readonly outcome: "refreshed";
      readonly token: string;
      readonly payload: SessionTokenPayload;
      readonly expiresAt: string;
    }
  | {
      readonly outcome:
        Exclude<SessionVerificationOutcome, "valid"> | "revoked";
    };

export interface SessionRefreshInput {
  readonly ring: SessionKeyRing;
  readonly now: string;
  readonly ttlMs?: number;
  /** The account's current version, read from storage — never from the
   * token. A bumped version is how revocation reaches a live session. */
  readonly tokenVersion: number;
}

/**
 * A refresh is a re-issue, not an extension: the presented token must still
 * verify and still be unexpired, and the new token is signed with the
 * current key at the account's current token version. An expired token can
 * never be refreshed, so the maximum session length is bounded by how often
 * the browser is actually used.
 */
export function refreshSessionToken(
  token: unknown,
  input: SessionRefreshInput,
): SessionRefreshResult {
  const verification = verifySessionToken(token, input.ring, input.now);
  if (verification.outcome !== "valid")
    return { outcome: verification.outcome };
  if (verification.payload.tokenVersion !== input.tokenVersion)
    return { outcome: "revoked" };
  const issued = createSessionToken({
    accountId: verification.payload.accountId,
    tokenVersion: input.tokenVersion,
    now: input.now,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    key: input.ring.current,
  });
  return {
    outcome: "refreshed",
    token: issued.token,
    payload: issued.payload,
    expiresAt: issued.expiresAt,
  };
}
