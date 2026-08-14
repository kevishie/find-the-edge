---
title: 'Materialize Paginated Boards Safely'
type: 'bugfix'
created: '2026-08-13'
status: 'done'
baseline_commit: '4a5418bcfd99e89ba542439c4df8d48070cab58f'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A board stops materializing whenever its physical event partition exceeds the repository's 50-row page limit, even when duplicate/version rows collapse to a small valid logical board. The stored board then ages out and every request falls back to the slower live projection.

**Approach:** Exhaust a bounded, snapshot-consistent cursor chain inside the worker, apply duplicate and withdrawn-listing rules across the complete logical board, and store a terminal cursor-free response only when the resulting board still fits the public 50-item and body-size contracts.

## Boundaries & Constraints

**Always:** Preserve the existing public page contract, signed-cursor boundary, snapshot consistency, chronological ordering, global near-duplicate collapse, board-wide withdrawal evidence, split attachment, freshness semantics, telemetry, and per-board failure isolation. Bound internal pagination and reject cursor cycles or drift.

**Ask First:** None; the user explicitly authorized the recommended production fix and approval-gated execution loop.

**Never:** Persist a worker-signed cursor, hide genuine games by truncating or nulling a public cursor, raise the repository limit as the only fix, concatenate pages without deduplication, call a provider from the read path, or let one malformed board abort other materializations.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Collapsible pagination | Multiple physical pages collapse/filter to at most 50 games | Store one terminal board containing all logical games | None |
| Genuine large slate | More than 50 logical games after normalization | Do not store a misleading partial board | Record `needs-cursor` skip |
| Invalid cursor chain | Cursor repeats, exceeds the page bound, or changes snapshot/projection state | Skip only that board | Record `pagination-invalid` telemetry |
| Cross-page evidence | Duplicate siblings or withdrawal witnesses occur on different pages | Apply rules over the complete board | Fail open only where existing schedule/witness rules already do |

</frozen-after-approval>

## Code Map

- `packages/database/src/board-projection.ts` -- board target collection, normalization, filtering, size checks, storage, and skip reasons.
- `packages/database/src/board-projection.test.ts` -- materialization, withdrawal, freshness, telemetry, and pagination regressions.
- `packages/database/src/games-repository.ts` -- cursor-aware repository contract and existing near-duplicate normalization behavior.
- `apps/workers/src/live-odds-lambda.ts` -- worker cursor codec boundary and board skip metric publication.

## Tasks & Acceptance

**Execution:**
- [x] `packages/database/src/board-projection.ts` -- add a bounded internal page collector, validate cursor/snapshot/projection continuity, normalize globally, filter once, and synthesize a terminal page -- materialize complete logical boards without exposing worker cursors.
- [x] `packages/database/src/board-projection.test.ts` -- cover collapsible pagination, cross-page duplicate/witness behavior, genuine 51-game boards, cursor cycles/page bounds/snapshot drift, and continued processing of later boards -- lock correctness and failure isolation.
- [x] `apps/workers/src/live-odds-lambda.ts` -- update the cursor-boundary explanation and publish the new skip reason through existing telemetry -- keep operations truthful.

**Acceptance Criteria:**
- Given a multi-page physical partition that becomes at most 50 logical games, when materialization runs, then one cursor-free board containing every retained game is stored.
- Given more than 50 genuine logical games, when materialization runs, then no partial stored board replaces the live paginated response.
- Given a cyclic, overlong, or snapshot-drifting cursor chain, when materialization runs, then that board is skipped with an explicit reason and remaining targets continue.
- Given duplicate or withdrawal evidence split across page boundaries, when normalization runs, then it produces the same result as an equivalent single-page board.

## Spec Change Log

## Design Notes

Cursor traversal is an internal worker implementation detail. The terminal stored envelope is derived only after all physical pages have been collected under one snapshot. Global normalization must precede the 50-item decision because physical version churn—not real slate size—is the production failure being repaired.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test -- board-projection.test.ts` -- expected: all board projection regressions pass.
- `pnpm --filter @find-the-edge/workers test` -- expected: worker metric and integration tests pass.
- `pnpm check` -- expected: full formatting, lint, boundaries, types, tests, build, and browser gates pass.

## Suggested Review Order

**Pagination and materialization boundary**

- Bounded traversal validates envelopes, snapshots, identifiers, and terminal completeness.
  [`board-projection.ts:561`](../../packages/database/src/board-projection.ts#L561)

- Explicit skip reasons preserve per-board isolation and operational truth.
  [`board-projection.ts:50`](../../packages/database/src/board-projection.ts#L50)

- Worker cursors remain internal and never become public response cursors.
  [`live-odds-lambda.ts:624`](../../apps/workers/src/live-odds-lambda.ts#L624)

**Storage safety**

- Stored board validation and persistence enforce the UTF-8 byte contract.
  [`board-projection.ts:349`](../../packages/database/src/board-projection.ts#L349)

- Final serialization and writes fail per-board without blocking later targets.
  [`board-projection.ts:801`](../../packages/database/src/board-projection.ts#L801)

**Regression coverage**

- Physical pagination collapses into one complete logical board.
  [`board-projection.test.ts:237`](../../packages/database/src/board-projection.test.ts#L237)

- Cycles, drift, and page bounds exercise their actual traversal paths.
  [`board-projection.test.ts:383`](../../packages/database/src/board-projection.test.ts#L383)

- Uninitialized terminal pages retain truthful projection telemetry.
  [`board-projection.test.ts:656`](../../packages/database/src/board-projection.test.ts#L656)
