import { createFoundationApp } from "./foundation.js";

const launchAccount = "228246988391";
const launchRegion = "us-east-1";
if (
  process.env["CDK_DEFAULT_ACCOUNT"] &&
  process.env["CDK_DEFAULT_ACCOUNT"] !== launchAccount
)
  throw new Error(`CDK_DEFAULT_ACCOUNT must be ${launchAccount}`);
if (
  process.env["CDK_DEFAULT_REGION"] &&
  process.env["CDK_DEFAULT_REGION"] !== launchRegion
)
  throw new Error(`CDK_DEFAULT_REGION must be ${launchRegion}`);

const stage = process.env["FTE_AWS_STAGE"] ?? "local";
const rawSchedulerEnabled = process.env["FTE_UPCOMING_SCHEDULER_ENABLED"];
const rawFixtureOddsSeedEnabled = process.env["FTE_FIXTURE_ODDS_SEED_ENABLED"];
if (
  rawSchedulerEnabled !== undefined &&
  rawSchedulerEnabled !== "true" &&
  rawSchedulerEnabled !== "false"
)
  throw new Error("FTE_UPCOMING_SCHEDULER_ENABLED must be true or false");
if (
  rawFixtureOddsSeedEnabled !== undefined &&
  rawFixtureOddsSeedEnabled !== "true" &&
  rawFixtureOddsSeedEnabled !== "false"
)
  throw new Error("FTE_FIXTURE_ODDS_SEED_ENABLED must be true or false");
const { app } = createFoundationApp({
  stage,
  schedulerEnabled: rawSchedulerEnabled === "true",
  fixtureOddsSeedEnabled: rawFixtureOddsSeedEnabled === "true",
  ...(process.env["FTE_EVENT_CURSOR_SECRET_ARN"]
    ? { cursorSecretArn: process.env["FTE_EVENT_CURSOR_SECRET_ARN"] }
    : {}),
  ...(process.env["FTE_UPCOMING_ALARM_TOPIC_ARN"]
    ? { alarmTopicArn: process.env["FTE_UPCOMING_ALARM_TOPIC_ARN"] }
    : {}),
  account: launchAccount,
  region: launchRegion,
});

app.synth();
