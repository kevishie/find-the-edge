---
title: 'Splits board views, integrity, and one-minute cadence'
type: 'feature'
created: '2026-08-08'
status: 'in-review'
baseline_commit: 'cd8e138'
review_loop_iteration: 0
context:
  - '{project-root}/templates/Betting Splits Data Viz.html'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-perf-board-request-path.md'
---

## Intent

Ship the density study end to end and make the board trustworthy and fresh:

- **Views.** The designed switcher replaces the provisional toggle: icon-and-
  label pills, the active view filled `#a855f7` with dark text, a per-view
  hint, and a locally saved preference. Four views: Split Bars (default),
  Heat Cells, Divergence, and Compare All, which renders the three encodings
  as stacked boards against the same rows. All share one encoding — a
  power-0.75 ramp saturating at ±62 points, purple money-heavy, amber
  ticket-heavy.
- **Integrity.** The provider occasionally publishes a listing and withdraws
  it before any book quotes it (observed live: a 2:50 AM duplicate of a 4:10
  PM matchup, gone from the feed by morning). Nothing retires the stored
  event. A real game always retains its last odds rows after first pitch, so
  a scheduled game hours past its claimed start with no odds evidence is
  treated as withdrawn and dropped from boards. Sport tabs on the splits
  screen appear only when a sport's board carries split percentages —
  measured live, the provider publishes splits for exactly MLB, NCAAF, WNBA,
  and CFL, so an MLS tab could never fill.
- **Cadence.** The scheduler ticks every minute; the schedule catalog and
  every league's lines refresh each tick (thirty-second near-start floor so a
  tick can never skip the window). Splits keep their five-minute checkpoint.
  The games screen revalidates on the same one-minute clock and keeps its
  last good page through failed background refreshes; its merged
  all-lifecycle board is materialized at ingest like the splits boards. A
  full tick spends under fifty of the provider's thousand requests a minute.

## Measured / Verified

- Switcher verified on staging: four pills, active fill `rgb(168,85,247)`,
  hint and saved-note present; Compare All renders three captioned boards.
- Board delivery: stored-read serving at ~150 ms with gzip (~13 kB wire).
- Phantom listing verified dropped after the first post-deploy
  materialization tick.

## Boundaries kept

- The withdrawn-listing rule never hides an upcoming game awaiting evidence
  and never hides a started game, which retains its odds rows.
- The current sport's tab always stays reachable; only peer tabs are gated
  on proven coverage.
- The stored view preference migrates from the provisional key.

## Code Map

- `apps/web/src/App.tsx` — view switcher, board table component, sport-tab
  coverage probe, games auto-refresh.
- `packages/database/src/games-repository.ts` — withdrawn-listing rule.
- `packages/database/src/board-projection.ts` — games all-view targets.
- `packages/config/src/feed-coverage.ts` — one-minute cadences.
- `infra/cdk/src/foundation.ts` — one-minute scheduler tick.

## Follow-ups

- Provider splits exist today for NCAAF, WNBA, and CFL and are not ingested;
  expanding league coverage is the concrete growth path (tennis has no
  splits at all).
- Sub-minute line refresh would need a self-requeuing SQS delay loop; the
  EventBridge floor is one minute.
