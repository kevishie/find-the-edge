import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEquals,
  createIdentityAccount,
  createOtpChallenge,
  createSessionToken,
  deriveAccountId,
  hmacSha256Hex,
  isE164PhoneNumber,
  isOtpCode,
  normalizeIdentityAccount,
  normalizeOtpChallenge,
  normalizePhoneNumber,
  otpCodeHash,
  OTP_CHALLENGE_TTL_MS,
  OTP_MAX_ATTEMPTS,
  phoneDigest,
  phoneSuffixHint,
  refreshSessionToken,
  SESSION_TOKEN_TTL_MS,
  verifyOtpChallenge,
  verifySessionToken,
  withFailedOtpAttempt,
  type OtpChallenge,
  type SessionKeyRing,
} from "./identity.js";

const PHONE = "+15551234567";
const PEPPER = "otp-pepper-value-0123456789abcdef";
const ACCOUNT_PEPPER = "account-pepper-value-0123456789ab";
const SALT = "0123456789abcdef0123456789abcdef";
const NOW = "2026-08-10T12:00:00.000Z";
const KEY_RING: SessionKeyRing = {
  current: { keyId: "session-2026-08", secret: "a".repeat(48) },
  previous: { keyId: "session-2026-07", secret: "b".repeat(48) },
};

const challenge = (
  overrides: Partial<Parameters<typeof createOtpChallenge>[0]> = {},
): OtpChallenge =>
  createOtpChallenge({
    phone: PHONE,
    code: "907531",
    salt: SALT,
    pepper: PEPPER,
    now: NOW,
    ...overrides,
  });

const later = (milliseconds: number): string =>
  new Date(Date.parse(NOW) + milliseconds).toISOString();

describe("phone normalization", () => {
  it("accepts only canonical E.164", () => {
    expect(normalizePhoneNumber(PHONE)).toBe(PHONE);
    expect(normalizePhoneNumber(`  ${PHONE}\n`)).toBe(PHONE);
    expect(normalizePhoneNumber("+448081570000")).toBe("+448081570000");
    expect(isE164PhoneNumber(PHONE)).toBe(true);
  });

  it("rejects every non-canonical spelling", () => {
    for (const input of [
      "15551234567",
      "+1 555 123 4567",
      "+1-555-123-4567",
      "(555) 123-4567",
      "+05551234567",
      "+1234567",
      "+1234567890123456",
      "+1555123456a",
      "++15551234567",
      "+1555123456７",
      "",
      " ",
      42,
      null,
      undefined,
      { toString: () => PHONE },
      `+1${"5".repeat(40)}`,
    ])
      expect(() => normalizePhoneNumber(input)).toThrow(
        "identity-phone-invalid",
      );
    expect(isE164PhoneNumber(15551234567)).toBe(false);
  });

  it("logs at most a two-digit hint or a peppered digest", () => {
    expect(phoneSuffixHint(PHONE)).toBe("**67");
    const digest = phoneDigest(PHONE, PEPPER);
    expect(digest).toMatch(/^[a-f0-9]{32}$/);
    expect(digest).not.toContain("5551");
    expect(phoneDigest(PHONE, PEPPER)).toBe(digest);
    expect(phoneDigest("+15551234568", PEPPER)).not.toBe(digest);
    expect(phoneDigest(PHONE, `${PEPPER}x`)).not.toBe(digest);
    expect(() => phoneDigest(PHONE, "short")).toThrow(
      "identity-pepper-invalid",
    );
  });
});

describe("account identity", () => {
  it("derives a stable peppered account id that hides the number", () => {
    const accountId = deriveAccountId(PHONE, ACCOUNT_PEPPER);
    expect(accountId).toMatch(/^account:[a-f0-9]{64}$/);
    expect(deriveAccountId(`  ${PHONE} `, ACCOUNT_PEPPER)).toBe(accountId);
    expect(deriveAccountId(PHONE, `${ACCOUNT_PEPPER}2`)).not.toBe(accountId);
    expect(deriveAccountId("+15551234568", ACCOUNT_PEPPER)).not.toBe(accountId);
    expect(() => deriveAccountId("5551234567", ACCOUNT_PEPPER)).toThrow(
      "identity-phone-invalid",
    );
  });

  it("creates and re-derives an account record without a phone number", () => {
    const accountId = deriveAccountId(PHONE, ACCOUNT_PEPPER);
    const account = createIdentityAccount({ accountId, createdAt: NOW });
    expect(account).toEqual({
      schemaVersion: "identity-account-v1",
      accountId,
      tokenVersion: 1,
      createdAt: NOW,
      lastSignedInAt: NOW,
    });
    expect(Object.isFrozen(account)).toBe(true);
    expect(JSON.stringify(account)).not.toContain("555");
    expect(normalizeIdentityAccount(account)).toEqual(account);
    expect(
      normalizeIdentityAccount({
        ...account,
        lastSignedInAt: later(60_000),
        tokenVersion: 4,
      }).tokenVersion,
    ).toBe(4);
  });

  it("rejects corrupt account rows", () => {
    const accountId = deriveAccountId(PHONE, ACCOUNT_PEPPER);
    for (const stored of [
      null,
      "account",
      [],
      { schemaVersion: "identity-account-v2", accountId, createdAt: NOW },
      {
        schemaVersion: "identity-account-v1",
        accountId: "nope",
        createdAt: NOW,
      },
      { schemaVersion: "identity-account-v1", accountId, createdAt: "nope" },
      {
        schemaVersion: "identity-account-v1",
        accountId,
        createdAt: NOW,
        tokenVersion: 0,
      },
      {
        schemaVersion: "identity-account-v1",
        accountId,
        createdAt: NOW,
        tokenVersion: 1.5,
      },
      {
        schemaVersion: "identity-account-v1",
        accountId,
        createdAt: NOW,
        lastSignedInAt: "2026-08-10T11:59:59.000Z",
      },
    ])
      expect(() => normalizeIdentityAccount(stored)).toThrow(
        "stored-identity-account-invalid",
      );
    expect(() =>
      createIdentityAccount({ accountId: "account:zz", createdAt: NOW }),
    ).toThrow("identity-account-id-invalid");
  });
});

describe("otp challenge", () => {
  it("stores only a hash of the code and never the code itself", () => {
    const created = challenge();
    expect(created.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.expiresAt).toBe(later(OTP_CHALLENGE_TTL_MS));
    expect(created.attemptCount).toBe(0);
    expect(created.consumedAt).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain("907531");
    expect(serialized).not.toContain(PEPPER);
    expect(Object.values(created)).not.toContain("907531");
  });

  it("binds the hash to the challenge, salt, number, and pepper", () => {
    const first = challenge();
    const second = challenge({ now: later(1) });
    expect(second.challengeId).not.toBe(first.challengeId);
    expect(second.codeHash).not.toBe(first.codeHash);
    expect(challenge({ salt: "f".repeat(32) }).codeHash).not.toBe(
      first.codeHash,
    );
    expect(challenge({ pepper: `${PEPPER}2` }).codeHash).not.toBe(
      first.codeHash,
    );
    expect(
      otpCodeHash({
        pepper: PEPPER,
        challengeId: first.challengeId,
        salt: SALT,
        phone: PHONE,
        code: "907531",
      }),
    ).toBe(first.codeHash);
  });

  it("rejects malformed inputs", () => {
    expect(isOtpCode("907531")).toBe(true);
    expect(isOtpCode("12345")).toBe(false);
    expect(isOtpCode("12345a")).toBe(false);
    expect(isOtpCode(123_456)).toBe(false);
    expect(() => challenge({ code: "12345" })).toThrow(
      "identity-otp-code-invalid",
    );
    expect(() => challenge({ salt: "xyz" })).toThrow(
      "identity-otp-salt-invalid",
    );
    expect(() => challenge({ pepper: "tiny" })).toThrow(
      "identity-pepper-invalid",
    );
    expect(() => challenge({ now: "not-a-time" })).toThrow(
      "identity-otp-issued-at-invalid",
    );
    expect(() => challenge({ ttlMs: 10_000 })).toThrow(
      "identity-otp-ttl-invalid",
    );
    expect(() => challenge({ ttlMs: OTP_CHALLENGE_TTL_MS + 1 })).toThrow(
      "identity-otp-ttl-invalid",
    );
    expect(() => challenge({ phone: "5551234567" })).toThrow(
      "identity-phone-invalid",
    );
  });

  it("re-derives stored challenges and rejects tampered rows", () => {
    const created = challenge();
    expect(normalizeOtpChallenge(created)).toEqual(created);
    expect(
      normalizeOtpChallenge({ ...created, consumedAt: undefined }),
    ).toEqual(created);
    for (const stored of [
      null,
      [],
      "challenge",
      { ...created, schemaVersion: "otp-challenge-v2" },
      { ...created, phone: "+15551234568" },
      { ...created, salt: "f".repeat(32) },
      { ...created, issuedAt: later(1) },
      { ...created, challengeId: `otp:${"a".repeat(64)}` },
      { ...created, codeHash: "not-a-hash" },
      { ...created, attemptCount: -1 },
      { ...created, attemptCount: 1.5 },
      { ...created, consumedAt: "yesterday" },
      { ...created, expiresAt: later(OTP_CHALLENGE_TTL_MS + 60_000) },
      { ...created, expiresAt: NOW },
    ])
      expect(() => normalizeOtpChallenge(stored)).toThrow(
        "stored-otp-challenge-invalid",
      );
  });
});

describe("otp verification", () => {
  it("verifies the right code once and marks it consumed", () => {
    const created = challenge();
    const result = verifyOtpChallenge(created, "907531", later(1_000), PEPPER);
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") throw new Error("unreachable");
    expect(result.challenge.consumedAt).toBe(later(1_000));
    expect(Object.isFrozen(result.challenge)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("907531");
  });

  it("rejects a wrong, expired, consumed, or locked challenge", () => {
    const created = challenge();
    expect(verifyOtpChallenge(created, "907532", NOW, PEPPER)).toEqual({
      outcome: "mismatch",
    });
    expect(verifyOtpChallenge(created, "", NOW, PEPPER)).toEqual({
      outcome: "mismatch",
    });
    expect(verifyOtpChallenge(created, undefined, NOW, PEPPER)).toEqual({
      outcome: "mismatch",
    });
    expect(verifyOtpChallenge(created, "1".repeat(500), NOW, PEPPER)).toEqual({
      outcome: "mismatch",
    });
    expect(
      verifyOtpChallenge(
        created,
        "907531",
        later(OTP_CHALLENGE_TTL_MS),
        PEPPER,
      ),
    ).toEqual({ outcome: "expired" });
    expect(
      verifyOtpChallenge(
        { ...created, consumedAt: later(10) },
        "907531",
        later(20),
        PEPPER,
      ),
    ).toEqual({ outcome: "consumed" });
    expect(
      verifyOtpChallenge(
        { ...created, attemptCount: OTP_MAX_ATTEMPTS },
        "907531",
        later(20),
        PEPPER,
      ),
    ).toEqual({ outcome: "locked" });
    expect(
      verifyOtpChallenge(created, "907531", later(10), `${PEPPER}2`),
    ).toEqual({ outcome: "mismatch" });
  });

  it("locks out after the attempt bound and never issues afterwards", () => {
    let current = challenge();
    for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      expect(verifyOtpChallenge(current, "000000", later(10), PEPPER)).toEqual({
        outcome: "mismatch",
      });
      current = withFailedOtpAttempt(current);
    }
    expect(current.attemptCount).toBe(OTP_MAX_ATTEMPTS);
    expect(verifyOtpChallenge(current, "907531", later(20), PEPPER)).toEqual({
      outcome: "locked",
    });
  });

  it("rejects a corrupt stored challenge instead of verifying it", () => {
    expect(() =>
      verifyOtpChallenge(
        { ...challenge(), codeHash: "nope" },
        "907531",
        NOW,
        PEPPER,
      ),
    ).toThrow("stored-otp-challenge-invalid");
    expect(() =>
      verifyOtpChallenge(challenge(), "907531", "now", PEPPER),
    ).toThrow("identity-otp-verified-at-invalid");
  });

  it("compares code hashes in constant time", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("a", "")).toBe(false);
    // A candidate that shares every leading character must read the same
    // number of positions as one that differs immediately: the comparison
    // covers the longer of the two strings and folds in the length.
    const reads: number[] = [];
    const counted = (value: string) => {
      let count = 0;
      const proxy = {
        length: value.length,
        charCodeAt(index: number) {
          count += 1;
          return value.charCodeAt(index);
        },
      };
      constantTimeEquals(
        proxy as unknown as string,
        "0000000000000000000000000000000000000000000000000000000000000000",
      );
      reads.push(count);
    };
    counted("0000000000000000000000000000000000000000000000000000000000000001");
    counted("1000000000000000000000000000000000000000000000000000000000000000");
    counted("0000000000000000000000000000000000000000000000000000000000000000");
    expect(new Set(reads).size).toBe(1);
  });
});

describe("session tokens", () => {
  const accountId = deriveAccountId(PHONE, ACCOUNT_PEPPER);
  const issue = (
    overrides: Partial<Parameters<typeof createSessionToken>[0]> = {},
  ) =>
    createSessionToken({
      accountId,
      tokenVersion: 1,
      now: NOW,
      key: KEY_RING.current,
      ...overrides,
    });

  it("matches node's HMAC-SHA256, including over-length keys", () => {
    for (const [secret, message] of [
      ["", ""],
      ["key", "message"],
      ["a".repeat(48), "fte1.payload"],
      ["k".repeat(200), "a long message ".repeat(20)],
      ["ünïcödé-key-üüüüüüüüüüüüüüüüüüüü", "ünïcödé-message"],
    ] as const)
      expect(hmacSha256Hex(secret, message)).toBe(
        createHmac("sha256", secret).update(message).digest("hex"),
      );
  });

  it("round-trips a signed token", () => {
    const issued = issue();
    expect(issued.token.startsWith("fte1.")).toBe(true);
    expect(issued.token.split(".")).toHaveLength(3);
    expect(issued.expiresAt).toBe(later(SESSION_TOKEN_TTL_MS));
    expect(issued.payload).toEqual({
      schemaVersion: "fte-session-v1",
      keyId: "session-2026-08",
      accountId,
      tokenVersion: 1,
      issuedAt: NOW,
      expiresAt: later(SESSION_TOKEN_TTL_MS),
    });
    expect(verifySessionToken(issued.token, KEY_RING, later(60_000))).toEqual({
      outcome: "valid",
      payload: issued.payload,
    });
  });

  it("verifies a token signed by the previous key during rotation", () => {
    const old = issue({ key: KEY_RING.previous! });
    expect(verifySessionToken(old.token, KEY_RING, later(1_000)).outcome).toBe(
      "valid",
    );
    expect(
      verifySessionToken(
        old.token,
        { current: KEY_RING.current },
        later(1_000),
      ),
    ).toEqual({ outcome: "unknown-key" });
  });

  it("rejects a tampered signature", () => {
    const [prefix, payload, signature] = issue().token.split(".") as [
      string,
      string,
      string,
    ];
    const flipped = `${signature.slice(0, 63)}${signature.endsWith("a") ? "b" : "a"}`;
    expect(
      verifySessionToken(`${prefix}.${payload}.${flipped}`, KEY_RING, NOW),
    ).toEqual({ outcome: "bad-signature" });
    expect(
      verifySessionToken(
        `${prefix}.${payload}.${"0".repeat(64)}`,
        KEY_RING,
        NOW,
      ),
    ).toEqual({ outcome: "bad-signature" });
  });

  it("rejects a tampered payload and refuses smuggled fields", () => {
    const issued = issue();
    const signature = issued.token.split(".")[2]!;
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const forged = encode({
      ...issued.payload,
      accountId: deriveAccountId("+15550000000", ACCOUNT_PEPPER),
    });
    expect(
      verifySessionToken(`fte1.${forged}.${signature}`, KEY_RING, NOW),
    ).toEqual({ outcome: "bad-signature" });
    // Re-signing a payload with an extra claim still fails: the canonical
    // re-encoding drops the claim and no longer matches the signed text.
    const smuggled = encode({ ...issued.payload, admin: true });
    const resigned = createHmac("sha256", KEY_RING.current.secret)
      .update(`fte1.${smuggled}`)
      .digest("hex");
    expect(
      verifySessionToken(`fte1.${smuggled}.${resigned}`, KEY_RING, NOW),
    ).toEqual({ outcome: "malformed" });
    const reordered = encode({
      keyId: issued.payload.keyId,
      schemaVersion: issued.payload.schemaVersion,
      accountId: issued.payload.accountId,
      tokenVersion: issued.payload.tokenVersion,
      issuedAt: issued.payload.issuedAt,
      expiresAt: issued.payload.expiresAt,
    });
    expect(
      verifySessionToken(
        `fte1.${reordered}.${createHmac("sha256", KEY_RING.current.secret)
          .update(`fte1.${reordered}`)
          .digest("hex")}`,
        KEY_RING,
        NOW,
      ),
    ).toEqual({ outcome: "malformed" });
  });

  it("rejects malformed tokens", () => {
    const issued = issue();
    const [, payload, signature] = issued.token.split(".") as [
      string,
      string,
      string,
    ];
    for (const token of [
      undefined,
      42,
      "",
      "fte1",
      "fte1.payload",
      `fte2.${payload}.${signature}`,
      `fte1.${payload}.${signature}.extra`,
      `fte1.${payload}.${signature.slice(0, 63)}`,
      `fte1.${payload}.${signature.toUpperCase()}`,
      `fte1.${payload}=.${signature}`,
      `fte1.${payload}A.${signature}`,
      `fte1..${signature}`,
      `fte1.${Buffer.from("not json", "utf8").toString("base64url")}.${signature}`,
      `fte1.${Buffer.from(JSON.stringify([1, 2]), "utf8").toString("base64url")}.${signature}`,
      `fte1.${Buffer.from(JSON.stringify({ schemaVersion: "fte-session-v1" }), "utf8").toString("base64url")}.${signature}`,
      `fte1.${payload}.${signature}`.padEnd(1200, "a"),
    ])
      expect(verifySessionToken(token, KEY_RING, NOW).outcome).toBe(
        "malformed",
      );
  });

  it("rejects an expired token exactly at expiry", () => {
    const issued = issue();
    expect(
      verifySessionToken(
        issued.token,
        KEY_RING,
        later(SESSION_TOKEN_TTL_MS - 1),
      ).outcome,
    ).toBe("valid");
    expect(
      verifySessionToken(issued.token, KEY_RING, later(SESSION_TOKEN_TTL_MS)),
    ).toEqual({ outcome: "expired" });
  });

  it("rejects unusable keys and out-of-range claims", () => {
    expect(() => issue({ key: { keyId: "k", secret: "short" } })).toThrow(
      "identity-signing-key-invalid",
    );
    expect(() =>
      issue({ key: { keyId: "Bad Key", secret: "a".repeat(48) } }),
    ).toThrow("identity-signing-key-invalid");
    expect(() => issue({ accountId: "nope" })).toThrow(
      "identity-account-id-invalid",
    );
    expect(() => issue({ tokenVersion: 0 })).toThrow(
      "identity-token-version-invalid",
    );
    expect(() => issue({ now: "nope" })).toThrow(
      "identity-session-issued-at-invalid",
    );
    expect(() => issue({ ttlMs: 1_000 })).toThrow(
      "identity-session-ttl-invalid",
    );
    expect(() => issue({ ttlMs: 25 * 60 * 60_000 })).toThrow(
      "identity-session-ttl-invalid",
    );
    expect(() =>
      verifySessionToken(
        issue().token,
        { current: { keyId: "k", secret: "x" } },
        NOW,
      ),
    ).toThrow("identity-signing-key-invalid");
  });

  it("refreshes only a valid, unexpired, unrevoked token", () => {
    const issued = issue();
    const refreshed = refreshSessionToken(issued.token, {
      ring: KEY_RING,
      now: later(60_000),
      tokenVersion: 1,
    });
    expect(refreshed.outcome).toBe("refreshed");
    if (refreshed.outcome !== "refreshed") throw new Error("unreachable");
    expect(refreshed.token).not.toBe(issued.token);
    expect(refreshed.expiresAt).toBe(later(60_000 + SESSION_TOKEN_TTL_MS));
    expect(
      verifySessionToken(refreshed.token, KEY_RING, later(120_000)).outcome,
    ).toBe("valid");
    expect(
      refreshSessionToken(issued.token, {
        ring: KEY_RING,
        now: later(SESSION_TOKEN_TTL_MS),
        tokenVersion: 1,
      }),
    ).toEqual({ outcome: "expired" });
    expect(
      refreshSessionToken(issued.token, {
        ring: KEY_RING,
        now: later(1_000),
        tokenVersion: 2,
      }),
    ).toEqual({ outcome: "revoked" });
    expect(
      refreshSessionToken("fte1.nope", {
        ring: KEY_RING,
        now: later(1_000),
        tokenVersion: 1,
      }),
    ).toEqual({ outcome: "malformed" });
  });

  it("re-issues a previous-key token under the current key", () => {
    const old = createSessionToken({
      accountId,
      tokenVersion: 3,
      now: NOW,
      key: KEY_RING.previous!,
    });
    const refreshed = refreshSessionToken(old.token, {
      ring: KEY_RING,
      now: later(1_000),
      tokenVersion: 3,
      ttlMs: 15 * 60_000,
    });
    if (refreshed.outcome !== "refreshed") throw new Error("unreachable");
    expect(refreshed.payload.keyId).toBe("session-2026-08");
    expect(refreshed.payload.tokenVersion).toBe(3);
    expect(refreshed.expiresAt).toBe(later(1_000 + 15 * 60_000));
  });
});
