# Epic 0A Context: Multi-Sport Feed and Result Spine

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Establish a reusable, capability-aware acquisition and truth-data spine that imports upcoming events, accumulates immutable pregame odds, and records authoritative completed-event results across sports. The epic must make MLB and soccer work through the same contracts while allowing additional leagues and providers to be enabled through registration, so reliable historical evidence begins accumulating before prediction tuning, paper-pick evaluation, or broad UI work.

## Stories

- Story FTE-DATA-001: Feed Coverage Registry and League Allowlist
- Story FTE-DATA-002: Checkpointed Upcoming-Event Ingestion Orchestrator
- Story FTE-DATA-003: Multi-Sport Odds Collection Policy and Snapshot Jobs
- Story FTE-DATA-003B: SharpAPI Redundant Odds and Betting Splits
- Story FTE-DATA-003C: Production Odds Collection Control Plane
- Story FTE-DATA-004: Completed-Event Result Ingestion and Correction History

## Requirements & Constraints

- Every enabled league must explicitly resolve schedule, odds, and results capabilities, including provider coverage, supported markets, maturity, refresh cadence, allowlist state, quota expectations, and a reason when coverage is unavailable. MLB and MLS must resolve working capabilities; tennis, NFL, NBA, international soccer, and later sports must be representable as planned or enabled without orchestration changes.
- Upcoming-event ingestion must use durable cursors or checkpoints, canonical/provider identity mapping, and idempotent event upserts. Checkpoints advance only after durable writes; replaying a page must be safe; rescheduled and cancelled events retain identity and history; failure in one league must not discard progress for others.
- Fixture-backed MLB and soccer adapters must exercise the shared ingestion contract locally without paid APIs. Initial event and result backfills are bounded per enabled league.
- Odds collection must support scheduled and manual jobs governed by sport/league policy. It must normalize two-way moneyline, three-way moneyline, and spread selections through registered market contracts, retain provider and retrieval timestamps, and preserve offered-book and comparison-book prices.
- Odds evidence is immutable. Retries must not duplicate snapshots, later prices must not overwrite historical evidence, and unsupported, stale, suspended, partial, or out-of-order market states must remain explicit. No synthetic history may be created for periods before activation.
- A configurable secondary odds provider may provide bounded failover and public-betting evidence, but sources must never be silently blended or cause a sportsbook exposed by both aggregators to be weighted twice. Cross-provider event mappings must be exact; provider-derived EV is not authoritative local truth.
- Betting-ticket and money/handle split observations must preserve independent source and retrieval timestamps, optional percentages, immutable history, and a non-regressing current projection. Missing entitlement must degrade only the public-betting capability. SharpAPI activation, account contracts, and paid-plan changes require explicit approval; fixture-backed integration and deployable infrastructure may be completed while activation remains disabled.
- Completed-event polling must normalize final scores and official outcome states, including regulation/overtime scope and postponed, cancelled, and no-contest states. Repeated finals are idempotent; corrections append versions instead of rewriting history; unknown provider mappings remain unresolved rather than creating duplicate events.
- Provider credentials, commercial terms, and licensed raw payloads must not reach clients or logs. Raw payload logging must be redacted, and correction history must be append-only.
- Runs must expose actionable league-level telemetry: provider requests, quota, duration, checkpoints, created/updated/skipped events, snapshot counts, freshness and market gaps, finalized/corrected/unresolved results, job lag, and failure reasons.
- Live betting, player props, sportsbook placement, prediction logic, pick generation, grading rules, and performance aggregation are outside this epic.

## Technical Decisions

- Shared records and workflows use stable `sportKey`, league, event, participant, market, and provider identifiers. Sport-specific event or result detail belongs in versioned module-owned payloads; shared orchestration must not branch on a sport key.
- Provider integration is capability-specific. Schedule, odds, public-betting, and results adapters declare supported sports, leagues, markets, rate limits, expected freshness, and quality; orchestration resolves an adapter through registered coverage. Provider DTOs remain inside provider packages and are translated into normalized domain inputs.
- Canonical events use provider mapping records rather than names as identity. Mapping data preserves provider IDs and labels, normalized identity, confidence/match method, timestamps, and overrides. Event upserts use version or timestamp checks so older payloads cannot replace newer canonical state.
- Use the serverless worker model: scheduler-ready commands flow through SQS workers, with retries using exponential backoff and jitter, exhausted jobs sent to a DLQ, and league/provider failures isolated. Production schedule activation is not required by this epic.
- DynamoDB remains the operational store. Core event, mapping, run, result, and provider-health records are separate from immutable odds snapshots. Odds writes use deterministic identity/content hashes and conditional writes; current-price projections are timestamp-aware and idempotent, preferably maintained from DynamoDB Streams.
- Infrastructure and application boundaries remain explicit: workers compose domain, providers, database, config, and observability packages; domain code does not depend on AWS, provider DTOs, or persistence implementations. CDK owns queues, DLQs, workers, schedules, tables, streams, and archival resources.
- Production odds collection uses a frequent scheduler tick behind a dedicated FIFO queue, while the versioned per-league policy decides whether calls are due. Schedule discovery and odds refresh are separate durable runs; paid response pages are sealed before normalization so retries can repair persistence without repeating provider calls.
- SharpAPI is primary and The Odds API is an independently budgeted fallback. Fallback is allowed only before any primary evidence page commits, and shared sportsbook observations retain provenance while configured consensus selection prevents double-weighting.
- Tests must cover provider contracts and fixture integrations, including duplicate and replay behavior, partial failure, checkpoint resume, schedule changes, stale/suspended/out-of-order odds and splits, exact cross-provider mappings, primary/secondary outage and recovery, entitlement denial, delayed finals, corrections, and unmapped results. Infrastructure tests must verify separate secret and IAM handling for the optional secondary provider.

## Cross-Story Dependencies

FTE-DATA-001 depends on the sport-agnostic domain/registry and capability-based provider ports. FTE-DATA-002 consumes that coverage registry and the base CDK skeleton, and establishes canonical events and mappings needed by later stories. FTE-DATA-003 additionally depends on generic weighted-consensus market states. FTE-DATA-003B builds on the registry, event mappings, primary odds pipeline, provider ports, and consensus safeguards; its production activation has a human approval gate. FTE-DATA-003C supplies the durable production control plane and completes/supersedes the blocked DATA-003/003A execution outcomes. FTE-DATA-004 depends on the event ingestion identity spine. The immutable odds, split evidence, and authoritative results produced here are prerequisites for reproducible paper picks, automated grading, CLV, cohort evaluation, and strategy-learning workflows in subsequent epics.
