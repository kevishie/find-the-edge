# Decision Log

## 2026-07-26 — Multi-sport module architecture

Reason: Original soccer-first planning and the first MLB slice would force sport conditionals into shared models and infrastructure.

Decision:

- Universal domain and pricing stay sport-agnostic.
- Registered sport modules own mechanics, data needs, terminology, and extension behavior.
- Versioned strategies own approved markets and product policy.
- Providers advertise capabilities and coverage.
- Prompts compose shared, sport, strategy, and analysis sections.
- Maturity is explicit: MLB beta, soccer experimental, tennis/NFL/NCAAF planned.

Hypothesis: the fifth and tenth sport can be added without rewriting shared event, pricing, API, persistence, or prompt infrastructure.

## 2026-07-26 — MLB v2.1: value-first decisions

Reason: Early scouting disproportionately selected favorites because ranking emphasized matchup strength rather than price error.

Changes:

- Made fair probability, fair price, implied probability, and EV explicit.
- Added Best Underdog and public/sharp flags.
- Preserved approved MLB markets: ML, starting-pitcher K props, or No Bet.
- Required complete matchup, lineup, bullpen, and market audits.

Hypothesis: improve CLV and ROI, reduce overpriced favorites, and increase disciplined no-bet decisions.

## 2026-07-26 — Local-first six-hour MVP

Reason: Core product progress should not require provider or LLM API keys.

Decision: ship deterministic edge evaluation and a fixture-backed UI first. External ingestion and AI synthesis remain adapters behind explicit contracts and stop when secrets or provider access are missing.
