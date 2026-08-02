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
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
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
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
  alarmTopicArn?: string;
  cursorSecretArn?: string;
  fixtureOddsSeedEnabled?: boolean;
  webOrigin?: string;
}

interface FoundationStackProps extends StackProps {
  schedulerEnabled: boolean;
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
        "function handler(event) {\n  var request = event.request;\n  if (request.uri === '/games' || request.uri === '/auth/callback') {\n    request.uri = '/index.html';\n  }\n  return request;\n}",
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
      enabled: props.schedulerEnabled,
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
    const exactCsp = `default-src 'self'; base-uri 'none'; connect-src 'self' ${api.apiEndpoint} ${domain.baseUrl()}; form-action 'self' ${domain.baseUrl()}; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'`;
    for (const policy of [securityHeaders, immutableHeaders]) {
      const resource = policy.node.defaultChild as CfnResponseHeadersPolicy;
      resource.addPropertyOverride(
        "ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy",
        exactCsp,
      );
    }
    const authorizer = new HttpJwtAuthorizer(
      "EventsJwt",
      userPool.userPoolProviderUrl,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      },
    );
    const integration = new HttpLambdaIntegration(
      "EventsIntegration",
      eventApi,
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
      authorizer,
      authorizationScopes: ["events/events:read"],
    });
    api.addRoutes({
      path: "/games",
      methods: [HttpMethod.GET],
      integration,
      authorizer,
      authorizationScopes: ["events/events:read"],
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
    new HttpStage(this, "EventApiStage", {
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
      ...(["list", "detail"] as const).map(
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
      stageName: config.stage,
      cursorSecretArn: config.cursorSecretArn,
      fixtureOddsSeedEnabled: config.fixtureOddsSeedEnabled ?? false,
      ...(config.alarmTopicArn ? { alarmTopicArn: config.alarmTopicArn } : {}),
      ...(environment ? { env: environment } : {}),
    },
  );
  return { app, stack };
}
