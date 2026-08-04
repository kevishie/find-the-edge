---
title: 'Immutable Odds Snapshot Persistence and Current Projection'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'f16e8e3'
final_revision: 'a34f64c'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-020-bookmaker-market-selection-normalization.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The codebase already stores content-addressed immutable odds snapshots and conditionally advances current prices, but it does not explicitly represent missing provider timestamps, does not expose persistence outcomes as operational metrics, and lacks direct AWS command-contract and interrupted-write recovery proof.

**Approach:** Harden the existing append-only persistence boundary without changing its canonical identity model: reason-code unusable provider timestamps, aggregate each snapshot/current decision, verify the actual DynamoDB commands and recovery path, and document launch-forward history limitations.

## Boundaries & Constraints

**Always:** Preserve append-only `SNAPSHOT` rows, deterministic content hashes, distinct provider and collection timestamps, canonical participant-bound selection keys, exact provider-event/canonical-version fences, strongly consistent duplicate/race recovery, deterministic equal-timestamp ordering, and no snapshot TTL. Late valid evidence may append history but may never regress current. Missing provider timestamps must be explicitly unavailable and cannot become accepted price evidence.

**Block If:** Correctness would require mutating existing snapshots, synthesizing a provider timestamp, changing the snapshot hash/key schema incompatibly, deleting or rewriting legacy rows, or weakening canonical mapping/event fences.

**Never:** Backfill synthetic pre-launch history; treat a content collision as an idempotent duplicate; log raw paid payloads or credentials; implement DynamoDB Streams, replay/DLQ automation, history UI/API, or charting in this story; expire immutable snapshots.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First valid price | Canonical evidence with provider and collection timestamps | One immutable snapshot, exact-ID lookup, and current projection | Report snapshot created/current advanced |
| Exact retry | Identical evidence repeats | No duplicate history; missing mirror is repaired; current converges | Report snapshot existing and deterministic current outcome |
| Late evidence | Older provider timestamp arrives | Immutable history appends; current remains newer | Report current retained |
| Equal provider time | Distinct valid snapshots share timestamp | Snapshot ID deterministically breaks tie | No nondeterministic overwrite |
| Missing provider time | SharpAPI price has no usable timestamp | No accepted snapshot; explicit unavailable timestamp gap/rejection | Count by provider/league/reason without raw row |
| Interrupted mirror write | Primary snapshot commits, exact-ID mirror fails | Retry repairs mirror without duplicating snapshot | Bounded storage error, replay-safe recovery |
| Malformed/collision | Invalid row or same identity with different content | Nothing treated as valid | Reject as validation/corruption error |

</intent-contract>

## Code Map

- `packages/domain/src/fixture-odds.ts` -- normalized immutable snapshot identity, validation, keys, hashes, and current projection contract.
- `packages/providers/src/sharp-api.ts` -- provider timestamp validation and reason-coded row rejection.
- `packages/database/src/fixture-odds-adapter.ts` -- Dynamo persistence ordering, idempotency, duplicate/race recovery, and persistence decisions.
- `packages/database/src/exact-odds-snapshot-repository.ts` -- exact content-hash lookup mirror used by reproducibility and grading.
- `packages/database/src/fixture-odds-adapter.test.ts` -- repository concurrency, ordering, and recovery contracts.
- `apps/workers/src/sharp-api-ingestion.ts` -- persistence decision aggregation for each normalized observation.
- `apps/workers/src/production-odds-control-plane.ts` -- provider/league metrics and explicit unavailable/partial gaps.
- `infra/cdk/src/foundation.ts` -- retained PITR Dynamo table and least-privilege ingestion permissions.
- `docs/phase1-deployment.md` -- launch-forward history and legacy migration/recovery notes.

## Tasks & Acceptance

**Execution:**
- [x] `packages/providers/src/sharp-api.ts` and fixtures -- convert missing/malformed provider timestamps into bounded reason-coded row rejections while retaining valid rows from the same page.
- [x] `apps/workers/src/sharp-api-ingestion.ts` -- aggregate created/existing snapshot and advanced/retained current decisions, including stale/partial evidence counts, without exposing raw payloads.
- [x] `apps/workers/src/production-odds-control-plane.ts` -- emit bounded snapshot, duplicate, projection, stale/partial, and missing-timestamp metrics/gaps by SharpAPI and league.
- [x] `packages/database/src/fixture-odds-adapter.test.ts` -- directly assert AWS transaction/conditional/current commands, consistent recovery reads, cancellation translation, and malformed/collision rejection.
- [x] `packages/database` and worker tests -- prove retry repairs a failed exact-ID mirror after the primary snapshot commits without duplicate history or current regression.
- [x] `docs/phase1-deployment.md` -- document launch-forward history, no-TTL policy, legacy positional-key coexistence, exact-ID mirror repair, and FTE-022 stream boundary.

**Acceptance Criteria:**
- Given identical provider evidence is delivered repeatedly, when persistence completes, then exactly one immutable snapshot exists and every derived lookup/current representation converges safely.
- Given evidence older than the current projection, when it is persisted, then history retains it and current remains unchanged; equal timestamps resolve deterministically.
- Given SharpAPI omits or malforms a provider timestamp on one row, when the page is normalized, then valid sibling rows remain usable and the invalid row produces explicit unavailable evidence without a fabricated timestamp.
- Given persistence decisions occur in production ingestion, when a league run completes, then created, duplicate, advanced, retained, stale/partial, and missing-timestamp outcomes are observable with bounded provider/league dimensions.
- Given malformed odds, a hash/content collision, or an interrupted mirror write, when persistence or retry runs, then invalid evidence is rejected and partial persistence is safely repaired without mutating history.

## Spec Change Log

## Review Triage Log

### 2026-08-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 8, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Enforced strict timezone-qualified RFC3339 timestamps and invalidated earlier duplicate identities when a later authoritative revision has no valid timestamp.
  - `[high]` `[patch]` Emitted persistence decisions incrementally so partial-page success remains observable and retries record their own duplicate/retained outcomes.
  - `[high]` `[patch]` Preserved exact-index content conflicts as corruption and added a bounded mirror-write failure signal.
  - `[high]` `[patch]` Replaced the mirror stub with real exact-repository recovery proof and verified readable convergence after retry.
  - `[high]` `[patch]` Published bounded provider/league/reason EMF dimensions and added mixed nonzero production metric coverage.
  - `[medium]` `[patch]` Classified missing provider timestamp gaps as missing evidence and aligned durable gap tests.
  - `[medium]` `[patch]` Scoped stale counts to collected main rows and standardized partial evidence as rejected market-group units.

## Design Notes

The current exact-ID mirror is intentionally repairable rather than silently assumed atomic with the primary snapshot transaction. This story proves convergence under interruption and adds monitoring; changing to a new index or stream projection belongs to a separately reviewed migration. A provider timestamp that is absent or malformed is recorded as unavailable evidence, while `retrievedAt` remains collection provenance and is never substituted as market observation time.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test` -- mixed valid/missing timestamp fixtures normalize safely.
- `pnpm --filter @find-the-edge/database test` -- append-only, ordering, AWS command, collision, and repair contracts pass.
- `pnpm --filter @find-the-edge/workers test` -- persistence metrics and durable gap propagation pass.
- `pnpm check` -- full repository quality gate passes.
- `git diff --check` -- patch contains no whitespace errors.

## Auto Run Result

Implemented explicit missing/malformed provider-timestamp rejection while retaining valid sibling prices, persistence outcome aggregation and bounded production metrics, and replay-safe repair of an interrupted exact-ID mirror. The existing immutable snapshot, binding fence, current ordering, collision protection, and direct AWS command-contract tests remain intact. Deployment guidance now records launch-forward history, no-TTL snapshots, legacy positional-key coexistence, mirror repair, and the FTE-022 stream boundary.

Review findings: 11 patches applied, 0 deferred, 0 rejected. Follow-up review is recommended because review-driven corrections changed timestamp acceptance, duplicate reconciliation, operational metric semantics, and corruption handling.

Verification: provider 48 tests, database 186 tests, worker 141 tests, full `pnpm check`, and `git diff --check` passed.

Residual risk: the exact-ID mirror remains intentionally repairable rather than atomic with the primary snapshot transaction; bounded failure metrics and identical replay provide detection and convergence until FTE-022 introduces the stream projection path.
