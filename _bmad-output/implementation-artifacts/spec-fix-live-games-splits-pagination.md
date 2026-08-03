---
title: 'Fix Live Games and Splits Pagination'
type: 'bugfix'
created: '2026-08-03T15:05:00-04:00'
status: 'done'
baseline_commit: '27178423ff6b8b9aeed5d436e849c0125a71dc21'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-mvp-001b-games-and-odds-read-api.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-premium-betting-splits-terminal.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The production games and splits APIs legitimately return partial pages with continuation cursors after the DynamoDB scan safety cap, but the web client only accepts single complete pages. It therefore reports valid games as invalid and masks the same splits parsing failure as temporary unavailability.

**Approach:** Teach the public web client to validate and exhaust the existing cursor contract, combining pages into one deterministic complete result before the UI renders.

## Boundaries & Constraints

**Always:** Preserve strict runtime validation on every page; send the original sport, league, status, day, and limit on every request; pass the returned cursor without decoding or rewriting it; preserve API order; require unique canonical IDs; require a stable snapshot across pages; bound page count and cursor size; detect cursor cycles; retain abort behavior and redacted user-facing errors; apply identical behavior to games and splits.

**Ask First:** Changing the backend pagination contract, increasing repository scan limits, displaying partial results, or changing ingestion/canonicalization behavior.

**Never:** Ignore pagination metadata; silently truncate results; accept malformed cursors, duplicate games, mixed snapshots, or incoherent partial/complete states; weaken game, odds, or split field validation; expose raw backend errors.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| One complete page | `complete`, no cursor | Return the validated page unchanged | N/A |
| Multiple pages | Partial page(s), then complete | Follow cursors and return ordered unique combined items | Do not render until complete |
| Cursor cycle | A cursor repeats | Stop immediately | Return redacted invalid-response error |
| Snapshot mismatch | Later page has a different snapshot | Reject the combined result | Return redacted invalid-response error |
| Duplicate ID | Same canonical ID appears twice | Reject ambiguity | Return redacted invalid-response error |
| Excessive pagination | Page bound is exceeded | Stop safely | Return redacted invalid-response error |
| Abort during pagination | Caller aborts after any page | Stop further requests | Preserve abort semantics |

</frozen-after-approval>

## Code Map

- `apps/web/src/api.ts` -- strict response parsers, public games/splits requests, and DTO pagination assumptions.
- `apps/web/src/api.test.ts` -- contract tests for valid and invalid API responses.
- `packages/database/src/dynamodb-event-repository.ts` -- authoritative producer of partial pages and continuation cursors; read-only context.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api.ts` -- represent coherent partial-page metadata, validate each page, and add one bounded cursor-exhaustion path shared by games and splits.
- [x] `apps/web/src/api.ts` -- merge pages in API order, enforce snapshot/cursor/identity invariants, and normalize the returned result to complete metadata.
- [x] `apps/web/src/api.test.ts` -- cover complete and two-page games/splits flows, cursor propagation, cycles, duplicates, snapshot changes, bounds, malformed metadata, and aborts.

**Acceptance Criteria:**
- Given the current production partial response, when `/games` or `/splits` loads, then the client follows the cursor chain and renders the complete valid result without either reported error.
- Given any malformed or incoherent page chain, when loading, then the client fails closed with the existing redacted message and never renders a partial mixed result.
- Given a complete single-page response, when loading, then behavior remains backward compatible and only one request is made.

## Spec Change Log

## Design Notes

Keep page parsing separate from chain aggregation: each page must be independently valid before its items participate in the result. A partial page requires a non-empty bounded cursor and `hasMoreUnknown: true`; a complete page requires no cursor and `hasMoreUnknown: false`.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- all web contract and component tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- TypeScript passes.
- `pnpm check` -- repository quality gate passes.
- `pnpm exec playwright test --config playwright.config.ts` -- browser smoke passes.

**Manual checks (if no CLI):**
- Load the deployed games and splits routes for a day that produces multiple API pages; both complete without truncation or invalid-response messages.

## Suggested Review Order

**Pagination contract and aggregation**

- Start with the bounded cursor-exhaustion loop and cross-page integrity checks.
  [`api.ts:497`](../../../apps/web/src/api.ts#L497)

- Review coherent complete, partial, cursor-bearing, and terminal page validation.
  [`api.ts:316`](../../../apps/web/src/api.ts#L316)

**Split evidence validation**

- Inspect exact optional fields and canonical binding for every split observation.
  [`api.ts:370`](../../../apps/web/src/api.ts#L370)

**Regression coverage**

- Verify games and splits pagination, cursor forwarding, samples, cycles, and aborts.
  [`api.test.ts:227`](../../../apps/web/src/api.test.ts#L227)
