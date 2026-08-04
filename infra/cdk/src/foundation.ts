import {
  App,
  ArnFormat,
  Duration,
  RemovalPolicy,
  Stack,
  CfnOutput,
  type StackProps,
} from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Alarm, ComparisonOperator, Metric } from "aws-cdk-lib/aws-cloudwatch";
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
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  AccountRecovery,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
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
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Topic } from "aws-cdk-lib/aws-sns";
import {
  DefinitionBody,
  Fail,
  JsonPath,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  LambdaInvoke,
  SqsSendMessage,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  CfnStage,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigatewayv2";
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
  account?: string;
  region?: string;
  schedulerEnabled?: boolean;
  paperPickSchedulerEnabled?: boolean;
  paperPickGenerationMinutes?: number;
  alarmTopicArn?: string;
  cursorSecretArn?: string;
  fixtureOddsSeedEnabled?: boolean;
  webOrigin?: string;
}

interface FoundationStackProps extends StackProps {
  schedulerEnabled: boolean;
  paperPickSchedulerEnabled: boolean;
  paperPickGenerationMinutes: number;
  alarmTopicArn?: string;
  stageName: string;
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
    const resourceServer = new UserPoolResourceServer(
      this,
      "EventsResourceServer",
      {
        identifier: "events",
        userPool,
        scopes: [readScope],
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
        "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/games' || request.uri.indexOf('/games/') === 0 || request.uri === '/splits' || request.uri === '/performance') {\n    request.uri = '/index.html';\n  }\n  return request;\n}",
      ),
    });
    const distribution = new Distribution(this, "WebDistribution", {
      defaultRootObject: "index.html",
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
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
    const webOrigin = `https://${distribution.distributionDomainName}`;
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
          OAuthScope.OPENID,
          OAuthScope.EMAIL,
          OAuthScope.resourceServer(resourceServer, readScope),
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
    const oddsSecret = Secret.fromSecretNameV2(
      this,
      "TheOddsApiSecret",
      `find-the-edge/${props.stageName}/the-odds-api`,
    );
    // SharpAPI is primary; The Odds API remains configured as operator-selected standby.
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
        FTE_THE_ODDS_API_SECRET_ID: oddsSecret.secretName,
        FTE_SHARP_API_ENABLED: "true",
        FTE_SHARP_API_SECRET_ID: sharpApiSecret.secretName,
      },
      bundling: { minify: true, sourceMap: true },
    });
    oddsSecret.grantRead(liveOdds);
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
    liveOdds.addEventSource(
      new SqsEventSource(liveOddsQueue, {
        batchSize: 1,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );
    const liveOddsScheduler = new Rule(this, "LiveOddsScheduler", {
      enabled: props.schedulerEnabled,
      schedule: Schedule.rate(Duration.minutes(15)),
    });
    liveOddsScheduler.addTarget(
      new SqsQueue(liveOddsQueue, { messageGroupId: "odds-cadence" }),
    );
    new CfnOutput(this, "LiveOddsIngestionFunctionName", {
      value: liveOdds.functionName,
    });
    new CfnOutput(this, "TheOddsApiSecretName", {
      value: oddsSecret.secretName,
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
    const eventApi = new NodejsFunction(this, "EventApi", {
      entry: path.resolve(directory, "../../../apps/api/src/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        FTE_EVENT_TABLE_NAME: table.tableName,
        FTE_EVENT_CURSOR_SECRET_ARN: props.cursorSecretArn,
      },
      bundling: { minify: true, sourceMap: true },
    });
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:TransactGetItems",
        ],
        resources: [table.tableArn],
      }),
    );
    eventApi.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.cursorSecretArn],
      }),
    );
    const api = new HttpApi(this, "EventsHttpApi", {
      createDefaultStage: false,
    });
    const exactCsp = `default-src 'self'; base-uri 'none'; connect-src 'self' ${api.apiEndpoint}; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'`;
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
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
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
      path: "/games",
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
    ])
      api.addRoutes({
        path,
        methods: [HttpMethod.GET],
        integration,
      });
    const configureCorsCall = {
      service: "ApiGatewayV2",
      action: "updateApi",
      parameters: {
        ApiId: api.apiId,
        CorsConfiguration: {
          AllowOrigins: [webOrigin],
          AllowHeaders: ["authorization", "content-type"],
          AllowMethods: ["GET", "OPTIONS"],
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
    new CfnOutput(this, "EventsApiEndpoint", {
      value: `${api.apiEndpoint}/${props.stageName}`,
    });
    new CfnOutput(this, "WebOrigin", { value: webOrigin });
    new CfnOutput(this, "WebDistributionId", {
      value: distribution.distributionId,
    });
    new CfnOutput(this, "WebAssetsBucketName", { value: assets.bucketName });
    new CfnOutput(this, "CognitoIssuer", {
      value: userPool.userPoolProviderUrl,
    });
    new CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "CognitoClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, "CognitoDomain", { value: domain.baseUrl() });
    new CfnOutput(this, "CognitoScope", { value: "events/events:read" });
    new CfnOutput(this, "CognitoCallbackUrl", { value: callbackUrl });
    const alarms = [
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
      new Alarm(this, "CompletedResultsErrorsAlarm", {
        metric: completedResults.metricErrors(),
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
      ...(["CohortBuildFailures", "PerformanceReportFailures"] as const).map(
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
    ];
    if (props.alarmTopicArn) {
      const topic = Topic.fromTopicArn(
        this,
        "UpcomingEventsAlarmTopic",
        props.alarmTopicArn,
      );
      for (const alarm of alarms) alarm.addAlarmAction(new SnsAction(topic));
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
      cursorSecretArn: config.cursorSecretArn,
      fixtureOddsSeedEnabled: config.fixtureOddsSeedEnabled ?? false,
      ...(config.alarmTopicArn ? { alarmTopicArn: config.alarmTopicArn } : {}),
      ...(environment ? { env: environment } : {}),
    },
  );
  return { app, stack };
}
