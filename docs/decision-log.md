# Decision Log

## 2026-07-29 — CDK starts resource-free

Reason: Infrastructure structure can be validated without creating cloud resources, requiring credentials, or implying deployment authorization.

Decision: the foundation stack uses a bootstrapless synthesizer, disables analytics metadata, contains no resources, has environment-aware naming, and exposes synth but no deploy command. The empty-template validation warning is explicitly acknowledged with its rationale.

Hypothesis: later infrastructure stories can add isolated stacks safely while synthesis remains deterministic and non-chargeable.

## 2026-07-29 — Configuration is profile-scoped

Reason: Requiring future provider or AWS variables during fixture-only development would make optional adapters feel mandatory and encourage unsafe placeholder secrets.

Decision: validation is explicit at each package startup boundary and uses `local`, `provider`, or `aws` profiles. Local mode has safe non-secret defaults; provider and AWS variables become required only when those profiles are selected. Validation failures expose structured issue codes and variable names.

Hypothesis: local development stays zero-secret while misconfigured adapters fail immediately and readably.

## 2026-07-29 — Enforced package dependency direction

Reason: Naming package boundaries does not prevent domain, provider, persistence, and frontend responsibilities from coupling over time.

Decision: declare an allowlist for every workspace package, validate workspace manifest edges in `pnpm check`, and test representative forbidden edges. Production packages cannot depend on `test-utils`; domain remains dependency-free; UI cannot import auth implementations, providers, database, or infrastructure.

Hypothesis: architecture violations fail locally before they become cross-package refactors.

## 2026-07-29 — Consensus quality and fixture publication

Reason: A consensus price is not trustworthy if it includes the offered book or silently absorbs stale, suspended, sparse, or materially divergent inputs.

Decision:

- Normalize each comparison book to no-vig probabilities before weighting.
- Exclude the offered sportsbook unconditionally.
- Exclude stale, suspended, invalid, and outlier books with explicit reasons.
- Mark consensus unavailable when the remaining independent market is sparse.
- Let registered module metadata and strategy registration drive fixture UI.
- Publish fixture recommendations only for non-planned modules; fixture recommendations remain No Bet because no live evidence is present.

Hypothesis: market-quality failures stay visible and adding a planned sport cannot accidentally create a recommendation.

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
