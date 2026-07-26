# Product Philosophy

FIND THE EDGE is a private betting decision-support system. Its job is to identify positive expected value, explain the evidence, and make passing easy. It is not a picks feed, a guarantee engine, or a substitute for bankroll discipline.

## Principles

1. Price matters more than picking the likely winner.
2. Deterministic code owns odds conversion, fair price, EV, qualification, and result grading.
3. AI may synthesize verified inputs, but may not invent facts or override deterministic calculations.
4. Every recommendation must be reproducible from versioned inputs and rules.
5. Missing, stale, partial, conflicting, or unavailable data is explicit.
6. Confidence and EV are separate signals.
7. A no-bet decision is a successful product outcome.
8. Closing-line value and long-run ROI matter more than short-run win rate.

## Product boundaries

- No automatic bet placement.
- No claims of certainty.
- No recommendation without a market price.
- No secret-dependent core logic.
- New sports use their own versioned market and scouting contracts.

The BMAD Product Brief, PRD, architecture, and UX specification remain the planning baseline. The sport rules and model contracts in `docs/frameworks`, `models`, and `prompts` are the canonical behavioral source of truth.
