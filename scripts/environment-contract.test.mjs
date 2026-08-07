import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentEnvironment,
  validateDeploymentBranch,
} from "./environment-contract.mjs";

test("staging and prod have isolated immutable deployment contracts", () => {
  assert.deepEqual(deploymentEnvironment("staging"), {
    stage: "staging",
    branch: "main",
    githubEnvironment: "staging",
    stack: "FindTheEdge-staging-Foundation",
    secretPrefix: "find-the-edge/staging",
    webOrigin: "https://staging.kevishie.com",
    apiBase: "https://api-staging.kevishie.com",
  });
  assert.deepEqual(deploymentEnvironment("prod"), {
    stage: "prod",
    branch: "production",
    githubEnvironment: "production",
    stack: "FindTheEdge-prod-Foundation",
    secretPrefix: "find-the-edge/prod",
    webOrigin: "https://kevishie.com",
    apiBase: "https://api.kevishie.com",
  });
});

test("stage and branch validation fail closed", () => {
  for (const stage of ["dev", "production", "qa", "", "PROD"])
    assert.throws(() => deploymentEnvironment(stage), /stage/i);
  assert.doesNotThrow(() => validateDeploymentBranch("staging", "main"));
  assert.doesNotThrow(() => validateDeploymentBranch("prod", "production"));
  assert.throws(
    () => validateDeploymentBranch("staging", "production"),
    /branch/i,
  );
  assert.throws(() => validateDeploymentBranch("prod", "main"), /branch/i);
});
