---
title: 'FTE-DATA-003C Production Odds Collection Control Plane'
type: 'feature'
created: '2026-08-03T20:30:00-04:00'
status: 'done'
baseline_revision: '845a1c8'
final_revision: '227a8c8'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0A-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md'
warnings: [multiple-goals, oversized]
---

<intent-contract>

## Intent

**Problem:** Real SharpAPI odds and splits are live, but production bypasses adaptive cadence, hard-selects one provider, loses page progress on retry, and lacks durable attempt/quota/gap telemetry. The blocked DATA-003/003A outcomes therefore remain unproven and the current 15-minute full refresh wastes quota.

**Approach:** Add a provider-neutral production control plane around the existing strict adapters and immutable evidence store: policy-driven per-league cadence, durable page/run/attempt state, resumable Sharp pagination, isolated league execution, bounded primary/fallback selection, explicit evidence gaps/provenance, and operational metrics. Supersede DATA-003/003A only after this corrective story proves their required outcomes.

## Boundaries & Constraints

**Always:** Keep SharpAPI primary and The Odds API an explicit bounded fallback; schedule newly discovered games separately from odds refresh; refresh MLB/MLS hourly by default and increase frequency only inside configured pregame windows; persist every physical request attempt, page cursor/offset, quota cost, chosen provider, failure reason, and completion checkpoint before advancing; bind odds through exact canonical mappings and pregame event fences; preserve provider provenance without double-weighting shared books; isolate leagues; append immutable evidence and explicit stale/partial/suspended/closed/missing/unsupported gaps.

**Block If:** Automatic fallback would blend providers inside one partially committed run; the paid contract forbids required normalized retention; provider semantics cannot distinguish an evidence gap without fabrication; enabling a new paid service or increasing plan cost is required.

**Never:** Re-fetch completed pages after a durable checkpoint; bootstrap events from odds labels; infer missing odds or history; let manual refresh bypass quota, activation, mapping, freshness, or cadence safeguards; expose secrets/raw licensed payloads; enable live betting or placement.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Healthy primary | League due, Sharp healthy | Resume at durable page, store evidence/gaps, checkpoint | Record attempts/pages/quota |
| Primary unavailable | No partial primary commit, fallback eligible | Run The Odds API under its own budget | Record bounded failover reason |
| Mid-page crash | Durable page plan/partial writes | Retry repairs/replays without another paid call when response material is sealed | Never regress current |
| League failure | MLB fails while MLS succeeds | Preserve MLS completion and MLB continuation | Alarm/retry failed league only |
| Not due | Outside cadence window | Skip provider calls | Record cadence skip |
| Missing market/book | Valid provider response lacks configured evidence | Persist explicit gap | Never synthesize price |
| Shared sportsbook | Same book through two providers | Retain both provenance records, choose one configured consensus source | Never double-weight |

</intent-contract>

## Code Map

- `packages/config/src/feed-coverage.ts` -- authoritative provider/book/market/cadence/activation/quota policy.
- `packages/domain/src/fixture-odds.ts` -- extend evidence with provider, policy, book role, source state, and gap contracts.
- `packages/database/src/odds-control-plane.ts` -- durable run, attempt, page/checkpoint, quota, continuation, gap, and health transitions.
- `packages/database/src/fixture-odds-adapter.ts` -- exact mapping/start/status fences and replay-safe evidence/current repair.
- `apps/workers/src/odds-control-plane.ts` -- per-league cadence, provider selection, recovery, isolation, and telemetry.
- `apps/workers/src/live-odds-lambda.ts` -- compose the control plane instead of static Sharp/The Odds branching.
- `infra/cdk/src/foundation.ts` -- dedicated FIFO/DLQ execution, schedule, metrics, alarms, IAM, and disabled-safe configuration.

## Tasks & Acceptance

**Execution:**
- [x] `packages/config/src/feed-coverage.ts` and tests -- add versioned Sharp-primary/fallback policy with hourly base cadence, sport-specific near-start windows, book roles, markets, quota reserves, activation, cooldown, and failback thresholds.
- [x] `packages/domain/src/fixture-odds.ts`, `packages/providers/src/{sharp-api,the-odds-api}.ts`, and tests -- preserve provider/policy/book-role/source state and bounded explicit evidence gaps while retaining strict normalization.
- [x] `packages/database/src/odds-control-plane.ts`, `packages/database/src/fixture-odds-adapter.ts`, and parity tests -- add atomic request reservation, sealed response/page recovery, per-league checkpoints, quota/health/run records, continuation, exact pregame fences, immutable gaps, and replay-safe current repair.
- [x] `apps/workers/src/odds-control-plane.ts`, `apps/workers/src/live-odds-lambda.ts`, and tests -- apply cadence, independently process leagues, resume pages, select/fail over only before provider evidence commits, deduplicate shared books, and emit stable metrics/failures.
- [x] `infra/cdk/src/foundation.ts`, tests, and deployment docs -- add FIFO/DLQ scheduling, dedicated alarms/metrics with notification configuration, least-privilege storage/secret access, and migration-safe rollout.
- [x] `_bmad-output/implementation-artifacts/{sprint-status.yaml,spec-fte-data-003*,epic-0A-context.md}` -- mark DATA-003/003A superseded/completed only after every corrective acceptance criterion passes.

**Acceptance Criteria:**
- Given MLB/MLS production policy, when a league is not due or quota reserve is insufficient, then no paid call occurs and the skip is durable/queryable.
- Given a multi-page Sharp response and interruption, when retried, then completed/sealed pages are not fetched again and evidence/current/checkpoint converge exactly once.
- Given primary outage, throttling, entitlement, or coverage failure before primary evidence commits, when fallback is eligible, then The Odds API runs under an independent budget; otherwise no mixed run is created.
- Given stale, suspended, closed, partial, unsupported, or missing configured evidence, when processed, then an immutable bounded gap with provider/policy provenance is stored and no price is fabricated.
- Given exact mapping changes, start-time/status changes, or an unmapped provider event, when committing odds, then the transaction fails/quarantines the item without creating a canonical event.
- Given one league fails, when other due leagues run, then successful checkpoints remain durable and failed work alone retries with provider/page/quota/failure telemetry.
- Given synthesis and deployment tests, when inspected, then FIFO/DLQ, disabled-safe schedules, exact IAM/secrets, alarms, and no raw credentials/payloads are proven.

## Spec Change Log

## Review Triage Log

### 2026-08-03 — Review pass 1
- intent_gap: 0
- bad_spec: 0
- patch: 15 (high 12, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Persisted upcoming starts so near-game cadence survives skipped discovery ticks and gave schedule discovery an independent budgeted provider policy.
  - `[high]` `[patch]` Added expected-event and per-book/market gaps with distinct missing, partial, stale, suspended, closed, and unsupported states.
  - `[high]` `[patch]` Enforced capability/league-scoped health, failback thresholds, bounded provider selection, and production shared-book source selection.
  - `[high]` `[patch]` Added durable leased/terminal attempts, sealed replay, ambiguous-call blocking, and run/quota/checkpoint/continuation lifecycle for every paid capability.
  - `[high]` `[patch]` Replaced ephemeral split mappings with durable exact bindings and isolated schedule/split failures by league.
  - `[high]` `[patch]` Added conditional control-plane transitions and preserved continuation metadata so stale overlapping workers cannot regress authoritative state.
  - `[medium]` `[patch]` Enforced Sharp quota costs/reserves across account, odds, schedule, and split calls and quarantined odds work after discovery failure.

### 2026-08-03 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 13 (high 10, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Added bounded recovery probes and provider-scoped schedule readiness so failback requires proven health and valid mappings.
  - `[high]` `[patch]` Reserved quota before every physical request, retained failed/ambiguous costs, and made physical attempt identities immutable and unique.
  - `[high]` `[patch]` Based fallback on durable evidence commitment, surfaced CAS losses, and stopped stale workers instead of accepting lost transitions.
  - `[high]` `[patch]` Isolated account/split failures and preserved classified capability/league failures without aborting successful odds work.
  - `[medium]` `[patch]` Made continuation cleanup reusable, strengthened post-start retrieval fences, and pruned expired expected-event gaps.

### 2026-08-03 — Review pass 3
- intent_gap: 0
- bad_spec: 0
- patch: 10 (high 8, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Added atomic quota/attempt reservation, continuation ownership, immutable terminal attempts, and page/run evidence commits with crash recovery.
  - `[high]` `[patch]` Added explicit versioned CAS and idempotent exact replay for run, checkpoint, health, and continuation transitions in memory and Dynamo.
  - `[high]` `[patch]` Reconstructed evidence commitment and seen event IDs from sealed pages so resume cannot mix providers or emit false intermediate missing gaps.
  - `[high]` `[patch]` Converted odds, schedule, probe, account, and split calls to terminal paid-attempt lifecycles and reconciled reserved quota to provider-reported actual usage.
  - `[medium]` `[patch]` Removed Sharp schedule double charging and made empty pages non-evidence-bearing.

### 2026-08-03 — Review pass 4
- intent_gap: 0
- bad_spec: 0
- patch: 8 (high 6, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Added continuation owner leases and ambiguity fences for every paid capability so overlap and uncertain responses cannot duplicate calls or mix providers.
  - `[high]` `[patch]` Threaded configured book roles into production persistence and applied shared-book source selection to current projections while retaining immutable provenance.
  - `[high]` `[patch]` Strengthened Dynamo page/evidence commits with exact replay and run-version/owner CAS parity.
  - `[medium]` `[patch]` Preserved provider-authoritative quota reconciliation and converted post-owner reserve failures into durable quota skips.

### 2026-08-03 — Review pass 5
- intent_gap: 0
- bad_spec: 0
- patch: 5 (high 2, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Added a recoverable evidence-intent fence before snapshots/gaps so crashes reconstruct commitment and permanently block mixed-provider fallback.
  - `[high]` `[patch]` Replaced frozen lease time with an injected live clock, page-loop heartbeats, and owner verification before calls and commits.
  - `[medium]` `[patch]` Made unresolved ambiguous calls require explicit reconciliation and reconciled run cost both upward and downward to provider truth.

### 2026-08-03 — Review pass 6
- intent_gap: 0
- bad_spec: 0
- patch: 3 (high 3, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Enforced persistent ambiguity checks and renewable live owner leases across schedule, account, and split calls, seals, commits, and continuation advances.
  - `[high]` `[patch]` Added capability/provider/league recovery-probe ownership so concurrent unhealthy ticks cannot duplicate paid probes.

### 2026-08-03 — Review pass 7
- intent_gap: 0
- bad_spec: 0
- patch: 4 (high 3, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Added in-flight paid-call lease heartbeats, post-response owner validation, and ambiguity fencing when ownership is lost.
  - `[high]` `[patch]` Recovered already sealed pages before classifying later failures and fenced continuation clearing by expected run, owner, and version.
  - `[medium]` `[patch]` Added one-time CAS adoption for legacy ownerless continuations.

### 2026-08-03 — Review pass 8
- intent_gap: 0
- bad_spec: 0
- patch: 5 (high 3, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Switched production leases to a real live clock and fresh claim timestamps, with a 30-second production heartbeat instead of 50-millisecond writes.
  - `[high]` `[patch]` Serialized and drained in-flight heartbeat renewals before accepting paid responses.
  - `[high]` `[patch]` Added CAS-retry quota reconciliation that preserves concurrent league reservations and provider-authoritative deltas.

### 2026-08-03 — Review pass 9
- intent_gap: 0
- bad_spec: 0
- patch: 1 (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Made ambiguity fencing reread and CAS-retry the heartbeat-advanced authoritative continuation while preserving newer ambiguity state.

## Design Notes

The corrective story replaces the older speculative page protocol with the minimum durable transitions required by the providers now in production. A run chooses one provider before evidence commits; fallback is a new provider-scoped run, never a continuation of partial primary evidence. The scheduler may tick frequently, but policy decides whether each league is due.

## Verification

**Commands:**
- `pnpm check`
- `FTE_EVENT_CURSOR_SECRET_ARN=<synthetic-arn> pnpm synth`
- `pnpm test:e2e`
- `git diff --check`

## Auto Run Result

- Summary: Replaced static 15-minute full-feed polling with a provider-neutral production control plane that applies adaptive league cadence, exact mapping/pregame fences, durable paid-call/page recovery, provider-scoped fallback, explicit evidence gaps, quota/health accounting, FIFO/DLQ isolation, and alarmable telemetry.
- Review: Nine adversarial passes repaired cadence context, per-book gaps, health/failback, physical-attempt identity, CAS transitions, continuation ownership, ambiguity fencing, evidence commitment, quota reconciliation, shared-book selection, and live-clock lease behavior. Final blind convergence review found no actionable issues; the final edge CAS issue was fixed with regression coverage.
- Verification: `pnpm check`, synthetic infrastructure synthesis, `pnpm test:e2e` (6/6), focused database/workers/domain/config/provider suites, and `git diff --check` passed.
- Residual risk: Ambiguous paid calls intentionally remain blocked until explicit reconciliation; this favors quota and evidence integrity over automatic recall.

## Dev Agent Record

### Completion Notes

- Added a versioned MLB/MLS collection policy with hourly baseline refreshes and league-specific near-start cadence, quota reserves, cooldown, and failback settings.
- Added durable provider-neutral runs, physical attempts, sealed pages, continuations, checkpoints, health, quota, and immutable evidence gaps with in-memory/Dynamo parity tests.
- Production now discovers schedules independently, resumes SharpAPI pages without repeating sealed paid calls, fences commits against canonical event status/start changes, and permits bounded The Odds API fallback only before primary evidence commits.
- Sharp account and split pages are durable; missing split entitlement is recorded explicitly rather than displayed as fabricated or unexplained empty data.
- Added FIFO execution with DLQ, isolated league processing, stable embedded metrics, alarms, least-privilege Dynamo/secret access, and migration/rollback documentation.
- Adversarial hardening pass 1 persisted upcoming starts/expected event IDs across discovery skips, separated schedule fallback behavior, generated per-book/per-market evidence gaps, league-scoped health, enforced failback thresholds, added durable request leases/terminal attempts, and protected monotonic state transitions from stale writers.
- Adversarial hardening pass 2 added non-serving recovery probes, provider-scoped schedule authorization, atomic per-request quota reservation, unique terminal physical attempts, durable ambiguous-call fencing, evidence-aware fallback, classified failures, safe continuation deletion, retrieved-time pregame fencing, and expiry-pruned expected schedule bindings.
- Verification passed: `pnpm check`, synthetic `pnpm synth`, `pnpm test:e2e` (6/6), and `git diff --check`.

### File List

- `_bmad-output/implementation-artifacts/epic-0A-context.md`
- `_bmad-output/implementation-artifacts/spec-fte-data-003c-production-odds-collection-control-plane.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/workers/src/{fixture-odds-seed,index,live-odds-ingestion,live-odds-lambda,odds-control-plane,production-odds-control-plane,sharp-api-ingestion}.ts`
- `apps/workers/src/{live-odds-lambda,odds-control-plane,production-odds-control-plane,sharp-api-ingestion}.test.ts`
- `docs/phase1-deployment.md`
- `infra/cdk/src/{foundation,foundation.test}.ts`
- `packages/config/src/{feed-coverage,feed-coverage.test}.ts`
- `packages/database/src/{fixture-odds-adapter,index,odds-control-plane}.ts`
- `packages/database/src/{fixture-odds-adapter,odds-control-plane}.test.ts`
- `packages/domain/src/{fixture-odds,fixture-odds.test}.ts`
- `packages/providers/src/{sharp-api,the-odds-api}.ts`
- `packages/providers/src/sharp-api.test.ts`

### Change Log

- 2026-08-03: Implemented and verified the production odds collection control plane; moved story to review.
- 2026-08-03: Applied adversarial hardening pass 1 and reverified the full repository, infrastructure synthesis, and browser suite.
- 2026-08-03: Applied adversarial hardening pass 2 and reverified focused state-machine/provider integration coverage.
