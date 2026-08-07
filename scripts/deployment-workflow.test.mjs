import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("quality gates protect both deployment mainlines", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /branches:\s*\[main, production\]/);
});

test("deployment maps only verified main and production revisions to isolated environments", async () => {
  const workflow = await read(".github/workflows/deploy-phase1.yml");
  for (const required of [
    "branches: [main, production]",
    "head_branch == 'main' ||",
    "head_branch == 'production'",
    "github.event.workflow_run.head_sha",
    "environment: ${{ needs.target.outputs.github_environment }}",
    "phase1-${{ needs.target.outputs.stage }}-environment",
    "FTE_RELEASE_SHA:",
    "FTE_WEB_CERTIFICATE_ARN:",
    "FTE_API_CERTIFICATE_ARN:",
  ])
    assert.ok(
      workflow.includes(required),
      `missing workflow contract: ${required}`,
    );
  assert.doesNotMatch(workflow, /find-the-edge\/dev\//);
  assert.doesNotMatch(workflow, /phase1-development-environment/);
});

test("OIDC bootstrap has isolated environment subjects and no administrator policy", async () => {
  const template = await read("infra/github-actions-deploy-role.yml");
  assert.match(
    template,
    /repo:kevishie@880315\/find-the-edge@1301138962:environment:staging/,
  );
  assert.match(
    template,
    /repo:kevishie@880315\/find-the-edge@1301138962:environment:production/,
  );
  assert.match(template, /github-actions-find-the-edge-staging-deploy/);
  assert.match(template, /github-actions-find-the-edge-production-deploy/);
  assert.doesNotMatch(template, /AdministratorAccess/);
  assert.doesNotMatch(template, /pull_request|environment:\*/);
});

test("promotion runbook records DNS, approval, rollback, and legacy-dev boundaries", async () => {
  const runbook = await read("docs/environment-promotion.md");
  for (const required of [
    "staging.kevishie.com",
    "api-staging.kevishie.com",
    "kevishie.com",
    "api.kevishie.com",
    "ns-cloud-d1.googledomains.com",
    "173.230.142.141",
    "Required reviewer",
    "hotfix",
    "rollback",
    "FindTheEdge-dev-Foundation",
    "Do not delete",
  ])
    assert.ok(
      runbook.includes(required),
      `missing runbook contract: ${required}`,
    );
});
