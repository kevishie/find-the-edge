# Epic 4 Context: Odds Ingestion and Market Normalization

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn provider betting data into trustworthy, auditable price evidence by normalizing bookmakers, markets, and selections, preserving every accepted retrieval as immutable history, maintaining freshness-safe current projections, handling provider limitations explicitly, and giving the user a clear comparison and movement view. This epic supplies the canonical odds inputs required by later consensus, +EV qualification, scouting provenance, CLV, and performance analysis.

## Stories

- Story FTE-020: Bookmaker, Market, and Selection Normalization
- Story FTE-021: Immutable Odds Snapshot Persistence and Current Projection
- Story FTE-022: DynamoDB Streams Projection Workflow
- Story FTE-023: Featured and Event-Specific Odds Ingestion
- Story FTE-024: Provider Quota, Retry, DLQ, and Suspended/Partial States
- Story FTE-025: Event Detail Odds Comparison
- Story FTE-026: Odds History API and Chart

## Requirements & Constraints

- Map provider bookmaker identifiers to stable canonical bookmakers. The target sportsbook and comparison roster are configurable rather than embedded in shared domain logic. Unknown books may be retained for audit but cannot enter consensus silently.
- Normalize Moneyline, Three-Way Moneyline, Spread, Totals, Both Teams to Score, and Team Totals when available. Unsupported or malformed bookmakers, markets, selections, and prices require explicit reason codes and cannot become active opportunities.
- Every accepted retrieval creates append-only odds snapshots. Store a collection timestamp always and a provider timestamp when supplied; mark an absent provider timestamp unavailable rather than inferring it.
- Duplicate and retried retrievals must be idempotent. Older evidence cannot replace a newer current projection, and malformed odds cannot be persisted as valid prices.
- Missing target-book coverage must be explicit per event, market, and selection and disqualifies comparisons that require it. Stale, suspended, unavailable, and incomplete markets remain distinguishable, visible where useful, and excluded from active qualification.
- Collection must use capability- and entitlement-matched providers, enabled sports and competitions, supported markets, adaptive polling, and bounded quota. Rate limits, quota exhaustion, network failures, malformed responses, and partial responses require distinct safe outcomes; valid partial data may be retained without implying completeness.
- The initial comparison policy uses the approved independent comparison-book set and requires at least three eligible contributors. Coverage gaps fail closed rather than silently weakening the minimum-book gate.
- Provider credentials remain server-side, errors must not expose secrets, and raw provider payloads must not be logged verbatim. Operational signals cover request usage, quota, retries, snapshots, duplicates, stale or partial data, projection lag, failures, and DLQ depth.
- Odds history is derived only from stored snapshots. Do not synthesize pre-launch history, infer a missing opening price, or attribute movement to causes such as sharp or public action without verified evidence.
- Immutable MVP snapshots have no TTL. Any future destructive retention or archival policy must preserve reconstruction of historical calculation and CLV inputs.

## Technical Decisions

- Use capability-based provider interfaces and canonical sport, league, event, participant, bookmaker, market, and selection identities. Provider-specific DTOs stay inside adapter boundaries; normalized results carry source, freshness, confidence, and raw-reference provenance where required.
- Keep operational odds in a purpose-built DynamoDB table. Snapshot records are immutable; current prices are mutable projections keyed by event, market, selection, and bookmaker; history and bookmaker-event indexes support comparison and movement reads.
- Derive snapshot identity from provider and provider-event identity, bookmaker, market, selection, price, timestamps, and a bounded collection bucket or response hash. Conditional writes reject duplicates.
- Current projections accept only evidence at least as new as the stored collection timestamp. Projection handling must be replay-safe and idempotent. DynamoDB Streams is the preferred projection path so normal updates, deduplication, and rebuilds share one workflow; unrecoverable records route to a DLQ.
- Preserve snapshot references and content-hash provenance needed to reproduce downstream calculations. Derived consensus records include their algorithm version and input-snapshot hash.
- Polling becomes more frequent near kickoff but remains bounded. Deduplicate requests by sport, event, market set, and polling window; retry transient failures with jitter and pause non-critical work when quota protection activates.
- Odds conversion, implied probability, movement, consensus, fair odds, EV, and qualification remain deterministic and outside React, infrastructure adapters, provider DTOs, persistence mappers, and LLM output.

## UX & Interaction Patterns

Event Detail emphasizes the configured target sportsbook while showing comparison books, best price, freshness, and market state in compact market groups or tables. Missing coverage uses an unavailable state rather than a guessed value. Stale, partial, suspended, provider-unavailable, and quota-low states include text, timestamps, and recoverable guidance; color is never their only indicator. Provider and collection timestamps are available through progressive disclosure.

Odds history shows opening price when known, current price, timestamped movement, stale gaps, and suspended intervals. It must support sparse histories and explicit loading, empty, error, and partial-data states. Charts require a text alternative and underlying data table, and responsive layouts preserve market, selection, sportsbook identity, price, and status rather than compressing away essential context.

## Cross-Story Dependencies

FTE-020 depends on canonical event and provider foundations plus the approved comparison policy. FTE-021 follows stable canonical identities; FTE-022 builds the replayable projection path on that persistence contract. FTE-023 requires event ingestion and snapshot persistence, while FTE-024 hardens its provider and failure paths. FTE-025 consumes normalized current odds in Event Detail; FTE-026 adds stored history and depends on deterministic odds conversion from FTE-027. Opportunity, scouting, settlement, and performance work consume this epic's immutable evidence and projections without redefining their provenance or state semantics.
