import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checksums,
  failureDetail,
  safeDevConfig,
  validateSafeDevConfig,
  validateTemplate,
} from "./phase1-support.mjs";

test("failed commands report their own diagnostics without leaking credentials", () => {
  assert.equal(
    failureDetail(
      "\nAn error occurred (AccessDenied) when calling GetInvalidation\n",
    ),
    ": An error occurred (AccessDenied) when calling GetInvalidation",
  );
  const redacted = failureDetail(
    "denied for ASIAZZZZZZZZZZZZZZZZ\naws_session_token=abc.def\n",
  );
  assert.doesNotMatch(redacted, /ASIAZZZZZZZZZZZZZZZZ|abc\.def/);
  assert.match(redacted, /\[redacted]/);
  assert.equal(failureDetail(undefined), "");
  assert.equal(failureDetail("   \n  "), "");
  assert.ok(failureDetail("x".repeat(900)).length <= 502);
});

test("safe defaults are credential-free dev placeholders", () => {
  const config = safeDevConfig({});
  validateSafeDevConfig(config);
  assert.equal(config.stage, "dev");
  assert.match(config.apiBase, /^https:/);
  assert.deepEqual(config.cognitoScopes, [
    "events/events:read",
    "events/scouting:read",
    "events/scouting:write",
  ]);
});

test("rejects prod, wildcard origins, HTTP endpoints, and malformed secret ARNs", () => {
  const base = safeDevConfig({});
  for (const change of [
    { stage: "prod" },
    { webOrigin: "*" },
    { apiBase: "http://api.example.com" },
    { cursorSecretArn: "secret-value" },
    { fixtureSeedEnabled: true },
    { schedulerEnabled: false },
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
  for (const cognitoScopes of [
    ["events/events:read"],
    ["events/events:read", "events/scouting:write", "events/scouting:read"],
  ])
    assert.throws(() => validateSafeDevConfig({ ...base, cognitoScopes }));
});

function validTemplate() {
  const exactSpaCode =
    "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/auth/callback' || request.uri === '/login' || request.uri === '/sign-in' || request.uri === '/privacy' || request.uri === '/terms' || request.uri === '/events' || request.uri.indexOf('/events/') === 0 || request.uri === '/games' || request.uri.indexOf('/games/') === 0 || request.uri === '/splits' || request.uri === '/watchlist' || request.uri === '/dashboard' || request.uri === '/performance' || request.uri === '/data-sources' || request.uri.indexOf('/data-sources/') === 0 || request.uri === '/retrospectives' || request.uri.indexOf('/retrospectives/') === 0 || request.uri === '/experiments' || request.uri.indexOf('/experiments/') === 0 || request.uri.indexOf('/scout-jobs/') === 0) {\n    request.uri = '/index.html';\n  }\n  return request;\n}";
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
        ".auth.us-east-1.amazoncognito.com; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
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
        '"],"AllowHeaders":["authorization","content-type","idempotency-key"],"AllowMethods":["GET","POST","DELETE","OPTIONS"],"ExposeHeaders":["location"]}},"physicalResourceId":{"id":"fixture-events-api-cors"}}',
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
            {
              ScopeDescription: "Read owned FIND THE EDGE scouting jobs",
              ScopeName: "scouting:read",
            },
            {
              ScopeDescription: "Create and retry FIND THE EDGE scouting jobs",
              ScopeName: "scouting:write",
            },
            {
              ScopeDescription:
                "Review non-executable retrospective candidates",
              ScopeName: "retrospectives:approve",
            },
            {
              ScopeDescription:
                "Approve, promote, and roll back deployed strategy artifacts",
              ScopeName: "strategies:promote",
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
          AllowedOAuthScopes: [
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/events:read"]],
            },
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/scouting:read"]],
            },
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/scouting:write"]],
            },
          ],
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
      ReviewerClient: {
        Type: "AWS::Cognito::UserPoolClient",
        Properties: {
          GenerateSecret: false,
          AllowedOAuthFlows: ["code"],
          AllowedOAuthScopes: [
            "openid",
            "email",
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/events:read"]],
            },
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/scouting:read"]],
            },
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/scouting:write"]],
            },
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/retrospectives:approve"]],
            },
            {
              "Fn::Join": ["", [{ Ref: "Server" }, "/strategies:promote"]],
            },
          ],
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
      ReviewerGroup: {
        Type: "AWS::Cognito::UserPoolGroup",
        Properties: {
          GroupName: "fte-retrospective-reviewers",
          UserPoolId: { Ref: "Pool" },
        },
      },
      StrategyPromoterGroup: {
        Type: "AWS::Cognito::UserPoolGroup",
        Properties: {
          GroupName: "fte-strategy-promoters",
          UserPoolId: { Ref: "Pool" },
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
      ApiStage: {
        Type: "AWS::ApiGatewayV2::Stage",
        Properties: {
          ApiId: { Ref: "Api" },
          DefaultRouteSettings: {
            ThrottlingBurstLimit: 100,
            ThrottlingRateLimit: 50,
          },
        },
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
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      OddsHistoryRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /games/{eventId}/odds-history",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      SplitsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /splits",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ProviderStatusRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /providers/status",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      OpportunityListRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /sports/{sportKey}/opportunities",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      OpportunityDetailRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /sports/{sportKey}/opportunities/{opportunityId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ArbitrageRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /sports/{sportKey}/arbitrage",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ClvRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /sports/{sportKey}/clv",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      PerformanceCohortsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /performance/cohorts",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      PerformanceCohortRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /performance/cohorts/{eventId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      PerformanceReportsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /performance/reports",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      PerformanceReportRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /performance/reports/{eventId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      RetrospectivesRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /retrospectives",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      RetrospectiveRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /retrospectives/{eventId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      RetrospectiveVersionsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /retrospectives/{eventId}/versions",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      RetrospectiveReviewRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "POST /retrospectives/{eventId}/review",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/retrospectives:approve"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      StrategyExperimentsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /strategy-experiments",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      StrategyExperimentRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /strategy-experiments/{eventId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ...Object.fromEntries(
        ["approve", "promote", "rollback"].map((action) => [
          `StrategyExperiment${action}Route`,
          {
            Type: "AWS::ApiGatewayV2::Route",
            Properties: {
              RouteKey: `POST /strategy-experiments/{eventId}/${action}`,
              ApiId: { Ref: "Api" },
              AuthorizationType: "JWT",
              AuthorizerId: { Ref: "Auth" },
              AuthorizationScopes: ["events/strategies:promote"],
              Target: {
                "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
              },
            },
          },
        ]),
      ),
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
          AuthorizationType: "NONE",
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ScoutCreateRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "POST /events/{eventId}/scout",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/scouting:write"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ScoutStatusRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /scout-jobs/{jobId}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/scouting:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ScoutRetryRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "POST /scout-jobs/{jobId}/retry",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/scouting:write"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ScoutReportByJobRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /scout-jobs/{jobId}/report",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/scouting:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ScoutReportVersionsRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /scout-reports/{reportId}/versions",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/scouting:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ScoutReportVersionRoute: {
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          RouteKey: "GET /scout-reports/{reportId}/versions/{versionNumber}",
          ApiId: { Ref: "Api" },
          AuthorizationType: "JWT",
          AuthorizerId: { Ref: "Auth" },
          AuthorizationScopes: ["events/scouting:read"],
          Target: {
            "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
          },
        },
      },
      ...Object.fromEntries(
        [
          ["AuthOtpRequestRoute", "POST /auth/otp/request"],
          ["AuthOtpVerifyRoute", "POST /auth/otp/verify"],
          ["AuthSessionRefreshRoute", "POST /auth/session/refresh"],
          ["BillingWebhookRoute", "POST /billing/webhook"],
          ["BillingEntitlementRoute", "GET /billing/entitlement"],
          ["BillingCheckoutRoute", "POST /billing/checkout"],
          ["BillingPortalRoute", "POST /billing/portal"],
        ].map(([id, routeKey]) => [
          id,
          {
            Type: "AWS::ApiGatewayV2::Route",
            Properties: {
              RouteKey: routeKey,
              ApiId: { Ref: "Api" },
              AuthorizationType: "NONE",
              Target: {
                "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
              },
            },
          },
        ]),
      ),
      ...Object.fromEntries(
        [
          ["WatchlistListRoute", "GET /watchlist"],
          ["WatchlistAddRoute", "POST /watchlist"],
          ["WatchlistRemoveRoute", "DELETE /watchlist/{eventId}"],
        ].map(([id, routeKey]) => [
          id,
          {
            Type: "AWS::ApiGatewayV2::Route",
            Properties: {
              RouteKey: routeKey,
              ApiId: { Ref: "Api" },
              AuthorizationType: "JWT",
              AuthorizerId: { Ref: "Auth" },
              Target: {
                "Fn::Join": ["", ["integrations/", { Ref: "Integration" }]],
              },
            },
          },
        ]),
      ),
      Auth: {
        Type: "AWS::ApiGatewayV2::Authorizer",
        Properties: {
          ApiId: { Ref: "Api" },
          AuthorizerType: "JWT",
          JwtConfiguration: {
            Issuer: { "Fn::GetAtt": ["Pool", "ProviderURL"] },
            Audience: [{ Ref: "Client" }, { Ref: "ReviewerClient" }],
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
          Environment: {
            Variables: {
              FTE_SHARP_API_ENABLED: "true",
              FTE_SHARP_API_SECRET_ID: "find-the-edge/dev/sharpapi",
            },
          },
        },
      },
      LiveQueue: {
        Type: "AWS::SQS::Queue",
        Properties: { FifoQueue: true },
      },
      LiveMapping: {
        Type: "AWS::Lambda::EventSourceMapping",
        Properties: {
          BatchSize: 1,
          EventSourceArn: { "Fn::GetAtt": ["LiveQueue", "Arn"] },
          FunctionName: { Ref: "Seed" },
        },
      },
      LiveRule: {
        Type: "AWS::Events::Rule",
        Properties: {
          ScheduleExpression: "rate(1 minute)",
          State: "ENABLED",
          Targets: [
            { Arn: { "Fn::GetAtt": ["LiveQueue", "Arn"] }, Id: "Target0" },
          ],
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
                  "dynamodb:PutItem",
                  "dynamodb:Query",
                  "dynamodb:TransactGetItems",
                  "dynamodb:TransactWriteItems",
                ],
                Resource: [{ "Fn::GetAtt": ["Table", "Arn"] }],
              },
              {
                Effect: "Allow",
                Action: "dynamodb:DeleteItem",
                Resource: { "Fn::GetAtt": ["Table", "Arn"] },
                Condition: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": ["WATCHLIST#*"],
                  },
                },
              },
              {
                Effect: "Allow",
                Action: "dynamodb:UpdateItem",
                Resource: { "Fn::GetAtt": ["Table", "Arn"] },
                Condition: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      "ACCOUNT#*",
                      "OTP#*",
                      "OTP_RATE#*",
                      "ENTITLEMENT#*",
                    ],
                  },
                },
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
                  "dynamodb:BatchGetItem",
                  "dynamodb:ConditionCheckItem",
                  "dynamodb:GetItem",
                  "dynamodb:Query",
                  "dynamodb:PutItem",
                  "dynamodb:UpdateItem",
                  "dynamodb:TransactWriteItems",
                ],
                Resource: [{ "Fn::GetAtt": ["Table", "Arn"] }],
              },
              {
                Effect: "Allow",
                Action: "dynamodb:DeleteItem",
                Resource: [{ "Fn::GetAtt": ["Table", "Arn"] }],
                Condition: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": ["EVENT_RECONCILIATION#*"],
                  },
                },
              },
            ],
          },
        },
      },
    },
    Outputs: {
      EventsApiId: { Value: { Ref: "Api" } },
      EventsApiEndpoint: {
        Value: {
          "Fn::Join": ["", [{ "Fn::GetAtt": ["Api", "ApiEndpoint"] }, "/dev"]],
        },
      },
      LiveOddsIngestionFunctionName: { Value: { Ref: "Seed" } },
      SharpApiSecretName: { Value: "find-the-edge/dev/sharpapi" },
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
      ScoutingReadScope: { Value: "events/scouting:read" },
      ScoutingWriteScope: { Value: "events/scouting:write" },
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

test("template validation structurally binds public reads, outputs, and scoped IAM", () => {
  const template = validTemplate();
  assert.doesNotThrow(() => validateTemplate(template, templateConfig));
  const handler = vm.runInNewContext(
    `${template.Resources.SpaFunction.Properties.FunctionCode}; handler`,
  );
  for (const [uri, expected] of [
    ["/games", "/index.html"],
    ["/auth/callback", "/index.html"],
    ["/privacy", "/index.html"],
    ["/terms", "/index.html"],
    ["/assets/missing.hash.js", "/assets/missing.hash.js"],
    ["/runtime-config.js", "/runtime-config.js"],
    ["/cognito-token-provider.js", "/cognito-token-provider.js"],
    ["/any.dotted/path", "/any.dotted/path"],
  ])
    assert.equal(handler({ request: { uri } }).uri, expected);
  for (const legalRoute of ["/privacy", "/terms"]) {
    const missingLegalRoute = structuredClone(template);
    missingLegalRoute.Resources.SpaFunction.Properties.FunctionCode =
      missingLegalRoute.Resources.SpaFunction.Properties.FunctionCode.replace(
        `request.uri === '${legalRoute}' || `,
        "",
      );
    assert.throws(
      () => validateTemplate(missingLegalRoute, templateConfig),
      /SPA navigation|CloudFront/,
    );
  }
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

    const wrongCognitoHost = structuredClone(template);
    wrongCognitoHost.Resources[
      resourceId
    ].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy[
      "Fn::Join"
    ][1][4] = ".auth.eu-west-1.amazoncognito.com; form-action 'none'";
    assert.throws(
      () => validateTemplate(wrongCognitoHost, templateConfig),
      /CSP/,
    );
  }
  for (const unwantedScope of ["openid", "email"]) {
    const staleOrdinaryScopes = structuredClone(template);
    staleOrdinaryScopes.Resources.Client.Properties.AllowedOAuthScopes.unshift(
      unwantedScope,
    );
    assert.throws(
      () => validateTemplate(staleOrdinaryScopes, templateConfig),
      /Cognito web clients/,
    );
  }
  for (const [property, value] of [
    ["AllowMethods", ["GET"]],
    ["AllowHeaders", ["authorization", "content-type", "idempotency-key", "*"]],
    ["ExposeHeaders", []],
    ["ExposeHeaders", ["location", "*"]],
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
  assert.throws(
    () => validateTemplate(wrongApi, templateConfig),
    /public|scoped/i,
  );
  for (const routeId of [
    "Route",
    "EventsRoute",
    "EventRoute",
    "ScoutCreateRoute",
    "ScoutStatusRoute",
    "ScoutRetryRoute",
  ]) {
    const missingRoute = structuredClone(template);
    delete missingRoute.Resources[routeId];
    assert.throws(
      () => validateTemplate(missingRoute, templateConfig),
      /public|scoped/,
    );
  }
  for (const [routeId, wrongScope] of [
    ["ScoutCreateRoute", "events/scouting:read"],
    ["ScoutStatusRoute", "events/scouting:write"],
    ["ScoutRetryRoute", "events/events:read"],
  ]) {
    const wrongScoutingScope = structuredClone(template);
    wrongScoutingScope.Resources[routeId].Properties.AuthorizationScopes = [
      wrongScope,
    ];
    assert.throws(
      () => validateTemplate(wrongScoutingScope, templateConfig),
      /scoped/,
    );
  }
  const extraRoute = structuredClone(template);
  extraRoute.Resources.ExtraRoute = structuredClone(template.Resources.Route);
  extraRoute.Resources.ExtraRoute.Properties.RouteKey = "GET /extra";
  assert.throws(
    () => validateTemplate(extraRoute, templateConfig),
    /public|scoped/,
  );
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
    /public|\$default/,
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
    assert.throws(() => validateTemplate(weakRoute, templateConfig), /public/);
  }
  const wildcardIam = structuredClone(template);
  wildcardIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement[0].Resource =
    "*";
  assert.throws(
    () => validateTemplate(wildcardIam, templateConfig),
    /exact event table/,
  );
  const exactIndexIam = structuredClone(template);
  exactIndexIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement[0].Resource =
    [
      { "Fn::GetAtt": ["Table", "Arn"] },
      {
        "Fn::Join": [
          "",
          [{ "Fn::GetAtt": ["Table", "Arn"] }, "/index/opportunity-active-v1"],
        ],
      },
    ];
  assert.doesNotThrow(() => validateTemplate(exactIndexIam, templateConfig));
  const exactIndexOnlyIam = structuredClone(template);
  exactIndexOnlyIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement.push(
    {
      Effect: "Allow",
      Action: "dynamodb:Query",
      Resource: {
        "Fn::Join": [
          "",
          [{ "Fn::GetAtt": ["Table", "Arn"] }, "/index/opportunity-rank-v1"],
        ],
      },
    },
  );
  assert.doesNotThrow(() =>
    validateTemplate(exactIndexOnlyIam, templateConfig),
  );
  const indexOnlyWriteIam = structuredClone(template);
  indexOnlyWriteIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement.push(
    {
      Effect: "Allow",
      Action: "dynamodb:PutItem",
      Resource: {
        "Fn::Join": [
          "",
          [{ "Fn::GetAtt": ["Table", "Arn"] }, "/index/opportunity-rank-v1"],
        ],
      },
    },
  );
  assert.throws(
    () => validateTemplate(indexOnlyWriteIam, templateConfig),
    /index-only/,
  );
  const indexOnlySatisfiesTableIam = structuredClone(template);
  const apiActions =
    indexOnlySatisfiesTableIam.Resources.ApiPolicy.Properties.PolicyDocument
      .Statement[0].Action;
  apiActions.splice(apiActions.indexOf("dynamodb:Query"), 1);
  indexOnlySatisfiesTableIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement.push(
    structuredClone(
      exactIndexOnlyIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement.at(
        -1,
      ),
    ),
  );
  assert.throws(
    () => validateTemplate(indexOnlySatisfiesTableIam, templateConfig),
    /table-bound/,
  );
  const unsafeIndexIam = structuredClone(exactIndexIam);
  unsafeIndexIam.Resources.ApiPolicy.Properties.PolicyDocument.Statement[0].Resource[1][
    "Fn::Join"
  ][1][1] = "/index/../../other";
  assert.throws(
    () => validateTemplate(unsafeIndexIam, templateConfig),
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
    ].Properties.PolicyDocument.Statement[0].Action.push(
      "dynamodb:BatchWriteItem",
    );
    assert.throws(
      () => validateTemplate(extraAction, templateConfig),
      /exactly the required actions/,
    );
  }
  const broadDelete = structuredClone(template);
  delete broadDelete.Resources.SeedPolicy.Properties.PolicyDocument.Statement[1]
    .Condition;
  assert.throws(
    () => validateTemplate(broadDelete, templateConfig),
    /limited to reconciliation lock keys/,
  );
  const broadApiDelete = structuredClone(template);
  delete broadApiDelete.Resources.ApiPolicy.Properties.PolicyDocument
    .Statement[1].Condition;
  assert.throws(
    () => validateTemplate(broadApiDelete, templateConfig),
    /limited to watchlist partition keys/,
  );
  const broadApiUpdate = structuredClone(template);
  delete broadApiUpdate.Resources.ApiPolicy.Properties.PolicyDocument
    .Statement[2].Condition;
  assert.throws(
    () => validateTemplate(broadApiUpdate, templateConfig),
    /limited to identity partition keys/,
  );
  // The identity routes are the front door: an authorizer on them would lock
  // every new visitor out, so the pin refuses one.
  for (const mutation of [
    (route) => {
      route.Properties.AuthorizationType = "JWT";
      route.Properties.AuthorizerId = { Ref: "Auth" };
    },
    (route) => {
      route.Properties.AuthorizationScopes = ["events/events:read"];
    },
  ]) {
    const authorizedIdentity = structuredClone(template);
    mutation(authorizedIdentity.Resources.AuthOtpVerifyRoute);
    assert.throws(
      () => validateTemplate(authorizedIdentity, templateConfig),
      /Public reads must remain public/,
    );
  }
  for (const routeId of [
    "AuthOtpRequestRoute",
    "AuthOtpVerifyRoute",
    "AuthSessionRefreshRoute",
  ]) {
    const missingIdentityRoute = structuredClone(template);
    delete missingIdentityRoute.Resources[routeId];
    assert.throws(
      () => validateTemplate(missingIdentityRoute, templateConfig),
      /public|scoped/,
    );
  }
  for (const mutation of [
    (route) => {
      route.Properties.AuthorizationType = "NONE";
      delete route.Properties.AuthorizerId;
    },
    (route) => {
      route.Properties.AuthorizationScopes = ["events/events:read"];
    },
  ]) {
    const unscopedWatchlist = structuredClone(template);
    mutation(unscopedWatchlist.Resources.WatchlistRemoveRoute);
    assert.throws(
      () => validateTemplate(unscopedWatchlist, templateConfig),
      /Public reads must remain public/,
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
