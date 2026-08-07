const DEPLOYMENT_ENVIRONMENTS = Object.freeze({
  staging: Object.freeze({
    stage: "staging",
    branch: "main",
    githubEnvironment: "staging",
    stack: "FindTheEdge-staging-Foundation",
    secretPrefix: "find-the-edge/staging",
    webOrigin: "https://staging.kevishie.com",
    apiBase: "https://api-staging.kevishie.com",
  }),
  prod: Object.freeze({
    stage: "prod",
    branch: "production",
    githubEnvironment: "production",
    stack: "FindTheEdge-prod-Foundation",
    secretPrefix: "find-the-edge/prod",
    webOrigin: "https://kevishie.com",
    apiBase: "https://api.kevishie.com",
  }),
});

export function deploymentEnvironment(stage) {
  const target = DEPLOYMENT_ENVIRONMENTS[stage];
  if (!target)
    throw new Error("FTE_AWS_STAGE must select the staging or prod stage");
  return target;
}

export function validateDeploymentBranch(stage, branch) {
  const target = deploymentEnvironment(stage);
  if (branch !== target.branch)
    throw new Error(`${stage} deployment requires the ${target.branch} branch`);
  return target;
}
