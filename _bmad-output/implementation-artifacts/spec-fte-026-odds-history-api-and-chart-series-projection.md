---
title: 'Odds History API and Chart-Series Projection'
type: 'feature'
created: '2026-08-06'
status: 'in-review'
baseline_commit: 'a912633841319793365103b62af5dc96365d841c'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-025-event-detail-odds-comparison.md'
warnings:
  - 'This story file reconstructs an already-started story from the planning artifacts and commit 8b9d39f.'
---

<intent-contract>

## Intent

**Problem:** Current odds are useful only for the instant they are viewed. The product cannot support line-movement decisions unless every retained SharpAPI observation can be retrieved as trustworthy, book-specific, chart-ready history without merging books, splitting one game when harmless event metadata changes, or inventing prices through missing and blocked evidence.

**Approach:** Complete the immutable event-history mirror and bounded cursor API; project exact market, selection, and sportsbook series with deterministic ordering and calculations; expose honest opening/current/state semantics; and make the browser consume all retained pages without duplicate or reordered observations.

## Boundaries & Constraints

**Always:** Use SharpAPI as the sole production provider; preserve immutable snapshots without TTL or destructive compaction; keep each sportsbook as an independent series; preserve point, American odds, implied probability, provider time, and collection time; continue history across canonical event versions; use stable tie ordering and scoped cursors; represent blocked evidence as a gap rather than a price; keep public read routes public; validate strict bounded inputs and output shapes; test locally before any deployment.

**Block If:** A row cannot be tied to the exact canonical event; history ordering or cursor scope is ambiguous; a state or opening marker would require fabricated evidence; an update would mutate or delete immutable snapshots; a provider other than SharpAPI would be reintroduced.

**Never:** Merge sportsbook series into consensus; synthesize missing observations; connect chart segments across suspended/unavailable evidence; claim a causal sharp/public signal from movement alone; expose provider secrets or raw payloads; deploy merely to discover whether the implementation works.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Multi-book history | Same selection observed at several sportsbooks | Separate chronological series with stable book identity | Never average or merge |
| Event metadata revision | Canonical version advances for the same event | One continuous logical history | Cursor remains valid for the same event/range/scope |
| Exact retry | Same immutable snapshot is replayed | One observation identity | Conflicting identity fails as corruption |
| Tied provider time | Observations share `observedAt` | Stable retrieval/snapshot tie order | Reject decreasing or duplicate traversal |
| Spread/total | Observation carries line point and price | Return both point and American/implied price | Reject malformed market-specific points |
| Missing opening | Requested book has no retained observation | Explicit unavailable opening state or absent requested series metadata | Never create a price |
| Suspended evidence | Provider marks an observation suspended | Retain audit evidence and expose a chart gap | Never treat as active/current |
| Pagination | More than one page exists | Stable continuation with no skip/repeat and fixed as-of fence | Reject malformed, replayed, or wrong-scope cursors |
| Display collapse | Consecutive observations have identical value/state | May collapse for display while retaining first/last times | Raw immutable evidence remains unchanged |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- shared odds-history DTO, point state, markers, and deterministic implied-probability contract.
- `packages/database/src/exact-odds-snapshot-repository.ts` -- immutable event-history mirror written beside exact snapshot identity.
- `packages/database/src/fixture-odds-adapter.ts` -- publication ordering that makes history mirror retries safe.
- `packages/database/src/odds-history-repository.ts` -- event/market/selection/book projection, ordering, markers, filtering, and cursor paging.
- `packages/database/src/dynamodb-odds-history-repository.ts` -- bounded strongly consistent DynamoDB query.
- `apps/api/src/handler.ts` -- strict public `/games/{eventId}/odds-history` request boundary and safe telemetry.
- `apps/web/src/api.ts` -- strict response validation and full-page merge without cache mutation.
- `apps/web/src/App.tsx` -- FTE-026 consumer; rendering itself is completed by FTE-026A.
- Focused tests beside each file plus `tests/e2e/games.spec.ts`.

## Tasks & Acceptance

**Execution:**
- [x] Define one exact shared odds-history envelope containing state, American odds, deterministic implied probability, point when applicable, provider/collection timestamps, and opening/current markers.
- [x] Complete immutable event-history mirroring and prove exact retries, conflicts, and event-version changes cannot lose or duplicate observations.
- [x] Add strict market, selection, and all-book/selected-book filters with scope-bound stable cursor pagination.
- [x] Project separately ordered sportsbook series, explicit missing/opening semantics, suspended gaps, and optional display-only collapse metadata without altering raw snapshots.
- [x] Validate the API envelope, safe public errors, and bounded non-sensitive history telemetry.
- [x] Exhaust and merge pages in the browser without duplicates, skips, label regression, or silent reordering.
- [x] Add repository, DynamoDB, API, browser-client, and integration regressions for every matrix row.
- [x] Run focused tests, full `pnpm check`, Phase 1 preflight, adversarial review, and local browser verification before marking done.

**Acceptance Criteria:**
- Given retained observations from multiple SharpAPI books, the endpoint returns one separately identified chronological series per requested book and never merges book evidence.
- Given harmless canonical event-version changes or exact provider retries, history remains continuous and contains no duplicate chart points.
- Given spread/total and moneyline observations, every active point exposes the exact line where applicable, American odds, deterministic implied probability, provider time, collection time, stable identity, and opening/current status.
- Given suspended or unavailable evidence, history preserves the evidence but exposes a visible gap state and never invents an actionable price.
- Given tied timestamps and multi-page results, repeated traversal is deterministic, scoped, and contains no duplicate or skipped immutable observation.
- Given strict market, selection, and book filters, unsupported or malformed scopes fail safely before storage reads and valid scopes return only matching series.
- Given a missing requested book or opening observation, the response states that absence honestly rather than omitting context or fabricating data.
- Given any provider/storage/API failure, the public response remains bounded and generic while logs and metrics contain counts, not event IDs, prices, secrets, or raw payloads.

## Design Notes

The current implementation at commit `8b9d39f` established the event-history mirror, cross-version grouping, cursor fencing, and a strict browser parser. This story closes the remaining contract gaps; FTE-026A owns the final interactive chart, filters, accessible table, and responsive presentation. Public read access is intentional because authentication was removed from the MVP by product decision.

## Technical References

- [Architecture: immutable odds evidence and event-scoped reads](/Users/kevishie/Projects/find-the-edge/_bmad-output/planning-artifacts/architecture.md)
- [Epic 4 FTE-026 acceptance and tests](/Users/kevishie/Projects/find-the-edge/_bmad-output/planning-artifacts/epics-and-stories.md)
- [AWS DynamoDB Query pagination](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html)
- [SharpAPI splits reference](https://docs.sharpapi.io/en/api-reference/splits/)

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/api test`
- `pnpm --filter @find-the-edge/web test`
- `pnpm exec playwright test --config playwright.config.ts tests/e2e/games.spec.ts`
- `pnpm check`
- `pnpm phase1:preflight`
- local fixture API plus desktop/tablet/mobile browser smoke

## Dev Agent Record

### Implementation Plan

Close the shared contract and storage/API correctness first, then hand the exact DTO to FTE-026A without teaching React to infer provenance or availability.

### Debug Log References

- Existing implementation commit: `8b9d39fb1cf6dc8652edc7f69dfd6162dc1d0811`.

### Completion Notes

- Added a strict shared chart-ready history DTO and bounded, scope-bound cursor API over immutable SharpAPI evidence.
- Preserved independent sportsbook series across event-version changes, deduplicated mirrored evidence, and ordered tied provider timestamps deterministically.
- Enforced SharpAPI provenance, exact market-specific points, active-only opening/current markers, approved-book scopes, encoded canonical selections, and safe generic failures.
- Added strict browser pagination/identity validation and exercised the production handler through desktop/mobile Playwright fixtures.
- Verification passed: repository-wide `pnpm check`, 12/12 focused Playwright tests, and credential-free Phase 1 preflight.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
- `packages/domain/src/odds-history.ts`
- `packages/domain/src/odds-history.test.ts`
- `packages/domain/src/index.ts`
- `packages/database/src/odds-history-repository.ts`
- `packages/database/src/odds-history-repository.test.ts`
- `packages/database/src/dynamodb-odds-history-repository.ts`
- `packages/database/src/dynamodb-odds-history-repository.test.ts`
- `apps/api/src/handler.ts`
- `apps/api/src/handler.test.ts`
- `apps/api/src/lambda.ts`
- `apps/api/package.json`
- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`
- `tests/e2e/local-games-api.ts`
- `tests/e2e/games.spec.ts`
- `pnpm-lock.yaml`

## Change Log

- 2026-08-06: Reconstructed the missing in-progress story file from the approved Epic 4 plan and audited the existing implementation against its acceptance criteria.
- 2026-08-06: Completed, adversarially reviewed, and locally verified the immutable SharpAPI odds-history contract and chart-series projection.

## Review Triage Log

### 2026-08-07 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 4, medium 0, low 0)
- defer: 9: (high 3, medium 5, low 1)
- reject: 2: (high 1, medium 1, low 0)
- addressed_findings:
  - `[high]` `[patch]` Canonicalize unordered DynamoDB provenance maps before immutable snapshot equality checks.
  - `[high]` `[patch]` Validate exact snapshot-index values and compare their content-derived immutable identity on retries and reads.
  - `[high]` `[patch]` Keep every non-active provenance state non-actionable when projecting closing candidates.
  - `[high]` `[patch]` Require own-property membership before projecting an unfiltered sportsbook history series.
