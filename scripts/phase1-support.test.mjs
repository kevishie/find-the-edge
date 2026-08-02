import assert from "node:assert/strict";
import vm from "node:vm";
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
  const exactSpaCode =
    "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/games' || request.uri === '/auth/callback') {\n    request.uri = '/index.html';\n  }\n  return request;\n}";
  const webOrigin = {
    "Fn::Join": [
      "",
      ["https://", { "Fn::GetAtt": ["Distribution", "DomainName"] }],
    ],
  };
  const exactCsp = {
    "Fn::Join": [
      "",
      [
        "default-src 'self'; base-uri 'none'; connect-src 'self' ",
        { "Fn::GetAtt": ["Api", "ApiEndpoint"] },
        " https://",
        { Ref: "Domain" },
        ".auth.us-east-1.amazoncognito.com; form-action 'self' https://",
        { Ref: "Domain" },
        ".auth.us-east-1.amazoncognito.com; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
      ],
    ],
  };
  const corsCall = {
    "Fn::Join": [
      "",
      [
        '{"service":"ApiGatewayV2","action":"updateApi","parameters":{"ApiId":"',
        { Ref: "Api" },
        '","CorsConfiguration":{"AllowOrigins":["https://',
        { "Fn::GetAtt": ["Distribution", "DomainName"] },
        '"],"AllowHeaders":["authorization","content-type"],"AllowMethods":["GET","OPTIONS"]}},"physicalResourceId":{"id":"fixture-events-api-cors"}}',
      ],
    ],
  };
  const template = {
    Resources: {
      Table: { Type: "AWS::DynamoDB::Table", Properties: {} },
      Pool: {
        Type: "AWS::Cognito::UserPool",
        Properties: {
          AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
          Policies: { PasswordPolicy: { MinimumLength: 14 } },
        },
      },
      Server: {
        Type: "AWS::Cognito::UserPoolResourceServer",
        Properties: {
          Identifier: "events",
          Scopes: [
            {
              ScopeDescription: "Read FIND THE EDGE events and odds",
              ScopeName: "events:read",
            },
          ],
        },
      },
      Domain: {
        Type: "AWS::Cognito::UserPoolDomain",
        Properties: { UserPoolId: { Ref: "Pool" } },
      },
      Client: {
        Type: "AWS::Cognito::UserPoolClient",
        Properties: {
          GenerateSecret: false,
          AllowedOAuthFlows: ["code"],
          UserPoolId: { Ref: "Pool" },
          CallbackURLs: [
            {
              "Fn::Join": [
                "",
                [
                  "https://",
                  { "Fn::GetAtt": ["Distribution", "DomainName"] },
                  "/auth/callback",
                ],
              ],
            },
          ],
          LogoutURLs: [webOrigin],
        },
      },
      Bucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
            ],
          },
          VersioningConfiguration: { Status: "Enabled" },
        },
      },
      BucketPolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: {
          Bucket: { Ref: "Bucket" },
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: "s3:GetObject",
                Principal: { Service: "cloudfront.amazonaws.com" },
                Resource: {
                  "Fn::Join": ["", [{ "Fn::GetAtt": ["Bucket", "Arn"] }, "/*"]],
                },
                Condition: {
                  StringEquals: {
                    "AWS:SourceArn": {
                      "Fn::Join": [
                        "",
                        ["distribution/", { Ref: "Distribution" }],
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
      Oac: {
        Type: "AWS::CloudFront::OriginAccessControl",
        Properties: {
          OriginAccessControlConfig: { SigningBehavior: "always" },
        },
      },
      SpaFunction: {
        Type: "AWS::CloudFront::Function",
        Properties: { AutoPublish: true, FunctionCode: exactSpaCode },
      },
      Headers: {
        Type: "AWS::CloudFront::ResponseHeadersPolicy",
        Properties: {
          ResponseHeadersPolicyConfig: {
            SecurityHeadersConfig: {
              ContentSecurityPolicy: {
                ContentSecurityPolicy: exactCsp,
              },
            },
          },
        },
      },
      ImmutableHeaders: {
        Type: "AWS::CloudFront::ResponseHeadersPolicy",
        Properties: {
          ResponseHeadersPolicyConfig: {
            SecurityHeadersConfig: {
              ContentSecurityPolicy: {
                ContentSecurityPolicy: exactCsp,
              },
            },
          },
        },
      },
      Distribution: {
        Type: "AWS::CloudFront::Distribution",
        Properties: {
          DistributionConfig: {
            DefaultRootObject: "index.html",
            DefaultCacheBehavior: {
              ViewerProtocolPolicy: "redirect-to-https",
              Compress: true,
              FunctionAssociations: [
                {
                  EventType: "viewer-request",
                  FunctionARN: {
                    "Fn::GetAtt": ["SpaFunction", "FunctionARN"],
                  },
                },
              ],
            },
            Origins: [{ OriginAccessControlId: { Ref: "Oac" } }],
          },
        },
      },
      Api: {
        Type: "AWS::ApiGatewayV2::Api",
        Properties: {},
      },
      CorsConfigurator: {
        Type: "Custom::AWS",
        Properties: {
          ServiceToken: { "Fn::GetAtt": ["CorsHandler", "Arn"] },
          Create: corsCall,
          Update: corsCall,
        },
      },
      Route: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /games",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/events:read"],
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
          AuthorizationScopes: ["events/events:read"],
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
          AuthorizationScopes: ["events/events:read"],
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
            Issuer: { "Fn::GetAtt": ["Pool", "ProviderURL"] },
            Audience: [{ Ref: "Client" }],
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
      CorsPolicy: {
        Type: "AWS::IAM::Policy",
        Properties: {
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: "apigateway:PATCH",
                Resource: {
                  "Fn::Join": [
                    "",
                    ["arn:aws:apigateway:us-east-1::/apis/", { Ref: "Api" }],
                  ],
                },
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
                  "dynamodb:ConditionCheckItem",
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
      WebOrigin: { Value: webOrigin },
      WebDistributionId: { Value: { Ref: "Distribution" } },
      WebAssetsBucketName: { Value: { Ref: "Bucket" } },
      CognitoIssuer: { Value: { "Fn::GetAtt": ["Pool", "ProviderURL"] } },
      CognitoUserPoolId: { Value: { Ref: "Pool" } },
      CognitoClientId: { Value: { Ref: "Client" } },
      CognitoDomain: {
        Value: {
          "Fn::Join": [
            "",
            [
              "https://",
              { Ref: "Domain" },
              ".auth.us-east-1.amazoncognito.com",
            ],
          ],
        },
      },
      CognitoScope: { Value: "events/events:read" },
      CognitoCallbackUrl: {
        Value: {
          "Fn::Join": [
            "",
            [
              "https://",
              { "Fn::GetAtt": ["Distribution", "DomainName"] },
              "/auth/callback",
            ],
          ],
        },
      },
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
  const handler = vm.runInNewContext(
    `${template.Resources.SpaFunction.Properties.FunctionCode}; handler`,
  );
  for (const [uri, expected] of [
    ["/games", "/index.html"],
    ["/auth/callback", "/index.html"],
    ["/assets/missing.hash.js", "/assets/missing.hash.js"],
    ["/runtime-config.js", "/runtime-config.js"],
    ["/cognito-token-provider.js", "/cognito-token-provider.js"],
    ["/any.dotted/path", "/any.dotted/path"],
  ])
    assert.equal(handler({ request: { uri } }).uri, expected);
  for (const mutate of [
    (copy) =>
      (copy.Resources.Distribution.Properties.DistributionConfig.CustomErrorResponses =
        [{ ErrorCode: 404, ResponsePagePath: "/index.html" }]),
    (copy) =>
      (copy.Resources.SpaFunction.Properties.FunctionCode =
        "function handler(event){return event.request;}"),
    (copy) =>
      delete copy.Resources.Distribution.Properties.DistributionConfig
        .DefaultCacheBehavior.FunctionAssociations,
  ]) {
    const unsafeNavigation = structuredClone(template);
    mutate(unsafeNavigation);
    assert.throws(
      () => validateTemplate(unsafeNavigation, templateConfig),
      /SPA navigation|CloudFront/,
    );
  }
  assert.throws(
    () => validateTemplate({ ...template, Outputs: {} }, templateConfig),
    /output/i,
  );
  const wildcard = structuredClone(template);
  wildcard.Resources.CorsConfigurator.Properties.Create["Fn::Join"][1][2] =
    '","CorsConfiguration":{"AllowOrigins":["*';
  wildcard.Resources.CorsConfigurator.Properties.Update =
    wildcard.Resources.CorsConfigurator.Properties.Create;
  assert.throws(() => validateTemplate(wildcard, templateConfig), /CORS/);
  for (const mutate of [
    (copy) => delete copy.Resources.BucketPolicy,
    (copy) =>
      (copy.Resources.BucketPolicy.Properties.PolicyDocument.Statement[0].Condition.StringEquals[
        "AWS:SourceArn"
      ] = "*"),
    (copy) =>
      (copy.Resources.BucketPolicy.Properties.PolicyDocument.Statement[0].Principal.Service =
        "*"),
  ]) {
    const weakenedOac = structuredClone(template);
    mutate(weakenedOac);
    assert.throws(
      () => validateTemplate(weakenedOac, templateConfig),
      /private|bucket|OAC/i,
    );
  }
  for (const mutate of [
    (copy) => (copy.Outputs.CognitoUserPoolId.Value = { Ref: "OtherPool" }),
    (copy) =>
      (copy.Resources.Domain.Properties.UserPoolId = { Ref: "OtherPool" }),
    (copy) => (copy.Outputs.CognitoDomain.Value = "https://other.example.com"),
    (copy) =>
      (copy.Outputs.CognitoCallbackUrl.Value =
        "https://other.example.com/auth/callback"),
  ]) {
    const crossBound = structuredClone(template);
    mutate(crossBound);
    assert.throws(
      () => validateTemplate(crossBound, templateConfig),
      /Cognito|Launch outputs/,
    );
  }
  for (const resourceId of ["Headers", "ImmutableHeaders"]) {
    const wrongCsp = structuredClone(template);
    wrongCsp.Resources[
      resourceId
    ].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy[
      "Fn::Join"
    ][1][1] = { "Fn::GetAtt": ["OtherApi", "ApiEndpoint"] };
    assert.throws(() => validateTemplate(wrongCsp, templateConfig), /CSP/);
  }
  for (const [property, value] of [
    ["AllowMethods", ["GET"]],
    ["AllowHeaders", ["authorization", "content-type", "*"]],
  ]) {
    const wrongCors = structuredClone(template);
    const parts =
      wrongCors.Resources.CorsConfigurator.Properties.Create["Fn::Join"][1];
    parts[4] = parts[4].replace(
      new RegExp(`"${property}":\\[[^\\]]*\\]`),
      `"${property}":${JSON.stringify(value)}`,
    );
    wrongCors.Resources.CorsConfigurator.Properties.Update =
      wrongCors.Resources.CorsConfigurator.Properties.Create;
    assert.throws(() => validateTemplate(wrongCors, templateConfig), /CORS/);
  }
  for (const mutate of [
    (statement) => (statement.Action = "apigateway:UpdateApi"),
    (statement) => (statement.Action = ["apigateway:PATCH", "apigateway:GET"]),
    (statement) => (statement.Resource = "*"),
    (statement) => (statement.Effect = "Deny"),
  ]) {
    const wrongCorsIam = structuredClone(template);
    mutate(
      wrongCorsIam.Resources.CorsPolicy.Properties.PolicyDocument.Statement[0],
    );
    assert.throws(
      () => validateTemplate(wrongCorsIam, templateConfig),
      /CORS configurator IAM/,
    );
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
