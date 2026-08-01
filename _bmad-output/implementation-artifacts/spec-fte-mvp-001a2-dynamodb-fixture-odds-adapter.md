---
title: 'FTE-MVP-001A2 DynamoDB Fixture Odds Adapter'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'f7fb329'
final_revision: 'ed49785'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** A1 proves immutable observation and CURRENT decisions, but the shared DATA002 DynamoDB table has no adapter that enforces those decisions while protecting exact canonical bindings.

**Approach:** Implement and contract-test a DynamoDB adapter that normalizes through A1, condition-checks the exact provider mapping and canonical event, inserts immutable snapshots idempotently, and advances CURRENT in a separate monotonic operation. Add no seed or read API.

## Boundaries & Constraints

**Always:** Use A1 before keys/writes and existing DATA002 keys. Snapshot transaction condition-checks the exact provider mapping still targets canonical event ID and the canonical event still matches ID/version/sport/league, then inserts only if absent. On conditional create loss, strongly reread exactly: identical content is `existing`, different is corruption, absent is binding/conflict. Inspect cancellation reasons; throttle, validation, contention, permission, and unknown errors propagate, never become success. Snapshot persistence is independent from CURRENT so late history survives. CURRENT advances only by A1 ordering; conditional loss plus strong exact read converges on retained/current. Use bounded GetItem/TransactWrite/PutItem and no Scan.

**Block If:** The gateway cannot expose cancellation reasons or consistent exact reads without a small backwards-compatible extension.

**Never:** Add providers/fixtures, DATA002 writes, workers/seed/Lambda/CDK, API/UI/auth, external calls, pagination, quotas, retry loops, recovery state, schedules, or a condition-ignorant fake. A preliminary binding read is never transaction protection.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| First/replay | Bound absent or identical snapshot | Created once; identical race converges | Conditional loss + exact read |
| Collision | Same key, different content | Unchanged | Typed corruption |
| Binding race | Mapping/canonical changes pre-transaction | No snapshot | Typed binding conflict |
| Older arrival | Older distinct after newer CURRENT | Snapshot stored; CURRENT retained | Success |
| Current race | Competing winners | A1 deterministic winner remains | Exact read resolves conditional loss |
| Nonconditional cancel | Throttle/contention/validation/unknown | No false success | Propagate storage error |

</intent-contract>

## Code Map

- `packages/database/src/fixture-odds-adapter.ts` -- gateway contract, exact keys/conditions, snapshot and CURRENT operations.
- `packages/database/src/fixture-odds-adapter.test.ts` -- condition-aware harness and race/cancellation cases.
- `packages/database/src/index.ts` -- exports only.

## Tasks & Acceptance

**Execution:**
- [x] `packages/database/src/fixture-odds-adapter.ts` -- implement protected immutable insertion/replay/corruption and independent monotonic CURRENT using A1.
- [x] `packages/database/src/fixture-odds-adapter.test.ts` -- cover exact request shapes, mapping/canonical races, replay visibility, late history, current races, collision, and cancellation categories with real condition evaluation.
- [x] `packages/database/src/index.ts` -- export without changing unrelated behavior.

**Acceptance Criteria:**
- Given mapping/canonical changes during ingest, when transaction executes, then no snapshot stores and failure is never replay.
- Given concurrent identical ingest, when one create loses after winner commit, then exact reread returns existing; contention remains error.
- Given newer then older observations, when persisted, then both snapshots exist and CURRENT is A1's winner.
- Given workspace gates, then no Scan or seed/deployment/API/UI behavior enters this slice.

## Spec Change Log

## Review Triage Log

- 2026-08-01 implementation review: intent_gap 0; bad_spec 0; patch 8 (high 2, medium 6); defer 0; reject 0. Applied all localized patches: added the concrete AWS DocumentClient gateway and direct command/error tests; CURRENT recovery now validates its immutable target; exact rows are descriptor-safe and shape-exact; semantic snapshot equality ignores object property order; recovery read failures are storage errors; binding failures take precedence over simultaneous snapshot loss; and cancellation vectors require the exact operation count before positional classification.
- 2026-08-01 final confirmation: intent_gap 0; bad_spec 0; cumulative patch 9 (high 2, medium 7); defer 0; reject 0. Tightened cancellation classification so only a literal `None` is a nonfailure; missing, empty, and unknown codes propagate as storage failures even in an exact-length reason vector.

## Design Notes

Protected immutable snapshot creation and conditional CURRENT advancement are separate exact operations. A failure between them is safely resumed by replaying the content-addressed observation.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test` -- races/cancellation classification pass.
- `pnpm check` -- workspace gates pass.
- `rg -n '\bScan\b' packages/database/src/fixture-odds-adapter.ts` -- no matches.

## Auto Run Result

Implemented a bounded Dynamo fixture-odds port and adapter. Snapshot creation uses one request containing exact DATA002 mapping and canonical-event condition checks plus an absent-only immutable insert. Conditional create loss is classified from per-operation cancellation reasons and resolved only through a strongly consistent exact read; malformed, conflicting, absent, mixed, throttled, validation, permission, contention, and unknown outcomes cannot become success. CURRENT is an independent monotonic write and conditional losses resolve through an exact reread and A1's transition ordering.

Verification: database tests pass 79/79, including concrete AWS command shapes and cancellation translation, exact request shapes, condition-evaluated binding and CURRENT races, identical replay, collision, late history, equal-time ordering, malformed/reordered rows, orphan CURRENT, failed recovery reads, combined/truncated/missing-code reasons, and cancellation categories; database typecheck/lint pass; fresh `pnpm check` passes repository format, lint, boundaries, 15/15 package typechecks, tooling typecheck, 22/22 test tasks, and 15/15 builds; the no-Scan check and `git diff --check` pass. No provider, fixture source, DATA002 write, seed, worker, CDK, API, UI, auth, external call, retry, pagination, quota, recovery, schedule, or commit was added.
