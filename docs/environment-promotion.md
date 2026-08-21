# Environment promotion and custom-domain runbook

This runbook prepares and operates two isolated persistent environments:

| Mainline     | AWS stage | GitHub Environment | Web                            | API                                |
| ------------ | --------- | ------------------ | ------------------------------ | ---------------------------------- |
| `main`       | `staging` | `staging`          | `https://staging.kevishie.com` | `https://api-staging.kevishie.com` |
| `production` | `prod`    | `production`       | `https://kevishie.com`         | `https://api.kevishie.com`         |

Feature branches merge into `main`. After the exact deployed staging SHA passes live smoke, promote it with a pull request from `main` to `production`. A production hotfix must be merged back into `main` immediately so the mainlines do not diverge.

Recurring provider acquisition is stage-owned cost policy. `staging` runs Live Odds at 05:00, 13:00, and 21:00 UTC and Provider Landing fifteen minutes after each window while keeping opportunity generation and opportunity expiration disabled. The functions, queues, checkpoints, DLQs, secrets, and manual invocation outputs remain available, and scheduled work follows the same quota, idempotency, retry, and terminal-failure controls as a deliberate canary. `prod` keeps one-minute Live Odds and the two opportunity schedules enabled; universal Provider Landing remains promotion-gated and disabled. Preflight and synthesis reject contradictory stage policy and structurally bind each retained output to its exact schedule and sole target. This cost-control boundary does not share tables or let staging read production data.

## Safety boundary and current DNS observation

As observed on 2026-08-07, `kevishie.com` used `ns-cloud-d1.googledomains.com` through `ns-cloud-d4.googledomains.com`, and its apex resolved to `173.230.142.141`. These are observations, not deployment constants. Re-query and export the complete zone immediately before certificate validation or traffic changes.

```sh
dig +noall +answer NS kevishie.com
dig +noall +answer A kevishie.com
dig +noall +answer AAAA kevishie.com
dig +noall +answer MX kevishie.com
dig +noall +answer TXT kevishie.com
dig +noall +answer CAA kevishie.com
```

Capture every record, TTL, registrar name server, and prior target in an approved change record. Lower relevant TTLs ahead of the cutover where the current provider allows it. Do not change registrar delegation, authoritative name servers, or the apex from CI.

The preferred steady state is an authoritative Route 53 public hosted zone with alias `A` and `AAAA` records to CloudFront and API Gateway. If DNS remains external, add the exact ACM validation CNAMEs and endpoint records printed by AWS. Never publish a CNAME at the zone apex unless the authoritative provider explicitly implements a safe apex-alias feature.

## Legacy development inventory

`FindTheEdge-dev-Foundation` contains retained DynamoDB, Cognito, and S3 resources plus its existing Lambda, API Gateway, CloudFront, queue, workflow, and scheduler resources. It also references `find-the-edge/dev/*` secrets. The new stages create new `FindTheEdge-staging-Foundation` and `FindTheEdge-prod-Foundation` stacks and distinct secret prefixes. Observability resources and runtime log delivery are intentionally absent.

Do not delete, rename, import, empty, or repurpose the legacy stack or its retained resources in this rollout. Data migration and legacy-dev disposition require a separate reviewed plan after both new environments are proven.

## One-time AWS preparation

1. Confirm the active identity is account `228246988391` in `us-east-1`.
2. Bootstrap CDK in that account/region if it is not already bootstrapped.
3. Request or import certificates:
   - CloudFront certificate in `us-east-1`, covering the environment's exact web hostname.
   - Regional API Gateway certificate in `us-east-1`, covering the environment's exact API hostname.
4. Add ACM validation records to the current authoritative DNS and wait for both certificates to reach `ISSUED`. Do not point application traffic yet.
5. Deploy `infra/github-actions-deploy-role.yml`. It creates separate deployment and authorization-operator OIDC roles for the GitHub `staging` and `production` Environment subjects and does not use static AWS keys or `AdministratorAccess`.
6. Review the role policy before production. It is service-scoped but retains `Resource: "*"` for CDK resource creation; further resource-level reduction is a security-hardening follow-up where AWS APIs permit predictable ARNs.

## One-time GitHub preparation

Create GitHub Environments named `staging` and `production`.

- Restrict `staging` deployments to the `main` branch.
- Restrict `production` deployments to the `production` branch.
- A successful quality run on `main` automatically deploys staging. A successful quality run on `production` automatically deploys production. No additional GitHub Environment reviewer gate is required for this two-engineer repository.
- Configure these variables separately in each Environment:
  - `AWS_DEPLOY_ROLE_ARN`
  - `AUTHORIZATION_OPERATOR_ROLE_ARN`
  - `WEB_CERTIFICATE_ARN`
  - `API_CERTIFICATE_ARN`
  - `EVENT_CURSOR_SECRET_ARN`
- Product-access enforcement is not a GitHub variable in this release. The
  reviewed workflow binds `false` independently in the `main`/staging and
  `production`/prod branch cases, then rechecks it before cloud credentials.
  This avoids organization/repository fallback and prevents an unreviewed
  settings change from activating the cutover.
- Configure `SHARP_API_KEY` as an Environment secret. Never use one environment's secret or cursor ARN in the other.

Protect both `main` and `production`: require pull requests and the Quality gates checks, disable force pushes and branch deletion, and dismiss stale approvals when the head changes. Repository settings are external control-plane state and must be verified in GitHub after configuration.

Server-owned elevated roles use the separate least-privilege operator role and the protected manual workflow documented in `docs/runbooks/identity-authorization.md`. Never substitute the deployment role for production role provisioning.

## Credential-free verification

Run both synth/preflight paths before requesting cloud credentials:

```sh
FTE_AWS_STAGE=staging FTE_PRODUCT_ACCESS_ENFORCED=false pnpm phase1:preflight
FTE_AWS_STAGE=prod FTE_PRODUCT_ACCESS_ENFORCED=false pnpm phase1:preflight
pnpm phase1:test
pnpm check
```

The templates must emit `WebDnsTarget`, `ApiDnsTarget`, `ApiDnsHostedZoneId`, `DeploymentStage`, and `ReleaseSha`, use `find-the-edge/<stage>/*` secrets, and contain no cross-environment domain or identifier.

## Staging rollout

1. Confirm `main` contains the intended reviewed baseline and enable its staging-mainline branch protection.
2. Merge the implementation through a pull request. Quality gates must pass for the exact head SHA.
3. The deployment workflow enters only the GitHub `staging` Environment, assumes only the staging OIDC role, deploys `FindTheEdge-staging-Foundation`, uploads the versioned web bundle, awaits invalidation, and runs live smoke.
4. Publish the staging DNS targets only after certificates are issued. Verify DNS through at least two public resolvers, then rerun smoke against both staging hostnames.
5. Record the Git SHA, workflow run, CloudFormation stack ID, DNS answers, certificate status, smoke result, and alarm state.

Do not promote a revision to `production` until staging proves the exact custom web/API origins, TLS, CORS, CSP, authentication callback, direct-S3 denial, representative data reads, stage marker, and release SHA.

This configuration release does not enable product enforcement. Verify the
deployed Event API Lambda configuration reports
`FTE_PRODUCT_ACCESS_ENFORCED=false`. A later cutover may change staging only
after a real owned and entitled session passes positive access, missing and
revoked sessions return 401, unentitled sessions return 402, all legacy routes
have migrated, and the hosted smoke uses real owned authority. Production
remains false through the staging soak. The current protected launch also
refuses `true`, so that later cutover requires its own reviewed code change.

Resolve the Event API from the selected stack and verify the live value after
every deployment:

```sh
stage=staging # use prod only during an intentional production promotion
stack=FindTheEdge-$stage-Foundation
event_api=$(aws cloudformation list-stack-resources --stack-name "$stack" --region us-east-1 --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId | contains("EventApi")))] | if length == 1 then .[0].PhysicalResourceId else error("event-api-binding") end')
test "$(aws lambda get-function-configuration --function-name "$event_api" --region us-east-1 --query 'Environment.Variables.FTE_PRODUCT_ACCESS_ENFORCED' --output text)" = false
```

## Production promotion and cutover

1. Open a pull request from `main` to `production`; do not cherry-pick an unproven substitute revision.
2. After required checks, merge. The successful quality run automatically enters the production GitHub Environment and deploys the exact verified `production` SHA.
3. Deploy `FindTheEdge-prod-Foundation` and verify its generated targets without moving the apex.
4. For the initial DNS cutover, preserve all unrelated MX, TXT, CAA, verification, and subdomain records and retain the captured rollback values.
5. Point `api.kevishie.com` to the API Gateway custom domain and `kevishie.com` to the production CloudFront distribution using Route 53 aliases or the current provider's supported equivalent.
6. Confirm authoritative and recursive answers from multiple resolvers, then run production smoke and record provenance.

## Rollback

**Automatic web rollback is ON for `prod` and OFF for `staging`.**

The rollback protects readers from a bad release, and it also deadlocks any
client-side fix the smoke is failing on, because it deletes the bundle
carrying that fix. Measured on staging 2026-08-13: the correct bundle went up
at 19:45:15 and the previous release replaced it at 19:46:18, three deploys
running, so no client fix reached staging at all. The CDK stack is not rolled
back, which is why server-side changes landed in those same deploys while
client-side ones silently did not — and why checking `ReleaseSha` to confirm
a deploy says nothing about the browser bundle.

Those two facts point opposite ways, so the default follows who is watching.
Production serves real readers and keeps the protection. Staging exists to
find bugs and keeps the bundle.

Override with `FTE_ROLLBACK_WEB_ON_FAILURE`: `1` forces the rollback on, `0`
forces it off. Turning it off for a single prod deploy is the deliberate way
to land a fix that the smoke itself gates on — do it knowingly, and turn it
back on.

Application rollback restores the prior versioned S3 release, waits for CloudFront invalidation, and leaves retained data untouched. Infrastructure rollback uses a reviewed CDK/CloudFormation change and must pass the retained-resource guard.

DNS rollback restores the captured prior apex and API records with their prior values and TTLs. If authoritative name servers were migrated, restore the prior registrar delegation only from the approved snapshot and confirm all unrelated records still resolve. A failed production smoke is not permission to delete DynamoDB, Cognito, S3, secrets, queues, or immutable odds history. Legacy log groups are removed only through the bounded procedure in `docs/cloudwatch-shutdown.md`.

After rollback, disable spend-producing schedules if needed, preserve evidence, link the failed Git SHA and workflow, and reconcile any production hotfix or rollback commit back into `main` before further promotion.
