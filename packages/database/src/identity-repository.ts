import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createIdentityAccount,
  normalizeIdentityAccount,
  normalizeOtpChallenge,
  normalizePhoneNumber,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_WINDOW_MS,
  type IdentityAccount,
  type OtpChallenge,
} from "@find-the-edge/domain";

/**
 * "created" means this call is the one that must send a message; "existing"
 * means a live challenge was already outstanding — a double-tapped resend,
 * or a request that lost a race — and no second message is sent.
 */
export interface OtpChallengeRequestResult {
  readonly outcome: "created" | "existing";
  readonly challenge: OtpChallenge;
}

export type RateLimitAction = "request" | "verify";
export type RateLimitScope = "phone" | "ip";

export interface RateLimitRequest {
  readonly action: RateLimitAction;
  readonly scope: RateLimitScope;
  /** An E.164 number for the phone scope, a source address for the ip scope. */
  readonly subject: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly now: string;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly count: number;
  /** When the current window rolls over, for a Retry-After header. */
  readonly resetAt: string;
}

export interface IdentityRepository {
  /**
   * Idempotent inside the resend window: a repeat request returns the live
   * challenge rather than replacing it, so one impatient user costs one SMS.
   * Outside the window a fresh challenge replaces the old one — there is
   * never more than one live challenge per number.
   */
  requestChallenge(
    challenge: OtpChallenge,
    resendWindowMs?: number,
  ): Promise<OtpChallengeRequestResult>;
  getChallenge(phone: string): Promise<OtpChallenge | null>;
  /** Single use: exactly one caller can win, however many race. */
  consumeChallenge(
    phone: string,
    challengeId: string,
    consumedAt: string,
  ): Promise<boolean>;
  /** Atomic increment; returns the new count so the caller can lock out. */
  recordFailedAttempt(phone: string, challengeId: string): Promise<number>;
  upsertAccount(input: {
    readonly accountId: string;
    readonly now: string;
  }): Promise<IdentityAccount>;
  getAccount(accountId: string): Promise<IdentityAccount | null>;
  /** Revocation: every token already issued fails its version check. */
  bumpTokenVersion(accountId: string): Promise<IdentityAccount | null>;
  consumeRateLimit(request: RateLimitRequest): Promise<RateLimitDecision>;
}

/**
 * Key schema (single table, primary key only — no Scan, no GSI):
 *
 *   `ACCOUNT#<accountId>`   / `RECORD`                  durable, no phone
 *   `OTP#<phone>`           / `CHALLENGE`               one live challenge, TTL
 *   `OTP_RATE#<subject>`    / `WINDOW#<window start>`   counter, TTL
 *
 * The account id is a peppered digest, so the durable partition never spells
 * a phone number. The challenge and counter partitions do, because they are
 * looked up by number before any account exists; both carry a TTL and hold
 * nothing but a hash and a count.
 */
export const identityAccountKey = (accountId: string) => ({
  pk: `ACCOUNT#${assertAccountId(accountId)}`,
  sk: "RECORD",
});

export const otpChallengeKey = (phone: string) => ({
  pk: `OTP#${normalizePhoneNumber(phone)}`,
  sk: "CHALLENGE",
});

const SOURCE_ADDRESS = /^[0-9a-fA-F:.]{3,45}$/;

export const assertSourceAddress = (value: unknown): string => {
  if (typeof value !== "string" || !SOURCE_ADDRESS.test(value))
    throw new Error("identity-source-address-invalid");
  return value;
};

function assertAccountId(value: unknown): string {
  if (typeof value !== "string" || !/^account:[a-f0-9]{64}$/.test(value))
    throw new Error("identity-account-id-invalid");
  return value;
}

/**
 * Request and verify are budgeted separately: sending messages costs money
 * and annoys the owner of the number, while guessing costs nothing, so the
 * two limits are not interchangeable and must not share a counter.
 */
export const rateLimitSubjectKey = (request: {
  readonly action: RateLimitAction;
  readonly scope: RateLimitScope;
  readonly subject: string;
}): string => {
  const subject =
    request.scope === "phone"
      ? normalizePhoneNumber(request.subject)
      : assertSourceAddress(request.subject);
  const prefix =
    request.action === "request"
      ? request.scope === "phone"
        ? ""
        : "ip:"
      : request.scope === "phone"
        ? "verify:"
        : "verify-ip:";
  return `OTP_RATE#${prefix}${subject}`;
};

const assertWindow = (request: RateLimitRequest) => {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 10_000 ||
    !Number.isSafeInteger(request.windowMs) ||
    request.windowMs < 1_000 ||
    request.windowMs > 24 * 60 * 60_000
  )
    throw new Error("identity-rate-limit-policy-invalid");
  const now = Date.parse(request.now);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== request.now)
    throw new Error("identity-rate-limit-now-invalid");
  const start = Math.floor(now / request.windowMs) * request.windowMs;
  return {
    pk: rateLimitSubjectKey(request),
    sk: `WINDOW#${new Date(start).toISOString()}`,
    resetAt: new Date(start + request.windowMs).toISOString(),
    // Two windows of retention: the row outlives its own window so a clock
    // at the boundary can never resurrect a spent budget.
    expiresAt: Math.ceil((start + 2 * request.windowMs) / 1_000),
  };
};

const epochSeconds = (instant: string): number =>
  Math.ceil(Date.parse(instant) / 1_000);

/**
 * DynamoDB stores an explicit null as a present attribute, which would make
 * `attribute_not_exists(value.consumedAt)` false for an unconsumed row and
 * break single-use enforcement. An unconsumed challenge therefore omits the
 * field entirely; the domain normalizer restores it as null on read.
 */
const storedChallenge = (challenge: OtpChallenge): Record<string, unknown> => {
  const { consumedAt, ...rest } = normalizeOtpChallenge(challenge);
  return consumedAt === null ? rest : { ...rest, consumedAt };
};

const isConditionalCheckFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

const withinResendWindow = (
  challenge: OtpChallenge,
  issuedAt: string,
  resendWindowMs: number,
): boolean =>
  challenge.consumedAt === null &&
  Date.parse(issuedAt) < Date.parse(challenge.expiresAt) &&
  Date.parse(issuedAt) - Date.parse(challenge.issuedAt) < resendWindowMs;

export class DynamoIdentityRepository implements IdentityRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async requestChallenge(
    challenge: OtpChallenge,
    resendWindowMs: number = OTP_RESEND_WINDOW_MS,
  ): Promise<OtpChallengeRequestResult> {
    const candidate = normalizeOtpChallenge(challenge);
    const key = otpChallengeKey(candidate.phone);
    const existing = await this.getChallenge(candidate.phone);
    if (
      existing &&
      withinResendWindow(existing, candidate.issuedAt, resendWindowMs)
    )
      return { outcome: "existing", challenge: existing };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...key,
            value: storedChallenge(candidate),
            expiresAt: epochSeconds(candidate.expiresAt),
          },
          // Newest issue wins, so two concurrent requests resolve the same
          // way whatever order they land in, and a late-arriving older
          // challenge can never replace a newer one.
          ConditionExpression:
            "attribute_not_exists(pk) OR #value.issuedAt < :issuedAt",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: { ":issuedAt": candidate.issuedAt },
        }),
      );
      return { outcome: "created", challenge: candidate };
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    const winner = await this.getChallenge(candidate.phone);
    // The only way the row vanished between the failed condition and this
    // read is expiry or consumption, which makes the caller's challenge the
    // live one again.
    return winner
      ? { outcome: "existing", challenge: winner }
      : { outcome: "created", challenge: candidate };
  }

  async getChallenge(phone: string): Promise<OtpChallenge | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: otpChallengeKey(phone),
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined
      ? null
      : normalizeOtpChallenge(result.Item["value"]);
  }

  async consumeChallenge(
    phone: string,
    challengeId: string,
    consumedAt: string,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: otpChallengeKey(phone),
          UpdateExpression: "SET #value.consumedAt = :consumedAt",
          ConditionExpression:
            "attribute_exists(pk) AND #value.challengeId = :challengeId AND attribute_not_exists(#value.consumedAt)",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: {
            ":consumedAt": consumedAt,
            ":challengeId": challengeId,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async recordFailedAttempt(
    phone: string,
    challengeId: string,
  ): Promise<number> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: otpChallengeKey(phone),
          UpdateExpression:
            "SET #value.attemptCount = #value.attemptCount + :one",
          ConditionExpression:
            "attribute_exists(pk) AND #value.challengeId = :challengeId AND attribute_not_exists(#value.consumedAt)",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: { ":one": 1, ":challengeId": challengeId },
          ReturnValues: "ALL_NEW",
        }),
      );
      return normalizeOtpChallenge(result.Attributes?.["value"]).attemptCount;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
      // The challenge was consumed or replaced under us. Failing closed —
      // reporting the challenge as exhausted — can only ever refuse a guess.
      return OTP_MAX_ATTEMPTS;
    }
  }

  async upsertAccount(input: {
    readonly accountId: string;
    readonly now: string;
  }): Promise<IdentityAccount> {
    const created = createIdentityAccount({
      accountId: input.accountId,
      createdAt: input.now,
    });
    const key = identityAccountKey(created.accountId);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, value: created },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return created;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    // An existing account keeps its creation instant and its token version;
    // a sign-in only moves the last-seen marker.
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: "SET #value.lastSignedInAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#value": "value" },
        ExpressionAttributeValues: { ":now": created.lastSignedInAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    return normalizeIdentityAccount(result.Attributes?.["value"]);
  }

  async getAccount(accountId: string): Promise<IdentityAccount | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: identityAccountKey(accountId),
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined
      ? null
      : normalizeIdentityAccount(result.Item["value"]);
  }

  async bumpTokenVersion(accountId: string): Promise<IdentityAccount | null> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: identityAccountKey(accountId),
          UpdateExpression:
            "SET #value.tokenVersion = #value.tokenVersion + :one",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "ALL_NEW",
        }),
      );
      return normalizeIdentityAccount(result.Attributes?.["value"]);
    } catch (error) {
      if (isConditionalCheckFailure(error)) return null;
      throw error;
    }
  }

  async consumeRateLimit(
    request: RateLimitRequest,
  ): Promise<RateLimitDecision> {
    const window = assertWindow(request);
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: window.pk, sk: window.sk },
          UpdateExpression:
            "SET #count = if_not_exists(#count, :zero) + :one, #expiresAt = :expiresAt",
          // The whole limit lives in this condition: the increment and the
          // budget check are one atomic write, so parallel requests cannot
          // both read "four used" and both spend the fifth.
          ConditionExpression:
            "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: {
            "#count": "count",
            "#expiresAt": "expiresAt",
          },
          ExpressionAttributeValues: {
            ":zero": 0,
            ":one": 1,
            ":limit": request.limit,
            ":expiresAt": window.expiresAt,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      const count: unknown = result.Attributes?.["count"];
      return {
        allowed: true,
        count: typeof count === "number" ? count : request.limit,
        resetAt: window.resetAt,
      };
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
      return { allowed: false, count: request.limit, resetAt: window.resetAt };
    }
  }
}

export class MemoryIdentityRepository implements IdentityRepository {
  /** Partitioned exactly like the table, so the tests exercise the same
   * key derivation the hosted repository uses. */
  readonly items = new Map<string, Record<string, unknown>>();

  private static id(key: { pk: string; sk: string }): string {
    return `${key.pk}\0${key.sk}`;
  }

  private read(key: {
    pk: string;
    sk: string;
  }): Record<string, unknown> | null {
    return this.items.get(MemoryIdentityRepository.id(key)) ?? null;
  }

  private write(
    key: { pk: string; sk: string },
    item: Record<string, unknown>,
  ): void {
    this.items.set(MemoryIdentityRepository.id(key), structuredClone(item));
  }

  async requestChallenge(
    challenge: OtpChallenge,
    resendWindowMs: number = OTP_RESEND_WINDOW_MS,
  ): Promise<OtpChallengeRequestResult> {
    await Promise.resolve();
    const candidate = normalizeOtpChallenge(challenge);
    const key = otpChallengeKey(candidate.phone);
    const stored = this.read(key);
    if (stored) {
      const existing = normalizeOtpChallenge(stored["value"]);
      if (withinResendWindow(existing, candidate.issuedAt, resendWindowMs))
        return { outcome: "existing", challenge: existing };
      if (Date.parse(existing.issuedAt) >= Date.parse(candidate.issuedAt))
        return { outcome: "existing", challenge: existing };
    }
    this.write(key, {
      ...key,
      value: storedChallenge(candidate),
      expiresAt: epochSeconds(candidate.expiresAt),
    });
    return { outcome: "created", challenge: candidate };
  }

  async getChallenge(phone: string): Promise<OtpChallenge | null> {
    await Promise.resolve();
    const stored = this.read(otpChallengeKey(phone));
    return stored ? normalizeOtpChallenge(stored["value"]) : null;
  }

  async consumeChallenge(
    phone: string,
    challengeId: string,
    consumedAt: string,
  ): Promise<boolean> {
    await Promise.resolve();
    const key = otpChallengeKey(phone);
    const stored = this.read(key);
    if (!stored) return false;
    const challenge = normalizeOtpChallenge(stored["value"]);
    if (challenge.challengeId !== challengeId || challenge.consumedAt !== null)
      return false;
    this.write(key, {
      ...stored,
      value: storedChallenge(Object.freeze({ ...challenge, consumedAt })),
    });
    return true;
  }

  async recordFailedAttempt(
    phone: string,
    challengeId: string,
  ): Promise<number> {
    await Promise.resolve();
    const key = otpChallengeKey(phone);
    const stored = this.read(key);
    if (!stored) return OTP_MAX_ATTEMPTS;
    const challenge = normalizeOtpChallenge(stored["value"]);
    if (challenge.challengeId !== challengeId || challenge.consumedAt !== null)
      return OTP_MAX_ATTEMPTS;
    const next = Object.freeze({
      ...challenge,
      attemptCount: challenge.attemptCount + 1,
    }) as OtpChallenge;
    this.write(key, { ...stored, value: storedChallenge(next) });
    return next.attemptCount;
  }

  async upsertAccount(input: {
    readonly accountId: string;
    readonly now: string;
  }): Promise<IdentityAccount> {
    await Promise.resolve();
    const created = createIdentityAccount({
      accountId: input.accountId,
      createdAt: input.now,
    });
    const key = identityAccountKey(created.accountId);
    const stored = this.read(key);
    const account = stored
      ? createIdentityAccount({
          ...normalizeIdentityAccount(stored["value"]),
          lastSignedInAt: created.lastSignedInAt,
        })
      : created;
    this.write(key, { ...key, value: account });
    return account;
  }

  async getAccount(accountId: string): Promise<IdentityAccount | null> {
    await Promise.resolve();
    const stored = this.read(identityAccountKey(accountId));
    return stored ? normalizeIdentityAccount(stored["value"]) : null;
  }

  async bumpTokenVersion(accountId: string): Promise<IdentityAccount | null> {
    await Promise.resolve();
    const key = identityAccountKey(accountId);
    const stored = this.read(key);
    if (!stored) return null;
    const account = normalizeIdentityAccount(stored["value"]);
    const next = createIdentityAccount({
      ...account,
      tokenVersion: account.tokenVersion + 1,
    });
    this.write(key, { ...key, value: next });
    return next;
  }

  async consumeRateLimit(
    request: RateLimitRequest,
  ): Promise<RateLimitDecision> {
    await Promise.resolve();
    const window = assertWindow(request);
    const key = { pk: window.pk, sk: window.sk };
    const stored = this.read(key);
    const current = typeof stored?.["count"] === "number" ? stored["count"] : 0;
    if (current >= request.limit)
      return { allowed: false, count: current, resetAt: window.resetAt };
    this.write(key, {
      ...key,
      count: current + 1,
      expiresAt: window.expiresAt,
    });
    return { allowed: true, count: current + 1, resetAt: window.resetAt };
  }
}
