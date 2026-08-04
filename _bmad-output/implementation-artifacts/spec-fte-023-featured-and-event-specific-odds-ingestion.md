---
title: 'Featured and Event-Specific Odds Ingestion'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'f84ba41'
final_revision: '6f9f5a7'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-022-dynamodb-streams-projection-workflow.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Production odds ingestion uses only SharpAPI's league-wide `market=main` request for MLB and MLS. It cannot target a known event, does not cover the approved soccer competitions, ignores the provider's suspended-market signal, and lacks endpoint/market/quota evidence. Broad repeated scans therefore spend quota inefficiently and cannot distinguish a valid partial snapshot from a provider or entitlement gap.

**Approach:** Make SharpAPI the sole production schedule and odds source. Add capability-driven featured and event-specific request plans using the documented league snapshot and event-odds endpoints. Use canonical provider league IDs discovered from the SharpAPI catalog, stable cursor paging for league scans, durable request deduplication, explicit partial/gap outcomes, and immutable FTE-021 persistence.

## Boundaries & Constraints

**Always:** Use only SharpAPI in production; preserve provider event IDs and canonical league slugs; request prematch main markets for featured scans; use event-specific odds when a known event needs a focused refresh; normalize only valid supported MVP markets; retain valid sibling rows when other rows or books are missing; persist explicit reason-coded gaps; honor `Retry-After`/provider retry timestamps without consuming duplicate calls; include endpoint mode, requested market set, league, quota state, partial state, snapshot outcome, and bounded failure reason in metrics.

**Block If:** A league slug is not confirmed by SharpAPI's catalog; an event-specific request has no canonical provider event ID; the response lacks a trustworthy provider timestamp; deduplication ownership cannot be acquired; quota exhaustion would require an immediate paid retry; a change would fabricate suspended prices or silently substitute another provider.

**Never:** Call The Odds API from production code; fuzzy-map provider leagues or events; use offset paging for multi-page live scans; archive raw paid-provider payloads; discard a whole response because one row, market, or sportsbook is invalid; promote suspended/closed prices as actionable current odds; overwrite immutable history; log credentials or raw payloads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Featured scan | Approved league and `main` market set | Cursor-page prematch odds and persist valid immutable snapshots | Deduplicate by provider/league/mode/markets/window |
| Focused refresh | Known SharpAPI event ID | Fetch `/events/{eventId}/odds` once and persist supported rows | Reject missing/mismatched event identity before writes |
| Partial response | Valid rows mixed with malformed, absent-book, or unsupported rows | Persist valid siblings and explicit gaps | Partial metric and bounded reason counts |
| Suspended market | Valid row has `is_active=false` | Preserve evidence as unavailable/suspended, never actionable current price | Reason-coded market gap/state |
| Rate limited | SharpAPI returns 429 plus retry timing | Stop paging, retain retry state safely, retry only after provider window | No immediate retry storm or duplicate paid call |
| Missing Hard Rock | Event has other allowed books but no Hard Rock rows | Persist comparison evidence and explicit target-book gap | Snapshot remains valid and partial |
| Duplicate trigger | Same request identity and polling window repeats | Existing owner/result wins; no second provider call | Dedup metric, successful no-op |

</intent-contract>

## Code Map

- `packages/sports/src/soccer/definition.ts` -- approved soccer leagues and exact SharpAPI catalog identities.
- `packages/providers/src/sharp-api.ts` -- league snapshot and event-specific request construction, cursor paging, response/rate-limit parsing and normalization.
- `apps/workers/src/sharp-api-ingestion.ts` -- immutable persistence and explicit partial-gap handling.
- `apps/workers/src/production-odds-control-plane.ts` -- featured versus focused cadence/dispatch decisions without provider fallback.
- `packages/database/src/fixture-odds-adapter.ts` -- immutable snapshot/current persistence and explicit gap records.
- `infra/cdk/src/foundation.ts` -- SharpAPI-only runtime configuration, schedules, retry/DLQ controls, and alarms.
- `docs/phase1-deployment.md` -- provider contract, quota behavior, operational verification, and rollback.

## Tasks & Acceptance

**Execution:**
- [x] Add exact SharpAPI catalog-backed runtime descriptors for MLS, England Premier League, Liga MX, and UEFA Champions League; reject unknown/fuzzy aliases.
- [x] Add typed SharpAPI featured (`GET /odds`, `market=main`, `is_live=false`, cursor paging) and focused (`GET /events/{eventId}/odds`) operations with bounded pages, request metadata, and 429 retry parsing.
- [x] Extend normalization for provider `is_active`, main/alternate markers, supported full-game market types, valid partial siblings, missing Hard Rock, and reason-coded rejected rows/groups.
- [x] Introduce durable request identity containing provider, league, endpoint mode, canonical event ID when focused, sorted market set, and polling window; prove duplicate triggers do not issue duplicate provider calls.
- [x] Persist valid immutable snapshots plus explicit gaps through FTE-021/FTE-022 ordering without raw payload storage or alternate-provider fallback.
- [x] Emit bounded metrics for endpoint mode, league, market set, request/dedup/quota, rows/groups accepted/rejected, snapshots created/advanced/retained, partial outcomes, and retryable failures.
- [x] Add fixtures/tests for full success, multi-page cursor scans, event-specific refresh, partial rows, suspended market, 429 timing, missing Hard Rock, malformed timestamps, mismatched event identity, duplicate trigger, and provider-only production configuration.
- [x] Update deployment documentation and environment smoke to prove SharpAPI-only featured and focused ingestion with real current evidence.

**Acceptance Criteria:**
- Given an approved league featured trigger, when ingestion runs, then SharpAPI alone is queried with stable cursor pagination and valid main-market snapshots are persisted once per durable request window.
- Given a known provider event requiring a focused refresh, when ingestion runs, then the documented event-odds endpoint is called once, only matching-event rows are accepted, and valid supported markets advance through the canonical immutable projection ordering.
- Given partial, suspended, unsupported, or missing-Hard-Rock evidence, when normalization completes, then valid siblings remain visible while explicit non-actionable gaps and bounded partial metrics explain what is absent.
- Given a 429 response, when retry metadata is present, then no immediate repeat call occurs and the retry is delayed until the provider window without losing already persisted valid pages.
- Given production synthesis and runtime inspection, when provider configuration is checked, then no The Odds API secret, environment variable, adapter path, request, or fallback is reachable.

## Review Triage Log

### 2026-08-04 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 12 (high 8, medium 4, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - Distinguished quota/cooldown blocking from true duplicate attempts and return a retryable outcome without a provider call.
  - Moved focused attempt success after all snapshots and gaps persist; failures remain durably failed.
  - Persisted SharpAPI `retryAt` as provider cooldown so later polling windows cannot call early.
  - Made malformed supported rows and absent `is_active` row-local, conservative rejections while retaining valid siblings.
  - Validated every focused raw row's event and league identity, rejected empty/mixed payloads, and raised the focused-only bound to 5,000 rows.
  - Required an existing exact event/league binding before spending a focused provider call.
  - Added focused snapshot/current/partial/rejection metrics and included polling-window duration in request identity.
  - Routed the default featured production path through the typed featured operation and proved unambiguous Draw fallback across soccer leagues.

## Design Notes

SharpAPI documents `GET /api/v1/odds` with comma-separated `market`, `event_id`, `is_live`, and cursor filters, plus `GET /api/v1/events/{eventId}/odds` for an unpaginated all-book event snapshot. The focused endpoint cannot filter books or markets, so normalization must enforce the MVP allowlist locally. Canonical soccer IDs come from `/leagues`; runtime descriptors may cache verified IDs, but discovery/validation remains fail-closed. `is_active=false` means suspended or closed and must not be exposed as an actionable price. The Odds API adapter may remain only as inert historical code until a later cleanup, but production imports/configuration/tests must prove it is unreachable.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm phase1:preflight`
- `pnpm check`
- hosted Phase 1 environment smoke and browser verification

## Dev Agent Record

### Implementation Plan

Extend the existing SharpAPI boundary rather than introduce another provider abstraction. Keep league-wide collection on the proven cursor control plane, add a separately invokable focused path that shares immutable persistence and durable quota attempts, and make exact catalog identities the only runtime allowlist.

### Completion Notes

- Added exact SharpAPI identities for MLB, MLS, EPL, Liga MX, and UEFA Champions League and expanded the sport and production collection registries without fuzzy aliases.
- Added typed featured and focused operations, prematch/main query constraints, bounded response parsing, focused identity validation, suspension evidence, and provider-directed `Retry-After` parsing.
- Added a focused Lambda invocation and deterministic request identity over provider, league, endpoint, event, sorted markets, and polling window. Atomic quota-attempt reservation makes duplicate triggers successful no-ops without a second paid call.
- Reused FTE-021 immutable persistence and explicit gap storage. Suspended prices cannot become current; valid siblings remain persistable; missing Hard Rock and malformed/unsupported rows remain reason coded.
- Added endpoint/market/quota/partial/failure dimensions and operational documentation. Production still exposes only the SharpAPI secret and has no alternate-provider fallback.
- Review hardening distinguishes quota blocking from deduplication, commits success only after persistence, retains provider cooldown, validates focused event/league binding, handles malformed rows locally, fails closed on ambiguous activity, and completes endpoint-specific observability.
- Verification passed: providers 57 tests, workers 149 tests, sports 17 tests, config 58 tests, infrastructure 8 tests, credential-free Phase 1 preflight, full `pnpm check`, and `git diff --check`.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-023-featured-and-event-specific-odds-ingestion.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/workers/src/live-odds-lambda.test.ts`
- `apps/workers/src/live-odds-lambda.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/sharp-api-ingestion.test.ts`
- `apps/workers/src/sharp-api-ingestion.ts`
- `docs/phase1-deployment.md`
- `packages/config/src/feed-coverage.test.ts`
- `packages/config/src/feed-coverage.ts`
- `packages/providers/src/sharp-api.test.ts`
- `packages/providers/src/sharp-api.ts`
- `packages/sports/src/soccer/definition.ts`

## Change Log

- 2026-08-04: Created implementation-ready SharpAPI-only FTE-023 contract from official endpoint and schema documentation.
- 2026-08-04: Implemented and fully verified SharpAPI featured and focused event odds ingestion; moved story to review.

## Auto Run Result

Implemented SharpAPI-only featured and focused event odds ingestion across five exact league descriptors. Featured scans use prematch main markets with cursor pagination; focused refreshes use the documented event endpoint, exact pre-existing event/league binding, durable quota-aware request identity, conservative suspension handling, partial sibling persistence, explicit target-book gaps, and immutable snapshot projection.

Changed the SharpAPI provider boundary and tests, worker orchestration and tests, league/config registries, operational documentation, sprint tracker, and this story record. Adversarial review produced 12 implementation patches (8 high, 4 medium), with no deferred or rejected items. Follow-up review remains recommended because the patches affect paid-request ownership, durable success state, rate-limit cooldown, data identity, and partial normalization.

Verification passed: providers 57 tests, workers 149 tests, sports 17 tests, config 58 tests, infrastructure 8 tests, credential-free Phase 1 preflight, full `pnpm check`, and `git diff --check`.

Residual risk: live environment schedule ingestion still reports `schedule-provider-error` for MLB and MLS after successful infrastructure deployment; this is outside the focused-odds implementation and remains the immediate deployment follow-up.
