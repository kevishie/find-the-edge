---
title: 'Disable Automatic Provider Ingestion in Staging'
type: 'chore'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '5cf7c20053d2a08dfa51913e391899a5dc7e26b8'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture.md'
  - '{project-root}/docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Staging continuously runs the one-minute SharpAPI live-odds fast lane and universal provider landing, producing paid provider traffic and heavy DynamoDB read/write amplification even when no ingestion test is in progress. Staging is a pre-production verification environment and does not need an always-live market feed.

**Approach:** Make recurring data-plane work stage-owned: persistent staging deploys with automatic provider ingestion and its dependent opportunity schedules disabled, while production retains its current live-odds cadence. Keep the staging Lambdas, secrets, queues, checkpoints, outputs, and manual invocation path intact so an operator can explicitly run bounded ingestion tests.

## Boundaries & Constraints

**Always:** Derive the persistent-stage scheduling policy deterministically from the selected stage; fail deployment/preflight when staging requests automatic scheduling or production requests the normal live-odds scheduler off. In staging, synthesize the Live Odds, Provider Landing, Opportunity Generation, and Opportunity Expiration EventBridge rules as disabled. Preserve existing staged data and last-good reads. Preserve both provider Lambda outputs and all quota, checkpoint, idempotency, DLQ, secret, and manual-invocation safeguards. Production live-odds cadence remains one minute with its existing fast lane.

**Ask First:** Re-enable any recurring provider acquisition in staging; promote universal Provider Landing scheduling to production; share or replicate provider records across environment tables; delete or rewrite retained staging data; alter production provider cadence or quota policy.

**Never:** Delete the staging table, secret, queues, functions, checkpoints, or historical rows. Do not make deployment smoke or preflight issue paid provider calls. Do not weaken manual invocation authorization, quota admission, or maintenance fences. Do not introduce cross-environment reads in this change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Staging deploy | Stage `staging` | Four recurring data-plane rules synthesize `DISABLED`; functions and outputs remain | Reject any contradictory scheduler configuration before deployment |
| Production deploy | Stage `prod` | Existing one-minute Live Odds and five-minute opportunity rules remain enabled; Provider Landing remains at its current promotion-gated state | Reject accidental production scheduler disablement |
| Manual staging test | Operator invokes an output-resolved provider Lambda | Existing bounded worker executes under quota/checkpoint/idempotency controls | Existing safe failure, cooldown, DLQ, and terminal handling remain unchanged |
| Repeated staging deployment | Default protected workflow | Rules remain disabled without relying on a remembered console setting | Static preflight rejects template drift |

</frozen-after-approval>

## Code Map

- `infra/cdk/src/app.ts` -- parses the stage and scheduler setting used by CDK synthesis.
- `infra/cdk/src/foundation.ts` -- owns Live Odds, Provider Landing, and dependent opportunity EventBridge rules plus manual Lambda outputs.
- `infra/cdk/src/foundation.test.ts` -- pins exact rule state by stage and preserves manual resources.
- `scripts/phase1-launch.mjs` -- constructs the protected deployment environment; currently forces scheduling on for every stage.
- `scripts/phase1-preflight.mjs` -- synthesizes the credential-free template with the same stage policy.
- `scripts/phase1-support.mjs` -- validates deployment configuration and the synthesized Live Odds rule.
- `scripts/phase1-launch.test.mjs`, `scripts/phase1-support.test.mjs` -- protect stage policy and refuse contradictory templates/configuration.
- `docs/phase1-deployment.md`, `docs/environment-promotion.md`, `docs/runbooks/sharpapi.md` -- operator contract for automatic versus manual ingestion.

## Tasks & Acceptance

**Execution:**
- [x] `infra/cdk/src/app.ts`, `infra/cdk/src/foundation.ts` -- encode explicit stage-owned recurring-data-plane policy while preserving functions and manual outputs.
- [x] `scripts/phase1-launch.mjs`, `scripts/phase1-preflight.mjs`, `scripts/phase1-support.mjs` -- make protected deploy/preflight select and validate staging-off/production-on deterministically.
- [x] `infra/cdk/src/foundation.test.ts`, `scripts/phase1-launch.test.mjs`, `scripts/phase1-support.test.mjs` -- add staging/production matrices and contradictory-state regressions.
- [x] `docs/phase1-deployment.md`, `docs/environment-promotion.md`, `docs/runbooks/sharpapi.md` -- document the quiet staging default and explicit manual canary path.

**Acceptance Criteria:**
- Given a staging synthesis, when the template is inspected, then no recurring provider or opportunity rule is enabled and both provider function outputs remain present.
- Given a production synthesis, when the template is inspected, then the existing Live Odds cadence and dependent opportunity schedules remain enabled and universal Provider Landing is not newly promoted.
- Given the protected deploy or preflight path, when its scheduler state contradicts the selected persistent stage, then it fails before CloudFormation mutation.
- Given a staging deployment, when no operator explicitly invokes a provider Lambda, then staging makes no scheduled SharpAPI acquisition calls.

## Spec Change Log

## Design Notes

This is the first cost-control increment. A later design may create a single provider data plane and replicate normalized, license-safe projections into environment-owned product stores. That architectural move must separately resolve environment isolation, provider licensing, blast radius, replay semantics, freshness SLAs, and production-to-staging testability; it is intentionally not smuggled into this scheduler shutdown.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/infra-cdk test` -- staging/production CDK rule matrix passes.
- `pnpm phase1:test` -- deployment policy and template validation suites pass.
- `pnpm check` -- repository format, lint, typecheck, test, build, and browser gates pass.
- `git diff --check` -- no malformed patch whitespace.

**Manual checks (after deployment):**
- Inspect the staging stack rules and confirm Live Odds, Provider Landing, Opportunity Generation, and Opportunity Expiration are disabled while both provider Lambda outputs still resolve.
- Compare staging table consumed read/write capacity and Lambda invocation counts over an equivalent post-deploy window; no scheduled provider invocations should appear.

## Suggested Review Order

**Stage-owned scheduling policy**

- Central policy makes staging quiet, production live, and legacy environments flag-controlled.
  [`environments.ts:22`](../../infra/cdk/src/environments.ts#L22)

- CDK applies the policy while retaining the universal landing worker and output.
  [`foundation.ts:751`](../../infra/cdk/src/foundation.ts#L751)

- Protected launches derive recurrence from the selected environment before AWS mutation.
  [`phase1-launch.mjs:179`](../../scripts/phase1-launch.mjs#L179)

**Queued-work shutdown and manual access**

- Staging acknowledges queued cadence messages before secrets, storage, or provider calls.
  [`live-odds-lambda.ts:157`](../../apps/workers/src/live-odds-lambda.ts#L157)

- Scheduled landing retries stop while direct operator invocations remain available.
  [`provider-landing-lambda.ts:205`](../../apps/workers/src/provider-landing-lambda.ts#L205)

**Fail-closed deployment validation**

- Preflight binds exact outputs, worker identities, schedules, states, and sole targets.
  [`phase1-support.mjs:243`](../../scripts/phase1-support.mjs#L243)

- Operator guidance records quiet staging, queued-work fencing, and production ownership.
  [`environment-promotion.md:12`](../../docs/environment-promotion.md#L12)

**Regression coverage**

- Schedule matrices pin staging-off and production-on synthesis behavior.
  [`foundation.test.ts:1406`](../../infra/cdk/src/foundation.test.ts#L1406)

- Static tests reject decoys, joint retargeting, fan-out, and missing outputs.
  [`phase1-support.test.mjs:19`](../../scripts/phase1-support.test.mjs#L19)

- Worker tests prove queued shutdown does not remove manual invocation.
  [`live-odds-lambda.test.ts:17`](../../apps/workers/src/live-odds-lambda.test.ts#L17)
