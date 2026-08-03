---
title: 'Complete filterable betting splits board'
type: 'feature'
created: '2026-08-03'
status: 'done'
review_loop_iteration: 0
baseline_commit: '246ef6a2a65dc709bf27426b69914b5874d8d88a'
context:
  - 'docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The splits page hides scheduled games that lack split observations, repeats games for each returned scope, and exposes sportsbook scope as plain text. This makes sparse SharpAPI coverage look like a broken schedule and makes sportsbook filtering harder than it needs to be.

**Approach:** Show every scheduled game from the splits API exactly once, render missing values as `—`, and add an accessible logo-based sportsbook selector. Treat SharpAPI's returned scopes as the source of truth: expose every scope received, identify its documented `consensus` scope as DraftKings plus Circa, and do not claim that all account-selected odds books provide betting splits.

## Boundaries & Constraints

**Always:** Default to an “All books” board; present available sportsbook scopes in deterministic order; label `consensus` as the documented DraftKings-plus-Circa aggregate rather than a standalone sportsbook; use local, provenance-documented logo assets with readable accessible names and a resilient text/initial fallback; preserve provider timestamps and freshness warnings; show a per-game “No split data” state without hiding the matchup; keep one game-detail link per matchup.

**Ask First:** Adding externally hosted logo dependencies, changing the paid SharpAPI plan, deleting/rebuilding production canonical-event data, or representing an aggregate as “consensus” when the provider did not identify it that way.

**Never:** Fabricate split percentages, merge scopes mathematically, infer missing splits from odds, deduplicate canonical events in the browser by team-name strings, expose the SharpAPI key, or promise split coverage for a sportsbook absent from the provider response.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed coverage | Eight scheduled games; one has BetMGM splits | Eight matchups render once; seven show `—`; summary reports one covered game | No global empty-state message |
| Scope selection | Multiple returned sportsbook scopes | Logo controls filter the board to one scope without duplicating matchups | Unknown scope gets accessible fallback control |
| No splits | Scheduled games with zero observations | All games remain visible with `—` and “No split data” | Freshness is shown as unavailable, not current |
| Provider failure | Splits request fails | Existing temporary-unavailable state renders | No stale values are presented as newly loaded |

</frozen-after-approval>

## Code Map

- `apps/web/src/App.tsx` -- splits state derivation, scope selection, board rendering, summaries, and empty states.
- `apps/web/src/styles.css` -- compact logo selector, responsive states, and no-data presentation.
- `apps/web/src/sportsbooks.tsx` -- normalized sportsbook metadata and accessible logo/fallback component.
- `apps/web/public/sportsbooks/` -- vetted local sportsbook logo assets and provenance note.
- `apps/web/src/App.test.tsx` -- page-level behavior and accessibility coverage.
- `packages/providers/src/sharp-api.ts` -- verifies every provider-returned sportsbook split scope is preserved.
- `packages/providers/src/sharp-api.test.ts` -- multi-sportsbook parsing contract.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/sportsbooks.tsx`, `apps/web/public/sportsbooks/` -- add a normalized logo registry for common SharpAPI sportsbook IDs with accessible fallback and documented asset sources.
- [x] `apps/web/src/App.tsx` -- derive scope choices from returned observations, add All/single-book selection, render every API game once, and present selected-scope coverage accurately.
- [x] `apps/web/src/styles.css` -- style compact logo controls, selected/focus states, and sparse-data rows consistently with the Find the Edge brand.
- [x] `apps/web/src/App.test.tsx` -- cover mixed/no coverage, book switching, one-row-group-per-game, deterministic scope order, and unknown-logo fallback.
- [x] `packages/providers/src/sharp-api.test.ts` -- prove multiple sportsbook split rows survive parsing unchanged.

**Acceptance Criteria:**
- Given a day containing scheduled games with sparse splits, when the page loads, then every API game appears once and every missing line/handle/bets value displays `—`.
- Given SharpAPI returns multiple sportsbook scopes, when a user chooses a sportsbook logo, then the same complete schedule remains visible and only that scope's observations populate cells.
- Given an unknown sportsbook ID, when its filter renders, then it remains keyboard operable and identifiable by accessible name without a broken image.
- Given only BetMGM is returned, when the page loads, then BetMGM is the only individual-book choice and the UI does not imply DraftKings or FanDuel split coverage.

## Spec Change Log

- 2026-08-03: Human clarified SharpAPI's documented split sources are DraftKings and Circa. Updated the approved intent and UI naming so `consensus` is presented as their aggregate, not a standalone sportsbook or all-books consensus.

## Design Notes

“All books” means show the complete schedule and use an explicitly deterministic available observation per game; it is not a calculated consensus. The selected scope is displayed near the board summary. Scope buttons use logos as the primary visual cue but retain `aria-label` and `title` text. Upstream removal of existing duplicate/pseudo canonical games is deferred because safe identity reconciliation and production cleanup require a separate data-integrity story.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- all splits UI and accessibility tests pass.
- `pnpm --filter @find-the-edge/providers test` -- SharpAPI multi-scope parsing remains intact.
- `pnpm check` -- repository-wide format, lint, boundaries, typecheck, tests, and build pass.

**Manual checks (if no CLI):**
- Verify the deployed `/splits` page shows the full returned schedule, logo filters are recognizable and keyboard accessible, missing observations show `—`, and no duplicated matchup groups are introduced by scope selection.

## Suggested Review Order

**Schedule and scope behavior**

- Complete schedules stay visible while selected-scope observations populate available cells.
  [`App.tsx:746`](../../apps/web/src/App.tsx#L746)

- Logo controls expose only provider-returned scopes and preserve keyboard accessibility.
  [`App.tsx:915`](../../apps/web/src/App.tsx#L915)

- Soccer outcomes remain structurally complete even when draw observations are missing.
  [`App.tsx:1019`](../../apps/web/src/App.tsx#L1019)

**Sportsbook identity**

- Exact scope normalization prevents duplicate controls without inventing provider coverage.
  [`sportsbooks.tsx:4`](../../apps/web/src/sportsbooks.tsx#L4)

- Local logos degrade to recognizable initials when an asset fails.
  [`sportsbooks.tsx:32`](../../apps/web/src/sportsbooks.tsx#L32)

- Runbook distinguishes DK-plus-Circa splits from fifteen-book odds coverage.
  [`sharpapi.md:16`](../../docs/runbooks/sharpapi.md#L16)

**Verification**

- UI tests cover eight-game sparsity, filtering, freshness, and failed logos.
  [`App.test.tsx:711`](../../apps/web/src/App.test.tsx#L711)

- Provider parsing proves distinct returned sportsbook scopes survive unchanged.
  [`sharp-api.test.ts:119`](../../packages/providers/src/sharp-api.test.ts#L119)
