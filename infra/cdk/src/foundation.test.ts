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
    template.resourceCountIs("AWS::Lambda::Function", 15);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          FTE_AWS_STAGE: "dev",
          FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
          FTE_EVENT_TABLE: Match.anyValue(),
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FTE_SHARP_API_ENABLED: "true",
          FTE_SHARP_API_SECRET_ID: Match.anyValue(),
          FTE_LIVE_ODDS_QUEUE_URL: Match.anyValue(),
        }),
      },
    });
    template.hasOutput("SharpApiSecretName", {});
    const sharpRendered = JSON.stringify(template.toJSON());
    expect(sharpRendered).toContain("sharpapi");
    expect(sharpRendered).toContain("sqs:ChangeMessageVisibility");
    expect(sharpRendered).toContain("dynamodb:DeleteItem");
    expect(sharpRendered).toContain("EVENT_RECONCILIATION#*");
    expect(sharpRendered).toContain("ODDS_CONTROL#CONTINUATION#*");
    const liveOddsPolicy = Object.entries(
      template.toJSON().Resources as Record<
        string,
        { Type: string; Properties?: Record<string, unknown> }
      >,
    ).find(
      ([key, value]) =>
        key.startsWith("LiveOddsIngestionServiceRoleDefaultPolicy") &&
        value.Type === "AWS::IAM::Policy",
    );
    const liveOddsPolicyText = JSON.stringify(liveOddsPolicy?.[1]);
    expect(liveOddsPolicyText).toContain("EVENT_RECONCILIATION#*");
    expect(liveOddsPolicyText).toContain("ODDS_CONTROL#CONTINUATION#*");
    expect(liveOddsPolicyText).not.toContain('"Action":"dynamodb:*"');
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:DeleteItem",
            Effect: "Allow",
            Condition: {
              "ForAllValues:StringLike": {
                "dynamodb:LeadingKeys": [
                  "EVENT_RECONCILIATION#*",
                  "ODDS_CONTROL#CONTINUATION#*",
                ],
              },
            },
          }),
        ]),
      },
    });
    expect(sharpRendered).not.toContain("sk_live_");
    template.hasOutput("FixtureOddsSeedFunctionName", {});
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "dynamodb:ConditionCheckItem",
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
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const resultLambda = Object.entries(resources).find(
      ([key, value]) =>
        key.startsWith("CompletedResultsWorker") &&
        value.Type === "AWS::Lambda::Function",
    );
    const resultRule = Object.entries(resources).find(
      ([key, value]) =>
        key.startsWith("CompletedResultsScheduler") &&
        value.Type === "AWS::Events::Rule",
    );
    const resultPolicy = Object.entries(resources).find(
      ([key, value]) =>
        key.startsWith("CompletedResultsWorkerServiceRoleDefaultPolicy") &&
        value.Type === "AWS::IAM::Policy",
    );
    expect(resultLambda?.[1].Properties?.["ReservedConcurrentExecutions"]).toBe(
      1,
    );
    expect(resultRule?.[1].Properties?.["State"]).toBe("DISABLED");
    expect(JSON.stringify(resultRule?.[1])).toContain(
      resultLambda?.[0] ?? "missing-lambda",
    );
    const resultPolicyText = JSON.stringify(resultPolicy?.[1]);
    expect(resultPolicyText).toContain("dynamodb:DeleteItem");
    expect(resultPolicyText).not.toContain("dynamodb:Scan");
    expect(resultPolicyText).not.toContain("secretsmanager");
    expect(rendered).toContain("dynamodb:TransactWriteItems");
    expect(rendered).toContain("PaperGradingFailuresAlarm");
    expect(rendered).toContain("PaperGradingUnresolvedAlarm");
    expect(rendered).toContain("PaperGradingRegradesAlarm");
    expect(rendered).not.toContain("dynamodb:Scan");
  });

  it("omits the fixture seed by default and rejects non-dev enablement", () => {
    const { stack } = createFoundationApp({ stage: "prod", ...eventConfig });
    Template.fromStack(stack).resourceCountIs("AWS::Lambda::Function", 14);
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
    template.resourceCountIs("AWS::SQS::Queue", 9);
    template.resourceCountIs("AWS::Lambda::Function", 14);
    template.resourceCountIs("AWS::Events::Rule", 6);
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 2);
    template.hasResourceProperties("AWS::Events::Rule", {
      State: "DISABLED",
      ScheduleExpression: "rate(5 minutes)",
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      State: "DISABLED",
      ScheduleExpression: "rate(5 minutes)",
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      State: "DISABLED",
      ScheduleExpression: "cron(0/15 * * * ? *)",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 2,
      Environment: {
        Variables: Match.objectLike({
          FTE_PAPER_PICK_ENABLED: "false",
          FTE_PAPER_PICK_MODEL_CAPABILITY: "disabled",
          FTE_PAPER_PICK_GENERATION_MINUTES: "15",
        }),
      },
    });
    const paperResources = JSON.stringify(template.toJSON());
    expect(paperResources).toContain("FindTheEdge/PaperPicks");
    expect(paperResources).toContain("QueuePaperPickWorkflowFailure");
    expect(paperResources).toContain("aws.states");
    expect(paperResources).not.toContain("replayCommand");
    expect(paperResources).not.toContain('"DeadLetterConfig"');
    expect(paperResources).not.toContain("dynamodb:Scan");
    for (const alarm of [
      "OddsCommandOutcomeAlarm",
      "OddsProviderHealthUnavailableAlarm",
      "OddsRateWindowBlockedAlarm",
      "OddsMarketSuspendedAlarm",
      "OddsPartialEvidenceAlarm",
      "OddsSplitFailureAlarm",
      "LiveOddsControlPlaneDlqAlarm",
    ])
      expect(paperResources).toContain(alarm);
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 1,
      Environment: { Variables: { FTE_EVENT_TABLE: Match.anyValue() } },
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 hour)",
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    });
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "opportunity-active-v1",
          KeySchema: [
            { AttributeName: "activePk", KeyType: "HASH" },
            { AttributeName: "activeSk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        }),
        Match.objectLike({
          IndexName: "opportunity-rank-v1",
          KeySchema: [
            { AttributeName: "rankPk", KeyType: "HASH" },
            { AttributeName: "rankSk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        }),
      ]),
    });
    expect(JSON.stringify(template.toJSON())).toContain(
      "OpportunityExpirationFailuresAlarm",
    );
    expect(JSON.stringify(template.toJSON())).toContain(
      "OpportunityStaleActiveAlarm",
    );
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "StaleActiveCount",
      Namespace: "FindTheEdge/OpportunityLifecycle",
      Dimensions: [
        { Name: "Cause", Value: "sweep" },
        { Name: "Outcome", Value: "transition" },
      ],
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 100,
      BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumRetryAttempts: 5,
      MaximumRecordAgeInSeconds: 86400,
      StartingPosition: "TRIM_HORIZON",
      FilterCriteria: {
        Filters: [
          {
            Pattern:
              '{"eventName":["INSERT"],"dynamodb":{"Keys":{"pk":{"S":[{"prefix":"FIXTURE_ODDS#"}]},"sk":{"S":[{"prefix":"SNAPSHOT#"}]}}}}',
          },
        ],
      },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      QueueName: "find-the-edge-test-odds-control.fifo",
      VisibilityTimeout: 360,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 2 },
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
    expect(rendered).toContain("FindTheEdge/OddsProjection");
    expect(rendered).toContain("FixtureOddsProjectionDlqAlarm");
    expect(rendered).toContain("FixtureOddsProjectionErrorsAlarm");
    expect(rendered).toContain("FixtureOddsProjectionFailuresAlarm");
    expect(rendered).toContain("dynamodb:GetRecords");
    expect(rendered).toContain("dynamodb:GetShardIterator");
    expect(rendered).toContain("FIXTURE_ODDS#");
    expect(rendered).toContain("SNAPSHOT#");
    expect(rendered).toContain("FixtureOddsProjectionFunctionName");
    expect(rendered).toContain("FixtureOddsProjectionDlqUrl");
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const projectionPolicy = Object.entries(resources).find(
      ([key, value]) =>
        key.startsWith("FixtureOddsProjectionServiceRoleDefaultPolicy") &&
        value.Type === "AWS::IAM::Policy",
    );
    const projectionPolicyText = JSON.stringify(projectionPolicy?.[1]);
    expect(projectionPolicyText).toContain('"Action":"dynamodb:PutItem"');
    expect(projectionPolicyText).toContain("dynamodb:GetRecords");
    expect(projectionPolicyText).toContain("dynamodb:GetShardIterator");
    expect(projectionPolicyText).toContain("dynamodb:DescribeStream");
    expect(projectionPolicyText).toContain("dynamodb:ListStreams");
    expect(projectionPolicyText).toContain("dynamodb:LeadingKeys");
    expect(projectionPolicyText).toContain("FIXTURE_ODDS#*");
    expect(projectionPolicyText).not.toContain("dynamodb:Scan");
    expect(projectionPolicyText).not.toContain("dynamodb:UpdateItem");
    const projectionStatements = (
      projectionPolicy?.[1].Properties?.["PolicyDocument"] as {
        Statement: Array<Record<string, unknown>>;
      }
    ).Statement;
    expect(
      projectionStatements.filter((statement) =>
        JSON.stringify(statement["Action"]).includes("dynamodb"),
      ),
    ).toEqual([
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["FIXTURE_ODDS#*"],
          },
        },
        Effect: "Allow",
        Resource: { "Fn::GetAtt": [expect.any(String), "Arn"] },
      },
      {
        Action: "dynamodb:ListStreams",
        Effect: "Allow",
        Resource: "*",
      },
      {
        Action: [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
        ],
        Effect: "Allow",
        Resource: { "Fn::GetAtt": [expect.any(String), "StreamArn"] },
      },
    ]);
    expect(rendered).toContain("FailedRecords");
    expect(rendered).toContain("FindTheEdge/EventApi");
    expect(rendered).toContain("GET /games");
    template.hasResourceProperties("AWS::CloudFront::Function", {
      AutoPublish: true,
      FunctionCode:
        "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/auth/callback' || request.uri === '/games' || request.uri.indexOf('/games/') === 0 || request.uri === '/splits' || request.uri === '/performance' || request.uri === '/data-sources' || request.uri.indexOf('/data-sources/') === 0 || request.uri === '/retrospectives' || request.uri.indexOf('/retrospectives/') === 0 || request.uri === '/experiments' || request.uri.indexOf('/experiments/') === 0 || request.uri.indexOf('/scout-jobs/') === 0) {\n    request.uri = '/index.html';\n  }\n  return request;\n}",
    });
    expect(rendered).not.toContain("CustomErrorResponses");
    template.hasResourceProperties("Custom::AWS", {
      Create: Match.anyValue(),
      Update: Match.anyValue(),
    });
    expect(rendered).toContain("ApiGatewayV2");
    expect(rendered).toContain("updateApi");
    expect(rendered).toContain("AllowOrigins");
    expect(rendered).toContain("ExposeHeaders");
    expect(rendered).toContain("location");
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /games",
      AuthorizationType: "NONE",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /providers/status",
      AuthorizationType: "NONE",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /games/{eventId}/odds-history",
      AuthorizationType: "NONE",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /events/{eventId}",
      AuthorizationType: "NONE",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /events",
      AuthorizationType: "JWT",
    });
    for (const routeKey of [
      "GET /sports/{sportKey}/opportunities",
      "GET /sports/{sportKey}/opportunities/{opportunityId}",
    ])
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "NONE",
      });
    expect(rendered).toContain(
      '\\"AllowHeaders\\":[\\"authorization\\",\\"content-type\\",\\"idempotency-key\\"]',
    );
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      },
    });
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
              "dynamodb:PutItem",
              "dynamodb:TransactGetItems",
              "dynamodb:TransactWriteItems",
            ],
            Effect: "Allow",
          }),
        ]),
      },
    });
    expect(rendered).toContain("Caught5xx");
    expect(rendered).toContain("opportunity-rank-v1");
    expect(rendered).toContain("OpportunityJoinFailure");
    expect(rendered).toContain("OpportunityStaleRead");
    expect(rendered).toContain("provider-status");
    expect(rendered).toContain("/data-sources");
    expect(rendered).toContain("/scout-jobs/");
    expect(rendered).toContain("/auth/callback");
    expect(rendered).toContain("RetrospectiveValidationFailures");
    expect(rendered).toContain("RetrospectiveReviewConflict");
    expect(rendered).toContain("RetrospectiveReviewForbidden");
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
      AllowedOAuthScopes: Match.anyValue(),
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthScopes: Match.anyValue(),
    });
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
    expect(rendered).toContain("ReviewerWebClient");
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
      GroupName: "fte-retrospective-reviewers",
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
      GroupName: "fte-strategy-promoters",
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      Identifier: "events",
      Scopes: [
        {
          ScopeName: "events:read",
          ScopeDescription: "Read FIND THE EDGE events and odds",
        },
        {
          ScopeName: "scouting:read",
          ScopeDescription: "Read owned FIND THE EDGE scouting jobs",
        },
        {
          ScopeName: "scouting:write",
          ScopeDescription: "Create and retry FIND THE EDGE scouting jobs",
        },
        {
          ScopeName: "retrospectives:approve",
          ScopeDescription: "Review non-executable retrospective candidates",
        },
        {
          ScopeName: "strategies:promote",
          ScopeDescription:
            "Approve, promote, and roll back deployed strategy artifacts",
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
    const responseHeaderPolicies = Object.values(resources).filter(
      (resource) => resource.Type === "AWS::CloudFront::ResponseHeadersPolicy",
    );
    expect(responseHeaderPolicies).toHaveLength(2);
    for (const policy of responseHeaderPolicies) {
      const policyText = JSON.stringify(policy.Properties);
      expect(policyText).toContain("ApiEndpoint");
      expect(policyText).toContain(".auth.");
      expect(policyText).toContain("AWS::Region");
      expect(policyText).toContain(".amazoncognito.com");
    }
    expect(rendered).not.toContain("https://*.");
    expect(rendered).toContain("ApiEndpoint");
    expect(rendered).toContain("; form-action 'none'; frame-ancestors 'none'");
    for (const output of [
      "WebOrigin",
      "WebDistributionId",
      "WebAssetsBucketName",
      "CognitoIssuer",
      "CognitoUserPoolId",
      "CognitoClientId",
      "CognitoDomain",
      "CognitoScope",
      "ScoutingReadScope",
      "ScoutingWriteScope",
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

  it("synthesizes the protected idempotent scouting dispatch workflow", () => {
    const { stack } = createFoundationApp({ stage: "test", ...eventConfig });
    const template = Template.fromStack(stack);
    const synthesized = template.toJSON();
    const resources = synthesized.Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const rendered = JSON.stringify(synthesized);

    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "find-the-edge-test-scouting-dispatch-dlq.fifo",
      FifoQueue: true,
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "find-the-edge-test-scouting-dispatch.fifo",
      FifoQueue: true,
      ContentBasedDeduplication: false,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 120,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "find-the-edge-test-scouting-outbox-publisher-dlq",
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 2,
      Environment: {
        Variables: {
          FTE_EVENT_TABLE: Match.anyValue(),
          FTE_SCOUTING_QUEUE_URL: Match.anyValue(),
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 5,
      Environment: {
        Variables: {
          FTE_SCOUTING_STATE_MACHINE_ARN: Match.anyValue(),
          FTE_EVENT_TABLE: Match.anyValue(),
        },
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 30,
      ReservedConcurrentExecutions: 5,
      Environment: {
        Variables: { FTE_EVENT_TABLE: Match.anyValue() },
      },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 25,
      BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      MaximumRetryAttempts: 5,
      MaximumRecordAgeInSeconds: 86400,
      DestinationConfig: {
        OnFailure: { Destination: Match.anyValue() },
      },
      StartingPosition: "TRIM_HORIZON",
      FilterCriteria: {
        Filters: [
          {
            Pattern:
              '{"eventName":["INSERT","MODIFY"],"dynamodb":{"Keys":{"pk":{"S":[{"prefix":"SCOUT_OUTBOX#"}]},"sk":{"S":["CURRENT"]}},"NewImage":{"entityType":{"S":["scouting-dispatch-outbox"]},"outboxStatus":{"S":["pending"]}}}}',
          },
        ],
      },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 5 },
    });

    const scoutingStateMachine = Object.entries(resources).find(
      ([key, resource]) =>
        key.startsWith("ScoutingWorkflow") &&
        resource.Type === "AWS::StepFunctions::StateMachine",
    );
    expect(scoutingStateMachine).toBeDefined();
    expect(scoutingStateMachine?.[1].Properties?.["StateMachineType"]).toBe(
      "STANDARD",
    );
    expect(
      scoutingStateMachine?.[1].Properties?.["LoggingConfiguration"],
    ).toEqual(
      expect.objectContaining({ IncludeExecutionData: false, Level: "ERROR" }),
    );
    const workflowDefinition = JSON.stringify(
      scoutingStateMachine?.[1].Properties?.["DefinitionString"],
    );
    expect(workflowDefinition).toContain("TimeoutSeconds");
    expect(workflowDefinition).toContain("300");
    expect(workflowDefinition).toContain("Retry");
    const mainTaskDefinition = workflowDefinition.slice(
      workflowDefinition.indexOf("InvokeScoutingWorkflowWorker"),
      workflowDefinition.indexOf(
        "ScoutingWorkflowSucceeded",
        workflowDefinition.indexOf("InvokeScoutingWorkflowWorker"),
      ),
    );
    expect(mainTaskDefinition).not.toContain("Retry");
    expect(workflowDefinition).toContain("Catch");
    expect(workflowDefinition).toContain("States.ALL");
    expect(workflowDefinition).toContain("FinalizeScoutingWorkflowFailure");
    expect(workflowDefinition).toContain("FinalizeScoutingWorkflowTimeout");
    expect(workflowDefinition).toContain("finalize-failure");
    expect(workflowDefinition).toContain("workflow-temporarily-unavailable");
    expect(workflowDefinition).toContain("workflow-timeout");
    expect(workflowDefinition).toContain("$.jobId");
    expect(workflowDefinition).toContain("$.attemptId");

    for (const [routeKey, scope] of [
      ["POST /events/{eventId}/scout", "events/scouting:write"],
      ["GET /scout-jobs/{jobId}", "events/scouting:read"],
      ["POST /scout-jobs/{jobId}/retry", "events/scouting:write"],
    ]) {
      const matches = Object.values(resources).filter(
        (resource) =>
          resource.Type === "AWS::ApiGatewayV2::Route" &&
          resource.Properties?.["RouteKey"] === routeKey,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.Properties).toEqual(
        expect.objectContaining({
          AuthorizationType: "JWT",
          AuthorizationScopes: [scope],
        }),
      );
    }
    expect(rendered).toContain("scouting:read");
    expect(rendered).toContain("scouting:write");
    const oauthClients = Object.values(resources).filter(
      (resource) => resource.Type === "AWS::Cognito::UserPoolClient",
    );
    expect(oauthClients).toHaveLength(2);
    const scoutingClient = oauthClients.find((client) =>
      JSON.stringify(client.Properties?.["AllowedOAuthScopes"]).includes(
        "scouting:write",
      ),
    );
    const allowedScopes = scoutingClient?.Properties?.["AllowedOAuthScopes"];
    const scopes = JSON.stringify(allowedScopes);
    expect(allowedScopes).toHaveLength(3);
    expect(scopes).not.toContain("openid");
    expect(scopes).not.toContain("email");
    expect(scopes).toContain("scouting:read");
    expect(scopes).toContain("scouting:write");
    expect(rendered).toContain("states:StartExecution");
    expect(rendered).toContain("states:DescribeExecution");
    expect(rendered).toContain("sqs:SendMessage");
    const outboxPolicy = Object.entries(resources).find(
      ([key, resource]) =>
        key.startsWith("ScoutingOutboxPublisherServiceRoleDefaultPolicy") &&
        resource.Type === "AWS::IAM::Policy",
    );
    expect(JSON.stringify(outboxPolicy?.[1])).toContain(
      '"Action":["dynamodb:GetItem","dynamodb:UpdateItem"]',
    );
    expect(JSON.stringify(outboxPolicy?.[1])).toContain("SCOUT_OUTBOX#*");
    const dispatcherPolicy = Object.entries(resources).find(
      ([key, resource]) =>
        key.startsWith("ScoutingDispatcherServiceRoleDefaultPolicy") &&
        resource.Type === "AWS::IAM::Policy",
    );
    expect(JSON.stringify(dispatcherPolicy?.[1])).toContain(
      '"Action":["dynamodb:GetItem","dynamodb:TransactWriteItems"]',
    );
    for (const leadingKey of [
      "EVENT_DETAIL#*",
      "SCOUT_JOB#*",
      "SCOUT_ATTEMPT#*",
      "SCOUT_ACTIVE#*",
    ])
      expect(JSON.stringify(dispatcherPolicy?.[1])).toContain(leadingKey);
    const workflowWorkerPolicy = Object.entries(resources).find(
      ([key, resource]) =>
        key.startsWith("ScoutingWorkflowWorkerServiceRoleDefaultPolicy") &&
        resource.Type === "AWS::IAM::Policy",
    );
    expect(JSON.stringify(workflowWorkerPolicy?.[1])).toContain(
      '"Action":["dynamodb:GetItem","dynamodb:TransactWriteItems"]',
    );
    for (const leadingKey of [
      "EVENT_DETAIL#*",
      "SCOUT_JOB#*",
      "SCOUT_ATTEMPT#*",
      "SCOUT_ACTIVE#*",
    ])
      expect(JSON.stringify(workflowWorkerPolicy?.[1])).toContain(leadingKey);
    expect(rendered).not.toContain("dynamodb:Scan");
    for (const [key, resource] of Object.entries(resources)) {
      if (!key.startsWith("Scouting") || resource.Type !== "AWS::IAM::Policy")
        continue;
      const actions = JSON.stringify(resource.Properties?.["PolicyDocument"]);
      expect(actions).not.toMatch(/"Action":"[^"]*\*/);
      expect(actions).not.toMatch(/"Action":\[[^\]]*"[^"]*\*/);
    }
    for (const alarm of [
      "ScoutingOutboxPublisherErrorsAlarm",
      "ScoutingOutboxFailuresAlarm",
      "ScoutingOutboxPublisherDlqAlarm",
      "ScoutingOutboxIteratorAgeAlarm",
      "ScoutingOutboxLagAlarm",
      "ScoutingDispatcherErrorsAlarm",
      "ScoutingDispatchFailuresAlarm",
      "ScoutingWorkflowWorkerErrorsAlarm",
      "ScoutingDispatchDlqAlarm",
      "ScoutingDispatchOldestMessageAlarm",
      "ScoutingWorkflowFailuresAlarm",
      "ScoutingWorkflowTimeoutsAlarm",
    ])
      expect(rendered).toContain(alarm);
    for (const route of ["scout-create", "scout-status", "scout-retry"])
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        MetricName: "Caught5xx",
        Namespace: "FindTheEdge/EventApi",
        Dimensions: [{ Name: "Route", Value: route }],
      });
    for (const output of [
      "ScoutingDispatchQueueUrl",
      "ScoutingDispatchDlqUrl",
      "ScoutingOutboxPublisherDlqUrl",
      "ScoutingWorkflowArn",
      "ScoutingOutboxPublisherFunctionName",
      "ScoutingDispatcherFunctionName",
      "ScoutingWorkflowWorkerFunctionName",
      "ScoutingReadScope",
      "ScoutingWriteScope",
    ])
      template.hasOutput(output, {});
  });

  it("keeps both opportunity GSIs in the final template with index-scoped consumers", () => {
    const { stack } = createFoundationApp({
      stage: "gsi-contract",
      ...eventConfig,
    });
    const rendered = Template.fromStack(stack).toJSON();
    const resources = rendered.Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const table = Object.values(resources).find(
      (resource) => resource.Type === "AWS::DynamoDB::Table",
    );
    const indexes = table?.Properties?.["GlobalSecondaryIndexes"] as
      { IndexName: string }[] | undefined;
    expect(indexes?.map(({ IndexName }) => IndexName).sort()).toEqual([
      "opportunity-active-v1",
      "opportunity-rank-v1",
    ]);
    const statements = Object.values(resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy")
      .flatMap((resource) => {
        const policy = resource.Properties?.["PolicyDocument"] as
          | {
              Statement?: {
                Action?: string | string[];
                Resource?: unknown;
              }[];
            }
          | undefined;
        return policy?.Statement ?? [];
      });
    for (const indexName of ["opportunity-active-v1", "opportunity-rank-v1"]) {
      const consumers = statements.filter((statement) =>
        JSON.stringify(statement.Resource).includes(`"/index/${indexName}"`),
      );
      expect(consumers.length).toBeGreaterThan(0);
      expect(
        consumers.every((statement) =>
          (Array.isArray(statement.Action)
            ? statement.Action
            : [statement.Action]
          ).includes("dynamodb:Query"),
        ),
      ).toBe(true);
      expect(
        consumers.every(
          (statement) =>
            !JSON.stringify(statement.Action).includes("dynamodb:*"),
        ),
      ).toBe(true);
    }
    for (const output of [
      "EventsApiEndpoint",
      "WebOrigin",
      "LiveOddsIngestionFunctionName",
    ])
      expect(rendered.Outputs).toHaveProperty(output);
  });

  it("rejects unsafe stage names", () => {
    expect(() =>
      createFoundationApp({ stage: "Production!", ...eventConfig }),
    ).toThrow("FTE_AWS_STAGE");
  });

  it("binds one validated generation cadence into the rule and command", () => {
    const { stack } = createFoundationApp({
      stage: "cadence",
      ...eventConfig,
      paperPickGenerationMinutes: 20,
    });
    const template = Template.fromStack(stack).toJSON();
    const rendered = JSON.stringify(template);
    expect(rendered).toContain("cron(0/20 * * * ? *)");
    const paperRule = Object.values(
      template.Resources as Record<
        string,
        {
          Type: string;
          Properties?: {
            ScheduleExpression?: string;
            Targets?: { InputTransformer?: { InputTemplate?: string } }[];
          };
        }
      >,
    ).find(
      (resource) =>
        resource.Type === "AWS::Events::Rule" &&
        resource.Properties?.ScheduleExpression === "cron(0/20 * * * ? *)",
    );
    expect(
      paperRule?.Properties?.Targets?.[0]?.InputTransformer?.InputTemplate,
    ).toContain('"generationMinutes":20');
    expect(rendered).toContain('"FTE_PAPER_PICK_GENERATION_MINUTES":"20"');
    expect(() =>
      createFoundationApp({
        stage: "bad-cadence",
        ...eventConfig,
        paperPickGenerationMinutes: 17,
      }),
    ).toThrow("positive divisor of 60");
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
    template.resourceCountIs("AWS::CloudWatch::Alarm", 76);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmActions: ["arn:aws:sns:us-east-1:123456789012:fte-alerts"],
    });
    expect(JSON.stringify(template.toJSON())).toContain(
      "FindTheEdge/OddsControlPlane",
    );
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
