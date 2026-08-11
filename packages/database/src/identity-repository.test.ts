import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createOtpChallenge,
  deriveAccountId,
  normalizePhoneNumber,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_WINDOW_MS,
  type OtpChallenge,
} from "@find-the-edge/domain";
import {
  DynamoIdentityRepository,
  identityAccountKey,
  MemoryIdentityRepository,
  otpChallengeKey,
  rateLimitSubjectKey,
  type IdentityRepository,
} from "./identity-repository";

const PHONE = "+15557654321";
const PEPPER = "otp-pepper-value-0123456789abcdef";
const ACCOUNT_PEPPER = "account-pepper-value-0123456789ab";
const NOW = "2026-08-10T12:00:00.000Z";
const ACCOUNT_ID = deriveAccountId(PHONE, ACCOUNT_PEPPER);

const later = (milliseconds: number): string =>
  new Date(Date.parse(NOW) + milliseconds).toISOString();

const challenge = (
  overrides: Partial<Parameters<typeof createOtpChallenge>[0]> = {},
): OtpChallenge =>
  createOtpChallenge({
    phone: PHONE,
    code: "907531",
    salt: "0123456789abcdef0123456789abcdef",
    pepper: PEPPER,
    now: NOW,
    ...overrides,
  });

interface CommandLike {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

const conditionalFailure = () =>
  Object.assign(new Error("condition"), {
    name: "ConditionalCheckFailedException",
  });

/**
 * Single-table double that understands exactly the expressions the
 * repository is allowed to issue. Anything else throws, so a change to the
 * repository's storage vocabulary cannot slip past these tests.
 */
class FakeIdentityTableClient {
  readonly items = new Map<string, Record<string, unknown>>();

  private static id(pk: string, sk: string): string {
    return `${pk}\0${sk}`;
  }

  raw(pk: string, sk: string): Record<string, unknown> | undefined {
    return this.items.get(FakeIdentityTableClient.id(pk, sk));
  }

  putRaw(pk: string, sk: string, item: Record<string, unknown>): void {
    this.items.set(FakeIdentityTableClient.id(pk, sk), structuredClone(item));
  }

  async send(raw: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const command = raw as CommandLike;
    const input = command.input;
    const key = input["Key"] as { pk: string; sk: string } | undefined;
    const values = (input["ExpressionAttributeValues"] ?? {}) as Record<
      string,
      unknown
    >;
    if (command.constructor.name === "GetCommand") {
      const item = key
        ? this.items.get(FakeIdentityTableClient.id(key.pk, key.sk))
        : undefined;
      return item === undefined ? {} : { Item: structuredClone(item) };
    }
    if (command.constructor.name === "PutCommand") {
      const item = input["Item"] as {
        pk: string;
        sk: string;
        value?: Record<string, unknown>;
      };
      const id = FakeIdentityTableClient.id(item.pk, item.sk);
      const existing = this.items.get(id);
      const condition = input["ConditionExpression"];
      if (condition === "attribute_not_exists(pk)" && existing)
        throw conditionalFailure();
      if (
        condition ===
          "attribute_not_exists(pk) OR #value.issuedAt < :issuedAt" &&
        existing &&
        String((existing["value"] as Record<string, unknown>)["issuedAt"]) >=
          String(values[":issuedAt"])
      )
        throw conditionalFailure();
      this.items.set(id, structuredClone(item));
      return {};
    }
    if (command.constructor.name !== "UpdateCommand")
      throw new Error(`unexpected-command:${command.constructor.name}`);
    if (!key) throw new Error("update-without-key");
    const id = FakeIdentityTableClient.id(key.pk, key.sk);
    const existing = this.items.get(id);
    const update = String(input["UpdateExpression"]);
    const condition = String(input["ConditionExpression"]);
    if (
      update ===
      "SET #count = if_not_exists(#count, :zero) + :one, #expiresAt = :expiresAt"
    ) {
      if (condition !== "attribute_not_exists(#count) OR #count < :limit")
        throw new Error(`unexpected-condition:${condition}`);
      const current =
        typeof existing?.["count"] === "number" ? existing["count"] : 0;
      if (current >= Number(values[":limit"])) throw conditionalFailure();
      const item = {
        ...key,
        count: current + 1,
        expiresAt: values[":expiresAt"],
      };
      this.items.set(id, item);
      return { Attributes: structuredClone(item) };
    }
    const value = existing?.["value"] as Record<string, unknown> | undefined;
    if (condition === "attribute_exists(pk)") {
      if (!existing || !value) throw conditionalFailure();
    } else if (
      condition ===
      "attribute_exists(pk) AND #value.challengeId = :challengeId AND attribute_not_exists(#value.consumedAt)"
    ) {
      if (
        !existing ||
        !value ||
        value["challengeId"] !== values[":challengeId"] ||
        value["consumedAt"] !== undefined
      )
        throw conditionalFailure();
    } else throw new Error(`unexpected-condition:${condition}`);
    const next: Record<string, unknown> = { ...(value ?? {}) };
    if (update === "SET #value.consumedAt = :consumedAt")
      next["consumedAt"] = values[":consumedAt"];
    else if (update === "SET #value.attemptCount = #value.attemptCount + :one")
      next["attemptCount"] = Number(next["attemptCount"]) + 1;
    else if (update === "SET #value.lastSignedInAt = :now")
      next["lastSignedInAt"] = values[":now"];
    else if (update === "SET #value.tokenVersion = #value.tokenVersion + :one")
      next["tokenVersion"] = Number(next["tokenVersion"]) + 1;
    else throw new Error(`unexpected-update:${update}`);
    const item = { ...existing, value: next };
    this.items.set(id, structuredClone(item));
    return input["ReturnValues"] === "ALL_NEW"
      ? { Attributes: structuredClone(item) }
      : {};
  }
}

interface Harness {
  readonly repository: IdentityRepository;
  readonly rawChallenge: () => Record<string, unknown> | undefined;
  readonly rawAccount: () => Record<string, unknown> | undefined;
  readonly rawRate: (
    pk: string,
    sk: string,
  ) => Record<string, unknown> | undefined;
  readonly corrupt: (
    pk: string,
    sk: string,
    item: Record<string, unknown>,
  ) => void;
}

const harnesses: readonly (readonly [string, () => Harness])[] = [
  [
    "memory",
    () => {
      const repository = new MemoryIdentityRepository();
      const key = otpChallengeKey(PHONE);
      const accountKey = identityAccountKey(ACCOUNT_ID);
      return {
        repository,
        rawChallenge: () => repository.items.get(`${key.pk}\0${key.sk}`),
        rawAccount: () =>
          repository.items.get(`${accountKey.pk}\0${accountKey.sk}`),
        rawRate: (pk, sk) => repository.items.get(`${pk}\0${sk}`),
        corrupt: (pk, sk, item) => repository.items.set(`${pk}\0${sk}`, item),
      };
    },
  ],
  [
    "dynamo",
    () => {
      const client = new FakeIdentityTableClient();
      const key = otpChallengeKey(PHONE);
      const accountKey = identityAccountKey(ACCOUNT_ID);
      return {
        repository: new DynamoIdentityRepository(
          client as unknown as DynamoDBDocumentClient,
          "table",
        ),
        rawChallenge: () => client.raw(key.pk, key.sk),
        rawAccount: () => client.raw(accountKey.pk, accountKey.sk),
        rawRate: (pk, sk) => client.raw(pk, sk),
        corrupt: (pk, sk, item) => client.putRaw(pk, sk, item),
      };
    },
  ],
];

describe("identity key schema", () => {
  it("keys accounts by digest and challenges by number", () => {
    expect(identityAccountKey(ACCOUNT_ID)).toEqual({
      pk: `ACCOUNT#${ACCOUNT_ID}`,
      sk: "RECORD",
    });
    expect(otpChallengeKey(` ${PHONE} `)).toEqual({
      pk: `OTP#${PHONE}`,
      sk: "CHALLENGE",
    });
    expect(() => identityAccountKey("nope")).toThrow(
      "identity-account-id-invalid",
    );
    expect(() => otpChallengeKey("5557654321")).toThrow(
      "identity-phone-invalid",
    );
  });

  it("budgets requests and verifications separately per scope", () => {
    expect(
      rateLimitSubjectKey({
        action: "request",
        scope: "phone",
        subject: PHONE,
      }),
    ).toBe(`OTP_RATE#${PHONE}`);
    expect(
      rateLimitSubjectKey({
        action: "request",
        scope: "ip",
        subject: "203.0.113.7",
      }),
    ).toBe("OTP_RATE#ip:203.0.113.7");
    expect(
      rateLimitSubjectKey({ action: "verify", scope: "phone", subject: PHONE }),
    ).toBe(`OTP_RATE#verify:${PHONE}`);
    expect(
      rateLimitSubjectKey({
        action: "verify",
        scope: "ip",
        subject: "2001:db8::1",
      }),
    ).toBe("OTP_RATE#verify-ip:2001:db8::1");
    expect(() =>
      rateLimitSubjectKey({
        action: "request",
        scope: "ip",
        subject: "not an address",
      }),
    ).toThrow("identity-source-address-invalid");
  });
});

for (const [name, build] of harnesses)
  describe(`identity repository (${name})`, () => {
    it("returns the live challenge inside the resend window", async () => {
      const { repository } = build();
      const first = await repository.requestChallenge(challenge());
      expect(first.outcome).toBe("created");
      const repeat = await repository.requestChallenge(
        challenge({ code: "111111", salt: "f".repeat(32), now: later(5_000) }),
      );
      expect(repeat).toEqual({
        outcome: "existing",
        challenge: first.challenge,
      });
      const replaced = await repository.requestChallenge(
        challenge({
          code: "111111",
          salt: "f".repeat(32),
          now: later(OTP_RESEND_WINDOW_MS),
        }),
      );
      expect(replaced.outcome).toBe("created");
      expect(replaced.challenge.challengeId).not.toBe(
        first.challenge.challengeId,
      );
      expect((await repository.getChallenge(PHONE))?.challengeId).toBe(
        replaced.challenge.challengeId,
      );
    });

    it("resolves concurrent requests to one live challenge whatever the order", async () => {
      const { repository } = build();
      const candidates = [
        challenge({ now: later(OTP_RESEND_WINDOW_MS * 2) }),
        challenge({ salt: "a".repeat(32), now: later(OTP_RESEND_WINDOW_MS) }),
      ];
      const results = await Promise.all(
        candidates.map((candidate) => repository.requestChallenge(candidate)),
      );
      const live = await repository.getChallenge(PHONE);
      expect(live?.challengeId).toBe(candidates[0]!.challengeId);
      expect(
        results.filter(({ outcome }) => outcome === "created"),
      ).not.toHaveLength(0);
    });

    it("lets exactly one caller consume a challenge", async () => {
      const { repository } = build();
      const { challenge: live } =
        await repository.requestChallenge(challenge());
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.consumeChallenge(PHONE, live.challengeId, later(1_000)),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await repository.getChallenge(PHONE))?.consumedAt).toBe(
        later(1_000),
      );
      expect(
        await repository.consumeChallenge(
          PHONE,
          live.challengeId,
          later(2_000),
        ),
      ).toBe(false);
    });

    it("refuses to consume a challenge that is not the one presented", async () => {
      const { repository } = build();
      await repository.requestChallenge(challenge());
      expect(
        await repository.consumeChallenge(
          PHONE,
          `otp:${"a".repeat(64)}`,
          later(1_000),
        ),
      ).toBe(false);
      expect(
        await repository.consumeChallenge(
          "+15550001111",
          `otp:${"a".repeat(64)}`,
          later(1_000),
        ),
      ).toBe(false);
    });

    it("increments attempts atomically and fails closed once gone", async () => {
      const { repository } = build();
      const { challenge: live } =
        await repository.requestChallenge(challenge());
      const counts = await Promise.all(
        Array.from({ length: OTP_MAX_ATTEMPTS }, () =>
          repository.recordFailedAttempt(PHONE, live.challengeId),
        ),
      );
      expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      expect((await repository.getChallenge(PHONE))?.attemptCount).toBe(
        OTP_MAX_ATTEMPTS,
      );
      await repository.consumeChallenge(PHONE, live.challengeId, later(1_000));
      expect(
        await repository.recordFailedAttempt(PHONE, live.challengeId),
      ).toBe(OTP_MAX_ATTEMPTS);
      expect(
        await repository.recordFailedAttempt("+15550001111", live.challengeId),
      ).toBe(OTP_MAX_ATTEMPTS);
    });

    it("creates an account once and only moves the last-seen marker", async () => {
      const { repository } = build();
      const created = await repository.upsertAccount({
        accountId: ACCOUNT_ID,
        now: NOW,
      });
      expect(created).toEqual({
        schemaVersion: "identity-account-v1",
        accountId: ACCOUNT_ID,
        tokenVersion: 1,
        createdAt: NOW,
        lastSignedInAt: NOW,
      });
      const bumped = await repository.bumpTokenVersion(ACCOUNT_ID);
      expect(bumped?.tokenVersion).toBe(2);
      const returning = await repository.upsertAccount({
        accountId: ACCOUNT_ID,
        now: later(600_000),
      });
      expect(returning).toEqual({
        schemaVersion: "identity-account-v1",
        accountId: ACCOUNT_ID,
        tokenVersion: 2,
        createdAt: NOW,
        lastSignedInAt: later(600_000),
      });
      expect(await repository.getAccount(ACCOUNT_ID)).toEqual(returning);
      expect(
        await repository.getAccount(
          deriveAccountId("+15550002222", ACCOUNT_PEPPER),
        ),
      ).toBeNull();
      expect(
        await repository.bumpTokenVersion(
          deriveAccountId("+15550002222", ACCOUNT_PEPPER),
        ),
      ).toBeNull();
    });

    it("spends a windowed budget and reopens it in the next window", async () => {
      const { repository, rawRate } = build();
      const request = {
        action: "request",
        scope: "phone",
        subject: PHONE,
        limit: 3,
        windowMs: 900_000,
        now: NOW,
      } as const;
      const decisions = [];
      for (let attempt = 0; attempt < 4; attempt += 1)
        decisions.push(await repository.consumeRateLimit(request));
      expect(decisions.map(({ allowed }) => allowed)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      expect(decisions.map(({ count }) => count)).toEqual([1, 2, 3, 3]);
      expect(new Set(decisions.map(({ resetAt }) => resetAt))).toEqual(
        new Set(["2026-08-10T12:15:00.000Z"]),
      );
      const next = await repository.consumeRateLimit({
        ...request,
        now: "2026-08-10T12:15:00.000Z",
      });
      expect(next).toEqual({
        allowed: true,
        count: 1,
        resetAt: "2026-08-10T12:30:00.000Z",
      });
      // The counter row carries a TTL two windows out, so a spent budget
      // cannot be resurrected by an expiry landing mid-window.
      const row = rawRate(
        `OTP_RATE#${PHONE}`,
        "WINDOW#2026-08-10T12:00:00.000Z",
      );
      expect(row?.["expiresAt"]).toBe(
        Math.ceil(Date.parse("2026-08-10T12:30:00.000Z") / 1_000),
      );
    });

    it("holds the budget under concurrent spending", async () => {
      const { repository } = build();
      const request = {
        action: "verify",
        scope: "ip",
        subject: "203.0.113.7",
        limit: 2,
        windowMs: 60_000,
        now: NOW,
      } as const;
      const decisions = await Promise.all(
        Array.from({ length: 6 }, () => repository.consumeRateLimit(request)),
      );
      expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(2);
    });

    it("rejects unusable rate-limit policies", async () => {
      const { repository } = build();
      await expect(
        repository.consumeRateLimit({
          action: "request",
          scope: "phone",
          subject: PHONE,
          limit: 0,
          windowMs: 900_000,
          now: NOW,
        }),
      ).rejects.toThrow("identity-rate-limit-policy-invalid");
      await expect(
        repository.consumeRateLimit({
          action: "request",
          scope: "phone",
          subject: PHONE,
          limit: 5,
          windowMs: 900_000,
          now: "yesterday",
        }),
      ).rejects.toThrow("identity-rate-limit-now-invalid");
    });

    it("stores a TTL on the challenge and omits an unconsumed marker", async () => {
      const { repository, rawChallenge, rawAccount } = build();
      const { challenge: live } =
        await repository.requestChallenge(challenge());
      const row = rawChallenge();
      expect(row?.["expiresAt"]).toBe(
        Math.ceil(Date.parse(live.expiresAt) / 1_000),
      );
      const value = row?.["value"] as Record<string, unknown>;
      expect("consumedAt" in value).toBe(false);
      expect(JSON.stringify(value)).not.toContain("907531");
      await repository.upsertAccount({ accountId: ACCOUNT_ID, now: NOW });
      // Accounts are durable identity, so they carry no TTL and no number.
      expect(rawAccount()?.["expiresAt"]).toBeUndefined();
      expect(JSON.stringify(rawAccount())).not.toContain(
        normalizePhoneNumber(PHONE),
      );
    });

    it("rejects corrupt stored rows instead of trusting them", async () => {
      const { repository, corrupt } = build();
      const key = otpChallengeKey(PHONE);
      corrupt(key.pk, key.sk, {
        ...key,
        value: { ...challenge(), challengeId: `otp:${"a".repeat(64)}` },
      });
      await expect(repository.getChallenge(PHONE)).rejects.toThrow(
        "stored-otp-challenge-invalid",
      );
      const accountKey = identityAccountKey(ACCOUNT_ID);
      corrupt(accountKey.pk, accountKey.sk, {
        ...accountKey,
        value: { schemaVersion: "identity-account-v1", accountId: "nope" },
      });
      await expect(repository.getAccount(ACCOUNT_ID)).rejects.toThrow(
        "stored-identity-account-invalid",
      );
    });
  });

describe("identity repository failure propagation", () => {
  const failing = (name: string) => {
    const error = Object.assign(new Error("boom"), { name });
    return new DynamoIdentityRepository(
      {
        send: () => Promise.reject(error),
      } as unknown as DynamoDBDocumentClient,
      "table",
    );
  };

  it("propagates service errors rather than reading them as denials", async () => {
    const repository = failing("ThrottlingException");
    await expect(repository.getChallenge(PHONE)).rejects.toThrow("boom");
    await expect(
      repository.consumeChallenge(PHONE, `otp:${"a".repeat(64)}`, NOW),
    ).rejects.toThrow("boom");
    await expect(
      repository.recordFailedAttempt(PHONE, `otp:${"a".repeat(64)}`),
    ).rejects.toThrow("boom");
    await expect(
      repository.upsertAccount({ accountId: ACCOUNT_ID, now: NOW }),
    ).rejects.toThrow("boom");
    await expect(repository.bumpTokenVersion(ACCOUNT_ID)).rejects.toThrow(
      "boom",
    );
    await expect(
      repository.consumeRateLimit({
        action: "request",
        scope: "phone",
        subject: PHONE,
        limit: 5,
        windowMs: 900_000,
        now: NOW,
      }),
    ).rejects.toThrow("boom");
    await expect(repository.requestChallenge(challenge())).rejects.toThrow(
      "boom",
    );
  });
});
