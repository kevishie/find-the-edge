import { constantTimeEquals, hmacSha256Hex } from "./identity.js";

/**
 * Stripe's own default. A signature older than this is refused even when it
 * verifies: the HMAC proves who wrote the payload, not when, so without a
 * clock bound a captured webhook could be replayed at any point in the
 * future by anybody who saw it once.
 */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** A `Stripe-Signature` header is a handful of short pairs. Anything longer
 * is not a header we need to spend HMACs on. */
export const STRIPE_SIGNATURE_HEADER_MAX_LENGTH = 2048;

export const STRIPE_WEBHOOK_SECRET_MIN_LENGTH = 16;

export interface StripeSignatureInput {
  /** The exact bytes Stripe signed, as received. Not re-serialized JSON. */
  readonly payload: string;
  /** The raw `Stripe-Signature` header value. */
  readonly header: string;
  /** The endpoint's `whsec_...` signing secret. */
  readonly secret: string;
  readonly now: string;
  readonly toleranceSeconds?: number;
}

export type StripeSignatureOutcome =
  | "valid"
  | "malformed-header"
  | "timestamp-out-of-tolerance"
  | "bad-signature";

export interface StripeSignatureResult {
  readonly outcome: StripeSignatureOutcome;
}

const assertSecret = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length < STRIPE_WEBHOOK_SECRET_MIN_LENGTH ||
    value.length > 512
  )
    throw new Error("stripe-webhook-secret-invalid");
  return value;
};

const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;

interface ParsedHeader {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

/**
 * `t=1739130000,v1=<hex>,v1=<hex>,v0=<hex>`. Exactly one `t` is required —
 * two would let a caller pick which timestamp the tolerance check reads. The
 * `v0` scheme is Stripe's obsolete one and is ignored rather than accepted.
 * Multiple `v1` values are normal during a signing-secret rotation, when
 * Stripe signs one payload with both the old and the new secret.
 */
const parseHeader = (header: unknown): ParsedHeader | null => {
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    header.length > STRIPE_SIGNATURE_HEADER_MAX_LENGTH
  )
    return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !TIMESTAMP.test(value)) return null;
      timestamp = Number.parseInt(value, 10);
    } else if (key === "v1") {
      if (!SIGNATURE.test(value)) return null;
      signatures.push(value);
    } else if (key.length === 0) return null;
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
};

/**
 * Stripe's signature scheme, implemented over the dependency-free HMAC this
 * package already ships. `node:crypto` is deliberately not imported here:
 * `@find-the-edge/domain` is bundled into the browser app, and a Node
 * builtin would break that build.
 *
 * Every candidate signature is compared, in constant time, before any
 * decision is returned, so the number of matching leading hex characters is
 * not observable in the running time. The timestamp check runs after the
 * comparison for the same reason: the answer is the same amount of work
 * whichever way it comes out.
 */
export function verifyStripeSignature(
  input: StripeSignatureInput,
): StripeSignatureResult {
  const secret = assertSecret(input.secret);
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== input.now)
    throw new Error("stripe-signature-now-invalid");
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (
    !Number.isSafeInteger(tolerance) ||
    tolerance < 1 ||
    tolerance > 24 * 60 * 60
  )
    throw new Error("stripe-signature-tolerance-invalid");
  if (typeof input.payload !== "string")
    return { outcome: "malformed-header" };
  const parsed = parseHeader(input.header);
  if (!parsed) return { outcome: "malformed-header" };
  const expected = hmacSha256Hex(
    secret,
    `${parsed.timestamp}.${input.payload}`,
  );
  let matched = false;
  for (const candidate of parsed.signatures)
    matched = constantTimeEquals(expected, candidate) || matched;
  const skewSeconds = Math.abs(now / 1_000 - parsed.timestamp);
  // A future timestamp is refused on the same bound as a past one: a clock
  // far ahead of ours is either broken or chosen, and neither is a webhook
  // this endpoint should act on.
  if (skewSeconds > tolerance)
    return { outcome: "timestamp-out-of-tolerance" };
  return { outcome: matched ? "valid" : "bad-signature" };
}

/**
 * The signing half, for tests and fixtures only. Real webhooks are signed by
 * Stripe; nothing in the service calls this.
 */
export const signStripePayload = (input: {
  readonly payload: string;
  readonly secret: string;
  readonly timestampSeconds: number;
}): string =>
  `t=${input.timestampSeconds},v1=${hmacSha256Hex(
    assertSecret(input.secret),
    `${input.timestampSeconds}.${input.payload}`,
  )}`;
