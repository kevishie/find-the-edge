---
title: 'FTE-030 Movement, CLV, Outlier, and Market Disagreement Functions'
type: 'feature'
created: '2026-08-06'
status: 'in-review'
baseline_revision: '2dc03b08c91773e695e4be1d9efb9fb207844120'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-029-fair-odds-ev-expected-profit-kelly-and-fractional-kelly.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-032-consensus-and-qualification-defaults.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Movement is currently calculated only in React, outlier and disagreement math is embedded in other calculations, and the accepted closing-consensus CLV benchmark has no pure implementation. These gaps prevent consumers from receiving one deterministic, explainable market-quality result.

**Approach:** Add versioned pure helpers for observed line movement, closing-consensus CLV, whole-book outliers, and market disagreement. Make existing consensus and qualification delegate to the shared helpers without changing their v1 outputs or persisted evaluation identity.

## Boundaries & Constraints

**Always:** Keep authoritative math pure and sport-agnostic in `packages/odds`. Derive movement direction from implied probability rather than naive American-odds sign arithmetic; report point movement separately and do not compare prices across changed spread/total lines. Require an explicit significance threshold. Calculate CLV against a complete closing comparison consensus that excludes the target sportsbook, using `placedDecimal * closingFairProbability - 1` and `closingFairProbability - placedImpliedProbability`; positive means the placed price beat that independent close. Preserve upper-median, strict-greater-than outlier exclusion and warning/block threshold equality. Return deeply immutable full-precision results with stable reason codes and local calculation versions. Preserve qualification decisions, reasons, scalar disagreement, version, manifest hash, and worker IDs.

**Block If:** Correct implementation requires choosing a new default significance or history-gap threshold, changing the accepted closing-consensus benchmark, changing a persisted schema/version/hash, or redefining existing consensus/qualification semantics.

**Never:** Infer sharp, public, steam, causal, or recommended-bet meaning from movement alone. Do not add UI, provider, database, AWS, machine-learning, settlement, closing-snapshot lookup, display rounding, shared input hashing, or durable version propagation. Do not substitute the target or a same-book close when closing consensus is unavailable; those integration changes belong to FTE-051 and shared precision/provenance belongs to FTE-031.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Comparable movement | Two or more active same-line observations | Odds endpoints/delta, implied-probability delta, direction, maximum gap, and significance | Available typed result |
| Changed line | Point differs between opening and latest active observation | Point delta remains visible; price/probability comparison is unavailable | `line-changed` reason, no fabricated price movement |
| Sparse or inactive history | Fewer than two active observations, or current evidence is suspended/unavailable | No actionable movement; current state remains explicit | Typed insufficient-data reason |
| Closing consensus | Valid placed price and available selected closing probability | Positive, zero, or negative price and probability CLV with nested consensus evidence | Available typed result |
| Missing close | Closing consensus is invalid/sparse or selection is absent | No CLV values and no target/same-book fallback | Typed bounded reason with nested consensus |
| Outlier | Any outcome deviates strictly beyond the configured upper-median threshold | Entire book excluded; centers and per-book deviations retained | Exact threshold remains included |
| Disagreement | At least two post-outlier vectors | Maximum per-outcome range, decisive selection, and none/warning/block classification | Equality triggers warning/block; sparse score is `null` |

</intent-contract>

## Code Map

- `packages/odds/src/index.ts` -- current odds, consensus, outlier, and fair-value public surface; re-export the new pure market-signal contracts.
- `packages/odds/src/movement.ts` and `movement.test.ts` -- canonical history ordering, comparable movement, point changes, gaps, direction, and significance.
- `packages/odds/src/market-quality.ts` and `market-quality.test.ts` -- standalone upper-median whole-book outlier audit and post-outlier disagreement score.
- `packages/odds/src/clv.ts` and `clv.test.ts` -- scalar CLV and fail-closed selected closing-consensus adapter.
- `packages/odds/src/index.test.ts` -- consensus delegation parity and unchanged outlier exclusions.
- `packages/odds/src/qualification.ts` and `qualification.test.ts` -- disagreement delegation with exact qualification-v1 compatibility.
- `apps/workers/src/pick-evaluation.test.ts` -- immutable manifest hash/ID, thresholds, reasons, and stored disagreement regression.

## Tasks & Acceptance

**Execution:**
- [x] `packages/odds/src/movement.ts` and `movement.test.ts` -- implement typed, immutable movement and explicit-threshold helpers covering direction, sign crossing, changed points, sparse/current inactive evidence, gaps, ordering, and boundaries.
- [x] `packages/odds/src/market-quality.ts` and `market-quality.test.ts` -- implement deterministic outlier and disagreement audits for two- and three-outcome vectors, including exact thresholds, upper-median compatibility, permutation invariance, and sparse states.
- [x] `packages/odds/src/clv.ts` and `clv.test.ts` -- implement strict scalar CLV plus selected closing-consensus CLV with target exclusion, selection alignment, nested evidence, and fail-closed unavailable states.
- [x] `packages/odds/src/index.ts` and `index.test.ts` -- export the contracts and route weighted-consensus outlier decisions through the shared audit without changing consensus-v1 results.
- [x] `packages/odds/src/qualification.ts`, `qualification.test.ts`, and `apps/workers/src/pick-evaluation.test.ts` -- route disagreement through the shared helper while proving qualification and persisted worker evidence remain byte-for-byte compatible.

**Acceptance Criteria:**
- Given comparable retained observations, when movement is calculated, then direction follows implied probability, exact significance/gap boundaries are deterministic, and input order does not change the frozen result.
- Given a placed price and selected closing comparison consensus, when CLV is calculated, then both CLV formulas match their golden values and unavailable consensus exposes no numeric fallback.
- Given complete two- or three-outcome book vectors, when quality is analyzed, then any-outcome outliers and decisive disagreement ranges use one shared formula with explicit evidence.
- Given production qualification evidence, when helper delegation is enabled, then decisions, reasons, scalar disagreement, calculation version, manifest hash, and worker identifiers remain unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 1, medium 9, low 1)
- defer: 0
- reject: 3: (high 0, medium 2, low 1)
- addressed_findings:
  - `[medium]` `[patch]` Added numeric-tolerance comparisons so mathematically exact outlier, warning, and block boundaries retain the documented strict/inclusive semantics.
  - `[medium]` `[patch]` Rejected probability vectors whose total is not one within machine-precision tolerance.
  - `[medium]` `[patch]` Required every movement observation, including inactive evidence, to contain valid American odds.
  - `[medium]` `[patch]` Required canonical UTC ISO timestamps so history ordering is cross-runtime deterministic.
  - `[low]` `[patch]` Replaced locale-sensitive observation-ID tie-breaking with code-point ordering.
  - `[high]` `[patch]` Made any intervening point change invalidate price comparison, even when the latest point later returns to the opening point.
  - `[medium]` `[patch]` Rejected non-finite point and American-odds deltas rather than exposing infinite movement values.
  - `[medium]` `[patch]` Gave invalid placed odds precedence over sparse closing-consensus availability.
  - `[medium]` `[patch]` Preserved qualification-v1 scoring for malformed disagreement thresholds while delegating valid policies to the shared helper.

### 2026-08-06 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 7, low 0)
- defer: 0
- reject: 1: (high 0, medium 1, low 0)
- addressed_findings:
  - `[medium]` `[patch]` Tightened equality tolerance to two machine epsilons and bounded it by half the configured threshold, preserving exact decimal boundaries without suppressing real near-boundary movement.
  - `[medium]` `[patch]` Replaced the qualification catch-all with an explicit malformed-threshold compatibility branch.
  - `[medium]` `[patch]` Returned invalid placed odds before consensus construction and made absent nested consensus explicit for direct-input failures.
  - `[medium]` `[patch]` Rejected extreme finite odds that collapse to invalid unit probability or decimal price.
  - `[medium]` `[patch]` Replaced spread-argument min/max operations with reductions so large comparison rosters remain bounded.

### 2026-08-06 — Final focused review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` Replaced the fixed/half-threshold deadband with a threshold-relative two-epsilon comparison, retaining literal-decimal equality without swallowing genuine representable excesses above or below ordinary and tiny thresholds.

## Design Notes

Movement uses selection perspective: increased implied probability is `shortened`, decreased is `lengthened`, and equality is `unchanged`. Significant means absolute probability delta `>=` the caller-supplied threshold; maximum-gap status is strictly greater than its caller-supplied threshold. CLV golden: placed `+120` against closing fair probability `.50` yields price CLV `.10` and probability CLV `.0454545…`. Outlier centers preserve the consensus-v1 upper median for even rosters; disagreement is the largest post-outlier probability range across every outcome, not only the candidate outcome.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/odds test` -- movement, CLV, outlier, disagreement, and compatibility goldens pass.
- `pnpm --filter @find-the-edge/workers test` -- persisted evaluation regression passes.
- `pnpm check` -- repository formatting, lint, boundaries, types, tests, and builds pass.
- `git diff --check` -- no whitespace defects.
