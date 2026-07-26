# Prioritized Task Queue

## P0 — Six-hour MVP

1. `FTE-001` — Monorepo and TypeScript quality foundation.
2. `FTE-003/027/029` slice — Pure deterministic odds conversion, fair price, EV, and qualification reason codes.
3. `FTE-002/036` slice — Responsive fixture-backed Edge Lab/Dashboard that separates EV from confidence and supports No Bet.
4. `FTE-004` slice — Unit and browser smoke coverage for calculations and the main decision flow.
5. Local developer documentation and CI-equivalent quality command.

## P1 — Data contracts

1. MLB game, lineup, starter, bullpen, market, and evidence schemas.
2. Two- and three-way weighted no-vig consensus with stale/suspended/outlier states.
3. Opportunity persistence port and local fixture adapter.
4. Versioned scout input/output validation.

## P2 — External adapters

1. Approve providers, data rights, quotas, and cost ceilings.
2. Implement odds and MLB data adapters with request logging and fixture recording.
3. Add scheduled ingestion only after secrets and spend limits are approved.
4. Add optional LLM report synthesis behind a manual trigger and token budget.

## P3 — Operational product

Authentication, AWS infrastructure, immutable persistence, lineup refresh, bet tracker, grading/CLV, evaluation dashboard, and production release gates.
