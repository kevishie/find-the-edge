import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertRetainedResourcesSafe,
  assertDeployedTemplateMatches,
  assertStackDriftSafe,
  assertStackResourceDriftsSafe,
  assertDeployedOutputBindings,
  combineLaunchAndCleanupFailures,
  combineLaunchAndRollbackFailures,
  classifyReleaseVerificationFailure,
  cleanupTemporaryLaunch,
  deployStagedDynamoGsiUpdates,
  planDynamoGsiDeploymentStages,
  resolveDynamoGsiBinding,
  retargetCloudAssemblyTemplateAsset,
  requireInvalidationId,
  releaseSnapshotArguments,
  resolveExistingStackSummary,
  planReleaseRollback,
  validateStackOutputs,
  validateLaunchEnvironment,
  selectLaunchTarget,
  waitForStackDriftResult,
  waitForDynamoGsiActive,
} from "./phase1-launch.mjs";

const valid = {
  FTE_PHASE1_LAUNCH: "1",
  AWS_ACCOUNT_ID: "228246988391",
  AWS_REGION: "us-east-1",
  FTE_PHASE1_USERNAME: "operator@example.com",
  FTE_EVENT_CURSOR_SECRET_ARN:
    "arn:aws:secretsmanager:us-east-1:228246988391:secret:cursor",
};
test("launch requires explicit opt-in and exact account/region", () => {
  assert.doesNotThrow(() => validateLaunchEnvironment(valid));
  assert.throws(
    () => validateLaunchEnvironment({ ...valid, FTE_PHASE1_LAUNCH: "0" }),
    /disabled/,
  );
  assert.throws(
    () =>
      validateLaunchEnvironment({ ...valid, AWS_ACCOUNT_ID: "000000000000" }),
    /restricted/,
  );
  assert.throws(
    () => validateLaunchEnvironment({ ...valid, AWS_REGION: "us-west-2" }),
    /restricted/,
  );
});
test("launch binds verified branches, stages, certificates, and release provenance", () => {
  const certificate =
    "arn:aws:acm:us-east-1:228246988391:certificate/11111111-1111-4111-8111-111111111111";
  const staging = {
    ...valid,
    FTE_AWS_STAGE: "staging",
    FTE_DEPLOY_BRANCH: "main",
    FTE_RELEASE_SHA: "0123456789abcdef0123456789abcdef01234567",
    FTE_WEB_CERTIFICATE_ARN: certificate,
    FTE_API_CERTIFICATE_ARN: certificate,
  };
  assert.equal(
    selectLaunchTarget(staging).stack,
    "FindTheEdge-staging-Foundation",
  );
  assert.throws(
    () =>
      validateLaunchEnvironment({
        ...staging,
        FTE_DEPLOY_BRANCH: "production",
      }),
    /branch/,
  );
  assert.throws(
    () => validateLaunchEnvironment({ ...staging, FTE_RELEASE_SHA: "latest" }),
    /verified commit/,
  );
  assert.throws(
    () =>
      validateLaunchEnvironment({
        ...staging,
        FTE_API_CERTIFICATE_ARN: certificate.replace("us-east-1", "us-west-2"),
      }),
    /certificate/,
  );
  selectLaunchTarget(valid);
});
test("release snapshots request only latest rollback material", () => {
  const arguments_ = releaseSnapshotArguments("safe-versioned-bucket");
  assert.deepEqual(arguments_.slice(0, 6), [
    "s3api",
    "list-object-versions",
    "--bucket",
    "safe-versioned-bucket",
    "--region",
    "us-east-1",
  ]);
  const query = arguments_[arguments_.indexOf("--query") + 1];
  assert.match(query, /Versions\[\?IsLatest==`true`\]/);
  assert.match(query, /DeleteMarkers\[\?IsLatest==`true`\]/);
  assert.doesNotMatch(query, /LastModified|ETag|Size|StorageClass|Owner/);
});
test("launch blocks modified, deleted, unknown, or incomplete drift", () => {
  assert.doesNotThrow(() =>
    assertStackDriftSafe({
      DetectionStatus: "DETECTION_COMPLETE",
      StackDriftStatus: "IN_SYNC",
    }),
  );
  for (const result of [
    { DetectionStatus: "DETECTION_COMPLETE", StackDriftStatus: "DRIFTED" },
    { DetectionStatus: "DETECTION_FAILED", StackDriftStatus: "UNKNOWN" },
    { DetectionStatus: "DETECTION_IN_PROGRESS" },
  ])
    assert.throws(() => assertStackDriftSafe(result), /drift/);
});
test("drift polling is bounded and requires a final in-sync result", async () => {
  const statuses = [
    { DetectionStatus: "DETECTION_IN_PROGRESS" },
    { DetectionStatus: "DETECTION_COMPLETE", StackDriftStatus: "IN_SYNC" },
  ];
  let delays = 0;
  assert.equal(
    (
      await waitForStackDriftResult(() => statuses.shift(), {
        attempts: 2,
        delay: async () => {
          delays += 1;
        },
      })
    ).StackDriftStatus,
    "IN_SYNC",
  );
  assert.equal(delays, 1);
  await assert.rejects(
    waitForStackDriftResult(
      () => ({ DetectionStatus: "DETECTION_IN_PROGRESS" }),
      { attempts: 2, delay: async () => {} },
    ),
    /did not complete/,
  );
});
test("drift guard permits only AWS API log ARN normalization", () => {
  const actual =
    "arn:aws:logs:us-east-1:228246988391:log-group:FindTheEdge-dev-Foundation-EventApiAccessLogs-abc";
  const benign = {
    ResourceType: "AWS::ApiGatewayV2::Stage",
    StackResourceDriftStatus: "MODIFIED",
    PropertyDifferences: [
      {
        PropertyPath: "/AccessLogSettings/DestinationArn",
        DifferenceType: "NOT_EQUAL",
        ExpectedValue: `${actual}:*`,
        ActualValue: actual,
      },
    ],
  };
  assert.doesNotThrow(() => assertStackResourceDriftsSafe([benign]));
  for (const drift of [
    { ...benign, ResourceType: "AWS::DynamoDB::Table" },
    { ...benign, StackResourceDriftStatus: "DELETED" },
    {
      ...benign,
      PropertyDifferences: [
        { ...benign.PropertyDifferences[0], ActualValue: `${actual}-other` },
      ],
    },
  ])
    assert.throws(
      () => assertStackResourceDriftsSafe([drift]),
      /unresolved resource drift/,
    );
});
test("first launch safely distinguishes no stack from the exact active stack", () => {
  assert.equal(resolveExistingStackSummary([]), undefined);
  assert.equal(
    resolveExistingStackSummary([
      {
        StackName: "FindTheEdge-dev-Foundation",
        StackStatus: "DELETE_COMPLETE",
        StackId:
          "arn:aws:cloudformation:us-east-1:228246988391:stack/FindTheEdge-dev-Foundation/deleted",
      },
    ]),
    undefined,
  );
  const active = {
    StackName: "FindTheEdge-dev-Foundation",
    StackStatus: "CREATE_COMPLETE",
    StackId:
      "arn:aws:cloudformation:us-east-1:228246988391:stack/FindTheEdge-dev-Foundation/active",
  };
  assert.equal(resolveExistingStackSummary([active]), active);
  assert.throws(
    () =>
      resolveExistingStackSummary([
        {
          ...active,
          StackId: active.StackId.replace("228246988391", "000000000000"),
        },
      ]),
    /escaped/,
  );
  assert.throws(
    () => resolveExistingStackSummary([active, { ...active }]),
    /multiple/,
  );
});
test("CloudFront invalidation response must be captured before waiting", () => {
  assert.equal(
    requireInvalidationId({
      Invalidation: { Id: "I1BWGQU3SW3T0OCHCNFC9MKOZL" },
    }),
    "I1BWGQU3SW3T0OCHCNFC9MKOZL",
  );
  for (const response of [
    {},
    { Invalidation: {} },
    { Invalidation: { Id: "bad/id" } },
  ])
    assert.throws(
      () => requireInvalidationId(response),
      /invalidation identifier/,
    );
});
test("filesystem cleanup remains unconditional when user deletion fails", async () => {
  let removed = false;
  await assert.rejects(
    cleanupTemporaryLaunch({
      directory: "/generated/test-only",
      userCreated: true,
      userPoolId: "pool",
      username: "user",
      write: async () => {},
      deleteUser: async () => {
        throw new Error("sensitive provider error");
      },
      remove: async () => {
        removed = true;
      },
    }),
    /user deletion/,
  );
  assert.equal(removed, true);
});
test("cleanup reports dual failures without leaking raw paths or errors", async () => {
  let removeAttempts = 0;
  await assert.rejects(
    cleanupTemporaryLaunch({
      directory: "/private/secret/operator-path",
      userCreated: true,
      userPoolId: "pool",
      username: "user",
      write: async () => {},
      deleteUser: async () => {
        throw new Error("provider secret 123");
      },
      remove: async () => {
        removeAttempts += 1;
        throw new Error("EACCES /private/secret/operator-path");
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Temporary launch cleanup failed: user deletion; filesystem removal",
      );
      assert.doesNotMatch(
        error.message,
        /provider secret|EACCES|operator-path/,
      );
      return true;
    },
  );
  assert.equal(removeAttempts, 1);
});
test("primary launch and cleanup failures are combined without masking or leaks", () => {
  const error = combineLaunchAndCleanupFailures(
    new Error("primary token /private/path"),
    new Error("cleanup provider secret"),
  );
  assert.equal(
    error.message,
    "Launch operation failed (details redacted); temporary launch cleanup also failed (details redacted)",
  );
  assert.match(error.message, /Launch operation failed/);
  assert.match(error.message, /cleanup also failed/);
  assert.doesNotMatch(error.message, /token|private|provider secret/);
});
test("release rollback restores prior versions and removes partial new keys", () => {
  const snapshot = {
    Versions: [
      { Key: "index.html", VersionId: "v1", IsLatest: true },
      { Key: "assets/old.js", VersionId: "v2", IsLatest: true },
    ],
    DeleteMarkers: [{ Key: "removed.js", VersionId: "d1", IsLatest: true }],
  };
  const current = {
    Versions: [
      { Key: "index.html", VersionId: "v3", IsLatest: true },
      { Key: "assets/new.js", VersionId: "v4", IsLatest: true },
    ],
  };
  assert.deepEqual(planReleaseRollback(snapshot, current), {
    restore: [
      { Key: "index.html", VersionId: "v1", IsLatest: true },
      { Key: "assets/old.js", VersionId: "v2", IsLatest: true },
    ],
    remove: ["assets/new.js", "removed.js"],
  });
  const combined = combineLaunchAndRollbackFailures(
    new Error("smoke secret /path"),
    new Error("rollback secret /path"),
  );
  assert.match(combined.message, /Launch operation failed/);
  assert.match(combined.message, /rollback also failed/);
  assert.doesNotMatch(combined.message, /secret|\/path/);
});

test("release verification failures expose only bounded diagnostic codes", () => {
  assert.equal(
    classifyReleaseVerificationFailure(
      new Error("live ingestion returned an invalid control-plane summary"),
    ),
    "live-ingestion-summary-invalid",
  );
  assert.equal(
    classifyReleaseVerificationFailure(new Error("secret raw provider error")),
    "release-verification-failed",
  );
  assert.equal(
    combineLaunchAndRollbackFailures(
      new Error("no provider-backed games were visible"),
      new Error("sensitive rollback failure"),
    ).message,
    "Launch operation failed (provider-games-unavailable); release rollback also failed (details redacted)",
  );
});
test("launch validates cursor secret input before AWS", () => {
  assert.throws(
    () =>
      validateLaunchEnvironment({
        ...valid,
        FTE_EVENT_CURSOR_SECRET_ARN:
          "arn:aws:secretsmanager:us-east-1:000000000000:secret:x",
      }),
    /cursor/,
  );
});
test("launch blocks destructive retained-table diffs", () => {
  const table = {
    Type: "AWS::DynamoDB::Table",
    Properties: { KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] },
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  };
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: { Table: table } },
      { Resources: { Table: structuredClone(table) } },
    ),
  );
  for (const mutation of [
    {},
    { Table: { ...table, DeletionPolicy: "Delete" } },
    {
      Table: {
        ...table,
        Properties: {
          KeySchema: [{ AttributeName: "other", KeyType: "HASH" }],
        },
      },
    },
  ])
    assert.throws(
      () =>
        assertRetainedResourcesSafe(
          { Resources: { Table: table } },
          { Resources: mutation },
        ),
      /retained|exactly/i,
    );
});
test("launch protects every retained S3, Cognito, and log resource", () => {
  const resources = {
    Bucket: {
      Type: "AWS::S3::Bucket",
      Properties: { BucketName: "assets" },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
    Pool: {
      Type: "AWS::Cognito::UserPool",
      Properties: { UsernameAttributes: ["email"] },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
    Logs: {
      Type: "AWS::Logs::LogGroup",
      Properties: { LogGroupName: "logs" },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
  };
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: resources },
      { Resources: structuredClone(resources) },
    ),
  );
  for (const [id, property, value] of [
    ["Bucket", "BucketName", "other"],
    ["Pool", "UsernameAttributes", ["phone_number"]],
    ["Logs", "LogGroupName", "other"],
  ]) {
    const proposed = structuredClone(resources);
    proposed[id].Properties[property] = value;
    assert.throws(
      () =>
        assertRetainedResourcesSafe(
          { Resources: resources },
          { Resources: proposed },
        ),
      /protected properties/,
    );
    delete proposed[id];
    assert.throws(
      () =>
        assertRetainedResourcesSafe(
          { Resources: resources },
          { Resources: proposed },
        ),
      /removed/,
    );
  }
});
test("retained guard is canonical, comprehensive, and fail-closed for unknown types", () => {
  const retained = {
    Type: "Custom::FutureDurableStore",
    Properties: { Security: { Encrypted: true }, Data: ["a", "b"] },
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  };
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: { Future: retained } },
      {
        Resources: {
          Future: {
            ...retained,
            Properties: { Data: ["a", "b"], Security: { Encrypted: true } },
          },
        },
      },
    ),
  );
  const changed = structuredClone(retained);
  changed.Properties.Security.Encrypted = false;
  assert.throws(
    () =>
      assertRetainedResourcesSafe(
        { Resources: { Future: retained } },
        { Resources: { Future: changed } },
      ),
    /protected properties/,
  );
});
test("retained guard allows monotonic upgrades and rejects conditions or security downgrades", () => {
  const resources = {
    Table: {
      Type: "AWS::DynamoDB::Table",
      Properties: {
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "localSk", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
          RecoveryPeriodInDays: 7,
        },
        SSESpecification: {
          SSEEnabled: true,
          SSEType: "KMS",
          KMSMasterKeyId: "key-1",
        },
        TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
        StreamSpecification: { StreamViewType: "NEW_IMAGE" },
        ResourcePolicy: { PolicyDocument: { Version: "2012-10-17" } },
        LocalSecondaryIndexes: [
          {
            IndexName: "local",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "localSk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "global",
            KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
            Projection: { ProjectionType: "KEYS_ONLY" },
          },
        ],
        Tags: [{ Key: "old", Value: "tag" }],
      },
      Condition: "KeepData",
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
    Bucket: {
      Type: "AWS::S3::Bucket",
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "aws:kms",
                KMSMasterKeyID: "key-1",
              },
            },
          ],
        },
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" },
        OwnershipControls: {
          Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
        },
        VersioningConfiguration: { Status: "Enabled" },
        ReplicationConfiguration: { Role: "replication-role", Rules: [] },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
    Pool: {
      Type: "AWS::Cognito::UserPool",
      Properties: {
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        Policies: {
          PasswordPolicy: { MinimumLength: 14, RequireSymbols: true },
        },
        MfaConfiguration: "OPTIONAL",
        EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
        SoftwareTokenMfaConfiguration: { Enabled: true },
        UserPoolAddOns: { AdvancedSecurityMode: "ENFORCED" },
        DeviceConfiguration: { ChallengeRequiredOnNewDevice: true },
        UserAttributeUpdateSettings: {
          AttributesRequireVerificationBeforeUpdate: ["email"],
        },
        LambdaConfig: { PreAuthentication: "lambda-arn" },
      },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
    Logs: {
      Type: "AWS::Logs::LogGroup",
      Properties: {
        RetentionInDays: 30,
        KmsKeyId: "key-1",
        DataProtectionPolicy: { Name: "protect" },
        FieldIndexPolicies: [{ Fields: ["requestId"] }],
        ResourcePolicyDocument: { Version: "2012-10-17" },
        LogGroupClass: "STANDARD",
      },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    },
  };
  const upgraded = structuredClone(resources);
  upgraded.Table.Properties.Tags = [{ Key: "new", Value: "tag" }];
  upgraded.Table.Properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays = 35;
  upgraded.Table.Properties.AttributeDefinitions.push(
    { AttributeName: "newPk", AttributeType: "S" },
    { AttributeName: "newSk", AttributeType: "N" },
  );
  upgraded.Table.Properties.GlobalSecondaryIndexes.push({
    IndexName: "new",
    KeySchema: [
      { AttributeName: "newPk", KeyType: "HASH" },
      { AttributeName: "newSk", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
  });
  upgraded.Bucket.Properties.LifecycleConfiguration = { Rules: [] };
  upgraded.Pool.Properties.Policies.PasswordPolicy.MinimumLength = 16;
  upgraded.Pool.Properties.Tags = { owner: "security" };
  upgraded.Logs.Properties.RetentionInDays = 365;
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: resources },
      { Resources: upgraded },
    ),
  );
  for (const mutate of [
    (copy) => delete copy.Table.Condition,
    (copy) =>
      (copy.Table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled = false),
    (copy) =>
      (copy.Table.Properties.PointInTimeRecoverySpecification.RecoveryPeriodInDays = 3),
    (copy) => (copy.Table.Properties.SSESpecification.SSEType = "AES256"),
    (copy) => (copy.Table.Properties.SSESpecification.KMSMasterKeyId = "key-2"),
    (copy) =>
      (copy.Table.Properties.LocalSecondaryIndexes[0].Projection.ProjectionType =
        "KEYS_ONLY"),
    (copy) =>
      (copy.Table.Properties.GlobalSecondaryIndexes[0].Projection.ProjectionType =
        "ALL"),
    (copy) => delete copy.Table.Properties.TimeToLiveSpecification,
    (copy) => delete copy.Table.Properties.StreamSpecification,
    (copy) => delete copy.Table.Properties.ResourcePolicy,
    (copy) =>
      (copy.Bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy = false),
    (copy) => delete copy.Bucket.Properties.BucketEncryption,
    (copy) =>
      (copy.Bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm =
        "AES256"),
    (copy) =>
      (copy.Bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.KMSMasterKeyID =
        "key-2"),
    (copy) => delete copy.Bucket.Properties.ObjectLockConfiguration,
    (copy) => delete copy.Bucket.Properties.OwnershipControls,
    (copy) =>
      (copy.Bucket.Properties.VersioningConfiguration.Status = "Suspended"),
    (copy) => delete copy.Bucket.Properties.ReplicationConfiguration,
    (copy) =>
      (copy.Bucket.Properties.LifecycleConfiguration = {
        Rules: [{ Expiration: { Days: 1 } }],
      }),
    (copy) => (copy.Pool.Properties.Policies.PasswordPolicy.MinimumLength = 12),
    (copy) =>
      (copy.Pool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly = false),
    (copy) => (copy.Pool.Properties.MfaConfiguration = "OFF"),
    (copy) => (copy.Pool.Properties.EnabledMfas = []),
    (copy) =>
      (copy.Pool.Properties.SoftwareTokenMfaConfiguration.Enabled = false),
    (copy) => delete copy.Pool.Properties.UserPoolAddOns,
    (copy) => delete copy.Pool.Properties.DeviceConfiguration,
    (copy) => delete copy.Pool.Properties.UserAttributeUpdateSettings,
    (copy) => delete copy.Pool.Properties.LambdaConfig,
    (copy) => (copy.Logs.Properties.RetentionInDays = 7),
    (copy) => (copy.Logs.Properties.KmsKeyId = "key-2"),
    (copy) => (copy.Logs.Properties.DataProtectionPolicy.Name = "other"),
    (copy) => delete copy.Logs.Properties.FieldIndexPolicies,
    (copy) => delete copy.Logs.Properties.ResourcePolicyDocument,
    (copy) => (copy.Logs.Properties.LogGroupClass = "INFREQUENT_ACCESS"),
  ]) {
    const weakened = structuredClone(resources);
    mutate(weakened);
    assert.throws(() =>
      assertRetainedResourcesSafe(
        { Resources: resources },
        { Resources: weakened },
      ),
    );
  }
});

test("retained guard permits only GSI-backed additive attribute definitions", () => {
  const table = {
    Type: "AWS::DynamoDB::Table",
    Properties: {
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "existing",
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ],
    },
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  };
  const upgraded = structuredClone(table);
  upgraded.Properties.AttributeDefinitions.push(
    { AttributeName: "activePk", AttributeType: "S" },
    { AttributeName: "activeSk", AttributeType: "N" },
  );
  upgraded.Properties.GlobalSecondaryIndexes.push({
    IndexName: "opportunity-active-v1",
    KeySchema: [
      { AttributeName: "activePk", KeyType: "HASH" },
      { AttributeName: "activeSk", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
  });
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: { Table: table } },
      { Resources: { Table: upgraded } },
    ),
  );
  const reordered = structuredClone(upgraded);
  reordered.Properties.AttributeDefinitions.reverse();
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: { Table: table } },
      { Resources: { Table: reordered } },
    ),
  );
  const reuseExisting = structuredClone(table);
  reuseExisting.Properties.GlobalSecondaryIndexes.push({
    IndexName: "reuse-existing",
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
    Projection: { ProjectionType: "ALL" },
  });
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: { Table: table } },
      { Resources: { Table: reuseExisting } },
    ),
  );
  for (const mutate of [
    (copy) =>
      copy.Properties.AttributeDefinitions.push({
        AttributeName: "orphan",
        AttributeType: "S",
      }),
    (copy) => copy.Properties.AttributeDefinitions.shift(),
    (copy) => (copy.Properties.AttributeDefinitions[0].AttributeType = "N"),
    (copy) =>
      copy.Properties.AttributeDefinitions.push({
        AttributeName: "pk",
        AttributeType: "N",
      }),
    (copy) => delete copy.Properties.GlobalSecondaryIndexes[1].IndexName,
    (copy) =>
      copy.Properties.GlobalSecondaryIndexes.push(
        structuredClone(copy.Properties.GlobalSecondaryIndexes[1]),
      ),
    (copy) => (copy.Properties.GlobalSecondaryIndexes[1].IndexName = " "),
    (copy) =>
      (copy.Properties.GlobalSecondaryIndexes[1].KeySchema[1].AttributeName =
        "missing"),
    (copy) => copy.Properties.GlobalSecondaryIndexes.shift(),
    (copy) =>
      (copy.Properties.GlobalSecondaryIndexes[0].Projection.ProjectionType =
        "ALL"),
    (copy) =>
      (copy.Properties.GlobalSecondaryIndexes[0].ContributorInsightsSpecification =
        {
          Enabled: true,
        }),
  ]) {
    const unsafe = structuredClone(upgraded);
    mutate(unsafe);
    assert.throws(
      () =>
        assertRetainedResourcesSafe(
          { Resources: { Table: table } },
          { Resources: { Table: unsafe } },
        ),
      /protected properties/,
    );
  }
});

const stagedIndex = (name, partitionKey, sortKey) => ({
  IndexName: name,
  KeySchema: [
    { AttributeName: partitionKey, KeyType: "HASH" },
    { AttributeName: sortKey, KeyType: "RANGE" },
  ],
  Projection: { ProjectionType: "KEYS_ONLY" },
});

function stagedGsiTemplate(indexes) {
  const attributeNames = new Set(["pk", "sk"]);
  for (const index of indexes)
    for (const key of index.KeySchema) attributeNames.add(key.AttributeName);
  return {
    Resources: {
      EventIngestionTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          AttributeDefinitions: [...attributeNames].map((AttributeName) => ({
            AttributeName,
            AttributeType: "S",
          })),
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: structuredClone(indexes),
        },
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      },
    },
    Outputs: { ExistingOutput: { Value: "unchanged" } },
  };
}

test("GSI stage planning deterministically leaves only one index for the final deploy", () => {
  const existingIndex = stagedIndex("existing-v1", "pk", "sk");
  const activeIndex = stagedIndex(
    "opportunity-active-v1",
    "activePk",
    "activeSk",
  );
  const rankIndex = stagedIndex("opportunity-rank-v1", "rankPk", "rankSk");
  const existing = stagedGsiTemplate([existingIndex]);
  const target = stagedGsiTemplate([existingIndex, rankIndex, activeIndex]);
  const stages = planDynamoGsiDeploymentStages(existing, target);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].logicalId, "EventIngestionTable");
  assert.equal(stages[0].indexName, "opportunity-active-v1");
  assert.deepEqual(
    stages[0].template.Resources.EventIngestionTable.Properties.GlobalSecondaryIndexes.map(
      ({ IndexName }) => IndexName,
    ),
    ["existing-v1", "opportunity-active-v1"],
  );
  assert.deepEqual(stages[0].template.Outputs, existing.Outputs);
  assert.deepEqual(
    target.Resources.EventIngestionTable.Properties.GlobalSecondaryIndexes.map(
      ({ IndexName }) => IndexName,
    ),
    ["existing-v1", "opportunity-rank-v1", "opportunity-active-v1"],
  );
  assert.equal(
    planDynamoGsiDeploymentStages(stages[0].template, target).length,
    0,
  );
});

test("GSI stage planning fails closed on removals, mutations, ambiguity, and excessive stages", () => {
  const existingIndex = stagedIndex("existing-v1", "pk", "sk");
  const existing = stagedGsiTemplate([existingIndex]);
  const additive = stagedGsiTemplate([
    existingIndex,
    stagedIndex("new-index-v1", "newPk", "newSk"),
  ]);
  const removed = stagedGsiTemplate([]);
  assert.throws(
    () => planDynamoGsiDeploymentStages(existing, removed),
    /protected properties|index removal/,
  );
  const mutated = structuredClone(additive);
  mutated.Resources.EventIngestionTable.Properties.GlobalSecondaryIndexes[0].Projection.ProjectionType =
    "ALL";
  assert.throws(
    () => planDynamoGsiDeploymentStages(existing, mutated),
    /protected properties|index mutation/,
  );
  for (const ambiguous of [
    (() => {
      const copy = structuredClone(additive);
      delete copy.Resources.EventIngestionTable.Properties
        .GlobalSecondaryIndexes[1].IndexName;
      return copy;
    })(),
    (() => {
      const copy = structuredClone(additive);
      copy.Resources.EventIngestionTable.Properties.GlobalSecondaryIndexes.push(
        structuredClone(
          copy.Resources.EventIngestionTable.Properties
            .GlobalSecondaryIndexes[1],
        ),
      );
      return copy;
    })(),
  ])
    assert.throws(
      () => planDynamoGsiDeploymentStages(existing, ambiguous),
      /protected properties|ambiguous/,
    );
  const ambiguousExisting = structuredClone(existing);
  ambiguousExisting.Resources.EventIngestionTable.Properties.GlobalSecondaryIndexes[0].KeySchema =
    [];
  assert.throws(
    () =>
      planDynamoGsiDeploymentStages(
        ambiguousExisting,
        structuredClone(ambiguousExisting),
      ),
    /ambiguous/,
  );
  const tooMany = stagedGsiTemplate([
    existingIndex,
    ...Array.from({ length: 10 }, (_, index) =>
      stagedIndex(`new-index-${index}`, `newPk${index}`, `newSk${index}`),
    ),
  ]);
  assert.throws(
    () => planDynamoGsiDeploymentStages(existing, tooMany),
    /too many intermediate updates/,
  );
});

function cloudAssemblyFixture(templateContents) {
  const hash = createHash("sha256").update(templateContents).digest("hex");
  return {
    hash,
    manifest: {
      artifacts: {
        "FindTheEdge-dev-Foundation": {
          type: "aws:cloudformation:stack",
          properties: {
            templateFile: "FindTheEdge-dev-Foundation.template.json",
            stackTemplateAssetObjectUrl: `s3://cdk-hnb659fds-assets-228246988391-us-east-1/${hash}.json`,
            additionalDependencies: ["FindTheEdge-dev-Foundation.assets"],
          },
          dependencies: ["FindTheEdge-dev-Foundation.assets"],
        },
        "FindTheEdge-dev-Foundation.assets": {
          type: "cdk:asset-manifest",
          properties: { file: "FindTheEdge-dev-Foundation.assets.json" },
        },
      },
    },
    assets: {
      files: {
        [hash]: {
          displayName: "FindTheEdge-dev-Foundation Template",
          source: {
            path: "FindTheEdge-dev-Foundation.template.json",
            packaging: "file",
          },
          destinations: {
            target: {
              bucketName: "cdk-hnb659fds-assets-228246988391-us-east-1",
              objectKey: `${hash}.json`,
              region: "us-east-1",
            },
          },
        },
      },
    },
  };
}

test("staged CDK assembly retargets the content-addressed template asset on every update", () => {
  const initial = cloudAssemblyFixture('{"stage":"target"}');
  const firstContents = '{"stage":"first"}';
  const first = retargetCloudAssemblyTemplateAsset(
    initial.manifest,
    initial.assets,
    firstContents,
  );
  const firstHash = createHash("sha256").update(firstContents).digest("hex");
  assert.equal(first.templateHash, firstHash);
  assert.equal(first.assetManifest.files[initial.hash], undefined);
  assert.equal(
    first.manifest.artifacts["FindTheEdge-dev-Foundation"].properties
      .stackTemplateAssetObjectUrl,
    `s3://cdk-hnb659fds-assets-228246988391-us-east-1/${firstHash}.json`,
  );
  assert.equal(
    first.assetManifest.files[firstHash].destinations.target.objectKey,
    `${firstHash}.json`,
  );
  const secondContents = '{"stage":"second"}';
  const second = retargetCloudAssemblyTemplateAsset(
    first.manifest,
    first.assetManifest,
    Buffer.from(secondContents),
  );
  const secondHash = createHash("sha256").update(secondContents).digest("hex");
  assert.equal(second.templateHash, secondHash);
  assert.equal(second.assetManifest.files[firstHash], undefined);
  assert.ok(second.assetManifest.files[secondHash]);
  const inconsistent = structuredClone(first.assetManifest);
  inconsistent.files[firstHash].destinations.target.objectKey =
    "cached-target.json";
  assert.throws(
    () =>
      retargetCloudAssemblyTemplateAsset(
        first.manifest,
        inconsistent,
        secondContents,
      ),
    /destination is inconsistent/,
  );
});

test("DynamoDB GSI readiness binds the exact stack table and waits for ACTIVE", async () => {
  const stackId =
    "arn:aws:cloudformation:us-east-1:228246988391:stack/FindTheEdge-dev-Foundation/id";
  const binding = resolveDynamoGsiBinding(
    {
      StackResourceDetail: {
        StackId: stackId,
        LogicalResourceId: "EventIngestionTable",
        PhysicalResourceId: "find-the-edge-events",
        ResourceType: "AWS::DynamoDB::Table",
        ResourceStatus: "UPDATE_COMPLETE",
      },
    },
    {
      stackId,
      logicalId: "EventIngestionTable",
      indexName: "opportunity-active-v1",
    },
  );
  assert.deepEqual(binding, {
    tableName: "find-the-edge-events",
    tableArn:
      "arn:aws:dynamodb:us-east-1:228246988391:table/find-the-edge-events",
    indexName: "opportunity-active-v1",
  });
  const response = (TableStatus, IndexStatus) => ({
    Table: {
      TableName: binding.tableName,
      TableArn: binding.tableArn,
      TableStatus,
      GlobalSecondaryIndexes: [
        {
          IndexName: binding.indexName,
          IndexArn: `${binding.tableArn}/index/${binding.indexName}`,
          IndexStatus,
        },
      ],
    },
  });
  const states = [
    response("UPDATING", "CREATING"),
    response("ACTIVE", "ACTIVE"),
  ];
  let delays = 0;
  assert.equal(
    (
      await waitForDynamoGsiActive(() => states.shift(), binding, {
        attempts: 2,
        delay: async () => {
          delays += 1;
        },
      })
    ).Table.TableStatus,
    "ACTIVE",
  );
  assert.equal(delays, 1);
  for (const unsafe of [
    {
      ...response("ACTIVE", "ACTIVE"),
      Table: {
        ...response("ACTIVE", "ACTIVE").Table,
        TableArn: `${binding.tableArn}-other`,
      },
    },
    {
      ...response("ACTIVE", "ACTIVE"),
      Table: {
        ...response("ACTIVE", "ACTIVE").Table,
        GlobalSecondaryIndexes: [
          {
            ...response("ACTIVE", "ACTIVE").Table.GlobalSecondaryIndexes[0],
            IndexArn: `${binding.tableArn}/index/other`,
          },
        ],
      },
    },
    response("DELETING", "DELETING"),
  ])
    await assert.rejects(
      waitForDynamoGsiActive(async () => unsafe, binding, {
        attempts: 1,
        delay: async () => {},
      }),
      /escaped|intended index|unsafe readiness state/,
    );
  await assert.rejects(
    waitForDynamoGsiActive(
      async () => response("UPDATING", "CREATING"),
      binding,
      { attempts: 2, delay: async () => {} },
    ),
    /did not become active in time/,
  );
  await assert.rejects(
    waitForDynamoGsiActive(async () => {
      throw new Error("provider details");
    }, binding),
    (error) => {
      assert.equal(
        error.message,
        "DynamoDB GSI readiness could not be verified",
      );
      return true;
    },
  );
  assert.throws(
    () =>
      resolveDynamoGsiBinding(
        { StackResourceDetail: { PhysicalResourceId: "other" } },
        { stackId, logicalId: "EventIngestionTable", indexName: "index-v1" },
      ),
    /intended DynamoDB table/,
  );
});

test("staged GSI deployment waits, re-reads, and drift-checks every intermediate template", async () => {
  const existingIndex = stagedIndex("existing-v1", "pk", "sk");
  const target = stagedGsiTemplate([
    existingIndex,
    stagedIndex("opportunity-rank-v1", "rankPk", "rankSk"),
    stagedIndex("opportunity-active-v1", "activePk", "activeSk"),
    stagedIndex("opportunity-third-v1", "thirdPk", "thirdSk"),
  ]);
  const events = [];
  let deployed;
  const result = await deployStagedDynamoGsiUpdates({
    deployedTemplate: stagedGsiTemplate([existingIndex]),
    targetTemplate: target,
    deployStage: async (stage) => {
      events.push(`deploy:${stage.indexName}`);
      deployed = structuredClone(stage.template);
    },
    waitForStackStability: async () => events.push("wait"),
    waitForIndexActive: async () => events.push("active"),
    readDeployedTemplate: async () => {
      events.push("read");
      return structuredClone(deployed);
    },
    verifyDeployedDrift: async () => events.push("drift"),
  });
  assert.deepEqual(result.completed, [
    {
      logicalId: "EventIngestionTable",
      indexName: "opportunity-active-v1",
    },
    {
      logicalId: "EventIngestionTable",
      indexName: "opportunity-rank-v1",
    },
  ]);
  assert.deepEqual(events, [
    "deploy:opportunity-active-v1",
    "wait",
    "active",
    "read",
    "drift",
    "deploy:opportunity-rank-v1",
    "wait",
    "active",
    "read",
    "drift",
  ]);
  assert.equal(
    planDynamoGsiDeploymentStages(result.deployedTemplate, target).length,
    0,
  );
});

test("staged GSI deployment rejects an intermediate template mismatch before drift validation", async () => {
  const existingIndex = stagedIndex("existing-v1", "pk", "sk");
  const existing = stagedGsiTemplate([existingIndex]);
  const target = stagedGsiTemplate([
    existingIndex,
    stagedIndex("new-a-v1", "aPk", "aSk"),
    stagedIndex("new-b-v1", "bPk", "bSk"),
  ]);
  let driftChecks = 0;
  await assert.rejects(
    deployStagedDynamoGsiUpdates({
      deployedTemplate: existing,
      targetTemplate: target,
      deployStage: async () => {},
      waitForStackStability: async () => {},
      waitForIndexActive: async () => {},
      readDeployedTemplate: async () => existing,
      verifyDeployedDrift: async () => {
        driftChecks += 1;
      },
    }),
    /did not match expectation/,
  );
  assert.equal(driftChecks, 0);
  assert.throws(
    () => assertDeployedTemplateMatches(target, existing),
    /did not match expectation/,
  );
});

test("retained guard permits only the additive NEW_IMAGE table stream transition", () => {
  const table = {
    Type: "AWS::DynamoDB::Table",
    Properties: {
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    },
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  };
  const withNewImage = structuredClone(table);
  withNewImage.Properties.StreamSpecification = {
    StreamViewType: "NEW_IMAGE",
  };
  assert.doesNotThrow(() =>
    assertRetainedResourcesSafe(
      { Resources: { Table: table } },
      { Resources: { Table: withNewImage } },
    ),
  );
  for (const streamViewType of [
    "KEYS_ONLY",
    "OLD_IMAGE",
    "NEW_AND_OLD_IMAGES",
  ]) {
    const unsafe = structuredClone(table);
    unsafe.Properties.StreamSpecification = { StreamViewType: streamViewType };
    assert.throws(
      () =>
        assertRetainedResourcesSafe(
          { Resources: { Table: table } },
          { Resources: { Table: unsafe } },
        ),
      /protected properties/,
    );
  }
  assert.throws(
    () =>
      assertRetainedResourcesSafe(
        { Resources: { Table: withNewImage } },
        { Resources: { Table: table } },
      ),
    /protected properties/,
  );
});

const outputs = {
  EventsApiEndpoint: "https://abc123.execute-api.us-east-1.amazonaws.com/dev",
  WebOrigin: "https://abc123.cloudfront.net",
  WebDistributionId: "EABCDEFGHIJK",
  WebAssetsBucketName: "fte-assets-example",
  CognitoIssuer:
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Example",
  CognitoUserPoolId: "us-east-1_Example",
  CognitoClientId: "client_123",
  ReviewerCognitoClientId: "reviewer_client_123",
  CognitoDomain: "https://fte.auth.us-east-1.amazoncognito.com",
  CognitoScope: "events/events:read",
  ScoutingReadScope: "events/scouting:read",
  ScoutingWriteScope: "events/scouting:write",
  CognitoCallbackUrl: "https://abc123.cloudfront.net/auth/callback",
  LiveOddsIngestionFunctionName: "fte-live-odds",
  SharpApiSecretName: "find-the-edge/dev/sharpapi",
};
test("launch binds every discovered output to intended targets", () => {
  assert.doesNotThrow(() => validateStackOutputs(outputs));
  for (const change of [
    { WebOrigin: "https://evil.example.com" },
    {
      EventsApiEndpoint: "https://abc.execute-api.us-west-2.amazonaws.com/dev",
    },
    { CognitoCallbackUrl: "https://other.cloudfront.net/auth/callback" },
    { CognitoScope: "other" },
    { ScoutingReadScope: "other" },
    { ScoutingWriteScope: "other" },
  ])
    assert.throws(() => validateStackOutputs({ ...outputs, ...change }));
});
test("custom-domain outputs bind the selected stage and exact release", () => {
  const target = {
    stage: "staging",
    stack: "FindTheEdge-staging-Foundation",
    secretPrefix: "find-the-edge/staging",
    webOrigin: "https://staging.kevishie.com",
    apiBase: "https://api-staging.kevishie.com",
  };
  const staged = {
    ...outputs,
    WebOrigin: target.webOrigin,
    EventsApiEndpoint: target.apiBase,
    CognitoCallbackUrl: `${target.webOrigin}/auth/callback`,
    SharpApiSecretName: "find-the-edge/staging/sharpapi",
    DeploymentStage: "staging",
    ReleaseSha: "0123456789abcdef0123456789abcdef01234567",
  };
  assert.doesNotThrow(() => validateStackOutputs(staged, target));
  assert.throws(() =>
    validateStackOutputs({ ...staged, DeploymentStage: "prod" }, target),
  );
  assert.throws(() =>
    validateStackOutputs({ ...staged, ReleaseSha: "latest" }, target),
  );
});
test("deployed output bindings require exact physical resources and distribution", () => {
  const resources = [
    ["AWS::S3::Bucket", outputs.WebAssetsBucketName],
    ["AWS::CloudFront::Distribution", outputs.WebDistributionId],
    ["AWS::Cognito::UserPool", outputs.CognitoUserPoolId],
    ["AWS::Cognito::UserPoolClient", outputs.CognitoClientId],
    ["AWS::Cognito::UserPoolClient", outputs.ReviewerCognitoClientId],
    ["AWS::Lambda::Function", outputs.LiveOddsIngestionFunctionName],
    ["AWS::ApiGatewayV2::Api", "abc123"],
  ].map(([ResourceType, PhysicalResourceId]) => ({
    ResourceType,
    PhysicalResourceId,
  }));
  const distribution = {
    Id: outputs.WebDistributionId,
    DomainName: "abc123.cloudfront.net",
    ARN: `arn:aws:cloudfront::228246988391:distribution/${outputs.WebDistributionId}`,
  };
  assert.doesNotThrow(() =>
    assertDeployedOutputBindings(outputs, resources, distribution),
  );
  for (const mutation of [
    () => resources.slice(1),
    () => resources.map((item) => ({ ...item, PhysicalResourceId: "wrong" })),
  ])
    assert.throws(() =>
      assertDeployedOutputBindings(outputs, mutation(), distribution),
    );
  assert.throws(() =>
    assertDeployedOutputBindings(outputs, resources, {
      ...distribution,
      DomainName: "wrong.cloudfront.net",
    }),
  );
});
