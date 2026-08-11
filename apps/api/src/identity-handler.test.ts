import { describe, expect, it } from "vitest";
import {
  MemoryIdentityRepository,
  type EventRepository,
  type IdentityRepository,
} from "@find-the-edge/database";
import {
  createSessionToken,
  deriveAccountId,
  OTP_CHALLENGE_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_REQUEST_PHONE_RATE_LIMIT,
  OTP_RESEND_WINDOW_MS,
  OTP_VERIFY_PHONE_RATE_LIMIT,
  SESSION_TOKEN_TTL_MS,
  verifySessionToken,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import { createEventHandler, type ApiRequest } from "./handler";
import type { IdentityRuntime } from "./identity-handler";
import type { SmsMessage, SmsSendResult, SmsSender } from "./sms-sender";

const PHONE = "+15557654321";
const OTHER_PHONE = "+15550009999";
const SOURCE_IP = "203.0.113.7";
const NOW = "2026-08-10T12:00:00.000Z";
const KEY_RING: SessionKeyRing = {
  current: { keyId: "session-2026-08", secret: "a".repeat(48) },
};

const later = (milliseconds: number): string =>
  new Date(Date.parse(NOW) + milliseconds).toISOString();

class FakeSmsSender implements SmsSender {
  readonly sent: SmsMessage[] = [];
  result: SmsSendResult = { outcome: "delivered" };

  async send(message: SmsMessage): Promise<SmsSendResult> {
    await Promise.resolve();
    this.sent.push(message);
    return this.result;
  }
}

/** Identity never touches the event projection; any read here is a bug. */
const unusedEvents: EventRepository = {
  list: () => {
    throw new Error("not-used");
  },
  detail: () => {
    throw new Error("not-used");
  },
};

interface Harness {
  readonly call: (request: ApiRequest) => Promise<{
    readonly statusCode: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  }>;
  readonly sms: FakeSmsSender;
  readonly repository: IdentityRepository;
  readonly logs: Record<string, unknown>[];
  readonly setNow: (value: string) => void;
  readonly lastCode: () => string;
}

const build = (
  overrides: Partial<IdentityRuntime> = {},
  repository: IdentityRepository = new MemoryIdentityRepository(),
): Harness => {
  const sms = new FakeSmsSender();
  const logs: Record<string, unknown>[] = [];
  let clock = NOW;
  let issued = 0;
  const codes = ["907531", "112233", "445566", "778899", "223344", "556677"];
  const runtime: IdentityRuntime = {
    sms,
    otpPepper: "otp-pepper-value-0123456789abcdef",
    accountPepper: "account-pepper-value-0123456789ab",
    signingKeys: KEY_RING,
    now: () => new Date(clock),
    generateCode: () => codes[issued++ % codes.length]!,
    generateSalt: () => String(issued).padStart(32, "0"),
    ...overrides,
  };
  const handler = createEventHandler(
    unusedEvents,
    undefined,
    (entry) => logs.push({ ...entry }),
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
    repository,
    runtime,
  );
  return {
    call: async (request) => {
      const result = await handler(request);
      return {
        statusCode: result.statusCode,
        headers: result.headers,
        body: result.body ? (JSON.parse(result.body) as unknown) : undefined,
      };
    },
    sms,
    repository,
    logs,
    setNow: (value) => {
      clock = value;
    },
    lastCode: () => codes[(issued - 1) % codes.length]!,
  };
};

const requestOtp = (phone: string, sourceIp = SOURCE_IP): ApiRequest => ({
  route: "auth-otp-request",
  method: "POST",
  contentType: "application/json",
  sourceIp,
  body: JSON.stringify({ phone }),
});

const verifyOtp = (
  phone: string,
  code: string,
  sourceIp = SOURCE_IP,
): ApiRequest => ({
  route: "auth-otp-verify",
  method: "POST",
  contentType: "application/json",
  sourceIp,
  body: JSON.stringify({ phone, code }),
});

const ACCEPTED = {
  schemaVersion: "auth-otp-request-v1",
  status: "accepted",
  expiresInSeconds: OTP_CHALLENGE_TTL_MS / 1_000,
  resendAfterSeconds: OTP_RESEND_WINDOW_MS / 1_000,
};

describe("POST /auth/otp/request", () => {
  it("accepts a request, sends one message, and never returns the code", async () => {
    const harness = build();
    const response = await harness.call(requestOtp(PHONE));
    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual(ACCEPTED);
    expect(harness.sms.sent).toHaveLength(1);
    expect(harness.sms.sent[0]?.phone).toBe(PHONE);
    expect(harness.sms.sent[0]?.body).toContain("907531");
    expect(JSON.stringify(response.body)).not.toContain("907531");
    const stored = await harness.repository.getChallenge(PHONE);
    expect(stored?.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("907531");
  });

  it("answers identically for a known and an unknown number", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(60_000));
    await harness.call(verifyOtp(PHONE, "907531"));
    harness.setNow(later(120_000));
    const known = await harness.call(requestOtp(PHONE));
    const unknown = await harness.call(requestOtp(OTHER_PHONE));
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toEqual(unknown.body);
    expect(known.headers).toEqual(unknown.headers);
  });

  it("suppresses a resend inside the cooldown window", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(5_000));
    const repeat = await harness.call(requestOtp(PHONE));
    expect(repeat.body).toEqual(ACCEPTED);
    expect(harness.sms.sent).toHaveLength(1);
    harness.setNow(later(OTP_RESEND_WINDOW_MS));
    await harness.call(requestOtp(PHONE));
    expect(harness.sms.sent).toHaveLength(2);
    // The first code is dead once a fresh challenge replaces it.
    harness.setNow(later(OTP_RESEND_WINDOW_MS + 1_000));
    expect((await harness.call(verifyOtp(PHONE, "907531"))).statusCode).toBe(
      400,
    );
  });

  it("answers the same way when delivery fails", async () => {
    const harness = build();
    harness.sms.result = { outcome: "failed", failureClass: "throttled" };
    const response = await harness.call(requestOtp(PHONE));
    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual(ACCEPTED);
    const log = harness.logs.find(
      (entry) => entry["event"] === "identity-request",
    );
    expect(log).toMatchObject({
      route: "auth-otp-request",
      outcome: "accepted",
      delivery: "failed",
      failureClass: "throttled",
    });
  });

  it("rate limits per number and reports when to retry", async () => {
    const harness = build();
    for (
      let attempt = 0;
      attempt < OTP_REQUEST_PHONE_RATE_LIMIT.limit;
      attempt += 1
    ) {
      harness.setNow(later(attempt * OTP_RESEND_WINDOW_MS));
      expect((await harness.call(requestOtp(PHONE))).statusCode).toBe(202);
    }
    harness.setNow(
      later(OTP_REQUEST_PHONE_RATE_LIMIT.limit * OTP_RESEND_WINDOW_MS),
    );
    const limited = await harness.call(requestOtp(PHONE));
    expect(limited.statusCode).toBe(429);
    expect(limited.body).toEqual({
      error: "rate-limited",
      retryAfterSeconds: expect.any(Number) as number,
    });
    expect(limited.headers["retry-after"]).toMatch(/^[0-9]+$/);
    expect(harness.sms.sent).toHaveLength(OTP_REQUEST_PHONE_RATE_LIMIT.limit);
    // A different number from the same address is still served until the
    // per-address budget runs out.
    expect((await harness.call(requestOtp(OTHER_PHONE))).statusCode).toBe(202);
  });

  it("rate limits per source address across numbers", async () => {
    const harness = build();
    let served = 0;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      harness.setNow(later(attempt * 60_000));
      const response = await harness.call(
        requestOtp(`+1555000${String(attempt).padStart(4, "0")}`),
      );
      if (response.statusCode === 202) served += 1;
      else expect(response.statusCode).toBe(429);
    }
    expect(served).toBe(20);
  });

  it("rejects a malformed body without touching the transport", async () => {
    const harness = build();
    for (const request of [
      { ...requestOtp(PHONE), body: JSON.stringify({ phone: "5557654321" }) },
      {
        ...requestOtp(PHONE),
        body: JSON.stringify({ phone: PHONE, extra: 1 }),
      },
      { ...requestOtp(PHONE), body: JSON.stringify({}) },
      { ...requestOtp(PHONE), body: JSON.stringify([PHONE]) },
      { ...requestOtp(PHONE), body: "{" },
      { ...requestOtp(PHONE), body: "x".repeat(300) },
      { ...requestOtp(PHONE), contentType: "text/plain" },
      {
        route: "auth-otp-request" as const,
        method: "GET" as const,
        sourceIp: SOURCE_IP,
      },
      { ...requestOtp(PHONE), query: { phone: PHONE } },
    ] satisfies ApiRequest[]) {
      const response = await harness.call(request);
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: "invalid-request" });
    }
    expect(harness.sms.sent).toHaveLength(0);
  });

  it("still serves when the gateway reports no source address", async () => {
    const harness = build();
    const response = await harness.call({
      ...requestOtp(PHONE),
      sourceIp: "not-an-address",
    });
    expect(response.statusCode).toBe(202);
  });
});

describe("POST /auth/otp/verify", () => {
  it("exchanges a valid code for a token bound to the account", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(30_000));
    const response = await harness.call(verifyOtp(PHONE, "907531"));
    expect(response.statusCode).toBe(200);
    const body = response.body as {
      schemaVersion: string;
      token: string;
      expiresAt: string;
      accountId: string;
    };
    expect(body.schemaVersion).toBe("auth-session-v1");
    expect(body.accountId).toBe(
      deriveAccountId(PHONE, "account-pepper-value-0123456789ab"),
    );
    expect(body.expiresAt).toBe(later(30_000 + SESSION_TOKEN_TTL_MS));
    const verified = verifySessionToken(body.token, KEY_RING, later(60_000));
    expect(verified.outcome).toBe("valid");
    if (verified.outcome !== "valid") throw new Error("unreachable");
    expect(verified.payload.accountId).toBe(body.accountId);
    expect(JSON.stringify(response.body)).not.toContain(PHONE);
    expect(JSON.stringify(response.body)).not.toContain("907531");
    const account = await harness.repository.getAccount(body.accountId);
    expect(account?.lastSignedInAt).toBe(later(30_000));
  });

  it("never issues twice for one code", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(10_000));
    expect((await harness.call(verifyOtp(PHONE, "907531"))).statusCode).toBe(
      200,
    );
    const replay = await harness.call(verifyOtp(PHONE, "907531"));
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toEqual({ error: "invalid-credentials" });
  });

  it("returns one neutral shape for every failure", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(1_000));
    const responses = [
      // wrong code for a live challenge
      await harness.call(verifyOtp(PHONE, "000000")),
      // no challenge at all for this number
      await harness.call(verifyOtp(OTHER_PHONE, "907531")),
      // a number that is not a number
      await harness.call(verifyOtp("5557654321", "907531")),
      // a code that is not a code
      await harness.call(verifyOtp(PHONE, "abc")),
      { ...(await harness.call({ ...verifyOtp(PHONE, "907531"), body: "{" })) },
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: "invalid-credentials" });
    }
    expect(
      new Set(responses.map(({ headers }) => JSON.stringify(headers))).size,
    ).toBe(1);
    // An expired code is the same answer again.
    harness.setNow(later(OTP_CHALLENGE_TTL_MS + 1_000));
    const expired = await harness.call(verifyOtp(PHONE, "907531"));
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toEqual({ error: "invalid-credentials" });
  });

  it("locks a challenge out after the attempt bound", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      harness.setNow(later(1_000 + attempt));
      expect((await harness.call(verifyOtp(PHONE, "000000"))).statusCode).toBe(
        400,
      );
    }
    harness.setNow(later(10_000));
    // The right code no longer helps once the challenge is exhausted.
    const locked = await harness.call(verifyOtp(PHONE, "907531"));
    expect(locked.statusCode).toBe(400);
    expect(locked.body).toEqual({ error: "invalid-credentials" });
    expect((await harness.repository.getChallenge(PHONE))?.attemptCount).toBe(
      OTP_MAX_ATTEMPTS,
    );
  });

  it("rate limits guessing per number", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    const statuses: number[] = [];
    for (
      let attempt = 0;
      attempt < OTP_VERIFY_PHONE_RATE_LIMIT.limit + 2;
      attempt += 1
    ) {
      harness.setNow(later(1_000 + attempt));
      statuses.push(
        (await harness.call(verifyOtp(PHONE, "000000"))).statusCode,
      );
    }
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });

  it("keeps the account's token version when signing in again", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(1_000));
    const first = (await harness.call(verifyOtp(PHONE, "907531"))).body as {
      accountId: string;
    };
    await harness.repository.bumpTokenVersion(first.accountId);
    harness.setNow(later(OTP_RESEND_WINDOW_MS * 2));
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(OTP_RESEND_WINDOW_MS * 2 + 1_000));
    const second = (await harness.call(verifyOtp(PHONE, harness.lastCode())))
      .body as { token: string; accountId: string };
    expect(second.accountId).toBe(first.accountId);
    const verified = verifySessionToken(
      second.token,
      KEY_RING,
      later(OTP_RESEND_WINDOW_MS * 2 + 2_000),
    );
    if (verified.outcome !== "valid") throw new Error("unreachable");
    expect(verified.payload.tokenVersion).toBe(2);
  });
});

describe("POST /auth/session/refresh", () => {
  const signedIn = async (harness: Harness) => {
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(1_000));
    return (await harness.call(verifyOtp(PHONE, "907531"))).body as {
      token: string;
      accountId: string;
    };
  };

  it("issues a fresh token from a valid one", async () => {
    const harness = build();
    const session = await signedIn(harness);
    harness.setNow(later(60_000));
    const response = await harness.call({
      route: "auth-session-refresh",
      method: "POST",
      authorization: `Bearer ${session.token}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.body as { token: string; expiresAt: string };
    expect(body.token).not.toBe(session.token);
    expect(body.expiresAt).toBe(later(60_000 + SESSION_TOKEN_TTL_MS));
    expect(
      verifySessionToken(body.token, KEY_RING, later(120_000)).outcome,
    ).toBe("valid");
  });

  it("refuses anything that is not a live token", async () => {
    const harness = build();
    const session = await signedIn(harness);
    const foreign = createSessionToken({
      accountId: session.accountId,
      tokenVersion: 1,
      now: NOW,
      key: { keyId: "session-2026-08", secret: "z".repeat(48) },
    });
    harness.setNow(later(60_000));
    for (const request of [
      { route: "auth-session-refresh" as const, method: "POST" as const },
      {
        route: "auth-session-refresh" as const,
        method: "POST" as const,
        authorization: session.token,
      },
      {
        route: "auth-session-refresh" as const,
        method: "POST" as const,
        authorization: `Bearer ${foreign.token}`,
      },
      {
        route: "auth-session-refresh" as const,
        method: "POST" as const,
        authorization: `Bearer ${session.token}`,
        body: JSON.stringify({ token: session.token }),
        contentType: "application/json",
      },
      {
        route: "auth-session-refresh" as const,
        method: "GET" as const,
        authorization: `Bearer ${session.token}`,
      },
    ] satisfies ApiRequest[]) {
      const response = await harness.call(request);
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ error: "unauthorized" });
    }
    // Expiry ends the session; a refresh cannot resurrect it.
    harness.setNow(later(SESSION_TOKEN_TTL_MS + 2_000));
    expect(
      (
        await harness.call({
          route: "auth-session-refresh",
          method: "POST",
          authorization: `Bearer ${session.token}`,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("stops refreshing once the account's tokens are revoked", async () => {
    const harness = build();
    const session = await signedIn(harness);
    await harness.repository.bumpTokenVersion(session.accountId);
    harness.setNow(later(60_000));
    expect(
      (
        await harness.call({
          route: "auth-session-refresh",
          method: "POST",
          authorization: `Bearer ${session.token}`,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("identity observability", () => {
  it("logs and counts outcomes without a number, a code, or a token", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(1_000));
    const session = (await harness.call(verifyOtp(PHONE, "907531"))).body as {
      token: string;
    };
    const serialized = JSON.stringify(harness.logs);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain("5557654321");
    expect(serialized).not.toContain("907531");
    expect(serialized).not.toContain(session.token);
    const identityLogs = harness.logs.filter(
      (entry) => entry["event"] === "identity-request",
    );
    expect(identityLogs).toHaveLength(2);
    expect(identityLogs[0]?.["phoneDigest"]).toMatch(/^[a-f0-9]{32}$/);
    expect(identityLogs[1]).toMatchObject({ outcome: "verified" });
    const metrics = harness.logs.filter((entry) => "_aws" in entry);
    const names = metrics.flatMap((entry) => {
      const aws = entry["_aws"] as {
        CloudWatchMetrics: {
          Dimensions: string[][];
          Metrics: { Name: string }[];
        }[];
      };
      expect(aws.CloudWatchMetrics[0]?.Dimensions).toEqual([["Route"]]);
      return aws.CloudWatchMetrics[0]!.Metrics.map(({ Name }) => Name);
    });
    expect(names).toContain("AuthOtpDelivered");
    expect(names).toContain("AuthOtpVerified");
    expect(metrics.every((entry) => !("Phone" in entry))).toBe(true);
  });

  it("counts rejections, rate limits, and refusals separately", async () => {
    const harness = build();
    await harness.call(verifyOtp(PHONE, "000000"));
    await harness.call({ route: "auth-session-refresh", method: "POST" });
    const names = harness.logs
      .filter((entry) => "_aws" in entry)
      .flatMap((entry) => {
        const aws = entry["_aws"] as {
          CloudWatchMetrics: { Metrics: { Name: string }[] }[];
        };
        return aws.CloudWatchMetrics[0]!.Metrics.map(({ Name }) => Name);
      });
    expect(names).toContain("AuthOtpRejected");
    expect(names).toContain("AuthUnauthorized");
  });

  it("fails neutrally when the identity service is not configured", async () => {
    const logs: Record<string, unknown>[] = [];
    const handler = createEventHandler(unusedEvents, undefined, (entry) =>
      logs.push({ ...entry }),
    );
    const response = await handler({
      route: "auth-otp-request",
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ phone: PHONE }),
    });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "internal-error" });
    expect(JSON.stringify(logs)).not.toContain(PHONE);
  });
});

describe("identity route isolation", () => {
  it("needs no authenticated subject", async () => {
    const harness = build();
    const response = await harness.call(requestOtp(PHONE));
    expect(response.statusCode).toBe(202);
  });

  it("never reads the event repository", async () => {
    const harness = build();
    await harness.call(requestOtp(PHONE));
    harness.setNow(later(1_000));
    await harness.call(verifyOtp(PHONE, "907531"));
    expect(
      harness.logs.some(
        (entry) => entry["event"] === "event-api-internal-failure",
      ),
    ).toBe(false);
  });
});
