---
title: 'FTE-MVP-001A3 Dynamic Fixture Odds Seed'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '8379c48'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** A1/A2 provide a proven odds kernel and persistent adapter, but no bounded operator command creates canonical MLB/MLS fixtures and prices them using the canonical identity/version actually stored by DATA002.

**Approach:** Add deterministic MLB/MLS odds fixture material and an operator-invokable seed service/Lambda that runs DATA002 fixture schedule ingestion, resolves the exact persisted mapping/canonical binding, then persists observations through A2. Deploy the seed resource only in the dev stage.

## Boundaries & Constraints

**Always:** Support exactly existing fixture-development MLB and MLS schedule pages, one bounded page per league. After DATA002 ingestion completes, strongly resolve the exact provider mapping and canonical record for each fixture; build observations from returned canonical ID/version/sport/league, never constants. Reruns after canonical version advancement succeed and bind the current version. Persist each fixture event's bounded prices deterministically through A2; report created/existing/current outcomes. Lambda invocation is explicitly environment-gated and CDK creates the function, write role, and output only when stage is exactly `dev` and configuration enables it. Non-dev enablement is rejected at configuration/synth time. IAM is table-scoped to exact Get/Query/Put/TransactWrite operations; no Scan. Failure is fail-closed with event/fixture context and no secret payload logging.

**Block If:** DATA002 cannot expose exact mapping+canonical binding without a small read-only store extension, or an event's bounded multi-observation seed cannot safely resume through A2 idempotence after partial invocation failure.

**Never:** Add schedules/EventBridge, automatic invocation, production-stage seed resource, live provider calls, pagination, quotas, retry/recovery state, API `/games`, web UI/auth/CORS, recommendations, or new sports. Do not hard-code canonical IDs/versions. Do not seed at API cold start.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| First/rerun | Enabled dev invocation | Canonical fixtures and bounded odds converge | Counts distinguish created/existing |
| Canonical advance | Event version changed before rerun | Observations bind freshly resolved version | No stale constant failure |
| Partial prior run | Some observations already persisted | Rerun resumes idempotently | Existing is success |
| Missing/rebound mapping | Exact binding unavailable/mismatched | No unbound odds write | Typed contextual failure |
| Disabled/non-dev | Lambda disabled or stage not dev | No seed execution/resource | Reject invocation/configuration |

</intent-contract>

## Code Map

- `packages/providers/src/fixtures/mvp-odds.ts` -- deterministic MLB/MLS odds material keyed only by provider event identity.
- `packages/database/src/event-ingestion.ts` and stores -- read-only exact canonical binding contract if needed.
- `apps/workers/src/fixture-odds-seed.ts` -- DATA002 schedule→binding→A2 composition and result summary.
- `apps/workers/src/fixture-odds-seed-lambda.ts` -- strict environment gate and AWS composition.
- `infra/cdk/src/foundation.ts`, `app.ts` -- dev-only resource, least-privilege IAM, and function-name output.

## Tasks & Acceptance

**Execution:**
- [x] providers/database -- add bounded odds fixture material and exact read-only canonical binding needed by seed.
- [x] workers -- implement deterministic seed composition/Lambda and tests for first/rerun/version advance/partial/missing mapping/disabled cases.
- [x] CDK -- create seed function/IAM/output only for explicitly enabled dev; reject non-dev enablement and assert absence elsewhere.

**Acceptance Criteria:**
- Given seed twice, when the second invocation runs, then canonical/odds state converges without duplicate history or surfaced conditional conflicts.
- Given canonical version advances, when seed reruns, then newly built observations use the freshly resolved version.
- Given prod or another non-dev stage, when enablement is requested, then configuration/synth rejects it and no write-capable seed resource exists.
- Given full gates/synth, then operator invocation is proven without API/UI, schedules, live calls, or Scan.

## Spec Change Log

## Review Triage Log

### Patch 4 — Edge Case Hunter

| Severity | Classification | Finding | Resolution |
|---|---|---|---|
| High | local_patch | Schedule fixtures could be written before exact schedule↔odds coverage was proven. | Preflight now loads every bounded page/bootstrap and proves exact scoped one-to-one coverage before the first store write. |
| High | local_patch | Duplicate scoped odds provider-event identities were not rejected before writes. | Duplicate scoped identities now fail during preflight with zero canonical or odds writes. |
| Medium | local_patch | A2 failures lacked typed market/selection context and preserved cause. | `FixtureOddsSeedError` now carries provider event, market, selection, and cause while excluding payload details from its message. |
| Low | local_patch | A whitespace-only table environment value passed the runtime gate. | Table names are trimmed and blank values are rejected. |

Triage summary: local patches 4 (High 2, Medium 1, Low 1); bad spec 0; intent conflict 0.

## Design Notes

Partial event pricing is resumed rather than rolled back across observations: each A2 observation is content-addressed and idempotent, so rerunning the bounded operator command completes missing observations without a new recovery workflow.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/workers test` -- seed convergence/version/gate tests pass.
- `pnpm --filter @find-the-edge/infra-cdk test` -- dev-only resource/IAM tests pass.
- `pnpm check` -- workspace gates pass.
- `pnpm synth` -- configured dev synth succeeds; configured prod enablement fails.

**Results:**
- `pnpm --filter @find-the-edge/workers test` -- 36/36 passed, including seed convergence, canonical-version refresh, partial resume, preflight zero-write failures, contextual causes, missing binding, and runtime gate.
- `pnpm --filter @find-the-edge/infra-cdk test` -- 6/6 passed, including dev-only resource/output/exact IAM and non-dev rejection/absence.
- `pnpm check` -- passed all format, lint, boundary, typecheck, test, and build gates.
- Configured dev synth with `FTE_FIXTURE_ODDS_SEED_ENABLED=true` -- passed and emitted `FixtureOddsSeedFunctionName`; template contains no `dynamodb:Scan`.
- Configured prod synth with the same enablement -- rejected with `fixture odds seed can only be enabled for the dev stage`.
