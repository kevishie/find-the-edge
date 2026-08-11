import { describe, expect, it, vi } from "vitest";
import {
  createEntitlement,
  createSessionToken,
  type SessionKeyRing,
} from "@find-the-edge/domain";
import type {
  EntitlementRepository,
  IdentityRepository,
} from "@find-the-edge/database";
import {
  decideProductAccess,
  denialBody,
  denialStatus,
  requiresProductAccess,
} from "./product-access";

const NOW = new Date("2026-08-11T18:00:00.000Z");
const RING: SessionKeyRing = {
  current: {
    keyId: "k1",
    secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
  },
};
const ACCOUNT = `account:${"a1b2c3d4".repeat(8)}`;

const token = (accountId = ACCOUNT, tokenVersion = 1) =>
  createSessionToken({
    accountId,
    tokenVersion,
    now: NOW.toISOString(),
    key: RING.current,
  }).token;

const identityOf = (account: unknown) =>
  ({
    getAccount: vi.fn(() => Promise.resolve(account)),
  }) as unknown as IdentityRepository;

const entitlementsOf = (record: unknown) =>
  ({
    get: vi.fn(() => Promise.resolve(record)),
  }) as unknown as EntitlementRepository;

const entitled = (state: "trialing" | "active" | "canceled") =>
  createEntitlement({
    accountId: ACCOUNT,
    state,
    accessUntil: new Date(NOW.getTime() + 86_400_000).toISOString(),
    updatedAt: NOW.toISOString(),
  });

const decide = (
  request: { route: string; authorization?: string },
  options: {
    enforced?: boolean;
    account?: unknown;
    entitlement?: unknown;
  } = {},
) =>
  decideProductAccess(
    request,
    { signingKeys: RING, enforced: options.enforced ?? true },
    identityOf(
      options.account === undefined
        ? { accountId: ACCOUNT, tokenVersion: 1 }
        : options.account,
    ),
    entitlementsOf(
      options.entitlement === undefined
        ? entitled("active")
        : options.entitlement,
    ),
    NOW,
  );

describe("which routes are paid", () => {
  it("keeps open only the routes that cannot be paid for", () => {
    // Sign-in is how an account comes to exist and billing is how it comes
    // to be paid for, so gating either would be a loop with no entrance.
    for (const route of [
      "auth-otp-request",
      "auth-otp-verify",
      "auth-session-refresh",
      "billing-webhook",
      "billing-entitlement",
      "billing-checkout",
      "billing-portal",
      "provider-status",
    ])
      expect(requiresProductAccess(route)).toBe(false);
  });

  it("treats every odds, edge, scouting and per-user route as paid", () => {
    for (const route of [
      "list",
      "detail",
      "games",
      "splits",
      "odds-history",
      "opportunity-list",
      "opportunity-detail",
      "arbitrage-list",
      "clv-list",
      "performance-list",
      "performance-reports",
      "retrospective-list",
      "experiment-list",
      "scout-create",
      "scout-status",
      "scout-report-by-job",
      "watchlist-list",
      "watchlist-add",
      "watchlist-remove",
    ])
      expect(requiresProductAccess(route)).toBe(true);
  });

  it("defaults an unrecognised route to paid", () => {
    // A route added later is protected until someone deliberately opens it,
    // which is the safe direction for this list to fail in.
    expect(requiresProductAccess("some-future-route")).toBe(true);
  });
});

describe("the access decision", () => {
  it("allows an entitled session and reports the account", async () => {
    for (const state of ["trialing", "active"] as const)
      expect(
        await decide(
          { route: "games", authorization: `Bearer ${token()}` },
          { entitlement: entitled(state) },
        ),
      ).toEqual({ allowed: true, accountId: ACCOUNT });
  });

  it("refuses an anonymous product read", async () => {
    expect(await decide({ route: "games" })).toEqual({
      allowed: false,
      denial: "unauthenticated",
    });
  });

  it("refuses a forged or foreign token without consulting storage", async () => {
    const get = vi.fn(() => Promise.resolve(entitled("active")));
    const entitlements = { get } as unknown as EntitlementRepository;
    for (const authorization of [
      "Bearer fte1.tampered.0000",
      "Bearer not-a-token",
      "Basic something",
      `Bearer ${token()}x`,
    ]) {
      const decision = await decideProductAccess(
        { route: "games", authorization },
        { signingKeys: RING, enforced: true },
        identityOf({ accountId: ACCOUNT, tokenVersion: 1 }),
        entitlements,
        NOW,
      );
      expect(decision).toEqual({ allowed: false, denial: "unauthenticated" });
    }
    // An unverifiable token never reaches the entitlement lookup.
    expect(get).not.toHaveBeenCalled();
  });

  it("ends a revoked session even though its signature is still good", async () => {
    // Signing out everywhere bumps the stored token version; the token in
    // the browser stays cryptographically valid, so this is the only check
    // that can retire it.
    expect(
      await decide(
        { route: "games", authorization: `Bearer ${token(ACCOUNT, 1)}` },
        { account: { accountId: ACCOUNT, tokenVersion: 2 } },
      ),
    ).toEqual({ allowed: false, denial: "unauthenticated" });
    expect(
      await decide(
        { route: "games", authorization: `Bearer ${token()}` },
        { account: null },
      ),
    ).toEqual({ allowed: false, denial: "unauthenticated" });
  });

  it("separates 'not signed in' from 'signed in and not paying'", async () => {
    // The browser picks between a sign-in form and a subscribe button from
    // this distinction alone, so the two must never collapse.
    const unpaid = await decide(
      { route: "games", authorization: `Bearer ${token()}` },
      { entitlement: null },
    );
    expect(unpaid).toEqual({
      allowed: false,
      denial: "not-entitled",
      accountId: ACCOUNT,
    });
    expect(denialStatus("unauthenticated")).toBe(401);
    expect(denialStatus("not-entitled")).toBe(402);
    expect(denialBody("not-entitled").error).toBe("payment-required");
  });

  it("refuses a cancelled account whose access date has not passed", async () => {
    expect(
      await decide(
        { route: "games", authorization: `Bearer ${token()}` },
        { entitlement: entitled("canceled") },
      ),
    ).toMatchObject({ allowed: false, denial: "not-entitled" });
  });

  it("lets the open routes through with no session at all", async () => {
    for (const route of [
      "auth-otp-request",
      "billing-checkout",
      "provider-status",
    ])
      expect(await decide({ route })).toEqual({ allowed: true });
  });

  it("allows everything while enforcement is off", async () => {
    // The rollout switch is server-side configuration. Until billing has
    // produced an entitled account, enforcing would refuse every caller.
    expect(await decide({ route: "games" }, { enforced: false })).toEqual({
      allowed: true,
    });
  });

  it("raises rather than guessing when storage is unreadable", async () => {
    // Allowing would hand out the product on a DynamoDB blip; denying would
    // paywall a paying customer over an outage. Neither is this function's
    // call to make.
    await expect(
      decideProductAccess(
        { route: "games", authorization: `Bearer ${token()}` },
        { signingKeys: RING, enforced: true },
        identityOf({ accountId: ACCOUNT, tokenVersion: 1 }),
        {
          get: () => Promise.reject(new Error("dynamo-unavailable")),
        } as unknown as EntitlementRepository,
        NOW,
      ),
    ).rejects.toThrow("dynamo-unavailable");
  });
});
