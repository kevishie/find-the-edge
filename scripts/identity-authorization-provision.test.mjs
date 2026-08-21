import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUTHORIZATION_DESIRED_STATES,
  buildAuthorizationTransaction,
  decodeProvisionItem,
  executeAuthorizationProvision,
  normalizeProvisionAccount,
  normalizeProvisionAudit,
  normalizeProvisionAuthorization,
  safeAuthorizationProvisionError,
  validateAuthorizationProvisionAwsIdentity,
  validateAuthorizationProvisionEnvironment,
  validateAuthorizationProvisionTarget,
} from "./identity-authorization-provision.mjs";

const ACCOUNT_ID = `account:${"a".repeat(64)}`;
const OTHER_ACCOUNT_ID = `account:${"b".repeat(64)}`;
const NOW = "2026-08-14T16:00:00.000Z";
const PRIOR = "2026-08-14T15:00:00.000Z";

const environment = (overrides = {}) => ({
  AWS_ACCOUNT_ID: "228246988391",
  AWS_REGION: "us-east-1",
  FTE_AWS_STAGE: "staging",
  FTE_AUTHORIZATION_MODE: "dry-run",
  FTE_AUTHORIZATION_DESIRED: "both",
  FTE_AUTHORIZATION_ACCOUNT_ID: ACCOUNT_ID,
  FTE_AUTHORIZATION_EXPECTED_UPDATED_AT: "absent",
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "kevishie/find-the-edge",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF:
    "kevishie/find-the-edge/.github/workflows/provision-identity-authorization.yml@refs/heads/main",
  GITHUB_JOB: "provision",
  GITHUB_RUN_ID: "123456",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_ACTOR_ID: "98765",
  GITHUB_SHA: "c".repeat(40),
  ...overrides,
});

const account = (id = ACCOUNT_ID) => ({
  schemaVersion: "identity-account-v1",
  accountId: id,
  tokenVersion: 1,
  createdAt: "2026-08-14T14:00:00.000Z",
  lastSignedInAt: "2026-08-14T14:30:00.000Z",
});

const authorization = (roles = ["retrospective-reviewer"]) => ({
  schemaVersion: "identity-authorization-v1",
  accountId: ACCOUNT_ID,
  roles,
  updatedAt: PRIOR,
  operatorId: "operator:github-1",
});

test("environment binding accepts only protected branch targets and closed inputs", () => {
  const staging = validateAuthorizationProvisionEnvironment(environment());
  assert.deepEqual(staging.target, {
    branch: "main",
    stage: "staging",
    githubEnvironment: "staging",
    stackName: "FindTheEdge-staging-Foundation",
  });
  assert.deepEqual(staging.desiredRoles, [
    "retrospective-reviewer",
    "strategy-promoter",
  ]);
  assert.equal(staging.operatorId, "operator:github-98765");
  assert.equal(staging.changeId, "github:123456:2");

  const production = validateAuthorizationProvisionEnvironment(
    environment({
      FTE_AWS_STAGE: "prod",
      GITHUB_REF: "refs/heads/production",
      GITHUB_WORKFLOW_REF:
        "kevishie/find-the-edge/.github/workflows/provision-identity-authorization.yml@refs/heads/production",
      FTE_AUTHORIZATION_DESIRED: "none",
    }),
  );
  assert.equal(production.target.githubEnvironment, "production");
  assert.deepEqual(production.desiredRoles, []);

  for (const overrides of [
    { GITHUB_REF: "refs/heads/feature" },
    { AWS_REGION: "us-west-2" },
    { FTE_AWS_STAGE: "prod" },
    { FTE_AUTHORIZATION_DESIRED: "admin" },
    { FTE_AUTHORIZATION_ACCOUNT_ID: OTHER_ACCOUNT_ID.toUpperCase() },
    { FTE_AUTHORIZATION_EXPECTED_UPDATED_AT: "2026-08-14T15:00:00Z" },
    { GITHUB_ACTOR_ID: "person@example.com" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_SHA: "short" },
    { FTE_AUTHORIZATION_APPLY: "SET-ROLES" },
  ])
    assert.throws(
      () => validateAuthorizationProvisionEnvironment(environment(overrides)),
      /identity-authorization-provision-/,
    );

  assert.equal(
    validateAuthorizationProvisionEnvironment(
      environment({
        FTE_AUTHORIZATION_MODE: "apply",
        FTE_AUTHORIZATION_APPLY: "SET-ROLES",
      }),
    ).mode,
    "apply",
  );
  const longestToken = validateAuthorizationProvisionEnvironment(
    environment({
      GITHUB_RUN_ID: "9".repeat(20),
      GITHUB_RUN_ATTEMPT: "9".repeat(5),
    }),
  ).clientRequestToken;
  assert.ok(longestToken.length <= 36);
});

test("target validation binds one active stage table and exact AWS identity", () => {
  const target = {
    stackName: "FindTheEdge-staging-Foundation",
    githubEnvironment: "staging",
  };
  const stack = {
    StackName: target.stackName,
    StackId:
      "arn:aws:cloudformation:us-east-1:228246988391:stack/FindTheEdge-staging-Foundation/id",
    StackStatus: "UPDATE_COMPLETE",
  };
  const resources = [
    {
      LogicalResourceId: "EventIngestionTableABC",
      ResourceType: "AWS::DynamoDB::Table",
      PhysicalResourceId: "FindTheEdge-staging-table",
    },
  ];
  const table = {
    TableName: "FindTheEdge-staging-table",
    TableArn:
      "arn:aws:dynamodb:us-east-1:228246988391:table/FindTheEdge-staging-table",
    TableStatus: "ACTIVE",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
  };
  assert.deepEqual(
    validateAuthorizationProvisionTarget({ target, stack, resources, table }),
    {
      stackId: stack.StackId,
      tableName: table.TableName,
      tableArn: table.TableArn,
    },
  );
  assert.doesNotThrow(() =>
    validateAuthorizationProvisionTarget({
      target,
      stack,
      resources,
      table: { ...table, KeySchema: [...table.KeySchema].reverse() },
    }),
  );
  assert.doesNotThrow(() =>
    validateAuthorizationProvisionAwsIdentity(
      {
        Account: "228246988391",
        Arn: "arn:aws:sts::228246988391:assumed-role/github-actions-find-the-edge-staging-authorization-operator/run",
        UserId: "role:run",
      },
      target,
    ),
  );
  assert.throws(
    () =>
      validateAuthorizationProvisionAwsIdentity(
        {
          Account: "000000000000",
          Arn: "arn",
          UserId: "id",
        },
        target,
      ),
    /aws-identity-invalid/,
  );
  for (const arn of [
    "arn:aws:sts::228246988391:assumed-role/github-actions-find-the-edge-staging-deploy/run",
    "arn:aws:sts::228246988391:assumed-role/github-actions-find-the-edge-production-authorization-operator/run",
  ])
    assert.throws(
      () =>
        validateAuthorizationProvisionAwsIdentity(
          { Account: "228246988391", Arn: arn, UserId: "role:run" },
          target,
        ),
      /aws-identity-invalid/,
    );
  assert.throws(
    () =>
      validateAuthorizationProvisionTarget({
        target,
        stack,
        resources: [...resources, { ...resources[0] }],
        table,
      }),
    /table-binding-invalid/,
  );
  assert.throws(
    () =>
      validateAuthorizationProvisionTarget({
        target,
        stack,
        resources,
        table: { ...table, TableStatus: "UPDATING" },
      }),
    /table-invalid/,
  );
});

test("stored account, authorization, and audit contracts are exact and canonical", () => {
  assert.deepEqual(normalizeProvisionAccount(account(), ACCOUNT_ID), account());
  assert.deepEqual(
    normalizeProvisionAuthorization(authorization(), ACCOUNT_ID),
    authorization(),
  );
  for (const malformed of [
    { ...account(), accountId: OTHER_ACCOUNT_ID },
    { ...account(), extra: true },
    { ...account(), tokenVersion: 0 },
  ])
    assert.throws(
      () => normalizeProvisionAccount(malformed, ACCOUNT_ID),
      /account-record-invalid/,
    );
  for (const malformed of [
    {
      ...authorization(),
      roles: ["strategy-promoter", "retrospective-reviewer"],
    },
    { ...authorization(), roles: ["admin"] },
    { ...authorization(), updatedAt: "2026-08-14T15:00:00Z" },
    { ...authorization(), extra: true },
  ])
    assert.throws(
      () => normalizeProvisionAuthorization(malformed, ACCOUNT_ID),
      /identity-authorization-provision-/,
    );

  const expected = {
    accountId: ACCOUNT_ID,
    beforeRoles: ["retrospective-reviewer"],
    afterRoles: ["retrospective-reviewer", "strategy-promoter"],
    previousUpdatedAt: PRIOR,
    updatedAt: NOW,
    operatorId: "operator:github-98765",
    changeId: "github:123456:2",
    releaseSha: "c".repeat(40),
  };
  assert.deepEqual(
    normalizeProvisionAudit(
      { schemaVersion: "identity-authorization-audit-v1", ...expected },
      expected,
    ),
    { schemaVersion: "identity-authorization-audit-v1", ...expected },
  );
});

const config = (overrides = {}) => ({
  ...validateAuthorizationProvisionEnvironment(
    environment({
      FTE_AUTHORIZATION_MODE: "apply",
      FTE_AUTHORIZATION_APPLY: "SET-ROLES",
    }),
  ),
  ...overrides,
});

const harness = ({ current = null, corruptReadback = false } = {}) => {
  let storedCurrent = current;
  const audits = new Map();
  const transactions = [];
  return {
    transactions,
    operations: {
      tableName: "FindTheEdge-staging-table",
      readAccount: async () => account(),
      readAuthorization: async () => storedCurrent,
      readAudit: async (key) => audits.get(key.sk) ?? null,
      transact: async (transaction) => {
        transactions.push(transaction);
        const currentItem = decodeProvisionItem(
          transaction.TransactItems[1].Put.Item,
        );
        const auditItem = decodeProvisionItem(
          transaction.TransactItems[2].Put.Item,
        );
        storedCurrent = corruptReadback
          ? { ...currentItem.value, roles: [] }
          : currentItem.value;
        audits.set(auditItem.sk, auditItem.value);
      },
    },
  };
};

test("dry run makes exact reads and never mutates", async () => {
  const state = harness({ current: authorization() });
  const result = await executeAuthorizationProvision(
    config({ mode: "dry-run" }),
    state.operations,
    new Date(NOW),
  );
  assert.equal(result.outcome, "planned");
  assert.equal(result.previousUpdatedAt, PRIOR);
  assert.deepEqual(result.beforeRoles, ["retrospective-reviewer"]);
  assert.deepEqual(result.afterRoles, AUTHORIZATION_DESIRED_STATES.both);
  assert.equal(state.transactions.length, 0);
});

test("apply atomically fences account and current state, audits, and reads back", async () => {
  const state = harness();
  const result = await executeAuthorizationProvision(
    config(),
    state.operations,
    new Date(NOW),
  );
  assert.equal(result.outcome, "applied");
  assert.equal(result.updatedAt, NOW);
  assert.match(result.auditKey, /^AUTHORIZATION_AUDIT#/);
  assert.equal(state.transactions.length, 1);
  const transaction = state.transactions[0];
  assert.equal(transaction.TransactItems.length, 3);
  assert.match(
    transaction.TransactItems[0].ConditionCheck.ConditionExpression,
    /expectedAccount/,
  );
  assert.equal(
    transaction.TransactItems[1].Put.ConditionExpression,
    "attribute_not_exists(pk)",
  );
  assert.equal(
    transaction.TransactItems[2].Put.ConditionExpression,
    "attribute_not_exists(pk)",
  );
  assert.doesNotMatch(JSON.stringify(transaction), /Scan|Query|secret/i);
});

test("update requires the exact expected version and canonical current material", async () => {
  const current = authorization();
  const state = harness({ current });
  const result = await executeAuthorizationProvision(
    config({ expectedUpdatedAt: PRIOR }),
    state.operations,
    new Date(NOW),
  );
  assert.equal(result.outcome, "applied");
  const update = state.transactions[0].TransactItems[1].Put;
  assert.match(update.ConditionExpression, /expectedCurrent/);
  assert.match(
    update.ConditionExpression,
    /#value\.#[uU]pdatedAt < :updatedAt/,
  );

  await assert.rejects(
    executeAuthorizationProvision(
      config({ expectedUpdatedAt: "2026-08-14T14:59:00.000Z" }),
      harness({ current }).operations,
      new Date(NOW),
    ),
    /expected-state-conflict/,
  );
});

test("same state is a no-op and failures remain fail-closed", async () => {
  const noOp = harness({
    current: authorization(AUTHORIZATION_DESIRED_STATES.both),
  });
  const result = await executeAuthorizationProvision(
    config({ expectedUpdatedAt: PRIOR }),
    noOp.operations,
    new Date(NOW),
  );
  assert.equal(result.outcome, "no-op");
  assert.equal(noOp.transactions.length, 0);

  const missing = harness();
  missing.operations.readAccount = async () => null;
  await assert.rejects(
    executeAuthorizationProvision(config(), missing.operations, new Date(NOW)),
    /account-missing/,
  );

  await assert.rejects(
    executeAuthorizationProvision(
      config(),
      harness({ corruptReadback: true }).operations,
      new Date(NOW),
    ),
    /readback-mismatch/,
  );
  for (const corruptCurrent of ["", 0, false])
    await assert.rejects(
      executeAuthorizationProvision(
        config({ mode: "dry-run" }),
        harness({ current: corruptCurrent }).operations,
        new Date(NOW),
      ),
      /authorization-record-invalid/,
    );
  assert.equal(
    safeAuthorizationProvisionError(
      new Error("AccessDenied for token secret and account material"),
    ),
    "identity-authorization-provision-failed",
  );
});

test("transaction builder never accepts a caller-supplied next timestamp", () => {
  const candidate = {
    schemaVersion: "identity-authorization-v1",
    accountId: ACCOUNT_ID,
    roles: AUTHORIZATION_DESIRED_STATES.both,
    updatedAt: NOW,
    operatorId: "operator:github-98765",
  };
  const audit = {
    schemaVersion: "identity-authorization-audit-v1",
    accountId: ACCOUNT_ID,
    beforeRoles: [],
    afterRoles: AUTHORIZATION_DESIRED_STATES.both,
    previousUpdatedAt: null,
    updatedAt: NOW,
    operatorId: "operator:github-98765",
    changeId: "github:123456:2",
    releaseSha: "c".repeat(40),
  };
  const transaction = buildAuthorizationTransaction({
    tableName: "FindTheEdge-staging-table",
    config: config(),
    account: account(),
    current: null,
    candidate,
    audit,
  });
  assert.equal(transaction.ClientRequestToken, "fte-auth-123456-2");
  assert.ok(transaction.ClientRequestToken.length <= 36);
  assert.equal(
    decodeProvisionItem(transaction.TransactItems[1].Put.Item).value.updatedAt,
    NOW,
  );
  assert.throws(
    () => decodeProvisionItem({ value: { BOOL: true } }),
    /aws-item-invalid/,
  );
});

test("live provisioner has no scan, query, secret, delete, or public endpoint path", async () => {
  const source = await readFile(
    new URL("./identity-authorization-provision.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /["'](?:scan|query|delete-item|get-secret-value)["']|\/auth\//i,
  );
  for (const command of [
    "get-caller-identity",
    "describe-stacks",
    "list-stack-resources",
    "describe-table",
    "get-item",
    "transact-write-items",
  ])
    assert.ok(
      source.includes(`"${command}"`),
      `missing exact command ${command}`,
    );
});
