# Phase1 deployment and environment smoke

Phase1 packages the public live-games UI. SharpAPI is the primary MLB/MLS odds source and The Odds API is a bounded fallback; no development fixtures are part of the production read path.

The games and odds UI and its read-only API are public and require no account or
token. CloudFront serves an encrypted, private S3 bucket through signed origin
access; direct S3 access is never an application fallback. Existing Cognito
resources remain dormant to avoid destructive identity-resource cleanup during
this release.

## Prerequisites

- Node 20.19 or newer and pnpm 10.28.2.
- For local validation: no AWS login is required.
- For deployment: an authenticated AWS profile/role in account `228246988391`, region `us-east-1`, the existing cursor-signing secret, and `find-the-edge/dev/the-odds-api` in Secrets Manager. Store either the plain API key or `{ "apiKey": "..." }`; never put it in CDK context, Lambda environment variables, browser assets, or logs.
- For environment smoke: the deployed API, live-ingestion function output, cursor-secret identifier, and exact hosted browser origin.

## Credential-free preflight and bundle

```sh
pnpm phase1:test
pnpm phase1:preflight
FTE_PHASE1_API_BASE=https://api.example.com FTE_WEB_ORIGIN=https://app.example.com pnpm phase1:bundle
```

Preflight synthesizes with safe placeholder identifiers and validates anonymous games routes, exact CORS, secret-read isolation, table-scoped IAM, and absence of plaintext credentials. It does not call AWS.

For an explicit local-only bundle, set `FTE_PHASE1_LOCAL_MODE=1` and use an `http://localhost` or `http://127.0.0.1` API base. HTTP is rejected for every non-local host.

## Guarded launch and outputs

Set `AWS_ACCOUNT_ID=228246988391`, `AWS_REGION=us-east-1`,
`FTE_EVENT_CURSOR_SECRET_ARN`, and `FTE_PHASE1_LAUNCH=1`, then run
`pnpm phase1:launch`. The command rechecks STS
identity immediately before every mutation, rejects retained-table destructive
diffs, deploys the dev stack, generates runtime configuration from stack outputs,
uploads and invalidates the private site, runs live ingestion, and proves the anonymous API and browser flow.

The underlying operator commands are shown for diagnosis only:

```sh
aws sts get-caller-identity
export CDK_DEFAULT_ACCOUNT=228246988391
export CDK_DEFAULT_REGION=us-east-1
export FTE_AWS_STAGE=dev
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-dev-cursor
export FTE_FIXTURE_ODDS_SEED_ENABLED=false
export FTE_UPCOMING_SCHEDULER_ENABLED=true
pnpm --filter @find-the-edge/infra-cdk synth
pnpm --filter @find-the-edge/infra-cdk exec cdk deploy FindTheEdge-dev-Foundation --require-approval never --outputs-file /tmp/fte-phase1-outputs.json
aws cloudformation describe-stacks --stack-name FindTheEdge-dev-Foundation --region "$CDK_DEFAULT_REGION" --query 'Stacks[0].Outputs' --output table
```

The launch command consumes all stack outputs directly. Roll back assets by
uploading the prior checksum-verified bundle and invalidating `/*`.
Infrastructure rollback requires a reviewed CDK diff; the event table, dormant
user pool, web bucket, and logs are retained.

## Live ingestion, quota, and cadence

The stack output `LiveOddsIngestionFunctionName` is the safe manual trigger. Invoke it once after both provider secrets exist. A 15-minute EventBridge tick enqueues one FIFO control-plane command; policy—not the tick—decides whether each league is due. Exhausted commands enter the dedicated odds DLQ and alarm without blocking another league.

```sh
export AWS_ACCOUNT_ID=228246988391
export AWS_REGION=us-east-1
export FTE_PHASE1_API_BASE=https://abc.execute-api.us-east-1.amazonaws.com
export FTE_LIVE_ODDS_FUNCTION_NAME=FindTheEdge-dev-LiveOddsIngestion...
export FTE_WEB_ORIGIN=https://app.example.com
export FTE_PHASE1_BROWSER_BASE_URL=https://app.example.com
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-dev-cursor
export FTE_PHASE1_SMOKE=1
pnpm phase1:smoke
```

Normal MLB/MLS odds refresh hourly. Inside 90 minutes of first pitch, MLB refreshes every 15 minutes and MLS every 30 minutes. Other league profiles default to six hours. The durable provider `x-requests-remaining` value blocks paid calls at a 50-credit monthly reserve. Schedule discovery continues independently. CloudWatch logs emit only bounded summaries, never keys or credential-bearing URLs.

The versioned control-plane policy keeps a 100-request SharpAPI reserve and a separate 50-request The Odds API reserve. Schedule discovery has its own explicit request-cost/reserve policy and only uses its fallback after Sharp schedule discovery fails. Every physical request is reserved before execution, and its redacted outcome, quota cost, sealed normalized page, cursor, gap evidence, provider-and-league health and league checkpoint are durable. An unsealed paid response remains ambiguous behind a five-minute reconciliation lease; it is not automatically recalled during that lease. A retry consumes a sealed normalized page before making another paid call. Automatic fallback is permitted only when the primary has not committed evidence in that run; a partial SharpAPI run never continues through The Odds API.

Manual refresh is only a scheduler hint. It does not bypass provider activation, cadence/quota decisions, cooldown, exact canonical mappings, scheduled/pregame fences or immutable history. Missing, partial, stale, suspended, closed and unsupported evidence is stored as an explicit gap rather than inferred.

### Migration and rollback

Deploy the retained-table schema and disabled FIFO path first, verify the `LiveOddsControlPlaneDlqAlarm` notification target, then enable the scheduler. Existing odds rows remain readable; new rows add optional provider/policy provenance. Roll back by disabling `FTE_UPCOMING_SCHEDULER_ENABLED` and redeploying the prior worker bundle. Do not delete the retained table, queues, secrets or immutable snapshots. Before re-enabling, inspect failed run/page/attempt records and redrive only the failed league command.

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

Rollback static hosting by restoring the previous versioned bundle. To stop provider spend, deploy with `FTE_UPCOMING_SCHEDULER_ENABLED=false`; retained events and last-good immutable/current odds remain readable. Do not delete the retained DynamoDB table or secret.
