# Epic 5 Context: Deterministic Betting Engine

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Provide a pure, sport-agnostic, reproducible betting-math foundation that converts offered odds into probabilities, removes vig, builds weighted consensus, derives fair prices and expected value, and measures movement and closing-line value. This engine makes downstream opportunities, reports, picks, bet tracking, and performance analysis auditable while keeping authoritative calculations outside providers, persistence, applications, and AI.

## Stories

- Story FTE-027: Pure Odds Conversion and Implied Probability Functions
- Story FTE-028: Two-Way and Three-Way No-Vig Consensus
- Story FTE-029: Fair Odds, EV, Expected Profit, Kelly, and Fractional Kelly
- Story FTE-030: Movement, CLV, Outlier, and Market Disagreement Functions
- Story FTE-031: Calculation Versioning, Precision, and Display Rounding
- Story FTE-032: Spike - Consensus and Qualification Defaults

## Requirements & Constraints

- Convert valid American and decimal odds and calculate implied probability deterministically. Reject zero, malformed, missing, or impossible inputs rather than coercing them.
- Accept generic market definitions and selections. Support complete two-outcome and three-outcome markets; a three-way calculation requires all required selections. Sport modules define possible markets, while versioned strategies decide which markets are approved.
- Build no-vig consensus from configured comparison sportsbooks and weights. Disabled, zero-weight, stale, suspended, incomplete, outlier-excluded, and invalid prices cannot contribute. The configured target sportsbook must never contribute to the consensus used to evaluate its own offer.
- Return explicit typed states for insufficient books, missing selections, stale data, suspended markets, invalid odds, unavailable closing prices, and sparse history. Never fabricate a value or use ordinary bad market data as exceptional control flow.
- Produce fair odds in American and decimal formats, EV, and expected profit from reproducible inputs. Expected profit requires an explicit stake and is not certain profit.
- Kelly and configurable fractional Kelly are informational only; they cannot drive autonomous stake sizing, bankroll management, or sportsbook bet placement.
- Quantify movement in odds and implied-probability terms, calculate CLV against the configured benchmark, detect outliers, and score market disagreement. Results describe observed prices only and must not infer sharp, public, or causal movement without evidence.
- Preserve calculation inputs, source snapshot identity, a stable non-sensitive input hash, and applicable sport-module, strategy, and calculation versions so derived results can be reproduced after configuration or algorithm changes.
- Preserve greater internal precision than display precision. Apply a shared decimal policy and round only at defined output or display boundaries; rounded values must never feed later calculations.
- Cover known formulas, invalid and boundary inputs, two-way and three-way vig removal, weighted consensus, EV, expected profit, Kelly, movement, CLV, outliers, disagreement, version propagation, hash stability, and rounding edges with unit tests. Use property-style conversion round trips and golden fixtures to expose algorithm drift.

## Technical Decisions

- `packages/odds` owns all authoritative betting calculations. It may depend only on generic domain value types and must contain no AWS, database, provider DTO, network, React, or LLM dependencies.
- Implement calculations as pure functions with typed success/failure results. Core pricing must not branch on sport; registered modules and versioned strategy configuration supply market policy, thresholds, and target sportsbook.
- Consensus, EV, opportunity, CLV, report, evaluation, and pick records carry the versions and provenance relevant to their reproduction. Derived consensus records retain the calculation version and input-snapshot hash.
- Comparison sportsbooks, weights, minimum EV, maximum odds age, minimum contributing books, outlier policy, disagreement thresholds, fractional-Kelly percentage, CLV benchmark, and retention are configuration rather than constants.
- Current approved defaults are DraftKings, FanDuel, BetMGM, and Caesars when entitled, initially equal weighted; a 15-minute maximum odds age; at least three eligible independent comparison books; exclusion of a book when any outcome deviates eight probability points from the cross-book median; and closing comparison consensus excluding the target as the CLV benchmark. EV thresholds remain sport-strategy-specific. Immutable MVP snapshots have no TTL. Changes require versioned evidence and an updated decision record.
- AI may consume deterministic outputs for narrative synthesis but cannot calculate or alter odds conversion, vig removal, consensus, EV, qualification, payout, Kelly, movement, grading, or CLV.

## UX & Interaction Patterns

Consumers must be able to show the underlying odds format, implied and fair probability, fair odds, EV, contributing-book count, freshness, algorithm/version details, and explicit unavailable or disqualification reasons. Fractional Kelly is labeled informational. Movement output distinguishes price direction, stale gaps, suspension, and missing history without implying an unsupported cause.

## Cross-Story Dependencies

The completed sport-agnostic domain, versioned strategy configuration, and weighted-consensus state foundations are prerequisites that Epic 5 consumes rather than duplicates. FTE-027 is the mathematical base for FTE-028 through FTE-030. FTE-028 uses the configurable defaults governed by FTE-032; FTE-029 builds on conversion and consensus; FTE-030 uses configured thresholds and the CLV benchmark. FTE-031 standardizes precision, hashing, and version propagation across all calculations. Downstream opportunity qualification, scouting, paper-pick evaluation, bet settlement, and performance stories consume these outputs and must not redefine the formulas.
