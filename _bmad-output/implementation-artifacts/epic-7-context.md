# Epic 7 Context: Manual Scouting Workflow

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver a private, soccer-first workflow that lets the user manually scout a selected event, follow durable progress through completion or failure, and review an auditable, versioned report. The workflow must turn provider-backed facts and deterministic betting analysis into disciplined decision support without inventing missing information, hiding uncertainty, or implying that automatic scouting is active in the MVP.

## Stories

- Story FTE-038: Scout Event API, Idempotent Job Model, SQS, and Step Functions
- Story FTE-039: Spike - Soccer Enrichment Provider Evaluation
- Story FTE-040: Provider-Backed Scouting Input Contract and Development Stub
- Story FTE-041: AI Report Provider Interface and Structured Report Schema
- Story FTE-042: Report Persistence, Versioning, and Source Provenance
- Story FTE-043: Scouting Progress UI and Retry States
- Story FTE-044: Scouting Report Screen, Versions, Sources, and PASS State

## Requirements & Constraints

- Scouting is manually initiated from an eligible event. Fully automated schedules remain post-MVP and future-facing settings must not imply otherwise.
- Every request creates a traceable job. Equivalent active work must converge instead of duplicating, and repeated clicks must return or open the existing job.
- Durable states must distinguish queued, active, completed, retryable failure, and terminal failure. A permitted retry creates a linked attempt; a non-retryable failure explains what must change.
- The production soccer enrichment provider remains unresolved until a human-approved evaluation covers data coverage, freshness, quotas, pricing, licensing, provenance, historical depth, and integration risk. Development fixtures must be unmistakably non-production.
- Every factual input must carry enough metadata to audit its provider or source, provider timestamp when available, collection time, verification status, freshness, confidence, and unavailability. Malformed, stale, conflicting, inferred, and unavailable inputs must remain distinguishable.
- Reports use a stable fourteen-section order from Match Snapshot through Nuke or Pass. Missing information remains visible as unavailable rather than disappearing.
- Provider-backed facts, deterministic calculations, and AI-assisted interpretation are separate responsibilities. AI may synthesize verified inputs but must not invent facts or authoritatively calculate odds, probability, EV, Kelly sizing, or CLV.
- Each completed run creates a new immutable report version with generation time, input and source references, associated odds snapshots, model and prompt versions, and change metadata when available. Historical versions and provenance remain readable after source data changes.
- PASS or no qualified edge is a valid successful result. Partial data must never be presented as a complete report or confident recommendation.
- All scouting jobs and reports require authentication. User-visible errors are safe, provider payloads and credentials are not exposed, and prohibited promotional language is avoided.

## Technical Decisions

- Buffer scouting commands with SQS and orchestrate work with Standard Step Functions so provider calls, deterministic analysis, AI generation, validation, persistence, failure handling, and retries have isolated, visible boundaries.
- Keep DynamoDB as the primary operational store. Use idempotent conditional writes for active work and append-oriented records for attempts and report history; re-scouting after materially changed inputs creates a new version instead of mutating history.
- Place unresolved data providers behind adapters that return normalized domain contracts. Provider DTOs must not leak into scouting, report, or UI models, and adapters require contract validation.
- Keep authoritative betting calculations in the deterministic domain. Structured AI output must validate against the report contract, cite normalized source references, preserve unavailable states, and record model and prompt versions before persistence.
- Carry correlation and scouting job identifiers through API and worker logs. Monitor workflow success and failure, queue and DLQ health, provider latency and quota state, while redacting secrets and sensitive inputs.
- Use Cognito-protected APIs, strict boundary validation, least-privilege IAM, encrypted AWS storage and queues, and sanitized rendering for report content and source links.

## UX & Interaction Patterns

- Scout Event creates or opens a dedicated progress surface. Labels describe user work such as collecting data, generating the report, and calculating edges rather than exposing AWS service terminology.
- Progress and report surfaces explicitly represent queued, running, complete, failed, partial-data, and retry-available states. Errors use safe guidance; stale or partial states identify missing evidence without overstating certainty.
- Reports provide sticky, collapsible section navigation, a version selector, change indicators, citations, timestamps, data warnings, confidence, and verification badges.
- Provenance uses progressive disclosure: default views show concise freshness and confidence, while tooltips, row expansion, or a source drawer reveal provider timestamp, collection timestamp, source, verification, and unavailable facts.
- PASS is calm and prominent, not styled as failure, and should explain that fresh data did not meet qualification thresholds.

## Cross-Story Dependencies

- The durable job contract depends on the existing event repository and infrastructure foundation. It enables the progress UI independently of production enrichment or final report content.
- Provider evaluation gates the production input contract. The input contract then gates the AI interface and report schema; report validation gates immutable persistence.
- Report persistence and progress UI can advance in parallel after their respective job and schema foundations, but both are required before the final report screen can expose versions, sources, and PASS.
- Deterministic market-analysis work is a prerequisite for report fields that display odds-derived conclusions; the AI layer consumes those outputs rather than replacing them.
