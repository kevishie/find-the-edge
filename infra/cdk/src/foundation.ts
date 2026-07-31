import {
  App,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Alarm, ComparisonOperator, Metric } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Topic } from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FoundationConfig {
  stage: string;
  account?: string;
  region?: string;
  schedulerEnabled?: boolean;
  alarmTopicArn?: string;
}

interface FoundationStackProps extends StackProps {
  schedulerEnabled: boolean;
  alarmTopicArn?: string;
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
    table.grantReadWriteData(worker);
    table.grant(worker, "dynamodb:TransactWriteItems");
    queue.grantSendMessages(worker);
    worker.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 1,
        maxConcurrency: 5,
        reportBatchItemFailures: true,
      }),
    );
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
      ...(config.alarmTopicArn ? { alarmTopicArn: config.alarmTopicArn } : {}),
      ...(environment ? { env: environment } : {}),
    },
  );
  return { app, stack };
}
