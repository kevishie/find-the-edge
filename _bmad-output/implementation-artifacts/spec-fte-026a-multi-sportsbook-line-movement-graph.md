---
title: 'Multi-Sportsbook Line Movement Graph'
type: 'feature'
created: '2026-08-06'
status: 'done'
baseline_commit: 'a912633841319793365103b62af5dc96365d841c'
review_loop_iteration: 1
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md'
  - '_bmad-output/implementation-artifacts/spec-fte-025-event-detail-odds-comparison.md'
warnings:
  - 'This story file reconstructs an already-started story from the planning artifacts and commit 8b9d39f.'
---

<intent-contract>

## Intent

**Problem:** A static current-price grid does not show how the market arrived there. The existing first-pass SVG is not yet a decision tool because it lacks book selection, step movement, opening/current context, keyboard details, state gaps, time windows, and a text-equivalent table.

**Approach:** Turn the Event Detail workbench into a dense, responsive, multi-sportsbook movement explorer that preserves every book as a separate step series and combines exact line/price history with DraftKings/Circa splits as clearly labeled evidence.

## Boundaries & Constraints

**Always:** Default all observed books on; preserve exact book identity with logo, text, color, and a non-color line pattern; use step interpolation; expose opening/current and exact observation details; break lines across non-active states; provide market, selection, metric, book, and time-window controls; provide an accessible table containing the same plotted values; make mobile/tablet usable; respect reduced motion; keep splits and movement explicitly non-causal and non-recommendatory.

**Block If:** The graph would need to merge books, fabricate a point, connect across unavailable evidence, infer a provider timestamp, or hide retained evidence through an irreversible transform.

**Never:** Present consensus as a sportsbook; call Circa a publishing sharp book; claim splits prove sharp action; identify series only by color; make hover the sole access to a value; replace exact American odds with a rounded derived value.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| All books | Several observed books | All enabled by default as separate series | Empty books remain honestly unavailable |
| Book filtering | User toggles logos | Only selected series render; history remains unchanged | At least one selected book or explicit empty state |
| Line movement | Spread/total point changes | Horizontal-then-vertical step line with exact associated price | No smoothing |
| Price movement | Moneyline or price metric | American and implied-probability views | Deterministic conversion only |
| Blocked interval | Suspended/unavailable point | Visible gap/state row; no connecting segment | Never interpolate through it |
| Opening/current | First/latest active observation | Labeled per book in graph, legend, and table | Truncated history is labeled as loaded-window evidence |
| Keyboard detail | User focuses point/table row | Book, point, American odds, probability, provider/collection times, and state | Same facts available without pointer |
| Dense history | Many books and points | Time presets and bounded responsive rendering | No mutation or dropped evidence in table |
| Small viewport | Tablet/mobile | Controls wrap, chart scrolls, table remains reachable | No clipped essential labels |

</intent-contract>

## Code Map

- `apps/web/src/api.ts` -- strict shared history envelope parsing and paging.
- `apps/web/src/App.tsx` -- movement controls, step-series chart, point inspector, split context, and accessible table.
- `apps/web/src/styles.css` -- dense responsive layout, book patterns, focus states, and reduced-motion behavior.
- `apps/web/src/sportsbooks.tsx` and `public/sportsbooks/` -- recognizable book logos with text fallback.
- `apps/web/src/App.test.tsx` and `apps/web/src/api.test.ts` -- component and boundary state matrix.
- `tests/e2e/games.spec.ts` and `tests/e2e/local-games-api.ts` -- desktop/tablet/mobile direct-detail smoke with realistic multi-book history.

## Tasks & Acceptance

**Execution:**
- [x] Add default-all, logo-backed sportsbook multi-select without changing retained history.
- [x] Render separate step series with stable color and dash identity, explicit opening/current markers, and honest non-active gaps.
- [x] Add market/selection controls plus moneyline American/implied and spread/total line/price metrics.
- [x] Add practical loaded-history time windows and clear truncated-window language.
- [x] Add hover and keyboard observation details containing exact line, American price, probability, provider time, collection time, and state.
- [x] Add an accessible plotted-values table with parity to the selected graph evidence.
- [x] Make desktop, tablet, mobile, focus, contrast, and reduced-motion behavior production-ready.
- [x] Add component and Playwright coverage, run the full local gates, complete adversarial review, and fix all accepted findings.

### Review Findings

- [x] [Review][Patch] Accept canonical percent-encoded selection filters [apps/api/src/handler.ts:395]
- [x] [Review][Patch] Mark only active evidence as opening/current [packages/database/src/odds-history-repository.ts:289]
- [x] [Review][Patch] Enforce SharpAPI provenance for projected history [packages/database/src/odds-history-repository.ts:247]
- [x] [Review][Patch] Reject malformed market-specific point values [packages/database/src/odds-history-repository.ts:245]
- [x] [Review][Patch] Enforce one fixed generated-at fence across pages [apps/web/src/api.ts:2160]
- [x] [Review][Patch] Reject duplicate observations within every page [apps/web/src/api.ts:1053]
- [x] [Review][Patch] Use own-property checks for the approved sportsbook roster [packages/database/src/odds-history-repository.ts:183]
- [x] [Review][Patch] Preserve every non-active gap through chart sampling [apps/web/src/App.tsx:1933]
- [x] [Review][Patch] Recompute loaded-window markers and disclose truncation [apps/web/src/App.tsx:2503]
- [x] [Review][Patch] Stop classifying Circa as a publishing sharp sportsbook [apps/web/src/App.tsx:2529]
- [x] [Review][Patch] Enforce deterministic tie ordering for observations [packages/database/src/odds-history-repository.ts:226]
- [x] [Review][Patch] Validate approved sportsbook scopes before event storage reads [apps/api/src/handler.ts:435]
- [x] [Review][Patch] Reject sportsbook identity changes across pages [apps/web/src/api.ts:2213]
- [x] [Review][Patch] Exercise the production history handler in end-to-end fixtures [tests/e2e/local-games-api.ts:295]
- [x] [Review][Patch] Show opening and current context in the graph and legend [apps/web/src/App.tsx:2234]
- [x] [Review][Patch] Deduplicate mirrored evidence across canonical event versions [packages/database/src/odds-history-repository.ts:235]
- [x] [Review][Patch] Bound response collection sizes and reject empty series [apps/web/src/api.ts:1020]
- [x] [Review][Patch] Surface current unavailable state instead of an older active legend value [apps/web/src/App.tsx:2784]

**Acceptance Criteria:**
- Given several observed sportsbooks, the graph defaults them all on, never merges their series, and identifies each with logo/text plus non-color styling.
- Given a spread, total, or moneyline selection, metric controls show exact line and associated price or American/implied views without changing underlying history.
- Given two or more observations, the visual uses step movement, labels opening/current loaded evidence, and never draws through suspended or unavailable states.
- Given pointer or keyboard interaction, exact book, value, American odds, implied probability, provider time, collection time, and state are available.
- Given the graph cannot be seen or operated, an accessible table exposes the same selected observations and markers.
- Given a long retained history, time-window controls make it usable while clearly describing whether earlier evidence exists.
- Given desktop, tablet, mobile, keyboard-only, or reduced-motion use, essential controls and values remain readable and operable to WCAG 2.1 AA intent.
- Given splits are present, DraftKings/Circa evidence is labeled separately from book line movement and no causal betting recommendation is claimed.

## Technical References

- [Epic 4 FTE-026A acceptance and tests](/Users/kevishie/Projects/find-the-edge/_bmad-output/planning-artifacts/epics-and-stories.md)
- [UX design specification](/Users/kevishie/Projects/find-the-edge/_bmad-output/planning-artifacts/ux-design-specification.md)
- [W3C WCAG: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- [W3C WCAG: Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html)

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test`
- `pnpm --filter @find-the-edge/web typecheck`
- `pnpm exec playwright test --config playwright.config.ts tests/e2e/games.spec.ts`
- `pnpm check`
- `pnpm phase1:preflight`
- local fixture API plus desktop/tablet/mobile browser smoke

## Dev Agent Record

### Implementation Plan

Build the interaction and accessibility layer over FTE-026's exact DTO, retain a strict no-fabrication boundary, and keep the rendering dense enough to compare many books quickly.

### Debug Log References

- Existing first-pass implementation commit: `8b9d39fb1cf6dc8652edc7f69dfd6162dc1d0811`.

### Completion Notes

- Delivered a dense, default-all multi-book decision workbench with logo filters, independent step-series lines, stable color/dash identity, and exact opening/current values.
- Added market, selection, metric, and 6h/24h/7d/all-loaded controls plus explicit loaded-window disclosure and unavailable-state handling.
- Preserved suspended/unavailable gaps through chart sampling, exposed keyboard-focus details, and provided an accessible table with the exact plotted evidence.
- Separated Pinnacle market-making movement from DraftKings public movement and separately labeled DraftKings/Circa split evidence without causal claims.
- Fixed all 18 accepted adversarial-review findings; full local checks, 12 desktop/mobile Playwright scenarios, and Phase 1 preflight pass.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-026a-multi-sportsbook-line-movement-graph.md`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`
- `apps/web/src/styles.css`
- `apps/web/public/sportsbooks/README.md`
- `apps/web/public/sportsbooks/caesars.svg`
- `apps/web/public/sportsbooks/hardrock.svg`
- `tests/e2e/games.spec.ts`
- `tests/e2e/local-games-api.ts`

## Change Log

- 2026-08-06: Reconstructed the missing in-progress story file and began the audited production-quality graph milestone.
- 2026-08-06: Completed the production multi-sportsbook movement workbench, resolved every accepted review finding, and passed all local release gates.
