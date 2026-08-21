import { describe, expect, it, vi } from "vitest";
import {
  createAdminDirectoryEntry,
  deriveAccountId,
} from "@find-the-edge/domain";
import {
  MemoryAdminAccessRepository,
  type AdminAccessRepository,
} from "@find-the-edge/database";
import { createAdminHttpHandler } from "./admin-handler";

const pepper = "permanent-account-pepper-value";
const owner = deriveAccountId("+15551234567", pepper);
const now = new Date("2026-08-19T12:00:00.000Z");

const setup = () => {
  const repository = new MemoryAdminAccessRepository();
  const handler = createAdminHttpHandler(
    repository,
    { get: vi.fn().mockResolvedValue(null) },
    { get: vi.fn().mockResolvedValue(null) },
    pepper,
    () => now,
  );
  return { repository, handler };
};

describe("admin HTTP handler", () => {
  it("strongly authorizes every request", async () => {
    const { handler } = setup();
    expect(
      (
        await handler({
          route: "admin-users-list",
          method: "GET",
          adminAuthorized: false,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await handler({
          route: "admin-users-list",
          method: "GET",
          subject: owner,
          adminAuthorized: false,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("grants a pending phone, lists it, and rejects an invalid revoke version", async () => {
    const { handler } = setup();
    const granted = await handler({
      route: "admin-access-grant",
      method: "POST",
      subject: owner,
      adminAuthorized: true,
      idempotencyKey: "grant-request-0001",
      contentType: "application/json",
      body: JSON.stringify({ phoneNumber: "+15557654321" }),
    });
    expect(granted.statusCode).toBe(200);
    const grantedBody: unknown = JSON.parse(granted.body);
    if (
      !grantedBody ||
      typeof grantedBody !== "object" ||
      !("user" in grantedBody) ||
      !grantedBody.user ||
      typeof grantedBody.user !== "object" ||
      !("directoryId" in grantedBody.user) ||
      typeof grantedBody.user.directoryId !== "string"
    )
      throw new Error("invalid-test-response");
    const user = grantedBody.user;
    const directoryId = user.directoryId as string;
    expect(user).toMatchObject({
      lifecycle: "pending",
      phoneHint: "**21",
      manualGrant: { active: true, version: 1 },
    });
    expect(granted.body).not.toContain("+15557654321");
    const listed = await handler({
      route: "admin-users-list",
      method: "GET",
      subject: owner,
      adminAuthorized: true,
    });
    const listedBody: unknown = JSON.parse(listed.body);
    if (
      !listedBody ||
      typeof listedBody !== "object" ||
      !("items" in listedBody) ||
      !Array.isArray(listedBody.items)
    )
      throw new Error("invalid-test-response");
    expect(listedBody.items).toHaveLength(1);
    const stale = await handler({
      route: "admin-access-revoke",
      method: "DELETE",
      subject: owner,
      adminAuthorized: true,
      directoryId,
      idempotencyKey: "revoke-request-0001",
      query: { version: "0" },
    });
    expect(stale.statusCode).toBe(400);
  });

  it("fails the directory closed when server-owned roles are unreadable", async () => {
    const repository = new MemoryAdminAccessRepository();
    await repository.completeVerifiedLogin({
      accountId: owner,
      phoneDigest: "a".repeat(32),
      phoneNumber: "+15551234567",
      now: now.toISOString(),
      ownerAccountId: owner,
      bootstrapMode: "fresh",
    });
    const handler = createAdminHttpHandler(
      repository,
      { get: vi.fn().mockResolvedValue(null) },
      { get: vi.fn().mockRejectedValue(new Error("storage detail")) },
      pepper,
      () => now,
    );
    expect(
      (
        await handler({
          route: "admin-users-list",
          method: "GET",
          subject: owner,
          adminAuthorized: true,
        })
      ).statusCode,
    ).toBe(500);
  });

  it("rejects unsafe, zero, and negative DELETE versions as bad requests", async () => {
    const { handler } = setup();
    for (const version of ["0", "-1", "9007199254740992", "1.5"])
      expect(
        (
          await handler({
            route: "admin-access-revoke",
            method: "DELETE",
            subject: owner,
            adminAuthorized: true,
            directoryId: `directory:${"a".repeat(32)}`,
            idempotencyKey: "revoke-version-0001",
            query: { version },
          })
        ).statusCode,
      ).toBe(400);
  });

  it("bounds source-read concurrency for a 100-row page", async () => {
    const pageItems = Array.from({ length: 100 }, (_, index) => ({
      directory: createAdminDirectoryEntry({
        phoneDigest: index.toString(16).padStart(32, "0"),
        phoneHint: `**${String(index).padStart(2, "0").slice(-2)}`,
        createdAt: now.toISOString(),
      }),
      manualGrant: null,
    }));
    let active = 0;
    let maximum = 0;
    const handler = createAdminHttpHandler(
      {
        list: vi.fn().mockResolvedValue({ items: pageItems, cursor: null }),
      } as unknown as AdminAccessRepository,
      {
        get: vi.fn(async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active -= 1;
          return null;
        }),
      },
      { get: vi.fn().mockResolvedValue(null) },
      pepper,
      () => now,
    );
    expect(
      (
        await handler({
          route: "admin-users-list",
          method: "GET",
          subject: owner,
          adminAuthorized: true,
          query: { limit: "100" },
        })
      ).statusCode,
    ).toBe(200);
    expect(maximum).toBeLessThanOrEqual(10);
  });
});
