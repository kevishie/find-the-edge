export * from "./feed-coverage";

export type RuntimeEnvironment = "development" | "test" | "production";
export type ConfigProfile = "local" | "provider" | "aws";

export interface RuntimeConfig {
  environment: RuntimeEnvironment;
  applicationName: string;
  port: number;
  fixtureMode: boolean;
  provider?: {
    oddsApiKey: string;
  };
  aws?: {
    region: string;
    stage: string;
  };
}

export interface ConfigIssue {
  variable: string;
  code: "missing" | "malformed";
  message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `Configuration validation failed: ${issues
        .map(({ variable, message }) => `${variable} ${message}`)
        .join("; ")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

function required(
  input: Readonly<Record<string, string | undefined>>,
  variable: string,
  issues: ConfigIssue[],
): string | undefined {
  const value = input[variable]?.trim();
  if (!value) {
    issues.push({
      variable,
      code: "missing",
      message: "is required for this profile",
    });
    return undefined;
  }
  return value;
}

export function validateEnvironment(
  input: Readonly<Record<string, string | undefined>>,
  profile: ConfigProfile = "local",
): RuntimeConfig {
  const issues: ConfigIssue[] = [];
  const environment = input["NODE_ENV"] ?? "development";
  if (!["development", "test", "production"].includes(environment)) {
    issues.push({
      variable: "NODE_ENV",
      code: "malformed",
      message: "must be development, test, or production",
    });
  }

  const port = Number(input["FTE_PORT"] ?? "5173");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push({
      variable: "FTE_PORT",
      code: "malformed",
      message: "must be an integer from 1 through 65535",
    });
  }

  const oddsApiKey =
    profile === "provider"
      ? required(input, "ODDS_API_KEY", issues)
      : input["ODDS_API_KEY"];
  const awsRegion =
    profile === "aws" ? required(input, "AWS_REGION", issues) : undefined;
  const awsStage =
    profile === "aws" ? required(input, "FTE_AWS_STAGE", issues) : undefined;

  if (issues.length > 0) throw new ConfigValidationError(issues);

  return {
    environment: environment as RuntimeEnvironment,
    applicationName: input["FTE_APPLICATION_NAME"] ?? "find-the-edge",
    port,
    fixtureMode: profile === "local",
    ...(oddsApiKey ? { provider: { oddsApiKey } } : {}),
    ...(awsRegion && awsStage
      ? { aws: { region: awsRegion, stage: awsStage } }
      : {}),
  };
}
