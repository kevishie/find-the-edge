import { describe, expect, it } from "vitest";
import { deriveAccountId } from "./identity.js";
import {
  createIdentityAuthorization,
  IDENTITY_AUTHORIZATION_CAPABILITIES,
  IDENTITY_AUTHORIZATION_ROLES,
  identityAuthorizationCapabilities,
  isIdentityAuthorizationOperatorId,
  isIdentityAuthorizationRole,
  normalizeIdentityAuthorization,
} from "./identity-authorization.js";

const ACCOUNT_ID = deriveAccountId(
  "+15557654321",
  "account-pepper-value-0123456789ab",
);
const NOW = "2026-08-14T12:00:00.000Z";

describe("identity authorization", () => {
  it("creates one canonical, immutable server-owned role record", () => {
    const record = createIdentityAuthorization({
      accountId: ACCOUNT_ID,
      roles: ["strategy-promoter", "retrospective-reviewer"],
      updatedAt: NOW,
      operatorId: "operator:access-control-bot",
    });

    expect(record).toEqual({
      schemaVersion: "identity-authorization-v1",
      accountId: ACCOUNT_ID,
      roles: ["retrospective-reviewer", "strategy-promoter"],
      updatedAt: NOW,
      operatorId: "operator:access-control-bot",
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.roles)).toBe(true);
    expect(normalizeIdentityAuthorization(record)).toEqual(record);
    expect(() =>
      normalizeIdentityAuthorization({
        ...record,
        roles: ["strategy-promoter", "retrospective-reviewer"],
      }),
    ).toThrow("stored-identity-authorization-invalid");
  });

  it("allows an explicit empty role set without inventing access", () => {
    expect(
      createIdentityAuthorization({
        accountId: ACCOUNT_ID,
        roles: [],
        updatedAt: NOW,
        operatorId: "operator:bootstrap",
      }).roles,
    ).toEqual([]);
  });

  it("recognizes only the two closed elevated roles", () => {
    expect(IDENTITY_AUTHORIZATION_ROLES).toEqual([
      "retrospective-reviewer",
      "strategy-promoter",
    ]);
    for (const role of IDENTITY_AUTHORIZATION_ROLES)
      expect(isIdentityAuthorizationRole(role)).toBe(true);
    for (const value of [
      "admin",
      "fte-retrospective-reviewers",
      "Retrospective-Reviewer",
      " retrospective-reviewer",
      "",
      null,
      1,
    ])
      expect(isIdentityAuthorizationRole(value)).toBe(false);
  });

  it("projects roles to canonical full-scope capabilities", () => {
    expect(IDENTITY_AUTHORIZATION_CAPABILITIES).toEqual([
      "events/retrospectives:approve",
      "events/strategies:promote",
    ]);
    expect(
      identityAuthorizationCapabilities([
        "strategy-promoter",
        "retrospective-reviewer",
      ]),
    ).toEqual(["events/retrospectives:approve", "events/strategies:promote"]);
    expect(identityAuthorizationCapabilities([])).toEqual([]);
    expect(() =>
      identityAuthorizationCapabilities(["admin" as "retrospective-reviewer"]),
    ).toThrow("identity-authorization-roles-invalid");
  });

  it("rejects unknown, duplicate, and over-sized role sets", () => {
    for (const roles of [
      ["admin"],
      ["retrospective-reviewer", "retrospective-reviewer"],
      ["retrospective-reviewer", "strategy-promoter", "retrospective-reviewer"],
      "retrospective-reviewer",
      null,
    ])
      expect(() =>
        createIdentityAuthorization({
          accountId: ACCOUNT_ID,
          roles: roles as unknown[],
          updatedAt: NOW,
          operatorId: "operator:test",
        }),
      ).toThrow("identity-authorization-roles-invalid");
  });

  it("accepts only bounded non-PII operator handles", () => {
    for (const value of [
      "operator:a",
      "operator:release-bot",
      "operator:security.review_2",
      `operator:${"a".repeat(64)}`,
    ])
      expect(isIdentityAuthorizationOperatorId(value)).toBe(true);

    for (const value of [
      "admin",
      "operator:",
      "operator:-admin",
      "operator:admin-",
      "operator:Jane Doe",
      "operator:jane@example.com",
      "operator:+15557654321",
      "operator:ADMIN",
      `operator:${"a".repeat(65)}`,
      null,
    ])
      expect(isIdentityAuthorizationOperatorId(value)).toBe(false);
  });

  it("rejects malformed account, time, and operator fields", () => {
    const base = {
      accountId: ACCOUNT_ID,
      roles: ["retrospective-reviewer"] as const,
      updatedAt: NOW,
      operatorId: "operator:test",
    };
    expect(() =>
      createIdentityAuthorization({ ...base, accountId: "account:short" }),
    ).toThrow("identity-authorization-account-id-invalid");
    for (const updatedAt of [
      "2026-08-14",
      "2026-08-14T12:00:00Z",
      "not-a-time",
    ])
      expect(() => createIdentityAuthorization({ ...base, updatedAt })).toThrow(
        "identity-authorization-updated-at-invalid",
      );
    expect(() =>
      createIdentityAuthorization({
        ...base,
        operatorId: "operator:user@example.com",
      }),
    ).toThrow("identity-authorization-operator-id-invalid");
  });

  it("fails closed on every corrupt stored representation", () => {
    const valid = createIdentityAuthorization({
      accountId: ACCOUNT_ID,
      roles: ["retrospective-reviewer"],
      updatedAt: NOW,
      operatorId: "operator:test",
    });
    for (const stored of [
      null,
      [],
      "authorization",
      { ...valid, schemaVersion: "identity-authorization-v2" },
      { ...valid, accountId: "account:short" },
      { ...valid, roles: ["admin"] },
      {
        ...valid,
        roles: ["retrospective-reviewer", "retrospective-reviewer"],
      },
      { ...valid, updatedAt: "2026-08-14T12:00:00Z" },
      { ...valid, operatorId: "operator:user@example.com" },
      { ...valid, clientSupplied: true },
    ])
      expect(() => normalizeIdentityAuthorization(stored)).toThrow(
        "stored-identity-authorization-invalid",
      );
  });
});
