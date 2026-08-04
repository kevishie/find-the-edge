# Epic 5 Context: Deterministic Betting Engine

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Provide a pure, reproducible, and auditable betting-math foundation that converts offered odds into probabilities, removes vig, builds weighted market consensus, derives fair prices and expected value, measures movement and closing-line value, and exposes uncertainty without unsupported causal claims. This engine supplies trusted calculation outputs to opportunity qualification, event analysis, scouting reports, bet tracking, and performance measurement while keeping all authoritative math outside provider adapters, storage, UI code, AWS services, and LLM output.

## Stories

- Story FTE-027: Pure Odds Conversion and Implied Probability Functions
- Story FTE-028: Two-Way and Three-Way No-Vig Consensus
- Story FTE-029: Fair Odds, EV, Expected Profit, Kelly, and Fractional Kelly
- Story FTE-030: Movement, CLV, Outlier, and Market Disagreement Functions
- Story FTE-031: Calculation Versioning, Precision, and Display Rounding
- Story FTE-032: Spike - Consensus and Qualification Defaults

## Requirements & Constraints

- Convert valid positive and negative American odds and decimal odds, calculate implied probability, and reject zero, malformed, missing, or impossible inputs rather than silently coercing them.
- Support complete two-outcome and three-outcome markets. Three-way consensus requires home, draw, and away; incomplete markets return an explicit insufficient-data or disqualified state instead of a fabricated probability.
- Apply configurable comparison-book weights and minimum-book requirements. Zero-weight, stale, suspended, incomplete, disabled, and invalid prices cannot contribute. Unknown books do not enter consensus without explicit configuration, and the target sportsbook is excluded from the consensus used to evaluate its own offer.
- Produce fair American and decimal odds, EV, and expected profit from reproducible inputs. Expected profit requires an explicit stake and must never be presented as certain profit.
- Kelly and configurable fractional Kelly are informational only. They must not trigger autonomous wager sizing, bankroll management, or bet placement.
- Quantify movement in both odds and implied-probability terms, calculate CLV against a configurable benchmark, detect outliers, and score market disagreement. Sparse history or a missing closing price produces an unavailable or insufficient-data result.
- Movement and disagreement outputs describe observed price behavior only. They must not claim sharp action, public action, or steam without verified supporting evidence.
- Every calculation validates inputs and returns typed success/failure states for normal bad market data. Missing, stale, suspended, or excluded inputs remain explainable to downstream qualification and UI consumers.
- Calculation outputs preserve enough inputs, source snapshot identity, algorithm version, precision, and a stable non-sensitive input hash to reproduce the result. Stored precision exceeds display precision; rounding occurs only at display or defined output boundaries.
- Automated correctness is the primary success measure: known examples, invalid and boundary cases, two-way and three-way vig removal, weighted consensus, EV, profit, Kelly, movement, CLV, outliers, disagreement, version propagation, hash stability, and rounding edges require unit coverage. Conversion round trips require property-style coverage, and golden fixtures must detect algorithm drift.

## Technical Decisions

- `packages/odds` owns authoritative betting calculations and may depend only on domain value types. It must remain deterministic and free of React, AWS, database, provider DTO, network, and LLM dependencies.
- Use pure functions for conversion, implied probability, no-vig normalization, weighted consensus, fair odds, EV, expected profit, Kelly, movement, CLV, outlier detection, and disagreement scoring. Normal invalid market states are data results, not exceptional control flow.
- Consensus, EV, opportunity, CLV, and report records carry the calculation version. Derived consensus records also retain the input-snapshot hash so historical results remain explainable after algorithm changes.
- Internal calculations use a shared decimal-precision policy. UI formatting is a separate boundary concern and cannot feed rounded values back into calculations.
- Comparison books, weights, minimum EV, maximum odds age, minimum contributing books, outlier rules, disagreement thresholds, fractional Kelly percentage, CLV benchmark, and snapshot retention are configurable defaults, not irreversible constants. Their initial values require an approved decision record before production qualification ships.
- Deterministic outputs may be supplied to AI-assisted narratives, but an LLM cannot calculate, replace, or alter odds conversion, vig removal, consensus, EV, Kelly, movement, or CLV.

## UX & Interaction Patterns

Consumers show fair odds, implied and consensus probability, EV, contributing-book count, freshness, warnings, and explicit qualification or disqualification reasons. Fractional Kelly is visibly labeled informational. Unavailable calculations display a reason rather than a placeholder number. Display formatting may use American or decimal odds while preserving the same underlying calculation. Movement indicators distinguish price direction, stale gaps, suspension, and missing history, and never imply an unsupported cause.

## Cross-Story Dependencies

FTE-027 is the mathematical base for every later story. FTE-028 requires conversion plus the approved configurable defaults from FTE-032; FTE-029 builds on conversion and consensus. FTE-030 uses conversion and the thresholds or benchmark selected by FTE-032. FTE-031 standardizes versioning and precision across all earlier functions. FTE-032 depends on provider capabilities and the approved competition scope, and it must resolve the initial consensus, outlier, freshness, disagreement, Kelly, retention, and CLV defaults before final opportunity qualification. Downstream opportunity, scouting, bet-settlement, and performance stories consume these outputs but do not redefine the formulas.
