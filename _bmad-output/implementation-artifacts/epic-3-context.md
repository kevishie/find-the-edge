# Epic 3 Context: Sports Catalog and Event Ingestion

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Establish the canonical, provider-independent event catalog and the ingestion-to-UI path that lets an authenticated user browse trustworthy upcoming sporting events. The epic begins with the soccer delivery slice and The Odds API, while preserving the binding multi-sport architecture: shared storage, APIs, and screens use registered sport and league configuration so MLB and future sport modules can participate without core rewrites.

## Stories

- Story FTE-013: Soccer Domain Models and Event Lifecycle
- Story FTE-014: The Odds API Adapter Foundation and Request Logging
- Story FTE-015: Upcoming Soccer Event Ingestion Worker
- Story FTE-016: Event Repository, API, and Pagination
- Story FTE-017: Event Status and Data Freshness Indicators
- Story FTE-018: Events Explorer Screen
- Story FTE-019: Spike - Initial Soccer Competitions Allowlist

## Requirements & Constraints

- Represent canonical sports, leagues or competitions, participants, events, lifecycle status, kickoff changes, and provider mappings without embedding sport-specific fields in shared entities. Sport-specific details belong to versioned module-owned payloads.
- Ingest upcoming events that have betting-market coverage. Preserve source provider, provider entity identity, provider timestamp when available, collection timestamp, verification status, freshness, confidence, and a retained raw-data reference when audit needs require it.
- Treat canonical IDs as primary identity and provider IDs as aliases. Detect duplicates, preserve provider labels and aliases, retain kickoff-change history, and model postponement or cancellation as status changes rather than deletion. Ambiguous automatic matches remain unresolved instead of being merged speculatively.
- Make ingestion idempotent for equivalent provider inputs. Older provider data must not overwrite newer canonical state. Provider errors, partial responses, rate limits, quota exhaustion, and normalization failures must be classified and observable without exposing credentials.
- Restrict production ingestion to a human-approved competition allowlist. Provider coverage, target-sportsbook availability, schedule density, quota cost, and future enrichment coverage inform that decision.
- Provide authenticated list and detail APIs for upcoming events with combined date, sport, competition, status, and watchlist filters. List responses include opaque cursor pagination, raw ISO timestamps, display-ready timezone metadata, event status, coverage, freshness, and missing-data reasons.
- Normal reads must use keys or indexes rather than table scans. Core read surfaces may show cached data during provider outages only with explicit freshness or unavailable status.
- The explorer must distinguish no source data, provider failure, and filters with no matches. Missing coverage or facts are unavailable, never inferred or presented as verified.
- Event browsing must remain responsive at private-MVP scale, expose safe retryable errors, meet WCAG 2.1 AA interaction patterns, and support keyboard-accessible filters, sortable tables, pagination, rows, and actions.

## Technical Decisions

- Shared domain, storage keys, generic routes, and explorer behavior use stable `sportKey`, league or competition, event, and participant identifiers. Sport behavior and terminology come from registered, versioned `SportModule` metadata; shared code does not branch on a specific sport.
- Provider integration is capability-based. Adapters declare supported sports, leagues, markets, rate limits, freshness, and quality, and keep provider DTOs inside provider packages. Application services consume normalized provider results.
- DynamoDB is the operational store. Canonical events, competition links, provider mappings, unresolved or manual mapping records, and provider health live in the core table. Upcoming-event access uses purpose-built keys or GSIs ordered by kickoff; conditional writes protect event freshness and identity integrity.
- Provider mappings record match method, confidence, timestamps, normalized identity, and override state. Manual overrides supersede automatic matches and are audit logged.
- API inputs and outputs are schema validated and use a consistent envelope containing `data`, `error`, `requestId`, and optional page metadata. Cursors encode DynamoDB continuation state and remain opaque to clients.
- Event ingestion runs as an asynchronous worker suitable for scheduled and manual invocation. Structured logs include correlation and provider request IDs, endpoint, latency, quota metadata, and created, updated, skipped, and failed counts. Secrets remain server-side and are never logged.
- All API routes require authenticated user context. The platform uses the AWS serverless direction, including Lambda, API Gateway HTTP API, DynamoDB, EventBridge Scheduler, Secrets Manager, and CloudWatch.
- Contract, unit, repository, API, fixture-backed integration, UI component, and route-level end-to-end tests cover provider isolation, lifecycle changes, idempotency, pagination, filters, error states, and accessibility-critical behavior.

## UX & Interaction Patterns

Use a dense, sortable table for desktop comparison and responsive cards or drill-in views for smaller screens. Provide date navigation plus sport, competition, search, watchlist, scouted-state, and event-status filters; filters combine. Rows prioritize event participants, kickoff in the configured timezone (Eastern Time by default), lifecycle status, target-book and comparison coverage, report and lineup readiness, freshness, and gated Scout/Watchlist actions. Loading uses layout-matched skeletons. Stale, partial, unavailable, postponed, cancelled, started, and final states use explicit text or icons as well as color. Freshness appears as a badge with timestamp and explanatory tooltip. Tables may scroll horizontally rather than shrinking below readable sizes; mobile surfaces retain event status and primary actions while moving secondary fields into detail views.

## Cross-Story Dependencies

The shared package foundation precedes canonical event models. Provider adapter work depends on those models and configuration support. The ingestion worker depends on canonical models, the adapter, and the approved competition allowlist; its normalized records feed the repository and API. Status and freshness semantics extend API responses, and the Events Explorer depends on the application shell plus the repository/API and status work. Downstream odds ingestion, scouting, watchlists, reports, recommendations, and bets all rely on the canonical event identity established here. Binding multi-sport foundation work applies before legacy soccer-specific implementation wherever shared domain, provider, storage, API, or UI behavior is involved.
