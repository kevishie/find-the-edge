---
title: 'FTE-029 Fair Odds, EV, Expected Profit, Kelly, and Fractional Kelly'
type: 'feature'
created: '2026-08-06'
status: 'done'
baseline_revision: '4ef29576d1a743402fac7bd17b13d76697412f84'
final_revision: 'ae1b86537a644337395191750737d78eac644157'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-028-two-way-and-three-way-no-vig-consensus.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-032-consensus-and-qualification-defaults.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The odds engine exposes fair-price conversion and unit EV only; it cannot yet produce a complete, auditable expected-profit and informational Kelly result, and production qualification duplicates the EV formula. Consumers therefore lack one safe source of truth for these betting decisions.

**Approach:** Add strict pure helpers plus one fail-closed aggregate calculator that preserves full-precision values, returns a bounded display projection, and makes Kelly informational only. Route qualification EV through the same helper without changing its stored result contract or decision semantics.

## Boundaries & Constraints

**Always:** Keep authoritative math pure and sport-agnostic in `packages/odds`. Preserve the signatures and strict validation behavior of existing conversion and `expectedValue` helpers. Require fair probability strictly between zero and one, valid American offered odds, an explicit finite nonnegative stake, and a configured fractional-Kelly multiplier in `(0, 1]`. Calculate fair decimal and American odds, unit EV, expected profit, raw Kelly, nonnegative informational full-Kelly, and fractional-Kelly fractions from unrounded values. Echo immutable inputs, include a calculation version, and expose both full-precision and display-only values. Normalize negative display zero. Label expected profit as an expectation rather than certain profit and Kelly as informational only. Preserve qualification-v1 decisions, reasons, manifest EV, and version.

**Block If:** Correct implementation requires a bankroll amount, wager sizing/placement authority, a persisted manifest-schema change, or a shared rounding/version decision assigned to FTE-031.

**Never:** Add bankroll management, recommended wager amounts, automatic sizing, bet placement, UI/settings work, provider/database dependencies, sport-specific branches, AI arithmetic, input hashing, or durable provenance/version migration. Display-rounded values must never feed another calculation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Positive EV | Valid probability/price, explicit stake and fraction | Fair prices, positive EV/profit, raw Kelly, and fractional informational fraction | Available typed result |
| Zero/negative EV | Valid inputs at or below break-even | Truthful nonpositive EV/profit and raw Kelly; actionable Kelly fractions clamp to zero | Available typed result, never a negative stake fraction |
| Zero stake | Valid math with stake `0` | Expected profit is exactly zero; all price/EV/Kelly values remain valid | Available typed result |
| Invalid scalar | Probability outside `(0,1)`, invalid American odds, negative/non-finite stake, or fraction outside `(0,1]` | No partial calculation | Typed invalid result with stable issue code |
| Numeric collapse | Finite inputs produce non-finite/collapsed intermediate or profit overflow | No actionable values | Typed `numeric-overflow` invalid result |
| Display boundary | Raw value lies on a half-rounding or negative-zero boundary | Stable v1 display projection while raw value remains unchanged | No error expected |

</intent-contract>

## Code Map

- `packages/odds/src/index.ts` -- owns conversion, EV, edge evaluation, and the new fair-value helpers/result contract.
- `packages/odds/src/index.test.ts` -- formula goldens, invalid states, overflow, rounding, immutability, and raw-versus-display coverage.
- `packages/odds/src/qualification.ts` -- production evaluator currently duplicating the EV formula; must consume `expectedValue` without changing qualification-v1 behavior.
- `packages/odds/src/qualification.test.ts` -- direct parity coverage for the qualification adapter.
- `apps/workers/src/pick-evaluation.test.ts` -- stored manifest EV and decision regression.
- `packages/config/src/evaluation-policy.ts` -- accepted fractional-Kelly multiplier source; no contract change is required.

## Tasks & Acceptance

**Execution:**
- [x] `packages/odds/src/index.ts` -- add strict fair-odds, expected-profit, Kelly, fractional-Kelly helpers and a deeply immutable typed aggregate result with versioned display projection.
- [x] `packages/odds/src/index.test.ts` -- cover the complete matrix with exact positive/zero/negative EV goldens, favorite/underdog/even prices, invalid boundaries, overflow, rounding, and algebraic invariants.
- [x] `packages/odds/src/qualification.ts` -- replace inline EV arithmetic with the authoritative helper while preserving every public and persisted qualification-v1 behavior.
- [x] `packages/odds/src/qualification.test.ts` and `apps/workers/src/pick-evaluation.test.ts` -- prove helper parity and unchanged worker decision/manifest EV.

**Acceptance Criteria:**
- Given a valid fair probability and offered price, when fair value is calculated, then fair decimal/American odds round-trip to the probability and EV equals `p * decimalOdds - 1` at full precision.
- Given an explicit stake, when expected profit is calculated, then it equals `stake * EV`, is zero for zero stake, and is labeled as an expectation rather than guaranteed profit.
- Given positive, zero, or negative EV, when Kelly is calculated, then raw Kelly remains mathematically truthful while informational full/fractional stake fractions never fall below zero or exceed full positive Kelly.
- Given any invalid or numerically unsafe input, when the aggregate calculator runs, then it returns a deterministic typed invalid result with no partial raw or display values.
- Given production qualification evidence, when evaluation runs after the refactor, then its decision, reason codes, EV, calculation version, and stored manifest remain compatible.

## Spec Change Log

## Review Triage Log

### 2026-08-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 3, medium 3, low 1)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Nonzero expected profit could underflow to zero; strict and aggregate paths now fail closed, with positive and negative-collapse regression coverage.
  - `[high]` `[patch]` Positive fractional Kelly could underflow to zero; Kelly helpers now detect numeric collapse and the aggregate returns `numeric-overflow`.
  - `[high]` `[patch]` A slightly non-break-even probability could cancel to zero EV; the aggregate now distinguishes true break-even from floating-point cancellation and fails closed.
  - `[medium]` `[patch]` Relative display tolerance shifted large integral values and promoted below-half values; display projection now uses deterministic fixed-decimal conversion with exact-half and below-half tests.
  - `[medium]` `[patch]` Scaling a huge finite display value could overflow despite safe raw values; display rounding no longer multiplies by a decimal scale and preserves finite scientific-notation values.
  - `[medium]` `[patch]` Strict EV delegation changed qualification behavior at boundary or non-finite model probabilities; the compatibility adapter preserves qualification-v1 arithmetic outside the helper's strict domain while valid production inputs use the authoritative helper.
  - `[low]` `[patch]` Half-boundary coverage exercised only zero normalization; tests now cover positive and negative exact halves, immediately-below-half behavior, large values, underflow, cancellation, and qualification boundaries.

### 2026-08-06 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 1, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Algebraically exact break-even inputs could differ by one ULP across equivalent conversion paths and be falsely rejected; cancellation detection now compares against the canonical American-odds ratio and covers `100 / 207` at `+107`.
  - `[medium]` `[patch]` Built-in fixed formatting rounded canonical decimal half values such as `1.005` toward zero; display projection now rounds the number's canonical decimal representation with integer arithmetic while preserving below-half and huge finite cases.

### 2026-08-06 — Final follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` The package's existing `impliedProbability` helper can produce the other of two one-ULP break-even representations; cancellation detection now accepts both authoritative conversion paths while still rejecting a genuinely non-break-even zeroed result.

### 2026-08-06 — Confirmation review pass
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - none

## Design Notes

Golden fixture: `p=.48`, offered `+120`, stake `100`, quarter Kelly produces EV `0.056`, expected profit `5.60`, raw/full Kelly `0.046666…`, and fractional Kelly `0.011666…`. A `p=.50`, `-110` fixture retains negative raw Kelly but exposes zero informational stake fractions. Until FTE-031 establishes shared policy, the aggregate owns a named v1 display projection only: decimal odds to 3 decimals, American odds to a whole number, EV/Kelly as percentage points to 2 decimals, and expected profit to 2 decimals. Raw fields remain untouched and authoritative.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/odds test` -- all formula, adapter, and boundary tests pass.
- `pnpm --filter @find-the-edge/workers test` -- evaluation and manifest regressions pass.
- `pnpm check` -- repository formatting, lint, boundaries, types, tests, and builds pass.
