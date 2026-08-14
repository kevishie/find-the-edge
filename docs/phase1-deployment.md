# Phase1 deployment and environment smoke

For staging/production branches, custom domains, certificates, GitHub Environments, DNS cutover, promotion, and rollback, follow [Environment promotion and custom-domain runbook](./environment-promotion.md). The dev commands below remain a fenced legacy path and must not be used to infer production targets.

Phase1 packages the public live-games UI. SharpAPI is the sole production MLB/MLS schedule and odds source; no development fixtures are part of the production read path.

The games and odds UI and its read-only API are public and require no account or
token. CloudFront serves an encrypted, private S3 bucket through signed origin
access; direct S3 access is never an application fallback. Existing Cognito
resources remain dormant to avoid destructive identity-resource cleanup during
this release.

## Prerequisites

- Node 20.19 or newer and pnpm 10.28.2.
- For local validation: no AWS login is required.
- For deployment: an authenticated AWS profile/role in account `228246988391`, region `us-east-1`, the existing cursor-signing secret, and `find-the-edge/dev/sharpapi` in Secrets Manager. Store either the plain API key or `{ "apiKey": "..." }`; never put it in CDK context, Lambda environment variables, browser assets, or logs. SharpAPI is the sole production schedule and odds provider.
- For phone sign-in (FTE-070): `find-the-edge/<stage>/identity` in Secrets Manager, holding
  `{ "currentKeyId": "session-<yyyy-mm>", "currentSecret": "<32+ random chars>", "otpPepper": "<32+ random chars>", "accountPepper": "<32+ random chars>" }`,
  optionally plus `previousKeyId` and `previousSecret` while a signing key is
  rotating. Rotate `currentSecret` (keeping the old pair as `previous*` until
  old tokens expire) and `otpPepper` freely; **never** rotate `accountPepper` —
  every account id is derived from it, so changing it orphans every account.
  The identity routes return `500` until this secret exists; every other route
  is unaffected. SMS is sent with `sns:Publish` to the number, using the
  account's existing SNS SMS origination — the stack provisions no messaging
  resource, so no phone number, sender id, or pool is created or required by
  this deploy.

## SharpAPI odds request modes

Production has two paid-request modes, both using the same server-side SharpAPI secret and immutable snapshot path:

- **Featured** scans use `GET /api/v1/odds` with an exact catalog league identity, `market=main`, `is_live=false`, and opaque cursor pagination. The runtime allowlist is MLB, MLS, English Premier League, Liga MX, and UEFA Champions League. Unknown or friendly-name aliases fail closed.
- **Focused** refreshes accept only a canonical SharpAPI event ID and use `GET /api/v1/events/{eventId}/odds`. A durable identity hashes provider, league, endpoint mode, event ID, sorted market set, and five-minute polling window, so duplicate scheduler/manual triggers cannot issue a second paid call.

Focused Lambda payloads have exactly this shape:

```json
{ "mode": "focused", "leagueKey": "epl", "providerEventId": "<sharp-event-id>" }
```

The focused endpoint returns all entitled books/markets. Local normalization keeps only supported full-game main markets, excludes suspended (`is_active=false`), stale, alternate, live, and player-prop prices from current odds, retains valid siblings, and writes reason-coded gaps including missing Hard Rock coverage. HTTP 429 responses are not retried immediately; provider retry timing is retained on the typed error boundary and the durable request window prevents duplicate calls. Raw paid-provider responses and credentials are never logged or archived.

Operational verification should confirm `OddsProviderRequest`, `OddsRequestDeduplicated`, `OddsNormalizedObservation`, `OddsNormalizationRejected`, snapshot/current outcomes, and provider failures with bounded `provider`, `league`, `endpoint`, `markets`, `partial`, and `reason` dimensions. SharpAPI is the sole production schedule and odds source. Production Lambda configuration must contain only `FTE_SHARP_API_SECRET_ID`; `THE_ODDS_API_KEY`, calls to The Odds API, and any provider fallback are forbidden.

The 25-book entitlement is a capacity bound, not an expectation that every book
appears on every event. The closed collection allowlist retains approved raw
Pinnacle and other entitled-book prices with `providerId=sharpapi`; it does not
consume vendor fair-odds/EV analytics or alter consensus weights. Expected-book
gaps are configured per league and market. Rollout uses a redacted authorized
canary, one league, then remaining leagues; Pinnacle is reported as observed or
`coverage-unverified`, without a second paid provider call for absence.

- For environment smoke: the deployed API, live-ingestion function output, cursor-secret identifier, and exact hosted browser origin.

## Credential-free preflight and bundle

```sh
pnpm phase1:test
FTE_AWS_STAGE=staging FTE_PRODUCT_ACCESS_ENFORCED=false pnpm phase1:preflight
FTE_AWS_STAGE=prod FTE_PRODUCT_ACCESS_ENFORCED=false pnpm phase1:preflight
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

Persistent launches also require the exact
`FTE_PRODUCT_ACCESS_ENFORCED=true|false` setting. Keep it `false` for the
configuration-plumbing release; absence, whitespace, case variants, and
numeric aliases are rejected before AWS mutation. GitHub deployments source
the value independently in each protected branch case in the reviewed workflow.
The current guarded launcher accepts only `false`; enabling staging requires a
later reviewed cutover change after the owned-session and hosted-smoke gates
are complete. No repository, organization, or Environment variable can activate
it in this release.

The underlying operator commands are shown for diagnosis only:

```sh
aws sts get-caller-identity
export CDK_DEFAULT_ACCOUNT=228246988391
export CDK_DEFAULT_REGION=us-east-1
export FTE_AWS_STAGE=dev
export FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-dev-cursor
export FTE_FIXTURE_ODDS_SEED_ENABLED=false
export FTE_PRODUCT_ACCESS_ENFORCED=false
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

The stack output `LiveOddsIngestionFunctionName` is the safe manual trigger. Invoke it once after the SharpAPI secret exists. A 15-minute EventBridge tick enqueues one FIFO control-plane command; policy—not the tick—decides whether each league is due. Exhausted commands enter the dedicated odds DLQ and alarm without blocking another league.

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

Normal MLB/MLS odds refresh hourly. Inside 90 minutes of first pitch, MLB refreshes every 15 minutes and MLS every 30 minutes. Other league profiles default to six hours. An authoritative provider rate window blocks paid calls at its configured reserve; requests-per-minute is never represented as durable subscription quota, and absent headers remain unknown. Schedule discovery continues independently. CloudWatch logs emit only bounded summaries, never keys or credential-bearing URLs.

The versioned control-plane policy keeps a 100-request SharpAPI reserve. Schedule discovery has its own explicit request-cost/reserve policy and fails closed with a bounded reason when SharpAPI is unavailable. Every physical request is reserved before execution, and its redacted outcome, quota cost, sealed normalized page, cursor, gap evidence, provider-and-league health and league checkpoint are durable. An unsealed paid response remains ambiguous behind a five-minute reconciliation lease; it is not automatically recalled during that lease. A retry consumes a sealed normalized page before making another paid call.

Manual refresh is only a scheduler hint. It does not bypass provider activation, cadence/quota decisions, cooldown, exact canonical mappings, scheduled/pregame fences or immutable history. Missing, partial, stale, suspended, closed and unsupported evidence is stored as an explicit gap rather than inferred.

### Guarded development feed reset

Use a feed reset only when the development environment contains stale or
partially ingested provider data that a normal forced refresh cannot repair.
The operation is permanently restricted to account `228246988391`, region
`us-east-1`, and stack `FindTheEdge-dev-Foundation`. It resolves the retained
table and live-ingestion Lambda from CloudFormation and proves that both use the
same table before doing anything.

Run the dry run first. It scans only `pk` and `sk`, classifies every key, aborts
on an unknown family, and prints an allowlisted record count plus a SHA-256
manifest digest. It does not pause ingestion, create a backup, delete records,
or call SharpAPI.

```sh
export AWS_ACCOUNT_ID=228246988391
export AWS_REGION=us-east-1
pnpm phase1:reset-feed
```

For apply, use the **Reset Phase 1 SharpAPI feed** GitHub Action, choose `apply`,
and type `RESET`. The manual workflow uses the short-lived repository OIDC role
and the same environment-mutation lock as deployment. Apply is intentionally
rejected outside that workflow so a local process cannot overlap a deploy or a
second reset.

Apply records the same dry-run plan, disables the live and legacy producer
rules, all three feed event-source mappings, and the live, legacy, projection,
and producer Lambdas. It waits the longest deployed writer timeout, purges each
source queue exactly once, and requires three complete stable empty-queue reads.
It then requires point-in-time recovery and creates an on-demand backup named
`find-the-edge-dev-feed-reset-<UTC timestamp>`. It waits until the backup is
`AVAILABLE` before deleting only canonical schedule, mapping/reconciliation,
current odds/availability, split, and SharpAPI control-plane records. Immutable
fixture-odds snapshots, their exact-ID/history indexes, results, users, paper
bets, evaluations, performance data, strategies, experiments, and
retrospectives are preserved. Every preserved key present at the stable reset
boundary must still exist after deletion and re-ingestion; concurrent additions
to preserved product families are allowed. Unprocessed
DynamoDB batch items are retried only when every returned key belongs to the
submitted batch, and the operation proves that no allowlisted feed rows remain.

With every event source still disabled, the operation temporarily gives only
the live Lambda exactly one unit of concurrency for one synchronous forced
SharpAPI ingest. A short-lived DynamoDB maintenance lease is checked by the
Lambda before it reads the provider secret, so any unrelated direct invocation
is rejected during that window; the reset releases the lease after refencing
the Lambda, and a crashed lease expires after 20 minutes. Every
enabled league must complete before it validates the public MLB games and splits
endpoints for the current Eastern calendar day. Success requires unique
matchups, fresh valid American odds, fresh SharpAPI split percentages, and at
least one same-game odds-plus-splits decision surface. All rules, mappings, and
Lambda concurrencies are restored to their exact prior states in success and
normal failure paths, including provider failure. Apply has a 75-minute internal
deadline inside the 90-minute workflow timeout, leaving a bounded cleanup
reserve; termination signals request the same restoration path.

The output includes the backup name and ARN but never credentials or licensed
provider payloads. Empty or unavailable UI data can be transient while the
hosted API converges, so verification retries boundedly. If ingestion or
verification still fails after deletion, the script restores every writer's
prior state, exits nonzero with an allowlisted failure code, and requires
operator follow-up; do not assume the clean feed will repair itself. Restore the
prior table into a new table from the reported on-demand backup (or use DynamoDB
point-in-time recovery), inspect it, and perform a reviewed data copy; never
replace or delete the retained stack table during recovery.

### Migration and rollback

Deploy the retained-table schema and disabled FIFO path first, verify the `LiveOddsControlPlaneDlqAlarm` notification target, then enable the scheduler. Existing odds rows remain readable; new rows add optional provider/policy provenance. Roll back by disabling `FTE_UPCOMING_SCHEDULER_ENABLED` and redeploying the prior worker bundle. Do not delete the retained table, queues, secrets or immutable snapshots. Before re-enabling, inspect failed run/page/attempt records and redrive only the failed league command.

Odds history starts when live collection is activated. Do not infer or synthesize pre-launch opening prices. Immutable `SNAPSHOT` rows intentionally have no TTL even though the shared table supports TTL for transient records. Legacy positional `away`/`home` selection partitions may coexist with participant-bound partitions; leave them untouched and treat them as legacy evidence rather than merging histories implicitly.

Each primary snapshot also receives a repairable content-hash lookup row. If that mirror write is interrupted after the primary snapshot commits, ingestion emits `OddsExactSnapshotMirrorFailure`; replay the same sealed ingestion page so the conditional snapshot insert resolves as an identical duplicate, the exact-ID mirror is recreated, and `CURRENT` converges without rewriting history. Alert on repeated nonzero mirror-failure metrics.

### Odds projection rollout and rebuild

The retained event table publishes `NEW_IMAGE` stream records to the fixture-odds projector. Its infrastructure filter and runtime guard accept only immutable `FIXTURE_ODDS#…` / `SNAPSHOT#…` inserts. `CURRENT`, exact-ID mirrors, event data, betting splits, results, paper records, control-plane records, modifications, and removals are successful no-ops. The projector validates the complete immutable row and uses the same provider `observedAt`, then snapshot-ID ordering as synchronous ingestion.

Keep synchronous `CURRENT` writes enabled during this rollout. Deploy the stream, projector, dedicated projection DLQ, and alarms; ingest a known snapshot; then verify `ProjectionProcessed`, `ProjectionAdvanced` or `ProjectionRetained`, and `ProjectionLagMilliseconds` in `FindTheEdge/OddsProjection`. Verify `FixtureOddsProjectionErrorsAlarm`, `FixtureOddsProjectionLagAlarm`, and `FixtureOddsProjectionDlqAlarm` remain clear. The two writers are intentionally safe because they share the same conditional winner. Removing synchronous projection is a separate migration after sustained production proof.

Malformed relevant records retry up to five times for at most one day and then send invocation metadata and the stream locator to the dedicated projection DLQ. The failure destination is not a raw snapshot archive. Logs contain only bounded sequence number and canonical partition/sort-key locators, never the `NEW_IMAGE` or odds payload. Reconstruct the exact record from the immutable table by those keys while it is retained, correct the producer or deployment defect, and then redrive. Unrelated shared-table records must not be redriven into the projector.

For a rebuild, replay DynamoDB stream records only while they remain available in the 24-hour stream retention window. Outside that window, use a point-in-time/export-derived list of immutable snapshot inserts or an explicit manifest that enumerates known fixture-odds partitions and queries their `SNAPSHOT#` rows. Do not Scan the shared table, fabricate missing history, mutate snapshots, or use `CURRENT`/exact-ID mirror rows as replay inputs. Replay order does not matter because duplicate and older snapshots retain the deterministic winner.

Rollback first by disabling the projector event-source mapping while leaving synchronous ingestion enabled. A pre-stream stack version may remove the stream configuration, so do not claim it preserves stream evidence; export any required evidence before that rollback. Always preserve the retained table, DLQ, and immutable snapshots. After recovery, reconstruct failed records from their bounded pk/sk locators or replay the exported immutable insert set; do not delete or rewrite history.

## Automatic deployment from GitHub

Pushes to `main` and `production` first run `.github/workflows/ci.yml`. After that
workflow finishes successfully, `.github/workflows/deploy-phase1.yml` checks out
the exact verified commit, maps `main` to staging and `production` to production,
assumes the environment-specific AWS role through GitHub OIDC, and runs the same
guarded `pnpm phase1:launch` command documented above. A failed quality workflow
never receives deployment credentials and never deploys.

The one-time role bootstrap is tracked in
`infra/github-actions-deploy-role.yml`. Deploy it only from the authorized AWS
account after reviewing the isolated GitHub Environment trust policies:

```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name FindTheEdge-GitHubActionsDeployRole \
  --template-file infra/github-actions-deploy-role.yml \
  --capabilities CAPABILITY_NAMED_IAM
```

The template creates separate service-scoped staging and production deployment
roles plus least-privilege identity-authorization operator roles. Its OIDC
trust is restricted to the immutable GitHub owner/repository IDs and exact
GitHub Environment subjects for `kevishie/find-the-edge`; no static AWS access
keys are stored in GitHub. Configure each Environment's
`AUTHORIZATION_OPERATOR_ROLE_ARN` from the matching stack output and follow
`docs/runbooks/identity-authorization.md`. Protect `main` and `production` so
only reviewed commits can reach their respective environments.

## Rollback

Rollback static hosting by restoring the previous versioned bundle. To stop provider spend, deploy with `FTE_UPCOMING_SCHEDULER_ENABLED=false`; retained events and last-good immutable/current odds remain readable. Do not delete the retained DynamoDB table or secret.
