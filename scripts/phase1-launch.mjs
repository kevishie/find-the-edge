import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPhase1Web } from "./build-phase1-web.mjs";
import { phase1EnvironmentSmoke } from "./phase1-environment-smoke.mjs";
import { run } from "./phase1-support.mjs";
import {
  deploymentEnvironment,
  validateDeploymentBranch,
} from "./environment-contract.mjs";

export const LAUNCH_ACCOUNT = "228246988391";
export const LAUNCH_REGION = "us-east-1";
export let LAUNCH_STACK = "FindTheEdge-dev-Foundation";
const legacyLaunchTarget = {
  stage: "dev",
  branch: "main",
  stack: LAUNCH_STACK,
  secretPrefix: "find-the-edge/dev",
  webOrigin: undefined,
  apiBase: undefined,
};
let activeLaunchTarget = legacyLaunchTarget;
export const MAX_INTERMEDIATE_GSI_STAGES = 8;
export const DYNAMO_GSI_ACTIVE_ATTEMPTS = 360;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function uniqueNamedMap(
  items,
  nameProperty,
  validName = (name) => name.length > 0,
) {
  if (items === undefined) return new Map();
  if (!Array.isArray(items)) return undefined;
  const mapped = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return undefined;
    const name = item[nameProperty];
    if (typeof name !== "string" || !validName(name) || mapped.has(name))
      return undefined;
    mapped.set(name, item);
  }
  return mapped;
}

function validDynamoIndexName(name) {
  return (
    name.length >= 3 && name.length <= 255 && /^[A-Za-z0-9_.-]+$/.test(name)
  );
}

function dynamoKeyAttributes(keySchema) {
  if (!Array.isArray(keySchema) || keySchema.length < 1 || keySchema.length > 2)
    return undefined;
  const attributes = new Set();
  const keyTypes = new Set();
  for (const key of keySchema) {
    if (!key || typeof key !== "object" || Array.isArray(key)) return undefined;
    if (
      typeof key.AttributeName !== "string" ||
      key.AttributeName.length === 0 ||
      (key.KeyType !== "HASH" && key.KeyType !== "RANGE") ||
      attributes.has(key.AttributeName) ||
      keyTypes.has(key.KeyType)
    )
      return undefined;
    attributes.add(key.AttributeName);
    keyTypes.add(key.KeyType);
  }
  if (!keyTypes.has("HASH")) return undefined;
  return attributes;
}

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
  if (environment.FTE_AWS_STAGE) {
    const target = validateDeploymentBranch(
      environment.FTE_AWS_STAGE,
      environment.FTE_DEPLOY_BRANCH,
    );
    if (!/^[0-9a-f]{40}$/.test(environment.FTE_RELEASE_SHA ?? ""))
      throw new Error(
        "FTE_RELEASE_SHA must identify the exact verified commit",
      );
    for (const name of ["FTE_WEB_CERTIFICATE_ARN", "FTE_API_CERTIFICATE_ARN"])
      if (
        !new RegExp(
          `^arn:aws:acm:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:certificate/[0-9a-f-]{36}$`,
        ).test(environment[name] ?? "")
      )
        throw new Error(
          `${name} must identify an ACM certificate in us-east-1`,
        );
    return target;
  }
  return legacyLaunchTarget;
}

export function selectLaunchTarget(environment) {
  const target = validateLaunchEnvironment(environment);
  activeLaunchTarget = target;
  LAUNCH_STACK = target.stack;
  return target;
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
  const preservesNamedIndexes = (oldIndexes, newIndexes) => {
    const oldByName = uniqueNamedMap(
      oldIndexes,
      "IndexName",
      validDynamoIndexName,
    );
    const newByName = uniqueNamedMap(
      newIndexes,
      "IndexName",
      validDynamoIndexName,
    );
    if (!oldByName || !newByName) return false;
    for (const [name, oldIndex] of oldByName) {
      const nextIndex = newByName.get(name);
      if (!nextIndex || !same(oldIndex, nextIndex)) return false;
    }
    return true;
  };
  const preservesDynamoAttributeDefinitions = (before, after) => {
    const oldDefinitions = uniqueNamedMap(
      before.AttributeDefinitions,
      "AttributeName",
    );
    const newDefinitions = uniqueNamedMap(
      after.AttributeDefinitions,
      "AttributeName",
    );
    const oldIndexes = uniqueNamedMap(
      before.GlobalSecondaryIndexes,
      "IndexName",
      validDynamoIndexName,
    );
    const newIndexes = uniqueNamedMap(
      after.GlobalSecondaryIndexes,
      "IndexName",
      validDynamoIndexName,
    );
    if (!oldDefinitions || !newDefinitions || !oldIndexes || !newIndexes)
      return false;
    for (const definition of [
      ...oldDefinitions.values(),
      ...newDefinitions.values(),
    ])
      if (!["S", "N", "B"].includes(definition.AttributeType)) return false;
    for (const [name, definition] of oldDefinitions)
      if (
        !newDefinitions.has(name) ||
        !same(definition.AttributeType, newDefinitions.get(name).AttributeType)
      )
        return false;
    const addedKeyAttributes = new Set();
    for (const [name, index] of newIndexes) {
      if (oldIndexes.has(name)) continue;
      const keyAttributes = dynamoKeyAttributes(index.KeySchema);
      if (!keyAttributes) return false;
      for (const attribute of keyAttributes) {
        if (!newDefinitions.has(attribute)) return false;
        addedKeyAttributes.add(attribute);
      }
    }
    for (const name of newDefinitions.keys())
      if (!oldDefinitions.has(name) && !addedKeyAttributes.has(name))
        return false;
    return true;
  };
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
          "KeySchema",
          "TimeToLiveSpecification",
          "ResourcePolicy",
        ]) &&
        preservesDynamoAttributeDefinitions(before, after) &&
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

function analyzeDynamoGsiChanges(existing, proposed) {
  if (
    !existing?.Resources ||
    typeof existing.Resources !== "object" ||
    Array.isArray(existing.Resources) ||
    !proposed?.Resources ||
    typeof proposed.Resources !== "object" ||
    Array.isArray(proposed.Resources)
  )
    throw new Error("GSI staging requires unambiguous stack resources");
  const additions = [];
  for (const [logicalId, resource] of Object.entries(existing.Resources)) {
    if (resource?.Type !== "AWS::DynamoDB::Table") continue;
    const next = proposed.Resources[logicalId];
    if (!next || next.Type !== "AWS::DynamoDB::Table")
      throw new Error(`GSI staging rejected table removal ${logicalId}`);
    const oldIndexes = uniqueNamedMap(
      resource.Properties?.GlobalSecondaryIndexes,
      "IndexName",
      validDynamoIndexName,
    );
    const newIndexes = uniqueNamedMap(
      next.Properties?.GlobalSecondaryIndexes,
      "IndexName",
      validDynamoIndexName,
    );
    const oldDefinitions = uniqueNamedMap(
      resource.Properties?.AttributeDefinitions,
      "AttributeName",
    );
    const newDefinitions = uniqueNamedMap(
      next.Properties?.AttributeDefinitions,
      "AttributeName",
    );
    if (!oldIndexes || !newIndexes || !oldDefinitions || !newDefinitions)
      throw new Error(`GSI staging found ambiguous indexes on ${logicalId}`);
    for (const definitions of [oldDefinitions, newDefinitions])
      for (const definition of definitions.values())
        if (!["S", "N", "B"].includes(definition.AttributeType))
          throw new Error(
            `GSI staging found ambiguous attributes on ${logicalId}`,
          );
    for (const [indexes, definitions] of [
      [oldIndexes, oldDefinitions],
      [newIndexes, newDefinitions],
    ])
      for (const [name, index] of indexes) {
        const keyAttributes = dynamoKeyAttributes(index.KeySchema);
        if (
          !keyAttributes ||
          [...keyAttributes].some((attribute) => !definitions.has(attribute))
        )
          throw new Error(
            `GSI staging found ambiguous index ${logicalId}.${name}`,
          );
      }
    for (const [name, definition] of oldDefinitions) {
      const nextDefinition = newDefinitions.get(name);
      if (
        !nextDefinition ||
        !same(definition.AttributeType, nextDefinition.AttributeType)
      )
        throw new Error(
          `GSI staging rejected attribute mutation on ${logicalId}`,
        );
    }
    for (const [name, index] of oldIndexes) {
      const nextIndex = newIndexes.get(name);
      if (!nextIndex)
        throw new Error(`GSI staging rejected index removal on ${logicalId}`);
      if (!same(index, nextIndex))
        throw new Error(`GSI staging rejected index mutation on ${logicalId}`);
    }
    const addedKeyAttributes = new Set();
    for (const [name, index] of newIndexes) {
      if (oldIndexes.has(name)) continue;
      const keyAttributes = dynamoKeyAttributes(index.KeySchema);
      if (!keyAttributes)
        throw new Error(
          `GSI staging found ambiguous index ${logicalId}.${name}`,
        );
      for (const attributeName of keyAttributes) {
        const definition = newDefinitions.get(attributeName);
        if (!definition || !["S", "N", "B"].includes(definition.AttributeType))
          throw new Error(
            `GSI staging found ambiguous index attribute ${logicalId}.${name}`,
          );
        addedKeyAttributes.add(attributeName);
      }
      additions.push({
        logicalId,
        indexName: name,
        index,
        keyAttributes: [...keyAttributes],
        targetDefinitions: newDefinitions,
      });
    }
    for (const name of newDefinitions.keys())
      if (!oldDefinitions.has(name) && !addedKeyAttributes.has(name))
        throw new Error(
          `GSI staging found ambiguous attributes on ${logicalId}`,
        );
  }
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  return additions.sort(
    (left, right) =>
      compare(left.logicalId, right.logicalId) ||
      compare(left.indexName, right.indexName),
  );
}

export function planDynamoGsiDeploymentStages(
  existing,
  proposed,
  { maxIntermediateStages = MAX_INTERMEDIATE_GSI_STAGES } = {},
) {
  if (
    !Number.isSafeInteger(maxIntermediateStages) ||
    maxIntermediateStages < 0 ||
    maxIntermediateStages > MAX_INTERMEDIATE_GSI_STAGES
  )
    throw new Error("GSI staging limit is invalid");
  assertRetainedResourcesSafe(existing, proposed);
  const additions = analyzeDynamoGsiChanges(existing, proposed);
  const intermediateCount = Math.max(0, additions.length - 1);
  if (intermediateCount > maxIntermediateStages)
    throw new Error("GSI staging requires too many intermediate updates");
  const rolling = structuredClone(existing);
  const stages = [];
  for (const addition of additions.slice(0, -1)) {
    const before = structuredClone(rolling);
    const properties = rolling.Resources[addition.logicalId].Properties ?? {};
    rolling.Resources[addition.logicalId].Properties = properties;
    properties.GlobalSecondaryIndexes = [
      ...(properties.GlobalSecondaryIndexes ?? []),
      structuredClone(addition.index),
    ];
    const definitions = uniqueNamedMap(
      properties.AttributeDefinitions,
      "AttributeName",
    );
    if (!definitions)
      throw new Error(
        `GSI staging found ambiguous attributes on ${addition.logicalId}`,
      );
    for (const attributeName of addition.keyAttributes) {
      if (definitions.has(attributeName)) continue;
      const definition = addition.targetDefinitions.get(attributeName);
      properties.AttributeDefinitions = [
        ...(properties.AttributeDefinitions ?? []),
        structuredClone(definition),
      ];
      definitions.set(attributeName, definition);
    }
    assertRetainedResourcesSafe(before, rolling);
    const stagedAdditions = analyzeDynamoGsiChanges(before, rolling);
    if (
      stagedAdditions.length !== 1 ||
      stagedAdditions[0].logicalId !== addition.logicalId ||
      stagedAdditions[0].indexName !== addition.indexName
    )
      throw new Error("GSI staging generated an unsafe intermediate update");
    stages.push({
      sequence: stages.length + 1,
      logicalId: addition.logicalId,
      indexName: addition.indexName,
      template: structuredClone(rolling),
    });
  }
  return stages;
}

export function assertDeployedTemplateMatches(expected, actual) {
  if (!same(expected, actual))
    throw new Error("Deployed GSI staging template did not match expectation");
}

export function retargetCloudAssemblyTemplateAsset(
  manifest,
  assetManifest,
  templateContents,
) {
  const nextManifest = structuredClone(manifest);
  const nextAssets = structuredClone(assetManifest);
  const stackArtifact = nextManifest?.artifacts?.[LAUNCH_STACK];
  const assetArtifact = nextManifest?.artifacts?.[`${LAUNCH_STACK}.assets`];
  const templateFile = `${LAUNCH_STACK}.template.json`;
  const assetManifestFile = `${LAUNCH_STACK}.assets.json`;
  if (
    stackArtifact?.type !== "aws:cloudformation:stack" ||
    stackArtifact.properties?.templateFile !== templateFile ||
    assetArtifact?.type !== "cdk:asset-manifest" ||
    assetArtifact.properties?.file !== assetManifestFile ||
    !stackArtifact.dependencies?.includes(`${LAUNCH_STACK}.assets`) ||
    !stackArtifact.properties?.additionalDependencies?.includes(
      `${LAUNCH_STACK}.assets`,
    )
  )
    throw new Error("Staged CDK assembly has ambiguous stack artifacts");
  let templateUrl;
  try {
    templateUrl = new URL(stackArtifact.properties.stackTemplateAssetObjectUrl);
  } catch {
    throw new Error("Staged CDK assembly has an invalid template asset URL");
  }
  if (
    templateUrl.protocol !== "s3:" ||
    !templateUrl.hostname ||
    templateUrl.search ||
    templateUrl.hash
  )
    throw new Error("Staged CDK assembly has an invalid template asset URL");
  const files = nextAssets?.files;
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new Error("Staged CDK assembly has ambiguous template assets");
  const candidates = Object.entries(files).filter(
    ([, asset]) =>
      asset?.displayName === `${LAUNCH_STACK} Template` &&
      asset.source?.path === templateFile &&
      asset.source?.packaging === "file",
  );
  if (candidates.length !== 1)
    throw new Error("Staged CDK assembly has ambiguous template assets");
  const [oldHash, oldAsset] = candidates[0];
  if (
    !/^[0-9a-f]{64}$/.test(oldHash) ||
    templateUrl.pathname !== `/${oldHash}.json`
  )
    throw new Error("Staged CDK assembly template hash is inconsistent");
  const destinations = oldAsset.destinations;
  if (
    !destinations ||
    typeof destinations !== "object" ||
    Array.isArray(destinations) ||
    Object.keys(destinations).length === 0
  )
    throw new Error("Staged CDK assembly has ambiguous template destinations");
  for (const destination of Object.values(destinations))
    if (
      destination?.bucketName !== templateUrl.hostname ||
      destination.region !== LAUNCH_REGION ||
      destination.objectKey !== `${oldHash}.json`
    )
      throw new Error(
        "Staged CDK assembly template destination is inconsistent",
      );
  const newHash = createHash("sha256").update(templateContents).digest("hex");
  if (oldHash !== newHash && files[newHash])
    throw new Error("Staged CDK assembly template hash is ambiguous");
  const newAsset = structuredClone(oldAsset);
  for (const destination of Object.values(newAsset.destinations))
    destination.objectKey = `${newHash}.json`;
  delete files[oldHash];
  files[newHash] = newAsset;
  templateUrl.pathname = `/${newHash}.json`;
  stackArtifact.properties.stackTemplateAssetObjectUrl = templateUrl.href;
  return {
    manifest: nextManifest,
    assetManifest: nextAssets,
    assetManifestFile,
    templateFile,
    templateHash: newHash,
  };
}

export async function deployStagedDynamoGsiUpdates({
  deployedTemplate,
  targetTemplate,
  deployStage,
  waitForStackStability,
  waitForIndexActive,
  readDeployedTemplate,
  verifyDeployedDrift,
  maxIntermediateStages = MAX_INTERMEDIATE_GSI_STAGES,
}) {
  let current = structuredClone(deployedTemplate);
  const initialStages = planDynamoGsiDeploymentStages(current, targetTemplate, {
    maxIntermediateStages,
  });
  const completed = [];
  while (completed.length < initialStages.length) {
    const remaining = planDynamoGsiDeploymentStages(current, targetTemplate, {
      maxIntermediateStages: initialStages.length - completed.length,
    });
    const stage = remaining[0];
    if (!stage)
      throw new Error("GSI staging stopped before the target was deployable");
    await deployStage(stage);
    await waitForStackStability();
    await waitForIndexActive(stage);
    const actual = await readDeployedTemplate();
    assertDeployedTemplateMatches(stage.template, actual);
    assertRetainedResourcesSafe(actual, targetTemplate);
    analyzeDynamoGsiChanges(actual, targetTemplate);
    await verifyDeployedDrift();
    current = actual;
    completed.push({
      logicalId: stage.logicalId,
      indexName: stage.indexName,
    });
  }
  const finalStages = planDynamoGsiDeploymentStages(current, targetTemplate, {
    maxIntermediateStages: 0,
  });
  if (finalStages.length !== 0)
    throw new Error("GSI staging did not leave a safe final update");
  return { deployedTemplate: current, completed };
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

function deployedStackTemplate(stackId, environment) {
  verifyIdentity(environment);
  if (
    !stackId?.startsWith(
      `arn:aws:cloudformation:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:stack/${LAUNCH_STACK}/`,
    )
  )
    throw new Error("Template read escaped the intended launch stack");
  const body = JSON.parse(
    run(
      "aws",
      [
        "cloudformation",
        "get-template",
        "--stack-name",
        stackId,
        "--region",
        LAUNCH_REGION,
        "--template-stage",
        "Original",
        "--output",
        "json",
      ],
      { capture: true, env: environment },
    ),
  ).TemplateBody;
  const template = typeof body === "string" ? JSON.parse(body) : body;
  if (!template || typeof template !== "object" || Array.isArray(template))
    throw new Error("CloudFormation returned an ambiguous deployed template");
  return template;
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

export function resolveDynamoGsiBinding(
  response,
  { stackId, logicalId, indexName },
) {
  const detail = response?.StackResourceDetail;
  const tableName = detail?.PhysicalResourceId;
  if (
    detail?.StackId !== stackId ||
    detail?.LogicalResourceId !== logicalId ||
    detail?.ResourceType !== "AWS::DynamoDB::Table" ||
    !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(detail?.ResourceStatus) ||
    typeof tableName !== "string" ||
    !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) ||
    !validDynamoIndexName(indexName)
  )
    throw new Error(
      "CloudFormation did not resolve the intended DynamoDB table",
    );
  return {
    tableName,
    tableArn: `arn:aws:dynamodb:${LAUNCH_REGION}:${LAUNCH_ACCOUNT}:table/${tableName}`,
    indexName,
  };
}

export async function waitForDynamoGsiActive(
  readTable,
  binding,
  {
    attempts = DYNAMO_GSI_ACTIVE_ATTEMPTS,
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("DynamoDB GSI readiness limit is invalid");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await readTable();
    } catch {
      throw new Error("DynamoDB GSI readiness could not be verified");
    }
    const table = response?.Table;
    const indexes = table?.GlobalSecondaryIndexes;
    if (
      table?.TableName !== binding.tableName ||
      table?.TableArn !== binding.tableArn ||
      !Array.isArray(indexes)
    )
      throw new Error("DynamoDB GSI readiness escaped the intended table");
    const named = uniqueNamedMap(indexes, "IndexName", validDynamoIndexName);
    const index = named?.get(binding.indexName);
    if (
      !named ||
      !index ||
      index.IndexArn !== `${binding.tableArn}/index/${binding.indexName}`
    )
      throw new Error(
        "DynamoDB GSI readiness did not resolve the intended index",
      );
    if (table.TableStatus === "ACTIVE" && index.IndexStatus === "ACTIVE")
      return response;
    if (
      !["ACTIVE", "UPDATING"].includes(table.TableStatus) ||
      !["ACTIVE", "CREATING", "UPDATING"].includes(index.IndexStatus)
    )
      throw new Error("DynamoDB GSI entered an unsafe readiness state");
    if (attempt + 1 < attempts) await delay(10_000);
  }
  throw new Error("DynamoDB GSI did not become active in time");
}

async function waitForDeployedGsiActive(
  environment,
  stackId,
  { logicalId, indexName },
) {
  verifyIdentity(environment);
  const binding = resolveDynamoGsiBinding(
    JSON.parse(
      run(
        "aws",
        [
          "cloudformation",
          "describe-stack-resource",
          "--stack-name",
          stackId,
          "--logical-resource-id",
          logicalId,
          "--region",
          LAUNCH_REGION,
          "--output",
          "json",
        ],
        { capture: true, env: environment },
      ),
    ),
    { stackId, logicalId, indexName },
  );
  await waitForDynamoGsiActive(() => {
    verifyIdentity(environment);
    return JSON.parse(
      run(
        "aws",
        [
          "dynamodb",
          "describe-table",
          "--table-name",
          binding.tableName,
          "--region",
          LAUNCH_REGION,
          "--output",
          "json",
        ],
        { capture: true, env: environment },
      ),
    );
  }, binding);
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

export function assertDeployedOutputBindings(
  outputs,
  resources,
  distribution,
  target = activeLaunchTarget,
) {
  const expected = [
    ["AWS::S3::Bucket", outputs.WebAssetsBucketName],
    ["AWS::CloudFront::Distribution", outputs.WebDistributionId],
    ["AWS::Cognito::UserPool", outputs.CognitoUserPoolId],
    ["AWS::Cognito::UserPoolClient", outputs.CognitoClientId],
    ["AWS::Cognito::UserPoolClient", outputs.ReviewerCognitoClientId],
    ["AWS::Lambda::Function", outputs.LiveOddsIngestionFunctionName],
  ];
  const apiId =
    outputs.EventsApiId ??
    new URL(outputs.EventsApiEndpoint).hostname.split(".")[0];
  expected.push(["AWS::ApiGatewayV2::Api", apiId]);
  const distributionOwnsWebOrigin = target.webOrigin
    ? distribution?.DistributionConfig?.Aliases?.Items?.includes(
        new URL(target.webOrigin).hostname,
      )
    : `https://${distribution?.DomainName}` === outputs.WebOrigin;
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
    !distributionOwnsWebOrigin ||
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

export function validateStackOutputs(outputs, target = activeLaunchTarget) {
  const web = new URL(outputs.WebOrigin);
  const api = new URL(outputs.EventsApiEndpoint);
  const issuer = new URL(outputs.CognitoIssuer);
  const domain = new URL(outputs.CognitoDomain);
  if (
    web.protocol !== "https:" ||
    web.origin !== outputs.WebOrigin ||
    (target.webOrigin
      ? outputs.WebOrigin !== target.webOrigin
      : !/^[a-z0-9]+\.cloudfront\.net$/.test(web.hostname)) ||
    web.pathname !== "/"
  )
    throw new Error("WebOrigin is not the exact intended CloudFront origin");
  if (
    api.protocol !== "https:" ||
    (target.apiBase
      ? outputs.EventsApiEndpoint !== target.apiBase
      : !/^[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(
          api.hostname,
        ) || api.pathname !== "/dev") ||
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
    outputs.ScoutingReadScope !== "events/scouting:read" ||
    outputs.ScoutingWriteScope !== "events/scouting:write" ||
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
    outputs.SharpApiSecretName !== `${target.secretPrefix}/sharpapi` ||
    (target.stage !== "dev" &&
      (outputs.DeploymentStage !== target.stage ||
        !/^[0-9a-f]{40}$/.test(outputs.ReleaseSha ?? "")))
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

/**
 * Whether a failed launch should restore the previous web release.
 *
 * Deliberately opt-in. The rollback is correct for an environment with real
 * users and self-defeating for one whose smoke is failing on a client bug,
 * because it deletes the bundle that fixes it.
 */
export function rollbackOnFailureEnabled(environment = process.env) {
  return environment.FTE_ROLLBACK_WEB_ON_FAILURE === "1";
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
  const target = selectLaunchTarget(environment);
  verifyIdentity(environment);
  const deployEnvironment = {
    ...environment,
    CDK_DEFAULT_ACCOUNT: LAUNCH_ACCOUNT,
    CDK_DEFAULT_REGION: LAUNCH_REGION,
    FTE_AWS_STAGE: target.stage,
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
  const synthesizedAssembly = resolve("infra/cdk/cdk.out");
  const deployedStack = existingStack(deployEnvironment);
  let finalGsiWaitTarget;
  if (deployedStack) {
    const deployedTemplate = deployedStackTemplate(
      deployedStack.StackId,
      deployEnvironment,
    );
    let deployedForFinal = deployedTemplate;
    assertRetainedResourcesSafe(deployedTemplate, proposedTemplate);
    await verifyStackDrift(deployEnvironment);
    const plannedStages = planDynamoGsiDeploymentStages(
      deployedTemplate,
      proposedTemplate,
    );
    if (plannedStages.length > 0) {
      const temporary = await mkdtemp(
        resolve(tmpdir(), "fte-phase1-gsi-stages-"),
      );
      const stagedAssembly = resolve(temporary, "cdk.out");
      try {
        await cp(synthesizedAssembly, stagedAssembly, { recursive: true });
        let stagedManifest = JSON.parse(
          await readFile(resolve(stagedAssembly, "manifest.json"), "utf8"),
        );
        let stagedAssetManifest = JSON.parse(
          await readFile(
            resolve(stagedAssembly, `${LAUNCH_STACK}.assets.json`),
            "utf8",
          ),
        );
        const result = await deployStagedDynamoGsiUpdates({
          deployedTemplate,
          targetTemplate: proposedTemplate,
          deployStage: async (stage) => {
            const templateContents = JSON.stringify(stage.template);
            const retargeted = retargetCloudAssemblyTemplateAsset(
              stagedManifest,
              stagedAssetManifest,
              templateContents,
            );
            await writeFile(
              resolve(stagedAssembly, retargeted.templateFile),
              templateContents,
              { mode: 0o600 },
            );
            await writeFile(
              resolve(stagedAssembly, retargeted.assetManifestFile),
              JSON.stringify(retargeted.assetManifest),
              { mode: 0o600 },
            );
            await writeFile(
              resolve(stagedAssembly, "manifest.json"),
              JSON.stringify(retargeted.manifest),
              { mode: 0o600 },
            );
            const verified = retargetCloudAssemblyTemplateAsset(
              JSON.parse(
                await readFile(
                  resolve(stagedAssembly, "manifest.json"),
                  "utf8",
                ),
              ),
              JSON.parse(
                await readFile(
                  resolve(stagedAssembly, retargeted.assetManifestFile),
                  "utf8",
                ),
              ),
              await readFile(resolve(stagedAssembly, retargeted.templateFile)),
            );
            if (
              verified.templateHash !== retargeted.templateHash ||
              !same(verified.manifest, retargeted.manifest) ||
              !same(verified.assetManifest, retargeted.assetManifest)
            )
              throw new Error("Staged CDK assembly verification failed");
            stagedManifest = retargeted.manifest;
            stagedAssetManifest = retargeted.assetManifest;
            guardedRun(
              "pnpm",
              [
                "--filter",
                "@find-the-edge/infra-cdk",
                "exec",
                "cdk",
                "deploy",
                "--app",
                stagedAssembly,
                LAUNCH_STACK,
                "--require-approval",
                "never",
              ],
              deployEnvironment,
              { timeout: 1_800_000 },
            );
          },
          waitForStackStability: async () => {
            guardedRun(
              "aws",
              [
                "cloudformation",
                "wait",
                "stack-update-complete",
                "--stack-name",
                deployedStack.StackId,
                "--region",
                LAUNCH_REGION,
              ],
              deployEnvironment,
              { capture: true, timeout: 1_800_000 },
            );
          },
          waitForIndexActive: async (stage) =>
            waitForDeployedGsiActive(
              deployEnvironment,
              deployedStack.StackId,
              stage,
            ),
          readDeployedTemplate: async () =>
            deployedStackTemplate(deployedStack.StackId, deployEnvironment),
          verifyDeployedDrift: async () => verifyStackDrift(deployEnvironment),
        });
        deployedForFinal = result.deployedTemplate;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    const finalAdditions = analyzeDynamoGsiChanges(
      deployedForFinal,
      proposedTemplate,
    );
    if (finalAdditions.length > 1)
      throw new Error("GSI staging did not leave a safe final update");
    finalGsiWaitTarget = finalAdditions[0];
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
      synthesizedAssembly,
      LAUNCH_STACK,
      "--require-approval",
      "never",
    ],
    deployEnvironment,
    { timeout: 1_800_000 },
  );
  if (deployedStack && finalGsiWaitTarget) {
    guardedRun(
      "aws",
      [
        "cloudformation",
        "wait",
        "stack-update-complete",
        "--stack-name",
        deployedStack.StackId,
        "--region",
        LAUNCH_REGION,
      ],
      deployEnvironment,
      { capture: true, timeout: 1_800_000 },
    );
    await waitForDeployedGsiActive(
      deployEnvironment,
      deployedStack.StackId,
      finalGsiWaitTarget,
    );
  }
  const outputs = stackOutputs(deployEnvironment);
  const required = [
    "EventsApiEndpoint",
    "EventsApiId",
    "WebOrigin",
    "WebDistributionId",
    "WebAssetsBucketName",
    "CognitoIssuer",
    "CognitoUserPoolId",
    "CognitoClientId",
    "ReviewerCognitoClientId",
    "CognitoDomain",
    "CognitoScope",
    "ScoutingReadScope",
    "ScoutingWriteScope",
    "CognitoCallbackUrl",
    "LiveOddsIngestionFunctionName",
    "SharpApiSecretName",
    ...(target.stage === "dev"
      ? []
      : [
          "DeploymentStage",
          "ReleaseSha",
          "ApiDnsTarget",
          "ApiDnsHostedZoneId",
          "WebDnsTarget",
        ]),
  ];
  if (required.some((key) => !outputs[key]))
    throw new Error(
      "Deployed stack did not return all required launch outputs",
    );
  validateStackOutputs(outputs, target);
  verifyDeployedOutputBindings(outputs, deployEnvironment);
  const bundleEnvironment = {
    ...deployEnvironment,
    FTE_PHASE1_API_BASE: outputs.EventsApiEndpoint,
    FTE_PHASE1_PROVIDER_KEY: "cognitoSession",
    FTE_JWT_ISSUER: outputs.CognitoIssuer,
    FTE_JWT_AUDIENCE: outputs.CognitoClientId,
    FTE_COGNITO_DOMAIN: outputs.CognitoDomain,
    FTE_COGNITO_SCOPES: [
      outputs.CognitoScope,
      outputs.ScoutingReadScope,
      outputs.ScoutingWriteScope,
    ].join(" "),
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
      FTE_DEPLOYED_STAGE: outputs.DeploymentStage ?? "dev",
      FTE_DEPLOYED_RELEASE_SHA: outputs.ReleaseSha ?? "legacy-dev",
      FTE_WEB_ASSETS_BUCKET_NAME: outputs.WebAssetsBucketName,
    });
    return { webOrigin: outputs.WebOrigin, outputs };
  } catch (primaryFailure) {
    // Rolling the web bundle back on a failed smoke deadlocks any fix the
    // smoke itself is failing on: the bundle carrying the fix is uploaded,
    // the smoke fails because the fix is not yet live everywhere it checks,
    // and the rollback then deletes the fix. Observed 2026-08-13 — the
    // correct bundle went up at 19:45:15 and was replaced by the previous
    // release at 19:46:18, three deploys running, so no client-side fix could
    // ever reach staging.
    //
    // Off by default while no one is using production. Turn it on before real
    // traffic by setting FTE_ROLLBACK_WEB_ON_FAILURE=1 — a failed smoke will
    // then restore the previous release, and a fix the smoke gates on will
    // need a deliberate override.
    if (rollbackOnFailureEnabled(deployEnvironment)) {
      try {
        restoreRelease(snapshot, outputs, deployEnvironment);
      } catch (rollbackFailure) {
        throw combineLaunchAndRollbackFailures(primaryFailure, rollbackFailure);
      }
    } else {
      process.stdout.write(
        "Web release rollback is DISABLED " +
          "(FTE_ROLLBACK_WEB_ON_FAILURE is not 1). The uploaded bundle stays " +
          "live despite the failure above.\n",
      );
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
