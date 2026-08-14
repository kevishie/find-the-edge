---
title: "FTE-077: Right-Size Read Consistency in the Control Plane"
type: "refactor"
created: "2026-08-13"
status: "in-review"
review_loop_iteration: 2
baseline_commit: "129b3a3d1901605532c9fcb7598e20ff2ff9c3bd"
context:
  - "{project-root}/_bmad-output/implementation-artifacts/spec-fte-077-right-size-read-consistency/SPEC.md"
  - "{project-root}/_bmad-output/implementation-artifacts/spec-fte-077-right-size-read-consistency/consistency-inventory.md"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Strong consistency is applied to observational DynamoDB reads that can safely tolerate stale replicas, doubling their read-capacity cost while obscuring which strong reads are correctness-critical.

**Approach:** Keep every ownership, lease, fence, replay, evidence, checkpoint, authorization, quota, provider-health, durable-decision readiness, and stale-index read strong. Explicitly opt six audited observational queries and two fail-closed readiness probes into eventual consistency, with stale-behavior tests.

## Boundaries & Constraints

**Always:** Gateway defaults stay strong. A stale read may only delay work, return timestamped observational state, or omit immutable history. Every retained strong site names the invariant it protects. FTE-075 must have a valid recorded baseline before deployment, completion, or any savings claim.

**Ask First:** Any additional downgrade, gateway-default change, or change to current evidence, retrospective queries, data schemas, deployment, or measurement methodology.

**Never:** Weaken ownership, optimistic versions, replay/idempotency, evidence, checkpoints, authorization, entitlements, quotas, terminal selection, or strong rereads that neutralize stale GSIs. Do not deploy, mark done, or claim savings in this implementation checkpoint.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Readiness replica is stale or malformed | Latch is missing or not the exact initialized value | Return uninitialized and perform no projection work | Fail closed; retry on a later invocation |
| Durable-decision readiness is checked | Paper-pick scheduling or opportunity generation can persist the result of a miss | Read the latch through the strong gateway default before any terminal skip, generation, disqualification, or lifecycle mutation | Never turn a replica-lagged miss into durable state |
| Observational list replica lags | New immutable/list row is omitted or a removed watch row remains | Return only validated requester-scoped, timestamped, or immutable data | Never mutate authority or cross a requester partition |
| Provider health changes | A recent healthy row is superseded by a durable outage or exhausted capacity | Batch and single status reads observe the latest durable health row | Retain strong consistency; never allow a replica-lagged healthy state |
| Protected read is reviewed | Ownership, evidence, version, auth, quota, or checkpoint site | Strong consistency remains | Nearby comment names the breakage prevented |

</frozen-after-approval>

## Code Map

- `packages/database/src/dynamodb-event-ingestion.ts` and `aws-dynamo-gateway.ts` -- optional per-call `get` consistency while preserving strong default.
- `packages/database/src/event-projection-readiness.ts` -- centralized exact readiness-latch helper.
- `packages/database/src/watchlist-repository.ts`, `dynamodb-odds-history-repository.ts`, `dynamodb-strategy-experiment-repository.ts`, `dynamodb-scouting-report-repository.ts`, `dynamodb-cohort-repository.ts`, and `opportunities/dynamodb-opportunity-lifecycle-repository.ts` -- six approved observational downgrades.
- `packages/database/src/odds-control-plane.ts` -- provider health remains strongly consistent for both batch presentation and quota reads.
- `apps/api/src/lambda.ts` and `apps/workers/src/live-odds-lambda.ts` -- shared eventual readiness helper callers whose stale miss only delays work.
- `apps/workers/src/paper-pick-scheduler-runtime.ts` and `apps/workers/src/opportunities/opportunity-generation-lambda.ts` -- shared strong readiness helper callers because a miss can drive durable state.
- `packages/database/src/watchlist-repository.ts` and `apps/api/src/handler.ts` -- eventual UI list plus bounded strong requester-scoped candidate lookup for DELETE.
- Matching database/API/worker test files -- request-shape and stale-behavior coverage.

## Tasks & Acceptance

**Execution:**

- [x] Add explicit eventual and strong-default readiness helpers; keep exactly two delay-only callers eventual and two durable-decision callers strong.
- [x] Change exactly six approved repository reads to eventual consistency and retain strong provider-health reads.
- [x] Add invariant comments to every retained strong site in the audited inventory.
- [x] Add the complete stale-read safety matrix without changing protected behavior.
- [x] Run focused database, API, and worker tests, typechecks, lint, and owned-file formatting.
- [x] Complete the required blind and edge-case review and resolve its consistency and stale-test findings.

**Acceptance Criteria:**

- Given the audited source tree, when consistency settings are enumerated, then only the six repository sites and two delay-only readiness probes are newly eventual; all defaults, provider-health reads, and durable-decision readiness probes remain strong.
- Given a stale result on each downgraded path, when its caller handles it, then no positive readiness, authorization, ownership, evidence, completion, or cross-requester result is fabricated.
- Given existing protected workflows, when their regression suites run, then leases, replay, evidence, quota, auth, checkpoints, grades, results, paper picks, and opportunity joins remain unchanged.
- Given no valid recorded FTE-075 baseline, when this checkpoint completes, then no deployment, done status, or capacity/dollar claim occurs.

## Spec Change Log

- 2026-08-13, review iteration 1: Edge Case Hunter showed that a replica-lagged recent healthy provider row can supersede a durable outage or exhausted-capacity state. Removed `getHealthMany` from the downgrade set, restored its strong batch read, moved provider health into the retained-strong inventory, and required explicit strong-read coverage. KEEP: the six immutable/requester-scoped observational downgrades, exact readiness validation, strong gateway defaults, invariant comments, and FTE-075 deployment/claim gate.
- 2026-08-13, review iteration 1: Blind Hunter showed that DELETE depended on an eventual watchlist query, while paper-pick and opportunity-generation readiness misses can create durable terminal/generation or lifecycle state. Added a bounded strong requester-scoped exact watchlist lookup for DELETE, retained the UI list as eventual, and restored the two durable-decision readiness callers to the strong gateway default. KEEP: six observational list/history downgrades, the API and live-odds delay-only readiness probes, strong defaults, and the FTE-075 gate.
- 2026-08-13, review iteration 2: Independent re-review returned CLEAN after the iteration-1 corrections. The complete repository gate also passed, including all 34 desktop and mobile browser tests. KEEP: status remains `in-review` until the valid FTE-075 baseline permits deployment and measured verification.

## Design Notes

Strong consistency is the default policy. Eventual consistency is a named exception at observational boundaries, so future callers cannot inherit weaker behavior accidentally.

## Verification

**Commands:**

- `pnpm --filter @find-the-edge/database test && pnpm --filter @find-the-edge/database typecheck && pnpm --filter @find-the-edge/database lint` -- database behavior and types pass.
- `pnpm --filter @find-the-edge/api test && pnpm --filter @find-the-edge/api typecheck && pnpm --filter @find-the-edge/api lint` -- provider-status and readiness callers pass.
- `pnpm --filter @find-the-edge/workers test && pnpm --filter @find-the-edge/workers typecheck && pnpm --filter @find-the-edge/workers lint` -- worker readiness and protected ingestion behavior pass.
- `pnpm exec prettier --check <changed-files>` and `git diff --check` -- changed files are formatted and whitespace-clean.
