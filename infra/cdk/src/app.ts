import { createFoundationApp } from "./foundation.js";
import {
  resolveRecurringDataPlaneEnabled,
  resolveEnvironment,
  resolveProductAccessEnforcement,
  resolveAdminAccessConfiguration,
} from "./environments.js";

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
const productAccessEnforced = resolveProductAccessEnforcement(
  deploymentEnvironment.stage,
  process.env["FTE_PRODUCT_ACCESS_ENFORCED"],
);
const adminRolloutMode = process.env["FTE_ADMIN_BOOTSTRAP_MODE"];
if (
  adminRolloutMode !== undefined &&
  !["disabled", "fresh", "verified"].includes(adminRolloutMode)
)
  throw new Error(
    "FTE_ADMIN_BOOTSTRAP_MODE must be disabled, fresh, or verified",
  );
const adminAccess = resolveAdminAccessConfiguration({
  enabled: process.env["FTE_ADMIN_ACCESS_ENABLED"],
  ownerAccountId: process.env["FTE_OWNER_ACCOUNT_ID"] || undefined,
  bootstrapVerified:
    process.env["FTE_ADMIN_BOOTSTRAP_VERIFIED"] ??
    (adminRolloutMode === "verified"
      ? "true"
      : adminRolloutMode
        ? "false"
        : undefined),
  freshBootstrap:
    process.env["FTE_ADMIN_FRESH_BOOTSTRAP"] ??
    (adminRolloutMode === "fresh"
      ? "true"
      : adminRolloutMode
        ? "false"
        : undefined),
});
const rawSchedulerEnabled = process.env["FTE_UPCOMING_SCHEDULER_ENABLED"];
const rawFixtureOddsSeedEnabled = process.env["FTE_FIXTURE_ODDS_SEED_ENABLED"];
const rawPaperPickSchedulerEnabled =
  process.env["FTE_PAPER_PICK_SCHEDULER_ENABLED"];
const rawPaperPickGenerationMinutes =
  process.env["FTE_PAPER_PICK_GENERATION_MINUTES"];
const schedulerEnabled = resolveRecurringDataPlaneEnabled(
  deploymentEnvironment.stage,
  rawSchedulerEnabled,
);
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
  schedulerEnabled,
  fixtureOddsSeedEnabled: rawFixtureOddsSeedEnabled === "true",
  productAccessEnforced,
  adminAccessEnabled: adminAccess.enabled,
  ...(adminAccess.bootstrapMode
    ? { adminBootstrapMode: adminAccess.bootstrapMode }
    : {}),
  ...(adminAccess.ownerAccountId
    ? { ownerAccountId: adminAccess.ownerAccountId }
    : {}),
  paperPickSchedulerEnabled: rawPaperPickSchedulerEnabled === "true",
  paperPickGenerationMinutes,
  ...(process.env["FTE_EVENT_CURSOR_SECRET_ARN"]
    ? { cursorSecretArn: process.env["FTE_EVENT_CURSOR_SECRET_ARN"] }
    : {}),
  ...(process.env["FTE_CRITICAL_ALARM_EMAIL"]
    ? { criticalAlarmEmail: process.env["FTE_CRITICAL_ALARM_EMAIL"] }
    : {}),
  account: launchAccount,
  region: launchRegion,
});

app.synth();
