# Epic 4 Context: Odds Ingestion and Market Normalization

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn provider betting data into a deterministic, auditable odds system: canonicalize bookmakers, markets, and selections; preserve every valid retrieval as immutable history; maintain safe current-price projections; collect enabled markets within provider limits; expose degraded data honestly; and let the user compare the target sportsbook with configured comparison books and inspect line movement. This epic supplies the trusted price inputs required by consensus, +EV qualification, scouting provenance, CLV, and later performance analysis.

## Stories

- Story FTE-020: Bookmaker, Market, and Selection Normalization
- Story FTE-021: Immutable Odds Snapshot Persistence and Current Projection
- Story FTE-022: DynamoDB Streams Projection Workflow
- Story FTE-023: Featured and Event-Specific Odds Ingestion
- Story FTE-024: Provider Quota, Retry, DLQ, and Suspended/Partial States
- Story FTE-025: Event Detail Odds Comparison
- Story FTE-026: Odds History API and Chart

## Requirements & Constraints

- Map provider bookmaker identifiers to stable canonical bookmakers. Identify the target sportsbook consistently, keep comparison-book configuration auditable, and never allow unknown books to enter consensus silently.
- Normalize Moneyline, Three-Way Moneyline, Spread, Totals, Both Teams to Score, and Team Totals when available. Unsupported or malformed bookmakers, markets, selections, and prices require explicit reason codes and cannot become active opportunities.
- Every accepted retrieval creates append-only odds snapshots. Later prices create new records; they do not mutate audit history. Store Collection Timestamp always and Provider Timestamp when supplied, marking a missing provider timestamp unavailable.
- Duplicate or retried retrievals must be idempotent. Older or duplicate data cannot overwrite a newer current projection, and malformed odds cannot be persisted as valid prices.
- Missing target-book coverage is explicit per event, market, and selection and disqualifies comparisons that require it. Stale, suspended, unavailable, and incomplete markets remain distinguishable, visible where useful, and excluded from active qualification.
- Odds collection is bounded by enabled competitions, markets, adaptive polling, and provider quota. Rate limits, quota exhaustion, network failures, malformed responses, and partial responses require distinct safe outcomes; valid partial data may be retained without implying completeness.
- Provider API keys remain server-side, provider failures must not expose secrets, and raw provider payloads are not logged verbatim. Operational signals cover requests, quota, retries, snapshot writes, duplicates, stale/partial data, projection lag, failures, and DLQ depth.
- Odds history must come only from stored snapshots. Do not synthesize pre-launch history, infer a missing opening price, or make causal claims such as sharp action or steam without verified supporting data.
- Normal reads use keyed DynamoDB access patterns and opaque pagination; table scans are not an application access pattern. Immutable snapshot retention remains unresolved, so MVP snapshots must not receive a destructive TTL by default.

## Technical Decisions

- Use the capability-based provider boundary and canonical sport, league, event, participant, bookmaker, market, and selection identifiers. Provider DTOs do not leak into domain calculations or UI contracts.
- Keep operational odds in the purpose-built odds table. Snapshot records are immutable; current prices are mutable projections keyed by event, market, selection, and bookmaker; market-history and bookmaker-event indexes support history and coverage reads.
- Derive snapshot identity from provider and provider-event identity, bookmaker, market, selection, price, timestamps, and a bounded collection bucket or response hash. Conditional snapshot writes reject duplicates.
- A current projection accepts only data whose Collection Timestamp is at least as new as the stored value. Projection handling is replay-safe and idempotent. DynamoDB Streams is the preferred projection path so rebuild, deduplication, and normal updates share one workflow; unrecoverable stream records route to a DLQ.
- Preserve enough snapshot and content-hash provenance to reconstruct calculation inputs and later CLV. Derived consensus records must carry their algorithm version and input-snapshot hash.
- Odds format conversion, implied probability, movement, consensus, fair odds, EV, and related qualification math stay deterministic and outside React, AWS adapters, provider DTOs, persistence mappers, and LLM output.

## UX & Interaction Patterns

- Event detail emphasizes the target sportsbook while showing comparison books, best price, freshness, and market state. Missing coverage uses an unavailable state rather than a guessed value.
- Use market groups or tabs and compact bookmaker rows/cells. Surface stale, partial, suspended, provider-unavailable, and quota-low states with timestamps and recoverable guidance; progressive disclosure may reveal provider and collection timestamps.
- Odds history shows opening price when known, current price, timestamped movement, stale gaps, and suspended intervals. It must work with sparse histories and use explicit empty, loading, error, and partial-data states.
- Responsive layouts preserve market, selection, sportsbook identity, price, and state; visual color is not the sole carrier of freshness or suspension meaning.

## Cross-Story Dependencies

- FTE-020 depends on canonical event/provider foundations and the consensus-default decision in FTE-032. FTE-021 cannot be finalized until FTE-020 defines stable canonical identities.
- FTE-022 builds on FTE-021 and the deployed AWS/CDK foundation. FTE-023 requires both event ingestion and snapshot persistence; FTE-024 hardens the FTE-023 collection path.
- FTE-025 requires the event read/detail path plus FTE-020/FTE-021 canonical current odds. FTE-026 then adds history and also depends on deterministic odds conversion from FTE-027.
- The completed competition-allowlist spike and deterministic odds conversion reduce downstream uncertainty, but the backlog still lists the event/provider foundation and FTE-032 as unfinished prerequisites. Resolve whether existing implemented provider, snapshot, control-plane, and market-board capabilities satisfy or supersede those legacy stories before adding parallel models or storage paths.
