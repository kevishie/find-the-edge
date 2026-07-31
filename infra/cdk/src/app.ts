import { createFoundationApp } from "./foundation.js";

const stage = process.env["FTE_AWS_STAGE"] ?? "local";
const rawSchedulerEnabled = process.env["FTE_UPCOMING_SCHEDULER_ENABLED"];
if (
  rawSchedulerEnabled !== undefined &&
  rawSchedulerEnabled !== "true" &&
  rawSchedulerEnabled !== "false"
)
  throw new Error("FTE_UPCOMING_SCHEDULER_ENABLED must be true or false");
const { app } = createFoundationApp({
  stage,
  schedulerEnabled: rawSchedulerEnabled === "true",
  ...(process.env["FTE_UPCOMING_ALARM_TOPIC_ARN"]
    ? { alarmTopicArn: process.env["FTE_UPCOMING_ALARM_TOPIC_ARN"] }
    : {}),
  ...(process.env["CDK_DEFAULT_ACCOUNT"]
    ? { account: process.env["CDK_DEFAULT_ACCOUNT"] }
    : {}),
  ...(process.env["CDK_DEFAULT_REGION"]
    ? { region: process.env["CDK_DEFAULT_REGION"] }
    : {}),
});

app.synth();
