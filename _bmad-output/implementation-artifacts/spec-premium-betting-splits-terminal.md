---
title: 'Premium Betting Splits Terminal'
type: 'feature'
created: '2026-08-03T14:05:00-04:00'
status: 'done'
baseline_commit: '50523cb2b99a992434abe7ae699589a3cddf5336'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-design-specification.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The current betting-splits page presents each game as a separate card with a generic market/side list, making it slow to compare many games, teams, and money-versus-ticket imbalances at once.

**Approach:** Replace it with a branded FIND THE EDGE splits terminal inspired by the supplied dense comparison layout: paired team rows per game, grouped Spread/Total/Moneyline columns, handle and bet percentages, strong imbalance signals, compact sport/date controls, and direct game-detail navigation.

## Boundaries & Constraints

**Always:** Use the existing public splits API and canonical game data; preserve missing values as `—`; distinguish money/handle from bets/tickets; retain provider scope and freshness; use the existing near-black, charcoal, purple, mono-data FIND THE EDGE visual language; keep semantic table headers, keyboard access, readable type, and horizontal scrolling on narrow screens; render all available games without inventing percentages, lines, movement, team logos, or rankings.

**Ask First:** Adding new API fields, aggregating across provider scopes, introducing team-logo assets, or changing the game-detail page beyond shared visual primitives.

**Never:** Copy Pro Tools branding, colors, or promotional content; imply that percentages are recommendations; manufacture the complementary side when SharpAPI did not supply it; add bet placement or a wagering slip; hide provenance or stale/missing states.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Full game | Two teams with spread, total, and moneyline splits | One compact two-row game group with aligned line, handle, and bets cells | N/A |
| Partial market | One side, line, handle, or bets value is absent | Preserve row alignment and show `—` only for the absent value | Do not infer complements |
| Strong imbalance | Money and bet percentages differ materially | Highlight magnitude and direction with text plus restrained brand/signal color | Never rely on color alone |
| No splits | Scheduled games exist without usable splits | Show an informative empty state under active filters | Keep filters usable |
| Narrow viewport | Table is wider than viewport | Keep dense table intact in a labeled horizontal scroll region | No unreadably small text |
| Load failure | Public splits request fails | Show the existing redacted error message without stale rows | Retry on filter change/reload |

</frozen-after-approval>

## Code Map

- `apps/web/src/App.tsx` -- existing splits explorer, filters, split-to-game association, and detail links.
- `apps/web/src/styles.css` -- FIND THE EDGE tokens and current card/table styling.
- `apps/web/src/App.test.tsx` -- component behavior and accessibility assertions.
- `apps/web/src/api.ts` -- trusted split DTO contract; no API change expected.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/App.tsx` -- transform split observations into stable team/market cells and render a dense grouped comparison table with branded summary header, filters, provenance, freshness, imbalance indicators, and game links.
- [x] `apps/web/src/styles.css` -- implement the premium terminal treatment, sticky identity column/header where practical, compact percentage cells, imbalance states, empty/loading states, and responsive horizontal scrolling.
- [x] `apps/web/src/App.test.tsx` -- cover paired rows, all three markets, partial data, imbalance text, filters, links, and empty/error states with accessible queries.

**Acceptance Criteria:**
- Given multiple games with splits, when the page loads, then users can compare teams and Spread/Total/Moneyline handle and bet percentages without opening individual cards.
- Given an available line or percentage, when rendered, then it appears under the correct team, market, and metric with no derived provider data.
- Given a meaningful money-versus-bets gap, when rendered, then magnitude and direction are understandable without color alone.
- Given desktop or mobile width, when navigating the table, then team identity remains understandable and every data column remains accessible.
- Given a game row, when its detail action is activated, then the canonical game detail opens with the active sport and day preserved.

## Spec Change Log

## Design Notes

Use a single league/day terminal rather than one card per game. Each game occupies two adjacent team rows separated from the next game by a stronger rule. Column groups use a two-tier header: market name above `Line`, `Handle`, and `Bets`. Purple marks active controls and selected context; green/amber/red signal exceptional gaps with explicit signed-point text. Keep source/freshness in a compact terminal toolbar rather than repeating verbose metadata in every cell.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- component tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- TypeScript passes.
- `pnpm --filter @find-the-edge/web build` -- production bundle succeeds.
- `pnpm exec playwright test --config playwright.config.ts` -- desktop and mobile smoke tests pass.

**Manual checks (if no CLI):**
- Inspect populated, partial, empty, loading, and error states at desktop and mobile widths; confirm horizontal scrolling, focus visibility, provenance, and game navigation.

## Suggested Review Order

**Terminal composition and data integrity**

- Start with scope-safe grouping, explicit selections, freshness, and complete market rows.
  [`App.tsx:687`](../../../apps/web/src/App.tsx#L687)

- Review the semantic terminal table and its loading, error, and empty states.
  [`App.tsx:913`](../../../apps/web/src/App.tsx#L913)

**Visual system and responsive behavior**

- Inspect the branded terminal shell, readable signals, and horizontal overflow treatment.
  [`styles.css:484`](../../../apps/web/src/styles.css#L484)

**Regression coverage**

- Verify paired games, scope separation, totals, soccer draws, and freshness behavior.
  [`App.test.tsx:409`](../../../apps/web/src/App.test.tsx#L409)
