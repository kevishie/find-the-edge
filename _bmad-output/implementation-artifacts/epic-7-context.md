# Epic 7 Context: Manual Scouting Workflow

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver an authenticated, manually triggered scouting workflow that turns provider-backed evidence, deterministic betting analysis, and constrained AI synthesis into an auditable, versioned report. The first detailed implementation is the experimental soccer module, but job, provider, storage, API, prompt, and evaluation contracts must remain sport-agnostic so additional registered sport modules do not require core rewrites. The workflow must make uncertainty and a valid no-bet outcome explicit; scheduled automatic scouting remains outside this epic.

## Stories

- Story FTE-038: Scout Event API, Idempotent Job Model, SQS, and Step Functions
- Story FTE-039: Spike - Soccer Enrichment Provider Evaluation
- Story FTE-040: Provider-Backed Scouting Input Contract and Development Stub
- Story FTE-041: AI Report Provider Interface and Structured Report Schema
- Story FTE-042: Report Persistence, Versioning, and Source Provenance
- Story FTE-043: Scouting Progress UI and Retry States
- Story FTE-044: Scouting Report Screen, Versions, Sources, and PASS State

## Requirements & Constraints

- Scout Event is available only for eligible events and creates a traceable asynchronous job. Equivalent active requests must converge on the existing job; retryable failures create linked attempts, while terminal failures explain what must change.
- Persist queued, active, completed, retryable-failure, and terminal-failure lifecycle states. The UI may expose finer progress such as collecting data, generating the report, calculating edges, and partial data without leaking infrastructure terminology.
- Sportmonks is only the provisional primary for a bounded, non-production soccer trial across MLS, EPL, Liga MX, and UCL. Production enrichment stays disabled until separately authorized credentials, acceptable written usage and retention rights, and the defined coverage, freshness, correctness, reliability, provenance, and cost gates pass. API-Football is not a production option under the current evaluation.
- Development fixtures must be clearly marked non-production and contain no secrets or restricted payloads. Every normalized fact must preserve source provider, provider entity and timestamp when available, collection time, verification status, freshness, confidence, and a contract-permitted evidence reference.
- Missing, malformed, unlicensed, stale, inferred, or conflicting data must never become a verified fact. Partial provider data may produce a report only when unavailable states and provenance remain explicit.
- The soccer report schema keeps all fourteen required sections in stable order, from Match Snapshot through Nuke or Pass; missing sections remain visible as unavailable. Other sports supply their own versioned scouting categories and schemas through registered modules.
- Provider facts, deterministic calculations, and AI interpretation are separate responsibilities. AI may summarize verified inputs and explain tactical or risk themes, but it must not invent facts or authoritatively calculate odds conversion, probability, no-vig consensus, fair price, EV, Kelly sizing, qualification, CLV, or data freshness.
- Each completed run creates an immutable report version. Preserve the exact input and source references, associated odds snapshots, generation time, sport/module/strategy/calculation versions, model and prompt-bundle versions, validation result, and changes from the prior version when available.
- PASS or No Bet is a successful outcome, not a failure. Provider outages, quota exhaustion, stale evidence, and partial responses must remain visible and must not yield a misleading active recommendation.
- Jobs, reports, and source details are private and authenticated. Errors and logs must be safe for display and must not expose credentials, restricted provider data, prompts, or sensitive inputs.

## Technical Decisions

- Buffer scouting commands with SQS and orchestrate collection, deterministic analysis, AI generation, contract validation, persistence, and failure handling with Step Functions. Correlation and scouting-job identifiers flow across API, queue, workflow, and worker boundaries; a DLQ captures exhausted work.
- Keep shared records, routes, orchestration, and prompts keyed by stable `sportKey` and versioned module/strategy identifiers. Sport-specific fields and the soccer section schema belong to the sport module; shared code must not branch directly on sport.
- Resolve providers by capability rather than vendor. Provider DTOs and IDs stay inside adapters, and normalized contracts expose declared sport/competition coverage, freshness, rate limits, quality, provenance, and explicit unavailable states.
- SharpAPI remains authoritative for canonical schedules and odds. Soccer enrichment maps to an existing canonical event; discrepancies enter reconciliation and cannot silently create, delete, reschedule, change participants, or reprice the event.
- Use DynamoDB conditional writes for active-job idempotency and immutable version insertion. Store report heads separately from historical versions; use private S3 pointers and content hashes only when payload size or contract-permitted evidence retention requires them.
- Structured AI output must validate against the module-owned report contract before persistence. Authoritative market fields are references to deterministic domain outputs, not values recomputed by the AI or frontend.
- Emit structured, redacted operational signals for state transitions, duplicates, retries, validation failures, provider latency/quota, workflow failures, and queue/DLQ health. Use protected APIs, strict boundary validation, least-privilege IAM, encrypted storage and queues, and sanitized report/source rendering.

## UX & Interaction Patterns

- Scout Event opens or redirects to a dedicated progress surface. User-facing states distinguish queued, collecting, generating, calculating, complete, failed, partial data, and retry available; repeated requests open the active job.
- Reports provide sticky, collapsible section navigation, a version selector, change indicators, citations, collection timestamps, confidence, freshness and verification badges, structured verdicts, and a prominent calm PASS state.
- Provenance uses progressive disclosure: summaries show concise status, freshness, and confidence, while expansion reveals source, provider and collection timestamps, verification, evidence, and unavailable facts.
- Loading, empty, stale, provider-unavailable, error, and partial-data states are visually and semantically distinct. Status never relies on color alone, and keyboard access and live status messaging follow WCAG 2.1 AA patterns.

## Cross-Story Dependencies

- The job/API foundation depends on the existing event and infrastructure foundations and unlocks the progress UI without waiting for production enrichment or final report content.
- The provider evaluation gates production enrichment. Its provisional trial decision informs the normalized input contract, while the fixture-backed stub allows schema and workflow development before production authorization.
- The normalized input contract and deterministic market-analysis outputs gate the AI report interface. Validated report output then gates immutable persistence and version retrieval.
- Progress UI and report persistence can proceed independently after their respective foundations, but both are required before the final report surface can expose status, versions, sources, partial data, and PASS behavior.
