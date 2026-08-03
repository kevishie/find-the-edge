---
title: 'FTE-DATA-003B SharpAPI Redundant Odds and Betting Splits'
type: 'feature'
created: '2026-08-02T00:00:00-04:00'
status: 'ready-for-dev'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003-multi-sport-odds-collection-policy-and-snapshot-jobs.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003a-durable-odds-provider-page-recovery.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-live-the-odds-api-games-and-odds.md'
---

# Story FTE-DATA-003B: SharpAPI Redundant Odds and Betting Splits

Status: ready-for-dev

## Story

As the operator of FIND THE EDGE,
I want SharpAPI integrated as a second odds provider with betting-split ingestion,
so that odds collection can survive a primary-provider outage and analysis can use timestamped public bet and money percentages that The Odds API does not supply.

## Acceptance Criteria

1. **Provider registration and capability resolution**
   - Given SharpAPI is configured, when provider coverage is resolved, then SharpAPI advertises `odds` and `public-betting` independently for each supported sport, league, and market; unverified coverage remains disabled with an explicit reason.
   - The existing `ProviderDescriptor`, coverage registry, and capability-based ports are extended rather than replaced. The Odds API remains registered and working.

2. **Strict SharpAPI adapter**
   - Given a valid SharpAPI response, when it is ingested, then provider event IDs, league, participants, start time, sportsbook, market, selection, point, American odds, provider timestamp, retrieval timestamp, and pagination/continuation metadata are validated and normalized into existing provider-neutral contracts.
   - Malformed, oversized, duplicate, ambiguous, unsupported, or internally inconsistent payload units fail closed without publishing a partial complete market. API keys, credential-bearing URLs, and raw licensed responses never enter logs or client responses.
   - Authentication, timeout, rate-limit, 4xx, 5xx, malformed-response, and plan/feature-entitlement failures map to stable redacted error codes with retryability declared explicitly.

3. **Provider-independent identity and immutable evidence**
   - Given the same real-world event arrives from both providers, when SharpAPI data is stored, then it binds through an exact provider-event-to-canonical-event mapping and never matches solely by display labels.
   - SharpAPI snapshots retain `providerId = sharpapi`; deterministic snapshot identity includes provider provenance so same-provider replay deduplicates while observations from different providers remain separately auditable.
   - Existing immutable-history and monotonic-current rules remain intact. No SharpAPI field overwrites The Odds API evidence, and no derived SharpAPI +EV/no-vig value replaces FIND THE EDGE's deterministic calculations.

4. **Explicit redundancy policy**
   - Given both providers are healthy, when a collection window runs, then the configured policy chooses which provider supplies current odds and whether the other runs in validation/shadow mode; it does not silently blend or double-count books shared by both feeds.
   - Given the selected odds provider is unavailable, rate-limited, exhausted, or missing required coverage, when failover is allowed, then the job tries the configured secondary provider within its own quota/cadence budget and records the failover reason, attempted providers, and winning source.
   - Given neither provider can supply a complete eligible market, then prior valid current data is retained and the event/market is marked stale, partial, or unavailable rather than fabricated.
   - Provider priority, failover eligibility, health thresholds, cooldown/recovery, league/market coverage, and quota reserves are deployment configuration, not hard-coded UI behavior. Automatic failback requires a configured health threshold to avoid provider flapping.

5. **Betting-split ingestion (SharpAPI Pro entitlement)**
   - Given the account is entitled to Betting Splits, when split data is returned, then the system stores an immutable observation for each canonical event/market/selection containing every source field the API actually provides, including bet/ticket percentage and money/handle percentage when available, provider timestamp, retrieval timestamp, source/provider, market/selection identity, and sample/count metadata when supplied.
   - Percentages are finite and constrained to `[0, 100]`; complementary selections are not forced to sum to 100 unless the documented SharpAPI contract guarantees the same population and timestamp. Missing ticket or money percentages remain missing, never inferred.
   - Split observations are joined to exact canonical event and normalized selection identities. Ambiguous event, participant, line, market, or scope mapping is persisted as an explicit gap and is excluded from analysis.
   - Odds and split timestamps may differ and remain separate. A split is stale according to a configurable split-specific freshness threshold and never inherits freshness from an odds quote.
   - Split history is append-only and replay-safe. Current split projections advance only by a deterministic authority order; later retrieval of older source data cannot regress current state.

6. **Entitlement and graceful degradation**
   - Given the API key lacks Pro split access, when odds ingestion runs, then SharpAPI odds can still operate if entitled while `public-betting` reports `not-entitled`; the whole provider is not marked unhealthy solely because split access is absent.
   - Production activation is blocked until the paid plan, licensing/retention terms, exact split endpoint/schema, supported leagues/markets/books, update cadence, and redistribution constraints are verified against the subscribed account and captured in fixtures/runbook configuration.
   - Purchasing or upgrading the SharpAPI plan and enabling production polling require explicit operator approval; story implementation must not perform either action.

7. **Observability, operations, and tests**
   - Run telemetry exposes provider attempts, selected source, failover/failback reason, latency, rate-limit/quota state, normalized odds count, split count, split freshness, mapping gaps, and entitlement failures by league without secrets or raw payloads.
   - Synthetic contract fixtures and automated tests cover two-way and three-way moneylines, spreads/totals where enabled, pagination, replay, cross-provider event mapping, shared-book deduplication policy, primary outage, secondary outage, rate limiting, failover cooldown, recovery/failback, missing split fields, invalid percentages, stale/out-of-order splits, plan denial, and persistence parity.
   - `pnpm check` and `pnpm synth` pass; infrastructure synthesis proves a separate SharpAPI secret, least-privilege access, independent provider configuration, disabled-by-default activation, and provider health alarms.

## Tasks / Subtasks

- [ ] Confirm the subscribed SharpAPI contract and freeze fixtures (AC: 2, 5, 6)
  - [ ] Verify the official REST endpoint(s), authentication header, pagination, rate-limit headers, odds schema, split schema, supported MLB/MLS markets, sportsbook IDs (including Hard Rock), timestamp semantics, and Pro entitlements against the account/API reference.
  - [ ] Record licensing, storage, retention, derived-use, and display constraints. Store only synthetic/redacted fixtures in Git.
  - [ ] Treat SharpAPI marketing claims as discovery input, not an executable contract; do not guess undocumented fields.

- [ ] Extend provider-neutral contracts and configuration (AC: 1, 4, 5)
  - [ ] Reuse `ProviderCapability` values `odds` and `public-betting`; add split observation/port types only where current contracts cannot express source, scope, timestamps, and optional percentages/counts.
  - [ ] Add exact SharpAPI coverage plus provider selection/failover policy, independent cadence/quota reserve, split freshness, health/cooldown, and disabled-by-default activation validation.

- [ ] Implement and test the SharpAPI adapter (AC: 2, 6)
  - [ ] Add strict bounded wire parsing and normalized output under `packages/providers`; prefer the existing HTTP/runtime pattern unless the official SDK provides a material, verified advantage.
  - [ ] Keep secret injection at the worker boundary and classify entitlement separately from provider health.

- [ ] Add canonical mapping and provider orchestration (AC: 3, 4)
  - [ ] Extend the existing schedule-first live ingestion path; preserve exact canonical bindings and schedule-before-odds behavior.
  - [ ] Implement deterministic primary/secondary selection, shadow validation, failover, cooldown, and failback without cross-provider double counting.

- [ ] Persist split evidence and current projections (AC: 5)
  - [ ] Add provider-neutral split repository contracts plus memory/Dynamo implementations using append-only snapshots, deterministic replay identities, canonical fences, and monotonic current writes.
  - [ ] Keep odds snapshots and split observations independently timestamped and queryable; do not embed mutable split values into historical odds records.

- [ ] Provision and document operations (AC: 6, 7)
  - [ ] Add a separately named Secrets Manager secret/reference for SharpAPI, narrow IAM grants, provider-specific configuration, metrics, and alarms. Keep production activation disabled until approval and contract verification.
  - [ ] Update the operations guide with key rotation, entitlement checks, quota behavior, manual canary, failover/failback, rollback, and stale-split handling.

- [ ] Complete automated verification (AC: 1-7)
  - [ ] Add adapter, orchestration, persistence, infrastructure, and end-to-end fixture tests for every scenario listed in AC 7.
  - [ ] Run `pnpm check`, `pnpm synth`, and focused provider/worker/database tests. A live canary is optional and must be explicitly authorized because it consumes an external service and may require a paid plan.

## Dev Notes

### Current State and Required Preservation

- `packages/providers/src/index.ts` already defines capability-scoped provider descriptors and includes `public-betting`. Extend this contract; do not introduce a parallel provider registry.
- `packages/providers/src/the-odds-api.ts` is the current strict HTTP/parser reference for MLB and MLS. It bounds payloads, normalizes named outcomes, classifies failures, and records quota headers. Preserve it as an independent adapter.
- `apps/workers/src/live-odds-ingestion.ts` currently owns schedule-first canonical ingestion, adaptive league cadence, quota reserve, exact canonical binding, and price persistence. Generalize this service around provider selection without weakening those safeguards.
- `packages/database/src/fixture-odds-adapter.ts` provides immutable snapshot and monotonic-current behavior despite its legacy fixture name. Reuse/generalize its transition kernel; do not create a weaker SharpAPI-specific store.
- `infra/cdk/src/foundation.ts` currently imports The Odds API secret, grants runtime-only access, runs a single-concurrency live worker, and schedules a 15-minute tick. Add separate SharpAPI secret/configuration and preserve least privilege and disabled-by-default activation.
- The working tree contains user-owned changes in these areas. Re-read them immediately before implementation and merge around them; do not discard or overwrite them.

### Architecture Guardrails

- Provider observations are evidence, not truth. Preserve provider provenance and deterministic local math.
- Separate four concerns: provider wire DTOs, normalized odds, normalized split evidence, and provider-selection policy.
- Cross-provider reconciliation must use durable provider mappings plus canonical event/participant identities. Labels may support diagnostics only.
- A sportsbook appearing through two aggregators is still one comparison book for consensus. Downstream consensus must choose one configured observation per book/market/time window or retain both as provenance without double weighting.
- Never expose provider secrets, raw licensed payloads, commercial terms, or unsupported analytics to the browser/logs.
- No backfill is implied. Evidence begins at the verified SharpAPI activation time; historical endpoints or data purchases are out of scope.

### Expected File Map

- UPDATE: `packages/providers/src/index.ts`, `coverage-registry.ts`, `the-odds-api.ts` only if shared contracts require it; preserve The Odds API behavior.
- NEW: `packages/providers/src/sharp-api.ts` and synthetic fixtures/tests.
- UPDATE: `packages/domain/src/index.ts` for provider-neutral split evidence contracts.
- UPDATE: `apps/workers/src/live-odds-ingestion.ts`, its tests, and the Lambda composition boundary for provider policy and separate credentials.
- UPDATE/NEW: `packages/database/src/fixture-odds-adapter.ts` or a clearly generalized odds repository plus split repository implementations/tests.
- UPDATE: `infra/cdk/src/foundation.ts`, infrastructure tests, deployment configuration, and operations documentation.

### Testing Requirements

- Use exact wire fixtures captured from the verified account contract and converted to synthetic/redacted data.
- Contract tests must prove both adapters independently satisfy the same normalized odds invariants.
- Persistence tests must prove exact replay, conflicting replay rejection, cross-provider provenance, older observation retention, current non-regression, and Dynamo/memory parity.
- Failover tests must use deterministic clocks and injected adapters; no network dependency in the default test suite.
- Security tests must scan synthesized output/log fixtures for both providers' key material and credential-bearing URLs.

### Latest External Information (verify again at implementation)

- SharpAPI's public pricing page currently lists Betting Splits on the Pro plan at $229/month, 300 requests/minute, and 15 sportsbooks. It also describes separate add-ons and plan-dependent live access; these commercial details can change and must remain configuration/approval inputs.
- Public product material describes REST access at `https://api.sharpapi.io`, `X-API-Key` authentication, a TypeScript SDK, and moneyline/spread/total coverage. The public pages do not establish a sufficiently precise split wire contract for implementation, so account-level API reference verification is a blocking task.

### References

- [Source: `_bmad-output/planning-artifacts/epics-and-stories.md` — FTE-SPORT-003, FTE-DATA-001, FTE-DATA-003]
- [Source: `_bmad-output/planning-artifacts/architecture.md` — provider abstraction, ingestion, security, and DynamoDB guidance]
- [Source: `_bmad-output/planning-artifacts/prd.md` — FR-LOOP-002, FR-012, provider health and immutable odds requirements]
- [Source: `_bmad-output/implementation-artifacts/spec-live-the-odds-api-games-and-odds.md`]
- [Source: `packages/providers/src/index.ts`, `packages/providers/src/the-odds-api.ts`]
- [Source: `apps/workers/src/live-odds-ingestion.ts`]
- [Source: `packages/database/src/fixture-odds-adapter.ts`]
- [SharpAPI pricing](https://sharpapi.io/pricing)
- [SharpAPI betting odds overview](https://sharpapi.io/features/betting-odds-api)

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- SharpAPI's exact Betting Splits endpoint/schema is intentionally a verification gate because public pricing confirms the feature but public marketing pages do not define its complete wire contract.

### File List
