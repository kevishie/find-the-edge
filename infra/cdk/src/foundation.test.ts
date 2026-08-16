import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { createFoundationApp } from "./foundation";

const eventConfig = {
  jwtIssuer: "https://issuer.example.com",
  jwtAudience: "find-the-edge",
  cursorSecretArn:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:event-cursor",
  webOrigin: "https://app.example.com",
  productAccessEnforced: false,
};

const expectProviderLandingSchedule = (
  template: Template,
  state: "ENABLED" | "DISABLED",
) => {
  const schedules = template.findResources("AWS::Events::Rule");
  const providerLanding = Object.entries(schedules).find(([logicalId]) =>
    logicalId.includes("ProviderLandingSchedule"),
  );
  expect(providerLanding?.[1]).toMatchObject({
    Properties: {
      State: state,
      ScheduleExpression: "rate(1 minute)",
      Targets: [
        {
          RetryPolicy: {
            MaximumEventAgeInSeconds: 3_600,
          },
        },
      ],
    },
  });
};

const expectCriticalAlarmBudget = (
  template: Template,
  expected: readonly {
    alarmId: string;
    resourceId: string;
    dimension: "FunctionName" | "QueueName";
  }[],
) => {
  const resources = template.toJSON().Resources as Record<
    string,
    { Type: string; Properties?: Record<string, unknown> }
  >;
  const alarms = template.findResources("AWS::CloudWatch::Alarm") as Record<
    string,
    { Properties: Record<string, unknown> }
  >;
  expect(Object.keys(alarms)).toHaveLength(4);
  for (const binding of expected) {
    const alarm = Object.entries(alarms).find(([id]) =>
      id.startsWith(binding.alarmId),
    )?.[1];
    const resourceId = Object.keys(resources).find(
      (id) =>
        id.startsWith(binding.resourceId) &&
        resources[id]?.Type ===
          (binding.dimension === "FunctionName"
            ? "AWS::Lambda::Function"
            : "AWS::SQS::Queue"),
    );
    expect(alarm).toBeDefined();
    expect(resourceId).toBeDefined();
    expect(JSON.stringify(alarm?.Properties["Dimensions"])).toContain(
      resourceId,
    );
    expect(alarm?.Properties["Dimensions"]).toContainEqual(
      expect.objectContaining({ Name: binding.dimension }),
    );
  }
  for (const alarm of Object.values(alarms)) {
    const properties = alarm.Properties;
    expect(properties).toMatchObject({
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      DatapointsToAlarm: 2,
      EvaluationPeriods: 3,
      Period: 300,
      Threshold: 1,
      TreatMissingData: "notBreaching",
    });
    expect(["AWS/Lambda", "AWS/SQS"]).toContain(properties["Namespace"]);
    expect(["Errors", "ApproximateNumberOfMessagesVisible"]).toContain(
      properties["MetricName"],
    );
    expect(properties).not.toHaveProperty("Metrics");
    expect(properties).not.toHaveProperty("OKActions");
    expect(properties["AlarmActions"]).toHaveLength(1);
  }
};

describe("foundation CDK app", () => {
  it.each(["staging", "prod"])(
    "scopes %s secrets and release provenance",
    (stage) => {
      const { stack } = createFoundationApp({
        stage,
        releaseSha: "0123456789abcdef0123456789abcdef01234567",
        ...eventConfig,
      });
      const template = Template.fromStack(stack);
      template.hasOutput("DeploymentStage", { Value: stage });
      template.hasOutput("ReleaseSha", {
        Value: "0123456789abcdef0123456789abcdef01234567",
      });
      template.hasOutput("SharpApiSecretName", {
        Value: `find-the-edge/${stage}/sharpapi`,
      });
    },
  );

  it.each([
    ["staging", "staging.kevishie.com", "api-staging.kevishie.com"],
    ["prod", "kevishie.com", "api.kevishie.com"],
  ])("binds %s to exact custom web and API domains", (stage, web, api) => {
    const { stack } = createFoundationApp({
      stage,
      webDomainName: web,
      apiDomainName: api,
      webCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-4111-8111-111111111111",
      apiCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/22222222-2222-4222-8222-222222222222",
      account: "123456789012",
      region: "us-east-1",
      ...eventConfig,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ Aliases: [web] }),
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: api,
      DomainNameConfigurations: [
        Match.objectLike({
          EndpointType: "REGIONAL",
          SecurityPolicy: "TLS_1_2",
        }),
      ],
    });
    template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    template.hasOutput("WebOrigin", { Value: `https://${web}` });
    template.hasOutput("EventsApiEndpoint", { Value: `https://${api}` });
    template.hasOutput("ApiDnsTarget", {});
    template.hasOutput("ApiDnsHostedZoneId", {});
    template.hasOutput("WebDnsTarget", {});
  });

  it("rejects partial, unsafe, or cross-region custom-domain configuration", () => {
    const base = { stage: "staging", ...eventConfig };
    expect(() =>
      createFoundationApp({ ...base, webDomainName: "staging.kevishie.com" }),
    ).toThrow(/custom domain/i);
    expect(() =>
      createFoundationApp({
        ...base,
        webDomainName: "https://staging.kevishie.com",
        apiDomainName: "api-staging.kevishie.com",
        webCertificateArn:
          "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-4111-8111-111111111111",
        apiCertificateArn:
          "arn:aws:acm:us-east-1:123456789012:certificate/22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow(/domain/i);
    expect(() =>
      createFoundationApp({
        ...base,
        webDomainName: "staging.kevishie.com",
        apiDomainName: "api-staging.kevishie.com",
        webCertificateArn:
          "arn:aws:acm:us-west-2:123456789012:certificate/11111111-1111-4111-8111-111111111111",
        apiCertificateArn:
          "arn:aws:acm:us-east-1:123456789012:certificate/22222222-2222-4222-8222-222222222222",
        region: "us-east-1",
      }),
    ).toThrow(/us-east-1/i);
  });

  it("caps critical monitoring at eight standard alarm metrics across deployed stacks", () => {
    const staging = Template.fromStack(
      createFoundationApp({
        stage: "staging",
        criticalAlarmEmail: "alerts@example.com",
        ...eventConfig,
      }).stack,
    );
    expectCriticalAlarmBudget(staging, [
      {
        alarmId: "LiveOddsIngestionErrorsAlarm",
        resourceId: "LiveOddsIngestion",
        dimension: "FunctionName",
      },
      {
        alarmId: "LiveOddsControlPlaneDlqAlarm",
        resourceId: "LiveOddsControlPlaneDlq",
        dimension: "QueueName",
      },
      {
        alarmId: "ProviderLandingErrorsAlarm",
        resourceId: "ProviderLanding",
        dimension: "FunctionName",
      },
      {
        alarmId: "ProviderLandingDlqAlarm",
        resourceId: "ProviderLandingDlq",
        dimension: "QueueName",
      },
    ]);
    const production = Template.fromStack(
      createFoundationApp({
        stage: "prod",
        criticalAlarmEmail: "alerts@example.com",
        ...eventConfig,
      }).stack,
    );
    expectCriticalAlarmBudget(production, [
      {
        alarmId: "LiveOddsIngestionErrorsAlarm",
        resourceId: "LiveOddsIngestion",
        dimension: "FunctionName",
      },
      {
        alarmId: "LiveOddsControlPlaneDlqAlarm",
        resourceId: "LiveOddsControlPlaneDlq",
        dimension: "QueueName",
      },
      {
        alarmId: "UpcomingEventsWorkerErrorsAlarm",
        resourceId: "UpcomingEventsWorker",
        dimension: "FunctionName",
      },
      {
        alarmId: "UpcomingEventsDlqAlarm",
        resourceId: "UpcomingEventsDlq",
        dimension: "QueueName",
      },
    ]);
    staging.resourceCountIs("AWS::Logs::LogGroup", 0);
    production.resourceCountIs("AWS::Logs::LogGroup", 0);
    staging.resourceCountIs("AWS::SNS::Topic", 1);
    production.resourceCountIs("AWS::SNS::Topic", 1);
  });

  it("keeps non-deployed stages and unconfigured notifications alarm-free", () => {
    const otherStage = Template.fromStack(
      createFoundationApp({ stage: "test", ...eventConfig }).stack,
    );
    otherStage.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    otherStage.resourceCountIs("AWS::SNS::Topic", 0);
    expect(() =>
      createFoundationApp({
        stage: "staging",
        criticalAlarmEmail: "not-an-email",
        ...eventConfig,
      }),
    ).toThrow("FTE_CRITICAL_ALARM_EMAIL");
  });

  it("creates the fixture seed only for explicitly enabled dev", () => {
    const { stack } = createFoundationApp({
      stage: "dev",
      fixtureOddsSeedEnabled: true,
      ...eventConfig,
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Function", 17);
    // The request-path API is CPU-bound, and Lambda scales CPU with memory.
    // Starving it shows up directly as page load time.
    template.hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: Match.exact(1024),
      Environment: {
        Variables: Match.objectLike({
          FTE_EVENT_TABLE_NAME: Match.anyValue(),
          FTE_EVENT_CURSOR_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: 1024,
      Timeout: 840,
      ReservedConcurrentExecutions: 1,
      Environment: {
        Variables: Match.objectLike({
          FTE_AWS_STAGE: "dev",
          FTE_EVENT_TABLE: Match.anyValue(),
          FTE_SHARP_API_SECRET_ID: Match.anyValue(),
        }),
      },
    });
    expectProviderLandingSchedule(template, "DISABLED");
    template.hasOutput("ProviderLandingFunctionName", {});
    template.hasOutput("ProviderLandingDlqUrl", {});
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
          // The fast-lane budget must stay below the one-minute tick so the
          // FIFO group never delays the next tick.
          FTE_FAST_LANE_BUDGET_MS: "50000",
          FTE_FAST_LANE_PAUSE_MS: "10000",
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
    expect(sharpRendered).toContain("dynamodb:BatchWriteItem");
    expect(sharpRendered).toContain("dynamodb:BatchGetItem");
    expect(sharpRendered).toContain("PROVIDER_LANDING#SHARPAPI#*");
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
            ],
            Effect: "Allow",
            Condition: {
              "ForAllValues:StringEquals": {
                "dynamodb:LeadingKeys": [
                  "ODDS_CONTROL#HEALTH#sharpapi:account:account",
                ],
              },
            },
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumEventAgeInSeconds: 3600,
      MaximumRetryAttempts: 2,
      DestinationConfig: {
        OnFailure: { Destination: Match.anyValue() },
      },
    });
    const liveOddsPolicy = Object.entries(
      template.toJSON().Resources as Record<
        string,
        { Type: string; Properties?: Record<string, unknown> }
      >,
    ).find(
      ([, value]) =>
        value.Type === "AWS::IAM::Policy" &&
        JSON.stringify(value).includes("EVENT_RECONCILIATION#*"),
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
        key.startsWith("CompletedResultsWorkerRoleDefaultPolicy") &&
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
    expect(rendered).not.toContain("dynamodb:Scan");
  });

  it("omits the fixture seed by default and rejects non-dev enablement", () => {
    const { stack } = createFoundationApp({ stage: "prod", ...eventConfig });
    Template.fromStack(stack).resourceCountIs("AWS::Lambda::Function", 16);
    expect(() =>
      createFoundationApp({
        stage: "prod",
        fixtureOddsSeedEnabled: true,
        ...eventConfig,
      }),
    ).toThrow("only be enabled for the dev stage");
  });

  it("carries the explicit product-access setting into the Event API", () => {
    const { stack } = createFoundationApp({
      stage: "test",
      ...eventConfig,
      productAccessEnforced: true,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FTE_PRODUCT_ACCESS_ENFORCED: "true",
        }),
      },
    });
    expect(() =>
      createFoundationApp({
        stage: "test",
        ...eventConfig,
        productAccessEnforced: "false" as unknown as boolean,
      }),
    ).toThrow(/explicit boolean/i);
  });

  it("synthesizes the full durable ingestion contract", () => {
    const { stack } = createFoundationApp({ stage: "test", ...eventConfig });
    const template = Template.fromStack(stack);

    expect(stack.stackName).toBe("FindTheEdge-test-Foundation");
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::SQS::Queue", 10);
    template.resourceCountIs("AWS::Lambda::Function", 16);
    template.resourceCountIs("AWS::Events::Rule", 8);
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 2);
    // Live odds tick every minute; opportunity expiration keeps five.
    expectProviderLandingSchedule(template, "DISABLED");
    template.hasResourceProperties("AWS::Events::Rule", {
      State: "DISABLED",
      ScheduleExpression: "rate(5 minutes)",
    });
    expectProviderLandingSchedule(template, "DISABLED");
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
    expect(paperResources).toContain("QueuePaperPickWorkflowFailure");
    expect(paperResources).toContain("aws.states");
    expect(paperResources).not.toContain("replayCommand");
    expect(paperResources).toContain('"DeadLetterConfig"');
    expect(paperResources).toContain("ProviderLandingDlq");
    expect(paperResources).not.toContain("dynamodb:Scan");
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
      ([, value]) =>
        value.Type === "AWS::IAM::Policy" &&
        JSON.stringify(value).includes("FIXTURE_ODDS#*"),
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
    expect(rendered).toContain("GET /games");
    template.hasResourceProperties("AWS::CloudFront::Function", {
      AutoPublish: true,
      FunctionCode:
        "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/auth/callback' || request.uri === '/login' || request.uri === '/subscribe' || request.uri === '/sign-in' || request.uri === '/privacy' || request.uri === '/terms' || request.uri === '/events' || request.uri.indexOf('/events/') === 0 || request.uri === '/games' || request.uri.indexOf('/games/') === 0 || request.uri === '/splits' || request.uri === '/watchlist' || request.uri === '/dashboard' || request.uri === '/performance' || request.uri === '/data-sources' || request.uri.indexOf('/data-sources/') === 0 || request.uri === '/retrospectives' || request.uri.indexOf('/retrospectives/') === 0 || request.uri === '/experiments' || request.uri.indexOf('/experiments/') === 0 || request.uri.indexOf('/scout-jobs/') === 0) {\n    request.uri = '/index.html';\n  }\n  return request;\n}",
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
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 0);
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
    for (const routeKey of [
      "GET /sports/{sportKey}/opportunities",
      "GET /sports/{sportKey}/opportunities/{opportunityId}",
    ])
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "NONE",
      });
    // These ten ordinary routes authenticate the owned fte1 session inside
    // Lambda. None may be partially left on the Cognito authorizer.
    for (const routeKey of [
      "GET /events",
      "POST /events/{eventId}/scout",
      "GET /scout-jobs/{jobId}",
      "POST /scout-jobs/{jobId}/retry",
      "GET /scout-jobs/{jobId}/report",
      "GET /scout-reports/{reportId}/versions",
      "GET /scout-reports/{reportId}/versions/{versionNumber}",
      "GET /watchlist",
      "POST /watchlist",
      "DELETE /watchlist/{eventId}",
    ]) {
      const matches = Object.values(resources).filter(
        (resource) =>
          resource.Type === "AWS::ApiGatewayV2::Route" &&
          resource.Properties?.["RouteKey"] === routeKey,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.Properties).toEqual(
        expect.objectContaining({ AuthorizationType: "NONE" }),
      );
      expect(matches[0]?.Properties?.["AuthorizerId"]).toBeUndefined();
      expect(matches[0]?.Properties?.["AuthorizationScopes"]).toBeUndefined();
    }
    // The identity routes are how a caller obtains a token, so they carry no
    // authorizer at all. FTE-074 retires the Cognito one; until then the two
    // schemes coexist and this assertion keeps them apart.
    // Billing joins them: the webhook proves itself with a Stripe signature
    // over the raw body, and the rest verify our own token in the handler.
    for (const routeKey of [
      "POST /auth/otp/request",
      "POST /auth/otp/verify",
      "POST /auth/session/refresh",
      "GET /auth/session/capabilities",
      "POST /billing/webhook",
      "GET /billing/entitlement",
      "POST /billing/checkout",
      "POST /billing/portal",
    ]) {
      const matches = Object.values(resources).filter(
        (resource) =>
          resource.Type === "AWS::ApiGatewayV2::Route" &&
          resource.Properties?.["RouteKey"] === routeKey,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.Properties).toEqual(
        expect.objectContaining({ AuthorizationType: "NONE" }),
      );
      expect(matches[0]?.Properties?.["AuthorizerId"]).toBeUndefined();
      expect(matches[0]?.Properties?.["AuthorizationScopes"]).toBeUndefined();
    }
    // These are the final four Cognito-authorized methods to move behind the
    // Lambda's verified owned-session and server-role boundary. The Cognito
    // pool, clients, groups, scopes, domain, and outputs remain for rollback.
    for (const routeKey of [
      "POST /retrospectives/{eventId}/review",
      "POST /strategy-experiments/{eventId}/approve",
      "POST /strategy-experiments/{eventId}/promote",
      "POST /strategy-experiments/{eventId}/rollback",
    ]) {
      const matches = Object.values(resources).filter(
        (resource) =>
          resource.Type === "AWS::ApiGatewayV2::Route" &&
          resource.Properties?.["RouteKey"] === routeKey,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.Properties).toEqual(
        expect.objectContaining({ AuthorizationType: "NONE" }),
      );
      expect(matches[0]?.Properties?.["AuthorizerId"]).toBeUndefined();
      expect(matches[0]?.Properties?.["AuthorizationScopes"]).toBeUndefined();
    }
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FTE_PRODUCT_ACCESS_ENFORCED: "false",
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:DeleteItem",
            Effect: "Allow",
            Condition: {
              "ForAllValues:StringLike": {
                "dynamodb:LeadingKeys": ["WATCHLIST#*"],
              },
            },
          }),
        ]),
      },
    });
    // Identity is the only thing the request path updates in place, and SMS
    // publish has no resource to name — the comment in the stack says so and
    // this assertion pins both halves.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "dynamodb:UpdateItem",
            Effect: "Allow",
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
          }),
          Match.objectLike({
            Action: "sns:Publish",
            Effect: "Allow",
            Resource: "*",
          }),
        ]),
      },
    });
    // No SMS resource is provisioned: origination is account-level and
    // already registered, so the stack must not create one.
    template.resourceCountIs("AWS::Pinpoint::App", 0);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    expect(rendered).toContain("find-the-edge/test/identity");
    // Referenced by name, not resolved at synth: the stack deploys whether or
    // not the Stripe secret exists yet.
    expect(rendered).toContain("find-the-edge/test/stripe");
    expect(rendered).toContain(
      '\\"AllowMethods\\":[\\"GET\\",\\"POST\\",\\"DELETE\\",\\"OPTIONS\\"]',
    );
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
    expect(rendered).toContain("opportunity-rank-v1");
    expect(rendered).toContain("/data-sources");
    expect(rendered).toContain("/scout-jobs/");
    expect(rendered).toContain("/auth/callback");
    expect(rendered).not.toContain("dynamodb:Scan");
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "test",
      AutoDeploy: true,
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
    template.resourceCountIs("AWS::Logs::LogGroup", 0);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
    expect(rendered).not.toContain("AWSLambdaBasicExecutionRole");
    expect(rendered).not.toContain("logs:");
    expect(rendered).not.toContain("cloudwatch:");
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
    ).toBeUndefined();
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

    for (const routeKey of [
      "POST /events/{eventId}/scout",
      "GET /scout-jobs/{jobId}",
      "POST /scout-jobs/{jobId}/retry",
      "GET /scout-jobs/{jobId}/report",
      "GET /scout-reports/{reportId}/versions",
      "GET /scout-reports/{reportId}/versions/{versionNumber}",
    ]) {
      const matches = Object.values(resources).filter(
        (resource) =>
          resource.Type === "AWS::ApiGatewayV2::Route" &&
          resource.Properties?.["RouteKey"] === routeKey,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.Properties).toEqual(
        expect.objectContaining({ AuthorizationType: "NONE" }),
      );
      expect(matches[0]?.Properties?.["AuthorizerId"]).toBeUndefined();
      expect(matches[0]?.Properties?.["AuthorizationScopes"]).toBeUndefined();
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
      ([, resource]) =>
        resource.Type === "AWS::IAM::Policy" &&
        JSON.stringify(resource).includes("SCOUT_OUTBOX#*"),
    );
    expect(JSON.stringify(outboxPolicy?.[1])).toContain(
      '"Action":["dynamodb:GetItem","dynamodb:UpdateItem"]',
    );
    expect(JSON.stringify(outboxPolicy?.[1])).toContain("SCOUT_OUTBOX#*");
    const dispatcherPolicy = Object.entries(resources).find(
      ([, resource]) =>
        resource.Type === "AWS::IAM::Policy" &&
        JSON.stringify(resource).includes("states:StartExecution") &&
        JSON.stringify(resource).includes("dynamodb:TransactWriteItems"),
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
      ([, resource]) =>
        resource.Type === "AWS::IAM::Policy" &&
        JSON.stringify(resource).includes("SCOUT_REPORT#*"),
    );
    expect(JSON.stringify(workflowWorkerPolicy?.[1])).toContain(
      '"Action":["dynamodb:ConditionCheckItem","dynamodb:GetItem","dynamodb:PutItem","dynamodb:TransactWriteItems"]',
    );
    for (const leadingKey of [
      "EVENT_DETAIL#*",
      "SCOUT_JOB#*",
      "SCOUT_ATTEMPT#*",
      "SCOUT_ACTIVE#*",
      "SCOUT_REPORT#*",
      "SCOUT_REPORT_JOB#*",
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
      "ProviderLandingFunctionName",
      "ProviderLandingDlqUrl",
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

  it("enables scheduling only by config with the capped staging alarm set", () => {
    const { stack } = createFoundationApp({
      stage: "staging",
      ...eventConfig,
      schedulerEnabled: true,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Events::Rule", { State: "ENABLED" });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.resourceCountIs("AWS::Logs::LogGroup", 0);
  });

  it("keeps universal provider acquisition inert in production until the staging gate is promoted", () => {
    const { stack } = createFoundationApp({
      stage: "prod",
      ...eventConfig,
      schedulerEnabled: true,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Events::Rule", {
      State: "DISABLED",
      ScheduleExpression: "rate(1 minute)",
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
  });
});
