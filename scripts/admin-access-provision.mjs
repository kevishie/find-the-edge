import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const ADMIN_PROVISION_ACCOUNT = "228246988391";
export const ADMIN_PROVISION_REGION = "us-east-1";
const ACCOUNT = /^account:[a-f0-9]{64}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const CHANGE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ROLES = ["retrospective-reviewer", "strategy-promoter", "super-admin"];
const fail = (reason) => {
  throw new Error(`admin-access-provision-${reason}`);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const instant = (value) =>
  typeof value === "string" &&
  INSTANT.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const targetFor = (stage) => {
  if (!["staging", "prod"].includes(stage)) fail("stage-invalid");
  return `FindTheEdge-${stage}-Foundation`;
};

export function validateAdminProvisionInput(input) {
  if (!input || !["bootstrap", "migrate", "recover"].includes(input.mode))
    fail("mode-invalid");
  if (!ACCOUNT.test(input.ownerAccountId ?? "")) fail("owner-invalid");
  if (!E164.test(input.phoneNumber ?? "")) fail("phone-invalid");
  if (
    typeof input.accountPepper !== "string" ||
    input.accountPepper.length < 16
  )
    fail("pepper-invalid");
  if (!TABLE.test(input.tableName ?? "")) fail("table-invalid");
  if (input.awsAccountId !== ADMIN_PROVISION_ACCOUNT) fail("account-invalid");
  if (input.region !== ADMIN_PROVISION_REGION) fail("region-invalid");
  const stackName = targetFor(input.stage);
  if (input.stackName !== stackName) fail("stack-invalid");
  if (!CHANGE.test(input.changeId ?? "")) fail("change-id-invalid");
  if (!instant(input.occurredAt)) fail("timestamp-invalid");
  if (input.mode === "recover" && input.allowRecovery !== true)
    fail("recovery-not-approved");
  const derived = `account:${createHash("sha256")
    .update(
      `fte:identity-account:v1|${input.accountPepper}|${input.phoneNumber}`,
    )
    .digest("hex")}`;
  if (derived !== input.ownerAccountId) fail("owner-phone-mismatch");
  return Object.freeze({ ...input, stackName, derivedAccountId: derived });
}

const normalizeAuthorization = (value, accountId) => {
  if (value === null) return null;
  const canonical = Array.isArray(value?.roles)
    ? ROLES.filter((role) => value.roles.includes(role))
    : [];
  if (
    !exact(value, [
      "schemaVersion",
      "accountId",
      "roles",
      "updatedAt",
      "operatorId",
    ]) ||
    value.schemaVersion !== "identity-authorization-v1" ||
    value.accountId !== accountId ||
    JSON.stringify(value.roles) !== JSON.stringify(canonical) ||
    !instant(value.updatedAt) ||
    !/^operator:[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value.operatorId)
  )
    fail("authorization-invalid");
  return value;
};
const ownerAuditKey = (mode, changeId) =>
  mode === "recover"
    ? `ADMIN_AUDIT#owner-recover#${createHash("sha256").update(changeId).digest("hex")}`
    : `ADMIN_AUDIT#owner-${mode}`;
const operatorId = (accountId) =>
  `operator:${createHash("sha256").update(accountId).digest("hex").slice(0, 24)}`;
const expectedValue = (current) =>
  current
    ? {
        ConditionExpression: "attribute_exists(pk) AND #value = :expected",
        ExpressionAttributeNames: { "#value": "value" },
        ExpressionAttributeValues: { ":expected": current },
      }
    : { ConditionExpression: "attribute_not_exists(pk)" };

export function buildAdminProvisionTransaction(raw, state = {}) {
  const input = validateAdminProvisionInput(raw);
  if (state.accountExists !== true) fail("account-missing");
  const currentOwner = state.currentOwner ?? null;
  if (input.mode === "recover") {
    if (
      !exact(currentOwner, [
        "schemaVersion",
        "accountId",
        "directoryId",
        "auditKey",
        "createdAt",
      ]) ||
      currentOwner.schemaVersion !== "owner-bootstrap-v1" ||
      !ACCOUNT.test(currentOwner.accountId) ||
      !/^directory:[a-f0-9]{32}$/.test(currentOwner.directoryId) ||
      !instant(currentOwner.createdAt)
    )
      fail("current-owner-invalid");
  } else if (currentOwner !== null) fail("owner-already-exists");
  const targetAuthorization = normalizeAuthorization(
    state.targetAuthorization ?? null,
    input.ownerAccountId,
  );
  const previousOwnerAuthorization =
    input.mode === "recover"
      ? normalizeAuthorization(
          state.previousOwnerAuthorization ?? null,
          currentOwner.accountId,
        )
      : null;
  if (
    input.mode === "recover" &&
    (!previousOwnerAuthorization?.roles.includes("super-admin") ||
      (currentOwner.accountId !== input.ownerAccountId &&
        targetAuthorization?.roles.includes("super-admin")))
  )
    fail("super-admin-authority-invalid");

  const digest = createHash("sha256")
    .update(
      `fte:identity-phone-digest:v1|${input.accountPepper}|${input.phoneNumber}`,
    )
    .digest("hex")
    .slice(0, 32);
  const directoryId = `directory:${digest}`;
  const auditKey = ownerAuditKey(input.mode, input.changeId);
  const directory = {
    schemaVersion: "admin-directory-v1",
    directoryId,
    phoneDigest: digest,
    phoneHint: `**${input.phoneNumber.slice(-2)}`,
    displayReference: `User ${digest.slice(0, 6)} · **${input.phoneNumber.slice(-2)}`,
    lifecycle: "active",
    accountId: input.ownerAccountId,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
  };
  const owner = {
    schemaVersion: "owner-bootstrap-v1",
    accountId: input.ownerAccountId,
    directoryId,
    auditKey,
    createdAt: input.occurredAt,
  };
  const authorization = {
    schemaVersion: "identity-authorization-v1",
    accountId: input.ownerAccountId,
    roles: ROLES.filter(
      (role) =>
        role === "super-admin" || targetAuthorization?.roles.includes(role),
    ),
    updatedAt: input.occurredAt,
    operatorId: operatorId(input.ownerAccountId),
  };
  const items = [
    {
      ConditionCheck: {
        TableName: input.tableName,
        Key: { pk: `ACCOUNT#${input.ownerAccountId}`, sk: "RECORD" },
        ConditionExpression: "attribute_exists(pk)",
      },
    },
    {
      Put: {
        TableName: input.tableName,
        Item: { pk: "ADMIN_OWNER", sk: "RECORD", value: owner },
        ...(currentOwner
          ? expectedValue(currentOwner)
          : { ConditionExpression: "attribute_not_exists(pk)" }),
      },
    },
    {
      Put: {
        TableName: input.tableName,
        Item: {
          pk: `ACCOUNT#${input.ownerAccountId}`,
          sk: "AUTHORIZATION",
          value: authorization,
        },
        ...expectedValue(targetAuthorization),
      },
    },
  ];
  if (
    input.mode === "recover" &&
    currentOwner.accountId !== input.ownerAccountId
  ) {
    items.push({
      Put: {
        TableName: input.tableName,
        Item: {
          pk: `ACCOUNT#${currentOwner.accountId}`,
          sk: "AUTHORIZATION",
          value: {
            ...previousOwnerAuthorization,
            roles: previousOwnerAuthorization.roles.filter(
              (role) => role !== "super-admin",
            ),
            updatedAt: input.occurredAt,
            operatorId: operatorId(input.ownerAccountId),
          },
        },
        ...expectedValue(previousOwnerAuthorization),
      },
    });
  }
  const existingDirectory = state.targetDirectory ?? null;
  if (existingDirectory) {
    if (
      existingDirectory.directoryId !== directoryId ||
      existingDirectory.accountId !== input.ownerAccountId ||
      existingDirectory.lifecycle !== "active"
    )
      fail("directory-conflict");
    items.push({
      ConditionCheck: {
        TableName: input.tableName,
        Key: { pk: `ADMIN_DIRECTORY#${digest}`, sk: "RECORD" },
        ConditionExpression: "#value = :expected",
        ExpressionAttributeNames: { "#value": "value" },
        ExpressionAttributeValues: { ":expected": existingDirectory },
      },
    });
  } else
    items.push({
      Put: {
        TableName: input.tableName,
        Item: {
          pk: `ADMIN_DIRECTORY#${digest}`,
          sk: "RECORD",
          directoryPk: "ADMIN_DIRECTORY",
          directorySk: `${input.occurredAt}#${directoryId}`,
          value: directory,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  const existingMapping = state.targetMapping ?? null;
  if (existingMapping) {
    if (existingMapping.directoryId !== directoryId) fail("mapping-conflict");
    items.push({
      ConditionCheck: {
        TableName: input.tableName,
        Key: { pk: `ACCOUNT#${input.ownerAccountId}`, sk: "ADMIN_DIRECTORY" },
        ConditionExpression: "directoryId = :directoryId",
        ExpressionAttributeValues: { ":directoryId": directoryId },
      },
    });
  } else
    items.push({
      Put: {
        TableName: input.tableName,
        Item: {
          pk: `ACCOUNT#${input.ownerAccountId}`,
          sk: "ADMIN_DIRECTORY",
          directoryId,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  items.push({
    Put: {
      TableName: input.tableName,
      Item: {
        pk: auditKey,
        sk: "EVENT",
        value: {
          schemaVersion: "admin-access-audit-v1",
          action: `owner-${input.mode}`,
          directoryId,
          actor: "system",
          grantVersion: null,
          occurredAt: input.occurredAt,
        },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });
  return {
    ClientRequestToken: `fte-admin-${createHash("sha256").update(input.changeId).digest("hex").slice(0, 24)}`,
    TransactItems: items,
  };
}

const attribute = (value) => {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number" && Number.isFinite(value))
    return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  if (object(value))
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
export const marshalAdminProvisionTransaction = (transaction) => ({
  ClientRequestToken: transaction.ClientRequestToken,
  TransactItems: transaction.TransactItems.map((operation) => {
    const [kind, request] = Object.entries(operation)[0];
    return {
      [kind]: {
        ...request,
        ...(request.Key ? { Key: item(request.Key) } : {}),
        ...(request.Item ? { Item: item(request.Item) } : {}),
        ...(request.ExpressionAttributeValues
          ? {
              ExpressionAttributeValues: item(
                request.ExpressionAttributeValues,
              ),
            }
          : {}),
      },
    };
  }),
});

const awsJson = (arguments_, environment) => {
  try {
    return JSON.parse(
      execFileSync("aws", [...arguments_, "--output", "json"], {
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      }) || "{}",
    );
  } catch {
    fail("aws-command-failed");
  }
};
const decodeAttribute = (value) => {
  if (!object(value) || Object.keys(value).length !== 1)
    fail("aws-item-invalid");
  if (typeof value.S === "string") return value.S;
  if (typeof value.N === "string" && /^-?\d+$/.test(value.N))
    return Number(value.N);
  if (value.NULL === true) return null;
  if (Array.isArray(value.L)) return value.L.map(decodeAttribute);
  if (object(value.M))
    return Object.fromEntries(
      Object.entries(value.M).map(([key, member]) => [
        key,
        decodeAttribute(member),
      ]),
    );
  fail("aws-item-invalid");
};
const decodeItem = (value) =>
  object(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          decodeAttribute(member),
        ]),
      )
    : null;
const bindTarget = (input, environment) => {
  const identity = awsJson(
    ["sts", "get-caller-identity", "--region", input.region],
    environment,
  );
  if (identity.Account !== input.awsAccountId) fail("aws-identity-mismatch");
  const stacks = awsJson(
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      input.stackName,
      "--region",
      input.region,
    ],
    environment,
  ).Stacks;
  if (
    stacks?.length !== 1 ||
    stacks[0].StackName !== input.stackName ||
    !String(stacks[0].StackId).startsWith(
      `arn:aws:cloudformation:${input.region}:${input.awsAccountId}:stack/${input.stackName}/`,
    )
  )
    fail("stack-binding-invalid");
  const resources =
    awsJson(
      [
        "cloudformation",
        "list-stack-resources",
        "--stack-name",
        stacks[0].StackId,
        "--region",
        input.region,
      ],
      environment,
    ).StackResourceSummaries ?? [];
  const tables = resources.filter(
    (resource) =>
      resource.ResourceType === "AWS::DynamoDB::Table" &&
      String(resource.LogicalResourceId).startsWith("EventIngestionTable"),
  );
  if (tables.length !== 1 || tables[0].PhysicalResourceId !== input.tableName)
    fail("table-binding-invalid");
  const table = awsJson(
    [
      "dynamodb",
      "describe-table",
      "--table-name",
      input.tableName,
      "--region",
      input.region,
    ],
    environment,
  ).Table;
  if (
    table?.TableName !== input.tableName ||
    table?.TableArn !==
      `arn:aws:dynamodb:${input.region}:${input.awsAccountId}:table/${input.tableName}`
  )
    fail("table-binding-invalid");
};
const readItem = (input, key, environment) => {
  const response = awsJson(
    [
      "dynamodb",
      "get-item",
      "--table-name",
      input.tableName,
      "--key",
      JSON.stringify(item(key)),
      "--consistent-read",
      "--region",
      input.region,
    ],
    environment,
  );
  return response.Item ? decodeItem(response.Item) : null;
};

export function adminAccessProvision(
  environment = process.env,
  argv = process.argv.slice(2),
) {
  const apply = argv.includes("--apply");
  const mode = argv.find((value) =>
    ["bootstrap", "migrate", "recover"].includes(value),
  );
  const input = validateAdminProvisionInput({
    mode,
    ownerAccountId: environment.FTE_OWNER_ACCOUNT_ID,
    phoneNumber: environment.FTE_OWNER_PHONE,
    accountPepper: environment.FTE_ACCOUNT_PEPPER,
    tableName: environment.FTE_EVENT_TABLE_NAME,
    awsAccountId: environment.AWS_ACCOUNT_ID,
    region: environment.AWS_REGION,
    stage: environment.FTE_AWS_STAGE,
    stackName: environment.FTE_STACK_NAME,
    changeId: environment.FTE_ADMIN_CHANGE_ID,
    occurredAt: environment.FTE_ADMIN_OCCURRED_AT,
    allowRecovery: environment.FTE_ALLOW_OWNER_RECOVERY === "I_UNDERSTAND",
  });
  bindTarget(input, environment);
  const currentOwner =
    readItem(input, { pk: "ADMIN_OWNER", sk: "RECORD" }, environment)?.value ??
    null;
  const digest = createHash("sha256")
    .update(
      `fte:identity-phone-digest:v1|${input.accountPepper}|${input.phoneNumber}`,
    )
    .digest("hex")
    .slice(0, 32);
  const targetAuthorization =
    readItem(
      input,
      { pk: `ACCOUNT#${input.ownerAccountId}`, sk: "AUTHORIZATION" },
      environment,
    )?.value ?? null;
  const expectedAuditKey = ownerAuditKey(input.mode, input.changeId);
  const existingAudit =
    readItem(input, { pk: expectedAuditKey, sk: "EVENT" }, environment)
      ?.value ?? null;
  if (existingAudit) {
    const expectedAction = `owner-${input.mode}`;
    const normalizedTargetAuthorization = normalizeAuthorization(
      targetAuthorization,
      input.ownerAccountId,
    );
    if (
      !exact(currentOwner, [
        "schemaVersion",
        "accountId",
        "directoryId",
        "auditKey",
        "createdAt",
      ]) ||
      !exact(existingAudit, [
        "schemaVersion",
        "action",
        "directoryId",
        "actor",
        "grantVersion",
        "occurredAt",
      ]) ||
      currentOwner.schemaVersion !== "owner-bootstrap-v1" ||
      existingAudit.schemaVersion !== "admin-access-audit-v1" ||
      currentOwner?.accountId !== input.ownerAccountId ||
      currentOwner?.auditKey !== expectedAuditKey ||
      currentOwner?.directoryId !== existingAudit.directoryId ||
      currentOwner?.createdAt !== input.occurredAt ||
      existingAudit.action !== expectedAction ||
      existingAudit.actor !== "system" ||
      existingAudit.grantVersion !== null ||
      existingAudit.occurredAt !== input.occurredAt ||
      !normalizedTargetAuthorization?.roles.includes("super-admin")
    )
      fail("replay-conflict");
    const replay = {
      outcome: "already-applied",
      mode,
      evidence: {
        ownerAccountId: input.ownerAccountId,
        directoryId: currentOwner.directoryId,
        auditKey: expectedAuditKey,
        occurredAt: input.occurredAt,
      },
    };
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    return replay;
  }
  const transaction = buildAdminProvisionTransaction(input, {
    accountExists: !!readItem(
      input,
      { pk: `ACCOUNT#${input.ownerAccountId}`, sk: "RECORD" },
      environment,
    ),
    currentOwner,
    targetAuthorization,
    previousOwnerAuthorization:
      input.mode === "recover" && currentOwner
        ? (readItem(
            input,
            { pk: `ACCOUNT#${currentOwner.accountId}`, sk: "AUTHORIZATION" },
            environment,
          )?.value ?? null)
        : null,
    targetDirectory:
      readItem(
        input,
        { pk: `ADMIN_DIRECTORY#${digest}`, sk: "RECORD" },
        environment,
      )?.value ?? null,
    targetMapping: readItem(
      input,
      { pk: `ACCOUNT#${input.ownerAccountId}`, sk: "ADMIN_DIRECTORY" },
      environment,
    ),
  });
  if (!apply) {
    const plan = { outcome: "validated", mode, transaction };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  if (environment.FTE_ADMIN_APPLY_CONFIRMATION !== `APPLY_${mode}`)
    fail("apply-confirmation-missing");
  execFileSync(
    "aws",
    [
      "dynamodb",
      "transact-write-items",
      "--region",
      input.region,
      "--cli-input-json",
      JSON.stringify(marshalAdminProvisionTransaction(transaction)),
    ],
    { stdio: "inherit", env: environment },
  );
  return { outcome: "applied", mode };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
)
  try {
    adminAccessProvision();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^admin-access-provision-[a-z0-9-]+$/.test(error.message) ? error.message : "admin-access-provision-failed"}\n`,
    );
    process.exitCode = 1;
  }
