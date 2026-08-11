import {
  App,
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  CfnOutput,
  type StackProps,
} from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import {
  EventField,
  Rule,
  RuleTargetInput,
  Schedule,
} from "aws-cdk-lib/aws-events";
import {
  LambdaFunction,
  SfnStateMachine,
  SqsQueue,
} from "aws-cdk-lib/aws-events-targets";
import {
  FilterCriteria,
  Runtime,
  StartingPosition,
} from "aws-cdk-lib/aws-lambda";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  AccountRecovery,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolGroup,
  UserPoolResourceServer,
  ResourceServerScope,
} from "aws-cdk-lib/aws-cognito";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import {
  AllowedMethods,
  CachePolicy,
  CfnResponseHeadersPolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  DynamoEventSource,
  SqsDlq,
  SqsEventSource,
} from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import {
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
  Timeout,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  LambdaInvoke,
  SqsSendMessage,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  ApiMapping,
  CfnStage,
  DomainName,
  EndpointType,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigatewayv2";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FoundationConfig {
  stage: string;
  releaseSha?: string;
  webDomainName?: string;
  apiDomainName?: string;
  webCertificateArn?: string;
  apiCertificateArn?: string;
  account?: string;
  region?: string;
  schedulerEnabled?: boolean;
  paperPickSchedulerEnabled?: boolean;
  paperPickGenerationMinutes?: number;
  alarmTopicArn?: string;
  alarmEmail?: string;
  cursorSecretArn?: string;
  fixtureOddsSeedEnabled?: boolean;
  webOrigin?: string;
}

interface FoundationStackProps extends StackProps {
  schedulerEnabled: boolean;
  paperPickSchedulerEnabled: boolean;
  paperPickGenerationMinutes: number;
  alarmTopicArn?: string;
  alarmEmail?: string;
  stageName: string;
  releaseSha?: string;
  webDomainName?: string;
  apiDomainName?: string;
  webCertificateArn?: string;
  apiCertificateArn?: string;
  cursorSecretArn: string;
  fixtureOddsSeedEnabled: boolean;
}

export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const table = new Table(this, "EventIngestionTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      timeToLiveAttribute: "expiresAt",
      stream: StreamViewType.NEW_IMAGE,
    });
    table.addGlobalSecondaryIndex({
      indexName: "opportunity-active-v1",
      partitionKey: { name: "activePk", type: AttributeType.STRING },
      sortKey: { name: "activeSk", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    table.addGlobalSecondaryIndex({
      indexName: "opportunity-rank-v1",
      partitionKey: { name: "rankPk", type: AttributeType.STRING },
      sortKey: { name: "rankSk", type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    const performanceWorker = new NodejsFunction(this, "PerformanceWorker", {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../apps/workers/src/performance-lambda.ts",
      ),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 1024,
      reservedConcurrentExecutions: 1,
      environment: { FTE_EVENT_TABLE_NAME: table.tableName },
    });
    performanceWorker.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );
    const performanceSchedule = new Rule(this, "PerformanceSchedule", {
      schedule: Schedule.cron({ minute: "20", hour: "5" }),
    });
    performanceSchedule.addTarget(new LambdaFunction(performanceWorker));
    const walkForwardWorker = new NodejsFunction(
      this,
      "WalkForwardExperimentWorker",
      {
        runtime: Runtime.NODEJS_22_X,
        entry: path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../apps/workers/src/walk-forward-runtime.ts",
        ),
        handler: "handler",
        timeout: Duration.minutes(5),
        memorySize: 1024,
        reservedConcurrentExecutions: 1,
        environment: { FTE_EVENT_TABLE_NAME: table.tableName },
      },
    );
    walkForwardWorker.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );
    const paperPickDlq = new Queue(this, "PaperPickWorkerDlq", {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const paperPickWorker = new NodejsFunction(this, "PaperPickWorker", {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../apps/workers/src/paper-pick-scheduler-runtime.ts",
      ),
      handler: "handler",
      timeout: Duration.minutes(2),
      memorySize: 512,
      reservedConcurrentExecutions: 2,
      environment: {
        FTE_EVENT_TABLE: table.tableName,
        FTE_PAPER_PICK_POLICY_ID: "paper-pick-schedule",
        FTE_PAPER_PICK_POLICY_VERSION: "1",
        FTE_PAPER_PICK_ENABLED: "false",
        FTE_PAPER_PICK_MODEL_CAPABILITY: "disabled",
        FTE_PAPER_PICK_GENERATION_MINUTES: String(
          props.paperPickGenerationMinutes,
        ),
      },
    });
    paperPickWorker.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:TransactGetItems",
        ],
        resources: [table.tableArn],
      }),
    );
    const paperPickFailure = new Fail(this, "PaperPickWorkflowFailure");
    const paperPickReplayFailure = new SqsSendMessage(
      this,
      "QueuePaperPickWorkflowFailure",
      {
        queue: paperPickDlq,
        messageBody: TaskInput.fromObject({
          source: "aws.states",
          detailType: JsonPath.stringAt("$.detailType"),
          generatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
          scheduledFor: JsonPath.stringAt("$.scheduledFor"),
          generationMinutes: JsonPath.numberAt("$.generationMinutes"),
        }),
      },
    );
    const paperPickSuccess = new Succeed(this, "PaperPickWorkflowSuccess");
    const paperPickInvoke = new LambdaInvoke(this, "InvokePaperPickWorker", {
      lambdaFunction: paperPickWorker,
      payloadResponseOnly: true,
    });
    paperPickInvoke.addRetry({
      maxAttempts: 2,
      interval: Duration.seconds(10),
      backoffRate: 2,
    });
    paperPickInvoke.addCatch(paperPickReplayFailure.next(paperPickFailure), {
      errors: ["States.ALL"],
      resultPath: "$.failure",
    });
    const paperPickWorkflow = new StateMachine(this, "PaperPickWorkflow", {
      stateMachineType: StateMachineType.STANDARD,
      definitionBody: DefinitionBody.fromChainable(
        paperPickInvoke.next(paperPickSuccess),
      ),
      timeout: Duration.minutes(10),
    });
    const paperPickSchedule = new Rule(this, "PaperPickSchedule", {
      enabled: props.paperPickSchedulerEnabled,
      schedule: Schedule.cron({
        minute: `0/${props.paperPickGenerationMinutes}`,
      }),
    });
    paperPickSchedule.addTarget(
      new SfnStateMachine(paperPickWorkflow, {
        input: RuleTargetInput.fromObject({
          source: "aws.events",
          detailType: "FTE Paper Pick Generation",
          generatedAt: EventField.time,
          scheduledFor: EventField.time,
          generationMinutes: props.paperPickGenerationMinutes,
        }),
      }),
    );
    new CfnOutput(this, "PaperPickFailureQueueUrl", {
      value: paperPickDlq.queueUrl,
    });
    new CfnOutput(this, "PaperPickWorkflowArn", {
      value: paperPickWorkflow.stateMachineArn,
    });
    const userPool = new UserPool(this, "MvpUserPool", {
      selfSignUpEnabled: false,
      accountRecovery: AccountRecovery.NONE,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: Duration.days(1),
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const readScope = new ResourceServerScope({
      scopeName: "events:read",
      scopeDescription: "Read FIND THE EDGE events and odds",
    });
    const scoutingReadScope = new ResourceServerScope({
      scopeName: "scouting:read",
      scopeDescription: "Read owned FIND THE EDGE scouting jobs",
    });
    const scoutingWriteScope = new ResourceServerScope({
      scopeName: "scouting:write",
      scopeDescription: "Create and retry FIND THE EDGE scouting jobs",
    });
    const retrospectiveApprovalScope = new ResourceServerScope({
      scopeName: "retrospectives:approve",
      scopeDescription: "Review non-executable retrospective candidates",
    });
    const strategyPromotionScope = new ResourceServerScope({
      scopeName: "strategies:promote",
      scopeDescription:
        "Approve, promote, and roll back deployed strategy artifacts",
    });
    const resourceServer = new UserPoolResourceServer(
      this,
      "EventsResourceServer",
      {
        identifier: "events",
        userPool,
        scopes: [
          readScope,
          scoutingReadScope,
          scoutingWriteScope,
          retrospectiveApprovalScope,
          strategyPromotionScope,
        ],
      },
    );
    const assets = new Bucket(this, "WebAssets", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      versioned: true,
    });
    const securityHeaders = new ResponseHeadersPolicy(
      this,
      "WebSecurityHeaders",
      {
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: "default-src 'none'",
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          xssProtection: { protection: true, modeBlock: true, override: true },
        },
        customHeadersBehavior: {
          customHeaders: [
            { header: "Cache-Control", value: "no-store", override: true },
            {
              header: "Permissions-Policy",
              value: "camera=(), microphone=(), geolocation=()",
              override: true,
            },
          ],
        },
      },
    );
    const immutableHeaders = new ResponseHeadersPolicy(
      this,
      "WebImmutableSecurityHeaders",
      {
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: "default-src 'none'",
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cache-Control",
              value: "public, max-age=31536000, immutable",
              override: true,
            },
          ],
        },
      },
    );
    const webAssetOrigin = S3BucketOrigin.withOriginAccessControl(assets);
    const spaNavigation = new CloudFrontFunction(this, "WebSpaNavigation", {
      code: FunctionCode.fromInline(
        "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/auth/callback' || request.uri === '/privacy' || request.uri === '/terms' || request.uri === '/events' || request.uri.indexOf('/events/') === 0 || request.uri === '/games' || request.uri.indexOf('/games/') === 0 || request.uri === '/splits' || request.uri === '/watchlist' || request.uri === '/dashboard' || request.uri === '/performance' || request.uri === '/data-sources' || request.uri.indexOf('/data-sources/') === 0 || request.uri === '/retrospectives' || request.uri.indexOf('/retrospectives/') === 0 || request.uri === '/experiments' || request.uri.indexOf('/experiments/') === 0 || request.uri.indexOf('/scout-jobs/') === 0) {\n    request.uri = '/index.html';\n  }\n  return request;\n}",
      ),
    });
    const webCertificate = props.webCertificateArn
      ? Certificate.fromCertificateArn(
          this,
          "WebCertificate",
          props.webCertificateArn,
        )
      : undefined;
    const distribution = new Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      ...(props.webDomainName && webCertificate
        ? { domainNames: [props.webDomainName], certificate: webCertificate }
        : {}),
      defaultBehavior: {
        origin: webAssetOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [
          {
            function: spaNavigation,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
        compress: true,
      },
      additionalBehaviors: {
        "assets/*": {
          origin: webAssetOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: immutableHeaders,
          compress: true,
        },
      },
    });
    const webOrigin = props.webDomainName
      ? `https://${props.webDomainName}`
      : `https://${distribution.distributionDomainName}`;
    const callbackUrl = `${webOrigin}/auth/callback`;
    const userPoolClient = new UserPoolClient(this, "MvpWebClient", {
      userPool,
      generateSecret: false,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
          clientCredentials: false,
        },
        scopes: [
          OAuthScope.resourceServer(resourceServer, readScope),
          OAuthScope.resourceServer(resourceServer, scoutingReadScope),
          OAuthScope.resourceServer(resourceServer, scoutingWriteScope),
        ],
        callbackUrls: [callbackUrl],
        logoutUrls: [webOrigin],
      },
      preventUserExistenceErrors: true,
    });
    new UserPoolGroup(this, "RetrospectiveReviewers", {
      userPool,
      groupName: "fte-retrospective-reviewers",
      description: "Human reviewers allowed to approve retrospective drafts",
    });
    new UserPoolGroup(this, "StrategyPromoters", {
      userPool,
      groupName: "fte-strategy-promoters",
      description: "Human promoters allowed to activate approved strategies",
    });
    const reviewerClient = new UserPoolClient(this, "ReviewerWebClient", {
      userPool,
      generateSecret: false,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          OAuthScope.OPENID,
          OAuthScope.EMAIL,
          OAuthScope.resourceServer(resourceServer, readScope),
          OAuthScope.resourceServer(resourceServer, scoutingReadScope),
          OAuthScope.resourceServer(resourceServer, scoutingWriteScope),
          OAuthScope.resourceServer(resourceServer, retrospectiveApprovalScope),
          OAuthScope.resourceServer(resourceServer, strategyPromotionScope),
        ],
        callbackUrls: [callbackUrl],
        logoutUrls: [webOrigin],
      },
      preventUserExistenceErrors: true,
    });
    const domain = new UserPoolDomain(this, "MvpHostedUiDomain", {
      userPool,
      cognitoDomain: {
        domainPrefix: `find-the-edge-${props.stageName}-${this.account}`,
      },
    });
    const dlq = new Queue(this, "UpcomingEventsDlq", {
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const queue = new Queue(this, "UpcomingEventsQueue", {
      fifo: true,
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      visibilityTimeout: Duration.seconds(180),
    });
    const directory = path.dirname(fileURLToPath(import.meta.url));
    // SharpAPI is the sole production schedule and odds source.
    const sharpApiSecret = Secret.fromSecretNameV2(
      this,
      "SharpApiSecret",
      `find-the-edge/${props.stageName}/sharpapi`,
    );
    const liveOdds = new NodejsFunction(this, "LiveOddsIngestion", {
      entry: path.resolve(
        directory,
        "../../../apps/workers/src/live-odds-lambda.ts",
      ),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.minutes(5),
      memorySize: 512,
      // SQS event-source scaling has a minimum maximum-concurrency of two.
      // FIFO message grouping still serializes cadence work for each group.
      reservedConcurrentExecutions: 2,
      environment: {
        FTE_EVENT_TABLE: table.tableName,
        FTE_SHARP_API_ENABLED: "true",
        FTE_SHARP_API_SECRET_ID: sharpApiSecret.secretName,
        // Intra-tick fast lane: the invocation re-runs the checkpoint-gated
        // control plane every ten seconds until fifty seconds of the
        // one-minute tick are spent, so near-start leagues refresh at the
        // ten-second cadence the policy declares. Must stay below the tick
        // interval or FIFO grouping would delay the next tick.
        FTE_FAST_LANE_BUDGET_MS: "50000",
        FTE_FAST_LANE_PAUSE_MS: "10000",
      },
      bundling: { minify: true, sourceMap: true },
    });
    sharpApiSecret.grantRead(liveOdds);
    liveOdds.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:ConditionCheckItem",
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn],
      }),
    );
    liveOdds.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:DeleteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "EVENT_RECONCILIATION#*",
              "ODDS_CONTROL#CONTINUATION#*",
            ],
          },
        },
      }),
    );
    const liveOddsDlq = new Queue(this, "LiveOddsControlPlaneDlq", {
      fifo: true,
      queueName: `find-the-edge-${props.stageName}-odds-control-dlq.fifo`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const liveOddsQueue = new Queue(this, "LiveOddsControlPlaneQueue", {
      fifo: true,
      queueName: `find-the-edge-${props.stageName}-odds-control.fifo`,
      contentBasedDeduplication: true,
      encryption: QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: liveOddsDlq, maxReceiveCount: 5 },
      visibilityTimeout: Duration.minutes(6),
    });
    liveOdds.addEnvironment("FTE_LIVE_ODDS_QUEUE_URL", liveOddsQueue.queueUrl);
    liveOddsQueue.grantConsumeMessages(liveOdds);
    liveOdds.addEventSource(
      new SqsEventSource(liveOddsQueue, {
        batchSize: 1,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );
    const liveOddsScheduler = new Rule(this, "LiveOddsScheduler", {
      enabled: props.schedulerEnabled,
      // One-minute ticks: games and lines refresh each tick, splits keep
      // their own five-minute checkpoint inside the control plane.
      schedule: Schedule.rate(Duration.minutes(1)),
    });
    liveOddsScheduler.addTarget(
      new SqsQueue(liveOddsQueue, { messageGroupId: "odds-cadence" }),
    );
    const oddsProjectionDlq = new Queue(this, "FixtureOddsProjectionDlq", {
      queueName: `find-the-edge-${props.stageName}-odds-projection-dlq`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const oddsProjection = new NodejsFunction(this, "FixtureOddsProjection", {
      entry: path.resolve(
        directory,
        "../../../apps/workers/src/fixture-odds-projection-lambda.ts",
      ),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: { FTE_EVENT_TABLE: table.tableName },
      bundling: { minify: true, sourceMap: true },
    });
    oddsProjection.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:PutItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["FIXTURE_ODDS#*"],
          },
        },
      }),
    );
    oddsProjection.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 5,
        maxRecordAge: Duration.days(1),
        onFailure: new SqsDlq(oddsProjectionDlq),
        filters: [
          FilterCriteria.filter({
            eventName: ["INSERT"],
            dynamodb: {
              Keys: {
                pk: { S: [{ prefix: "FIXTURE_ODDS#" }] },
                sk: { S: [{ prefix: "SNAPSHOT#" }] },
              },
            },
          }),
        ],
      }),
    );
    new CfnOutput(this, "FixtureOddsProjectionFunctionName", {
      value: oddsProjection.functionName,
    });
    new CfnOutput(this, "FixtureOddsProjectionDlqUrl", {
      value: oddsProjectionDlq.queueUrl,
    });
    new CfnOutput(this, "LiveOddsIngestionFunctionName", {
      value: liveOdds.functionName,
    });
    new CfnOutput(this, "SharpApiSecretName", {
      value: sharpApiSecret.secretName,
    });
    const completedResults = new NodejsFunction(
      this,
      "CompletedResultsWorker",
      {
        entry: path.resolve(
          directory,
          "../../../apps/workers/src/completed-result-lambda.ts",
        ),
        handler: "handler",
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.minutes(2),
        memorySize: 256,
        reservedConcurrentExecutions: 1,
        environment: { FTE_EVENT_TABLE: table.tableName },
        bundling: { minify: true, sourceMap: true },
      },
    );
    completedResults.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn],
      }),
    );
    const completedResultsScheduler = new Rule(
      this,
      "CompletedResultsScheduler",
      {
        // Fixture adapters validate contracts only; never schedule them as production truth.
        enabled: false,
        schedule: Schedule.rate(Duration.hours(1)),
      },
    );
    completedResultsScheduler.addTarget(
      new LambdaFunction(completedResults, {
        retryAttempts: 2,
        maxEventAge: Duration.minutes(30),
      }),
    );
    new CfnOutput(this, "CompletedResultsFunctionName", {
      value: completedResults.functionName,
    });
    const opportunityExpirationLogs = new LogGroup(
      this,
      "OpportunityExpirationLogs",
      {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );
    const opportunityExpiration = new NodejsFunction(
      this,
      "OpportunityExpirationWorker",
      {
        entry: path.resolve(
          directory,
          "../../../apps/workers/src/opportunities/opportunity-expiration-lambda.ts",
        ),
        handler: "handler",
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.minutes(2),
        memorySize: 256,
        reservedConcurrentExecutions: 1,
        logGroup: opportunityExpirationLogs,
        environment: {
          FTE_EVENT_TABLE: table.tableName,
          FTE_OPPORTUNITY_SPORT_KEYS: "mlb,soccer,tennis,nfl,nba,ncaaf",
        },
        bundling: { minify: true, sourceMap: true },
      },
    );
    opportunityExpiration.addToRolePolicy(
      new PolicyStatement({
        actions: [
          // Lifecycle transactions authorize their per-item operations:
          // condition checks on the event fence and deletes of retired rank
          // rows, not a standalone TransactWriteItems action.
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
        ],
        resources: [
          table.tableArn,
          `${table.tableArn}/index/opportunity-active-v1`,
        ],
      }),
    );
    const opportunityExpirationSchedule = new Rule(
      this,
      "OpportunityExpirationSchedule",
      {
        enabled: props.schedulerEnabled,
        schedule: Schedule.rate(Duration.minutes(5)),
      },
    );
    opportunityExpirationSchedule.addTarget(
      new LambdaFunction(opportunityExpiration, {
        retryAttempts: 2,
        maxEventAge: Duration.minutes(5),
      }),
    );
    new CfnOutput(this, "OpportunityExpirationFunctionName", {
      value: opportunityExpiration.functionName,
    });
    const opportunityGenerationLogs = new LogGroup(
      this,
      "OpportunityGenerationLogs",
      {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );
    const opportunityGeneration = new NodejsFunction(
      this,
      "OpportunityGenerationWorker",
      {
        entry: path.resolve(
          directory,
          "../../../apps/workers/src/opportunities/opportunity-generation-lambda.ts",
        ),
        handler: "handler",
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.minutes(2),
        memorySize: 512,
        reservedConcurrentExecutions: 1,
        logGroup: opportunityGenerationLogs,
        environment: {
          FTE_EVENT_TABLE: table.tableName,
        },
        bundling: { minify: true, sourceMap: true },
      },
    );
    opportunityGeneration.addToRolePolicy(
      new PolicyStatement({
        actions: [
          // Lifecycle transactions authorize their per-item operations:
          // condition checks on the event fence and deletes of replaced rank
          // rows, not a standalone TransactWriteItems action.
          "dynamodb:BatchGetItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
        ],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );
    const opportunityGenerationSchedule = new Rule(
      this,
      "OpportunityGenerationSchedule",
      {
        enabled: props.schedulerEnabled,
        schedule: Schedule.rate(Duration.minutes(5)),
      },
    );
    opportunityGenerationSchedule.addTarget(
      new LambdaFunction(opportunityGeneration, {
        retryAttempts: 2,
        maxEventAge: Duration.minutes(5),
      }),
    );
    new CfnOutput(this, "OpportunityGenerationFunctionName", {
      value: opportunityGeneration.functionName,
    });
    const worker = new NodejsFunction(this, "UpcomingEventsWorker", {
      entry: path.resolve(directory, "../../../apps/workers/src/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        FTE_EVENT_TABLE: table.tableName,
        FTE_UPCOMING_QUEUE_URL: queue.queueUrl,
      },
      bundling: { minify: true, sourceMap: true },
    });
    worker.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:TransactGetItems",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn],
      }),
    );
    queue.grantSendMessages(worker);
    worker.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 1,
        maxConcurrency: 5,
        reportBatchItemFailures: true,
      }),
    );
    if (props.fixtureOddsSeedEnabled) {
      const fixtureSeed = new NodejsFunction(this, "FixtureOddsSeed", {
        entry: path.resolve(
          directory,
          "../../../apps/workers/src/fixture-odds-seed-lambda.ts",
        ),
        handler: "handler",
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.seconds(60),
        memorySize: 256,
        environment: {
          FTE_AWS_STAGE: props.stageName,
          FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
          FTE_EVENT_TABLE: table.tableName,
        },
      });
      fixtureSeed.addToRolePolicy(
        new PolicyStatement({
          actions: [
            "dynamodb:ConditionCheckItem",
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:TransactWriteItems",
          ],
          resources: [table.tableArn],
        }),
      );
      new CfnOutput(this, "FixtureOddsSeedFunctionName", {
        value: fixtureSeed.functionName,
      });
    }
    const producer = new NodejsFunction(this, "UpcomingEventsProducer", {
      entry: path.resolve(
        directory,
        "../../../apps/workers/src/scheduler-producer.ts",
      ),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      memorySize: 128,
      environment: { FTE_UPCOMING_QUEUE_URL: queue.queueUrl },
      bundling: { minify: true, sourceMap: true },
    });
    queue.grantSendMessages(producer);
    const schedulerReady = new Rule(this, "UpcomingEventsSchedulerReady", {
      // The legacy producer uses fixture schedule adapters. Keep it disabled;
      // live discovery and odds refreshes are owned by LiveOddsScheduler.
      enabled: false,
      schedule: Schedule.rate(Duration.hours(1)),
    });
    schedulerReady.addTarget(new LambdaFunction(producer));
    const scoutingDispatchDlq = new Queue(this, "ScoutingDispatchDlq", {
      fifo: true,
      queueName: `find-the-edge-${props.stageName}-scouting-dispatch-dlq.fifo`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const scoutingDispatchQueue = new Queue(this, "ScoutingDispatchQueue", {
      fifo: true,
      queueName: `find-the-edge-${props.stageName}-scouting-dispatch.fifo`,
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: scoutingDispatchDlq, maxReceiveCount: 5 },
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(2),
    });
    const scoutingWorkflowWorker = new NodejsFunction(
      this,
      "ScoutingWorkflowWorker",
      {
        entry: path.resolve(
          directory,
          "../../../apps/workers/src/scouting-workflow-lambda.ts",
        ),
        handler: "handler",
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.seconds(30),
        memorySize: 256,
        reservedConcurrentExecutions: 5,
        environment: { FTE_EVENT_TABLE: table.tableName },
        bundling: { minify: true, sourceMap: true },
      },
    );
    // FTE-042: DynamoDB transactions authorize PER-ITEM actions, so the
    // report completion TransactWriteItems needs ConditionCheckItem for the
    // canonical event fence and PutItem for the version/head/binding/job/
    // attempt/lock writes, scoped to the exact scouting key families.
    scoutingWorkflowWorker.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:ConditionCheckItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "EVENT_DETAIL#*",
              "SCOUT_JOB#*",
              "SCOUT_ATTEMPT#*",
              "SCOUT_ACTIVE#*",
              "SCOUT_REPORT#*",
              "SCOUT_REPORT_JOB#*",
            ],
          },
        },
      }),
    );
    const scoutingWorkflowFailed = new Fail(this, "ScoutingWorkflowFailed", {
      error: "ScoutingWorkflowFailed",
      cause: "The fenced scouting workflow did not complete",
    });
    const scoutingWorkflowSucceeded = new Succeed(
      this,
      "ScoutingWorkflowSucceeded",
    );
    const scoutingWorkflowInvoke = new LambdaInvoke(
      this,
      "InvokeScoutingWorkflowWorker",
      {
        lambdaFunction: scoutingWorkflowWorker,
        payloadResponseOnly: true,
        taskTimeout: Timeout.duration(Duration.seconds(25)),
      },
    );
    const scoutingWorkflowFailureFinalizer = new LambdaInvoke(
      this,
      "FinalizeScoutingWorkflowFailure",
      {
        lambdaFunction: scoutingWorkflowWorker,
        payload: TaskInput.fromObject({
          schemaVersion: 1,
          action: "finalize-failure",
          jobId: JsonPath.stringAt("$.jobId"),
          attemptId: JsonPath.stringAt("$.attemptId"),
          failureCode: "workflow-temporarily-unavailable",
        }),
        payloadResponseOnly: true,
      },
    );
    const scoutingWorkflowTimeoutFinalizer = new LambdaInvoke(
      this,
      "FinalizeScoutingWorkflowTimeout",
      {
        lambdaFunction: scoutingWorkflowWorker,
        payload: TaskInput.fromObject({
          schemaVersion: 1,
          action: "finalize-failure",
          jobId: JsonPath.stringAt("$.jobId"),
          attemptId: JsonPath.stringAt("$.attemptId"),
          failureCode: "workflow-timeout",
        }),
        payloadResponseOnly: true,
      },
    );
    scoutingWorkflowFailureFinalizer.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 2,
    });
    scoutingWorkflowTimeoutFinalizer.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 2,
    });
    scoutingWorkflowFailureFinalizer.addCatch(scoutingWorkflowFailed, {
      errors: ["States.ALL"],
      resultPath: "$.finalizerFailure",
    });
    scoutingWorkflowTimeoutFinalizer.addCatch(scoutingWorkflowFailed, {
      errors: ["States.ALL"],
      resultPath: "$.finalizerFailure",
    });
    scoutingWorkflowInvoke.addCatch(
      scoutingWorkflowTimeoutFinalizer.next(scoutingWorkflowFailed),
      {
        errors: ["States.Timeout"],
        resultPath: "$.workflowFailure",
      },
    );
    scoutingWorkflowInvoke.addCatch(
      scoutingWorkflowFailureFinalizer.next(scoutingWorkflowFailed),
      {
        errors: ["States.ALL"],
        resultPath: "$.workflowFailure",
      },
    );
    const scoutingWorkflowLogs = new LogGroup(this, "ScoutingWorkflowLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const scoutingWorkflow = new StateMachine(this, "ScoutingWorkflow", {
      stateMachineType: StateMachineType.STANDARD,
      definitionBody: DefinitionBody.fromChainable(
        scoutingWorkflowInvoke.next(scoutingWorkflowSucceeded),
      ),
      timeout: Duration.minutes(5),
      logs: {
        destination: scoutingWorkflowLogs,
        level: LogLevel.ERROR,
        includeExecutionData: false,
      },
    });
    const scoutingDispatcher = new NodejsFunction(this, "ScoutingDispatcher", {
      entry: path.resolve(
        directory,
        "../../../apps/workers/src/scouting-dispatcher-lambda.ts",
      ),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      environment: {
        FTE_SCOUTING_STATE_MACHINE_ARN: scoutingWorkflow.stateMachineArn,
        FTE_EVENT_TABLE: table.tableName,
      },
      bundling: { minify: true, sourceMap: true },
    });
    scoutingWorkflow.grantStartExecution(scoutingDispatcher);
    scoutingWorkflow.grantExecution(
      scoutingDispatcher,
      "states:DescribeExecution",
    );
    scoutingDispatcher.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:TransactWriteItems"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "EVENT_DETAIL#*",
              "SCOUT_JOB#*",
              "SCOUT_ATTEMPT#*",
              "SCOUT_ACTIVE#*",
            ],
          },
        },
      }),
    );
    scoutingDispatcher.addEventSource(
      new SqsEventSource(scoutingDispatchQueue, {
        batchSize: 1,
        maxConcurrency: 5,
        reportBatchItemFailures: true,
      }),
    );
    const scoutingOutboxPublisherDlq = new Queue(
      this,
      "ScoutingOutboxPublisherDlq",
      {
        queueName: `find-the-edge-${props.stageName}-scouting-outbox-publisher-dlq`,
        encryption: QueueEncryption.SQS_MANAGED,
        retentionPeriod: Duration.days(14),
      },
    );
    const scoutingOutboxPublisher = new NodejsFunction(
      this,
      "ScoutingOutboxPublisher",
      {
        entry: path.resolve(
          directory,
          "../../../apps/workers/src/scouting-outbox-lambda.ts",
        ),
        handler: "handler",
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.seconds(30),
        memorySize: 256,
        reservedConcurrentExecutions: 2,
        environment: {
          FTE_EVENT_TABLE: table.tableName,
          FTE_SCOUTING_QUEUE_URL: scoutingDispatchQueue.queueUrl,
        },
        bundling: { minify: true, sourceMap: true },
      },
    );
    scoutingOutboxPublisher.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["SCOUT_OUTBOX#*"],
          },
        },
      }),
    );
    scoutingDispatchQueue.grantSendMessages(scoutingOutboxPublisher);
    scoutingOutboxPublisher.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 25,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 5,
        maxRecordAge: Duration.days(1),
        onFailure: new SqsDlq(scoutingOutboxPublisherDlq),
        filters: [
          FilterCriteria.filter({
            eventName: ["INSERT", "MODIFY"],
            dynamodb: {
              Keys: {
                pk: { S: [{ prefix: "SCOUT_OUTBOX#" }] },
                sk: { S: ["CURRENT"] },
              },
              NewImage: {
                entityType: { S: ["scouting-dispatch-outbox"] },
                outboxStatus: { S: ["pending"] },
              },
            },
          }),
        ],
      }),
    );
    new CfnOutput(this, "ScoutingDispatchQueueUrl", {
      value: scoutingDispatchQueue.queueUrl,
    });
    new CfnOutput(this, "ScoutingDispatchDlqUrl", {
      value: scoutingDispatchDlq.queueUrl,
    });
    new CfnOutput(this, "ScoutingOutboxPublisherDlqUrl", {
      value: scoutingOutboxPublisherDlq.queueUrl,
    });
    new CfnOutput(this, "ScoutingWorkflowArn", {
      value: scoutingWorkflow.stateMachineArn,
    });
    new CfnOutput(this, "ScoutingOutboxPublisherFunctionName", {
      value: scoutingOutboxPublisher.functionName,
    });
    new CfnOutput(this, "ScoutingDispatcherFunctionName", {
      value: scoutingDispatcher.functionName,
    });
    new CfnOutput(this, "ScoutingWorkflowWorkerFunctionName", {
      value: scoutingWorkflowWorker.functionName,
    });
    // Our own identity keys: the session signing ring plus the OTP and
    // account peppers. Rotating the ring is a secret edit, not a deploy.
    const identitySecret = Secret.fromSecretNameV2(
      this,
      "IdentitySecret",
      `find-the-edge/${props.stageName}/identity`,
    );
    const eventApi = new NodejsFunction(this, "EventApi", {
      entry: path.resolve(directory, "../../../apps/api/src/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(10),
      // Lambda scales CPU with memory, and this handler is CPU-bound: it
      // validates every current-odds row and serialises a six-figure payload.
      // At 256 MB it held roughly a seventh of a vCPU and took about four
      // seconds warm. The larger size is close to cost-neutral in GB-seconds
      // because the duration falls by about as much as the size rises.
      memorySize: 1024,
      environment: {
        FTE_EVENT_TABLE_NAME: table.tableName,
        FTE_EVENT_CURSOR_SECRET_ARN: props.cursorSecretArn,
        FTE_IDENTITY_SECRET_ID: identitySecret.secretName,
      },
      bundling: { minify: true, sourceMap: true },
    });
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:TransactGetItems",
          "dynamodb:TransactWriteItems",
        ],
        resources: [table.tableArn],
      }),
    );
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [`${table.tableArn}/index/opportunity-rank-v1`],
      }),
    );
    // Removing a watchlist entry is the only delete the request path performs,
    // and it can only ever touch a user's own watchlist partition.
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:DeleteItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["WATCHLIST#*"],
          },
        },
      }),
    );
    // Identity is the only thing the request path updates in place: the
    // account row, the live OTP challenge, and the rate-limit counters.
    // Nothing else in the table can be reached by an UpdateItem call.
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [table.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["ACCOUNT#*", "OTP#*", "OTP_RATE#*"],
          },
        },
      }),
    );
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.cursorSecretArn],
      }),
    );
    identitySecret.grantRead(eventApi);
    // SMS sign-in codes go out over SNS direct publish. The account's SMS
    // origination is already configured at account and region level, so this
    // stack provisions no phone number, sender id, or pool. A direct-to-phone
    // publish has no topic ARN to name, and IAM offers no condition key for
    // the destination number, so this statement genuinely cannot be narrowed
    // below the action itself: it is `sns:Publish` on `*`, and the practical
    // bound on abuse is the rate limiting in the handler, not IAM.
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: ["sns:Publish"],
        resources: ["*"],
      }),
    );
    const api = new HttpApi(this, "EventsHttpApi", {
      createDefaultStage: false,
    });
    const apiOrigin = props.apiDomainName
      ? `https://${props.apiDomainName}`
      : api.apiEndpoint;
    const exactCsp = `default-src 'self'; base-uri 'none'; connect-src 'self' ${apiOrigin} ${domain.baseUrl()}; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'`;
    for (const policy of [securityHeaders, immutableHeaders]) {
      const resource = policy.node.defaultChild as CfnResponseHeadersPolicy;
      resource.addPropertyOverride(
        "ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy",
        exactCsp,
      );
    }
    const integration = new HttpLambdaIntegration(
      "EventsIntegration",
      eventApi,
    );
    const authorizer = new HttpJwtAuthorizer(
      "EventsJwt",
      userPool.userPoolProviderUrl,
      {
        jwtAudience: [
          userPoolClient.userPoolClientId,
          reviewerClient.userPoolClientId,
        ],
      },
    );
    // Our own identity endpoints, deliberately without an authorizer: these
    // routes are how a caller obtains a token, so requiring one would be
    // circular. They are protected by per-number and per-address rate limits
    // and single-use codes in the handler, not by the gateway.
    for (const path of [
      "/auth/otp/request",
      "/auth/otp/verify",
      "/auth/session/refresh",
    ])
      api.addRoutes({
        path,
        methods: [HttpMethod.POST],
        integration,
      });
    api.addRoutes({
      path: "/events",
      methods: [HttpMethod.GET],
      integration,
      authorizer,
      authorizationScopes: ["events/events:read"],
    });
    api.addRoutes({
      path: "/events/{eventId}",
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: "/events/{eventId}/scout",
      methods: [HttpMethod.POST],
      integration,
      authorizer,
      authorizationScopes: ["events/scouting:write"],
    });
    api.addRoutes({
      path: "/scout-jobs/{jobId}",
      methods: [HttpMethod.GET],
      integration,
      authorizer,
      authorizationScopes: ["events/scouting:read"],
    });
    api.addRoutes({
      path: "/scout-jobs/{jobId}/retry",
      methods: [HttpMethod.POST],
      integration,
      authorizer,
      authorizationScopes: ["events/scouting:write"],
    });
    for (const path of [
      "/scout-jobs/{jobId}/report",
      "/scout-reports/{reportId}/versions",
      "/scout-reports/{reportId}/versions/{versionNumber}",
    ])
      api.addRoutes({
        path,
        methods: [HttpMethod.GET],
        integration,
        authorizer,
        authorizationScopes: ["events/scouting:read"],
      });
    // The watchlist is per-user data, so every route is authenticated. It
    // carries no dedicated Cognito scope: the requester is the token subject
    // and the storage partition is derived from it, so a scope would add a
    // re-consent step without adding an authorization decision.
    api.addRoutes({
      path: "/watchlist",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration,
      authorizer,
    });
    api.addRoutes({
      path: "/watchlist/{eventId}",
      methods: [HttpMethod.DELETE],
      integration,
      authorizer,
    });
    for (const path of [
      "/sports/{sportKey}/opportunities",
      "/sports/{sportKey}/opportunities/{opportunityId}",
      "/sports/{sportKey}/arbitrage",
      "/sports/{sportKey}/clv",
    ])
      api.addRoutes({
        path,
        methods: [HttpMethod.GET],
        integration,
      });
    api.addRoutes({
      path: "/games",
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: "/providers/status",
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: "/games/{eventId}/odds-history",
      methods: [HttpMethod.GET],
      integration,
    });
    api.addRoutes({
      path: "/splits",
      methods: [HttpMethod.GET],
      integration,
    });
    for (const path of [
      "/performance/cohorts",
      "/performance/cohorts/{eventId}",
      "/performance/reports",
      "/performance/reports/{eventId}",
      "/retrospectives",
      "/retrospectives/{eventId}",
      "/retrospectives/{eventId}/versions",
      "/strategy-experiments",
      "/strategy-experiments/{eventId}",
    ])
      api.addRoutes({
        path,
        methods: [HttpMethod.GET],
        integration,
      });
    api.addRoutes({
      path: "/retrospectives/{eventId}/review",
      methods: [HttpMethod.POST],
      integration,
      authorizer,
      authorizationScopes: ["events/retrospectives:approve"],
    });
    for (const action of ["approve", "promote", "rollback"])
      api.addRoutes({
        path: `/strategy-experiments/{eventId}/${action}`,
        methods: [HttpMethod.POST],
        integration,
        authorizer,
        authorizationScopes: ["events/strategies:promote"],
      });
    const configureCorsCall = {
      service: "ApiGatewayV2",
      action: "updateApi",
      parameters: {
        ApiId: api.apiId,
        CorsConfiguration: {
          AllowOrigins: [webOrigin],
          AllowHeaders: ["authorization", "content-type", "idempotency-key"],
          AllowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
          ExposeHeaders: ["location"],
        },
      },
      physicalResourceId: PhysicalResourceId.of(
        `${this.stackName}-events-api-cors`,
      ),
    };
    new AwsCustomResource(this, "ConfigureEventsApiCors", {
      onCreate: configureCorsCall,
      onUpdate: configureCorsCall,
      installLatestAwsSdk: false,
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ["apigateway:PATCH"],
          resources: [
            this.formatArn({
              service: "apigateway",
              resource: "/apis",
              resourceName: api.apiId,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              account: "",
            }),
          ],
        }),
      ]),
    });
    const accessLogs = new LogGroup(this, "EventApiAccessLogs", {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const eventApiStage = new HttpStage(this, "EventApiStage", {
      httpApi: api,
      stageName: props.stageName,
      autoDeploy: true,
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            routeKey: "$context.routeKey",
            status: "$context.status",
            responseLatency: "$context.responseLatency",
            authorizerStatus: "$context.authorizer.status",
          }),
        ),
      },
    });
    const eventApiStageResource = eventApiStage.node.defaultChild as CfnStage;
    eventApiStageResource.defaultRouteSettings = {
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
    };
    if (props.apiDomainName && props.apiCertificateArn) {
      const apiCertificate = Certificate.fromCertificateArn(
        this,
        "ApiCertificate",
        props.apiCertificateArn,
      );
      const apiDomain = new DomainName(this, "EventsApiDomain", {
        domainName: props.apiDomainName,
        certificate: apiCertificate,
        endpointType: EndpointType.REGIONAL,
        securityPolicy: SecurityPolicy.TLS_1_2,
      });
      new ApiMapping(this, "EventsApiMapping", {
        api,
        domainName: apiDomain,
        stage: eventApiStage,
      });
      new CfnOutput(this, "ApiDnsTarget", {
        value: apiDomain.regionalDomainName,
      });
      new CfnOutput(this, "ApiDnsHostedZoneId", {
        value: apiDomain.regionalHostedZoneId,
      });
    }
    new CfnOutput(this, "EventsApiEndpoint", {
      value: props.apiDomainName
        ? `https://${props.apiDomainName}`
        : `${api.apiEndpoint}/${props.stageName}`,
    });
    new CfnOutput(this, "EventsApiId", { value: api.apiId });
    new CfnOutput(this, "DeploymentStage", { value: props.stageName });
    if (props.releaseSha)
      new CfnOutput(this, "ReleaseSha", { value: props.releaseSha });
    new CfnOutput(this, "WebOrigin", { value: webOrigin });
    new CfnOutput(this, "WebDistributionId", {
      value: distribution.distributionId,
    });
    new CfnOutput(this, "WebDnsTarget", {
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, "WebAssetsBucketName", { value: assets.bucketName });
    new CfnOutput(this, "CognitoIssuer", {
      value: userPool.userPoolProviderUrl,
    });
    new CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "CognitoClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, "ReviewerCognitoClientId", {
      value: reviewerClient.userPoolClientId,
    });
    new CfnOutput(this, "CognitoDomain", { value: domain.baseUrl() });
    new CfnOutput(this, "CognitoScope", { value: "events/events:read" });
    new CfnOutput(this, "ScoutingReadScope", {
      value: "events/scouting:read",
    });
    new CfnOutput(this, "ScoutingWriteScope", {
      value: "events/scouting:write",
    });
    new CfnOutput(this, "CognitoCallbackUrl", { value: callbackUrl });
    const alarms = [
      new Alarm(this, "ScoutingOutboxPublisherErrorsAlarm", {
        metric: scoutingOutboxPublisher.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingOutboxFailuresAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/Scouting",
          metricName: "OutboxFailure",
          dimensionsMap: { Component: "outbox" },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingOutboxPublisherDlqAlarm", {
        metric:
          scoutingOutboxPublisherDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingOutboxIteratorAgeAlarm", {
        metric: scoutingOutboxPublisher.metric("IteratorAge", {
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 300_000,
        evaluationPeriods: 2,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingOutboxLagAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/Scouting",
          metricName: "OutboxLagMilliseconds",
          dimensionsMap: { Component: "outbox" },
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 300_000,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingDispatcherErrorsAlarm", {
        metric: scoutingDispatcher.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingDispatchFailuresAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/Scouting",
          metricName: "DispatchFailure",
          dimensionsMap: { Component: "dispatcher" },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingWorkflowWorkerErrorsAlarm", {
        metric: scoutingWorkflowWorker.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingDispatchDlqAlarm", {
        metric: scoutingDispatchDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingDispatchOldestMessageAlarm", {
        metric: scoutingDispatchQueue.metricApproximateAgeOfOldestMessage(),
        threshold: 300,
        evaluationPeriods: 2,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingWorkflowFailuresAlarm", {
        metric: scoutingWorkflow.metricFailed(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScoutingWorkflowTimeoutsAlarm", {
        metric: scoutingWorkflow.metricTimedOut(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "PaperPickWorkerErrorsAlarm", {
        metric: paperPickWorker.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "PaperPickDlqAlarm", {
        metric: paperPickDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "PaperPickWorkflowFailuresAlarm", {
        metric: paperPickWorkflow.metricFailed(),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "PaperPickLimitAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/PaperPicks",
          metricName: "Limits",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "LiveOddsIngestionErrorsAlarm", {
        metric: liveOdds.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "LiveOddsControlPlaneDlqAlarm", {
        metric: liveOddsDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "FixtureOddsProjectionErrorsAlarm", {
        metric: oddsProjection.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "FixtureOddsProjectionFailuresAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OddsProjection",
          metricName: "ProjectionFailure",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "FixtureOddsProjectionLagAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OddsProjection",
          metricName: "ProjectionLagMilliseconds",
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 300_000,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "FixtureOddsProjectionDlqAlarm", {
        metric: oddsProjectionDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "OddsControlPlaneLeagueFailureAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OddsControlPlane",
          metricName: "OddsLeagueFailure",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "OddsSplitFailureAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OddsControlPlane",
          metricName: "OddsSplitFailure",
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "ScheduledBoardOddsFreshnessAlarm", {
        // Measures the served boards, not provider health: age of the newest
        // priced evidence across scheduled boards with upcoming games. An
        // empty slate emits nothing, so missing data stays healthy.
        //
        // Snapshot identity is the observed price, so this age is now the time
        // since a price last MOVED, not since we last polled. A genuinely quiet
        // market can sit still for a long while without anything being wrong,
        // so the threshold buys enough room to never page on a calm board while
        // still catching the failure mode it exists for: both real incidents
        // (the 16-hour odds freeze and the 20-hour splits stall) ran far past
        // two hours.
        metric: new Metric({
          namespace: "FindTheEdge/Boards",
          metricName: "ScheduledBoardOddsAgeSeconds",
          statistic: "Maximum",
          period: Duration.minutes(15),
        }),
        threshold: 7_200,
        evaluationPeriods: 2,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
      new Alarm(this, "OddsControlPlaneCadenceLagAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OddsControlPlane",
          metricName: "OddsCadenceLagSeconds",
          statistic: "Maximum",
          period: Duration.minutes(15),
        }),
        threshold: 3_600,
        evaluationPeriods: 2,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "OddsControlPlaneQuotaReserveAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OddsControlPlane",
          metricName: "OddsQuotaReserveSkip",
          statistic: "Sum",
          period: Duration.minutes(15),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      ...[
        "OddsCommandOutcome",
        "OddsProviderHealthUnavailable",
        "OddsRateWindowBlocked",
        "OddsMarketSuspended",
        "OddsPartialEvidence",
      ].map(
        (metricName) =>
          new Alarm(this, `${metricName}Alarm`, {
            metric: new Metric({
              namespace: "FindTheEdge/OddsControlPlane",
              metricName,
              statistic: "Sum",
              period: Duration.minutes(5),
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator:
              ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          }),
      ),
      new Alarm(this, "CompletedResultsErrorsAlarm", {
        metric: completedResults.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "OpportunityExpirationFailuresAlarm", {
        metric: opportunityExpiration.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "OpportunityGenerationFailuresAlarm", {
        metric: opportunityGeneration.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "OpportunityStaleActiveAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/OpportunityLifecycle",
          metricName: "StaleActiveCount",
          dimensionsMap: { Cause: "sweep", Outcome: "transition" },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      ...[
        ["PaperGradingFailuresAlarm", "PaperGradingFailed"],
        ["PaperGradingUnresolvedAlarm", "PaperGradingUnresolved"],
        ["PaperGradingRegradesAlarm", "PaperGradingRegraded"],
      ].map(
        ([id, metricName]) =>
          new Alarm(this, id!, {
            metric: new Metric({
              namespace: "FindTheEdge/PaperGrading",
              metricName: metricName!,
              statistic: "Sum",
              period: Duration.minutes(15),
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator:
              ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          }),
      ),
      new Alarm(this, "UpcomingEventsDlqAlarm", {
        metric: dlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "UpcomingEventsWorkerErrorsAlarm", {
        metric: worker.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "UpcomingEventsProducerErrorsAlarm", {
        metric: producer.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "UpcomingEventsPartialBatchAlarm", {
        metric: new Metric({
          namespace: "FindTheEdge/UpcomingEvents",
          metricName: "FailedRecords",
          dimensionsMap: { FunctionName: worker.functionName },
          statistic: "Sum",
          period: Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "UpcomingEventsBacklogAlarm", {
        metric: queue.metricApproximateNumberOfMessagesVisible(),
        threshold: 100,
        evaluationPeriods: 2,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "UpcomingEventsOldestMessageAlarm", {
        metric: queue.metricApproximateAgeOfOldestMessage(),
        threshold: 300,
        evaluationPeriods: 2,
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      }),
      new Alarm(this, "EventApiErrorsAlarm", {
        metric: eventApi.metricErrors(),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      new Alarm(this, "EventApiLatencyAlarm", {
        metric: eventApi.metricDuration(),
        threshold: 2000,
        evaluationPeriods: 2,
      }),
      ...(
        [
          "list",
          "detail",
          "performance-list",
          "performance-reports",
          "performance-detail",
          "performance-members",
          "retrospective-list",
          "retrospective-detail",
          "retrospective-versions",
          "retrospective-review",
          "experiment-list",
          "experiment-detail",
          "experiment-approve",
          "experiment-promote",
          "experiment-rollback",
          "opportunity-list",
          "opportunity-detail",
          "provider-status",
          "scout-create",
          "scout-status",
          "scout-retry",
        ] as const
      ).map(
        (route) =>
          new Alarm(this, `EventApiCaught5xx${route}Alarm`, {
            metric: new Metric({
              namespace: "FindTheEdge/EventApi",
              metricName: "Caught5xx",
              dimensionsMap: { Route: route },
              statistic: "Sum",
              period: Duration.minutes(1),
            }),
            threshold: 1,
            evaluationPeriods: 1,
          }),
      ),
      ...(
        [
          "CohortBuildFailures",
          "PerformanceReportFailures",
          "RetrospectiveFailures",
          "RetrospectiveValidationFailures",
        ] as const
      ).map(
        (metricName) =>
          new Alarm(this, `${metricName}Alarm`, {
            metric: new Metric({
              namespace: "FindTheEdge/Performance",
              metricName,
              statistic: "Sum",
              period: Duration.minutes(5),
            }),
            threshold: 1,
            evaluationPeriods: 1,
          }),
      ),
      ...(
        [
          "RetrospectiveReviewConflict",
          "RetrospectiveReviewForbidden",
          "StrategyPromotionConflict",
          "StrategyPromotionForbidden",
        ] as const
      ).map(
        (metricName) =>
          new Alarm(this, `${metricName}Alarm`, {
            metric: new Metric({
              namespace: "FindTheEdge/EventApi",
              metricName,
              dimensionsMap: {
                Route: metricName.startsWith("Strategy")
                  ? "experiment-promote"
                  : "retrospective-review",
              },
              statistic: "Sum",
              period: Duration.minutes(5),
            }),
            threshold: 5,
            evaluationPeriods: 1,
          }),
      ),
      ...(["OpportunityJoinFailure", "OpportunityStaleRead"] as const).map(
        (metricName) =>
          new Alarm(this, `${metricName}Alarm`, {
            metric: new Metric({
              namespace: "FindTheEdge/EventApi",
              metricName,
              dimensionsMap: { Route: "opportunity-list" },
              statistic: "Sum",
              period: Duration.minutes(5),
            }),
            threshold: 1,
            evaluationPeriods: 1,
          }),
      ),
    ];
    if (props.alarmTopicArn) {
      const topic = Topic.fromTopicArn(
        this,
        "UpcomingEventsAlarmTopic",
        props.alarmTopicArn,
      );
      for (const alarm of alarms) alarm.addAlarmAction(new SnsAction(topic));
    }
    if (props.alarmEmail) {
      // An alarm that notifies nobody is a dashboard curiosity; the
      // expiration worker failed silently for weeks behind exactly that gap.
      const notifications = new Topic(this, "AlarmNotifications");
      notifications.addSubscription(new EmailSubscription(props.alarmEmail));
      for (const alarm of alarms) {
        alarm.addAlarmAction(new SnsAction(notifications));
        alarm.addOkAction(new SnsAction(notifications));
      }
    }
  }
}

export function createFoundationApp(config: FoundationConfig): {
  app: App;
  stack: FoundationStack;
} {
  if (!/^[a-z][a-z0-9-]*$/.test(config.stage)) {
    throw new Error(
      "FTE_AWS_STAGE must start with a lowercase letter and contain only lowercase letters, numbers, or hyphens",
    );
  }
  if (config.releaseSha && !/^[0-9a-f]{40}$/.test(config.releaseSha))
    throw new Error("FTE_RELEASE_SHA must be a lowercase 40-character Git SHA");
  const customDomainValues = [
    config.webDomainName,
    config.apiDomainName,
    config.webCertificateArn,
    config.apiCertificateArn,
  ];
  const customDomainsEnabled = customDomainValues.every(Boolean);
  if (customDomainValues.some(Boolean) && !customDomainsEnabled)
    throw new Error(
      "Custom domain configuration requires both domain names and both certificate ARNs",
    );
  if (customDomainsEnabled) {
    const domainPattern =
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
    if (
      !domainPattern.test(config.webDomainName!) ||
      !domainPattern.test(config.apiDomainName!) ||
      config.webDomainName === config.apiDomainName
    )
      throw new Error("Custom domain names must be distinct safe DNS names");
    const certificatePattern =
      /^arn:aws:acm:([a-z0-9-]+):(\d{12}):certificate\/[0-9a-f-]{36}$/;
    const webCertificate = config.webCertificateArn!.match(certificatePattern);
    const apiCertificate = config.apiCertificateArn!.match(certificatePattern);
    if (!webCertificate || webCertificate[1] !== "us-east-1")
      throw new Error("The CloudFront certificate must be in us-east-1");
    if (
      !apiCertificate ||
      (config.region && apiCertificate[1] !== config.region)
    )
      throw new Error("The API certificate must be in the API stack region");
  }
  if (config.fixtureOddsSeedEnabled && config.stage !== "dev")
    throw new Error("fixture odds seed can only be enabled for the dev stage");
  const paperPickGenerationMinutes = config.paperPickGenerationMinutes ?? 15;
  if (
    !Number.isSafeInteger(paperPickGenerationMinutes) ||
    paperPickGenerationMinutes < 1 ||
    paperPickGenerationMinutes > 60 ||
    60 % paperPickGenerationMinutes !== 0
  )
    throw new Error(
      "paper-pick generation minutes must be a positive divisor of 60",
    );
  if (!config.cursorSecretArn) throw new Error("cursor secret ARN is required");
  if (config.webOrigin) {
    let legacyOrigin: URL;
    try {
      legacyOrigin = new URL(config.webOrigin);
    } catch {
      throw new Error("FTE_WEB_ORIGIN must be an exact HTTPS origin");
    }
    if (
      legacyOrigin.origin !== config.webOrigin ||
      (legacyOrigin.protocol !== "https:" &&
        !(
          legacyOrigin.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(legacyOrigin.hostname)
        ))
    )
      throw new Error("FTE_WEB_ORIGIN must be an exact HTTPS origin");
  }
  const alarmArn = config.alarmTopicArn;
  const alarmMatch = alarmArn?.match(
    /^arn:(aws|aws-us-gov|aws-cn):sns:([a-z]{2}(?:-gov)?-[a-z]+-\d):\d{12}:[A-Za-z0-9_-]{1,256}$/,
  );
  if (
    alarmArn &&
    (!alarmMatch || (config.region && alarmMatch[2] !== config.region))
  )
    throw new Error(
      "FTE_UPCOMING_ALARM_TOPIC_ARN must be a valid SNS ARN in the stack region",
    );

  if (
    config.alarmEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.alarmEmail)
  )
    throw new Error("FTE_ALARM_EMAIL must be a plain email address");

  const app = new App({ analyticsReporting: false });
  const environment =
    config.account && config.region
      ? { account: config.account, region: config.region }
      : undefined;
  const stack = new FoundationStack(
    app,
    `FindTheEdge-${config.stage}-Foundation`,
    {
      description:
        "FIND THE EDGE checkpointed upcoming-event ingestion with a config-controlled scheduler producer.",
      schedulerEnabled: config.schedulerEnabled ?? false,
      paperPickSchedulerEnabled: config.paperPickSchedulerEnabled ?? false,
      paperPickGenerationMinutes,
      stageName: config.stage,
      ...(config.releaseSha ? { releaseSha: config.releaseSha } : {}),
      ...(customDomainsEnabled
        ? {
            webDomainName: config.webDomainName!,
            apiDomainName: config.apiDomainName!,
            webCertificateArn: config.webCertificateArn!,
            apiCertificateArn: config.apiCertificateArn!,
          }
        : {}),
      cursorSecretArn: config.cursorSecretArn,
      fixtureOddsSeedEnabled: config.fixtureOddsSeedEnabled ?? false,
      ...(config.alarmTopicArn ? { alarmTopicArn: config.alarmTopicArn } : {}),
      ...(config.alarmEmail ? { alarmEmail: config.alarmEmail } : {}),
      ...(environment ? { env: environment } : {}),
    },
  );
  return { app, stack };
}
