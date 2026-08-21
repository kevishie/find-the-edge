import { describe, expect, it } from "vitest";
import {
  adminDirectoryId,
  composeProductAccess,
  createAdminAuditEvent,
  createAdminDirectoryEntry,
  createManualAccessGrant,
  createOwnerBootstrap,
  normalizeAdminAuditEvent,
  normalizeAdminDirectoryEntry,
  normalizeManualAccessGrant,
  normalizeOwnerBootstrap,
} from "./admin-access";

const digest = "a".repeat(32);
const now = "2026-08-19T12:00:00.000Z";

describe("admin access domain", () => {
  it("creates privacy-minimized pending and active directory entries", () => {
    const pending = createAdminDirectoryEntry({
      phoneDigest: digest,
      phoneHint: "**12",
      createdAt: now,
    });
    expect(pending).toEqual(
      expect.objectContaining({
        directoryId: adminDirectoryId(digest),
        accountId: null,
        lifecycle: "pending",
        phoneHint: "**12",
      }),
    );
    expect(JSON.stringify(pending)).not.toContain("+1");
    expect(() =>
      normalizeAdminDirectoryEntry({ ...pending, unexpected: true }),
    ).toThrow(/stored-admin-directory-invalid/);
  });

  it("strictly validates versioned manual grants", () => {
    const grant = createManualAccessGrant({
      directoryId: adminDirectoryId(digest),
      active: true,
      version: 1,
      createdAt: now,
      operatorId: "operator:owner",
    });
    expect(normalizeManualAccessGrant(grant)).toEqual(grant);
    expect(() => normalizeManualAccessGrant({ ...grant, version: 0 })).toThrow(
      /stored-manual-access-invalid/,
    );
  });

  it("strictly normalizes privacy-safe owner bootstrap records", () => {
    const owner = createOwnerBootstrap({
      accountId: `account:${"b".repeat(64)}`,
      directoryId: adminDirectoryId(digest),
      auditKey: "ADMIN_AUDIT#owner-bootstrap",
      createdAt: now,
    });
    expect(normalizeOwnerBootstrap(owner)).toEqual(owner);
    expect(() =>
      normalizeOwnerBootstrap({ ...owner, phoneNumber: "+15551234567" }),
    ).toThrow(/stored-owner-bootstrap-invalid/);
    expect(() =>
      normalizeOwnerBootstrap({ ...owner, createdAt: "today" }),
    ).toThrow(/stored-owner-bootstrap-invalid/);
    expect(() =>
      normalizeOwnerBootstrap({
        ...owner,
        auditKey: "ADMIN_AUDIT#owner-recover#not-a-digest",
      }),
    ).toThrow(/stored-owner-bootstrap-invalid/);
  });

  it("closes audit actions, actors, versions, and stored keys", () => {
    const audit = createAdminAuditEvent({
      action: "manual-grant",
      actor: "operator:owner",
      directoryId: adminDirectoryId(digest),
      grantVersion: 1,
      occurredAt: now,
    });
    expect(normalizeAdminAuditEvent(audit)).toEqual(audit);
    expect(() =>
      createAdminAuditEvent({
        action: "login-reconciled",
        actor: "operator:owner",
        directoryId: adminDirectoryId(digest),
        occurredAt: now,
      }),
    ).toThrow(/admin-audit-actor-invalid/);
    expect(() =>
      normalizeAdminAuditEvent({ ...audit, phone: "+1555" }),
    ).toThrow(/stored-admin-audit-invalid/);
  });

  it.each([
    [{ superAdmin: true, stripe: "inactive", manual: false }, "granted"],
    [{ superAdmin: false, stripe: "active", manual: false }, "granted"],
    [{ superAdmin: false, stripe: "inactive", manual: true }, "granted"],
    [{ superAdmin: false, stripe: "inactive", manual: false }, "denied"],
    [
      { superAdmin: false, stripe: "unavailable", manual: false },
      "unavailable",
    ],
    [{ superAdmin: true, stripe: "unavailable", manual: false }, "granted"],
  ] as const)("composes independent access sources %#", (input, outcome) => {
    expect(composeProductAccess(input).outcome).toBe(outcome);
  });
});
