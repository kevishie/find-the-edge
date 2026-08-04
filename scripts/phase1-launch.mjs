import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPhase1Web } from "./build-phase1-web.mjs";
import { phase1EnvironmentSmoke } from "./phase1-environment-smoke.mjs";
import { run } from "./phase1-support.mjs";

export const LAUNCH_ACCOUNT = "228246988391";
export const LAUNCH_REGION = "us-east-1";
export const LAUNCH_STACK = "FindTheEdge-dev-Foundation";

export function validateLaunchEnvironment(environment) {
  if (environment.FTE_PHASE1_LAUNCH !== "1")
    throw new Error("Launch is disabled; set FTE_PHASE1_LAUNCH=1 explicitly");
  if (
    environment.AWS_ACCOUNT_ID !== LAUNCH_ACCOUNT ||
    environment.AWS_REGION !== LAUNCH_REGION
  )
    throw new Error(
      `Launch is restricted to account ${LAUNCH_ACCOUNT} in ${LAUNCH_REGION}`,
    );
  if (
    !environment.FTE_EVENT_CURSOR_SECRET_ARN?.startsWith(
      `arn:aws:secretsmanager:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:secret:`,
    )
  )
    throw new Error(
      "The cursor secret must belong to the authorized account and region",
    );
}

function verifyIdentity(environment) {
  const identity = JSON.parse(
    run("aws", ["sts", "get-caller-identity", "--output", "json"], {
      capture: true,
      env: environment,
    }),
  );
  if (
    identity.Account !== LAUNCH_ACCOUNT ||
    environment.AWS_REGION !== LAUNCH_REGION
  )
    throw new Error("AWS identity guard rejected this mutation");
}

function guardedRun(command, arguments_, environment, options = {}) {
  verifyIdentity(environment);
  return run(command, arguments_, { ...options, env: environment });
}

export function assertRetainedResourcesSafe(existing, proposed) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  const same = (left, right) =>
    JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  const requireSame = (before, after, properties) => {
    for (const property of properties)
      if (!same(before[property], after[property])) return false;
    return true;
  };
  const retainsTrue = (before, after, properties) =>
    properties.every(
      (property) => before[property] !== true || after[property] === true,
    );
  const retainsArray = (before, after, property) =>
    (before[property] ?? []).every((item) =>
      (after[property] ?? []).some((candidate) => same(item, candidate)),
    );
  const preservesNamedIndexes = (oldIndexes = [], newIndexes = []) =>
    oldIndexes.every((oldIndex) => {
      const nextIndex = newIndexes.find(
        (candidate) => candidate.IndexName === oldIndex.IndexName,
      );
      return (
        nextIndex &&
        requireSame(oldIndex, nextIndex, [
          "IndexName",
          "KeySchema",
          "Projection",
        ])
      );
    });
  const preservesS3Encryption = (oldEncryption, newEncryption) => {
    if (oldEncryption === undefined) return true;
    const oldRules = oldEncryption.ServerSideEncryptionConfiguration ?? [];
    const newRules = newEncryption?.ServerSideEncryptionConfiguration ?? [];
    return oldRules.every((oldRule) =>
      newRules.some(
        (newRule) =>
          same(
            oldRule.ServerSideEncryptionByDefault?.SSEAlgorithm,
            newRule.ServerSideEncryptionByDefault?.SSEAlgorithm,
          ) &&
          same(
            oldRule.ServerSideEncryptionByDefault?.KMSMasterKeyID,
            newRule.ServerSideEncryptionByDefault?.KMSMasterKeyID,
          ),
      ),
    );
  };
  const retained = Object.entries(existing.Resources ?? {}).filter(
    ([, resource]) =>
      resource.DeletionPolicy === "Retain" ||
      resource.UpdateReplacePolicy === "Retain",
  );
  if (retained.length === 0)
    throw new Error("Deployed stack has no retained resources to protect");
  for (const [logicalId, resource] of retained) {
    const next = proposed.Resources?.[logicalId];
    if (
      !next ||
      next.Type !== resource.Type ||
      next.DeletionPolicy !== "Retain" ||
      next.UpdateReplacePolicy !== "Retain"
    )
      throw new Error(
        `Retained data resource ${logicalId} would be removed or lose retention`,
      );
    if (
      !same(resource.Condition, next.Condition) ||
      !same(resource.CreationPolicy, next.CreationPolicy) ||
      !same(resource.UpdatePolicy, next.UpdatePolicy)
    )
      throw new Error(
        `Retained data resource ${logicalId} changes existence-affecting policy`,
      );
    const before = resource.Properties ?? {};
    const after = next.Properties ?? {};
    let safe;
    if (resource.Type === "AWS::DynamoDB::Table") {
      safe =
        requireSame(before, after, [
          "TableName",
          "AttributeDefinitions",
          "KeySchema",
          "TimeToLiveSpecification",
          "ResourcePolicy",
        ]) &&
        (before.StreamSpecification === undefined
          ? same(after.StreamSpecification, {
              StreamViewType: "NEW_IMAGE",
            }) || after.StreamSpecification === undefined
          : same(before.StreamSpecification, after.StreamSpecification)) &&
        (before.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled !==
          true ||
          after.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled ===
            true) &&
        (before.PointInTimeRecoverySpecification?.RecoveryPeriodInDays ===
          undefined ||
          (typeof after.PointInTimeRecoverySpecification
            ?.RecoveryPeriodInDays === "number" &&
            after.PointInTimeRecoverySpecification.RecoveryPeriodInDays >=
              before.PointInTimeRecoverySpecification.RecoveryPeriodInDays)) &&
        (before.SSESpecification === undefined ||
          (after.SSESpecification?.SSEEnabled === true &&
            requireSame(before.SSESpecification, after.SSESpecification, [
              "SSEType",
              "KMSMasterKeyId",
            ]))) &&
        same(before.LocalSecondaryIndexes, after.LocalSecondaryIndexes) &&
        preservesNamedIndexes(
          before.GlobalSecondaryIndexes,
          after.GlobalSecondaryIndexes,
        ) &&
        retainsTrue(before, after, ["DeletionProtectionEnabled"]);
    } else if (resource.Type === "AWS::S3::Bucket") {
      const publicKeys = [
        "BlockPublicAcls",
        "BlockPublicPolicy",
        "IgnorePublicAcls",
        "RestrictPublicBuckets",
      ];
      safe =
        requireSame(before, after, ["BucketName", "ObjectLockEnabled"]) &&
        preservesS3Encryption(
          before.BucketEncryption,
          after.BucketEncryption,
        ) &&
        requireSame(before, after, ["ObjectLockConfiguration"]) &&
        (before.VersioningConfiguration?.Status !== "Enabled" ||
          after.VersioningConfiguration?.Status === "Enabled") &&
        (before.ReplicationConfiguration === undefined ||
          same(
            before.ReplicationConfiguration,
            after.ReplicationConfiguration,
          )) &&
        (after.LifecycleConfiguration === undefined ||
          !JSON.stringify(after.LifecycleConfiguration).match(
            /Expiration|NoncurrentVersionExpiration|AbortIncompleteMultipartUpload/,
          )) &&
        (before.OwnershipControls === undefined ||
          same(before.OwnershipControls, after.OwnershipControls)) &&
        retainsTrue(
          before.PublicAccessBlockConfiguration ?? {},
          after.PublicAccessBlockConfiguration ?? {},
          publicKeys,
        );
    } else if (resource.Type === "AWS::Cognito::UserPool") {
      const oldPassword = before.Policies?.PasswordPolicy ?? {};
      const newPassword = after.Policies?.PasswordPolicy ?? {};
      safe =
        requireSame(before, after, [
          "UserPoolName",
          "AliasAttributes",
          "UsernameAttributes",
          "Schema",
          "AccountRecoverySetting",
          "UserPoolAddOns",
          "DeviceConfiguration",
          "UserAttributeUpdateSettings",
          "LambdaConfig",
        ]) &&
        (oldPassword.MinimumLength === undefined ||
          newPassword.MinimumLength >= oldPassword.MinimumLength) &&
        (oldPassword.TemporaryPasswordValidityDays === undefined ||
          (typeof newPassword.TemporaryPasswordValidityDays === "number" &&
            newPassword.TemporaryPasswordValidityDays <=
              oldPassword.TemporaryPasswordValidityDays)) &&
        retainsTrue(oldPassword, newPassword, [
          "RequireLowercase",
          "RequireNumbers",
          "RequireSymbols",
          "RequireUppercase",
        ]) &&
        (before.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true ||
          after.AdminCreateUserConfig?.AllowAdminCreateUserOnly === true) &&
        (before.DeletionProtection !== "ACTIVE" ||
          after.DeletionProtection === "ACTIVE") &&
        { OFF: 0, OPTIONAL: 1, ON: 2 }[after.MfaConfiguration ?? "OFF"] >=
          { OFF: 0, OPTIONAL: 1, ON: 2 }[before.MfaConfiguration ?? "OFF"] &&
        requireSame(before, after, [
          "EnabledMfas",
          "EmailMfaConfiguration",
          "SmsConfiguration",
          "SoftwareTokenMfaConfiguration",
          "WebAuthnConfiguration",
        ]) &&
        retainsArray(before, after, "AutoVerifiedAttributes");
    } else if (resource.Type === "AWS::Logs::LogGroup") {
      safe =
        requireSame(before, after, [
          "LogGroupName",
          "FieldIndexPolicies",
          "ResourcePolicyDocument",
          "LogGroupClass",
        ]) &&
        (before.RetentionInDays === undefined ||
          (typeof after.RetentionInDays === "number" &&
            after.RetentionInDays >= before.RetentionInDays)) &&
        (before.KmsKeyId === undefined ||
          same(before.KmsKeyId, after.KmsKeyId)) &&
        (before.DataProtectionPolicy === undefined ||
          same(before.DataProtectionPolicy, after.DataProtectionPolicy));
    } else {
      safe = same(before, after);
    }
    if (!safe)
      throw new Error(
        `Retained data resource ${logicalId} changes protected properties`,
      );
  }
}

async function acquireHostedUiToken(outputs, username, password) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${outputs.WebOrigin}/games`, {
      waitUntil: "domcontentloaded",
    });
    const usernameInput = page
      .locator('input[name="username"]:visible, input[type="email"]:visible')
      .first();
    const passwordInput = page
      .locator('input[name="password"]:visible, input[type="password"]:visible')
      .first();
    await usernameInput.fill(username);
    await passwordInput.fill(password);
    await page
      .locator('button:visible, input[type="submit"][value="Sign in"]:visible')
      .first()
      .click();
    await page.waitForURL(`${outputs.WebOrigin}/games`, { timeout: 30_000 });
    const tokens = await page.evaluate(async () => {
      const host = window;
      const config = host.__FTE_RUNTIME_CONFIG__;
      const provider = host.__FTE_TOKEN_PROVIDERS__?.[config?.tokenProviderKey];
      const accessToken =
        typeof provider === "function" ? await provider() : undefined;
      let idToken;
      try {
        idToken = JSON.parse(
          sessionStorage.getItem("fte.oauth.session") ?? "null",
        )?.idToken;
      } catch {
        idToken = undefined;
      }
      return { accessToken, idToken };
    });
    if (
      typeof tokens.accessToken !== "string" ||
      tokens.accessToken.length === 0 ||
      tokens.accessToken.length > 8192 ||
      typeof tokens.idToken !== "string" ||
      tokens.idToken.length === 0 ||
      tokens.idToken.length > 8192
    )
      throw new Error("Hosted UI did not provide a safe scoped access token");
    return tokens;
  } finally {
    await browser.close();
  }
}

function stackOutputs(environment) {
  verifyIdentity(environment);
  const response = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        LAUNCH_STACK,
        "--region",
        LAUNCH_REGION,
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  );
  const stack = response.Stacks?.[0];
  if (
    !stack?.StackId?.startsWith(
      `arn:aws:cloudformation:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:stack/${LAUNCH_STACK}/`,
    )
  )
    throw new Error(
      "CloudFormation response did not identify the intended stack",
    );
  return {
    StackId: stack.StackId,
    ...Object.fromEntries(
      (response.Stacks?.[0]?.Outputs ?? []).map(
        ({ OutputKey, OutputValue }) => [OutputKey, OutputValue],
      ),
    ),
  };
}

export function assertStackDriftSafe(result) {
  if (
    result.DetectionStatus !== "DETECTION_COMPLETE" ||
    result.StackDriftStatus !== "IN_SYNC"
  )
    throw new Error("Intended stack has unresolved resource drift");
}

export function resolveExistingStackSummary(summaries) {
  const matches = (summaries ?? []).filter(
    (summary) =>
      summary.StackName === LAUNCH_STACK &&
      summary.StackStatus !== "DELETE_COMPLETE",
  );
  if (matches.length > 1)
    throw new Error("CloudFormation returned multiple active launch stacks");
  const match = matches[0];
  if (
    match &&
    !match.StackId?.startsWith(
      `arn:aws:cloudformation:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:stack/${LAUNCH_STACK}/`,
    )
  )
    throw new Error("CloudFormation stack discovery escaped the launch target");
  return match;
}

function existingStack(environment) {
  verifyIdentity(environment);
  const response = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "list-stacks",
        "--region",
        LAUNCH_REGION,
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  );
  return resolveExistingStackSummary(response.StackSummaries);
}

export async function waitForStackDriftResult(
  readStatus,
  {
    attempts = 150,
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = readStatus();
    if (result.DetectionStatus !== "DETECTION_IN_PROGRESS") {
      if (result.DetectionStatus !== "DETECTION_COMPLETE")
        throw new Error("Intended stack has unresolved resource drift");
      return result;
    }
    await delay(2_000);
  }
  throw new Error("Intended stack drift detection did not complete in time");
}

export function assertStackResourceDriftsSafe(drifts) {
  if (
    drifts.length !== 1 ||
    drifts[0].ResourceType !== "AWS::ApiGatewayV2::Stage" ||
    drifts[0].StackResourceDriftStatus !== "MODIFIED" ||
    drifts[0].PropertyDifferences?.length !== 1
  )
    throw new Error("Intended stack has unresolved resource drift");
  const difference = drifts[0].PropertyDifferences[0];
  if (
    difference.PropertyPath !== "/AccessLogSettings/DestinationArn" ||
    difference.DifferenceType !== "NOT_EQUAL" ||
    difference.ExpectedValue !== `${difference.ActualValue}:*` ||
    !difference.ActualValue?.startsWith(
      `arn:aws:logs:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:log-group:${LAUNCH_STACK}-`,
    )
  )
    throw new Error("Intended stack has unresolved resource drift");
}

async function verifyStackDrift(environment) {
  verifyIdentity(environment);
  const stack = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        LAUNCH_STACK,
        "--region",
        LAUNCH_REGION,
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  ).Stacks?.[0];
  if (
    !stack?.StackId?.startsWith(
      `arn:aws:cloudformation:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:stack/${LAUNCH_STACK}/`,
    )
  )
    throw new Error("Drift check did not resolve the intended stack");
  const detectionId = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "detect-stack-drift",
        "--stack-name",
        stack.StackId,
        "--region",
        LAUNCH_REGION,
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  ).StackDriftDetectionId;
  if (!/^[0-9a-f-]{36}$/i.test(detectionId ?? ""))
    throw new Error("Stack drift detection did not start safely");
  const result = await waitForStackDriftResult(() =>
    JSON.parse(
      run(
        "aws",
        [
          "cloudformation",
          "describe-stack-drift-detection-status",
          "--stack-drift-detection-id",
          detectionId,
          "--region",
          LAUNCH_REGION,
          "--output",
          "json",
        ],
        { capture: true, env: environment },
      ),
    ),
  );
  if (result.StackDriftStatus === "IN_SYNC") return;
  if (result.StackDriftStatus !== "DRIFTED")
    throw new Error("Intended stack has unresolved resource drift");
  const drifts = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "describe-stack-resource-drifts",
        "--stack-name",
        stack.StackId,
        "--region",
        LAUNCH_REGION,
        "--stack-resource-drift-status-filters",
        "MODIFIED",
        "DELETED",
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  ).StackResourceDrifts;
  assertStackResourceDriftsSafe(drifts ?? []);
}

export function assertDeployedOutputBindings(outputs, resources, distribution) {
  const expected = [
    ["AWS::S3::Bucket", outputs.WebAssetsBucketName],
    ["AWS::CloudFront::Distribution", outputs.WebDistributionId],
    ["AWS::Cognito::UserPool", outputs.CognitoUserPoolId],
    ["AWS::Cognito::UserPoolClient", outputs.CognitoClientId],
    ["AWS::Cognito::UserPoolClient", outputs.ReviewerCognitoClientId],
    ["AWS::Lambda::Function", outputs.LiveOddsIngestionFunctionName],
  ];
  const apiId = new URL(outputs.EventsApiEndpoint).hostname.split(".")[0];
  expected.push(["AWS::ApiGatewayV2::Api", apiId]);
  if (
    expected.some(
      ([type, physicalId]) =>
        !resources.some(
          (resource) =>
            resource.ResourceType === type &&
            resource.PhysicalResourceId === physicalId,
        ),
    ) ||
    distribution?.Id !== outputs.WebDistributionId ||
    `https://${distribution?.DomainName}` !== outputs.WebOrigin ||
    !distribution?.ARN?.startsWith(
      `arn:aws:cloudfront::${LAUNCH_ACCOUNT}:distribution/`,
    )
  )
    throw new Error("Deployed outputs are not bound to the intended resources");
}

function verifyDeployedOutputBindings(outputs, environment) {
  verifyIdentity(environment);
  const resources = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "list-stack-resources",
        "--stack-name",
        LAUNCH_STACK,
        "--region",
        LAUNCH_REGION,
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  ).StackResourceSummaries;
  const distribution = JSON.parse(
    run(
      "aws",
      [
        "cloudfront",
        "get-distribution",
        "--id",
        outputs.WebDistributionId,
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  ).Distribution;
  assertDeployedOutputBindings(outputs, resources ?? [], distribution);
}

export function validateStackOutputs(outputs) {
  const web = new URL(outputs.WebOrigin);
  const api = new URL(outputs.EventsApiEndpoint);
  const issuer = new URL(outputs.CognitoIssuer);
  const domain = new URL(outputs.CognitoDomain);
  if (
    web.protocol !== "https:" ||
    web.origin !== outputs.WebOrigin ||
    !/^[a-z0-9]+\.cloudfront\.net$/.test(web.hostname) ||
    web.pathname !== "/"
  )
    throw new Error("WebOrigin is not the exact intended CloudFront origin");
  if (
    api.protocol !== "https:" ||
    !/^[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(api.hostname) ||
    api.pathname !== "/dev" ||
    api.search ||
    api.hash
  )
    throw new Error("EventsApiEndpoint is outside the intended API target");
  if (
    issuer.protocol !== "https:" ||
    issuer.origin + issuer.pathname !== outputs.CognitoIssuer ||
    issuer.hostname !== "cognito-idp.us-east-1.amazonaws.com" ||
    !issuer.pathname.startsWith("/us-east-1_")
  )
    throw new Error("Cognito issuer is outside the intended region");
  if (
    domain.protocol !== "https:" ||
    domain.origin !== outputs.CognitoDomain ||
    !domain.hostname.endsWith(".auth.us-east-1.amazoncognito.com") ||
    domain.pathname !== "/"
  )
    throw new Error("Cognito domain is outside the intended region");
  if (
    outputs.CognitoScope !== "events/events:read" ||
    outputs.CognitoCallbackUrl !== `${outputs.WebOrigin}/auth/callback`
  )
    throw new Error(
      "Cognito scope/callback outputs are not exactly bound to the web origin",
    );
  if (
    !/^E[A-Z0-9]{10,20}$/.test(outputs.WebDistributionId) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(outputs.WebAssetsBucketName) ||
    !/^us-east-1_[A-Za-z0-9]+$/.test(outputs.CognitoUserPoolId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(outputs.CognitoClientId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(outputs.ReviewerCognitoClientId) ||
    !/^[A-Za-z0-9-_]{1,64}$/.test(outputs.LiveOddsIngestionFunctionName) ||
    outputs.SharpApiSecretName !== "find-the-edge/dev/sharpapi"
  )
    throw new Error("A launch output has an invalid target identifier");
}
export function requireInvalidationId(response) {
  const id = response?.Invalidation?.Id;
  if (!/^I[A-Z0-9]{8,63}$/.test(id ?? ""))
    throw new Error(
      "CloudFront did not return a valid invalidation identifier",
    );
  return id;
}

export function releaseSnapshotArguments(bucket) {
  return [
    "s3api",
    "list-object-versions",
    "--bucket",
    bucket,
    "--region",
    LAUNCH_REGION,
    "--query",
    "{Versions:Versions[?IsLatest==`true`].{Key:Key,VersionId:VersionId,IsLatest:IsLatest},DeleteMarkers:DeleteMarkers[?IsLatest==`true`].{Key:Key,VersionId:VersionId,IsLatest:IsLatest}}",
    "--output",
    "json",
  ];
}

function releaseSnapshot(bucket, environment) {
  verifyIdentity(environment);
  return JSON.parse(
    run("aws", releaseSnapshotArguments(bucket), {
      capture: true,
      env: environment,
    }),
  );
}

export function planReleaseRollback(snapshot, current) {
  const prior = new Map();
  for (const item of [
    ...(snapshot.Versions ?? []),
    ...(snapshot.DeleteMarkers ?? []),
  ])
    if (item.IsLatest) prior.set(item.Key, item);
  const currentKeys = new Set(
    [...(current.Versions ?? []), ...(current.DeleteMarkers ?? [])]
      .filter((item) => item.IsLatest)
      .map((item) => item.Key),
  );
  return {
    restore: [...prior.values()].filter(
      (item) => item.VersionId && !snapshot.DeleteMarkers?.includes(item),
    ),
    remove: [
      ...new Set([
        ...[...currentKeys].filter((key) => !prior.has(key)),
        ...[...prior.entries()]
          .filter(([, item]) => snapshot.DeleteMarkers?.includes(item))
          .map(([key]) => key),
      ]),
    ],
  };
}

function restoreRelease(snapshot, outputs, environment) {
  const current = releaseSnapshot(outputs.WebAssetsBucketName, environment);
  const plan = planReleaseRollback(snapshot, current);
  for (const item of plan.restore)
    guardedRun(
      "aws",
      [
        "s3api",
        "copy-object",
        "--bucket",
        outputs.WebAssetsBucketName,
        "--key",
        item.Key,
        "--copy-source",
        `${outputs.WebAssetsBucketName}/${item.Key.split("/")
          .map(encodeURIComponent)
          .join("/")}?versionId=${encodeURIComponent(item.VersionId)}`,
        "--region",
        LAUNCH_REGION,
      ],
      environment,
      { capture: true },
    );
  for (const key of plan.remove)
    guardedRun(
      "aws",
      [
        "s3api",
        "delete-object",
        "--bucket",
        outputs.WebAssetsBucketName,
        "--key",
        key,
        "--region",
        LAUNCH_REGION,
      ],
      environment,
      { capture: true },
    );
  const invalidation = JSON.parse(
    guardedRun(
      "aws",
      [
        "cloudfront",
        "create-invalidation",
        "--distribution-id",
        outputs.WebDistributionId,
        "--paths",
        "/*",
        "--output",
        "json",
      ],
      environment,
      { capture: true },
    ),
  );
  guardedRun(
    "aws",
    [
      "cloudfront",
      "wait",
      "invalidation-completed",
      "--distribution-id",
      outputs.WebDistributionId,
      "--id",
      requireInvalidationId(invalidation),
    ],
    environment,
    { capture: true, timeout: 600_000 },
  );
}

export function combineLaunchAndRollbackFailures(primary, rollback) {
  const primaryCode = classifyReleaseVerificationFailure(primary);
  void rollback;
  return new Error(
    `Launch operation failed (${primaryCode}); release rollback also failed (details redacted)`,
  );
}

export function classifyReleaseVerificationFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const known = [
    [
      "live ingestion returned an invalid control-plane summary",
      "live-ingestion-summary-invalid",
    ],
    [
      "live ingestion returned an invalid legacy summary",
      "live-ingestion-summary-invalid",
    ],
    [
      "live ingestion Lambda invocation failed",
      "live-ingestion-invocation-failed",
    ],
    ["no provider-backed games were visible", "provider-games-unavailable"],
    [
      "no provider-backed spread/total/moneyline board was visible",
      "full-market-board-unavailable",
    ],
    ["CloudFront HTTP did not redirect", "cloudfront-redirect-invalid"],
    ["Anonymous direct S3 object access was not denied", "s3-origin-public"],
    ["Hosted index was unavailable", "hosted-index-unavailable"],
  ];
  return (
    known.find(([prefix]) => message.startsWith(prefix))?.[1] ??
    "release-verification-failed"
  );
}

export async function cleanupTemporaryLaunch({
  directory,
  userCreated,
  userPoolId,
  username,
  deleteUser,
  write = writeFile,
  remove = rm,
}) {
  const failures = [];
  try {
    if (userCreated) {
      const deleteInput = resolve(directory, "delete-user.json");
      await write(
        deleteInput,
        JSON.stringify({ UserPoolId: userPoolId, Username: username }),
        { mode: 0o600 },
      );
      await deleteUser(deleteInput);
    }
  } catch {
    failures.push("user deletion");
  } finally {
    try {
      await remove(directory, { recursive: true, force: true });
    } catch {
      failures.push("filesystem removal");
    }
  }
  if (failures.length > 0)
    throw new Error(`Temporary launch cleanup failed: ${failures.join("; ")}`);
}

export function combineLaunchAndCleanupFailures(primary, cleanup) {
  void primary;
  void cleanup;
  return new Error(
    "Launch operation failed (details redacted); temporary launch cleanup also failed (details redacted)",
  );
}

export async function phase1Launch(environment = process.env) {
  validateLaunchEnvironment(environment);
  verifyIdentity(environment);
  const deployEnvironment = {
    ...environment,
    CDK_DEFAULT_ACCOUNT: LAUNCH_ACCOUNT,
    CDK_DEFAULT_REGION: LAUNCH_REGION,
    FTE_AWS_STAGE: "dev",
    FTE_FIXTURE_ODDS_SEED_ENABLED: "false",
    FTE_UPCOMING_SCHEDULER_ENABLED: "true",
  };
  run("pnpm", ["--filter", "@find-the-edge/infra-cdk", "build"], {
    env: deployEnvironment,
  });
  run(
    "pnpm",
    [
      "--filter",
      "@find-the-edge/infra-cdk",
      "exec",
      "cdk",
      "synth",
      "--app",
      "node dist/app.js",
      LAUNCH_STACK,
    ],
    { env: deployEnvironment },
  );
  const proposedTemplate = JSON.parse(
    await readFile(
      resolve("infra/cdk/cdk.out", `${LAUNCH_STACK}.template.json`),
      "utf8",
    ),
  );
  const deployedStack = existingStack(deployEnvironment);
  if (deployedStack) {
    const deployedTemplate = JSON.parse(
      run(
        "aws",
        [
          "cloudformation",
          "get-template",
          "--stack-name",
          deployedStack.StackId,
          "--region",
          LAUNCH_REGION,
          "--template-stage",
          "Original",
          "--output",
          "json",
        ],
        { capture: true, env: deployEnvironment },
      ),
    ).TemplateBody;
    assertRetainedResourcesSafe(
      typeof deployedTemplate === "string"
        ? JSON.parse(deployedTemplate)
        : deployedTemplate,
      proposedTemplate,
    );
    await verifyStackDrift(deployEnvironment);
  }
  guardedRun(
    "pnpm",
    [
      "--filter",
      "@find-the-edge/infra-cdk",
      "exec",
      "cdk",
      "deploy",
      "--app",
      "node dist/app.js",
      LAUNCH_STACK,
      "--require-approval",
      "never",
    ],
    deployEnvironment,
    { timeout: 1_800_000 },
  );
  const outputs = stackOutputs(deployEnvironment);
  const required = [
    "EventsApiEndpoint",
    "WebOrigin",
    "WebDistributionId",
    "WebAssetsBucketName",
    "CognitoIssuer",
    "CognitoUserPoolId",
    "CognitoClientId",
    "ReviewerCognitoClientId",
    "CognitoDomain",
    "CognitoScope",
    "CognitoCallbackUrl",
    "LiveOddsIngestionFunctionName",
    "SharpApiSecretName",
  ];
  if (required.some((key) => !outputs[key]))
    throw new Error(
      "Deployed stack did not return all required launch outputs",
    );
  validateStackOutputs(outputs);
  verifyDeployedOutputBindings(outputs, deployEnvironment);
  const bundleEnvironment = {
    ...deployEnvironment,
    FTE_PHASE1_API_BASE: outputs.EventsApiEndpoint,
    FTE_PHASE1_PROVIDER_KEY: "cognitoSession",
    FTE_JWT_ISSUER: outputs.CognitoIssuer,
    FTE_JWT_AUDIENCE: outputs.CognitoClientId,
    FTE_COGNITO_DOMAIN: outputs.CognitoDomain,
    FTE_COGNITO_SCOPE: outputs.CognitoScope,
    FTE_COGNITO_CALLBACK_URL: outputs.CognitoCallbackUrl,
    FTE_COGNITO_LOGOUT_URL: outputs.WebOrigin,
    FTE_WEB_ORIGIN: outputs.WebOrigin,
  };
  const { output } = await buildPhase1Web(bundleEnvironment);
  const snapshot = releaseSnapshot(
    outputs.WebAssetsBucketName,
    deployEnvironment,
  );
  try {
    guardedRun(
      "aws",
      [
        "s3",
        "sync",
        output,
        `s3://${outputs.WebAssetsBucketName}`,
        "--delete",
        "--region",
        LAUNCH_REGION,
      ],
      deployEnvironment,
    );
    const invalidation = JSON.parse(
      guardedRun(
        "aws",
        [
          "cloudfront",
          "create-invalidation",
          "--distribution-id",
          outputs.WebDistributionId,
          "--paths",
          "/*",
          "--output",
          "json",
        ],
        deployEnvironment,
        { capture: true },
      ),
    );
    const invalidationId = requireInvalidationId(invalidation);
    guardedRun(
      "aws",
      [
        "cloudfront",
        "wait",
        "invalidation-completed",
        "--distribution-id",
        outputs.WebDistributionId,
        "--id",
        invalidationId,
      ],
      deployEnvironment,
      { capture: true, timeout: 600_000 },
    );
    await phase1EnvironmentSmoke({
      ...bundleEnvironment,
      AWS_ACCOUNT_ID: LAUNCH_ACCOUNT,
      AWS_REGION: LAUNCH_REGION,
      FTE_PHASE1_SMOKE: "1",
      FTE_PHASE1_API_BASE: outputs.EventsApiEndpoint,
      FTE_LIVE_ODDS_FUNCTION_NAME: outputs.LiveOddsIngestionFunctionName,
      FTE_PHASE1_BROWSER_BASE_URL: outputs.WebOrigin,
      FTE_PHASE1_STACK_ID: outputs.StackId,
      FTE_WEB_ASSETS_BUCKET_NAME: outputs.WebAssetsBucketName,
    });
    return { webOrigin: outputs.WebOrigin, outputs };
  } catch (primaryFailure) {
    try {
      restoreRelease(snapshot, outputs, deployEnvironment);
    } catch (rollbackFailure) {
      throw combineLaunchAndRollbackFailures(primaryFailure, rollbackFailure);
    }
    throw primaryFailure;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  phase1Launch()
    .then(({ webOrigin }) =>
      process.stdout.write(`Phase1 launch completed at ${webOrigin}\n`),
    )
    .catch((error) => {
      process.stderr.write(
        `Phase1 launch failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    });
}
