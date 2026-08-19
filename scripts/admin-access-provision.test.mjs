import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADMIN_PROVISION_ACCOUNT,
  ADMIN_PROVISION_REGION,
  buildAdminProvisionTransaction,
  marshalAdminProvisionTransaction,
  validateAdminProvisionInput,
} from "./admin-access-provision.mjs";

const pepper = "permanent-account-pepper-value";
const phoneNumber = "+15551234567";
const ownerAccountId = `account:${createHash("sha256").update(`fte:identity-account:v1|${pepper}|${phoneNumber}`).digest("hex")}`;
const now = "2026-08-19T12:00:00.000Z";
const base = {
  mode: "migrate",
  ownerAccountId,
  phoneNumber,
  accountPepper: pepper,
  tableName: "find-the-edge-staging",
  awsAccountId: ADMIN_PROVISION_ACCOUNT,
  region: ADMIN_PROVISION_REGION,
  stage: "staging",
  stackName: "FindTheEdge-staging-Foundation",
  changeId: "migration-request-0001",
  occurredAt: now,
};
const auth = (accountId, roles, updatedAt = "2026-08-18T12:00:00.000Z") => ({
  schemaVersion: "identity-authorization-v1",
  accountId,
  roles,
  updatedAt,
  operatorId: "operator:existing",
});

test("builds an exact redacted plan and preserves target reviewer/promoter roles", () => {
  assert.equal(
    validateAdminProvisionInput(base).derivedAccountId,
    ownerAccountId,
  );
  const transaction = buildAdminProvisionTransaction(base, {
    accountExists: true,
    targetAuthorization: auth(ownerAccountId, [
      "retrospective-reviewer",
      "strategy-promoter",
    ]),
  });
  const serialized = JSON.stringify(transaction);
  assert.doesNotMatch(serialized, new RegExp(phoneNumber.replace("+", "\\+")));
  assert.match(serialized, /ADMIN_AUDIT#owner-migrate/);
  const candidate = transaction.TransactItems[2].Put.Item.value;
  assert.deepEqual(candidate.roles, [
    "retrospective-reviewer",
    "strategy-promoter",
    "super-admin",
  ]);
  assert.deepEqual(
    transaction.TransactItems[2].Put.ExpressionAttributeValues[":expected"],
    auth(ownerAccountId, ["retrospective-reviewer", "strategy-promoter"]),
  );
  assert.ok(
    marshalAdminProvisionTransaction(transaction).TransactItems[0]
      .ConditionCheck.Key.pk.S,
  );
});

test("recovery atomically retires only the old super-admin role and is change-id stable", () => {
  const oldOwner = `account:${"a".repeat(64)}`;
  const currentOwner = {
    schemaVersion: "owner-bootstrap-v1",
    accountId: oldOwner,
    directoryId: `directory:${"b".repeat(32)}`,
    auditKey: "ADMIN_AUDIT#owner-migrate",
    createdAt: "2026-08-18T12:00:00.000Z",
  };
  const recovery = { ...base, mode: "recover", allowRecovery: true };
  const state = {
    accountExists: true,
    currentOwner,
    targetAuthorization: auth(ownerAccountId, ["strategy-promoter"]),
    previousOwnerAuthorization: auth(oldOwner, [
      "retrospective-reviewer",
      "super-admin",
    ]),
  };
  const first = buildAdminProvisionTransaction(recovery, state);
  const repeated = buildAdminProvisionTransaction(recovery, state);
  assert.deepEqual(repeated, first);
  const oldCandidate = first.TransactItems[3].Put.Item.value;
  assert.deepEqual(oldCandidate.roles, ["retrospective-reviewer"]);
  assert.deepEqual(
    first.TransactItems[1].Put.ExpressionAttributeValues[":expected"],
    currentOwner,
  );
  assert.match(JSON.stringify(first), /ADMIN_AUDIT#owner-recover#[a-f0-9]{64}/);
});

test("recovery rejects missing authority, a second target super-admin, and missing approval", () => {
  const oldOwner = `account:${"a".repeat(64)}`;
  const currentOwner = {
    schemaVersion: "owner-bootstrap-v1",
    accountId: oldOwner,
    directoryId: `directory:${"b".repeat(32)}`,
    auditKey: "ADMIN_AUDIT#owner-migrate",
    createdAt: "2026-08-18T12:00:00.000Z",
  };
  assert.throws(
    () => validateAdminProvisionInput({ ...base, mode: "recover" }),
    /recovery-not-approved/,
  );
  for (const state of [
    {
      accountExists: true,
      currentOwner,
      targetAuthorization: null,
      previousOwnerAuthorization: auth(oldOwner, []),
    },
    {
      accountExists: true,
      currentOwner,
      targetAuthorization: auth(ownerAccountId, ["super-admin"]),
      previousOwnerAuthorization: auth(oldOwner, ["super-admin"]),
    },
  ])
    assert.throws(
      () =>
        buildAdminProvisionTransaction(
          { ...base, mode: "recover", allowRecovery: true },
          state,
        ),
      /super-admin-authority-invalid/,
    );
});

test("binds execution to exact account, region, stack and table and passes region to every AWS operation", async () => {
  for (const change of [
    { awsAccountId: "000000000000" },
    { region: "us-west-2" },
    { stackName: "wrong" },
    { tableName: "*" },
  ])
    assert.throws(() => validateAdminProvisionInput({ ...base, ...change }));
  const source = await readFile(
    new URL("./admin-access-provision.mjs", import.meta.url),
    "utf8",
  );
  for (const command of [
    "get-caller-identity",
    "describe-stacks",
    "list-stack-resources",
    "describe-table",
    "get-item",
    "transact-write-items",
  ])
    assert.match(source, new RegExp(`"${command}"`));
  assert.match(source, /"--region"/);
  assert.match(source, /JSON\.stringify\(plan, null, 2\)/);
});
