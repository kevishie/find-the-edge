import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signStripePayload,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from "./stripe-signature.js";

const SECRET = "whsec_TestWebhookSecret0123456789";
const ROTATED_SECRET = "whsec_RotatedWebhookSecret012345";
const NOW = "2026-08-10T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1_000);
const PAYLOAD = JSON.stringify({
  id: "evt_signature000001",
  type: "customer.subscription.updated",
  created: NOW_SECONDS,
});

const header = (
  overrides: {
    readonly secret?: string;
    readonly payload?: string;
    readonly timestampSeconds?: number;
  } = {},
): string =>
  signStripePayload({
    payload: overrides.payload ?? PAYLOAD,
    secret: overrides.secret ?? SECRET,
    timestampSeconds: overrides.timestampSeconds ?? NOW_SECONDS,
  });

const verify = (input: {
  readonly payload?: string;
  readonly header: string;
  readonly secret?: string;
  readonly now?: string;
  readonly toleranceSeconds?: number;
}) =>
  verifyStripeSignature({
    payload: input.payload ?? PAYLOAD,
    header: input.header,
    secret: input.secret ?? SECRET,
    now: input.now ?? NOW,
    ...(input.toleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: input.toleranceSeconds }),
  }).outcome;

describe("verifyStripeSignature", () => {
  it("accepts a signature Stripe's own scheme would produce", () => {
    // Independent oracle: the header is checked against node's HMAC, not
    // against the implementation that produced it.
    const expected = createHmac("sha256", SECRET)
      .update(`${NOW_SECONDS}.${PAYLOAD}`)
      .digest("hex");
    expect(header()).toBe(`t=${NOW_SECONDS},v1=${expected}`);
    expect(verify({ header: header() })).toBe("valid");
  });

  it("rejects a tampered payload", () => {
    const signed = header();
    expect(verify({ header: signed, payload: `${PAYLOAD} ` })).toBe(
      "bad-signature",
    );
    expect(
      verify({
        header: signed,
        payload: PAYLOAD.replace("updated", "deleted"),
      }),
    ).toBe("bad-signature");
  });

  it("rejects the wrong secret", () => {
    expect(verify({ header: header(), secret: ROTATED_SECRET })).toBe(
      "bad-signature",
    );
  });

  it("rejects a signature whose timestamp is outside the tolerance", () => {
    const stale = NOW_SECONDS - STRIPE_SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(verify({ header: header({ timestampSeconds: stale }) })).toBe(
      "timestamp-out-of-tolerance",
    );
    // A timestamp far in the future is refused on the same bound.
    const ahead = NOW_SECONDS + STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verify({ header: header({ timestampSeconds: ahead }) })).toBe(
      "timestamp-out-of-tolerance",
    );
    // Exactly at the bound is still inside it.
    const edge = NOW_SECONDS - STRIPE_SIGNATURE_TOLERANCE_SECONDS;
    expect(verify({ header: header({ timestampSeconds: edge }) })).toBe(
      "valid",
    );
  });

  it("honours a caller-supplied tolerance", () => {
    const header30 = header({ timestampSeconds: NOW_SECONDS - 30 });
    expect(verify({ header: header30, toleranceSeconds: 60 })).toBe("valid");
    expect(verify({ header: header30, toleranceSeconds: 10 })).toBe(
      "timestamp-out-of-tolerance",
    );
  });

  it("accepts any matching v1 during a secret rotation", () => {
    const old = header();
    const rotated = header({ secret: ROTATED_SECRET });
    const both = `${old},${rotated.split(",")[1] ?? ""}`;
    expect(both.match(/v1=/g)).toHaveLength(2);
    expect(verify({ header: both })).toBe("valid");
    expect(verify({ header: both, secret: ROTATED_SECRET })).toBe("valid");
    expect(
      verify({ header: both, secret: "whsec_NeitherOfThoseSecrets01" }),
    ).toBe("bad-signature");
  });

  it("ignores the obsolete v0 scheme instead of accepting it", () => {
    const v1 = header().split(",")[1] ?? "";
    const digest = v1.slice("v1=".length);
    expect(verify({ header: `t=${NOW_SECONDS},v0=${digest}` })).toBe(
      "malformed-header",
    );
    expect(verify({ header: `t=${NOW_SECONDS},v0=${digest},${v1}` })).toBe(
      "valid",
    );
  });

  it("rejects malformed headers", () => {
    const signed = header();
    const v1 = signed.split(",")[1] ?? "";
    const cases: readonly string[] = [
      "",
      "not-a-header",
      v1,
      `t=${NOW_SECONDS}`,
      `t=,${v1}`,
      `t=abc,${v1}`,
      `t=${NOW_SECONDS},t=${NOW_SECONDS},${v1}`,
      `t=${NOW_SECONDS},v1=short`,
      `t=${NOW_SECONDS},v1=${"F".repeat(64)}`,
      `t=${NOW_SECONDS},,${v1}`,
      "x".repeat(4096),
    ];
    for (const candidate of cases)
      expect(verify({ header: candidate })).toBe("malformed-header");
  });

  it("tolerates the whitespace Stripe puts after each comma", () => {
    expect(verify({ header: header().replace(",", ", ") })).toBe("valid");
  });

  it("refuses to run with an unusable secret or clock", () => {
    expect(() =>
      verifyStripeSignature({
        payload: PAYLOAD,
        header: header(),
        secret: "short",
        now: NOW,
      }),
    ).toThrow("stripe-webhook-secret-invalid");
    expect(() =>
      verifyStripeSignature({
        payload: PAYLOAD,
        header: header(),
        secret: SECRET,
        now: "whenever",
      }),
    ).toThrow("stripe-signature-now-invalid");
    expect(() =>
      verifyStripeSignature({
        payload: PAYLOAD,
        header: header(),
        secret: SECRET,
        now: NOW,
        toleranceSeconds: 0,
      }),
    ).toThrow("stripe-signature-tolerance-invalid");
  });

  it("signs the exact bytes, so an equivalent re-serialization fails", () => {
    // The reason the webhook route must hold the raw body: this payload is
    // the same JSON value with different bytes, and it does not verify.
    const reserialized = JSON.stringify(JSON.parse(PAYLOAD), null, 2);
    expect(reserialized).not.toBe(PAYLOAD);
    expect(verify({ header: header(), payload: reserialized })).toBe(
      "bad-signature",
    );
  });
});
