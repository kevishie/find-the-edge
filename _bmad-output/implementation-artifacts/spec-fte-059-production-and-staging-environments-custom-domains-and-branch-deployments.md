---
title: 'FTE-059 Production and Staging Environments, Custom Domains, and Branch Deployments'
type: 'feature'
created: '2026-08-07'
status: 'ready-for-dev'
baseline_commit: '260d140c522e65942df42df3984325ceadeef5c2'
review_loop_iteration: 0
followup_review_recommended: true
context: [FTE-MVP-001D, FTE-MVP-001E, FTE-058]
warnings: [dns-cutover, production-deployment, retained-resources, privileged-ci]
---

# Story FTE-059: Production and Staging Environments, Custom Domains, and Branch Deployments

Status: in-progress

## Story

As the FIND THE EDGE operator,
I want isolated staging and production AWS environments with custom web/API domains and branch-driven deployments,
so that reviewed changes can be proven in staging and promoted predictably to the production site at `kevishie.com`.

## Environment Contract

| Git mainline | AWS stage | Web origin | API origin | Deployment policy |
|---|---|---|---|---|
| `staging` | `staging` | `https://staging.kevishie.com` | `https://api-staging.kevishie.com` | Deploy the exact CI-verified head commit after merge/push |
| `main` | `prod` | `https://kevishie.com` | `https://api.kevishie.com` | Deploy the exact CI-verified head commit after required production approval |

Feature branches never deploy persistent AWS environments. Promotion is by pull request from a feature branch to `staging`, validation on the deployed staging commit, then pull request from `staging` to `main`. Production is not rebuilt from staging artifacts blindly: both deployments use the same versioned build process and record the exact Git SHA, while production deploys the SHA merged into `main`.

## Acceptance Criteria

1. **Isolated environment configuration and resources**
   - Given credential-free configuration for `staging` or `prod`, when CDK synth/preflight runs, then stack names, resource names, runtime configuration, secrets, logs, queues, tables, Cognito resources, S3 assets, CloudFront distributions, API Gateway routes, alarms, and deployment locks are environment-scoped and no environment references the other environment's mutable resources or secrets.
   - `FTE_AWS_STAGE` accepts only `local`, `staging`, or `prod` for the new path. Legacy `dev` remains readable/deployable only through an explicitly documented migration/rollback path until its retained resources are dispositioned in a separate approved operation.
   - The implementation must not rename, replace, import, delete, empty, or repurpose `FindTheEdge-dev-Foundation`, its retained table/bucket/user pool/logs, or `find-the-edge/dev/*` secrets as an incidental effect of this story.

2. **Custom web and API domains**
   - Given validated certificates and authoritative DNS, when the staging environment is deployed, then `https://staging.kevishie.com` serves the staging SPA and `https://api-staging.kevishie.com` serves only the staging API.
   - Given approved production cutover, when production is deployed, then `https://kevishie.com` serves the production SPA and `https://api.kevishie.com` serves only the production API.
   - CloudFront uses an ACM certificate valid for its exact web hostname in `us-east-1`, TLS-only viewer behavior, private S3 origin access, existing security/cache headers, and SPA routing behavior. API Gateway uses a Regional HTTP API custom domain, TLS 1.2 or stronger, an ACM certificate in the API region, an explicit API mapping, and DNS pointing to the Regional domain.
   - Route 53 alias `A` and `AAAA` records are preferred after the `kevishie.com` public hosted zone is authoritative in Route 53. If DNS remains with another provider, infrastructure emits the exact certificate-validation and endpoint targets and the runbook documents provider-supported records; it must not claim an apex `CNAME` is valid.
   - Runtime config, Cognito callback/logout URLs, API JWT/CORS configuration, CSP `connect-src`, smoke inputs, and stack outputs use the environment's custom origins—not `execute-api`, CloudFront, placeholder, or cross-environment origins.

3. **Safe DNS ownership and cutover**
   - Before any nameserver or apex mutation, the operator runbook captures the current authoritative name servers, complete DNS record set, TTLs, apex response, and rollback targets. As observed while creating this story, authoritative name servers are `ns-cloud-d1` through `ns-cloud-d4.googledomains.com` and the apex resolves to `173.230.142.141`; implementation must re-query rather than trust these values at execution time.
   - Certificate validation and both staging subdomains may be prepared without moving the apex where the current DNS provider supports the required records. Changing registrar settings, authoritative name servers, or the `kevishie.com` apex requires explicit human approval after staging smoke passes.
   - The cutover plan lowers TTLs in advance where supported, verifies ACM issuance before traffic changes, preserves all unrelated DNS/MX/TXT records, confirms public resolution from more than one resolver, and contains an exact rollback to the captured prior apex/name servers. No automated test or ordinary branch push changes registrar delegation.

4. **Branch-driven CI/CD**
   - Pull requests and pushes to both `staging` and `main` run the existing quality, coverage, synth/preflight, and browser gates. A failed or cancelled gate cannot obtain deployment credentials or deploy.
   - A successful quality run for `staging` deploys only to the GitHub `staging` environment; a successful quality run for `main` deploys only to the GitHub `production` environment. Each job checks out and deploys the exact verified SHA and refuses an outdated branch revision.
   - GitHub Environment deployment-branch restrictions allow only `staging` for staging and only `main` for production. Production requires a reviewer and disallows bypass where the repository plan supports it; if the plan cannot enforce reviewers, the workflow uses an explicit `workflow_dispatch` approval gate and documents the residual limitation rather than silently auto-deploying production.
   - Concurrency groups are environment-specific, serialize mutation per environment, and do not allow a staging job to cancel or block production (or vice versa).
   - Branch protection requires pull requests and successful required checks on both mainlines. Force pushes and deletion are disabled. The repository documents the normal promotion flow and hotfix flow; a production hotfix must be merged back into `staging` immediately after `main` deployment.

5. **Least-privilege deployment identity and secrets**
   - Staging and production use separate GitHub OIDC deployment roles or equivalently isolated role policies. Trust is restricted to this immutable GitHub owner/repository identity and the intended GitHub Environment subject (or exact branch subject when no Environment is referenced); no wildcard subject, pull-request subject, static AWS access key, or cross-environment secret access is allowed.
   - Replace the current shared `AdministratorAccess` bootstrap role with reviewed least-privilege permissions sufficient for the guarded CDK/assets/smoke path, or record a time-bounded exception with a follow-up issue and explicit human approval before production.
   - Provider credentials and cursor-signing material are stored under distinct `find-the-edge/staging/*` and `find-the-edge/prod/*` names. GitHub environment secrets/variables are isolated; logs, artifacts, stack outputs, runtime config, and browser assets contain no secret values.

6. **Deployment, smoke, rollback, and provenance**
   - Each deployment reuses the existing guarded launch invariants: verify AWS account/region before every mutation, run bounded drift detection, reject destructive retained-resource changes, deploy infrastructure, build/upload versioned assets, await CloudFront invalidation, and run environment-specific API/CORS/DNS/TLS/browser smoke.
   - Smoke proves the expected Git SHA/environment marker, web hostname, API hostname, API mapping, exact CORS/CSP, HTTPS redirect, direct-S3 denial, representative games/odds read, alarms, and absence of cross-environment identifiers. Production smoke failure stops the release and invokes the documented application/infrastructure/DNS rollback boundaries; it never deletes retained data.
   - Deployments emit environment, stack, Git SHA, start/end time, result, and rollback metadata without credentials or licensed provider payloads. A release summary links the GitHub run to the CloudFormation stack and smoke result.

7. **Verification and documentation**
   - Automated tests mutate synthesized templates/workflow inputs to prove cross-environment names, wrong hosts, wildcard CORS/OIDC, stale SHA, wrong branch, unsafe DNS, shared secrets, destructive retained-resource changes, and production-without-approval are rejected.
   - `pnpm check`, `pnpm phase1:test`, credential-free synth/preflight for both `staging` and `prod`, workflow lint/structural tests, and local smoke contract tests pass.
   - The deployment runbook documents prerequisites, DNS ownership, certificate validation, one-time OIDC/GitHub Environment setup, branch protections, staging deploy, promotion, production approval/cutover, smoke, rollback, hotfix reconciliation, and legacy `dev` disposition as an explicit later decision.

## Tasks / Subtasks

- [x] **Task 1: Generalize the environment contract and stacks** (AC: 1, 6, 7)
  - [x] Replace dev-only constants/defaults with a validated typed stage descriptor for `staging` and `prod`; keep safe local synth and a fenced legacy-dev migration path.
  - [x] Scope every physical name, secret reference, output, deployment lock, runtime marker, and smoke target by stage; add cross-environment and destructive-change tests.
  - [x] Inventory current `FindTheEdge-dev-Foundation` retained resources and document that cleanup/migration is out of scope and approval-gated.

- [x] **Task 2: Add custom-domain infrastructure** (AC: 2, 3, 7)
  - [x] Add/reuse ACM certificates, CloudFront alternate domains, API Gateway HTTP API Regional custom domains/mappings, and Route 53 records or explicit external-DNS outputs.
  - [x] Derive runtime config, auth callbacks, CORS, CSP, and smoke URLs from the stage descriptor.
  - [x] Add synth assertions and negative tests for certificate region, host mismatch, apex CNAME, wrong API mapping, cross-stage records, and unrelated DNS-record removal.

- [x] **Task 3: Split and harden CI/CD** (AC: 4, 5, 6)
  - [x] Extend quality triggers to `staging` and `main`; replace the single dev deploy path with environment-mapped deployment jobs that consume the exact successful SHA.
  - [x] Add GitHub `staging` and `production` Environment contracts, environment-specific concurrency, approval behavior, branch restrictions, and release metadata.
  - [x] Replace/update the OIDC bootstrap template with isolated trust and least-privilege environment roles; test exact immutable repository/environment subjects and reject wildcard/pull-request trust.

- [x] **Task 4: Make launch and smoke environment-aware** (AC: 1, 2, 5, 6, 7)
  - [x] Generalize preflight, bundle, launch, runtime-config generation, asset rollback, and smoke scripts without weakening current identity, drift, retention, redaction, CORS, CSP, auth, or S3/CloudFront checks.
  - [x] Validate public DNS, TLS certificate/hostname, API mapping, environment/Git SHA marker, and cross-environment isolation with bounded retries for AWS/DNS propagation.

- [ ] **Task 5: Prepare and execute staged rollout** (AC: 3, 4, 6, 7)
  - [ ] Create/protect `staging`; configure GitHub Environments, secrets/variables, OIDC roles, certificates, and DNS validation through the documented one-time operator procedure.
  - [ ] Deploy and smoke `staging` from the `staging` branch before requesting production DNS approval.
  - [ ] After explicit approval, merge the proven revision to `main`, deploy production, cut over the apex/API records, run production smoke, and record rollback/provenance evidence.

## Dev Notes

### Current State to Preserve

- `.github/workflows/ci.yml` currently runs only for `main`; `.github/workflows/deploy-phase1.yml` deploys the exact successful `main` SHA but targets the existing dev launch path. Preserve its stale-revision refusal and quality-before-credentials ordering.
- `infra/github-actions-deploy-role.yml` currently trusts only the immutable repository identity on `refs/heads/main` but attaches `AdministratorAccess`. Environment-based jobs change the OIDC `sub` claim to the Environment form; update trust and tests together.
- `infra/cdk/src/app.ts` binds the authorized account `228246988391`, region `us-east-1`, and defaults to `local`. Do not widen account/region authorization as part of multi-stage support.
- `infra/cdk/src/foundation.ts` currently builds one stage-scoped foundation containing retained DynamoDB/Cognito/S3/log resources, CloudFront, HTTP API, Lambdas, workers, and environment-aware names. Extend this construct; do not create a parallel infrastructure implementation.
- `scripts/phase1-launch.mjs`, `scripts/phase1-preflight.mjs`, `scripts/phase1-environment-smoke.mjs`, and `docs/phase1-deployment.md` already contain identity, drift, destructive-change, asset rollback, redaction, and live smoke protections. Parameterize and strengthen them rather than bypassing them in YAML.
- The current apex is live at another target and authoritative DNS is external to Route 53. Treat DNS cutover as a user-visible production migration, not routine CDK deployment.
- FTE-058 is related release-readiness scope, not a prerequisite: this story is independently implementable from the completed Phase1 launch/smoke foundation and must feed its environment/promotion results back into FTE-058's eventual final release checklist.

### Architecture Compliance

- Continue AWS CDK v2, TypeScript, API Gateway HTTP API + Lambda, private S3 + CloudFront, typed runtime config, Secrets Manager, CloudWatch, and GitHub Actions OIDC. Infrastructure may reference package/environment contracts but must not import runtime business logic.
- Staging and production must be independently deployable and roll back independently. Separate AWS accounts are preferred by AWS, but this story may use the authorized account with strict stage isolation because the repository is currently account-bound; document this residual blast-radius risk.
- Keep DynamoDB evolution additive and all retained-resource checks fail-closed. No environment setup task is authorization to migrate or erase current dev/product data.

### File Structure Requirements

- **UPDATE:** `.github/workflows/ci.yml`, `.github/workflows/deploy-phase1.yml` (or replace with clearly named staging/production workflows), `infra/github-actions-deploy-role.yml`, `infra/cdk/src/app.ts`, `infra/cdk/src/foundation.ts`, their tests, Phase1 deployment scripts/tests, `package.json`, and `docs/phase1-deployment.md`.
- **NEW only if separation materially improves clarity:** a typed `infra/cdk/src/environments.ts`, workflow structural test/fixture, and a dedicated `docs/environment-promotion.md`. Do not duplicate full CDK stacks or launch scripts per environment.
- Do not commit synthesized `cdk.out`, generated runtime config containing deployed identifiers, AWS outputs, DNS exports, tokens, passwords, provider keys, or smoke artifacts.

### Testing Requirements

- CDK assertions: exact web/API domains, certificates, API mapping, Route 53 alias targets where managed, stage-scoped resources/secrets, retention, TLS/security policies, and no cross-environment references.
- Workflow/identity tests: exact event-to-stage mapping, exact verified SHA, quality conclusion, stale-head refusal, environment and concurrency names, approval gate, OIDC subject, and least-privilege policy boundaries.
- Script tests: config matrix (`local`, `staging`, `prod`, rejected `dev` except fenced migration), DNS/TLS failures, propagation timeout, wrong account/region, unsafe diff, rollback, redaction, and environment marker mismatch.
- Live staging proof precedes production approval. Never use production as the first integration test.

### Latest Technical Notes

- CloudFront custom-domain certificates must be in `us-east-1`; Route 53 can alias the zone apex to CloudFront. [AWS CloudFront alternate domains](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CreatingCNAME.html) [AWS Route 53 static site routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/getting-started-cloudfront-overview.html)
- A Regional API Gateway custom domain requires an ACM certificate in the API's region and a DNS alias/CNAME to its Regional hostname. [AWS API Gateway Regional custom domains](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-regional-api-custom-domain-create.html) [AWS Route 53 API Gateway routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-api-gateway.html)
- GitHub Environments can restrict deployment branches and gate secrets behind protection rules. Jobs referencing an Environment use an Environment-based OIDC subject rather than the branch subject. [GitHub deployments and environments](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/workflows-and-actions/deployments-and-environments) [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- AWS recommends isolating deployment stages in separate environments/accounts. This story preserves the fixed authorized account while requiring resource, role, secret, and pipeline isolation and recording the remaining shared-account risk. [AWS CDK Pipelines guidance](https://docs.aws.amazon.com/cdk/v2/guide/cdk-pipeline.html)

### References

- [Source: `_bmad-output/planning-artifacts/architecture.md` §5, §23, ADR-010]
- [Source: `_bmad-output/planning-artifacts/epics-and-stories.md` Epic 11, FTE-058]
- [Source: `_bmad-output/planning-artifacts/prd.md` §9.1 and Technical Assumptions]
- [Source: `_bmad-output/implementation-artifacts/spec-fte-mvp-001d-phase1-deployment-and-environment-smoke.md`]
- [Source: `_bmad-output/implementation-artifacts/spec-fte-mvp-001e-aws-native-auth-and-static-hosting-launch-layer.md`]
- [Source: `.github/workflows/ci.yml`, `.github/workflows/deploy-phase1.yml`, `infra/github-actions-deploy-role.yml`]
- [Source: `infra/cdk/src/app.ts`, `infra/cdk/src/foundation.ts`, `docs/phase1-deployment.md`]

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

- Implemented a single typed environment contract shared by CDK, workflow validation, launch, and smoke tooling, with explicit legacy-dev fencing.
- Added custom-domain synthesis and negative assertions before wiring the workflow and operator runbook.
- Verified both credential-free staging and production preflight/bundle paths and the complete Phase1 test suite.
- Full-repository `pnpm check` and `pnpm test` are currently blocked by pre-existing concurrent changes in `packages/database/src/games-repository.ts`; focused infrastructure and Phase1 suites pass.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Story assumes `main` is the production mainline and `staging` is the staging mainline, matching the requested branch-driven promotion model.
- DNS state was observed on 2026-08-07 and is explicitly required to be revalidated before implementation/cutover.
- Added isolated staging/production branch-to-environment deployment mapping, exact-SHA checks, environment-specific concurrency, and separate OIDC roles without `AdministratorAccess`.
- Added `kevishie.com`, `api.kevishie.com`, `staging.kevishie.com`, and `api-staging.kevishie.com` infrastructure contracts, provenance outputs, runtime bindings, and bounded public smoke validation.
- Added a complete operator runbook for certificates, external DNS, GitHub Environments, branch protection, promotion, rollback, hotfix reconciliation, and retained legacy-dev resources.
- Tasks 1-4 are complete and locally verified. Task 5 remains approval-gated pending live AWS/GitHub/DNS configuration, staging deployment evidence, and subsequent production approval.
- Superseding branch decision (2026-08-07): `main` is the staging mainline and `production` is the production mainline. Workflow, typed contracts, tests, and operator documentation were updated accordingly.
- Superseding gate decision (2026-08-07): successful quality runs deploy automatically from `main` to staging and from `production` to production; no separate reviewer gate is required for the two-engineer repository.

### File List

- `_bmad-output/implementation-artifacts/spec-fte-059-production-and-staging-environments-custom-domains-and-branch-deployments.md`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-phase1.yml`
- `docs/environment-promotion.md`
- `docs/phase1-deployment.md`
- `infra/cdk/src/app.ts`
- `infra/cdk/src/environments.test.ts`
- `infra/cdk/src/environments.ts`
- `infra/cdk/src/foundation.test.ts`
- `infra/cdk/src/foundation.ts`
- `infra/github-actions-deploy-role.yml`
- `package.json`
- `scripts/build-phase1-web.mjs`
- `scripts/deployment-workflow.test.mjs`
- `scripts/environment-contract.mjs`
- `scripts/environment-contract.test.mjs`
- `scripts/phase1-environment-smoke.mjs`
- `scripts/phase1-environment-smoke.test.mjs`
- `scripts/phase1-launch.mjs`
- `scripts/phase1-launch.test.mjs`
- `scripts/phase1-preflight.mjs`
- `scripts/phase1-support.mjs`
- `scripts/phase1-support.test.mjs`

### Change Log

- 2026-08-07: Implemented environment isolation, custom-domain infrastructure, branch-driven deployment, least-privilege OIDC roles, environment-aware launch/smoke tooling, and the staged promotion runbook. Live rollout remains approval-gated.
- 2026-08-07: Changed branch ownership so `main` deploys staging and `production` deploys production.
- 2026-08-07: Simplified deployment gating to automatic branch-driven releases after successful quality checks.
