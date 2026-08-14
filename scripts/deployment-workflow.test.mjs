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
    "product_access_enforced: ${{ steps.target.outputs.product_access_enforced }}",
    "FTE_PRODUCT_ACCESS_ENFORCED: ${{ needs.target.outputs.product_access_enforced }}",
  ])
    assert.ok(
      workflow.includes(required),
      `missing workflow contract: ${required}`,
    );
  assert.doesNotMatch(workflow, /find-the-edge\/dev\//);
  assert.doesNotMatch(workflow, /phase1-development-environment/);
  assert.ok(
    workflow.indexOf("Refuse premature product-access cutover") <
      workflow.indexOf("Install environment SharpAPI credential"),
    "product access must be validated before the first cloud mutation",
  );
  assert.equal(
    workflow.match(/echo "product_access_enforced=false"/g)?.length,
    2,
    "both protected branch cases must bind their own explicit false value",
  );
  assert.match(workflow, /test "\$FTE_PRODUCT_ACCESS_ENFORCED" = "false"/);
  assert.doesNotMatch(workflow, /PRODUCT_ACCESS_POLICY|vars\.PRODUCT_ACCESS/);
  for (const command of [
    "aws apigatewayv2 get-routes",
    "aws apigatewayv2 get-integration",
    "aws lambda get-function-configuration",
  ])
    assert.ok(workflow.includes(command), `missing live readback: ${command}`);
  assert.ok(
    workflow.indexOf("Deploy and run environment smoke") <
      workflow.indexOf("Verify live product-access setting"),
    "live setting must be read after deployment",
  );
  assert.match(workflow, /\^arn:aws:lambda:us-east-1:228246988391:function:/);
  assert.doesNotMatch(workflow, /function_name=\$\{function_name%%:\*\}/);

  const quality = await read(".github/workflows/ci.yml");
  assert.match(quality, /FTE_PRODUCT_ACCESS_ENFORCED:\s*["']false["']/);
  assert.match(quality, /FTE_AWS_STAGE=staging pnpm phase1:preflight/);
  assert.match(quality, /FTE_AWS_STAGE=prod pnpm phase1:preflight/);
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

test("authorization provisioning is branch-bound, serialized, and uses a dedicated exact-key role", async () => {
  const workflow = await read(
    ".github/workflows/provision-identity-authorization.yml",
  );
  for (const required of [
    "workflow_dispatch:",
    "main)",
    "production)",
    "environment: ${{ needs.target.outputs.github_environment }}",
    "phase1-${{ needs.target.outputs.stage }}-environment",
    "AUTHORIZATION_OPERATOR_ROLE_ARN",
    "SET-ROLES",
    "FTE_AUTHORIZATION_EXPECTED_UPDATED_AT",
    "Refuse an outdated protected-branch revision",
  ])
    assert.ok(
      workflow.includes(required),
      `missing authorization workflow contract: ${required}`,
    );
  assert.doesNotMatch(workflow, /AWS_DEPLOY_ROLE_ARN|secrets\.|pull_request/);
  assert.equal(
    workflow.match(
      /gh api "repos\/\$\{\{ github\.repository \}\}\/commits\/\$BRANCH"/g,
    )?.length,
    2,
    "protected branch freshness must be checked again immediately before provisioning",
  );

  const template = await read("infra/github-actions-deploy-role.yml");
  for (const required of [
    "github-actions-find-the-edge-staging-authorization-operator",
    "github-actions-find-the-edge-production-authorization-operator",
    "cloudformation:DescribeStacks",
    "cloudformation:ListStackResources",
    "dynamodb:DescribeTable",
    "dynamodb:GetItem",
    "dynamodb:ConditionCheckItem",
    "dynamodb:PutItem",
    "dynamodb:EnclosingOperation",
    "TransactWriteItems",
    "dynamodb:LeadingKeys",
    "ACCOUNT#*",
    "FindTheEdge-staging-Foundation-EventIngestionTable*",
    "FindTheEdge-prod-Foundation-EventIngestionTable*",
  ])
    assert.ok(
      template.includes(required),
      `missing authorization role contract: ${required}`,
    );
  const operatorPolicies = template.slice(
    template.indexOf("StagingAuthorizationOperatorRole:"),
  );
  assert.doesNotMatch(
    operatorPolicies,
    /dynamodb:(?:\*|Scan|Query|UpdateItem|DeleteItem|BatchWriteItem|TransactWriteItems)|secretsmanager:/,
  );
});

test("promotion runbook records automatic branch deployments, DNS, rollback, and legacy-dev boundaries", async () => {
  const runbook = await read("docs/environment-promotion.md");
  for (const required of [
    "staging.kevishie.com",
    "api-staging.kevishie.com",
    "kevishie.com",
    "api.kevishie.com",
    "ns-cloud-d1.googledomains.com",
    "173.230.142.141",
    "automatically deploys",
    "hotfix",
    "rollback",
    "FindTheEdge-dev-Foundation",
    "Do not delete",
  ])
    assert.ok(
      runbook.includes(required),
      `missing runbook contract: ${required}`,
    );
  assert.doesNotMatch(runbook, /Required reviewer|manual production-dispatch/i);
});
