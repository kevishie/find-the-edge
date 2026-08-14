import { describe, expect, it, vi } from "vitest";
import {
  createIdentityAccount,
  createSessionToken,
  type SessionKeyRing,
  type SessionSigningKey,
} from "@find-the-edge/domain";
import type { IdentityRepository } from "@find-the-edge/database";
import {
  authorizationContextFromGateway,
  isOwnedSessionAuthorization,
  memoizeIdentityAccountLookup,
  OWNED_SESSION_SCOPES,
  resolveOwnedSessionAuthorization,
} from "./authorization-context";

const NOW = new Date("2026-08-13T21:00:00.000Z");
const ACCOUNT_ID = `account:${"ab12cd34".repeat(8)}`;
const CURRENT_KEY: SessionSigningKey = {
  keyId: "current",
  secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
};
const RING: SessionKeyRing = { current: CURRENT_KEY };
const ACCOUNT = createIdentityAccount({
  accountId: ACCOUNT_ID,
  tokenVersion: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSignedInAt: NOW.toISOString(),
});

const session = (
  input: {
    readonly key?: SessionSigningKey;
    readonly tokenVersion?: number;
    readonly now?: string;
    readonly ttlMs?: number;
  } = {},
) =>
  createSessionToken({
    accountId: ACCOUNT_ID,
    tokenVersion: input.tokenVersion ?? ACCOUNT.tokenVersion,
    now: input.now ?? NOW.toISOString(),
    key: input.key ?? CURRENT_KEY,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  }).token;

const identityOf = (
  account: Awaited<ReturnType<IdentityRepository["getAccount"]>>,
): Pick<IdentityRepository, "getAccount"> => ({
  getAccount: vi.fn().mockResolvedValue(account),
});

const resolve = (
  authorization: string,
  identity: Pick<IdentityRepository, "getAccount"> = identityOf(ACCOUNT),
  signingKeys: SessionKeyRing = RING,
) =>
  resolveOwnedSessionAuthorization({
    authorization,
    signingKeys,
    identity,
    now: NOW,
  });

describe("owned session authorization", () => {
  it("projects a live stored account into ordinary product permissions", async () => {
    const identity = identityOf(ACCOUNT);
    await expect(resolve(`Bearer ${session()}`, identity)).resolves.toEqual({
      subject: ACCOUNT_ID,
      scopes: OWNED_SESSION_SCOPES,
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
    expect(identity.getAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(OWNED_SESSION_SCOPES).toEqual([
      "events/events:read",
      "events/scouting:read",
      "events/scouting:write",
    ]);
    expect(OWNED_SESSION_SCOPES).not.toContain("retrospectives:approve");
    expect(OWNED_SESSION_SCOPES).not.toContain("strategies:promote");
  });

  it("rejects malformed, tampered, expired, and foreign-key tokens before storage", async () => {
    const foreignKey: SessionSigningKey = {
      keyId: "foreign",
      secret: "abcdef0123456789abcdef0123456789abcdef0123456789",
    };
    const expired = session({
      now: new Date(NOW.getTime() - 60_000).toISOString(),
      ttlMs: 60_000,
    });
    for (const authorization of [
      "Bearer fte1.not-a-token",
      `Bearer ${session()}x`,
      `Bearer ${expired}`,
      `Bearer ${session({ key: foreignKey })}`,
      `Bearer ${session()} trailing-data`,
      `Bearer fte1.${"x".repeat(1100)}`,
    ]) {
      const identity = identityOf(ACCOUNT);
      await expect(resolve(authorization, identity)).resolves.toBeNull();
      expect(identity.getAccount).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing account and a stale revocation version", async () => {
    await expect(
      resolve(`Bearer ${session()}`, identityOf(null)),
    ).resolves.toBe(null);
    await expect(
      resolve(`Bearer ${session({ tokenVersion: 2 })}`, identityOf(ACCOUNT)),
    ).resolves.toBeNull();
  });

  it("rejects a mismatched stored account id", async () => {
    const other = createIdentityAccount({
      accountId: `account:${"cd34ef56".repeat(8)}`,
      tokenVersion: ACCOUNT.tokenVersion,
      createdAt: ACCOUNT.createdAt,
      lastSignedInAt: ACCOUNT.lastSignedInAt,
    });
    await expect(
      resolve(`Bearer ${session()}`, identityOf(other)),
    ).resolves.toBeNull();
  });

  it("propagates account storage failures without exposing credentials", async () => {
    const token = session();
    const outage = new Error(`failed ${ACCOUNT_ID} ${token}`);
    const identity: Pick<IdentityRepository, "getAccount"> = {
      getAccount: vi.fn().mockRejectedValue(outage),
    };
    const failure = await resolve(`Bearer ${token}`, identity).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "owned-session-authorization-unavailable",
    );
    expect((failure as Error).message).not.toContain(ACCOUNT_ID);
    expect((failure as Error).message).not.toContain(token);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("accepts case-insensitive bearer schemes consistently", async () => {
    for (const scheme of ["bearer", "BEARER", "BeArEr"])
      await expect(resolve(`${scheme} ${session()}`)).resolves.toMatchObject({
        subject: ACCOUNT_ID,
      });
  });

  it("memoizes the account authority only within one request wrapper", async () => {
    const identity = identityOf(ACCOUNT);
    const requestIdentity = memoizeIdentityAccountLookup(identity);
    await expect(
      Promise.all([
        resolve(`Bearer ${session()}`, requestIdentity),
        resolve(`Bearer ${session()}`, requestIdentity),
      ]),
    ).resolves.toHaveLength(2);
    expect(identity.getAccount).toHaveBeenCalledTimes(1);
  });

  it("classifies malformed fte1 credentials so they fail closed", () => {
    for (const authorization of [
      "Bearer fte1",
      "Bearer fte1.bad",
      " bearer   fte1.bad trailing ",
    ])
      expect(isOwnedSessionAuthorization(authorization)).toBe(true);
    expect(isOwnedSessionAuthorization("Bearer cognito.jwt.token")).toBe(false);
    expect(isOwnedSessionAuthorization(undefined)).toBe(false);
  });
});

describe("legacy gateway authorization", () => {
  it("preserves authorizer scopes and string-group permissions", () => {
    const scopes = ["events/events:read", "retrospectives:approve"];
    expect(
      authorizationContextFromGateway({
        scopes,
        claims: {
          sub: "cognito-user",
          scope: "ignored:because-authorizer-scopes-win",
          "cognito:groups":
            "fte-retrospective-reviewers,fte-strategy-promoters",
        },
      }),
    ).toEqual({
      subject: "cognito-user",
      scopes,
      reviewerAuthorized: true,
      strategyPromoterAuthorized: true,
    });
  });

  it("preserves claim-scope fallback and array-group permissions", () => {
    expect(
      authorizationContextFromGateway({
        claims: {
          sub: "cognito-user",
          scope: "events/events:read events/scouting:read",
          "cognito:groups": ["fte-retrospective-reviewers"],
        },
      }),
    ).toEqual({
      subject: "cognito-user",
      scopes: ["events/events:read", "events/scouting:read"],
      reviewerAuthorized: true,
      strategyPromoterAuthorized: false,
    });
  });

  it("defaults missing legacy authorization to no privileges", () => {
    expect(authorizationContextFromGateway(undefined)).toEqual({
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
  });
});
