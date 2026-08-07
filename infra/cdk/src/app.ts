import { createFoundationApp } from "./foundation.js";
import { resolveEnvironment } from "./environments.js";

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
const deploymentEnvironment = resolveEnvironment(stage, {
  allowLegacyDev: process.env["FTE_ALLOW_LEGACY_DEV"] === "1",
});
const rawSchedulerEnabled = process.env["FTE_UPCOMING_SCHEDULER_ENABLED"];
const rawFixtureOddsSeedEnabled = process.env["FTE_FIXTURE_ODDS_SEED_ENABLED"];
const rawPaperPickSchedulerEnabled =
  process.env["FTE_PAPER_PICK_SCHEDULER_ENABLED"];
const rawPaperPickGenerationMinutes =
  process.env["FTE_PAPER_PICK_GENERATION_MINUTES"];
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
if (
  rawPaperPickSchedulerEnabled !== undefined &&
  rawPaperPickSchedulerEnabled !== "true" &&
  rawPaperPickSchedulerEnabled !== "false"
)
  throw new Error("FTE_PAPER_PICK_SCHEDULER_ENABLED must be true or false");
const paperPickGenerationMinutes = rawPaperPickGenerationMinutes
  ? Number(rawPaperPickGenerationMinutes)
  : 15;
if (
  !Number.isSafeInteger(paperPickGenerationMinutes) ||
  paperPickGenerationMinutes < 1 ||
  paperPickGenerationMinutes > 60 ||
  60 % paperPickGenerationMinutes !== 0
)
  throw new Error(
    "FTE_PAPER_PICK_GENERATION_MINUTES must be a positive divisor of 60",
  );
const { app } = createFoundationApp({
  stage,
  ...(process.env["FTE_RELEASE_SHA"]
    ? { releaseSha: process.env["FTE_RELEASE_SHA"] }
    : {}),
  ...(deploymentEnvironment.webDomainName
    ? {
        webDomainName: deploymentEnvironment.webDomainName,
        apiDomainName: deploymentEnvironment.apiDomainName!,
        webCertificateArn: process.env["FTE_WEB_CERTIFICATE_ARN"] ?? "",
        apiCertificateArn: process.env["FTE_API_CERTIFICATE_ARN"] ?? "",
      }
    : {}),
  schedulerEnabled: rawSchedulerEnabled === "true",
  fixtureOddsSeedEnabled: rawFixtureOddsSeedEnabled === "true",
  paperPickSchedulerEnabled: rawPaperPickSchedulerEnabled === "true",
  paperPickGenerationMinutes,
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
