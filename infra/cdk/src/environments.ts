export type DeploymentStage = "local" | "staging" | "prod" | "dev";

export interface DeploymentEnvironment {
  stage: DeploymentStage;
  stackName: string;
  secretPrefix: string;
  persistent: boolean;
  legacy: boolean;
  branch?: "main" | "production";
  githubEnvironment?: "staging" | "production";
  webDomainName?: string;
  apiDomainName?: string;
  webOrigin?: string;
  apiOrigin?: string;
}

/** Production-only aggressive/dependent recurrence; staging provider cron is fixed in CDK. */
export function recurringDataPlaneEnabled(stage: DeploymentStage): boolean {
  return stage === "prod";
}

export function resolveRecurringDataPlaneEnabled(
  stage: DeploymentStage,
  value: string | undefined,
): boolean {
  if (value !== undefined && value !== "true" && value !== "false")
    throw new Error("FTE_UPCOMING_SCHEDULER_ENABLED must be true or false");
  if (stage === "staging" || stage === "prod") {
    const expected = recurringDataPlaneEnabled(stage);
    if (value !== undefined && (value === "true") !== expected)
      throw new Error(
        `FTE_UPCOMING_SCHEDULER_ENABLED must be ${String(expected)} for ${stage}`,
      );
    return expected;
  }
  return value === "true";
}

export function resolveProductAccessEnforcement(
  stage: DeploymentStage,
  value: string | undefined,
): boolean {
  if (value === undefined) {
    if (stage === "local") return false;
    throw new Error(
      "FTE_PRODUCT_ACCESS_ENFORCED is required for persistent stages",
    );
  }
  if (value === "true") {
    if (stage !== "local")
      throw new Error(
        "FTE_PRODUCT_ACCESS_ENFORCED must remain false until the owned-access cutover is approved",
      );
    return true;
  }
  if (value === "false") return false;
  throw new Error("FTE_PRODUCT_ACCESS_ENFORCED must be true or false");
}

/**
 * Selects one explicit owner ceremony before admin routes can be synthesized.
 * A new empty environment uses `freshBootstrap=true`; the configured owner's
 * first verified login then creates the entire owner aggregate atomically.
 * An environment containing legacy accounts must instead complete the offline
 * migration/recovery ceremony and set `bootstrapVerified=true`. Deployed stages
 * remain disabled when neither fence is deliberately selected.
 */
export function resolveAdminAccessConfiguration(input: {
  readonly enabled: string | undefined;
  readonly ownerAccountId: string | undefined;
  readonly bootstrapVerified: string | undefined;
  readonly freshBootstrap?: string | undefined;
}): {
  readonly enabled: boolean;
  readonly ownerAccountId?: string;
  readonly bootstrapMode?: "fresh" | "verified";
} {
  const enabled =
    input.enabled === undefined ? false : input.enabled === "true";
  if (
    input.enabled !== undefined &&
    input.enabled !== "true" &&
    input.enabled !== "false"
  )
    throw new Error("FTE_ADMIN_ACCESS_ENABLED must be true or false");
  if (
    input.bootstrapVerified !== undefined &&
    input.bootstrapVerified !== "true" &&
    input.bootstrapVerified !== "false"
  )
    throw new Error("FTE_ADMIN_BOOTSTRAP_VERIFIED must be true or false");
  if (
    input.freshBootstrap !== undefined &&
    input.freshBootstrap !== "true" &&
    input.freshBootstrap !== "false"
  )
    throw new Error("FTE_ADMIN_FRESH_BOOTSTRAP must be true or false");
  if (
    input.ownerAccountId !== undefined &&
    !/^account:[a-f0-9]{64}$/.test(input.ownerAccountId)
  )
    throw new Error("FTE_OWNER_ACCOUNT_ID must be an exact account id");
  if (enabled && !input.ownerAccountId)
    throw new Error(
      "FTE_OWNER_ACCOUNT_ID is required when admin access is enabled",
    );
  if (input.bootstrapVerified === "true" && input.freshBootstrap === "true")
    throw new Error("admin bootstrap mode must be fresh or verified, not both");
  if (
    enabled &&
    input.bootstrapVerified !== "true" &&
    input.freshBootstrap !== "true"
  )
    throw new Error(
      "admin access requires an explicit fresh bootstrap or verified migration",
    );
  return {
    enabled,
    ...(input.ownerAccountId ? { ownerAccountId: input.ownerAccountId } : {}),
    ...(enabled
      ? {
          bootstrapMode:
            input.freshBootstrap === "true"
              ? ("fresh" as const)
              : ("verified" as const),
        }
      : {}),
  };
}

const persistentEnvironments = {
  staging: {
    stage: "staging",
    stackName: "FindTheEdge-staging-Foundation",
    secretPrefix: "find-the-edge/staging",
    persistent: true,
    legacy: false,
    branch: "main",
    githubEnvironment: "staging",
    webDomainName: "staging.kevishie.com",
    apiDomainName: "api-staging.kevishie.com",
    webOrigin: "https://staging.kevishie.com",
    apiOrigin: "https://api-staging.kevishie.com",
  },
  prod: {
    stage: "prod",
    stackName: "FindTheEdge-prod-Foundation",
    secretPrefix: "find-the-edge/prod",
    persistent: true,
    legacy: false,
    branch: "production",
    githubEnvironment: "production",
    webDomainName: "kevishie.com",
    apiDomainName: "api.kevishie.com",
    webOrigin: "https://kevishie.com",
    apiOrigin: "https://api.kevishie.com",
  },
} as const satisfies Record<"staging" | "prod", DeploymentEnvironment>;

export function resolveEnvironment(
  stage: string,
  options: { allowLegacyDev?: boolean } = {},
): DeploymentEnvironment {
  if (stage === "staging" || stage === "prod")
    return persistentEnvironments[stage];
  if (stage === "local")
    return {
      stage,
      stackName: "FindTheEdge-local-Foundation",
      secretPrefix: "find-the-edge/local",
      persistent: false,
      legacy: false,
    };
  if (stage === "dev") {
    if (!options.allowLegacyDev)
      throw new Error(
        "The dev stage is legacy and requires an explicit allowLegacyDev migration fence",
      );
    return {
      stage,
      stackName: "FindTheEdge-dev-Foundation",
      secretPrefix: "find-the-edge/dev",
      persistent: true,
      legacy: true,
    };
  }
  throw new Error(
    "FTE_AWS_STAGE must be local, staging, or prod (legacy dev requires an explicit fence)",
  );
}
