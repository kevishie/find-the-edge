# Epic 3 Context: Sports Catalog and Event Ingestion

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Establish a trustworthy, provider-independent sports event catalog and the ingestion-to-UI path for browsing upcoming events. The initial delivery slice is soccer event discovery through The Odds API, while the binding multi-sport model keeps shared identity, storage, APIs, and screens reusable for additional registered sports without core rewrites.

## Stories

- Story FTE-013: Soccer Domain Models and Event Lifecycle
- Story FTE-014: The Odds API Adapter Foundation and Request Logging
- Story FTE-015: Upcoming Soccer Event Ingestion Worker
- Story FTE-016: Event Repository, API, and Pagination
- Story FTE-017: Event Status and Data Freshness Indicators
- Story FTE-018: Events Explorer Screen
- Story FTE-019: Spike - Initial Soccer Competitions Allowlist

## Requirements & Constraints

- Represent canonical sports, competitions, participants, events, provider mappings, lifecycle states, kickoff changes, postponements, and cancellations. Canonical identity must not depend on a provider ID alone, and lifecycle changes update an event rather than delete it.
- Ingest upcoming events that have betting-market coverage. Equivalent provider payloads must be idempotent; changed kickoff or status data must safely update the canonical event, and unsupported sports must be ignored.
- Keep provider DTOs isolated behind adapter contracts. API credentials remain server-side and must never appear in logs or browser data. Provider calls expose safe error classifications, request correlation, latency, and quota metadata.
- Limit production ingestion to an approved competition allowlist. Provider coverage, target-book availability, schedule density, quota cost, and future enrichment coverage inform that list.
- Provide list and detail APIs with combined date, sport, competition, status, and watchlist filters. Responses include raw ISO timestamps, Eastern Time display metadata, lifecycle status, coverage, freshness, missing-data reasons, and opaque cursor pagination.
- Normal event reads use purpose-built keys or indexes rather than table scans. Cached data may remain visible during provider failure only with explicit stale or unavailable status.
- Never present missing, stale, partial, postponed, cancelled, or unavailable data as verified. Missing bookmaker or market coverage is unavailable, not inferred.
- The explorer must distinguish source data being unavailable from valid data that has no filter matches. Errors surface as safe, retryable states rather than blank screens.
- Event browsing must remain responsive at private-MVP scale and follow WCAG 2.1 AA patterns for forms, tables, navigation, keyboard access, focus, contrast, and status messaging.

## Technical Decisions

- Shared domain entities, storage keys, routes, and explorer behavior use stable sport, competition, participant, and event identifiers. Sport terminology and behavior come from registered, versioned module metadata; shared surfaces do not branch on a specific sport.
- Provider integrations are capability-based and declare supported sports, leagues, markets, rate limits, expected freshness, and quality. Application services consume normalized provider results rather than provider-native DTOs.
- DynamoDB stores canonical events, provider mappings, competition relationships, and provider health in the core table. Upcoming-event access uses kickoff-ordered keys or GSIs; conditional writes protect freshness and identity integrity.
- Duplicate provider events resolve to one internal event only when confidence is sufficient. Ambiguous matches remain separate and flagged. Mappings preserve match method, confidence, timestamps, normalized identity, and override state.
- Event list endpoints accept a limit and return encoded DynamoDB continuation state as an opaque cursor. API clients validate consistent response envelopes outside React components.
- The frontend uses router search state for event filters, query keys based on stable filter tuples, and table state only for transient presentation. TanStack Table is the intended dense desktop implementation.
- Event ingestion runs asynchronously and supports scheduled and manual execution. Structured telemetry includes correlation and provider request IDs plus created, updated, skipped, failed, quota, and latency signals.
- Automated coverage spans lifecycle and identity rules, provider fixtures and redaction, worker idempotency, repository access and cursor behavior, API serialization, filter and empty states, accessibility-critical UI behavior, and a route-level browser smoke test.

## UX & Interaction Patterns

Use a dense, sortable table as the primary desktop explorer and responsive full-width cards or drill-in views on smaller screens. Provide date navigation plus sport (soccer-locked for the initial slice), competition, search, watchlist, scouted/unscouted, and event-status filters that combine correctly. Rows prioritize participants, Eastern Time kickoff, lifecycle status, Hard Rock availability, comparison-book coverage, report and lineup status, freshness, and gated Scout Event and Watchlist actions. Show Open Report when a completed report exists.

Loading uses layout-matched skeletons. Empty states explain whether no data exists or no events match the active filters. Partial and stale states list missing fields or timestamps; provider failure offers safe retry guidance. Status never relies on color alone. Tables use semantic headers, labelled sortable controls and row actions, visible focus, readable text, and horizontal scrolling instead of excessive compression. Mobile retains event status and primary actions while moving secondary columns into detail views.

## Cross-Story Dependencies

Canonical event models precede provider integration. The ingestion worker depends on those models, the provider adapter, and the approved competition allowlist; its normalized records feed the repository and APIs. Freshness and lifecycle semantics extend those responses. The Events Explorer depends on the application shell, list/detail APIs, and status mapping, while real Scout Event and Watchlist mutations remain gated until their later epics are ready. Downstream odds, scouting, watchlists, reports, recommendations, and bets all rely on the canonical event identity established here.
