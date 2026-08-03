import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const projectRoot = resolve(new URL("..", import.meta.url).pathname);

export function safeDevConfig(environment = process.env) {
  return {
    stage: environment.FTE_AWS_STAGE ?? "dev",
    issuer:
      environment.FTE_JWT_ISSUER ??
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_phase1",
    audience: environment.FTE_JWT_AUDIENCE ?? "phase1-client",
    cursorSecretArn:
      environment.FTE_EVENT_CURSOR_SECRET_ARN ??
      "arn:aws:secretsmanager:us-east-1:000000000000:secret:phase1-cursor",
    webOrigin: environment.FTE_WEB_ORIGIN ?? "https://app.phase1.invalid",
    apiBase: environment.FTE_PHASE1_API_BASE ?? "https://api.phase1.invalid",
    providerKey: environment.FTE_PHASE1_PROVIDER_KEY ?? "cognitoSession",
    cognitoDomain:
      environment.FTE_COGNITO_DOMAIN ??
      "https://phase1.auth.us-east-1.amazoncognito.com",
    cognitoScope: environment.FTE_COGNITO_SCOPE ?? "events/events:read",
    callbackUrl:
      environment.FTE_COGNITO_CALLBACK_URL ??
      "https://app.phase1.invalid/auth/callback",
    logoutUrl:
      environment.FTE_COGNITO_LOGOUT_URL ?? "https://app.phase1.invalid",
    fixtureSeedEnabled: environment.FTE_FIXTURE_ODDS_SEED_ENABLED === "true",
    schedulerEnabled:
      environment.FTE_UPCOMING_SCHEDULER_ENABLED === undefined ||
      environment.FTE_UPCOMING_SCHEDULER_ENABLED === "true",
    localMode: environment.FTE_PHASE1_LOCAL_MODE === "1",
  };
}

export function validateSafeDevConfig(config) {
  if (config.stage !== "dev")
    throw new Error("Phase1 requires FTE_AWS_STAGE=dev");
  if (config.fixtureSeedEnabled)
    throw new Error("Phase1 requires fixture odds seeding to be disabled");
  if (!config.schedulerEnabled)
    throw new Error("Phase1 requires live ingestion scheduling to be enabled");
  for (const [label, value] of [
    ["JWT issuer", config.issuer],
    ["JWT audience", config.audience],
  ]) {
    if (!value || /[\u0000-\u0020\u007f]/.test(value))
      throw new Error(`${label} is required and must not contain whitespace`);
  }
  const issuer = new URL(config.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password)
    throw new Error("JWT issuer must be an HTTPS URL without credentials");
  if (
    !/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(
      config.cursorSecretArn,
    )
  )
    throw new Error("Cursor secret must be a Secrets Manager ARN");
  const origin = new URL(config.webOrigin);
  if (origin.origin !== config.webOrigin || origin.protocol !== "https:")
    throw new Error("Web origin must be an exact HTTPS origin");
  const api = new URL(config.apiBase);
  const allowedLocalHttp =
    config.localMode &&
    api.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(api.hostname);
  if (
    (api.protocol !== "https:" && !allowedLocalHttp) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw new Error(
      "API base must be HTTPS (or explicit local HTTP) without credentials, query, or fragment",
    );
  if (config.providerKey === "cognitoSession") {
    if (config.cognitoScope !== "events/events:read")
      throw new Error("Cognito scope must be events/events:read");
    for (const [label, value] of [
      ["Cognito domain", config.cognitoDomain],
      ["Cognito callback", config.callbackUrl],
      ["Cognito logout", config.logoutUrl],
    ]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error(`${label} must be safe HTTPS`);
    }
  }
}

export function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
    timeout: options.timeout ?? 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed with exit code ${String(result.status)}`,
    );
  return result.stdout ?? "";
}

function entriesOfType(template, type) {
  return Object.entries(template.Resources ?? {}).filter(
    ([, resource]) => resource?.Type === type,
  );
}

function isRef(value, logicalId) {
  return value?.Ref === logicalId && Object.keys(value).length === 1;
}

function isGetAtt(value, logicalId, attribute) {
  return (
    Array.isArray(value?.["Fn::GetAtt"]) &&
    value["Fn::GetAtt"].length === 2 &&
    value["Fn::GetAtt"][0] === logicalId &&
    value["Fn::GetAtt"][1] === attribute
  );
}

function exactIntegrationTarget(value, integrationId) {
  return (
    Array.isArray(value?.["Fn::Join"]) &&
    value["Fn::Join"].length === 2 &&
    value["Fn::Join"][0] === "" &&
    Array.isArray(value["Fn::Join"][1]) &&
    value["Fn::Join"][1].length === 2 &&
    value["Fn::Join"][1][0] === "integrations/" &&
    isRef(value["Fn::Join"][1][1], integrationId)
  );
}

function referencedRoleId(lambda) {
  const role = lambda?.Properties?.Role;
  return Array.isArray(role?.["Fn::GetAtt"]) &&
    role["Fn::GetAtt"].length === 2 &&
    role["Fn::GetAtt"][1] === "Arn"
    ? role["Fn::GetAtt"][0]
    : undefined;
}

function dynamoActionsForRole(template, roleId, tableId) {
  const actions = new Set();
  for (const [, policy] of entriesOfType(template, "AWS::IAM::Policy")) {
    const roles = policy.Properties?.Roles ?? [];
    if (!roles.some((role) => isRef(role, roleId))) continue;
    for (const statement of policy.Properties?.PolicyDocument?.Statement ??
      []) {
      if (statement.Effect !== "Allow") continue;
      const statementActions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      if (!statementActions.some((action) => action?.startsWith?.("dynamodb:")))
        continue;
      const resources = Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource];
      if (
        resources.length !== 1 ||
        !resources.every((value) => isGetAtt(value, tableId, "Arn"))
      )
        throw new Error(
          "DynamoDB IAM must reference only the exact event table ARN",
        );
      for (const action of statementActions) actions.add(action);
    }
  }
  return actions;
}

function requireActions(actual, expected, label) {
  const missing = expected.filter((action) => !actual.has(action));
  const extra = [...actual].filter((action) => !expected.includes(action));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      `${label} must contain exactly the required actions (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
}

export function validateTemplate(template, config) {
  const exactSpaCode =
    "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/games') {\n    request.uri = '/index.html';\n  }\n  return request;\n}";
  const tables = entriesOfType(template, "AWS::DynamoDB::Table");
  const apis = entriesOfType(template, "AWS::ApiGatewayV2::Api");
  if (tables.length !== 1 || apis.length !== 1)
    throw new Error("Phase1 requires exactly one event table and HTTP API");
  const [tableId] = tables[0];
  const [apiId, api] = apis[0];
  const pools = entriesOfType(template, "AWS::Cognito::UserPool");
  const clients = entriesOfType(template, "AWS::Cognito::UserPoolClient");
  const servers = entriesOfType(
    template,
    "AWS::Cognito::UserPoolResourceServer",
  );
  const buckets = entriesOfType(template, "AWS::S3::Bucket");
  const bucketPolicies = entriesOfType(template, "AWS::S3::BucketPolicy");
  const domains = entriesOfType(template, "AWS::Cognito::UserPoolDomain");
  const distributions = entriesOfType(
    template,
    "AWS::CloudFront::Distribution",
  );
  const oacs = entriesOfType(template, "AWS::CloudFront::OriginAccessControl");
  const cloudFrontFunctions = entriesOfType(
    template,
    "AWS::CloudFront::Function",
  );
  const responsePolicies = entriesOfType(
    template,
    "AWS::CloudFront::ResponseHeadersPolicy",
  );
  if (
    [
      pools,
      clients,
      servers,
      domains,
      buckets,
      bucketPolicies,
      distributions,
      oacs,
      cloudFrontFunctions,
    ].some((items) => items.length !== 1)
  )
    throw new Error(
      "Phase1 requires exactly one Cognito pool/client/resource server and private web distribution",
    );
  const [poolId, pool] = pools[0];
  const [clientId, client] = clients[0];
  const [serverId, server] = servers[0];
  const [domainId, cognitoDomain] = domains[0];
  const [bucketId, bucket] = buckets[0];
  const [, bucketPolicy] = bucketPolicies[0];
  const [distributionId, distribution] = distributions[0];
  const [spaFunctionId, spaFunction] = cloudFrontFunctions[0];
  const [, oac] = oacs[0];
  const expectedCsp = {
    "Fn::Join": [
      "",
      [
        "default-src 'self'; base-uri 'none'; connect-src 'self' ",
        { "Fn::GetAtt": [apiId, "ApiEndpoint"] },
        "; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
      ],
    ],
  };
  if (
    responsePolicies.length !== 2 ||
    responsePolicies.some(
      ([, policy]) =>
        JSON.stringify(
          policy.Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig
            ?.ContentSecurityPolicy?.ContentSecurityPolicy,
        ) !== JSON.stringify(expectedCsp),
    )
  )
    throw new Error(
      "Every CloudFront behavior must use the exact restrictive launch CSP",
    );
  const webOrigin = {
    "Fn::Join": [
      "",
      ["https://", { "Fn::GetAtt": [distributionId, "DomainName"] }],
    ],
  };
  if (
    pool.Properties?.AdminCreateUserConfig?.AllowAdminCreateUserOnly !== true ||
    pool.Properties?.Policies?.PasswordPolicy?.MinimumLength < 14
  )
    throw new Error(
      "Cognito must disable public signup and enforce the strong password policy",
    );
  if (
    server.Properties?.Identifier !== "events" ||
    JSON.stringify(server.Properties?.Scopes) !==
      JSON.stringify([
        {
          ScopeDescription: "Read FIND THE EDGE events and odds",
          ScopeName: "events:read",
        },
      ])
  )
    throw new Error(
      "Cognito must define only the events:read resource-server scope",
    );
  if (!isRef(cognitoDomain.Properties?.UserPoolId, poolId))
    throw new Error("Cognito domain must bind to the selected user pool");
  const oauth = client.Properties;
  if (
    oauth?.GenerateSecret !== false ||
    JSON.stringify(oauth?.AllowedOAuthFlows) !== JSON.stringify(["code"]) ||
    !isRef(oauth?.UserPoolId, poolId) ||
    JSON.stringify(oauth?.CallbackURLs) !==
      JSON.stringify([
        {
          "Fn::Join": [
            "",
            [
              "https://",
              { "Fn::GetAtt": [distributionId, "DomainName"] },
              "/auth/callback",
            ],
          ],
        },
      ]) ||
    JSON.stringify(oauth?.LogoutURLs) !== JSON.stringify([webOrigin])
  )
    throw new Error(
      "Cognito web client must be a public authorization-code client with exact hosted URLs",
    );
  const publicBlock = bucket.Properties?.PublicAccessBlockConfiguration;
  if (
    ![
      "BlockPublicAcls",
      "BlockPublicPolicy",
      "IgnorePublicAcls",
      "RestrictPublicBuckets",
    ].every((key) => publicBlock?.[key] === true) ||
    bucket.Properties?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]
      ?.ServerSideEncryptionByDefault?.SSEAlgorithm !== "AES256" ||
    bucket.Properties?.VersioningConfiguration?.Status !== "Enabled"
  )
    throw new Error("Web bucket must be private, encrypted, and versioned");
  const cloudFrontRead =
    bucketPolicy.Properties?.PolicyDocument?.Statement?.find(
      (statement) =>
        statement.Effect === "Allow" &&
        statement.Action === "s3:GetObject" &&
        statement.Principal?.Service === "cloudfront.amazonaws.com",
    );
  if (
    !isRef(bucketPolicy.Properties?.Bucket, bucketId) ||
    !cloudFrontRead ||
    !JSON.stringify(cloudFrontRead.Resource).includes(
      JSON.stringify({ "Fn::GetAtt": [bucketId, "Arn"] }),
    ) ||
    !JSON.stringify(cloudFrontRead.Condition).includes(
      JSON.stringify({ Ref: distributionId }),
    )
  )
    throw new Error(
      "Private web bucket policy must bind CloudFront OAC to the intended distribution",
    );
  const distributionConfig = distribution.Properties?.DistributionConfig;
  const distributionOrigins = distributionConfig?.Origins ?? [];
  if (
    distributionConfig?.CustomErrorResponses !== undefined ||
    distributionConfig?.DefaultRootObject !== "index.html" ||
    distributionConfig?.DefaultCacheBehavior?.ViewerProtocolPolicy !==
      "redirect-to-https" ||
    distributionConfig?.DefaultCacheBehavior?.Compress !== true ||
    !distributionOrigins.some((origin) => origin.OriginAccessControlId) ||
    oac.Properties?.OriginAccessControlConfig?.SigningBehavior !== "always" ||
    spaFunction.Properties?.AutoPublish !== true ||
    spaFunction.Properties?.FunctionCode !== exactSpaCode ||
    JSON.stringify(
      distributionConfig?.DefaultCacheBehavior?.FunctionAssociations,
    ) !==
      JSON.stringify([
        {
          EventType: "viewer-request",
          FunctionARN: { "Fn::GetAtt": [spaFunctionId, "FunctionARN"] },
        },
      ])
  )
    throw new Error(
      "CloudFront must use exact SPA navigation, TLS redirect, compression, and signed OAC access",
    );
  if (api.Properties?.CorsConfiguration !== undefined)
    throw new Error("HTTP API CORS must be applied without a dependency cycle");
  const corsResources = entriesOfType(template, "Custom::AWS").filter(
    ([, value]) => {
      const rendered = JSON.stringify(value.Properties?.Create);
      return (
        rendered.includes("ApiGatewayV2") && rendered.includes("updateApi")
      );
    },
  );
  if (corsResources.length !== 1)
    throw new Error("HTTP API CORS requires exactly one guarded configurator");
  const [corsId, corsResource] = corsResources[0];
  const createCors = corsResource.Properties?.Create;
  const updateCors = corsResource.Properties?.Update;
  const createRendered = JSON.stringify(createCors);
  if (
    JSON.stringify(updateCors) !== createRendered ||
    corsResource.Properties?.Delete !== undefined ||
    !createRendered.includes(JSON.stringify({ Ref: apiId })) ||
    !createRendered.includes(
      JSON.stringify({ "Fn::GetAtt": [distributionId, "DomainName"] }),
    ) ||
    !createRendered.includes('\\"AllowOrigins\\":[\\"https://') ||
    !createRendered.includes('\\"AllowMethods\\":[\\"GET\\",\\"OPTIONS\\"]') ||
    !createRendered.includes(
      '\\"AllowHeaders\\":[\\"authorization\\",\\"content-type\\"]',
    ) ||
    createRendered.includes("*")
  )
    throw new Error(
      "HTTP API CORS must contain only the exact origin, methods, and headers",
    );
  const corsPolicies = entriesOfType(template, "AWS::IAM::Policy").filter(
    ([, value]) =>
      JSON.stringify(value.Properties?.PolicyDocument).includes(
        '"apigateway:PATCH"',
      ),
  );
  if (
    corsPolicies.length !== 1 ||
    corsPolicies[0][1].Properties?.PolicyDocument?.Statement?.length !== 1 ||
    corsPolicies[0][1].Properties.PolicyDocument.Statement[0]?.Effect !==
      "Allow" ||
    corsPolicies[0][1].Properties.PolicyDocument.Statement[0]?.Action !==
      "apigateway:PATCH" ||
    !JSON.stringify(
      corsPolicies[0][1].Properties.PolicyDocument.Statement[0]?.Resource,
    ).includes(JSON.stringify({ Ref: apiId })) ||
    JSON.stringify(
      corsPolicies[0][1].Properties.PolicyDocument.Statement[0]?.Resource,
    ).includes("*") ||
    !JSON.stringify(corsResource.Properties?.ServiceToken).includes(
      "Fn::GetAtt",
    )
  )
    throw new Error("HTTP API CORS configurator IAM must be API-scoped");
  const authorizers = entriesOfType(template, "AWS::ApiGatewayV2::Authorizer");
  if (
    authorizers.length !== 1 ||
    !isRef(authorizers[0][1].Properties?.ApiId, apiId) ||
    authorizers[0][1].Properties?.AuthorizerType !== "JWT" ||
    !isGetAtt(
      authorizers[0][1].Properties?.JwtConfiguration?.Issuer,
      poolId,
      "ProviderURL",
    ) ||
    JSON.stringify(authorizers[0][1].Properties?.JwtConfiguration?.Audience) !==
      JSON.stringify([{ Ref: clientId }])
  )
    throw new Error(
      "Internal event listing must keep its exact JWT authorizer",
    );
  const [authorizerId] = authorizers[0];
  const integrations = entriesOfType(
    template,
    "AWS::ApiGatewayV2::Integration",
  ).filter(([, value]) => isRef(value.Properties?.ApiId, apiId));
  const apiRoutes = entriesOfType(template, "AWS::ApiGatewayV2::Route").filter(
    ([, value]) => isRef(value.Properties?.ApiId, apiId),
  );
  const apiStages = entriesOfType(template, "AWS::ApiGatewayV2::Stage").filter(
    ([, value]) => isRef(value.Properties?.ApiId, apiId),
  );
  const requiredRouteKeys = [
    "GET /events",
    "GET /events/{eventId}",
    "GET /games",
  ];
  if (
    apiRoutes.length !== requiredRouteKeys.length ||
    JSON.stringify(
      apiRoutes.map(([, value]) => value.Properties?.RouteKey).sort(),
    ) !== JSON.stringify([...requiredRouteKeys].sort()) ||
    apiRoutes.some(([, value]) => {
      if (value.Properties?.RouteKey === "$default") return true;
      if (value.Properties?.RouteKey === "GET /events")
        return (
          value.Properties?.AuthorizationType !== "JWT" ||
          !isRef(value.Properties?.AuthorizerId, authorizerId) ||
          JSON.stringify(value.Properties?.AuthorizationScopes) !==
            JSON.stringify(["events/events:read"])
        );
      return (
        value.Properties?.AuthorizationType !== "NONE" ||
        value.Properties?.AuthorizerId !== undefined ||
        value.Properties?.AuthorizationScopes !== undefined
      );
    })
  )
    throw new Error(
      "Games and event detail must be public while event listing remains scoped",
    );
  if (
    apiStages.length !== 1 ||
    apiStages[0][1].Properties?.DefaultRouteSettings?.ThrottlingBurstLimit !==
      100 ||
    apiStages[0][1].Properties?.DefaultRouteSettings?.ThrottlingRateLimit !== 50
  )
    throw new Error("Public read API must enforce bounded stage throttling");
  if (integrations.length !== 1)
    throw new Error(
      "Intended API routes must share exactly one API integration",
    );
  const [integrationId, integration] = integrations[0];
  const integrationUri = integration.Properties?.IntegrationUri;
  const apiLambdaId = integrationUri?.["Fn::GetAtt"]?.[0];
  if (
    !apiLambdaId ||
    !isGetAtt(integrationUri, apiLambdaId, "Arn") ||
    apiRoutes.some(
      ([, value]) =>
        !exactIntegrationTarget(value.Properties?.Target, integrationId),
    )
  )
    throw new Error(
      "Every intended API route must target the exact shared Lambda integration",
    );
  const seedFunctions = entriesOfType(template, "AWS::Lambda::Function").filter(
    ([, value]) =>
      value.Properties?.Environment?.Variables
        ?.FTE_FIXTURE_ODDS_SEED_ENABLED === "true",
  );
  if (seedFunctions.length !== 0)
    throw new Error("Fixture seed function must be absent from live Phase1");
  const liveFunctions = entriesOfType(template, "AWS::Lambda::Function").filter(
    ([, value]) =>
      value.Properties?.Environment?.Variables?.FTE_THE_ODDS_API_SECRET_ID,
  );
  if (liveFunctions.length !== 1)
    throw new Error("Exactly one live odds ingestion function is required");
  const [liveId, liveFunction] = liveFunctions[0];
  const liveOutput = template.Outputs?.LiveOddsIngestionFunctionName?.Value;
  const apiOutput = template.Outputs?.EventsApiEndpoint?.Value;
  if (!isRef(liveOutput, liveId))
    throw new Error(
      "Live odds output must reference the real ingestion function",
    );
  if (
    liveFunction.Properties?.Environment?.Variables
      ?.FTE_THE_ODDS_API_SECRET_ID === undefined ||
    JSON.stringify(template).includes("apiKey")
  )
    throw new Error(
      "Live odds secret reference is missing or plaintext leaked",
    );
  const liveRules = entriesOfType(template, "AWS::Events::Rule").filter(
    ([, value]) =>
      value.Properties?.ScheduleExpression === "rate(15 minutes)" &&
      value.Properties?.State === "ENABLED" &&
      value.Properties?.Targets?.some((target) =>
        isGetAtt(target.Arn, liveId, "Arn"),
      ),
  );
  if (liveRules.length !== 1)
    throw new Error("Live odds ingestion must have one enabled 15-minute rule");
  if (
    !Array.isArray(apiOutput?.["Fn::Join"]) ||
    apiOutput["Fn::Join"].length !== 2 ||
    apiOutput["Fn::Join"][0] !== "" ||
    !Array.isArray(apiOutput["Fn::Join"][1]) ||
    apiOutput["Fn::Join"][1].length !== 2 ||
    !isGetAtt(apiOutput["Fn::Join"][1][0], apiId, "ApiEndpoint") ||
    apiOutput["Fn::Join"][1][1] !== "/dev"
  )
    throw new Error("API output must reference the real dev API endpoint");
  for (const outputName of [
    "WebOrigin",
    "WebDistributionId",
    "WebAssetsBucketName",
    "CognitoIssuer",
    "CognitoUserPoolId",
    "CognitoClientId",
    "CognitoDomain",
    "CognitoScope",
    "CognitoCallbackUrl",
    "LiveOddsIngestionFunctionName",
    "TheOddsApiSecretName",
  ])
    if (!template.Outputs?.[outputName]?.Value)
      throw new Error(`Required launch output ${outputName} is missing`);
  if (
    JSON.stringify(template.Outputs.WebOrigin.Value) !==
      JSON.stringify(webOrigin) ||
    !isRef(template.Outputs.WebDistributionId.Value, distributionId) ||
    !isRef(template.Outputs.WebAssetsBucketName.Value, bucketId) ||
    !isGetAtt(template.Outputs.CognitoIssuer.Value, poolId, "ProviderURL") ||
    !isRef(template.Outputs.CognitoClientId.Value, clientId) ||
    !isRef(template.Outputs.CognitoUserPoolId.Value, poolId) ||
    JSON.stringify(template.Outputs.CognitoCallbackUrl.Value) !==
      JSON.stringify({
        "Fn::Join": [
          "",
          [
            "https://",
            { "Fn::GetAtt": [distributionId, "DomainName"] },
            "/auth/callback",
          ],
        ],
      }) ||
    JSON.stringify(template.Outputs.CognitoDomain.Value) !==
      JSON.stringify({
        "Fn::Join": [
          "",
          ["https://", { Ref: domainId }, ".auth.us-east-1.amazoncognito.com"],
        ],
      }) ||
    template.Outputs.CognitoScope.Value !== "events/events:read"
  )
    throw new Error(
      "Launch outputs must reference the exact created resources",
    );
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource?.Type !== "AWS::IAM::Policy") continue;
    for (const statement of resource.Properties?.PolicyDocument?.Statement ??
      []) {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      if (
        actions.some(
          (action) =>
            typeof action === "string" && action.startsWith("dynamodb:"),
        )
      ) {
        if (actions.includes("dynamodb:Scan"))
          throw new Error("DynamoDB Scan is forbidden in Phase1 IAM");
        const resources = Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource];
        if (
          resources.length !== 1 ||
          !resources.every((value) => isGetAtt(value, tableId, "Arn"))
        )
          throw new Error(
            "DynamoDB IAM must reference only the exact event table ARN",
          );
      }
    }
  }
  const liveRoleId = referencedRoleId(template.Resources?.[liveId]);
  const apiRoleId = referencedRoleId(template.Resources?.[apiLambdaId]);
  if (!liveRoleId || !apiRoleId)
    throw new Error(
      "API and live ingestion functions must reference IAM roles",
    );
  requireActions(
    dynamoActionsForRole(template, apiRoleId, tableId),
    [
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:TransactGetItems",
    ],
    "API DynamoDB IAM",
  );
  requireActions(
    dynamoActionsForRole(template, liveRoleId, tableId),
    [
      "dynamodb:BatchGetItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ],
    "Live ingestion DynamoDB IAM",
  );
}

export async function filesRecursively(directory, root = directory) {
  const rootReal = await realpath(root);
  const directoryReal = await realpath(directory);
  if (
    directoryReal !== rootReal &&
    !directoryReal.startsWith(`${rootReal}${sep}`)
  )
    throw new Error("Checksum walk escaped its bundle root");
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Bundle symlinks are forbidden");
    if (info.isDirectory())
      output.push(...(await filesRecursively(path, root)));
    else if (info.isFile()) output.push(path);
    else
      throw new Error("Bundle may contain only regular files and directories");
  }
  return output;
}

export async function checksums(directory, excluded = new Set()) {
  const result = {};
  for (const path of await filesRecursively(directory)) {
    const name = relative(directory, path).split(sep).join("/");
    if (excluded.has(name)) continue;
    result[name] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return result;
}
