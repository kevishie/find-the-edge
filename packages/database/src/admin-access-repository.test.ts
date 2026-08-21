import { describe, expect, it } from "vitest";
import {
  createAdminAuditEvent,
  createAdminDirectoryEntry,
  createIdentityAccount,
  createIdentityAuthorization,
  createManualAccessGrant,
  createOwnerBootstrap,
  deriveAccountId,
  phoneDigest,
} from "@find-the-edge/domain";
import {
  AdminAccessConflictError,
  AdminOwnerBootstrapRequiredError,
  DynamoAdminAccessRepository,
  MemoryAdminAccessRepository,
} from "./admin-access-repository";

const pepper = "permanent-account-pepper-value";
const ownerPhone = "+15551234567";
const friendPhone = "+15557654321";
const owner = deriveAccountId(ownerPhone, pepper);
const at = (minute: number) =>
  `2026-08-19T12:${String(minute).padStart(2, "0")}:00.000Z`;

describe("memory admin access repository", () => {
  it("fails closed until the configured owner bootstraps", async () => {
    const repository = new MemoryAdminAccessRepository();
    await expect(
      repository.completeVerifiedLogin({
        accountId: deriveAccountId(friendPhone, pepper),
        phoneDigest: phoneDigest(friendPhone, pepper),
        phoneNumber: friendPhone,
        now: at(0),
        ownerAccountId: owner,
        bootstrapMode: "fresh",
      }),
    ).rejects.toBeInstanceOf(AdminOwnerBootstrapRequiredError);
    const { directory: entry } = await repository.completeVerifiedLogin({
      accountId: owner,
      phoneDigest: phoneDigest(ownerPhone, pepper),
      phoneNumber: ownerPhone,
      now: at(1),
      ownerAccountId: owner,
      bootstrapMode: "fresh",
    });
    expect(entry.lifecycle).toBe("active");
  });

  it("reconciles a pending grant and makes retries idempotent", async () => {
    const repository = new MemoryAdminAccessRepository();
    const granted = await repository.grant({
      phoneDigest: phoneDigest(friendPhone, pepper),
      phoneNumber: friendPhone,
      now: at(0),
      operatorAccountId: owner,
      idempotencyKey: "grant-request-0001",
    });
    expect(granted.directory.lifecycle).toBe("pending");
    expect(
      (
        await repository.grant({
          phoneDigest: phoneDigest(friendPhone, pepper),
          phoneNumber: friendPhone,
          now: at(1),
          operatorAccountId: owner,
          idempotencyKey: "grant-request-0001",
        })
      ).manualGrant.version,
    ).toBe(1);
    const { directory: active } = await repository.completeVerifiedLogin({
      accountId: deriveAccountId(friendPhone, pepper),
      phoneDigest: phoneDigest(friendPhone, pepper),
      phoneNumber: friendPhone,
      now: at(2),
    });
    expect(active.lifecycle).toBe("active");
    expect(
      (await repository.get(active.directoryId))?.manualGrant?.active,
    ).toBe(true);
  });

  it("conflicts stale writes and revokes only the manual source", async () => {
    const repository = new MemoryAdminAccessRepository();
    const current = await repository.grant({
      phoneDigest: phoneDigest(friendPhone, pepper),
      phoneNumber: friendPhone,
      now: at(0),
      operatorAccountId: owner,
      idempotencyKey: "grant-request-0002",
    });
    await expect(
      repository.revoke({
        directoryId: current.directory.directoryId,
        expectedVersion: 0,
        now: at(1),
        operatorAccountId: owner,
        idempotencyKey: "revoke-request-0001",
      }),
    ).rejects.toBeInstanceOf(AdminAccessConflictError);
    const revoked = await repository.revoke({
      directoryId: current.directory.directoryId,
      expectedVersion: 1,
      now: at(2),
      operatorAccountId: owner,
      idempotencyKey: "revoke-request-0002",
    });
    expect(revoked.manualGrant).toMatchObject({ active: false, version: 2 });
  });

  it("binds every idempotency key to its original action and target", async () => {
    const repository = new MemoryAdminAccessRepository();
    const granted = await repository.grant({
      phoneDigest: phoneDigest(friendPhone, pepper),
      phoneNumber: friendPhone,
      now: at(0),
      operatorAccountId: owner,
      idempotencyKey: "shared-request-0001",
    });
    await expect(
      repository.revoke({
        directoryId: granted.directory.directoryId,
        expectedVersion: 1,
        now: at(1),
        operatorAccountId: owner,
        idempotencyKey: "shared-request-0001",
      }),
    ).rejects.toBeInstanceOf(AdminAccessConflictError);
    await expect(
      repository.grant({
        phoneDigest: phoneDigest("+15557654322", pepper),
        phoneNumber: "+15557654322",
        now: at(2),
        operatorAccountId: owner,
        idempotencyKey: "shared-request-0001",
      }),
    ).rejects.toBeInstanceOf(AdminAccessConflictError);
  });
});

const keyOf = (key: Record<string, unknown>) =>
  `${String(key["pk"])}|${String(key["sk"])}`;
class FakeDynamo {
  readonly items = new Map<string, Record<string, unknown>>();
  transactions: readonly Record<string, unknown>[] = [];
  queryItems: readonly Record<string, unknown>[] = [];
  lastEvaluatedKey: Record<string, unknown> | undefined;
  batchUnprocessed = false;
  failTransaction = false;
  commitThenConflict = false;
  async send(command: { input: Record<string, unknown> }) {
    await Promise.resolve();
    const input = command.input;
    if ("IndexName" in input)
      return {
        Items: this.queryItems,
        ...(this.lastEvaluatedKey
          ? { LastEvaluatedKey: this.lastEvaluatedKey }
          : {}),
      };
    if ("RequestItems" in input) {
      const request = (
        input["RequestItems"] as Record<
          string,
          { Keys: readonly Record<string, unknown>[] }
        >
      )["table"]!;
      return {
        Responses: {
          table: request.Keys.flatMap((key) => {
            const found = this.items.get(keyOf(key));
            return found ? [found] : [];
          }),
        },
        ...(this.batchUnprocessed
          ? { UnprocessedKeys: { table: { Keys: request.Keys } } }
          : {}),
      };
    }
    if ("TransactItems" in input) {
      this.transactions = input["TransactItems"] as readonly Record<
        string,
        unknown
      >[];
      if (this.commitThenConflict) {
        for (const operation of this.transactions) {
          const putOperation = operation["Put"] as
            { Item?: Record<string, unknown> } | undefined;
          if (putOperation?.Item)
            this.items.set(keyOf(putOperation.Item), putOperation.Item);
        }
        this.commitThenConflict = false;
        const conflict = new Error("concurrent-winner");
        conflict.name = "TransactionCanceledException";
        throw conflict;
      }
      if (this.failTransaction) throw new Error("audit-write-failed");
      return {};
    }
    const key = input["Key"] as Record<string, unknown>;
    const item = this.items.get(keyOf(key));
    return item ? { Item: item } : {};
  }
}

const put = (
  fake: FakeDynamo,
  key: Record<string, unknown>,
  value: Record<string, unknown>,
) => fake.items.set(keyOf(key), { ...key, ...value });

describe("Dynamo admin access aggregate transactions", () => {
  it("refuses verified mode without a complete owner aggregate", async () => {
    const repository = new DynamoAdminAccessRepository(
      new FakeDynamo() as never,
      "table",
    );
    await expect(
      repository.assertVerifiedLoginAllowed(owner, owner, "verified"),
    ).rejects.toThrow(/stored-admin-owner-invalid/);
  });

  it("strictly accepts bootstrap, migration, and recovery owner evidence", async () => {
    for (const [action, auditKey] of [
      ["owner-bootstrap", "ADMIN_AUDIT#owner-bootstrap"],
      ["owner-migrate", "ADMIN_AUDIT#owner-migrate"],
      ["owner-recover", `ADMIN_AUDIT#owner-recover#${"c".repeat(64)}`],
    ] as const) {
      const fake = new FakeDynamo();
      const directoryId = `directory:${"b".repeat(32)}`;
      put(
        fake,
        { pk: "ADMIN_OWNER", sk: "RECORD" },
        {
          value: createOwnerBootstrap({
            accountId: owner,
            directoryId,
            auditKey,
            createdAt: at(0),
          }),
        },
      );
      put(
        fake,
        { pk: `ACCOUNT#${owner}`, sk: "RECORD" },
        {
          value: createIdentityAccount({ accountId: owner, createdAt: at(0) }),
        },
      );
      put(
        fake,
        { pk: `ACCOUNT#${owner}`, sk: "AUTHORIZATION" },
        {
          value: createIdentityAuthorization({
            accountId: owner,
            roles: ["super-admin"],
            updatedAt: at(0),
            operatorId: "operator:owner",
          }),
        },
      );
      put(
        fake,
        { pk: `ADMIN_DIRECTORY#${"b".repeat(32)}`, sk: "RECORD" },
        {
          value: createAdminDirectoryEntry({
            phoneDigest: "b".repeat(32),
            phoneHint: "**67",
            accountId: owner,
            createdAt: at(0),
          }),
        },
      );
      put(
        fake,
        { pk: `ACCOUNT#${owner}`, sk: "ADMIN_DIRECTORY" },
        {
          directoryId,
        },
      );
      put(
        fake,
        { pk: auditKey, sk: "EVENT" },
        {
          value: createAdminAuditEvent({
            action,
            actor: "system",
            directoryId,
            occurredAt: at(0),
          }),
        },
      );
      const repository = new DynamoAdminAccessRepository(
        fake as never,
        "table",
      );
      await expect(
        repository.assertVerifiedLoginAllowed(owner, owner, "verified"),
      ).resolves.toBeUndefined();
      const audit = fake.items.get(`${auditKey}|EVENT`)!;
      fake.items.set(`${auditKey}|EVENT`, {
        ...audit,
        value: { ...(audit["value"] as object), occurredAt: at(1) },
      });
      await expect(
        repository.assertVerifiedLoginAllowed(owner, owner, "verified"),
      ).rejects.toThrow(/stored-admin-owner-invalid/);
    }
  });

  it("atomically bootstraps account, sole owner, authorization, directory, mapping, and one audit without PII", async () => {
    const fake = new FakeDynamo();
    const repository = new DynamoAdminAccessRepository(fake as never, "table");
    const result = await repository.completeVerifiedLogin({
      accountId: owner,
      phoneDigest: phoneDigest(ownerPhone, pepper),
      phoneNumber: ownerPhone,
      now: at(0),
      ownerAccountId: owner,
      bootstrapMode: "fresh",
    });
    expect(result.account.accountId).toBe(owner);
    expect(fake.transactions).toHaveLength(6);
    const serialized = JSON.stringify(fake.transactions);
    expect(serialized).not.toContain(ownerPhone);
    expect(serialized.match(/admin-access-audit-v1/g)).toHaveLength(1);
    expect(serialized).toContain("identity-account-v1");
    expect(serialized).toContain("owner-bootstrap-v1");
    expect(serialized).toContain("super-admin");
  });

  it("replays a complete concurrent owner aggregate and returning login adds no audit", async () => {
    const fake = new FakeDynamo();
    fake.commitThenConflict = true;
    const repository = new DynamoAdminAccessRepository(fake as never, "table");
    const first = await repository.completeVerifiedLogin({
      accountId: owner,
      phoneDigest: phoneDigest(ownerPhone, pepper),
      phoneNumber: ownerPhone,
      now: at(0),
      ownerAccountId: owner,
      bootstrapMode: "fresh",
    });
    expect(first.account.tokenVersion).toBe(1);
    const returned = await repository.completeVerifiedLogin({
      accountId: owner,
      phoneDigest: phoneDigest(ownerPhone, pepper),
      phoneNumber: ownerPhone,
      now: at(1),
      ownerAccountId: owner,
      bootstrapMode: "fresh",
    });
    expect(returned.account.tokenVersion).toBe(1);
    expect(fake.transactions).toHaveLength(1);
    expect(JSON.stringify(fake.transactions)).not.toContain(
      "admin-access-audit-v1",
    );
  });

  it("fails closed on a corrupt owner record", async () => {
    const fake = new FakeDynamo();
    put(
      fake,
      { pk: "ADMIN_OWNER", sk: "RECORD" },
      {
        value: {
          ...createOwnerBootstrap({
            accountId: owner,
            directoryId: `directory:${"b".repeat(32)}`,
            auditKey: "ADMIN_AUDIT#owner-bootstrap",
            createdAt: at(0),
          }),
          phoneNumber: ownerPhone,
        },
      },
    );
    const repository = new DynamoAdminAccessRepository(fake as never, "table");
    await expect(
      repository.assertVerifiedLoginAllowed(owner, owner, "fresh"),
    ).rejects.toThrow(/stored-admin-owner-invalid/);
  });

  it("puts pending activation, account, mapping, and one system audit in one transaction and rolls all back on audit failure", async () => {
    const fake = new FakeDynamo();
    const ownerDirectoryId = `directory:${"b".repeat(32)}`;
    const ownerRecord = createOwnerBootstrap({
      accountId: owner,
      directoryId: ownerDirectoryId,
      auditKey: "ADMIN_AUDIT#owner-bootstrap",
      createdAt: at(0),
    });
    put(fake, { pk: "ADMIN_OWNER", sk: "RECORD" }, { value: ownerRecord });
    put(
      fake,
      { pk: `ACCOUNT#${owner}`, sk: "RECORD" },
      {
        value: createIdentityAccount({ accountId: owner, createdAt: at(0) }),
      },
    );
    put(
      fake,
      { pk: `ACCOUNT#${owner}`, sk: "AUTHORIZATION" },
      {
        value: createIdentityAuthorization({
          accountId: owner,
          roles: ["super-admin"],
          updatedAt: at(0),
          operatorId: "operator:owner",
        }),
      },
    );
    const ownerDigest = ownerDirectoryId.slice("directory:".length);
    put(
      fake,
      { pk: `ADMIN_DIRECTORY#${ownerDigest}`, sk: "RECORD" },
      {
        value: createAdminDirectoryEntry({
          phoneDigest: ownerDigest,
          phoneHint: "**67",
          accountId: owner,
          createdAt: at(0),
        }),
      },
    );
    put(
      fake,
      { pk: `ACCOUNT#${owner}`, sk: "ADMIN_DIRECTORY" },
      {
        directoryId: ownerDirectoryId,
      },
    );
    put(
      fake,
      { pk: "ADMIN_AUDIT#owner-bootstrap", sk: "EVENT" },
      {
        value: createAdminAuditEvent({
          action: "owner-bootstrap",
          actor: "system",
          directoryId: ownerDirectoryId,
          occurredAt: at(0),
        }),
      },
    );
    const digest = phoneDigest(friendPhone, pepper);
    const pending = createAdminDirectoryEntry({
      phoneDigest: digest,
      phoneHint: "**21",
      createdAt: at(0),
    });
    put(
      fake,
      { pk: `ADMIN_DIRECTORY#${digest}`, sk: "RECORD" },
      {
        value: pending,
      },
    );
    fake.failTransaction = true;
    const repository = new DynamoAdminAccessRepository(fake as never, "table");
    await expect(
      repository.completeVerifiedLogin({
        accountId: deriveAccountId(friendPhone, pepper),
        phoneDigest: digest,
        phoneNumber: friendPhone,
        now: at(1),
        ownerAccountId: owner,
        bootstrapMode: "verified",
      }),
    ).rejects.toThrow(/audit-write-failed/);
    expect(fake.transactions).toHaveLength(4);
    const audit = JSON.stringify(fake.transactions.at(-1));
    expect(audit).toContain("login-reconciled");
    expect(audit).toContain('"actor":"system"');
    expect(
      fake.items.has(`ACCOUNT#${deriveAccountId(friendPhone, pepper)}|RECORD`),
    ).toBe(false);
    expect(
      (
        fake.items.get(`ADMIN_DIRECTORY#${digest}|RECORD`)?.["value"] as {
          lifecycle: string;
        }
      ).lifecycle,
    ).toBe("pending");
  });

  it("replays concurrent identical grant, grantExisting, and revoke winners but conflicts key reuse", async () => {
    const digest = phoneDigest(friendPhone, pepper);
    const directory = createAdminDirectoryEntry({
      phoneDigest: digest,
      phoneHint: "**21",
      createdAt: at(0),
    });

    const grantFake = new FakeDynamo();
    grantFake.commitThenConflict = true;
    const grantRepository = new DynamoAdminAccessRepository(
      grantFake as never,
      "table",
    );
    const granted = await grantRepository.grant({
      phoneDigest: digest,
      phoneNumber: friendPhone,
      now: at(0),
      operatorAccountId: owner,
      idempotencyKey: "concurrent-grant-0001",
    });
    expect(granted.manualGrant).toMatchObject({ active: true, version: 1 });
    await expect(
      grantRepository.grant({
        phoneDigest: phoneDigest("+15557654322", pepper),
        phoneNumber: "+15557654322",
        now: at(1),
        operatorAccountId: owner,
        idempotencyKey: "concurrent-grant-0001",
      }),
    ).rejects.toBeInstanceOf(AdminAccessConflictError);

    const existingFake = new FakeDynamo();
    put(
      existingFake,
      { pk: `ADMIN_DIRECTORY#${digest}`, sk: "RECORD" },
      {
        value: directory,
      },
    );
    existingFake.commitThenConflict = true;
    const existingRepository = new DynamoAdminAccessRepository(
      existingFake as never,
      "table",
    );
    expect(
      (
        await existingRepository.grantExisting({
          directoryId: directory.directoryId,
          expectedVersion: 0,
          now: at(0),
          operatorAccountId: owner,
          idempotencyKey: "concurrent-existing-0001",
        })
      ).manualGrant.version,
    ).toBe(1);

    const revokeFake = new FakeDynamo();
    put(
      revokeFake,
      { pk: `ADMIN_DIRECTORY#${digest}`, sk: "RECORD" },
      {
        value: directory,
      },
    );
    put(
      revokeFake,
      { pk: `ADMIN_DIRECTORY#${digest}`, sk: "MANUAL_ACCESS" },
      {
        value: createManualAccessGrant({
          directoryId: directory.directoryId,
          active: true,
          version: 1,
          createdAt: at(0),
          operatorId: "operator:owner",
        }),
      },
    );
    revokeFake.commitThenConflict = true;
    const revokeRepository = new DynamoAdminAccessRepository(
      revokeFake as never,
      "table",
    );
    expect(
      (
        await revokeRepository.revoke({
          directoryId: directory.directoryId,
          expectedVersion: 1,
          now: at(1),
          operatorAccountId: owner,
          idempotencyKey: "concurrent-revoke-0001",
        })
      ).manualGrant,
    ).toMatchObject({ active: false, version: 2 });
  });

  it("uses one bounded batch for grants and accepts only exact Dynamo cursor keys", async () => {
    const fake = new FakeDynamo();
    const digest = "d".repeat(32);
    const directory = createAdminDirectoryEntry({
      phoneDigest: digest,
      phoneHint: "**21",
      createdAt: at(0),
    });
    fake.queryItems = [{ value: directory }];
    put(
      fake,
      { pk: `ADMIN_DIRECTORY#${digest}`, sk: "MANUAL_ACCESS" },
      {
        value: createManualAccessGrant({
          directoryId: directory.directoryId,
          active: true,
          version: 1,
          createdAt: at(0),
          operatorId: "operator:owner",
        }),
      },
    );
    fake.lastEvaluatedKey = {
      pk: `ADMIN_DIRECTORY#${digest}`,
      sk: "RECORD",
      directoryPk: "ADMIN_DIRECTORY",
      directorySk: `${at(0)}#${directory.directoryId}`,
    };
    const repository = new DynamoAdminAccessRepository(fake as never, "table");
    const page = await repository.list({ limit: 100 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.manualGrant?.active).toBe(true);
    expect(page.cursor).not.toBeNull();
    await expect(
      repository.list({ limit: 100, cursor: page.cursor! }),
    ).resolves.toBeDefined();
    for (const invalid of [
      { ...fake.lastEvaluatedKey, extra: "x" },
      { ...fake.lastEvaluatedKey, pk: `ACCOUNT#${owner}` },
      { ...fake.lastEvaluatedKey, directoryPk: "OTHER" },
      {
        ...fake.lastEvaluatedKey,
        directorySk: `${at(0)}#directory:${"e".repeat(32)}`,
      },
    ])
      await expect(
        repository.list({
          limit: 100,
          cursor: Buffer.from(JSON.stringify(invalid)).toString("base64url"),
        }),
      ).rejects.toThrow(/admin-cursor-invalid/);
  });
});
