---
title: 'Split-Bar Betting Splits Board'
type: 'feature'
created: '2026-08-06'
status: 'done'
baseline_commit: '8b9d39fb1cf6dc8652edc7f69dfd6162dc1d0811'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-premium-betting-splits-terminal.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The current splits table repeats handle, bets, and a long divergence sentence across nine metric columns, making the strongest public-money differences slow to scan and forcing excessive horizontal width.

**Approach:** Preserve the supplied visualization as a project template and adopt its recommended split-bar treatment: handle is a neutral fill, bets are a visible notch, and the signed gap is a purple money-heavy or amber ticket-heavy span with an exact accessible text equivalent.

## Boundaries & Constraints

**Always:** Use only the live split observations returned by the existing SharpAPI-backed API; keep every scheduled game, sport/day filter, sportsbook-scope filter/logo, freshness state, game-detail link, and soccer draw behavior; display line plus one handle-versus-bets bar for spread, total, and moneyline; retain exact percentages and direction in accessible text; use purple for money-heavy and amber for ticket-heavy because divergence is directional rather than good/bad; show partial evidence honestly; preserve responsive scrolling and the sticky team column.

**Ask First:** Any change to the splits API/DTO, provider selection, sportsbook aggregation policy, or the meaning of handle and bet percentages.

**Never:** Import mock games or percentages from the template; combine DraftKings and Circa unless the API scope itself is consensus; fabricate a missing percentage, line, or divergence; use green/red to imply a split is a positive/negative betting recommendation; remove textual/assistive direction cues; expose the source bundle as production application code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Complete split | Handle and bet percentages are present | Neutral handle fill, bet notch, colored divergence span, and signed point gap | Exact aria-label includes both percentages and direction |
| Handle only | Money percentage present, bet percentage absent | Handle fill remains; no notch/span or invented delta | Label says bets unavailable and never renders `—%` |
| Bets only | Bet percentage present, money percentage absent | Bet notch remains; no fill/span or invented delta | Label says handle unavailable and never renders `—%` |
| No evidence | No matching market/selection/scope observation | Muted unavailable state | No zero-valued bar or percentage is fabricated |
| Moneyline | Percentages exist but point is absent by design | Display `No line` beside the split bar | Do not render an em dash as if line evidence existed |
| Boundary/even | Values include 0%, 100%, or equal percentages | Endpoints remain visible; equal values show neutral `0` | Notch cannot be clipped and color is not the only cue |

</frozen-after-approval>

## Code Map

- `templates/Betting Splits Data Viz.html` -- preserved self-contained design reference supplied by the user.
- `apps/web/src/App.tsx` -- splits-board projection and accessible split-bar component.
- `apps/web/src/styles.css` -- compact table, divergence encoding, legend, and responsive behavior.
- `apps/web/src/App.test.tsx` -- complete, partial, boundary, scope, and accessibility regressions.
- `tests/e2e/games.spec.ts` -- desktop/mobile rendered splits smoke if the current fixture route supports the board.

## Tasks & Acceptance

**Execution:**
- [x] `templates/Betting Splits Data Viz.html` -- move the supplied bundle into a project-owned reference directory without altering it.
- [x] `apps/web/src/App.tsx` -- replace the three metric cells per market with line plus an accessible split bar and one shared legend.
- [x] `apps/web/src/styles.css` -- implement neutral fill, endpoint-safe notch, continuously scaled divergence span, strong-game grouping, and responsive sizing.
- [x] `apps/web/src/App.test.tsx` -- cover complete, partial, missing, 0/100/even, moneyline, scope, and non-fabrication behavior.
- [x] `tests/e2e/games.spec.ts` -- preserve desktop/mobile table usability and game navigation where applicable.

**Acceptance Criteria:**
- Given complete live split evidence, when a user scans the board, then all three markets fit as compact line-and-bar pairs and the strongest divergence is recognizable without reading a sentence.
- Given keyboard, screen-reader, mobile, partial-data, or no-data use, when the board renders, then every available value and direction remains understandable without relying on color or invented evidence.
- Given sportsbook and date filters, when the selection changes or refreshes, then the visualization continues to represent only the newest matching API observation for that scope.

## Spec Change Log

## Design Notes

The bar track spans 0–100. Handle fills from the origin; bets use a two-pixel notch; the area between them is the divergence. Accent intensity scales continuously with `pow(min(abs(handle - bets) / 62, 1), 0.75)`. Only exact display values are rounded; underlying percentages remain unchanged.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- all splits and movement component tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- component and DTO usage remain type-safe.
- `pnpm check` -- full repository quality, test, and build gate passes.
- `pnpm test:e2e` -- desktop and mobile browser smoke passes.

## Suggested Review Order

**Split-bar visualization**

- Start with the accessible handle, bets, divergence, and precision encoding.
  [`App.tsx:1240`](../../apps/web/src/App.tsx#L1240)

- Follow the scope-safe board projection and compact two-column market layout.
  [`App.tsx:1364`](../../apps/web/src/App.tsx#L1364)

- Inspect the responsive bar, contrast, endpoint, and sticky-column treatment.
  [`styles.css:746`](../../apps/web/src/styles.css#L746)

**Data honesty and local fidelity**

- Verify percentage-less records cannot claim split coverage or freshness.
  [`App.tsx:1235`](../../apps/web/src/App.tsx#L1235)

- Confirm browser tests exercise the real splits route and repository.
  [`local-games-api.ts:208`](../../tests/e2e/local-games-api.ts#L208)

**Regression evidence**

- Review complete, partial, unavailable, precision, and endpoint unit cases.
  [`App.test.tsx:1001`](../../apps/web/src/App.test.tsx#L1001)

- Check desktop/mobile scrolling, sticky identity, and soccer draw evidence.
  [`games.spec.ts:138`](../../tests/e2e/games.spec.ts#L138)

**Reference preservation**

- Compare the preserved supplied design study used for this implementation.
  [`Betting Splits Data Viz.html:1`](../../templates/Betting%20Splits%20Data%20Viz.html#L1)

- Keep the self-contained reference unchanged during repository formatting.
  [`.prettierignore:8`](../../.prettierignore#L8)
