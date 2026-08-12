import { randomBytes, randomInt } from "node:crypto";
import type {
  IdentityRepository,
  RateLimitDecision,
} from "@find-the-edge/database";
import {
  createOtpChallenge,
  createSessionToken,
  deriveAccountId,
  normalizePhoneNumber,
  phoneDigest,
  refreshSessionToken,
  verifyOtpChallenge,
  verifySessionToken,
  OTP_CHALLENGE_TTL_MS,
  OTP_REQUEST_IP_RATE_LIMIT,
  OTP_REQUEST_PHONE_RATE_LIMIT,
  OTP_RESEND_WINDOW_MS,
  OTP_VERIFY_IP_RATE_LIMIT,
  OTP_VERIFY_PHONE_RATE_LIMIT,
  type RateLimitPolicy,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import {
  otpMessageBody,
  type SmsDeliveryOutcome,
  type SmsFailureClass,
  type SmsSender,
} from "./sms-sender";

export type IdentityHttpRoute =
  | "auth-otp-request"
  | "auth-otp-verify"
  | "auth-session-refresh"
  | "auth-session-revoke";

export interface IdentityHttpRequest {
  readonly route: IdentityHttpRoute;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly contentType?: string;
  readonly body?: string;
  /** Raw `Authorization` header; only the refresh route reads it. */
  readonly authorization?: string;
  /** Gateway-observed source address. Never client-supplied. */
  readonly sourceIp?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
}

export interface IdentityHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface IdentityRuntime {
  readonly sms: SmsSender;
  /** Server-side secret mixed into every code hash; rotatable. */
  readonly otpPepper: string;
  /** Permanent secret behind the account id; see deriveAccountId. */
  readonly accountPepper: string;
  readonly signingKeys: SessionKeyRing;
  /**
   * Host of the web origin readers sign in on, bound into the code text so a
   * phone will offer it for autofill. Stage configuration only — never a
   * request header; see otpMessageBody. Absent means we send the plain text.
   */
  readonly webOtpHost?: string;
  readonly now?: () => Date;
  readonly generateCode?: () => string;
  readonly generateSalt?: () => string;
}

/**
 * What the request path is allowed to say about itself: a stable outcome
 * code, a delivery class, and a peppered digest of the number. No phone
 * number, no code, no token — not in metrics, not in logs.
 */
export interface IdentityObservation {
  readonly outcome: IdentityOutcome;
  readonly delivery: SmsDeliveryOutcome | "suppressed" | null;
  readonly failureClass: SmsFailureClass | null;
  readonly phoneDigest: string | null;
}

export type IdentityOutcome =
  | "accepted"
  | "resend-suppressed"
  | "rate-limited"
  | "invalid-request"
  | "verified"
  | "invalid-credentials"
  | "refreshed"
  | "revoked"
  | "unauthorized";

export interface IdentityHttpResult {
  readonly response: IdentityHttpResponse;
  readonly observation: IdentityObservation;
}

const response = (
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): IdentityHttpResponse => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  },
  body: JSON.stringify(body),
});

/**
 * Every verification failure looks like this one shape, whatever went wrong:
 * unknown number, no live challenge, wrong code, expired code, reused code,
 * or locked out. The server keeps the distinction for itself.
 */
const INVALID_CREDENTIALS = Object.freeze({ error: "invalid-credentials" });
const UNAUTHORIZED = Object.freeze({ error: "unauthorized" });
const INVALID_REQUEST = Object.freeze({ error: "invalid-request" });

const jsonBody = (
  request: IdentityHttpRequest,
  maximumBytes: number,
): Record<string, unknown> | null => {
  if (
    request.method !== "POST" ||
    request.contentType?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    !request.body ||
    Buffer.byteLength(request.body) > maximumBytes ||
    Object.keys(request.query ?? {}).length > 0
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(request.body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

/** `Bearer <token>`, scheme case-insensitive, exactly two parts. */
const bearerToken = (authorization: string | undefined): string | null => {
  if (typeof authorization !== "string" || authorization.length > 2048)
    return null;
  const parts = authorization.split(" ").filter((part) => part.length > 0);
  return parts.length === 2 && parts[0]?.toLowerCase() === "bearer"
    ? (parts[1] ?? null)
    : null;
};

const retryAfterSeconds = (decision: RateLimitDecision, now: string): number =>
  Math.max(
    1,
    Math.ceil((Date.parse(decision.resetAt) - Date.parse(now)) / 1_000),
  );

const rateLimited = (
  decision: RateLimitDecision,
  now: string,
  digest: string | null,
): IdentityHttpResult => {
  const seconds = retryAfterSeconds(decision, now);
  return {
    response: response(
      429,
      { error: "rate-limited", retryAfterSeconds: seconds },
      { "retry-after": String(seconds) },
    ),
    observation: {
      outcome: "rate-limited",
      delivery: null,
      failureClass: null,
      phoneDigest: digest,
    },
  };
};

/** Six uniformly random digits. `randomInt` rejects modulo bias, which a
 * `Math.random`-style construction would not. */
const secureCode = (): string =>
  String(randomInt(0, 1_000_000)).padStart(6, "0");
const secureSalt = (): string => randomBytes(16).toString("hex");

const spend = async (
  repository: IdentityRepository,
  scope: "phone" | "ip",
  action: "request" | "verify",
  subject: string,
  policy: RateLimitPolicy,
  now: string,
): Promise<RateLimitDecision> =>
  repository.consumeRateLimit({
    action,
    scope,
    subject,
    limit: policy.limit,
    windowMs: policy.windowMs,
    now,
  });

/**
 * The source address is only usable as a rate-limit subject when the gateway
 * gave us one it recognises. A missing address falls back to the per-number
 * budget alone rather than pooling every caller into one shared bucket,
 * which would let one host lock everybody out.
 */
const usableSourceIp = (value: string | undefined): string | null =>
  typeof value === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(value)
    ? value
    : null;

export const createIdentityHttpHandler =
  (repository: IdentityRepository, runtime: IdentityRuntime) =>
  async (request: IdentityHttpRequest): Promise<IdentityHttpResult> => {
    const now = (runtime.now?.() ?? new Date()).toISOString();
    const sourceIp = usableSourceIp(request.sourceIp);
    if (request.route === "auth-session-refresh") {
      const token = bearerToken(request.authorization);
      const unauthorized: IdentityHttpResult = {
        response: response(401, UNAUTHORIZED),
        observation: {
          outcome: "unauthorized",
          delivery: null,
          failureClass: null,
          phoneDigest: null,
        },
      };
      if (
        request.method !== "POST" ||
        Object.keys(request.query ?? {}).length > 0 ||
        (request.body !== undefined && request.body !== "") ||
        !token
      )
        return unauthorized;
      const verified = verifySessionToken(token, runtime.signingKeys, now);
      if (verified.outcome !== "valid") return unauthorized;
      // The account row is the authority on revocation: a token whose
      // version has been bumped, or whose account is gone, cannot refresh.
      const account = await repository.getAccount(verified.payload.accountId);
      if (!account) return unauthorized;
      const refreshed = refreshSessionToken(token, {
        ring: runtime.signingKeys,
        now,
        tokenVersion: account.tokenVersion,
      });
      if (refreshed.outcome !== "refreshed") return unauthorized;
      return {
        response: response(200, {
          schemaVersion: "auth-session-v1",
          token: refreshed.token,
          expiresAt: refreshed.expiresAt,
          accountId: account.accountId,
        }),
        observation: {
          outcome: "refreshed",
          delivery: null,
          failureClass: null,
          phoneDigest: null,
        },
      };
    }
    if (request.route === "auth-session-revoke") {
      // Signing out has to end the token, not merely forget it. Dropping the
      // copy in the browser leaves a signed, unexpired bearer token that any
      // other holder — a shared machine, a synced profile, a copied string —
      // could still spend until it lapsed on its own.
      //
      // Bumping the stored version is what actually retires it: every path
      // that accepts our token compares the two, so the old one dies at the
      // refresh route, the billing routes, and the product-access gate at
      // once, for every device that holds it.
      const unauthorized: IdentityHttpResult = {
        response: response(401, UNAUTHORIZED),
        observation: {
          outcome: "unauthorized",
          delivery: null,
          failureClass: null,
          phoneDigest: null,
        },
      };
      const token = bearerToken(request.authorization);
      if (
        request.method !== "POST" ||
        Object.keys(request.query ?? {}).length > 0 ||
        (request.body !== undefined && request.body !== "") ||
        !token
      )
        return unauthorized;
      const verified = verifySessionToken(token, runtime.signingKeys, now);
      if (verified.outcome !== "valid") return unauthorized;
      const account = await repository.getAccount(verified.payload.accountId);
      // A token whose version is already behind was revoked by an earlier
      // sign-out. That is the goal state, so say so rather than failing: a
      // reader pressing sign-out twice has not hit an error.
      if (!account || account.tokenVersion !== verified.payload.tokenVersion)
        return unauthorized;
      await repository.bumpTokenVersion(account.accountId);
      return {
        response: response(200, { schemaVersion: "auth-revoke-v1" }),
        observation: {
          outcome: "revoked",
          delivery: null,
          failureClass: null,
          phoneDigest: null,
        },
      };
    }
    const body = jsonBody(request, 256);
    if (request.route === "auth-otp-request") {
      const invalid: IdentityHttpResult = {
        response: response(400, INVALID_REQUEST),
        observation: {
          outcome: "invalid-request",
          delivery: null,
          failureClass: null,
          phoneDigest: null,
        },
      };
      if (!body || !exactKeys(body, ["phone"])) return invalid;
      let phone: string;
      try {
        phone = normalizePhoneNumber(body["phone"]);
      } catch {
        return invalid;
      }
      const digest = phoneDigest(phone, runtime.otpPepper);
      if (sourceIp) {
        const perIp = await spend(
          repository,
          "ip",
          "request",
          sourceIp,
          OTP_REQUEST_IP_RATE_LIMIT,
          now,
        );
        if (!perIp.allowed) return rateLimited(perIp, now, digest);
      }
      const perPhone = await spend(
        repository,
        "phone",
        "request",
        phone,
        OTP_REQUEST_PHONE_RATE_LIMIT,
        now,
      );
      if (!perPhone.allowed) return rateLimited(perPhone, now, digest);
      const code = (runtime.generateCode ?? secureCode)();
      const result = await repository.requestChallenge(
        createOtpChallenge({
          phone,
          code,
          salt: (runtime.generateSalt ?? secureSalt)(),
          pepper: runtime.otpPepper,
          now,
        }),
        OTP_RESEND_WINDOW_MS,
      );
      // A resend inside the window reuses the live challenge, whose code we
      // no longer hold — so there is nothing to send, and nothing to say.
      const delivery =
        result.outcome === "created"
          ? await runtime.sms.send({
              phone,
              body: otpMessageBody(code, runtime.webOtpHost),
            })
          : null;
      // The same body every time: known number or not, delivered or not.
      // Anything conditional here would be an enumeration oracle.
      return {
        response: response(202, {
          schemaVersion: "auth-otp-request-v1",
          status: "accepted",
          expiresInSeconds: OTP_CHALLENGE_TTL_MS / 1_000,
          resendAfterSeconds: OTP_RESEND_WINDOW_MS / 1_000,
        }),
        observation: {
          outcome: delivery === null ? "resend-suppressed" : "accepted",
          delivery: delivery === null ? "suppressed" : delivery.outcome,
          failureClass: delivery?.failureClass ?? null,
          phoneDigest: digest,
        },
      };
    }
    const rejected = (digest: string | null): IdentityHttpResult => ({
      response: response(400, INVALID_CREDENTIALS),
      observation: {
        outcome: "invalid-credentials",
        delivery: null,
        failureClass: null,
        phoneDigest: digest,
      },
    });
    if (!body || !exactKeys(body, ["phone", "code"])) return rejected(null);
    let phone: string;
    try {
      phone = normalizePhoneNumber(body["phone"]);
    } catch {
      return rejected(null);
    }
    const digest = phoneDigest(phone, runtime.otpPepper);
    if (sourceIp) {
      const perIp = await spend(
        repository,
        "ip",
        "verify",
        sourceIp,
        OTP_VERIFY_IP_RATE_LIMIT,
        now,
      );
      if (!perIp.allowed) return rateLimited(perIp, now, digest);
    }
    const perPhone = await spend(
      repository,
      "phone",
      "verify",
      phone,
      OTP_VERIFY_PHONE_RATE_LIMIT,
      now,
    );
    if (!perPhone.allowed) return rateLimited(perPhone, now, digest);
    const challenge = await repository.getChallenge(phone);
    if (!challenge) return rejected(digest);
    const verification = verifyOtpChallenge(
      challenge,
      body["code"],
      now,
      runtime.otpPepper,
    );
    if (verification.outcome !== "verified") {
      // Only a wrong code burns an attempt: expiry, reuse, and lockout are
      // already terminal for this challenge.
      if (verification.outcome === "mismatch")
        await repository.recordFailedAttempt(phone, challenge.challengeId);
      return rejected(digest);
    }
    // Single use is decided in storage, not here: whoever wins the
    // conditional write is the only caller that gets a token.
    if (!(await repository.consumeChallenge(phone, challenge.challengeId, now)))
      return rejected(digest);
    const account = await repository.upsertAccount({
      accountId: deriveAccountId(phone, runtime.accountPepper),
      now,
    });
    const session = createSessionToken({
      accountId: account.accountId,
      tokenVersion: account.tokenVersion,
      now,
      key: runtime.signingKeys.current,
    });
    return {
      response: response(200, {
        schemaVersion: "auth-session-v1",
        token: session.token,
        expiresAt: session.expiresAt,
        accountId: account.accountId,
      }),
      observation: {
        outcome: "verified",
        delivery: null,
        failureClass: null,
        phoneDigest: digest,
      },
    };
  };
