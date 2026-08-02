import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRetainedResourcesSafe,
  assertStackDriftSafe,
  assertDeployedOutputBindings,
  combineLaunchAndCleanupFailures,
  combineLaunchAndRollbackFailures,
  cleanupTemporaryLaunch,
  requireInvalidationId,
  resolveExistingStackSummary,
  planReleaseRollback,
  validateStackOutputs,
  validateLaunchEnvironment,
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
    requireInvalidationId({ Invalidation: { Id: "IABCDEFGHI" } }),
    "IABCDEFGHI",
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
test("launch validates private bootstrap inputs before AWS", () => {
  assert.throws(
    () => validateLaunchEnvironment({ ...valid, FTE_PHASE1_USERNAME: "bad" }),
    /email/,
  );
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
            KeySchema: ["key"],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "global",
            KeySchema: ["key"],
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
  upgraded.Table.Properties.GlobalSecondaryIndexes.push({
    IndexName: "new",
    KeySchema: ["new"],
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

const outputs = {
  EventsApiEndpoint: "https://abc123.execute-api.us-east-1.amazonaws.com/dev",
  WebOrigin: "https://abc123.cloudfront.net",
  WebDistributionId: "EABCDEFGHIJK",
  WebAssetsBucketName: "fte-assets-example",
  CognitoIssuer:
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Example",
  CognitoUserPoolId: "us-east-1_Example",
  CognitoClientId: "client_123",
  CognitoDomain: "https://fte.auth.us-east-1.amazoncognito.com",
  CognitoScope: "events/events:read",
  CognitoCallbackUrl: "https://abc123.cloudfront.net/auth/callback",
  FixtureOddsSeedFunctionName: "fte-seed",
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
  ])
    assert.throws(() => validateStackOutputs({ ...outputs, ...change }));
});
test("deployed output bindings require exact physical resources and distribution", () => {
  const resources = [
    ["AWS::S3::Bucket", outputs.WebAssetsBucketName],
    ["AWS::CloudFront::Distribution", outputs.WebDistributionId],
    ["AWS::Cognito::UserPool", outputs.CognitoUserPoolId],
    ["AWS::Cognito::UserPoolClient", outputs.CognitoClientId],
    ["AWS::Lambda::Function", outputs.FixtureOddsSeedFunctionName],
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
