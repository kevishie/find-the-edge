---
title: 'FTE-018 Events Explorer Screen'
type: 'feature'
created: '2026-08-04'
status: 'in-review'
baseline_revision: 'aff2a15865b8961cc853141a6f5cabaab85fc1ac'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-017-event-status-and-data-freshness-indicators.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The games screen exposes only scheduled events in large betting cards, so users cannot efficiently browse the complete event catalog, combine filters, sort dense results, distinguish no source data from no matches, or see honest readiness states for downstream features.

**Approach:** Turn `/games` into a URL-addressable, lifecycle-aware Events Explorer backed by the existing canonical projections and FTE-017 metadata, with deterministic client aggregation across lifecycle partitions, pure filter/sort primitives, a dense accessible desktop table, responsive cards, and explicit unavailable/disabled states for capabilities that are not built yet.

## Boundaries & Constraints

**Always:** Preserve public credential-free browsing per the user's explicit authentication removal; support MLB and MLS through registered sport metadata; keep date, sport, lifecycle, competition, normalized participant search, sort field, and direction in validated router search state; query one lifecycle partition at a time and aggregate `all` deterministically without pretending the partitions share an atomic snapshot; exhaust bounded pagination; deduplicate canonical IDs or fail safely on contradictory duplicates; apply competition/search locally to the complete loaded day; distinguish projection unavailable, no source events, no filter matches, partial lifecycle coverage, loading, and retryable failure; keep raw lifecycle and FTE-017 freshness independent; render semantic sortable controls and non-color status cues; show Hard Rock, comparison coverage, report, and lineup facts as unavailable until authoritative data exists; render Scout and Watchlist affordances disabled with visible reasons until their APIs exist; retain working detail navigation for every lifecycle without depending on the scheduled splits list.

**Block If:** Correct behavior requires inventing watchlist/scouting/report/lineup state, treating one selected odds board as bookmaker coverage, adding provider secrets to the client, or choosing a new persistence model outside this story.

**Never:** Reintroduce login or protected routes; silently drop failed lifecycle partitions; use browser time to reclassify freshness; infer coverage or readiness from missing odds; fabricate executable Scout/Watchlist actions; change split browsing beyond scheduled events; add table scans; couple shared UI logic to provider-native payloads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Combined filters | Day has multiple competitions/statuses and a normalized participant query | URL, result count, desktop rows, and mobile cards reflect their intersection with stable sorting | Invalid URL facets canonicalize to safe defaults without request churn |
| All lifecycle view | Six lifecycle partitions return pages at independent snapshots | Exhaust, merge, order, and deduplicate results while preserving per-item metadata | Any failed/uninitialized partition yields an explicit partial state naming unavailable lifecycle groups |
| No source data | Every successfully loaded lifecycle partition is empty | Explain that no events exist for the selected sport/day | Do not describe this as a filter mismatch |
| No filter matches | Base day contains events but competition/search removes all | Explain that active filters match no events and offer clear-filter action | Keep base data and query state intact |
| Unsupported capability | Coverage/report/lineup/watch/scout data is absent by design | Visible `Unavailable` or disabled action with reason | Never infer a negative fact or issue a mutation |
| Non-scheduled detail | Postponed/cancelled/completed row opens detail | Resolve the canonical event directly and render lifecycle/freshness | Never search only the scheduled splits list |

</intent-contract>

## Code Map

- `apps/api/src/handler.ts` -- allow every canonical lifecycle on public `/games` while retaining scheduled-only `/splits` and strict filters.
- `apps/web/src/api.ts` -- lifecycle-parameterized page loading, bounded all-status fan-out, merge/deduplication, and partial-state contract.
- `packages/ui/src/event-explorer.ts` -- pure normalized filter, option, search, and stable sort policy.
- `apps/web/src/App.tsx` -- validated router search, explorer loading/states, dense table, mobile cards, direct lifecycle-safe detail.
- `apps/web/src/styles.css` -- accessible table, skeleton, state panels, readiness cells, responsive explorer cards.
- `tests/e2e/{local-games-api,games.spec}.ts` -- multi-status fixture API and route-level explorer behavior.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/{handler,handler.test}.ts` -- accept every canonical event status for `/games`, keep `/splits` scheduled-only, and cover rejection/serialization boundaries.
- [x] `apps/web/src/{api,api.test}.ts` -- parameterize lifecycle queries; add bounded all-status aggregation with deterministic merge, duplicate protection, cancellation, and explicit partial/uninitialized outcomes.
- [x] `packages/ui/src/{event-explorer,event-explorer.test,index}.ts` -- implement and exhaustively test NFKC search, combined facets, competition options, stable sort fields/directions, and safe labels.
- [x] `apps/web/src/{App,App.test,styles}.ts*` -- implement URL-backed filters, skeleton/retry/empty/partial states, accessible sortable desktop table, responsive cards, readiness placeholders, disabled actions, and direct non-scheduled detail.
- [x] `tests/e2e/{local-games-api,games.spec}.ts` -- exercise multiple lifecycles/competitions, combined filtering, sorting, no-match versus no-data, disabled affordances, detail navigation, and responsive presentation.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- mark FTE-018 done only after all checks pass.

**Acceptance Criteria:**
- Given live canonical events across lifecycle partitions, when `/games` is opened or deep-linked, then sport/day/status/competition/search/sort filters combine correctly, remain shareable, and show stable complete results.
- Given desktop and mobile viewports, when results load, then the desktop uses a semantic dense sortable table and mobile uses readable cards retaining matchup, kickoff, lifecycle, freshness, and primary detail action.
- Given missing downstream capabilities, when a row renders, then Hard Rock, comparison, report, and lineup states say unavailable and Scout/Watchlist actions are visibly disabled with reasons.
- Given loading, source-empty, filter-empty, partial, unavailable, or request-failure input, when the explorer renders, then each state is distinct, accessible, and retryable where applicable without a blank screen.
- Given any lifecycle row, when View Details is activated, then canonical detail loads independently of scheduled split discovery and preserves its lifecycle/freshness truth.

## Spec Change Log

- 2026-08-04: Implemented the credential-free lifecycle explorer, bounded all-status fan-out and partial coverage contract, canonical detail reads, pure filter/sort policy, responsive accessible results, honest readiness states, and desktop/mobile browser coverage. All repository, browser, and deployment preflight checks pass; story moved to review.

## Review Triage Log

### 2026-08-04 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 8 (high 5, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Preserved the complete validated explorer search context through detail links and Back to games.
  - `[high]` `[patch]` Removed scheduled-game empty claims whenever the scheduled lifecycle was unavailable or not selected.
  - `[high]` `[patch]` Restricted partial aggregation to retryable request failures and projection initialization; integrity and programming failures now fail closed.
  - `[medium]` `[patch]` Added visible accessible reasons for disabled Scout and Watchlist controls.
  - `[high]` `[patch]` Retained a matching authoritative explorer odds board on canonical detail while leaving unknown deep-linked boards unavailable.
  - `[medium]` `[patch]` Bounded every lifecycle request and surfaced timeouts as retryable partial or failure state.
  - `[high]` `[patch]` Rejected canonical detail payloads with unsupported sport keys.
  - `[medium]` `[patch]` Labeled every mobile price with its market and selection or side.

## Design Notes

`All` is a presentation aggregation over six independently consistent server partitions. The client preserves each response's snapshot semantics, caps page traversal, and reports partial coverage rather than manufacturing a composite cursor or atomic timestamp. Readiness placeholders are product truth: “not connected yet” is different from “book has no market.”

## Verification

Completed successfully on 2026-08-04: focused API/UI/web tests, full `pnpm check`, eight desktop/mobile browser tests, credential-free Phase 1 deployment preflight, and whitespace validation.

**Commands:**
- `pnpm --filter @find-the-edge/api test` -- all API lifecycle boundaries pass.
- `pnpm --filter @find-the-edge/ui test` -- pure filter/sort matrix passes.
- `pnpm --filter @find-the-edge/web test` -- explorer state and interaction coverage passes.
- `pnpm check` -- formatting, lint, boundaries, types, unit tests, and production build pass.
- `pnpm test:e2e` -- desktop/mobile explorer smoke passes.
- `pnpm phase1:preflight` -- deployment foundation remains valid.
- `git diff --check` -- no whitespace errors.
