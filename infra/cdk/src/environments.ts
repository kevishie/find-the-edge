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
