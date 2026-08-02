import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  projectRoot,
  run,
  safeDevConfig,
  validateSafeDevConfig,
  validateTemplate,
} from "./phase1-support.mjs";

export async function phase1Preflight(environment = process.env) {
  const config = safeDevConfig(environment);
  validateSafeDevConfig(config);
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19))
    throw new Error("Node 20.19 or newer is required");
  const packageManifest = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf8"),
  );
  const expectedPnpm = packageManifest.packageManager?.match(
    /^pnpm@(\d+\.\d+\.\d+)$/,
  )?.[1];
  if (!expectedPnpm)
    throw new Error("packageManager must pin an exact pnpm version");
  const actualPnpm = run("pnpm", ["--version"], { capture: true }).trim();
  if (actualPnpm !== expectedPnpm)
    throw new Error(`pnpm ${expectedPnpm} is required`);
  const synthEnvironment = {
    ...environment,
    FTE_AWS_STAGE: config.stage,
    FTE_JWT_ISSUER: config.issuer,
    FTE_JWT_AUDIENCE: config.audience,
    FTE_EVENT_CURSOR_SECRET_ARN: config.cursorSecretArn,
    FTE_WEB_ORIGIN: config.webOrigin,
    FTE_FIXTURE_ODDS_SEED_ENABLED: "false",
    FTE_UPCOMING_SCHEDULER_ENABLED: "true",
    CDK_DEFAULT_ACCOUNT: "228246988391",
    CDK_DEFAULT_REGION: "us-east-1",
  };
  run("pnpm", ["--filter", "@find-the-edge/infra-cdk", "synth"], {
    env: synthEnvironment,
  });
  const templatePath = resolve(
    projectRoot,
    "infra/cdk/cdk.out/FindTheEdge-dev-Foundation.template.json",
  );
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  validateTemplate(template, config);
  return { config, templatePath };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  phase1Preflight()
    .then(({ templatePath }) => {
      process.stdout.write(
        `Phase1 preflight passed (credential-free): ${templatePath}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `Phase1 preflight failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    });
}
