# Phase1 deployment and environment smoke

Phase1 packages the existing fixture-backed games UI. Preflight, bundle, and test commands are credential-free; `phase1:launch` explicitly creates and updates cloud resources when its opt-in guard is enabled.

The AWS-native launch layer uses Cognito authorization-code flow with PKCE and
public signup disabled. CloudFront serves an encrypted, private S3 bucket through
signed origin access; direct S3 access is never an application fallback. The API
issuer, client audience, scope, and CORS origin are derived from these resources.

## Prerequisites

- Node 20.19 or newer and pnpm 10.28.2.
- For local validation: no AWS login is required.
- For deployment: an authenticated AWS profile/role in account `228246988391`, region `us-east-1`, and the existing Secrets Manager cursor-signing secret.
- For environment smoke: the deployed API and fixture-seed outputs, issuer/audience/cursor-secret identifiers, exact hosted browser origin, plus an `events:read` JWT in the process environment. The full smoke requires the browser URL; it is not an optional partial check. Never put tokens in command arguments, files, shell history, or logs.

## Credential-free preflight and bundle

```sh
pnpm phase1:test
pnpm phase1:preflight
FTE_PHASE1_API_BASE=https://api.example.com FTE_WEB_ORIGIN=https://app.example.com pnpm phase1:bundle
```

Preflight synthesizes `FindTheEdge-dev-Foundation` with safe placeholder identifiers and validates JWT protection on `GET /games`, exact CORS, required outputs, fixture seed enablement, table-scoped DynamoDB IAM, and absence of DynamoDB Scan. It does not call AWS. The bundle is written to ignored `dist/phase1-web`; `phase1-manifest.json` contains sorted SHA-256 checksums, not credentials or tokens. Upload the directory to any static host that serves `index.html` for `/games`; do not cache `runtime-config.js` across deployments.

For an explicit local-only bundle, set `FTE_PHASE1_LOCAL_MODE=1` and use an `http://localhost` or `http://127.0.0.1` API base. HTTP is rejected for every non-local host.

## Guarded launch and outputs

Set `AWS_ACCOUNT_ID=228246988391`, `AWS_REGION=us-east-1`,
`FTE_EVENT_CURSOR_SECRET_ARN`, an explicit email in `FTE_PHASE1_USERNAME`, and
`FTE_PHASE1_LAUNCH=1`, then run `pnpm phase1:launch`. The command rechecks STS
identity immediately before every mutation, rejects retained-table destructive
diffs, deploys the dev stack, generates runtime configuration from stack outputs,
uploads and invalidates the private site, and bootstraps the admin-created user
through a mode-0600 temporary request file. It never prints a password or token
and deletes temporary material on every exit.

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

The launch command consumes all stack outputs directly. Rotate or delete the MVP
user with the Cognito admin APIs using restricted JSON input files, never a
password argument. Roll back assets by uploading the prior checksum-verified
bundle and invalidating `/*`. Infrastructure rollback requires a reviewed CDK
diff; the event table, user pool, web bucket, and logs are retained.

## Seed, API, CORS, auth, and browser smoke

`phase1:launch` performs this proof automatically. It creates a private temporary user, completes Cognito Hosted UI PKCE login, keeps its access/ID tokens and password only in process memory or restricted temporary files, seeds twice, runs API/CORS/browser smoke, then deletes the user and temporary material. Standalone smoke requires both the scoped access token and a valid Cognito ID token as the mandatory wrong-scope proof:

```sh
export AWS_ACCOUNT_ID=228246988391
export AWS_REGION=us-east-1
export FTE_PHASE1_API_BASE=https://abc.execute-api.us-east-1.amazonaws.com
export FTE_FIXTURE_SEED_FUNCTION_NAME=FindTheEdge-dev-FixtureOddsSeed...
export FTE_WEB_ORIGIN=https://app.example.com
export FTE_PHASE1_BROWSER_BASE_URL=https://app.example.com
export FTE_JWT_ISSUER=https://issuer.example.com
export FTE_JWT_AUDIENCE=find-the-edge-dev
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-dev-cursor
export FTE_PHASE1_ACCESS_TOKEN='short-lived-access-token'
export FTE_PHASE1_WRONG_SCOPE_TOKEN='short-lived-id-token'
export FTE_PHASE1_USERNAME='private-user@example.com'
export FTE_PHASE1_PASSWORD='process-only-password'
export FTE_PHASE1_SMOKE=1
pnpm phase1:smoke
unset FTE_PHASE1_ACCESS_TOKEN FTE_PHASE1_WRONG_SCOPE_TOKEN
```

The smoke command validates every input, checks AWS identity again immediately before each seed mutation, proves convergence, verifies the exact fixtures and odds, requires denial for missing, malformed, and valid wrong-scope authentication, rejects an unconfigured CORS origin, and runs the real hosted browser flow. Browser artifacts are disabled. Without `FTE_PHASE1_SMOKE=1` it reports a skip and performs no mutation.

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
restricted to `kevishie/find-the-edge` on `refs/heads/main`; no static AWS access
keys are stored in GitHub. Protect the `main` branch so only reviewed commits
can reach this role.

## Rollback

Rollback static hosting by restoring the previous versioned `dist/phase1-web` artifact. For infrastructure, use CloudFormation/CDK change-set history to redeploy the previous known-good template. The DynamoDB table and API log group are retained; do not delete them as part of rollback. Disable further fixture invocation by deploying with `FTE_FIXTURE_ODDS_SEED_ENABLED=false`. Keep the scheduler disabled for Phase1.
