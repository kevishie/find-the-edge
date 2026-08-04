---
title: 'Refresh live splits after ingestion'
type: 'bugfix'
created: '2026-08-03'
status: 'done'
baseline_commit: 'be25eab'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The splits page can remain on an empty response even after the production API has ingested real split observations, forcing the user to manually reload before the board becomes useful.

**Approach:** Refresh the selected splits board periodically in the background, preserve the current board while refreshing, and replace it atomically with the newest valid API response.

## Boundaries & Constraints

**Always:** Keep sport, day, and sportsbook selection stable; cancel refresh work when the view or filter changes; retain the last valid board during transient failures; continue strict response validation.

**Ask First:** Any provider polling or ingestion cadence change, new paid service, or API contract change.

**Never:** Clear a valid board during background refresh, bypass validation, repeatedly overlap requests, or manufacture split data.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New data arrives | Initial board has zero observations; later response has observations | Board updates without a full-page reload | N/A |
| Refresh fails | A valid board is already visible | Existing board remains visible and a later interval retries | Do not replace it with an error page |
| Filter changes | Background request belongs to the previous sport/day | Old request is cancelled and cannot overwrite the new filter | Ignore aborted result |

</frozen-after-approval>

## Code Map

- `apps/web/src/App.tsx` -- owns splits loading state and the page refresh lifecycle.
- `apps/web/src/App.test.tsx` -- exercises empty, populated, failure, and filtering states.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/App.tsx` -- add non-overlapping background refresh with last-good-state retention.
- [x] `apps/web/src/App.test.tsx` -- cover empty-to-populated refresh and transient refresh failure.

**Acceptance Criteria:**
- Given an initially empty live board, when ingestion makes split observations available, then the page displays them within one refresh interval without a browser reload.
- Given a populated board, when a refresh fails, then the populated board remains usable and the page retries later.
- Given a filter change, when an older request resolves, then it cannot overwrite the selected board.

## Spec Change Log

- Review patch: preserve last-good state across same-board client identity changes by binding validity to the sport/day key; name the refresh cadence. This avoids replacing a valid board with an error during an application-client refresh while still isolating filter changes.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- expected: all web tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: no TypeScript errors.
- `pnpm --filter @find-the-edge/web lint` -- expected: no lint errors.

**Results (2026-08-03):** 58/58 web tests passed; typecheck, lint, and diff validation passed.

## Suggested Review Order

**Refresh lifecycle**

- Non-overlapping polling updates the active board while retaining last-good data.
  [`App.tsx:711`](../../../apps/web/src/App.tsx#L711)

- Cleanup cancels stale requests and intervals when the selected board changes.
  [`App.tsx:713`](../../../apps/web/src/App.tsx#L713)

**Behavioral coverage**

- Empty boards automatically acquire newly ingested observations.
  [`App.test.tsx:418`](../../../apps/web/src/App.test.tsx#L418)

- Transient failures retain usable data and retry successfully.
  [`App.test.tsx:447`](../../../apps/web/src/App.test.tsx#L447)
