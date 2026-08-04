# Epic 0C Context: Automated Grading and Learning Governance

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Close the paper-pick feedback loop with deterministic settlement, price-aware performance measurement, leakage-resistant learning, controlled strategy promotion, and an explicit safety boundary around real-money activity. The epic must make results useful for improving the betting process without rewriting historical evidence, overstating small samples, allowing an LLM to grade outcomes, or letting performance metrics silently activate wagering behavior.

## Stories

- Story FTE-LEARN-001: Deterministic ML and Spread Grading
- Story FTE-LEARN-002: Cohort Metrics, Calibration, CLV, and Uncertainty
- Story FTE-LEARN-003: Versioned Retrospective and Error Taxonomy
- Story FTE-LEARN-004: Walk-Forward Experiment and Strategy Promotion Gates
- Story FTE-LEARN-005: Real-Money Readiness Gate and Kill Switch

## Requirements & Constraints

- Completed-event results must settle eligible paper picks idempotently for supported two-way and three-way moneyline and spread markets. Outcomes include win, loss, push, void, and unresolved; an unsupported or ambiguous rule must never default to a loss.
- Grading must be deterministic and sport/market aware. It must account for ties, spread pushes, regulation-versus-overtime scope, cancellations, and official corrections without delegating any calculation or judgment to an LLM.
- Every grade must preserve the exact result version and provider provenance. Official corrections append auditable regrades rather than replacing prior grades, while duplicate delivery remains safe.
- Profit/loss, units, payout, and ROI must use the recorded decision-time price. Historical paper picks and their evidence remain immutable when strategies, models, results, or odds later change.
- Performance reporting must distinguish hit rate from profitability and include sample size, W/L/P/V counts, average odds, units, ROI, estimated decision-time EV, CLV when a valid closing line exists, calibration/Brier measures, confidence intervals, and drawdown.
- Cohorts must have immutable definitions and reproducible membership. Required segmentation includes sport, league, market, odds band, strategy version, model version, and paper-versus-money mode. Push and void denominators must be documented, missing closing lines must produce unavailable CLV rather than zero, and small samples must show uncertainty.
- Retrospectives must operate on frozen cohort manifests and separate result knowledge from decision-time evidence. They may classify data, price, model, rule, execution, false-positive, false-negative, and evidence-gap failures, but may not rewrite history or claim outcome-based certainty.
- Proposed prompt, strategy, or data changes create new version candidates with lineage and audited human review. A single game cannot automatically trigger promotion.
- Experiments must use chronological train, tune, and holdout windows with overlap checks. Holdout events cannot enter tuning inputs, and repeatedly tuned evidence cannot be presented as independent validation.
- Strategy promotion must evaluate configured minimum sample, ROI, CLV, calibration, drawdown, and regression criteria. Headline win rate alone is insufficient. Failing challengers remain recorded, promotion requires human approval, and rollback affects future runs without changing baseline history.
- Real-money mode remains disabled by default and is outside the automated learning loop. No metric, retrospective, model output, or strategy state may enable it automatically.
- Any future money-mode entry point must fail closed unless explicit, current human approval, jurisdiction/provider review, bankroll and per-bet/daily/weekly loss limits, dual confirmation, least-privilege feature enablement, and a global kill switch are all satisfied. Direct sportsbook credential storage and unattended bet placement remain out of scope.
- Grading, regrading, retrospective review, promotion, rollback, mode changes, approvals, limits, and kill-switch actions require immutable audit evidence and reason-coded observability. Historical records must not expire by default.

## Technical Decisions

- The universal domain uses stable sport, league, event, market, selection, strategy, model, and calculation identifiers. Sport modules own versioned grading mechanics; shared services must not branch on a hard-coded sport.
- Pure deterministic logic belongs in the domain and odds layers. Workers orchestrate result-triggered grading and scheduled analysis; APIs expose stored results and reports; web components must not implement authoritative calculations.
- Capability-specific result providers declare coverage and quality. Imported results and closing lines retain provider and retrieval provenance, and all primary learning records include `sportKey` plus the relevant sport-module, strategy, model, and calculation versions.
- Paper picks, result versions, grades/regrades, cohort manifests, retrospective versions, experiment evidence, approvals, and audit events are immutable or append-only. Mutable projections may improve reads but cannot replace historical truth.
- Performance aggregates are versioned, traceable to immutable inputs, and idempotent by source event or settlement identity. Aggregate reports expose their version, cohort hash, source counts, unavailable-data states, and failures.
- Regular data access must use explicit keys or indexes rather than table scans. Settlement changes use optimistic or conditional writes, and retries use stable idempotency identities.
- Strategy lifecycle transitions are explicit: draft, shadow, paper, candidate, and approved. Permission gates and deterministic validation—not model output—control promotion and rollback.
- Structured logs and metrics must expose grading/regrading/unresolved counts, aggregate and cohort versions, leakage/overlap failures, experiment gates, approvals, promotions, rollbacks, mode decisions, and kill-switch actions without logging secrets or licensed raw payloads.

## UX & Interaction Patterns

- Performance views prioritize ROI and CLV over win rate and show profit, average odds, estimated EV, bet count, market/league/confidence segments, time series, and calibration when sufficient evidence exists.
- Small or incomplete samples use a neutral caution state. Missing CLV, unresolved grades, stale evidence, and provider failures remain explicit rather than being rendered as zero or current data.
- The product should feel analytical and trustworthy, avoid casino or picks-selling aesthetics, avoid certainty language, and treat No Bet or insufficient evidence as valid outcomes.
- Human review surfaces must show frozen cohort identity, version lineage, gate-by-gate evidence, approval state, and the effect of rollback before an authorized decision is confirmed.
- Any future money-mode surface must display the active mode unmistakably and make approval expiry, configured limits, and global kill-switch state visible.

## Cross-Story Dependencies

- Deterministic grading requires completed-event result ingestion and reproducible paper-pick records.
- Cohort metrics consume immutable grades plus decision-time and closing-price evidence.
- Retrospectives freeze and analyze versioned cohorts produced by the metrics layer.
- Walk-forward experiments turn approved retrospective proposals into baseline/challenger evidence and promotion decisions.
- Real-money readiness depends on validated promotion evidence plus security hardening, production release controls, legal/provider review, and an independently approved release decision.
