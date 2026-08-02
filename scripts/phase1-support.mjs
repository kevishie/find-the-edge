import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const projectRoot = resolve(new URL("..", import.meta.url).pathname);

export function safeDevConfig(environment = process.env) {
  return {
    stage: environment.FTE_AWS_STAGE ?? "dev",
    issuer: environment.FTE_JWT_ISSUER ?? "https://issuer.phase1.invalid",
    audience: environment.FTE_JWT_AUDIENCE ?? "find-the-edge-dev",
    cursorSecretArn:
      environment.FTE_EVENT_CURSOR_SECRET_ARN ??
      "arn:aws:secretsmanager:us-east-1:000000000000:secret:phase1-cursor",
    webOrigin: environment.FTE_WEB_ORIGIN ?? "https://app.phase1.invalid",
    apiBase: environment.FTE_PHASE1_API_BASE ?? "https://api.phase1.invalid",
    providerKey: environment.FTE_PHASE1_PROVIDER_KEY ?? "hostSession",
    fixtureSeedEnabled:
      environment.FTE_FIXTURE_ODDS_SEED_ENABLED === undefined ||
      environment.FTE_FIXTURE_ODDS_SEED_ENABLED === "true",
    localMode: environment.FTE_PHASE1_LOCAL_MODE === "1",
  };
}

export function validateSafeDevConfig(config) {
  if (config.stage !== "dev")
    throw new Error("Phase1 requires FTE_AWS_STAGE=dev");
  if (!config.fixtureSeedEnabled)
    throw new Error("Phase1 requires FTE_FIXTURE_ODDS_SEED_ENABLED=true");
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
  const tables = entriesOfType(template, "AWS::DynamoDB::Table");
  const apis = entriesOfType(template, "AWS::ApiGatewayV2::Api");
  if (tables.length !== 1 || apis.length !== 1)
    throw new Error("Phase1 requires exactly one event table and HTTP API");
  const [tableId] = tables[0];
  const [apiId, api] = apis[0];
  const cors = api.Properties?.CorsConfiguration;
  if (
    !Array.isArray(cors?.AllowOrigins) ||
    cors.AllowOrigins.length !== 1 ||
    cors.AllowOrigins[0] !== config.webOrigin ||
    JSON.stringify(cors.AllowMethods) !== JSON.stringify(["GET", "OPTIONS"]) ||
    JSON.stringify(cors.AllowHeaders) !==
      JSON.stringify(["authorization", "content-type"])
  )
    throw new Error(
      "HTTP API CORS must contain only the exact origin, methods, and headers",
    );
  const authorizers = entriesOfType(
    template,
    "AWS::ApiGatewayV2::Authorizer",
  ).filter(
    ([, value]) =>
      isRef(value.Properties?.ApiId, apiId) &&
      value.Properties?.AuthorizerType === "JWT" &&
      value.Properties?.JwtConfiguration?.Issuer === config.issuer &&
      JSON.stringify(value.Properties?.JwtConfiguration?.Audience) ===
        JSON.stringify([config.audience]),
  );
  if (authorizers.length !== 1)
    throw new Error("Intended API must have the exact JWT issuer and audience");
  const [authorizerId] = authorizers[0];
  const integrations = entriesOfType(
    template,
    "AWS::ApiGatewayV2::Integration",
  ).filter(([, value]) => isRef(value.Properties?.ApiId, apiId));
  const apiRoutes = entriesOfType(template, "AWS::ApiGatewayV2::Route").filter(
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
    apiRoutes.some(
      ([, value]) =>
        value.Properties?.RouteKey === "$default" ||
        value.Properties?.AuthorizationType !== "JWT" ||
        !isRef(value.Properties?.AuthorizerId, authorizerId) ||
        JSON.stringify(value.Properties?.AuthorizationScopes) !==
          JSON.stringify(["events:read"]),
    )
  )
    throw new Error(
      "Intended API routes must all use the exact scoped JWT authorizer and must not include $default routes",
    );
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
  if (seedFunctions.length !== 1)
    throw new Error("Exactly one enabled fixture seed function is required");
  const [seedId] = seedFunctions[0];
  const seedOutput = template.Outputs?.FixtureOddsSeedFunctionName?.Value;
  const apiOutput = template.Outputs?.EventsApiEndpoint?.Value;
  if (!isRef(seedOutput, seedId))
    throw new Error(
      "Fixture seed output must reference the real seed function",
    );
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
  const seedRoleId = referencedRoleId(template.Resources?.[seedId]);
  const apiRoleId = referencedRoleId(template.Resources?.[apiLambdaId]);
  if (!seedRoleId || !apiRoleId)
    throw new Error("API and fixture seed functions must reference IAM roles");
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
    dynamoActionsForRole(template, seedRoleId, tableId),
    [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ],
    "Fixture seed DynamoDB IAM",
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
