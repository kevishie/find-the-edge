import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checksums,
  safeDevConfig,
  validateSafeDevConfig,
  validateTemplate,
} from "./phase1-support.mjs";

test("safe defaults are credential-free dev placeholders", () => {
  const config = safeDevConfig({});
  validateSafeDevConfig(config);
  assert.equal(config.stage, "dev");
  assert.match(config.apiBase, /^https:/);
});

test("rejects prod, wildcard origins, HTTP endpoints, and malformed secret ARNs", () => {
  const base = safeDevConfig({});
  for (const change of [
    { stage: "prod" },
    { webOrigin: "*" },
    { apiBase: "http://api.example.com" },
    { cursorSecretArn: "secret-value" },
    { fixtureSeedEnabled: false },
  ])
    assert.throws(() => validateSafeDevConfig({ ...base, ...change }));
  assert.doesNotThrow(() =>
    validateSafeDevConfig({
      ...base,
      localMode: true,
      apiBase: "http://127.0.0.1:3000",
    }),
  );
  assert.throws(() =>
    validateSafeDevConfig({
      ...base,
      localMode: true,
      apiBase: "http://api.example.com",
    }),
  );
});

function validTemplate() {
  const template = {
    Resources: {
      Table: { Type: "AWS::DynamoDB::Table", Properties: {} },
      Api: {
        Type: "AWS::ApiGatewayV2::Api",
        Properties: {
          CorsConfiguration: {
            AllowOrigins: ["https://app.example.com"],
            AllowMethods: ["GET", "OPTIONS"],
            AllowHeaders: ["authorization", "content-type"],
          },
        },
      },
      Route: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /games",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      EventsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /events",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      EventRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /events/{eventId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      Auth: {
        Type: "AWS::ApiGatewayV2::Authorizer",
        Properties: {
          ApiId: { Ref: "Api" },
          AuthorizerType: "JWT",
          JwtConfiguration: {
            Issuer: "https://issuer.example.com",
            Audience: ["audience"],
          },
        },
      },
      Integration: {
        Type: "AWS::ApiGatewayV2::Integration",
        Properties: {
          ApiId: { Ref: "Api" },
          IntegrationUri: { "Fn::GetAtt": ["ApiLambda", "Arn"] },
        },
      },
      ApiRole: { Type: "AWS::IAM::Role", Properties: {} },
      SeedRole: { Type: "AWS::IAM::Role", Properties: {} },
      ApiLambda: {
        Type: "AWS::Lambda::Function",
        Properties: { Role: { "Fn::GetAtt": ["ApiRole", "Arn"] } },
      },
      Seed: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Role: { "Fn::GetAtt": ["SeedRole", "Arn"] },
          Environment: { Variables: { FTE_FIXTURE_ODDS_SEED_ENABLED: "true" } },
        },
      },
      ApiPolicy: {
        Type: "AWS::IAM::Policy",
        Properties: {
          Roles: [{ Ref: "ApiRole" }],
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "dynamodb:BatchGetItem",
                  "dynamodb:GetItem",
                  "dynamodb:Query",
                  "dynamodb:TransactGetItems",
                ],
                Resource: [{ "Fn::GetAtt": ["Table", "Arn"] }],
              },
            ],
          },
        },
      },
      SeedPolicy: {
        Type: "AWS::IAM::Policy",
        Properties: {
          Roles: [{ Ref: "SeedRole" }],
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "dynamodb:GetItem",
                  "dynamodb:Query",
                  "dynamodb:PutItem",
                  "dynamodb:TransactWriteItems",
                ],
                Resource: [{ "Fn::GetAtt": ["Table", "Arn"] }],
              },
            ],
          },
        },
      },
    },
    Outputs: {
      EventsApiEndpoint: {
        Value: {
          "Fn::Join": ["", [{ "Fn::GetAtt": ["Api", "ApiEndpoint"] }, "/dev"]],
        },
      },
      FixtureOddsSeedFunctionName: { Value: { Ref: "Seed" } },
    },
  };
  return template;
}

const templateConfig = {
  webOrigin: "https://app.example.com",
  issuer: "https://issuer.example.com",
  audience: "audience",
};

test("template validation structurally binds API, auth, outputs, and scoped IAM", () => {
  const template = validTemplate();
  assert.doesNotThrow(() => validateTemplate(template, templateConfig));
  assert.throws(
    () => validateTemplate({ ...template, Outputs: {} }, templateConfig),
    /output/i,
  );
  const wildcard = structuredClone(template);
  wildcard.Resources.Api.Properties.CorsConfiguration.AllowOrigins = ["*"];
  assert.throws(() => validateTemplate(wildcard, templateConfig), /CORS/);
  for (const [property, value] of [
    ["AllowMethods", ["GET"]],
    ["AllowHeaders", ["authorization", "content-type", "*"]],
  ]) {
    const wrongCors = structuredClone(template);
    wrongCors.Resources.Api.Properties.CorsConfiguration[property] = value;
    assert.throws(() => validateTemplate(wrongCors, templateConfig), /CORS/);
  }
  const wrongApi = structuredClone(template);
  wrongApi.Resources.Route.Properties.ApiId = { Ref: "OtherApi" };
  assert.throws(() => validateTemplate(wrongApi, templateConfig), /intended/i);
  for (const routeId of ["Route", "EventsRoute", "EventRoute"]) {
    const missingRoute = structuredClone(template);
    delete missingRoute.Resources[routeId];
    assert.throws(
      () => validateTemplate(missingRoute, templateConfig),
      /routes/,
    );
  }
  const extraRoute = structuredClone(template);
  extraRoute.Resources.ExtraRoute = structuredClone(template.Resources.Route);
  extraRoute.Resources.ExtraRoute.Properties.RouteKey = "GET /extra";
  assert.throws(() => validateTemplate(extraRoute, templateConfig), /routes/);
  for (const mutate of [
    (copy) => delete copy.Resources.EventsRoute.Properties.Target,
    (copy) =>
      (copy.Resources.EventsRoute.Properties.Target = {
        "Fn::Join": ["", ["integrations/", { Ref: "OtherIntegration" }]],
      }),
    (copy) =>
      (copy.Resources.Integration.Properties.ApiId = { Ref: "OtherApi" }),
    (copy) =>
      (copy.Resources.Integration.Properties.IntegrationUri = {
        "Fn::GetAtt": ["OtherLambda", "Arn"],
      }),
    (copy) =>
      (copy.Resources.Integration.Properties.IntegrationUri = {
        "Fn::GetAtt": ["ApiLambda", "Name"],
      }),
  ]) {
    const wrongIntegration = structuredClone(template);
    mutate(wrongIntegration);
    assert.throws(() => validateTemplate(wrongIntegration, templateConfig));
  }
  const publicRoute = structuredClone(template);
  publicRoute.Resources.Public = {
    Type: "AWS::ApiGatewayV2::Route",
    Properties: { ApiId: { Ref: "Api" }, RouteKey: "$default" },
  };
  assert.throws(
    () => validateTemplate(publicRoute, templateConfig),
    /scoped JWT authorizer|\$default/,
  );
  for (const change of [
    { AuthorizerId: { Ref: "OtherAuth" } },
    { AuthorizationScopes: ["other:read"] },
    { AuthorizationScopes: undefined },
  ]) {
    const weakRoute = structuredClone(template);
    weakRoute.Resources.OtherRoute = {
      Type: "AWS::ApiGatewayV2::Route",
      Properties: {
        ...weakRoute.Resources.Route.Properties,
        RouteKey: "GET /events",
        ...change,
      },
    };
    assert.throws(
      () => validateTemplate(weakRoute, templateConfig),
      /scoped JWT authorizer/,
    );
  }
  const wildcardIam = structuredClone(template);
  wildcardIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement[0].Resource =
    "*";
  assert.throws(
    () => validateTemplate(wildcardIam, templateConfig),
    /exact event table/,
  );
  const scanIam = structuredClone(template);
  scanIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement[0].Action.push(
    "dynamodb:Scan",
  );
  assert.throws(() => validateTemplate(scanIam, templateConfig), /Scan/);
  for (const [policy, action] of [
    ["ApiPolicy", "dynamodb:BatchGetItem"],
    ["SeedPolicy", "dynamodb:TransactWriteItems"],
  ]) {
    const missingAction = structuredClone(template);
    const actions =
      missingAction.Resources[policy].Properties.PolicyDocument.Statement[0]
        .Action;
    actions.splice(actions.indexOf(action), 1);
    assert.throws(
      () => validateTemplate(missingAction, templateConfig),
      /exactly the required actions/,
    );
  }
  for (const policy of ["ApiPolicy", "SeedPolicy"]) {
    const extraAction = structuredClone(template);
    extraAction.Resources[
      policy
    ].Properties.PolicyDocument.Statement[0].Action.push("dynamodb:DeleteItem");
    assert.throws(
      () => validateTemplate(extraAction, templateConfig),
      /exactly the required actions/,
    );
  }
  const denyOnly = structuredClone(template);
  denyOnly.Resources.ApiPolicy.Properties.PolicyDocument.Statement[0].Effect =
    "Deny";
  assert.throws(
    () => validateTemplate(denyOnly, templateConfig),
    /exactly the required actions/,
  );
  for (const output of [
    {
      "Fn::Join": [
        "",
        ["prefix", { "Fn::GetAtt": ["Api", "ApiEndpoint"] }, "/dev"],
      ],
    },
    {
      "Fn::Join": [
        "",
        [{ "Fn::GetAtt": ["Api", "ApiEndpoint"] }, "/dev", "suffix"],
      ],
    },
    { "Fn::Join": ["", ["/dev", { "Fn::GetAtt": ["Api", "ApiEndpoint"] }]] },
  ]) {
    const wrongOutput = structuredClone(template);
    wrongOutput.Outputs.EventsApiEndpoint.Value = output;
    assert.throws(
      () => validateTemplate(wrongOutput, templateConfig),
      /API output/,
    );
  }
});

test("checksum walk rejects symlinks without following them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fte-checksum-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.txt"), "safe");
  assert.equal(Object.keys(await checksums(root)).join(), "file.txt");
  await symlink(join(root, "file.txt"), join(root, "link.txt"));
  await assert.rejects(checksums(root), /symlinks/);
});
