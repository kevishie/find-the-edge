---
title: 'Provider Quota, Retry, DLQ, and Suspended/Partial States'
type: 'feature'
created: '2026-08-04'
status: 'in-review'
baseline_revision: 'f11fdba'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-023-featured-and-event-specific-odds-ingestion.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Provider failures are partly classified and infrastructure has a DLQ, but rate-limit capacity is misrepresented as durable quota, retry ownership is inconsistent, provider health lacks actionable state, and newer suspension/partial evidence can leave an older current price appearing actionable.

**Approach:** Introduce one SharpAPI-only provider outcome contract spanning authoritative rate windows, bounded retry decisions, durable health, queue routing, and monotonic market availability. Preserve immutable price history while making current reads and recommendation inputs fail closed whenever newer evidence is suspended, closed, incomplete, missing, or unavailable.

## Boundaries & Constraints

**Always:** Distinguish rate-limit window from optional plan quota; use authoritative headers/timestamps when present and `unknown` otherwise; classify rate-limit/network failures as transient and authentication/entitlement/configuration/malformed/coverage failures as terminal; cap attempts and backoff with bounded jitter; preserve paid-call deduplication and ambiguous-response reconciliation; persist bounded provider health and latest availability; retain valid partial siblings; emit low-cardinality metrics and reason codes; route exhausted retryable commands to the existing odds DLQ.

**Block If:** SharpAPI does not expose enough evidence to distinguish a value; a retry would duplicate an ambiguous paid request; market-state identity cannot be tied exactly to event/book/market/selection or group; implementation would require deleting/mutating immutable snapshots or weakening target-book/market completeness gates.

**Never:** Treat requests-per-minute as subscription quota remaining; retry unauthorized, not-entitled, malformed, coverage-missing, or configuration failures; silently acknowledge a command that still requires retry; expose old CURRENT odds as actionable after newer unavailable evidence; TTL snapshots, gaps, runs, or audit history; log secrets/raw payloads; restore The Odds API fallback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Rate window | Limit/remaining/reset headers | Store typed window and reserve only within it | Reset atomically; unknown stays explicit |
| Transient failure | 429 or unambiguous network failure | Retry after provider time or capped backoff+jitter | Exhaustion throws for SQS/DLQ |
| Terminal failure | Auth, entitlement, malformed, config, coverage | Record unavailable health and acknowledge terminally | No quota-burning retry |
| Ambiguous call | Request may have reached provider | Reconcile durable attempt/page before another call | Never blindly repeat |
| Suspension | Newer exact selection/group unavailable evidence | Old price remains history but is excluded from CURRENT/actionability | Resume only on newer valid active evidence |
| Partial payload | Valid and invalid sibling rows | Persist valid siblings plus exact availability gaps | Group completeness still fails closed |

</intent-contract>

## Code Map

- `packages/providers/src/sharp-api.ts` -- typed response metadata, provider errors, retry timing, and row states.
- `packages/database/src/odds-control-plane.ts` -- atomic attempts, rate windows, health TTL/state, continuations, and availability projection.
- `packages/database/src/fixture-odds-adapter.ts` -- current/history reads gated by latest availability evidence.
- `apps/workers/src/odds-control-plane.ts` -- pure failure/retry decision and bounded attempt policy.
- `apps/workers/src/production-odds-control-plane.ts` -- consistent featured/focused/schedule/account/splits health and retry application.
- `apps/workers/src/live-odds-lambda.ts` -- explicit acknowledge/retry routing for SQS commands.
- `infra/cdk/src/foundation.ts` -- odds queue/DLQ, visibility/redrive, metrics, and alarms.
- `docs/runbooks/sharpapi.md` and `docs/phase1-deployment.md` -- operational interpretation and redrive procedure.

## Tasks & Acceptance

**Execution:**
- [x] `packages/providers/src/sharp-api.ts` and tests -- capture bounded rate-limit headers/reset and provider retry timing without fabricating plan quota; keep row-local partial normalization.
- [x] `packages/database/src/odds-control-plane.ts` and tests -- model typed provider health/rate window, atomic window reservation/reset, bounded failure/success state, retry time, and TTL only for transient health records.
- [x] `packages/domain/src/fixture-odds.ts`, database projection/read adapters, and tests -- persist monotonic latest selection/group availability and suppress older active CURRENT evidence until newer valid active evidence resumes it.
- [x] `apps/workers/src/odds-control-plane.ts` and tests -- define one retry matrix with terminal/transient/ambiguous classes, capped attempts, provider-directed delay, bounded jitter, and exact exhaustion result.
- [x] `apps/workers/src/production-odds-control-plane.ts` and tests -- apply rate, health, retry, partial, and suspension decisions consistently across every SharpAPI operation; success heals health without erasing audit evidence.
- [x] `apps/workers/src/live-odds-lambda.ts` and tests -- make SQS acknowledge/retry behavior explicit so dedup never swallows required retry and exhausted transient work reaches DLQ.
- [x] `infra/cdk/src/foundation.ts` and tests -- prove redrive/max receive/visibility plus low-cardinality quota, retry, provider-health, suspended/partial, failure, and DLQ alarms.
- [x] Runbooks and deployment smoke -- document reason matrix, cooldown/window reset, safe redrive, health TTL, and proof that provider failures cannot create active recommendations.

**Acceptance Criteria:**
- Given provider rate metadata or its absence, when requests reserve capacity concurrently, then the current window resets atomically, remaining capacity is never invented, and the configured reserve cannot be crossed.
- Given each provider failure class, when orchestration decides an outcome, then only safe transient failures retry with bounded delay/attempts, terminal failures stop, ambiguous calls reconcile, and exhausted transient SQS work reaches the DLQ.
- Given newer suspended, closed, missing, malformed, or incomplete evidence, when current odds or recommendation inputs are read, then older active prices remain historical but cannot be actionable; newer valid active evidence restores eligibility deterministically.
- Given partial provider data, when normalization and persistence complete, then valid siblings remain available, exact gaps remain visible, and completeness is never implied.
- Given production synthesis and tests, when operations inspect health and alarms, then rate window, retry scheduling/exhaustion, failure class, availability state, and DLQ depth are observable without secrets, raw payloads, or high-cardinality dimensions.

## Spec Change Log

- 2026-08-04: Implemented the SharpAPI-only rate-window, provider health, retry/DLQ, and monotonic availability contract; moved the story to review.

## Review Triage Log

- 2026-08-04 adversarial review: 13 findings resolved, 0 waived. Patched authoritative successful-response rate metadata, 13-digit reset epochs, Dynamo nested remaining expressions, unknown post-reset capacity, ambiguous exhaustion, fail-closed exact availability reads, same-time blocking precedence, canonical unavailable-selection mapping, incomplete group recovery, nested Lambda summaries, and alarm metric parity. Added production-shaped regression tests.
- 2026-08-04 adversarial review pass 2: 6 findings patched, 0 waived — 4 blind-hunter findings (2 high: focused capacity misclassification and missing focused rate reconciliation; 2 medium: retryable summary recognition and empty-header persistence) and 2 edge-hunter findings (1 high: provider `retryAt` could exhaust SQS receives early; 1 high: malformed cooldown could bypass recovery). Actions: added provider-directed bounded message visibility with receive-five exhaustion, separated capacity from deduplication, persisted/reconciled only authoritative non-empty rate windows, recognized nested retryable summaries, and routed malformed cooldown through fail-closed recovery. Added focused worker and synthesized infrastructure regressions.
- 2026-08-04 adversarial review pass 3: 6 findings patched, 0 waived — 4 high (expired-window deadlock, top-level provider retry timing loss, concurrent equal-time active overwrite, and stale legacy quota overriding authoritative capacity) and 2 medium (unassociated nested retry timing and missing production/race proofs). Actions: added a single-owner 60-second post-reset probe lease without inventing remaining capacity, made focused checks authoritative-window-only and reset-aware, preserved provider retry timing at SQS transport, encoded blocking priority in the Dynamo conditional write, and extracted reason/retryAt from one result record. Added memory/Dynamo race, focused reset/coexistence, and transport association regressions.
- 2026-08-04 clean review pass 4: 3 medium findings patched, 0 waived. Actions: generic quota prechecks now prefer authoritative `rateWindow.remaining` over stale legacy quota, recovery success persists the returned authoritative window, and Dynamo reset probes use both version CAS and `attribute_not_exists(remaining)` so a concurrent authoritative value, including zero, wins. Added exact orchestration and transaction-shape/race regressions.

## Design Notes

Availability is a separate monotonic projection ordered by provider observation time and deterministic evidence ID, parallel to price CURRENT. Read eligibility requires the latest exact-selection and required market-group availability evidence to be active; an older active update cannot displace newer blocking evidence. Immutable snapshots and explicit gaps remain the audit source.

Retry decisions are pure data: `{class, action, retryAt, attempt, maxAttempts, reason}`. SQS delivery count bounds transport retries; durable attempt identity prevents a second paid call from replacing reconciliation.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm phase1:preflight`
- `pnpm check`
- hosted Phase 1 environment and browser smoke

## Dev Agent Record

### Implementation Plan

Keep paid-call ownership in the existing durable control plane, replace the misleading plan-quota interpretation with authoritative provider request windows, centralize retry/health decisions, and add an availability projection parallel to immutable price history so unavailable evidence fails closed without deleting snapshots.

### Completion Notes

- Added bounded SharpAPI response metadata parsing for rate limit, remaining capacity, reset, and provider retry timing. Missing fields remain unknown, and account RPM is no longer synthesized into durable quota remaining.
- Added memory and DynamoDB atomic request-window reset, reservation, attempt reservation, and reconciliation paths that preserve the configured reserve under concurrency.
- Added one pure terminal/transient/ambiguous retry matrix with capped attempts, provider-directed timing, bounded jitter, reconciliation for ambiguous paid calls, and an exact exhausted result.
- Added durable health classes and reasons across odds, focused odds, schedule, account, and splits. Only transient unhealthy records receive retry/cooldown and TTL; success clears current failure state while durable runs, attempts, pages, and gaps remain.
- Added monotonic exact-selection and market-group availability evidence. Suspended, closed, and incomplete provider evidence blocks actionable CURRENT reads while immutable history remains; successful complete active evidence restores eligibility deterministically.
- Added explicit SQS partial-batch outcomes. Terminal commands acknowledge, while transient or ambiguous commands retain retry ownership and reach the existing DLQ at the fifth receive.
- Added low-cardinality retry, health, rate-window, suspended, partial, failure, and DLQ alarms plus safe redrive and recovery documentation.
- Verification passed after all four review passes: providers 58 tests, domain 66 tests, database 196 tests, workers 156 tests, infrastructure 8 tests, full `pnpm check`, Phase 1 preflight, and `git diff --check`.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-024-provider-quota-retry-dlq-and-suspended-partial-states.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/workers/src/live-odds-lambda.test.ts`
- `apps/workers/src/live-odds-lambda.ts`
- `apps/workers/src/odds-control-plane.test.ts`
- `apps/workers/src/odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/sharp-api-ingestion.test.ts`
- `apps/workers/src/sharp-api-ingestion.ts`
- `docs/phase1-deployment.md`
- `docs/runbooks/sharpapi.md`
- `infra/cdk/src/foundation.test.ts`
- `infra/cdk/src/foundation.ts`
- `packages/database/src/fixture-odds-adapter.test.ts`
- `packages/database/src/fixture-odds-adapter.ts`
- `packages/database/src/odds-control-plane.test.ts`
- `packages/database/src/odds-control-plane.ts`
- `packages/domain/src/fixture-odds.test.ts`
- `packages/domain/src/fixture-odds.ts`
- `packages/providers/src/sharp-api.test.ts`
- `packages/providers/src/sharp-api.ts`

## Change Log

- 2026-08-04: Completed implementation and verification of provider rate windows, bounded retry and DLQ routing, durable health, and fail-closed market availability.
- 2026-08-04: Applied all adversarial review findings and added production-path regressions for rate metadata and Dynamo nested-field reservations.
- 2026-08-04: Applied second-pass blind/edge review findings for focused capacity, transport retry timing, empty metadata, and malformed cooldown recovery; reran the complete repository and deployment gates.
- 2026-08-04: Applied final review findings for bounded reset probes, authoritative/legacy coexistence, top-level retry timing, concurrent blocking precedence, and nested result association; reran all gates.
- 2026-08-04: Applied clean-review fixes for generic authoritative quota precedence, probe-window healing, and Dynamo probe CAS fencing; reran all gates.
