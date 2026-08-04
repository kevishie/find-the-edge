# Epic 4 Context: Odds Ingestion and Market Normalization

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn provider betting data into trustworthy, auditable price evidence: normalize bookmakers, markets, and selections; preserve every accepted retrieval as immutable history; maintain freshness-safe current projections; collect supported markets within entitlement and quota limits; expose degraded states honestly; and let the user compare the configured target sportsbook with independent comparison books and inspect line movement. This epic produces the canonical odds inputs required by consensus, +EV qualification, scouting provenance, CLV, and later performance analysis.

## Stories

- Story FTE-020: Bookmaker, Market, and Selection Normalization
- Story FTE-021: Immutable Odds Snapshot Persistence and Current Projection
- Story FTE-022: DynamoDB Streams Projection Workflow
- Story FTE-023: Featured and Event-Specific Odds Ingestion
- Story FTE-024: Provider Quota, Retry, DLQ, and Suspended/Partial States
- Story FTE-025: Event Detail Odds Comparison
- Story FTE-026: Odds History API and Chart

## Requirements & Constraints

- Map provider bookmaker identifiers to stable canonical bookmakers. The target sportsbook and comparison roster are configuration, not domain constants. Unknown books may be retained for audit but cannot enter consensus silently.
- Normalize Moneyline, Three-Way Moneyline, Spread, Totals, Both Teams to Score, and Team Totals when available. Unsupported or malformed bookmakers, markets, selections, and prices require explicit reason codes and cannot become active opportunities.
- Every accepted retrieval creates append-only odds snapshots. Later prices create new records rather than mutating history. Store Collection Timestamp always and Provider Timestamp when supplied; mark a missing provider timestamp unavailable.
- Duplicate and retried retrievals must be idempotent. Older or duplicate evidence cannot overwrite a newer current projection, and malformed odds cannot be persisted as valid prices.
- Missing target-book coverage is explicit per event, market, and selection and disqualifies comparisons that require it. Stale, suspended, unavailable, and incomplete markets remain distinguishable, visible where useful, and excluded from active qualification.
- Production collection uses capability- and entitlement-matched providers, approved competitions, supported markets, adaptive polling, and bounded quota. Rate limits, quota exhaustion, network failure, malformed responses, and partial responses require distinct safe outcomes; valid partial data may be retained without implying completeness.
- The accepted MVP consensus policy evaluates Hard Rock offers against Pro-entitled DraftKings, FanDuel, BetMGM, and Caesars, with at least three eligible comparisons. Circa and Pinnacle odds are not dependencies under the Pro entitlement. Provider coverage gaps fail closed rather than weakening the book gate.
- Provider credentials remain server-side, errors must not expose secrets, and raw provider payloads are not logged verbatim. Operational signals cover requests, quota, retries, snapshots, duplicates, stale or partial data, projection lag, failures, and DLQ depth.
- Odds history comes only from stored snapshots. Do not synthesize pre-launch history, infer a missing opening price, or make causal claims such as sharp action or steam without verified supporting data.
- Immutable MVP snapshots receive no TTL. A future destructive retention or archival policy requires a new evidence-backed decision and must preserve reconstruction of historical calculations and CLV inputs.

## Technical Decisions

- Use capability-based provider boundaries and canonical sport, league, event, participant, bookmaker, market, and selection identifiers. Provider DTOs do not leak into domain calculations or UI contracts.
- Keep operational odds in the purpose-built odds table. Snapshot records are immutable; current prices are mutable projections keyed by event, market, selection, and bookmaker; market-history and bookmaker-event indexes support history and coverage reads.
- Derive snapshot identity from provider and provider-event identity, bookmaker, market, selection, price, timestamps, and a bounded collection bucket or response hash. Conditional writes reject duplicates.
- A current projection accepts only data whose Collection Timestamp is at least as new as the stored value. Projection handling is replay-safe and idempotent. DynamoDB Streams is the preferred projection path so rebuild, deduplication, and normal updates share one workflow; unrecoverable records route to a DLQ.
- Preserve snapshot references and content-hash provenance needed to reconstruct calculation inputs. Derived consensus records carry the algorithm version and input-snapshot hash.
- Adaptive polling increases near kickoff but remains bounded. Deduplicate provider requests by sport, event, market set, and polling window; retry transient failures with jitter and stop non-critical calls when quota protection activates.
- Odds conversion, implied probability, movement, consensus, fair odds, EV, and qualification math stay deterministic and outside React, AWS adapters, provider DTOs, persistence mappers, and LLM output.

## UX & Interaction Patterns

Event detail emphasizes the configured target sportsbook while showing comparison books, best price, freshness, and market state. Use market groups or tabs with compact bookmaker rows or cells. Missing coverage uses an unavailable state rather than a guessed value. Surface stale, partial, suspended, provider-unavailable, and quota-low states with timestamps and recoverable guidance; progressive disclosure may reveal provider and collection timestamps.

Odds history shows opening price when known, current price, timestamped movement, stale gaps, and suspended intervals. It must work with sparse histories and explicit empty, loading, error, and partial-data states. Responsive layouts preserve market, selection, sportsbook identity, price, and status. Color is not the sole carrier of freshness, suspension, or movement meaning.

## Cross-Story Dependencies

FTE-020 depends on canonical event/provider foundations and the now-resolved consensus policy. FTE-021 follows stable canonical identities; FTE-022 builds the replayable projection path on that persistence contract. FTE-023 requires event ingestion plus snapshots, and FTE-024 hardens its provider and failure paths. FTE-025 consumes normalized current odds through event detail; FTE-026 adds stored history and depends on deterministic odds conversion from FTE-027. Opportunity, scouting, bet-settlement, and performance stories consume this epic's immutable evidence and projections without redefining their provenance or state semantics.
