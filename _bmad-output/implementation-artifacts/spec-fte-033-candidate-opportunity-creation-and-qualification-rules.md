---
title: 'FTE-033 Candidate Opportunity Creation and Qualification Rules'
type: 'feature'
created: '2026-08-06'
status: 'in-review'
baseline_revision: 'a9236f0cf6a328f56f7d503e38c816191626ef0b'
review_loop_iteration: 3
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-031-calculation-versioning-precision-and-display-rounding.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-032-consensus-and-qualification-defaults.md'
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The system can calculate consensus and EV but has no durable, market-driven opportunity record. The future dashboard therefore cannot distinguish a qualified edge from a stale, suspended, sparse, unhealthy, or otherwise disqualified candidate, nor reconstruct the evidence behind the decision.

**Approach:** Add a server-authoritative opportunity qualification kernel and a dedicated generation service that evaluates each current target-book selection against fresh comparison-book consensus, persists every qualified or disqualified occurrence with closed reason/warning codes and exact immutable evidence, and converges deterministically under retry.

## Boundaries & Constraints

**Always:** Keep the target sportsbook configurable and exclude it from comparison consensus. Use the sport strategy's approved markets and minimum EV, and the versioned evaluation policy for comparison weights, freshness, minimum books, outliers, and disagreement. Treat target/evidence availability, scheduled event state, provider health, complete two/three-way vectors, coherent points, calculation provenance, and exact CURRENT-to-immutable rereads as qualification gates. Store full-precision outputs, stable logical identity, content-addressed occurrence identity, evaluated time supplied by the command, sorted blocking reasons and separate warnings, every available exact snapshot reference, included/excluded book evidence, sport/module/strategy/policy/calculation versions, and safe observability counts. Persist disqualifications as evidence; retry identical input to the same bytes and ID.

**Block If:** Qualification would require a new confidence formula, a new business threshold, changing immutable odds identity, weakening the three-book gate, treating transient/corrupt infrastructure failure as a business disqualification, or selecting a production schedule/cadence not already authorized.

**Never:** Change the paper/model `qualifyEvaluation` contract or its historical replay semantics. Never qualify client-side, include the target book in consensus, fabricate missing probabilities/prices/reasons, hash or persist raw provider payloads or secrets, create bets/reports, rank/query active opportunities, add lifecycle expiration/current pointers, or build Dashboard UI; FTE-034 through FTE-036 own those later layers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Qualified edge | Scheduled event, actionable target, three or more fresh independent comparisons, available consensus, disagreement below block, EV at or above sport threshold | `qualified` occurrence with raw target/consensus/fair/EV values, warning list, complete versions/provenance, and exact evidence refs | No error expected |
| Unsafe target | Missing, stale, suspended, closed, incomplete, unhealthy, or incoherent target price | `disqualified` with target-generic blocking reasons and all evidence that was safely available | Never substitute another book or stale price |
| Sparse/divergent market | Exclusions leave fewer than minimum books or disagreement reaches block threshold | `disqualified`; retain exclusions and explicit reason; warning threshold alone remains nonblocking | No partial actionable probability |
| Retry or changed evidence | Same command/evidence repeats, or any snapshot/policy/version changes | Same bytes and ID for exact replay; new immutable occurrence for meaningful change | Conditional conflict rereads strongly and rejects semantic mismatch |
| Infrastructure/corruption | CURRENT pointer changes during reread, malformed immutable record, throttling, or storage failure | No opportunity decision is fabricated | Fail the job with bounded non-sensitive telemetry |

</intent-contract>

## Code Map

- `packages/domain/src/opportunity-candidate.ts` and tests -- immutable candidate aggregate, logical/occurrence identities, typed reasons/warnings, evidence/version validation, and canonical normalization.
- `packages/odds/src/opportunity-qualification.ts` and tests -- market-only qualification composed from consensus, fair odds, EV, disagreement, and explicit gates.
- `packages/odds/src/versions.ts` -- register the opportunity-qualification algorithm without altering existing versions.
- `packages/database/src/opportunity-evidence-repository.ts` and tests -- strongly bind CURRENT rows to exact snapshots plus selection/group availability and coherent market vectors.
- `packages/database/src/opportunity-candidate-repository.ts`, Dynamo implementation, and tests -- immutable conditional persistence with replay verification.
- `apps/workers/src/opportunity-candidate-service.ts` and tests -- resolve module/strategy/policy, gate event/provider state, evaluate candidates, persist all decisions, and emit bounded counts/reason distributions.
- Package barrel files -- export only the new contracts; no API or React surface.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/opportunity-candidate.ts`, tests, and domain export -- define and runtime-validate frozen logical identity, immutable qualification occurrence, closed reason/warning vocabularies, exact evidence, versions/provenance, and deterministic IDs.
- [x] `packages/odds/src/opportunity-qualification.ts`, tests, versions, and odds export -- compute market-only candidate status from target odds and comparison consensus while preserving raw precision and explicit unavailable states.
- [x] `packages/database/src/opportunity-evidence-repository.ts` and tests -- reread exact target/comparison snapshots, enforce availability/freshness/event/point/vector bindings, and distinguish business absence from corruption.
- [x] `packages/database/src/opportunity-candidate-repository.ts`, Dynamo adapter, tests, and database export -- persist immutable qualified/disqualified occurrences idempotently and detect replay conflicts without TTL or active index.
- [x] `apps/workers/src/opportunity-candidate-service.ts`, tests, and worker export -- scan supplied eligible events, project approved strategy/policy inputs, evaluate every offered selection, persist decisions, and emit safe candidate/status/reason counts.
- [x] Package and worker integration tests -- cover two/three-way happy paths, every target/comparison gate, equality boundaries, outliers, warning/block disagreement, target exclusion, exact evidence, permutation/retry convergence, and transient failure behavior.

**Acceptance Criteria:**
- Given any generated candidate, when it is stored, then it has exactly one `qualified` or `disqualified` status, sorted closed reasons/warnings, authoritative full-precision values or explicit nulls, complete version/provenance evidence, and immutable input snapshot references.
- Given unchanged evidence and a frozen evaluation clock, when generation retries, then logical identity, occurrence ID, normalized bytes, and repository result converge; meaningful snapshot, policy, strategy, or calculation changes create a new occurrence.
- Given stale/suspended/missing target data, non-scheduled event state, unhealthy target provider, sparse consensus, disagreement at the block boundary, incoherent points, or unavailable provenance, when qualification runs, then the candidate cannot qualify.
- Given a valid market-only edge, when qualification runs, then the existing paper/model qualification output and historical manifest identities remain unchanged.

## Spec Change Log

## Review Triage Log

### 2026-08-06 — Adversarial review pass
- intent_gap: 0
- bad_spec: 0
- patch: 19: (high 16, medium 3, low 0)
- defer: 0
- reject: 2
- addressed_findings:
  - `[high]` `[patch]` Canonicalized selection vectors before duplicate detection, provenance, hashing, and persistence so permutation retries converge.
  - `[high]` `[patch]` Kept unhealthy comparison books as exclusions without blocking a valid minimum-book consensus and preserved root-cause reasons only when consensus is unavailable.
  - `[high]` `[patch]` Added disagreement provenance and bound qualification, sport-module, strategy, policy, values, and evidence identities to the occurrence.
  - `[high]` `[patch]` Fenced every CURRENT read, including missing pointers, and strongly reread selection and group availability before deciding.
  - `[high]` `[patch]` Rejected future, causally inverted, wrongly keyed, cross-event, cross-market, and availability-mismatched evidence as corruption.
  - `[high]` `[patch]` Enforced market-aware point coherence and complete exact two-way/three-way vectors for qualified target and included comparison books.
  - `[high]` `[patch]` Bound excluded-book evidence to the same occurrence evidence set and rejected contradictory event/market gates, values, and algorithm versions.
  - `[high]` `[patch]` Corrected the Dynamo exact-key read contract and conditional replay mismatch handling.
  - `[high]` `[patch]` Added durable provider-health identity/scope evidence, bounded failure telemetry, zero-result telemetry, and zero-market rejection.
  - `[medium]` `[patch]` Added adversarial regressions for reversed vectors, missing CURRENT, availability mutation, future evidence, shared health, Dynamo mismatch, and one-unhealthy/three-healthy consensus.
- rejected_findings:
  - `[reject]` Production market discovery and scheduling remain outside FTE-033; the invocable server service treats its validated server-supplied market vectors as authoritative and rejects empty vectors.
  - `[reject]` Fair-odds and EV scalar helpers remain owned by the versioned opportunity-qualification root; separately versioned disagreement and consensus calculations are included as component evidence.

### 2026-08-06 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 5, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Matched partial snapshot availability by immutable partition identity instead of compacted array position.
  - `[high]` `[patch]` Rejected mixed versions of one provider-health row and converted health older than the authorized evidence window to stale/unhealthy.
  - `[medium]` `[patch]` Preserved bounded per-sport partial-progress telemetry when a later persistence operation fails.
  - `[high]` `[patch]` Rejected stored reason, warning, target-price, and health claims contradicted by exact occurrence evidence.
  - `[high]` `[patch]` Persisted the exact minimum-book, freshness, minimum-EV, and disagreement thresholds used for each decision.
  - `[high]` `[patch]` Validated insufficient-book, EV, disagreement-block, and disagreement-warning outcomes against those stored thresholds.

## Design Notes

FTE-033 records immutable qualification occurrences only. A logical opportunity groups later refreshes by event version, market, selection, optional point, target sportsbook, and strategy. The occurrence additionally binds exact snapshots, evaluated time, policy, calculation graph, and mutable-gate evidence. FTE-034 may build a latest pointer and lifecycle transitions over these records without rewriting history.

The generator is an invocable server-side service with a caller-supplied clock and event set. Deployment cadence is deliberately not selected here because no cadence is authorized by this story; orchestration can invoke it safely after the owning scheduling decision.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- 144 candidate identity, validation, immutability, and permutation tests pass.
- `pnpm --filter @find-the-edge/odds test` -- 173 qualification gates, raw values, boundaries, and provenance tests pass.
- `pnpm --filter @find-the-edge/database test` -- 257 exact evidence reads and conditional replay behavior tests pass.
- `pnpm --filter @find-the-edge/workers test` -- 204 end-to-end generation, metrics, retries, and transient-failure tests pass (4 live-contract tests intentionally skipped).
- `pnpm check && git diff --check` -- repository formatting, lint, boundaries, types, tests, builds, and whitespace pass.
