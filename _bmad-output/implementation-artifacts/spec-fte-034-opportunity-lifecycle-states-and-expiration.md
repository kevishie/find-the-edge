---
title: 'FTE-034: Opportunity Lifecycle States and Expiration'
type: 'feature'
created: '2026-08-06'
status: 'in-review'
baseline_revision: '7cc3769e4caebc11565f374455bbb747a17ea649'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-6-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-033-candidate-opportunity-creation-and-qualification-rules.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Qualified candidate occurrences are immutable but have no authoritative lifecycle projection, so stale evidence or a suspended, started, cancelled, or completed event could remain visible as an active betting opportunity.

**Approach:** Add a versioned lifecycle head plus immutable transition history, project every candidate occurrence through deterministic state rules, and run a scheduled expiration/event-state sweep over a sparse active index. Treat the index as a discovery aid only: authoritative reads strongly re-check the head and its exact expiration boundary.

## Boundaries & Constraints

**Always:** Preserve FTE-033 candidate occurrences unchanged. Model `active`, `stale`, `suspended`, `disqualified`, and `closed`; `closed` is terminal for a logical opportunity. Store one optimistic-concurrency head and an immutable transition for every material state/version change. Use deterministic command and transition identities so exact retries do not add versions. Ignore older candidate evidence; reject equal evaluation timestamps with different occurrence identities. Compute an active candidate's `expiresAt` from the oldest required target snapshot, included comparison snapshot, and corresponding provider-health `checkedAt`: the first stale instant is `floor(oldestEvidence + configuredMaxAge) + 1ms`, capped by event `startsAt`. At `startsAt` the opportunity is closed. Require current, identity-fenced event evidence; missing, postponed, or indeterminate event evidence suspends rather than fabricating state. State precedence is `closed`, `suspended`, `stale`, `disqualified`, `active`. Persist exact causes, reason codes, source occurrence, evidence identities, event version/status/start, previous/new state versions, and timestamps. Resolve refresh/sweep races with conditional writes and rereads. Put active-index attributes only on active heads. Every active query result must be strongly reread and satisfy `state=active` and `asOf < expiresAt`. Use bounded index queries, least-privilege worker access, and emit transition/expiration/conflict/failure plus stale-active-count telemetry.

**Block If:** Authoritative event status/version cannot be read with an identity fence; implementation would require a table scan or cross-aggregate mutation; or a new ranking formula, provider cadence, or public API contract must be invented.

**Never:** Use TTL for lifecycle history; mutate or delete FTE-033 evidence; expose a raw eventually-consistent index result; let cleanup timing define correctness; revive a closed logical opportunity; compute expiry from `candidate.evaluatedAt`; add ranking, dashboard UI, or public opportunity endpoints; fabricate unavailable event state.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh qualified | Current scheduled event and qualified evidence before exact expiry | Active head, active-index entry, immutable transition | Transactionally persist or fail closed |
| Candidate disqualified | Current disqualified occurrence | Disqualified head; no active-index attributes | Preserve reasons and prior transition history |
| Exact age boundary | `asOf == expiresAt` | Not active; transition to stale unless event start makes it closed | Never return from active read |
| Event unavailable | Postponed, missing, or indeterminate current event evidence | Suspended; removed from active visibility | Preserve evidence/cause for retry |
| Event terminal | Started, live, completed, cancelled, or superseded event version | Closed terminal head | Later candidates cannot reactivate it |
| Retry/race | Duplicate command, older occurrence, or sweeper loses CAS to refresh | Replay is stable; older input is ignored; loser rereads and converges | Same-time different occurrence is a conflict |
| Lagging index | Stale active-index item points to non-active/expired head | Item is filtered after strong head reread | Count stale-active observation; never return it |

</intent-contract>

## Code Map

- `packages/domain/src/opportunities/` -- lifecycle states, commands, transition rules, exact expiry, and typed reasons.
- `packages/database/src/opportunities/` -- lifecycle repository contract and DynamoDB transactional head/history implementation.
- `apps/workers/src/opportunities/` -- candidate projector and bounded expiration/event-state sweep.
- `infra/cdk/src/foundation.ts` -- sparse active lifecycle index, scheduled worker, least-privilege IAM, and operational telemetry.
- `packages/domain/src/index.ts`, `packages/database/src/index.ts`, `apps/workers/src/index.ts` -- public package exports.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/opportunities/opportunity-lifecycle.ts` and tests -- define lifecycle records, exact expiration, precedence, transition matrix, retry/conflict behavior, and invariants.
- [x] `packages/database/src/opportunities/opportunity-lifecycle-repository.ts` and DynamoDB tests -- transact immutable transitions with CAS heads, sparse active keys, deterministic replay, bounded due/active discovery, and strong authoritative rereads.
- [x] `apps/workers/src/opportunities/opportunity-lifecycle-service.ts` and tests -- project FTE-033 occurrences using current event evidence without mutating either aggregate.
- [x] `apps/workers/src/opportunities/opportunity-expiration-worker.ts` and tests -- sweep bounded due active heads, re-evaluate event state, converge after races, and publish required metrics.
- [x] `infra/cdk/src/foundation.ts` and tests -- provision the active-by-sport/expiration index, five-minute worker schedule, scoped permissions, logs, metrics, and failure alarm without granting scans.
- [x] Package exports and focused fixtures -- make lifecycle behavior reusable by FTE-035 while keeping ranking and public DTOs out of scope.

**Acceptance Criteria:**
- Given any discovered opportunity, when an authoritative active read occurs at or after its exact expiration or event start, then it is never returned even if the scheduled sweep has not run.
- Given a suspended or terminal event, when projection or sweep evaluates it, then active visibility is removed and an auditable transition preserves the exact cause and evidence fence.
- Given duplicate delivery or a refresh/expiration race, when competing writes execute, then conditional persistence converges to one valid head/history sequence without duplicate transition versions.
- Given an active-index query, when lagging entries are encountered, then strong rereads filter them, record stale-active telemetry, and return only fresh active heads.

## Spec Change Log

## Review Triage Log

### 2026-08-06 — Adversarial review pass
- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 9, medium 4, low 1)
- defer: 0
- reject: 2
- addressed_findings:
  - `[high]` `[patch]` Made lifecycle projection a mandatory post-persistence dependency of candidate generation so created and duplicate occurrences converge to a head.
  - `[high]` `[patch]` Prevented replay of the latest candidate from undoing a later sweep and rejected transition chronology that moves backward.
  - `[high]` `[patch]` Suspended on lagging event versions and terminally closed only when a newer current version supersedes the candidate.
  - `[high]` `[patch]` Restricted suspension, staleness, and exact expiry to target/included books and rejected ambiguous required-book health evidence.
  - `[low]` `[patch]` Guarded lifecycle state-version overflow before incrementing.
  - `[high]` `[patch]` Bound stored head event evidence to event/version/sport and enforced possible initial/non-initial transition boundaries.
  - `[medium]` `[patch]` Fixed in-memory discovery when a cursor sorts after every row.
  - `[medium]` `[patch]` Paginated DynamoDB transition history through every one-megabyte query page.
  - `[high]` `[patch]` Added durable per-sport/per-mode sweep continuation so bounded scheduled runs cannot starve later active rows.
  - `[high]` `[patch]` Rejected future schedule timestamps and unsafe, empty, or duplicate sport partitions.
  - `[high]` `[patch]` Preserved known terminal event status even when metadata freshness has elapsed.
  - `[high]` `[patch]` Isolated corrupt/orphan heads with bounded failure telemetry so later opportunities still sweep.
  - `[medium]` `[patch]` Aligned stale-active alarm dimensions with emitted CloudWatch metrics.
  - `[medium]` `[patch]` Deduplicated physical stale-index row identities across due and freshness discovery modes.
- rejected_findings:
  - `[reject]` Non-active heads need not be swept solely to become terminal because active visibility is already removed; later authoritative projection can close them.
  - `[reject]` A due head that is still physically active at read time is legitimately stale-active evidence unless the same row is counted twice.

## Design Notes

The lifecycle head is a projection, not a replacement for the candidate occurrence. Use `OPPORTUNITY_LIFECYCLE#{logicalOpportunityId}` / `HEAD` for the current head and version-padded `TRANSITION#...` sort keys for history. Active heads alone receive `activePk=ACTIVE_OPPORTUNITY#{sportKey}` and `activeSk={expiresAt}#{logicalOpportunityId}`. The GSI carries no rank; FTE-035 owns ranking and its read model.

A five-minute sweep is operational maintenance, not the expiration guarantee. Read-time validation enforces the exact boundary. The projector is invoked after a candidate occurrence is persisted; if that handoff fails, redelivery of the deterministic candidate and lifecycle command safely converges.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- 158 lifecycle transition, boundary, identity, and domain tests pass.
- `pnpm --filter @find-the-edge/database test` -- 270 transactional replay, CAS, pagination, checkpoint, sparse-index, and lagging-index tests pass.
- `pnpm --filter @find-the-edge/workers test` -- 213 projection, sweep, race, continuation, and telemetry tests pass; 4 live-contract tests are intentionally skipped.
- `pnpm --filter @find-the-edge/infra test && pnpm --filter @find-the-edge/infra synth` -- 8 infrastructure assertions pass and synthesis succeeds with a local placeholder secret ARN.
- `pnpm check && git diff --check` -- full repository verification passes with no whitespace errors.

## Auto Run Result

### Summary

Implemented an authoritative opportunity lifecycle over immutable FTE-033 candidates. Qualified occurrences now project into audited current heads; exact evidence expiry, event changes, retries, races, lagging indexes, and bounded scheduled sweeps cannot expose stale opportunities as active.

### Files Changed

- `packages/domain/src/opportunities/` -- lifecycle states, exact expiration, transition reducer, runtime invariants, and boundary regressions.
- `packages/database/src/opportunities/` -- memory/Dynamo repositories, transactional head/history writes, strong active reads, full history pagination, event fences, and durable sweep checkpoints.
- `apps/workers/src/opportunities/` -- lifecycle projection, expiration service/Lambda, continuation, conflict convergence, failure isolation, and telemetry.
- `apps/workers/src/opportunity-candidate-service.ts` and tests -- mandatory post-persistence lifecycle projection with retry convergence.
- `infra/cdk/src/foundation.ts` and tests -- sparse active index, five-minute worker schedule, scoped access, logging, metrics, and alarms.
- Package barrel files -- exported the FTE-034 domain, database, and worker contracts.

### Review Findings

- Patches applied: 14 (9 high, 4 medium, 1 low).
- Items deferred: 0.
- Items rejected: 2.
- Follow-up review recommended: true because review repairs changed lifecycle behavior, persistence pagination, worker continuation, and operational monitoring across four layers.

### Verification

- Focused domain, database, worker, Lambda, and infrastructure suites passed.
- `pnpm check` passed formatting, lint, package boundaries, all typechecks, all repository tests, and all production builds.
- CDK synthesis passed locally with the established placeholder secret ARN.
- `git diff --check` passed.

### Residual Risks

- FTE-035 still owns ranked active-opportunity reads and the public explanation API; FTE-036 owns the dashboard UI.
- Provider/event ingestion availability remains an external operational dependency; lifecycle fails closed when authoritative evidence cannot be fenced.
