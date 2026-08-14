---
id: SPEC-fte-076-collapse-per-run-control-plane-bookkeeping
status: in-progress
review_loop_iteration: 2
baseline_commit: 129b3a3d1901605532c9fcb7598e20ff2ff9c3bd
companions:
  - implementation-contract.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only.

# FTE-076: Collapse Per-Run Control-Plane Bookkeeping

## Why

The ingestion control plane rewrites one RUN item from page-ledger transitions, making bookkeeping grow with pagination even though PAGE records already hold the exactly-once evidence fence. Operators need constant-cost run auditing without weakening replay, ownership, quota, or incident evidence.

## Capabilities

- **CAP-1**
  - **intent:** A control-plane pass uses a constant number of RUN-partition accesses regardless of page count.
  - **success:** A 100-page fresh success performs exactly two RUN accesses, a resumed success performs at most three, and an ownership loser or early skip performs zero.
- **CAP-2**
  - **intent:** The system preserves exactly-once evidence commitment while PAGE transitions stop rewriting RUN.
  - **success:** Existing commit-interruption, fallback-fencing, crash, and replay tests pass, and 100 repeated evidence-intent and evidence-commit transitions touch no RUN key.
- **CAP-3**
  - **intent:** Schedule source and conflict evidence can reach one atomic committed boundary without two evidence transactions per source page.
  - **success:** Two newly sealed schedule pages commit in one page-only transaction; replay commits only missing markers and makes no second paid request.
- **CAP-4**
  - **intent:** Only a continuation owner may inspect or mutate the active run audit state.
  - **success:** A worker that loses or observes a live continuation lease returns without a RUN read, RUN write, or PAGE-ledger scan.
- **CAP-5**
  - **intent:** Incident-relevant outcomes from never-read skip rows remain queryable without minting a RUN item every tick.
  - **success:** Dependency, cadence, and quota outcomes emit bounded audit telemetry containing status, reason, league, provider, policy version, and time while creating no skip RUN row.

## Constraints

- A valid, recorded FTE-075 baseline is a hard prerequisite for deploying this optimization, marking FTE-076 done, or publishing any savings claim. Local implementation and verification may proceed before that gate; optimization deployment may not.
- PAGE `evidenceIntentAt` remains the pre-commit crash fence. PAGE `committedAt` remains the durable exactly-once commit marker, and evidence-bearing commits also persist `evidenceCommittedAt` so an empty committed payload remains distinguishable from an ordinary no-evidence page during recovery.
- Retain continuation ownership, lease, run-lineage, paid-attempt reservation, quota reserve/reconciliation, immutable sealed-page, gap-idempotency, and terminal run-outcome semantics.
- RUN transitions retain optimistic version fencing. An unconditional update is forbidden.
- Existing RUN rows remain readable; no migration, backfill, rewrite, or deletion is permitted.
- FTE-075 capacity attribution remains the measurement mechanism and must not be changed or treated as a completed baseline by this story.
- Treat implementation as high-risk idempotency work: an adversarial review of access counting, crash replay, and acceptance preservation is required before merge.

## Non-goals

- Changing provider request cadence, page limits, quota policy, evidence payloads, canonical odds persistence, read consistency, or polling architecture.
- Claiming a dollar or percentage reduction before FTE-078 repeats the valid FTE-075 method on a settled post-change window.
- Removing the distinct evidence-intent write required before external odds persistence.

## Success signal

The 100-page counting harness proves RUN traffic is constant while all existing crash/replay and quota-fence regressions remain green. After the FTE-075 gate is satisfied, deployment telemetry shows the expected `ODDS_CONTROL#RUN` operation-count movement without any unsupported savings statement.

## Review findings

- [x] Persist an explicit PAGE evidence marker for an evidence-bearing empty commit and recover the RUN latch from either intent or committed evidence.
- [x] Compare a versionless legacy RUN's complete stored value instead of sending an undefined version expression.
- [x] Reclaim continuations whose legacy lease timestamps are malformed rather than treating them as permanently live.
- [x] Assert the RUN compare-and-swap even when the requested material equals the caller's prior snapshot.
- [x] Prevent a changed or deleted versionless RUN from being overwritten or recreated by its stale caller.
- [x] Omit the unused version placeholder from a versionless DynamoDB condition expression.
- [x] Prove the 100-page budget with 100 evidence-bearing external commits and assert the schedule source/conflict pair uses one compound call.
