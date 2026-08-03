---
title: 'Sportsbook Market Board'
type: 'feature'
created: '2026-08-02'
status: 'done'
baseline_commit: '39421a0d18e07833191fcfb19633633d532d2a60'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-design-specification.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-live-the-odds-api-games-and-odds.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Games are compact now, but each card still presents odds as a vertical moneyline list. Users cannot scan the two teams and compare the three standard sportsbook markets—spread, total, and moneyline—the way they can on a sportsbook board.

**Approach:** Ingest real h2h, spread, and total markets from The Odds API and render every game as a dense two-row market board. Each team occupies one row beneath fixed Spread, Total, and ML columns; totals map Over to the away row and Under to the home row, matching the supplied reference.

## Boundaries & Constraints

**Always:** Keep games grouped by sport and Eastern day. Preserve the away-then-home participant order, sportsbook provenance, observation time, monthly quota reserve, bounded exact DynamoDB reads, and fail-closed validation. Store the line/point independently from its American price. Select one coherent preferred sportsbook per game. On narrow screens, preserve readable team rows and market columns using horizontal scrolling rather than stacking giant cards. Display an em dash for a complete market that the selected sportsbook does not offer.

**Ask First:** Adding a bet slip, clickable wagering, team logos from a new asset provider, multiple-book comparison columns, or derived/fair lines.

**Never:** Invent missing spread/total values, mix selections from different sportsbooks or incompatible observation snapshots, expose the provider key, scan DynamoDB, place bets, or copy Hard Rock branding/assets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Full MLB board | Coherent h2h, spreads, totals | Two team rows with Spread, Total, ML line/price cells | N/A |
| Full MLS board | Three-way h2h plus spreads/totals | Team rows show away/home ML; draw remains accessible in compact market metadata | N/A |
| Optional market absent | Complete ML but no spread or total | Game remains visible; absent column cells show em dashes | Do not fabricate values |
| Partial/corrupt market | Only one side, bad point, mixed book/timestamp | Do not expose that market | Treat optional market as unavailable; reject corrupt stored rows |
| Narrow viewport | Board wider than viewport | Team rows remain aligned under headers | Horizontal scroll with semantic labels |

</frozen-after-approval>

## Code Map

- `packages/providers/src/the-odds-api.ts` -- request and normalize h2h, spreads, totals, including line points.
- `packages/domain/src/{fixture-odds,index}.ts` -- persist optional market point and expose it in game DTOs.
- `apps/workers/src/live-odds-ingestion.ts` -- persist all normalized markets and reserve the correct provider-request cost.
- `packages/database/src/games-repository.ts` -- bounded multi-market reads and coherent preferred-book selection.
- `apps/web/src/{api,App}.tsx` -- validate market bundles and render the two-row board.
- `apps/web/src/styles.css` -- dense desktop grid and mobile horizontal-scroll treatment.

## Tasks & Acceptance

**Execution:**
- [x] Extend provider/domain normalization and tests for h2h, spread, total, and point values.
- [x] Persist all markets with quota-safe request accounting and test the worker mapping.
- [x] Read coherent complete markets without scans; test missing, partial, corrupt, and bounded cases.
- [x] Validate the expanded payload and render accessible two-row market boards with responsive tests.
- [x] Update live smoke proof for the guarded AWS launch and deployed browser verification.

**Acceptance Criteria:**
- Given a provider-backed MLB game with all three markets, when Games loads, then each team has one aligned row with Spread, Total, and ML values from one sportsbook.
- Given multiple games, when scanning the page, then column headers repeat by board and several games fit within one desktop viewport.
- Given mobile width, when viewing a game, then team and market rows stay aligned and are reachable without oversized vertical cards.
- Given deployment, when live smoke runs, then the public UI shows real provider IDs and at least one real three-market board without authentication.

## Spec Change Log

## Design Notes

The UI borrows the reference’s information architecture, not its branding: game metadata above a four-column grid (`Team | Spread | Total | ML`), with two participant rows and compact line/price pairs. MLS draw ML is shown in a small footer because it is not owned by either team row.

## Verification

**Commands:**
- `pnpm check` -- all repository quality gates pass.
- `pnpm phase1:test && pnpm phase1:preflight && pnpm test:e2e` -- deployment tooling and responsive browser contracts pass.
- Guarded Phase 1 launch -- AWS deploy, live ingest, anonymous API, and hosted browser smoke pass.

## Suggested Review Order

**Market ingestion and integrity**

- Normalize three real markets while safely degrading malformed optional data.
  [`the-odds-api.ts:128`](../../packages/providers/src/the-odds-api.ts#L128)

- Account for three-market provider requests before storing normalized selections.
  [`live-odds-ingestion.ts:44`](../../apps/workers/src/live-odds-ingestion.ts#L44)

- Assemble bounded, coherent preferred-book snapshots without DynamoDB scans.
  [`games-repository.ts:145`](../../packages/database/src/games-repository.ts#L145)

**Public contract and board UI**

- Fail closed on malformed teams, prices, points, books, or snapshots.
  [`api.ts:116`](../../apps/web/src/api.ts#L116)

- Render each game as aligned away/home rows across Spread, Total, and ML.
  [`App.tsx:561`](../../apps/web/src/App.tsx#L561)

- Keep dense boards readable through responsive grids and horizontal scrolling.
  [`styles.css:598`](../../apps/web/src/styles.css#L598)

**Release proof and supporting tests**

- Require real, coherent three-market data during the guarded live smoke.
  [`phase1-environment-smoke.mjs:167`](../../scripts/phase1-environment-smoke.mjs#L167)

- Exercise complete market normalization and optional-market degradation.
  [`the-odds-api.test.ts:34`](../../packages/providers/src/the-odds-api.test.ts#L34)

- Verify the accessible two-row sportsbook board and Eastern-day filters.
  [`App.test.tsx:145`](../../apps/web/src/App.test.tsx#L145)
