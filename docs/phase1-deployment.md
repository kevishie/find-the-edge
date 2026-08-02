# Phase1 deployment and environment smoke

Phase1 packages the existing fixture-backed games UI. Preflight, bundle, and test commands are credential-free; `phase1:launch` explicitly creates and updates cloud resources when its opt-in guard is enabled.

The games and odds UI and its read-only API are public and require no account or
token. CloudFront serves an encrypted, private S3 bucket through signed origin
access; direct S3 access is never an application fallback. Existing Cognito
resources remain dormant to avoid destructive identity-resource cleanup during
this release.

## Prerequisites

- Node 20.19 or newer and pnpm 10.28.2.
- For local validation: no AWS login is required.
- For deployment: an authenticated AWS profile/role in account `228246988391`, region `us-east-1`, and the existing Secrets Manager cursor-signing secret.
- For environment smoke: the deployed API and fixture-seed outputs, cursor-secret identifier, and exact hosted browser origin. The full smoke requires the browser URL; it is not an optional partial check.

## Credential-free preflight and bundle

```sh
pnpm phase1:test
pnpm phase1:preflight
FTE_PHASE1_API_BASE=https://api.example.com FTE_WEB_ORIGIN=https://app.example.com pnpm phase1:bundle
```

Preflight synthesizes `FindTheEdge-dev-Foundation` with safe placeholder identifiers and validates anonymous read-only games routes, exact CORS, required outputs, fixture seed enablement, table-scoped DynamoDB IAM, and absence of DynamoDB Scan. It does not call AWS. The bundle is written to ignored `dist/phase1-web`; `phase1-manifest.json` contains sorted SHA-256 checksums, not credentials or tokens. Upload the directory to any static host that serves `index.html` for `/games`; do not cache `runtime-config.js` across deployments.

For an explicit local-only bundle, set `FTE_PHASE1_LOCAL_MODE=1` and use an `http://localhost` or `http://127.0.0.1` API base. HTTP is rejected for every non-local host.

## Guarded launch and outputs

Set `AWS_ACCOUNT_ID=228246988391`, `AWS_REGION=us-east-1`,
`FTE_EVENT_CURSOR_SECRET_ARN`, and `FTE_PHASE1_LAUNCH=1`, then run
`pnpm phase1:launch`. The command rechecks STS
identity immediately before every mutation, rejects retained-table destructive
diffs, deploys the dev stack, generates runtime configuration from stack outputs,
uploads and invalidates the private site, seeds the fixture data, and proves the
anonymous API and browser flow.

The underlying operator commands are shown for diagnosis only:

```sh
aws sts get-caller-identity
export CDK_DEFAULT_ACCOUNT=228246988391
export CDK_DEFAULT_REGION=us-east-1
export FTE_AWS_STAGE=dev
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-dev-cursor
export FTE_FIXTURE_ODDS_SEED_ENABLED=true
export FTE_UPCOMING_SCHEDULER_ENABLED=false
pnpm --filter @find-the-edge/infra-cdk synth
pnpm --filter @find-the-edge/infra-cdk exec cdk deploy FindTheEdge-dev-Foundation --require-approval never --outputs-file /tmp/fte-phase1-outputs.json
aws cloudformation describe-stacks --stack-name FindTheEdge-dev-Foundation --region "$CDK_DEFAULT_REGION" --query 'Stacks[0].Outputs' --output table
```

The launch command consumes all stack outputs directly. Roll back assets by
uploading the prior checksum-verified bundle and invalidating `/*`.
Infrastructure rollback requires a reviewed CDK diff; the event table, dormant
user pool, web bucket, and logs are retained.

## Seed, API, CORS, and browser smoke

`phase1:launch` performs this proof automatically. It seeds twice and then runs
anonymous API, exact-origin CORS, hosting-security, and browser smoke:

```sh
export AWS_ACCOUNT_ID=228246988391
export AWS_REGION=us-east-1
export FTE_PHASE1_API_BASE=https://abc.execute-api.us-east-1.amazonaws.com
export FTE_FIXTURE_SEED_FUNCTION_NAME=FindTheEdge-dev-FixtureOddsSeed...
export FTE_WEB_ORIGIN=https://app.example.com
export FTE_PHASE1_BROWSER_BASE_URL=https://app.example.com
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-dev-cursor
export FTE_PHASE1_SMOKE=1
pnpm phase1:smoke
```

The smoke command validates every input, checks AWS identity again immediately
before each seed mutation, proves convergence, verifies anonymous access to the
exact fixtures and odds, rejects an unconfigured CORS origin, and runs the real
hosted browser flow. Browser artifacts are disabled. Without
`FTE_PHASE1_SMOKE=1` it reports a skip and performs no mutation.

## Automatic deployment from GitHub

Pushes to `main` first run `.github/workflows/ci.yml`. After that workflow
finishes successfully, `.github/workflows/deploy-phase1.yml` checks out the exact
verified commit, assumes the repository-specific AWS role through GitHub OIDC,
and runs the same guarded `pnpm phase1:launch` command documented above. A failed
quality workflow never receives deployment credentials and never deploys.

The one-time role bootstrap is tracked in
`infra/github-actions-deploy-role.yml`. Deploy it only from the authorized AWS
account after reviewing the main-branch-only trust policy:

```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name FindTheEdge-GitHubActionsDeployRole \
  --template-file infra/github-actions-deploy-role.yml \
  --capabilities CAPABILITY_NAMED_IAM
```

The role currently has administrator permissions because the guarded launch can
create and update IAM, CloudFormation, Lambda, API Gateway, Cognito, DynamoDB,
S3, CloudFront, logs, alarms, queues, and deployment assets. Its OIDC trust is
restricted to the immutable GitHub owner/repository IDs for
`kevishie/find-the-edge` on `refs/heads/main`; no static AWS access keys are
stored in GitHub. Protect the `main` branch so only reviewed commits can reach
this role.

## Rollback

Rollback static hosting by restoring the previous versioned `dist/phase1-web` artifact. For infrastructure, use CloudFormation/CDK change-set history to redeploy the previous known-good template. The DynamoDB table and API log group are retained; do not delete them as part of rollback. Disable further fixture invocation by deploying with `FTE_FIXTURE_ODDS_SEED_ENABLED=false`. Keep the scheduler disabled for Phase1.
