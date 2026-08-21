---
title: 'Run staging provider ingestion three times daily'
type: 'chore'
created: '2026-08-19'
status: 'done'
baseline_commit: '20e2917a911027928af02b19fcf9dc6d1b6f4947'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-disable-staging-automatic-provider-ingestion.md'
  - '{project-root}/docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Completely disabling staging provider acquisition minimizes cost but lets its event catalog and odds age indefinitely, so the pre-production site eventually stops representing a working deployment.

**Approach:** Run bounded staging Live Odds and universal Provider Landing acquisition exactly three times per UTC day, stagger their starts to protect shared provider quota, and keep staging opportunity-generation schedules disabled. Production retains its existing one-minute live cadence and inert universal landing worker.

## Boundaries & Constraints

**Always:** Make cadence stage-owned and deterministic; schedule staging Live Odds at 05:00, 13:00, and 21:00 UTC and Provider Landing fifteen minutes later; permit only those retained EventBridge/SQS paths plus existing manual invocation; preserve quota admission, checkpointing, idempotency, retries, DLQs, alarms, secrets, outputs, and the newly hardened DynamoDB retry behavior; statically bind exact rule expression, state, and sole target.

**Ask First:** Change the three-per-day frequency or UTC windows; enable staging opportunity generation/expiration; enable universal Provider Landing in production; alter production Live Odds cadence; change provider quota/reserve policy; deploy anywhere other than the requested branch publication.

**Never:** Restore one-minute staging ingestion; delete retained resources or history; bypass provider/storage safety controls; share production data into staging; allow environment flags or console state to override persistent-stage cadence; include unrelated dirty planning files or `.claude/` in the commit/push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Staging synthesis | Protected `staging` deployment | Live Odds cron runs at hours 05/13/21; Provider Landing runs at minute 15 of those hours; opportunity rules remain disabled | Preflight rejects wrong cadence, state, target, or fan-out |
| Production synthesis | Protected `prod` deployment | Live Odds remains `rate(1 minute)`; Provider Landing remains disabled; opportunities remain enabled | Existing production policy contradictions fail before mutation |
| Staging scheduled run | EventBridge/SQS invocation from retained rules | Normal bounded worker executes under quota/checkpoint/retry controls | Existing transient storage/provider redrive and DLQ behavior remains |
| Manual staging run | Direct retained Lambda invocation | Manual canary remains supported between scheduled windows | Existing maintenance and authorization fences remain |

</frozen-after-approval>

## Code Map

- `infra/cdk/src/foundation.ts` -- owns Live Odds, Provider Landing, and opportunity EventBridge schedules.
- `infra/cdk/src/foundation.test.ts` -- pins exact stage-specific expressions, states, and retained outputs.
- `scripts/phase1-support.mjs` -- statically validates exact synthesized recurring-rule bindings.
- `scripts/phase1-support.test.mjs` -- rejects cadence/state/target/fan-out drift.
- `apps/workers/src/live-odds-lambda.ts` -- currently drops every staging SQS cadence command.
- `apps/workers/src/provider-landing-lambda.ts` -- currently drops every staging scheduled event.
- Matching worker tests -- prove staging scheduled and manual invocations reach normal setup while production behavior is unchanged.
- `docs/phase1-deployment.md`, `docs/environment-promotion.md`, `docs/runbooks/sharpapi.md` -- operator cadence and cost contract.

## Tasks & Acceptance

**Execution:**
- [x] `infra/cdk/src/foundation.ts`, `infra/cdk/src/foundation.test.ts` -- synthesize exact staggered three-daily staging provider schedules without enabling dependent opportunities.
- [x] `scripts/phase1-support.mjs`, `scripts/phase1-support.test.mjs` -- enforce exact per-stage expressions, state, output-resolved worker identity, and sole target.
- [x] `apps/workers/src/live-odds-lambda.ts`, `apps/workers/src/provider-landing-lambda.ts`, matching tests -- remove the obsolete staging scheduled-work drop while retaining manual and retry behavior.
- [x] Deployment/runbook docs -- replace the quiet-staging contract with the explicit UTC cadence and manual-canary guidance.
- [x] Run focused and full gates, inspect the complete branch diff, commit only scoped files, and publish the hardened branch as a draft pull request.

**Acceptance Criteria:**
- Given staging synthesis, when the template is validated, then exactly six provider starts per UTC day are represented by two staggered three-daily rules and no opportunity schedule is enabled.
- Given production synthesis, when compared with the current contract, then its provider and opportunity rule cadence/state is unchanged.
- Given a scheduled staging invocation, when it reaches either worker, then it is not discarded solely because the stage is staging and all existing safety controls still apply.
- Given the mixed working tree, when changes are published, then only the staging cadence work plus the two already-committed hardening changes are pushed.

## Spec Change Log

## Design Notes

The fifteen-minute stagger gives Live Odds first access to the shared authoritative SharpAPI account window. UTC cron expressions are stable across daylight-saving transitions and are easier for preflight to validate than deployment-relative eight-hour rates.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/infra-cdk test` -- exact staging/production schedule matrix passes.
- `pnpm --filter @find-the-edge/workers test` -- scheduled-worker and retry regressions pass.
- `pnpm phase1:test` -- protected deployment and template validation pass.
- `pnpm check && git diff --check` -- repository-wide gates pass.

## Suggested Review Order

**Stage-owned cadence**

- Define staggered staging cron windows while preserving production cadence and safety resources.
  [`foundation.ts:674`](../../infra/cdk/src/foundation.ts#L674)

- Pin exact staging and production rule state without enabling opportunity schedules.
  [`foundation.test.ts:1413`](../../infra/cdk/src/foundation.test.ts#L1413)

**Static deployment safety**

- Bind each stage's exact expression and sole output-resolved ingestion target.
  [`phase1-support.mjs:911`](../../scripts/phase1-support.mjs#L911)

- Reject cadence, state, identity, and fan-out drift in credential-free validation.
  [`phase1-support.test.mjs:19`](../../scripts/phase1-support.test.mjs#L19)

**Worker execution**

- Route scheduled staging Live Odds through the hardened quota and retry control plane.
  [`live-odds-lambda.ts:522`](../../apps/workers/src/live-odds-lambda.ts#L522)

- Route staging Provider Landing through durable account health and checkpoint controls.
  [`provider-landing-lambda.ts:205`](../../apps/workers/src/provider-landing-lambda.ts#L205)

**Operations**

- Document the three daily UTC windows and retained manual canary path.
  [`sharpapi.md:273`](../../docs/runbooks/sharpapi.md#L273)
