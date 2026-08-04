---
title: 'Event Detail Odds Comparison'
type: 'feature'
created: '2026-08-04'
status: 'in-review'
baseline_revision: '809bb76'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-024-provider-quota-retry-dlq-and-suspended-partial-states.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The public game-detail route is not an authoritative odds comparison: it borrows a single book from the list-page cache, fails on direct links, discards comparison books, and cannot show the availability evidence that makes a price safe or unsafe to use.

**Approach:** Add a detail-specific read contract backed by canonical event data plus every configured SharpAPI sportsbook projection, preserve explicit availability/freshness states, and render an accessible market-by-book comparison that emphasizes Hard Rock and fails closed when its applicable price is missing or ineligible.

## Boundaries & Constraints

**Always:** Use SharpAPI as the sole production provider while treating its sportsbook rows as independent books; load detail directly by canonical event ID; retain all configured books; validate event/version/market/selection bindings; apply latest exact-selection and group availability evidence; distinguish active, stale, suspended, partial, and unavailable; show timestamps and text labels; order and visually emphasize Hard Rock; make target-book eligibility explicit; keep the route public; preserve list-page density and immutable snapshots.

**Block If:** A provider row cannot be tied exactly to the canonical event/version and selection; a missing availability record would need to be guessed active; target sportsbook identity is unavailable; implementing comparison would require changing immutable history or inventing provider evidence.

**Never:** Restore The Odds API fallback; depend on a prior list-page request; fabricate missing books, prices, freshness, or eligibility; treat stale/suspended/partial/unavailable odds as active; infer best price from ineligible cells; expose secrets or raw provider payloads; add authentication back to public reads; implement odds history/charting from FTE-026.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Direct detail | Valid event with current rows from several books | API returns grouped comparisons and UI renders without list cache | No error expected |
| Target absent | Comparison books active but Hard Rock missing | Show comparison evidence, label target unavailable, mark applicable comparison unqualified | Never infer target price |
| Blocking evidence | Newer exact or group suspended/partial/unavailable state | Preserve price as evidence but mark cell ineligible with reason and timestamp | Exclude from best-price and qualification |
| Stale evidence | Active price older than the configured freshness window | Show stale label and age/timestamp | Exclude from active comparison |
| Sparse market | Some configured books or selections absent | Render explicit unavailable cells in stable book/selection order | Do not collapse the market or invent rows |
| Malformed binding | Current or availability row mismatches event/version/key | Fail the detail read safely | Return recoverable server error without internals |
| Deep-link failure | API unavailable or event not found | Show retryable error or not-found state | Retry refetches authoritative detail |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- detail comparison DTO and explicit cell/qualification state contract.
- `packages/database/src/games-repository.ts` -- authoritative event-detail join across configured books, CURRENT rows, and availability evidence.
- `packages/database/src/games-repository.test.ts` -- repository state matrix, target coverage, binding, and direct-read regressions.
- `apps/api/src/handler.ts` -- public detail endpoint routed through the joined games repository.
- `apps/api/src/handler.test.ts` -- public response, not-found, and safe-failure contract.
- `apps/web/src/api.ts` -- strict detail parser with no list-cache graft.
- `packages/ui/src/odds-comparison.ts` -- pure market grouping, ordering, labels, qualification, and eligible-best-price view model.
- `apps/web/src/App.tsx` and `apps/web/src/styles.css` -- accessible market tabs and responsive sportsbook comparison board.
- `apps/web/src/sportsbooks.tsx` -- canonical sportsbook logo presentation.
- `apps/web/src/App.test.tsx` and `tests/e2e/games.spec.ts` -- component state matrix and direct-link browser smoke.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts` and tests -- define an exact detail-only comparison envelope whose cell union cannot represent contradictory state, eligibility, or timestamp combinations.
- [x] `packages/database/src/games-repository.ts` and tests -- add `detail(eventId)` that loads one canonical event plus bounded, deduplicated current/availability keys for every configured book and fails closed on absent or newer blocking evidence.
- [x] `apps/api/src/handler.ts` and tests -- serve joined game detail publicly with safe 404/uninitialized/storage outcomes and no provider internals.
- [x] `apps/web/src/api.ts` and tests -- validate the authoritative detail envelope and remove `knownGames`/list-cache odds grafting.
- [x] `packages/ui/src/odds-comparison.ts` and tests -- derive deterministic market tabs, sportsbook/selection order, target qualification, state labels, and best eligible prices.
- [x] `apps/web/src/App.tsx`, `apps/web/src/styles.css`, and tests -- render keyboard-accessible tabs, recognizable book logos, a strongly marked Hard Rock column, text-plus-visual cell states, timestamps, responsive layout, and recoverable retry UI.
- [x] `tests/e2e/games.spec.ts` and its fixture API -- prove desktop/mobile direct navigation, multi-book comparison, target-missing, and suspended-state behavior.
- [ ] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- move FTE-025 through implementation/review to done only after full and hosted verification.

**Acceptance Criteria:**
- Given a valid canonical event with multiple SharpAPI sportsbook projections, when a user opens its detail URL directly, then all configured books and supported markets appear from the authoritative detail response without prior navigation.
- Given Hard Rock has an eligible applicable price, when comparison renders, then its column is first and visually distinct, target qualification is true, and only eligible prices participate in best-price display.
- Given Hard Rock is missing, stale, suspended, partial, or unavailable for an applicable selection, when comparison renders, then the reason is explicit, target qualification is false, and no target-dependent comparison is presented as actionable.
- Given sparse or blocking comparison-book evidence, when the API and UI process it, then every expected cell has one honest state and missing/ineligible evidence remains visible but excluded.
- Given keyboard, mobile, API-failure, and not-found flows, when exercised by automated tests, then market navigation is operable, essential labels remain readable, and retry/not-found states do not expose internals.

## Spec Change Log

- 2026-08-04: Implemented and locally verified the authoritative event-detail odds comparison; hosted verification remains pending deployment.

## Review Triage Log

### 2026-08-04 — Review pass 1
- intent_gap: 0
- bad_spec: 0
- patch: 11 (high 7, medium 4, low 0)
- defer: 0
- reject: 1 (high 0, medium 1, low 0)
- addressed_findings:
  - `[high]` `[patch]` Required every applicable Hard Rock cell to be eligible and made target identity explicit instead of roster-order dependent.
  - `[high]` `[patch]` Compared availability timestamps by instant and made blocking/missing evidence win over stale classification.
  - `[high]` `[patch]` Ranked spread and total lines by point quality before price.
  - `[high]` `[patch]` Rejected contradictory target qualification and malformed market/selection bindings at the browser boundary.
  - `[medium]` `[patch]` Enforced unique books/markets/selections and exact book-to-cell key equality.
  - `[medium]` `[patch]` Added explicit bounded reason text, typed not-found UI, and complete ARIA tab/panel linkage.

### 2026-08-04 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 4 (high 3, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Rejected future-dated price or availability evidence outside a five-minute skew tolerance.
  - `[high]` `[patch]` Enforced the domain American-odds bounds in the strict web parser.
  - `[high]` `[patch]` Reset route-keyed state immediately so a prior game cannot remain visible during navigation.
  - `[medium]` `[patch]` Displayed blocking evidence time instead of retained price time for unavailable states.

### 2026-08-04 — Review pass 3
- intent_gap: 0
- bad_spec: 0
- patch: 1 (high 0, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` Derived selection labels from canonical participants and market sides so provider labels cannot misidentify a row.

### 2026-08-04 — Review pass 4
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - none
- 2026-08-04 clean follow-up: 4 findings patched, 0 waived. Blocking cells now timestamp the blocking evidence, detail parsing enforces the canonical American-odds bounds, route identity prevents a prior game from rendering during deferred navigation, and repository reads reject future price or availability evidence beyond a five-minute clock-skew tolerance. Added parser, component/pure route-identity, and repository boundary regressions.

## Design Notes

The compact games list remains optimized for scanning and may continue selecting a representative book. The detail envelope is separate because it must preserve the book-by-market matrix and evidence states. Availability is evaluated against both exact-selection and market-group projections; a blocking state wins over an older active price. A sportsbook is a SharpAPI data dimension, not a second provider.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/api test`
- `pnpm --filter @find-the-edge/ui test`
- `pnpm --filter @find-the-edge/web test`
- `pnpm exec playwright test --config playwright.config.ts tests/e2e/games.spec.ts`
- `pnpm check`
- `pnpm phase1:preflight`
- hosted API direct-detail check and hosted desktop/mobile browser smoke

## Dev Agent Record

### Implementation Plan

Keep list-page odds unchanged, add one strict detail envelope, join current prices with exact and market-group availability in bounded strongly consistent reads, and derive all presentation and best-price decisions from explicit eligible cell states.

### Completion Notes

- Added the public, direct-link multi-book detail contract and removed the browser's prior list-cache odds graft.
- Added fail-closed exact/group availability evaluation for active, stale, suspended, partial, and unavailable cells while retaining price evidence for explanation.
- Added deterministic Hard Rock-first comparison presentation, eligible-only best-price marking, keyboard market tabs, sportsbook logos, timestamps, responsive overflow, and retry handling.
- Added repository, parser, view-model, component, and desktop/mobile browser regressions including missing-target and suspended-target behavior.
- Resolved all nine first-pass adversarial findings with regressions for exact target qualification, stale-versus-blocking precedence, malformed comparison matrices, market-aware best price, typed not-found UI, reason text, and ARIA relationships.
- Local verification passed: full `pnpm check`, Phase 1 preflight, 10/10 games Playwright scenarios, and `git diff --check`. Hosted API/UI verification remains for the deployment workflow.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-025-event-detail-odds-comparison.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/api/src/handler.ts`
- `apps/web/src/App.test.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/api.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/styles.css`
- `packages/database/src/games-repository.test.ts`
- `packages/database/src/games-repository.ts`
- `packages/database/src/memory-games-repository.ts`
- `packages/domain/src/index.ts`
- `packages/ui/src/index.ts`
- `packages/ui/src/odds-comparison.test.ts`
- `packages/ui/src/odds-comparison.ts`
- `tests/e2e/games.spec.ts`
- `tests/e2e/local-games-api.ts`

## Change Log

- 2026-08-04: Completed the local FTE-025 implementation and all local quality, build, preflight, and browser gates; retained in-progress status pending hosted verification and adversarial review.
