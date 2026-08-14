import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AUTHORIZATION_ACCOUNT = "228246988391";
export const AUTHORIZATION_REGION = "us-east-1";
export const AUTHORIZATION_MODES = new Set(["dry-run", "apply"]);
export const AUTHORIZATION_DESIRED_STATES = Object.freeze({
  none: Object.freeze([]),
  "retrospective-reviewer": Object.freeze(["retrospective-reviewer"]),
  "strategy-promoter": Object.freeze(["strategy-promoter"]),
  both: Object.freeze(["retrospective-reviewer", "strategy-promoter"]),
});

const AUTHORIZATION_ROLES = Object.freeze([
  "retrospective-reviewer",
  "strategy-promoter",
]);
const ACCOUNT_ID = /^account:[a-f0-9]{64}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGITS = /^\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const STACK_STATUSES = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
]);

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) =>
  record(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const bounded = (value, maximum) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const canonicalInstant = (value) =>
  typeof value === "string" &&
  CANONICAL_INSTANT.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const accountId = (value) =>
  typeof value === "string" && ACCOUNT_ID.test(value);

export const safeAuthorizationProvisionError = (error) => {
  const message = error instanceof Error ? error.message : "";
  return /^identity-authorization-provision-[a-z0-9-]+$/.test(message) &&
    message.length <= 128
    ? message
    : "identity-authorization-provision-failed";
};

const fail = (suffix) => {
  throw new Error(`identity-authorization-provision-${suffix}`);
};

const branchTarget = (ref) => {
  if (ref === "refs/heads/main")
    return {
      branch: "main",
      stage: "staging",
      githubEnvironment: "staging",
      stackName: "FindTheEdge-staging-Foundation",
    };
  if (ref === "refs/heads/production")
    return {
      branch: "production",
      stage: "prod",
      githubEnvironment: "production",
      stackName: "FindTheEdge-prod-Foundation",
    };
  fail("branch-invalid");
};

const boundedDigits = (value, maximum) =>
  bounded(value, maximum) && DIGITS.test(value);

export function validateAuthorizationProvisionEnvironment(environment) {
  const mode = environment.FTE_AUTHORIZATION_MODE ?? "dry-run";
  if (!AUTHORIZATION_MODES.has(mode)) fail("mode-invalid");
  const desired = environment.FTE_AUTHORIZATION_DESIRED;
  if (!Object.hasOwn(AUTHORIZATION_DESIRED_STATES, desired ?? ""))
    fail("desired-state-invalid");
  const target = branchTarget(environment.GITHUB_REF);
  if (
    environment.AWS_ACCOUNT_ID !== AUTHORIZATION_ACCOUNT ||
    environment.AWS_REGION !== AUTHORIZATION_REGION ||
    environment.FTE_AWS_STAGE !== target.stage
  )
    fail("target-invalid");
  if (!accountId(environment.FTE_AUTHORIZATION_ACCOUNT_ID))
    fail("account-id-invalid");
  const expectedUpdatedAt = environment.FTE_AUTHORIZATION_EXPECTED_UPDATED_AT;
  if (expectedUpdatedAt !== "absent" && !canonicalInstant(expectedUpdatedAt))
    fail("expected-updated-at-invalid");
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_REPOSITORY !== "kevishie/find-the-edge" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_JOB !== "provision" ||
    environment.GITHUB_WORKFLOW_REF !==
      `kevishie/find-the-edge/.github/workflows/provision-identity-authorization.yml@${environment.GITHUB_REF}` ||
    !boundedDigits(environment.GITHUB_RUN_ID, 20) ||
    !boundedDigits(environment.GITHUB_RUN_ATTEMPT, 5) ||
    !boundedDigits(environment.GITHUB_ACTOR_ID, 20) ||
    !SHA.test(environment.GITHUB_SHA ?? "")
  )
    fail("workflow-required");
  if (
    (mode === "apply" && environment.FTE_AUTHORIZATION_APPLY !== "SET-ROLES") ||
    (mode === "dry-run" &&
      ![undefined, ""].includes(environment.FTE_AUTHORIZATION_APPLY))
  )
    fail("confirmation-invalid");
  return Object.freeze({
    mode,
    target,
    accountId: environment.FTE_AUTHORIZATION_ACCOUNT_ID,
    desiredRoles: AUTHORIZATION_DESIRED_STATES[desired],
    expectedUpdatedAt,
    operatorId: `operator:github-${environment.GITHUB_ACTOR_ID}`,
    changeId: `github:${environment.GITHUB_RUN_ID}:${environment.GITHUB_RUN_ATTEMPT}`,
    releaseSha: environment.GITHUB_SHA,
    clientRequestToken: `fte-auth-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`,
  });
}

export function validateAuthorizationProvisionAwsIdentity(identity, target) {
  if (!target || !["staging", "production"].includes(target.githubEnvironment))
    fail("aws-identity-invalid");
  const expectedRole = `arn:aws:sts::${AUTHORIZATION_ACCOUNT}:assumed-role/github-actions-find-the-edge-${target.githubEnvironment}-authorization-operator/`;
  if (
    identity?.Account !== AUTHORIZATION_ACCOUNT ||
    !bounded(identity?.Arn, 2048) ||
    !identity.Arn.startsWith(expectedRole) ||
    identity.Arn.length === expectedRole.length ||
    !bounded(identity?.UserId, 1024)
  )
    fail("aws-identity-invalid");
}

export function validateAuthorizationProvisionTarget({
  target,
  stack,
  resources,
  table,
}) {
  const stackArnPrefix = `arn:aws:cloudformation:${AUTHORIZATION_REGION}:${AUTHORIZATION_ACCOUNT}:stack/${target.stackName}/`;
  if (
    stack?.StackName !== target.stackName ||
    !stack?.StackId?.startsWith(stackArnPrefix) ||
    !STACK_STATUSES.has(stack?.StackStatus) ||
    !Array.isArray(resources)
  )
    fail("stack-invalid");
  const tables = resources.filter(
    (resource) =>
      resource?.ResourceType === "AWS::DynamoDB::Table" &&
      resource?.LogicalResourceId?.startsWith("EventIngestionTable") &&
      TABLE_NAME.test(resource?.PhysicalResourceId ?? ""),
  );
  if (tables.length !== 1) fail("table-binding-invalid");
  const tableName = tables[0].PhysicalResourceId;
  const expectedArn = `arn:aws:dynamodb:${AUTHORIZATION_REGION}:${AUTHORIZATION_ACCOUNT}:table/${tableName}`;
  const primaryKey = Array.isArray(table?.KeySchema)
    ? [...table.KeySchema].sort((left, right) =>
        String(left?.KeyType).localeCompare(String(right?.KeyType)),
      )
    : [];
  if (
    table?.TableName !== tableName ||
    table?.TableArn !== expectedArn ||
    table?.TableStatus !== "ACTIVE" ||
    JSON.stringify(primaryKey) !==
      JSON.stringify([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ])
  )
    fail("table-invalid");
  return Object.freeze({
    stackId: stack.StackId,
    tableName,
    tableArn: expectedArn,
  });
}

const canonicalRoles = (value) => {
  if (
    !Array.isArray(value) ||
    value.length > AUTHORIZATION_ROLES.length ||
    !value.every((role) => AUTHORIZATION_ROLES.includes(role)) ||
    new Set(value).size !== value.length
  )
    fail("roles-invalid");
  const canonical = AUTHORIZATION_ROLES.filter((role) => value.includes(role));
  if (value.some((role, index) => role !== canonical[index]))
    fail("roles-noncanonical");
  return Object.freeze(canonical);
};

export function normalizeProvisionAccount(value, expectedAccountId) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "accountId",
      "tokenVersion",
      "createdAt",
      "lastSignedInAt",
    ]) ||
    value.schemaVersion !== "identity-account-v1" ||
    value.accountId !== expectedAccountId ||
    !accountId(value.accountId) ||
    !Number.isSafeInteger(value.tokenVersion) ||
    value.tokenVersion < 1 ||
    value.tokenVersion > 1_000_000_000 ||
    !canonicalInstant(value.createdAt) ||
    !canonicalInstant(value.lastSignedInAt) ||
    Date.parse(value.lastSignedInAt) < Date.parse(value.createdAt)
  )
    fail("account-record-invalid");
  return Object.freeze({ ...value });
}

export function normalizeProvisionAuthorization(value, expectedAccountId) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "accountId",
      "roles",
      "updatedAt",
      "operatorId",
    ]) ||
    value.schemaVersion !== "identity-authorization-v1" ||
    value.accountId !== expectedAccountId ||
    !accountId(value.accountId) ||
    !canonicalInstant(value.updatedAt) ||
    typeof value.operatorId !== "string" ||
    !/^operator:[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value.operatorId)
  )
    fail("authorization-record-invalid");
  return Object.freeze({ ...value, roles: canonicalRoles(value.roles) });
}

export function normalizeProvisionAudit(value, expected) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "accountId",
      "beforeRoles",
      "afterRoles",
      "previousUpdatedAt",
      "updatedAt",
      "operatorId",
      "changeId",
      "releaseSha",
    ]) ||
    value.schemaVersion !== "identity-authorization-audit-v1" ||
    value.accountId !== expected.accountId ||
    value.updatedAt !== expected.updatedAt ||
    value.previousUpdatedAt !== expected.previousUpdatedAt ||
    value.operatorId !== expected.operatorId ||
    value.changeId !== expected.changeId ||
    value.releaseSha !== expected.releaseSha
  )
    fail("audit-record-invalid");
  const beforeRoles = canonicalRoles(value.beforeRoles);
  const afterRoles = canonicalRoles(value.afterRoles);
  if (
    JSON.stringify(beforeRoles) !== JSON.stringify(expected.beforeRoles) ||
    JSON.stringify(afterRoles) !== JSON.stringify(expected.afterRoles)
  )
    fail("audit-record-invalid");
  return Object.freeze({ ...value, beforeRoles, afterRoles });
}

const currentKey = (account) => ({
  pk: `ACCOUNT#${account}`,
  sk: "AUTHORIZATION",
});
const accountKey = (account) => ({
  pk: `ACCOUNT#${account}`,
  sk: "RECORD",
});
const auditKey = (account, updatedAt, changeId) => ({
  pk: `ACCOUNT#${account}`,
  sk: `AUTHORIZATION_AUDIT#${updatedAt}#${changeId}`,
});

const attribute = (value) => {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number" && Number.isFinite(value))
    return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  if (record(value))
    return {
      M: Object.fromEntries(
        Object.entries(value).map(([key, member]) => [key, attribute(member)]),
      ),
    };
  fail("attribute-invalid");
};

const item = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, attribute(member)]),
  );

const decodeAttribute = (value) => {
  if (!record(value) || Object.keys(value).length !== 1)
    fail("aws-item-invalid");
  if (typeof value.S === "string") return value.S;
  if (typeof value.N === "string" && /^-?\d+$/.test(value.N)) {
    const parsed = Number(value.N);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (value.NULL === true) return null;
  if (Array.isArray(value.L)) return value.L.map(decodeAttribute);
  if (record(value.M))
    return Object.fromEntries(
      Object.entries(value.M).map(([key, member]) => [
        key,
        decodeAttribute(member),
      ]),
    );
  fail("aws-item-invalid");
};

export const decodeProvisionItem = (value) => {
  if (!record(value)) fail("aws-item-invalid");
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [
      key,
      decodeAttribute(member),
    ]),
  );
};

export function buildAuthorizationTransaction({
  tableName,
  config,
  account,
  current,
  candidate,
  audit,
}) {
  const names = {
    "#value": "value",
  };
  const accountFence = {
    TableName: tableName,
    Key: item(accountKey(config.accountId)),
    ConditionExpression: "attribute_exists(pk) AND #value = :expectedAccount",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: item({
      ":expectedAccount": account,
    }),
  };
  const currentCondition = current
    ? {
        ConditionExpression:
          "attribute_exists(pk) AND #value = :expectedCurrent AND #value.#updatedAt < :updatedAt",
        ExpressionAttributeNames: {
          ...names,
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: item({
          ":expectedCurrent": current,
          ":updatedAt": candidate.updatedAt,
        }),
      }
    : { ConditionExpression: "attribute_not_exists(pk)" };
  return {
    ClientRequestToken: config.clientRequestToken,
    TransactItems: [
      { ConditionCheck: accountFence },
      {
        Put: {
          TableName: tableName,
          Item: item({ ...currentKey(config.accountId), value: candidate }),
          ...currentCondition,
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: item({
            ...auditKey(config.accountId, audit.updatedAt, audit.changeId),
            value: audit,
          }),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ],
  };
}

export async function executeAuthorizationProvision(
  config,
  operations,
  now = new Date(),
) {
  const storedAccount = await operations.readAccount(config.accountId);
  if (!storedAccount) fail("account-missing");
  const account = normalizeProvisionAccount(storedAccount, config.accountId);
  const storedCurrent = await operations.readAuthorization(config.accountId);
  const current =
    storedCurrent === null
      ? null
      : normalizeProvisionAuthorization(storedCurrent, config.accountId);
  if (
    config.mode === "apply" &&
    ((config.expectedUpdatedAt === "absent" && current !== null) ||
      (config.expectedUpdatedAt !== "absent" &&
        current?.updatedAt !== config.expectedUpdatedAt))
  )
    fail("expected-state-conflict");
  const noOp =
    current !== null &&
    JSON.stringify(current.roles) === JSON.stringify(config.desiredRoles);
  if (config.mode === "dry-run" || noOp)
    return Object.freeze({
      outcome: noOp ? "no-op" : "planned",
      previousUpdatedAt: current?.updatedAt ?? null,
      beforeRoles: current?.roles ?? Object.freeze([]),
      afterRoles: config.desiredRoles,
    });
  const updatedAt = now.toISOString();
  if (
    !canonicalInstant(updatedAt) ||
    (current && updatedAt <= current.updatedAt)
  )
    fail("clock-not-monotonic");
  const candidate = Object.freeze({
    schemaVersion: "identity-authorization-v1",
    accountId: config.accountId,
    roles: config.desiredRoles,
    updatedAt,
    operatorId: config.operatorId,
  });
  const audit = Object.freeze({
    schemaVersion: "identity-authorization-audit-v1",
    accountId: config.accountId,
    beforeRoles: current?.roles ?? Object.freeze([]),
    afterRoles: config.desiredRoles,
    previousUpdatedAt: current?.updatedAt ?? null,
    updatedAt,
    operatorId: config.operatorId,
    changeId: config.changeId,
    releaseSha: config.releaseSha,
  });
  const auditStorageKey = auditKey(
    config.accountId,
    updatedAt,
    config.changeId,
  );
  await operations.transact(
    buildAuthorizationTransaction({
      tableName: operations.tableName,
      config,
      account,
      current,
      candidate,
      audit,
    }),
  );
  const [readCurrent, readAudit] = await Promise.all([
    operations.readAuthorization(config.accountId),
    operations.readAudit(auditStorageKey),
  ]);
  const verifiedCurrent = normalizeProvisionAuthorization(
    readCurrent,
    config.accountId,
  );
  normalizeProvisionAudit(readAudit, audit);
  if (
    verifiedCurrent.schemaVersion !== candidate.schemaVersion ||
    verifiedCurrent.accountId !== candidate.accountId ||
    JSON.stringify(verifiedCurrent.roles) !== JSON.stringify(candidate.roles) ||
    verifiedCurrent.updatedAt !== candidate.updatedAt ||
    verifiedCurrent.operatorId !== candidate.operatorId
  )
    fail("readback-mismatch");
  return Object.freeze({
    outcome: "applied",
    previousUpdatedAt: audit.previousUpdatedAt,
    updatedAt,
    beforeRoles: audit.beforeRoles,
    afterRoles: audit.afterRoles,
    auditKey: auditStorageKey.sk,
  });
}

const awsJson = (arguments_, environment) => {
  try {
    const result = spawnSync("aws", [...arguments_, "--output", "json"], {
      encoding: "utf8",
      stdio: "pipe",
      env: environment,
      timeout: 60_000,
    });
    if (result.error || result.status !== 0) fail("aws-command-failed");
    return JSON.parse(result.stdout || "{}");
  } catch {
    fail("aws-command-failed");
  }
};

const describeTarget = (config, environment) => {
  validateAuthorizationProvisionAwsIdentity(
    awsJson(["sts", "get-caller-identity"], environment),
    config.target,
  );
  const described = awsJson(
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      config.target.stackName,
      "--region",
      AUTHORIZATION_REGION,
    ],
    environment,
  );
  if (described.Stacks?.length !== 1) fail("stack-invalid");
  const stack = described.Stacks[0];
  const resources =
    awsJson(
      [
        "cloudformation",
        "list-stack-resources",
        "--stack-name",
        stack.StackId,
        "--region",
        AUTHORIZATION_REGION,
      ],
      environment,
    ).StackResourceSummaries ?? [];
  const tableNames = resources
    .filter(
      (resource) =>
        resource?.ResourceType === "AWS::DynamoDB::Table" &&
        resource?.LogicalResourceId?.startsWith("EventIngestionTable"),
    )
    .map((resource) => resource.PhysicalResourceId);
  if (tableNames.length !== 1 || !TABLE_NAME.test(tableNames[0] ?? ""))
    fail("table-binding-invalid");
  const table = awsJson(
    [
      "dynamodb",
      "describe-table",
      "--table-name",
      tableNames[0],
      "--region",
      AUTHORIZATION_REGION,
    ],
    environment,
  ).Table;
  return validateAuthorizationProvisionTarget({
    target: config.target,
    stack,
    resources,
    table,
  });
};

const lowLevelKey = (key) => item(key);

const liveOperations = (target, environment) => {
  const read = (key) => {
    const response = awsJson(
      [
        "dynamodb",
        "get-item",
        "--table-name",
        target.tableName,
        "--key",
        JSON.stringify(lowLevelKey(key)),
        "--consistent-read",
        "--region",
        AUTHORIZATION_REGION,
      ],
      environment,
    );
    if (response.Item === undefined) return null;
    const stored = decodeProvisionItem(response.Item);
    if (
      !exactKeys(stored, ["pk", "sk", "value"]) ||
      stored.pk !== key.pk ||
      stored.sk !== key.sk ||
      stored.value === null ||
      stored.value === undefined
    )
      fail("aws-item-invalid");
    return stored.value;
  };
  return {
    tableName: target.tableName,
    readAccount: (account) => read(accountKey(account)),
    readAuthorization: (account) => read(currentKey(account)),
    readAudit: (key) => read(key),
    transact: async (transaction) => {
      await Promise.resolve();
      awsJson(
        [
          "dynamodb",
          "transact-write-items",
          "--cli-input-json",
          JSON.stringify(transaction),
          "--region",
          AUTHORIZATION_REGION,
        ],
        environment,
      );
    },
  };
};

const accountDigest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export async function identityAuthorizationProvision(
  environment = process.env,
) {
  const config = validateAuthorizationProvisionEnvironment(environment);
  const target = describeTarget(config, environment);
  const result = await executeAuthorizationProvision(
    config,
    liveOperations(target, environment),
  );
  process.stdout.write(
    `${JSON.stringify({
      event: "identity-authorization-provision",
      mode: config.mode,
      outcome: result.outcome,
      stage: config.target.stage,
      accountDigest: accountDigest(config.accountId),
      beforeRoles: result.beforeRoles,
      afterRoles: result.afterRoles,
      previousUpdatedAt: result.previousUpdatedAt,
      ...(result.updatedAt ? { updatedAt: result.updatedAt } : {}),
      ...(result.auditKey ? { auditKey: result.auditKey } : {}),
      operatorId: config.operatorId,
      changeId: config.changeId,
      releaseSha: config.releaseSha,
    })}\n`,
  );
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  identityAuthorizationProvision().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "identity-authorization-provision",
        outcome: "failed",
        code: safeAuthorizationProvisionError(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
