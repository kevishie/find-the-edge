---
title: 'SharpAPI Schedule Row Conflict Isolation'
type: 'bugfix'
created: '2026-08-04'
status: 'done'
baseline_commit: '98ced02'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/spec-fte-024-provider-quota-retry-dlq-and-suspended-partial-states.md'
  - '_bmad-output/implementation-artifacts/spec-sharpapi-mlb-participant-boundary.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** All five live SharpAPI schedules fetch successfully but finish as generic `schedule-provider-error`. Post-fetch reconciliation is fail-fast, so one deterministic stored-event conflict aborts every valid sibling and hides the bounded cause.

**Approach:** Isolate only explicitly allowlisted event-scoped data conflicts at the per-row reconciliation boundary. Persist immutable quarantine evidence and continue valid siblings, while systemic storage, ownership, locking, page, continuation, checkpoint, and unknown failures still fail the league loudly.

## Boundaries & Constraints

**Always:** Classify from a closed internal reason-code set; quarantine only deterministic conflicts attributable to one provider event; persist one idempotent hashed gap/audit record per conflicting event; emit bounded league/provider/reason metrics; retain valid siblings; require at least one accepted future event before a conflicted run can be healthy; preserve sealed-page replay, paid-call ownership, and checkpoint consistency; keep summaries free of raw event/team/error/provider payload data.

**Ask First:** Automatically repairing or deleting conflicting canonical history, widening identity matching, or changing provider precedence.

**Never:** Catch all reconciliation exceptions; quarantine lock timeout, ownership loss, raw Dynamo/transaction failures, invalid provider pages, continuation/page/checkpoint transitions, or unknown errors; mark an all-quarantined schedule healthy; retry paid Sharp calls to resolve deterministic stored-data conflicts; introduce provider fallback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Mixed page | Valid, allowlisted conflict, valid | Both valid rows bind; conflict gets one durable gap and metric | Run completes degraded/partial |
| Replay | Same sealed page and conflict | Same evidence wins idempotently; no duplicate canonical mapping | No second paid request |
| All conflict | No accepted future row | Do not mark schedule healthy or ready | Bounded `schedule-stored-event-conflict` |
| Systemic failure | Lock, ownership, transaction, checkpoint, page commit, unknown | Abort league | Existing safe failure classification |

</frozen-after-approval>

## Code Map

- `apps/workers/src/production-odds-control-plane.ts` -- schedule page loop, per-event reconciliation, checkpoints, health, metrics.
- `apps/workers/src/schedule-reconciliation.ts` -- exact event binding and reconciliation result contract.
- `apps/workers/src/sharp-api-ingestion.ts` -- secondary Sharp schedule composition consuming the typed reconciliation contract.
- `packages/database/src/odds-control-plane.ts` -- immutable evidence gaps and replay state.
- `apps/workers/src/production-odds-control-plane.test.ts` -- production orchestration and failure-boundary tests.

## Tasks & Acceptance

**Execution:**
- [x] Add a closed event-conflict classifier covering only proven deterministic stored-event reason codes.
- [x] Wrap each schedule event binding, persist an idempotent exact-category quarantine gap with hashed identity, emit bounded metrics, and continue siblings.
- [x] Track accepted/quarantined counts across pages; keep all-conflicted runs unhealthy and prevent false readiness/checkpoints.
- [x] Preserve safe public reason codes and add structured redacted diagnostics without raw provider/event/team/error text.
- [x] Add mixed, replay, all-conflicted, every allowlisted conflict, and systemic-failure tests; prove no duplicate paid calls or mappings.

**Acceptance Criteria:**
- Given a mixed Sharp schedule page, when one event hits an allowlisted stored-data conflict, then valid siblings bind and checkpoint while exactly one durable quarantine record explains the excluded event.
- Given the same page replays, when evidence already exists, then mapping, gaps, metrics, and provider calls remain idempotent.
- Given every row conflicts, when the run finishes, then the league is unavailable with a bounded stored-event-conflict reason and cannot feed odds readiness.
- Given any systemic or unknown error, when reconciliation runs, then the league fails without converting it into row quarantine.

## Spec Change Log

- 2026-08-04: Implemented deterministic per-event schedule conflict isolation and moved the bugfix to review.

## Review Triage Log

- 2026-08-04 adversarial review: 9 findings patched, 0 waived. Replaced message matching with boundary-only typed conflicts; made refreshed membership replace prior checkpoints; added explicit degraded health; persisted bounded exact per-run conflict reasons; introduced an ownership-checked, sealed, committed conflict-evidence page before gap materialization; separated conflict metric delivery onto that page's durable marker with documented at-least-once semantics; intentionally clear all-conflict continuations while preserving committed failed-run evidence; expanded replay and prior-checkpoint assertions; removed the unperformed hosted-smoke implication.
- 2026-08-04 follow-up review: 6 findings patched, 0 waived. Added durable checkpoint invalidation for contradictory all-conflict evidence and protected the current run from fallback if that write itself fails; made stored per-row dispositions authoritative before replay reconciliation; moved deterministic provenance to typed Memory/Dynamo store failures; left metric delivery pending without a sink; safely paired legacy checkpoint arrays; and derived replay metrics exclusively from committed conflict gaps. Added repaired/different-category crash replay, sink rollout, old-checkpoint invalidation, and legacy rollout regressions.
- 2026-08-04 final review: 2 findings patched, 0 waived. A committed conflict page with undelivered metrics now fails with a bounded transient reason, retains its continuation, writes no terminal checkpoint, suppresses stored fallback, and replays to completion once a sink is configured. Added real Memory and Dynamo identity-claim conflict provenance tests, a single-row typed identity quarantine test, and plain-message/systemic failure rejection coverage.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm check`
- `pnpm phase1:preflight`
- hosted Phase 1 deployment smoke with real SharpAPI schedules and odds

## Dev Agent Record

### Completion Notes

- Added a boundary-only typed seven-code schedule-event conflict contract. An arbitrary error with the same text is rejected; lock, ownership, transaction, pagination, checkpoint, continuation, non-Error, and unknown failures remain outside the contract and abort the league.
- Added immutable per-run conflict gaps keyed by hashed provider-event occurrence and bounded exact category. Raw provider event IDs, participant labels, payloads, and exception text are absent from gaps and public summaries.
- Added a dedicated conflict-evidence page per source page. Ownership is renewed before sealing, the evidence page is committed before gaps materialize, and its separate durable metric marker provides replay deduplication with honest at-least-once sink semantics.
- Replaced prior checkpoint membership with accepted rows from the current completed refresh, so a formerly scheduled event that now conflicts cannot survive in starts or expected IDs. Mixed runs remain usable but explicitly `degraded`; an all-conflicted run remains unhealthy and cannot run odds or reuse stored readiness. When a conflict metric sink exists, it preserves committed failed-run evidence and writes an unavailable empty checkpoint; when no sink exists, it retains replay ownership and writes no terminal checkpoint until delivery succeeds.
- Proved sealed-page replay after lease expiry reuses the prior paid response, preserves exact checkpoint membership, gap/run lineage, health state, mapping uniqueness, continuation semantics, and the dedicated conflict metric marker. Real reconciliation-boundary tests cover every allowlisted reason and preserve systemic failures unchanged.
- Verification passed after both review passes: domain 70 tests, database 202 tests, workers 165 tests, full `pnpm check`, credential-free `pnpm phase1:preflight`, and `git diff --check`. Hosted smoke remains pending deployment and is not claimed here.

### File List

- `_bmad-output/implementation-artifacts/spec-sharpapi-schedule-row-conflict-isolation.md`
- `apps/workers/src/odds-control-plane.ts`
- `apps/workers/src/schedule-reconciliation.ts`
- `apps/workers/src/schedule-reconciliation.test.ts`
- `apps/workers/src/sharp-api-ingestion.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `packages/database/src/event-ingestion.ts`
- `packages/database/src/memory-event-ingestion.ts`
- `packages/database/src/dynamodb-event-ingestion.ts`
- `packages/database/src/store-contract.test.ts`
- `packages/database/src/odds-control-plane.ts`
- `packages/domain/src/fixture-odds.ts`

## Change Log

- 2026-08-04: Isolated deterministic SharpAPI schedule row conflicts while retaining valid siblings, durable evidence, replay idempotency, and fail-closed league readiness.
- 2026-08-04: Applied all adversarial findings for typed boundaries, checkpoint replacement, degraded health, per-run exact gaps, committed conflict evidence, independent metric delivery, and explicit all-conflict recovery semantics.
- 2026-08-04: Applied follow-up findings for durable checkpoint invalidation, sealed disposition replay, database-typed conflict provenance, pending metrics without a sink, and legacy checkpoint migration safety.
- 2026-08-04: Closed final review findings for durable pending-metric replay and typed identity-claim conflict quarantine across Memory and Dynamo stores.

## Suggested Review Order

**Typed conflict boundary**

- Database conflicts carry closed provenance instead of matching arbitrary error text.
  [`event-ingestion.ts:206`](../../packages/database/src/event-ingestion.ts#L206)

- Reconciliation converts only typed event-data conflicts into row quarantine.
  [`schedule-reconciliation.ts:50`](../../apps/workers/src/schedule-reconciliation.ts#L50)

**Owned schedule evidence**

- Per-event conflicts become exact, immutable, per-run evidence gaps.
  [`production-odds-control-plane.ts:506`](../../apps/workers/src/production-odds-control-plane.ts#L506)

- Dedicated sealed pages make replay disposition authoritative before reconciliation.
  [`production-odds-control-plane.ts:1203`](../../apps/workers/src/production-odds-control-plane.ts#L1203)

- Missing metric delivery retains ownership instead of orphaning committed evidence.
  [`production-odds-control-plane.ts:1283`](../../apps/workers/src/production-odds-control-plane.ts#L1283)

**Readiness and health**

- Mixed schedules expose degraded health while valid siblings remain usable.
  [`production-odds-control-plane.ts:1389`](../../apps/workers/src/production-odds-control-plane.ts#L1389)

- Memory and Dynamo stores prove the same typed conflict contract.
  [`store-contract.test.ts:1`](../../packages/database/src/store-contract.test.ts#L1)
