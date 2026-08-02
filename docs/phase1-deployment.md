# Phase1 deployment and environment smoke

Phase1 packages the existing fixture-backed games UI and validates the dev infrastructure without deploying by default. The repository commands never create credentials, secrets, or cloud resources. Run cloud commands only with an explicitly selected AWS account and region.

## Prerequisites

- Node 20.19 or newer and pnpm 10.28.2.
- For local validation: no AWS login is required.
- For deployment: an authenticated AWS profile/role, a 12-digit account, region, existing Secrets Manager cursor-signing secret, HTTPS JWT issuer, JWT audience, and exact HTTPS web origin.
- For environment smoke: the deployed API and fixture-seed outputs, issuer/audience/cursor-secret identifiers, exact hosted browser origin, plus an `events:read` JWT in the process environment. The full smoke requires the browser URL; it is not an optional partial check. Never put tokens in command arguments, files, shell history, or logs.

## Credential-free preflight and bundle

```sh
pnpm phase1:test
pnpm phase1:preflight
FTE_PHASE1_API_BASE=https://api.example.com FTE_WEB_ORIGIN=https://app.example.com pnpm phase1:bundle
```

Preflight synthesizes `FindTheEdge-dev-Foundation` with safe placeholder identifiers and validates JWT protection on `GET /games`, exact CORS, required outputs, fixture seed enablement, table-scoped DynamoDB IAM, and absence of DynamoDB Scan. It does not call AWS. The bundle is written to ignored `dist/phase1-web`; `phase1-manifest.json` contains sorted SHA-256 checksums, not credentials or tokens. Upload the directory to any static host that serves `index.html` for `/games`; do not cache `runtime-config.js` across deployments.

For an explicit local-only bundle, set `FTE_PHASE1_LOCAL_MODE=1` and use an `http://localhost` or `http://127.0.0.1` API base. HTTP is rejected for every non-local host.

## Explicit deploy and outputs

Verify identity before mutation, then synthesize and deploy noninteractively:

```sh
aws sts get-caller-identity
export CDK_DEFAULT_ACCOUNT=123456789012
export CDK_DEFAULT_REGION=us-east-1
export FTE_AWS_STAGE=dev
export FTE_JWT_ISSUER=https://issuer.example.com
export FTE_JWT_AUDIENCE=find-the-edge-dev
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:fte-dev-cursor
export FTE_WEB_ORIGIN=https://app.example.com
export FTE_FIXTURE_ODDS_SEED_ENABLED=true
export FTE_UPCOMING_SCHEDULER_ENABLED=false
pnpm --filter @find-the-edge/infra-cdk synth
pnpm --filter @find-the-edge/infra-cdk exec cdk deploy FindTheEdge-dev-Foundation --require-approval never --outputs-file /tmp/fte-phase1-outputs.json
aws cloudformation describe-stacks --stack-name FindTheEdge-dev-Foundation --region "$CDK_DEFAULT_REGION" --query 'Stacks[0].Outputs' --output table
```

Copy `EventsApiEndpoint` and `FixtureOddsSeedFunctionName` from the outputs. Deployment is intentionally not wrapped by a repository command: the operator must issue the mutating CDK command explicitly.

## Seed, API, CORS, auth, and browser smoke

Install/upload the static bundle first. Register the configured `hostSession` async token provider in the hosting shell as documented in `docs/web-runtime-configuration.md`. Then keep the scoped token only in the process environment:

```sh
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=us-east-1
export FTE_PHASE1_API_BASE=https://abc.execute-api.us-east-1.amazonaws.com
export FTE_FIXTURE_SEED_FUNCTION_NAME=FindTheEdge-dev-FixtureOddsSeed...
export FTE_WEB_ORIGIN=https://app.example.com
export FTE_PHASE1_BROWSER_BASE_URL=https://app.example.com
export FTE_JWT_ISSUER=https://issuer.example.com
export FTE_JWT_AUDIENCE=find-the-edge-dev
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:fte-dev-cursor
export FTE_PHASE1_ACCESS_TOKEN='obtain-from-your-identity-provider'
export FTE_PHASE1_SMOKE=1
pnpm phase1:smoke
unset FTE_PHASE1_ACCESS_TOKEN FTE_PHASE1_WRONG_SCOPE_TOKEN
```

The smoke command validates every input before its first AWS call, checks AWS identity, invokes the seed twice to prove convergence, verifies exact unchanged MLB/MLS fixture identifiers, markets, selections, books, prices, and timestamps, requires 401 without a token, rejects an unconfigured CORS origin, optionally tests denial with `FTE_PHASE1_WRONG_SCOPE_TOKEN`, and always runs the real hosted browser flow. Browser traces, videos, screenshots, and retained output are disabled so the injected process token cannot enter an artifact. Without `FTE_PHASE1_SMOKE=1` it reports a skip and performs no mutation.

## Rollback

Rollback static hosting by restoring the previous versioned `dist/phase1-web` artifact. For infrastructure, use CloudFormation/CDK change-set history to redeploy the previous known-good template. The DynamoDB table and API log group are retained; do not delete them as part of rollback. Disable further fixture invocation by deploying with `FTE_FIXTURE_ODDS_SEED_ENABLED=false`. Keep the scheduler disabled for Phase1.
