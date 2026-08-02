import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { createFoundationApp } from "./foundation";

const eventConfig = {
  jwtIssuer: "https://issuer.example.com",
  jwtAudience: "find-the-edge",
  cursorSecretArn:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:event-cursor",
  webOrigin: "https://app.example.com",
};

describe("foundation CDK app", () => {
  it("creates the fixture seed only for explicitly enabled dev", () => {
    const { stack } = createFoundationApp({
      stage: "dev",
      fixtureOddsSeedEnabled: true,
      ...eventConfig,
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Function", 5);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          FTE_AWS_STAGE: "dev",
          FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
          FTE_EVENT_TABLE: Match.anyValue(),
        },
      },
    });
    template.hasOutput("FixtureOddsSeedFunctionName", {});
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "dynamodb:GetItem",
              "dynamodb:Query",
              "dynamodb:PutItem",
              "dynamodb:TransactWriteItems",
            ],
            Effect: "Allow",
          }),
        ]),
      },
    });
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).toContain("dynamodb:TransactWriteItems");
    expect(rendered).not.toContain("dynamodb:Scan");
  });

  it("omits the fixture seed by default and rejects non-dev enablement", () => {
    const { stack } = createFoundationApp({ stage: "prod", ...eventConfig });
    Template.fromStack(stack).resourceCountIs("AWS::Lambda::Function", 4);
    expect(() =>
      createFoundationApp({
        stage: "prod",
        fixtureOddsSeedEnabled: true,
        ...eventConfig,
      }),
    ).toThrow("only be enabled for the dev stage");
  });

  it("synthesizes the full durable ingestion contract", () => {
    const { stack } = createFoundationApp({ stage: "test", ...eventConfig });
    const template = Template.fromStack(stack);

    expect(stack.stackName).toBe("FindTheEdge-test-Foundation");
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::SQS::Queue", 2);
    template.resourceCountIs("AWS::Lambda::Function", 4);
    template.resourceCountIs("AWS::Events::Rule", 1);
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
      VisibilityTimeout: 180,
      FifoQueue: true,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 60,
      Environment: {
        Variables: {
          FTE_EVENT_TABLE: Match.anyValue(),
          FTE_UPCOMING_QUEUE_URL: Match.anyValue(),
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 30,
      Environment: {
        Variables: { FTE_UPCOMING_QUEUE_URL: Match.anyValue() },
      },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      State: "DISABLED",
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.anyValue(),
        }),
      ]),
    });
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).toContain("dynamodb:TransactWriteItems");
    expect(rendered).toContain("sqs:ReceiveMessage");
    expect(rendered).toContain("sqs:SendMessage");
    expect(rendered).toContain("FindTheEdge/UpcomingEvents");
    expect(rendered).toContain("FailedRecords");
    expect(rendered).toContain("FindTheEdge/EventApi");
    expect(rendered).toContain("GET /games");
    template.hasResourceProperties("AWS::CloudFront::Function", {
      AutoPublish: true,
      FunctionCode:
        "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/games' || request.uri === '/auth/callback') {\n    request.uri = '/index.html';\n  }\n  return request;\n}",
    });
    expect(rendered).not.toContain("CustomErrorResponses");
    template.hasResourceProperties("Custom::AWS", {
      Create: Match.anyValue(),
      Update: Match.anyValue(),
    });
    expect(rendered).toContain("ApiGatewayV2");
    expect(rendered).toContain("updateApi");
    expect(rendered).toContain("AllowOrigins");
    expect(rendered).toContain("authorization");
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "apigateway:PATCH",
            Effect: "Allow",
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "dynamodb:GetItem",
              "dynamodb:BatchGetItem",
              "dynamodb:Query",
              "dynamodb:TransactGetItems",
            ],
            Effect: "Allow",
          }),
        ]),
      },
    });
    expect(rendered).toContain("Caught5xx");
    expect(rendered).not.toContain("dynamodb:Scan");
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "test",
      AutoDeploy: true,
      AccessLogSettings: Match.objectLike({
        Format: Match.stringLikeRegexp("requestId.*routeKey.*status"),
      }),
    });
    template.hasOutput("EventsApiEndpoint", {});
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      Policies: {
        PasswordPolicy: {
          MinimumLength: 14,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          RequireUppercase: true,
          TemporaryPasswordValidityDays: 1,
        },
      },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      GenerateSecret: false,
      CallbackURLs: [Match.anyValue()],
      LogoutURLs: [Match.anyValue()],
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      Identifier: "events",
      Scopes: [
        {
          ScopeName: "events:read",
          ScopeDescription: "Read FIND THE EDGE events and odds",
        },
      ],
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: Match.anyValue(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({
          Compress: true,
          ViewerProtocolPolicy: "redirect-to-https",
        }),
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.anyValue(),
            Override: true,
          },
        }),
      },
    });
    expect(rendered).not.toContain("https://*.");
    expect(rendered).toContain("ApiEndpoint");
    expect(rendered).toContain("amazoncognito.com; form-action");
    for (const output of [
      "WebOrigin",
      "WebDistributionId",
      "WebAssetsBucketName",
      "CognitoIssuer",
      "CognitoUserPoolId",
      "CognitoClientId",
      "CognitoDomain",
      "CognitoScope",
      "CognitoCallbackUrl",
    ])
      template.hasOutput(output, {});
    expect(rendered).toContain("events/events:read");
    template.hasResource("AWS::Logs::LogGroup", { DeletionPolicy: "Retain" });
    expect(rendered).not.toContain('"Action":"sqs:*"');
    expect(rendered).not.toContain('"Action":"dynamodb:*"');
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "sqs:SendMessage",
              "sqs:GetQueueAttributes",
              "sqs:GetQueueUrl",
            ],
            Effect: "Allow",
          }),
        ]),
      },
    });
    expect(rendered).not.toContain("2026-08-01T00:00:00.000Z");
  });

  it("rejects unsafe stage names", () => {
    expect(() =>
      createFoundationApp({ stage: "Production!", ...eventConfig }),
    ).toThrow("FTE_AWS_STAGE");
  });

  it("rejects wildcard and non-local HTTP web origins", () => {
    expect(() =>
      createFoundationApp({
        stage: "dev",
        ...eventConfig,
        webOrigin: "*",
      }),
    ).toThrow("FTE_WEB_ORIGIN");
    expect(() =>
      createFoundationApp({
        stage: "dev",
        ...eventConfig,
        webOrigin: "http://app.example.com",
      }),
    ).toThrow("FTE_WEB_ORIGIN");
  });

  it("enables scheduling only by config and wires configured SNS alarm actions", () => {
    const { stack } = createFoundationApp({
      stage: "alerts",
      ...eventConfig,
      schedulerEnabled: true,
      alarmTopicArn: "arn:aws:sns:us-east-1:123456789012:fte-alerts",
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Events::Rule", { State: "ENABLED" });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmActions: ["arn:aws:sns:us-east-1:123456789012:fte-alerts"],
    });
  });

  it("rejects an alarm topic outside the configured stack region", () => {
    expect(() =>
      createFoundationApp({
        stage: "alerts",
        ...eventConfig,
        region: "us-east-1",
        alarmTopicArn: "arn:aws:sns:us-west-2:123456789012:fte-alerts",
      }),
    ).toThrow("stack region");
  });
});
