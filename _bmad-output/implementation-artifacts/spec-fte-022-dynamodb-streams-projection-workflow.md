---
title: 'DynamoDB Streams Projection Workflow'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: '8bd4ac6'
final_revision: '25823c0'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-021-immutable-odds-snapshot-persistence-and-current-projection.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Immutable odds snapshots currently advance `CURRENT` synchronously, but there is no replayable stream projection path, independent failure queue, or proof that shared-table stream records are filtered safely. A failed or delayed projection therefore has no automated recovery boundary.

**Approach:** Enable a NEW_IMAGE DynamoDB stream and add a narrowly filtered projector that validates immutable odds snapshots and conditionally applies only the canonical newer winner. Keep synchronous projection temporarily as a safe dual-write rollout while the stream path gains operational proof.

## Boundaries & Constraints

**Always:** Process only INSERT records whose keys identify canonical `FIXTURE_ODDS#.../SNAPSHOT#...` rows; validate the complete snapshot before projecting; use the same provider-observation-time then deterministic snapshot-ID ordering accepted in FTE-021; make duplicate and out-of-order delivery safe; return partial batch failures for malformed relevant records; treat unrelated shared-table records as successful no-ops; use a dedicated projection DLQ, bounded retries, least-privilege IAM, and lag/processed/failure/DLQ signals.

**Block If:** Stream projection cannot reuse the exact FTE-021 ordering contract; infrastructure would require broad table mutation/read permissions or Scan; rebuild would fabricate or mutate history; rollout would remove synchronous projection before the stream path is verified.

**Never:** Process `CURRENT`, exact-ID mirror, event, split, paper-pick, result, or control-plane records; recurse on projector writes; change immutable snapshot/hash semantics; use collection time to override FTE-021 provider-time ordering; silently drop malformed relevant records; introduce a table Scan; remove synchronous current writes in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New snapshot | INSERT with valid canonical snapshot NEW_IMAGE | Conditional CURRENT projection applied | Processed/advanced metric |
| Duplicate delivery | Same snapshot record repeats | Idempotent retained/current result | Successful no-op outcome |
| Out-of-order delivery | Older snapshot follows newer CURRENT | CURRENT remains newer | Retained metric, no failure |
| Equal provider time | Distinct snapshots share observedAt | Deterministic snapshot ID chooses winner | Same result on replay |
| Malformed relevant row | Snapshot-shaped INSERT fails validation | Record reported as batch item failure | Retry then projection DLQ |
| Unrelated row | Any non-snapshot entity, MODIFY, REMOVE, CURRENT, or mirror row | Ignore successfully | Never enters DLQ |
| Mixed batch | Valid, unrelated, and malformed relevant records coexist | Valid commits, unrelated ignored, malformed alone retries | Partial batch response |

</intent-contract>

## Code Map

- `packages/domain/src/fixture-odds.ts` -- canonical snapshot key shape, validation inputs, and ordering contract.
- `packages/database/src/fixture-odds-adapter.ts` -- strict stored-item validator and conditional `putCurrent` primitive.
- `packages/database/src/fixture-odds-projector.ts` -- narrow snapshot-to-current projector with explicit advanced/retained result.
- `apps/workers/src/fixture-odds-projection-lambda.ts` -- DynamoDB stream parsing, exact filtering, partial batch response, and metrics.
- `infra/cdk/src/foundation.ts` -- NEW_IMAGE stream, projector Lambda/event source, DLQ, IAM, alarms, and outputs.
- `docs/phase1-deployment.md` -- dual-write rollout, replay/rebuild source, alarm checks, and rollback.

## Tasks & Acceptance

**Execution:**
- [x] `packages/database/src/fixture-odds-projector.ts` and tests -- reuse strict snapshot validation and conditional current ordering for deterministic advanced/retained projection results.
- [x] `apps/workers/src/fixture-odds-projection-lambda.ts` and tests -- parse only canonical snapshot INSERTs, ignore unrelated records, support mixed-batch partial failures, and emit bounded lag/processed/advanced/retained/failure metrics.
- [x] `infra/cdk/src/foundation.ts` and assertions -- enable NEW_IMAGE stream; add projector, event mapping/filter, bounded retries, dedicated DLQ/depth alarm and Lambda error alarm; prove least-privilege table/stream permissions and no Scan.
- [x] Existing ingestion/database integration tests -- prove synchronous and stream dual-writes converge under duplicates, races, equal timestamps, and out-of-order delivery without current regression.
- [x] `docs/phase1-deployment.md` -- document phased dual-write verification, replay from retained stream/export or explicit partition manifest, no-Scan rebuild constraint, alarm response, and rollback that preserves synchronous current writes.

**Acceptance Criteria:**
- Given a valid immutable snapshot INSERT, when the stream handler receives it, then CURRENT advances only if that snapshot wins the canonical FTE-021 ordering.
- Given duplicate, replayed, or out-of-order records, when processed in any supported batch order, then the same CURRENT winner remains and successful records do not enter the DLQ.
- Given malformed relevant and unrelated shared-table records in one batch, when processing completes, then valid snapshots commit, unrelated records are ignored, and only malformed relevant record identifiers are returned for retry/DLQ.
- Given the deployed stack, when its synthesized resources and IAM are inspected, then NEW_IMAGE streaming, bounded batch retry, a dedicated projection DLQ/alarms, exact stream/table permissions, and no Scan are proven.
- Given projection lag or unrecoverable records, when thresholds are crossed, then bounded processed/failure/lag/DLQ signals identify the projection path without raw snapshot payloads.

## Spec Change Log

## Review Triage Log

### 2026-08-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 9, medium 4, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Corrected partial-batch retry identity to DynamoDB sequence number and made missing identity fail the invocation rather than silently acknowledge poison data.
  - `[high]` `[patch]` Verified envelope keys equal NEW_IMAGE keys before projection and added mismatch coverage.
  - `[high]` `[patch]` Restricted projector PutItem permission by `FIXTURE_ODDS#*` leading key and strengthened exact role/resource/action assertions.
  - `[high]` `[patch]` Alarmed custom partial failures, emitted lag before validation, and logged only bounded sequence/key locators.
  - `[high]` `[patch]` Proved one event mapping jointly filters INSERT plus both canonical key prefixes.
  - `[high]` `[patch]` Corrected DLQ/replay/rollback documentation to reflect metadata-only SQS destinations and 24-hour stream retention.
  - `[medium]` `[patch]` Hardened live deployment recovery to retry only exact zero-cost two-league ownership overlap for a lease-covering bounded window.
  - `[medium]` `[patch]` Preserved explicit ownership/reservation failure classification and added regression coverage.
  - `[medium]` `[patch]` Completed the story file list for production orchestration and deployment-smoke changes.

## Design Notes

FTE-021 made provider observation time (`observedAt`) the accepted CURRENT ordering source, with snapshot ID as the deterministic tie-breaker; this story preserves that invariant despite older architecture prose mentioning collection time. The shared table makes exact event-name and key-prefix filtering a correctness boundary. Dual-write is intentional for rollout safety: both writers share one conditional winner, and removal of synchronous projection requires a later verified migration.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test` -- projection validation and ordering pass.
- `pnpm --filter @find-the-edge/workers test` -- stream batches, no-ops, partial failures, and metrics pass.
- `pnpm --filter @find-the-edge/infra-cdk test` -- stream, filter, DLQ, alarms, and IAM assertions pass.
- `pnpm check` -- full repository gate passes.
- `git diff --check` -- no whitespace errors.

## Dev Agent Record

### Implementation Plan

Reuse the strict FTE-021 stored-snapshot validator and conditional `putCurrent` operation behind a narrow projector. Place a second exact filter in the stream handler because the retained DynamoDB table is shared. Deploy it as an intentional dual writer with bounded retries, a dedicated DLQ, and payload-free EMF metrics.

### Completion Notes

- Added deterministic advanced/retained projection without changing immutable snapshot identity or `observedAt` plus snapshot-ID ordering.
- Added mixed-batch DynamoDB Streams handling: canonical snapshot inserts process, unrelated records are ignored, and only malformed relevant record IDs retry.
- Enabled `NEW_IMAGE`, exact key-prefix event filtering, five retries/one-day record age, projection DLQ, outputs, least-privilege `PutItem`, stream-read grants, and projection error/lag/DLQ alarms.
- Preserved synchronous ingestion projection and proved replayed dual writes cannot regress `CURRENT`.
- Documented dual-write verification, bounded DLQ response, no-Scan replay/rebuild sources, and rollback.
- Review hardening uses DynamoDB sequence numbers for partial retries, fails closed when sequence identity is absent, verifies envelope/image keys, emits poison-record lag and bounded locators, alarms custom failures, and constrains projector writes by leading key.
- Environment smoke now retries only exact, zero-cost MLB/MLS schedule ownership recovery for a bounded lease-covering window; production failure mappings retain ownership and reservation semantics.
- Verification passed: database 190 tests, workers 147 tests, environment smoke 10 tests, infrastructure 8 tests, full `pnpm check`, and `git diff --check`.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-022-dynamodb-streams-projection-workflow.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/workers/src/fixture-odds-projection-lambda.test.ts`
- `apps/workers/src/fixture-odds-projection-lambda.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `docs/phase1-deployment.md`
- `infra/cdk/src/foundation.test.ts`
- `infra/cdk/src/foundation.ts`
- `packages/database/src/fixture-odds-adapter.test.ts`
- `packages/database/src/fixture-odds-projector.test.ts`
- `packages/database/src/fixture-odds-projector.ts`
- `packages/database/src/index.ts`
- `scripts/phase1-environment-smoke.mjs`
- `scripts/phase1-environment-smoke.test.mjs`

## Change Log

- 2026-08-04: Implemented and fully verified FTE-022 DynamoDB Streams projection workflow; moved story to review.
- 2026-08-04: Addressed FTE-022 review findings for stream retry identity, envelope integrity, IAM, observability, recovery documentation, and deployment smoke resilience.

## Auto Run Result

Implemented a replay-safe DynamoDB Streams projection path for immutable odds snapshots while preserving the synchronous dual-write rollout. The shared table now emits NEW_IMAGE records to a strictly filtered projector; valid snapshots conditionally advance CURRENT, duplicates and older records are retained successes, unrelated entities are ignored, and malformed relevant records retry individually before a dedicated failure destination.

Infrastructure adds bounded batch/retry settings, exact stream/table permissions, a projection DLQ, custom failure/lag/DLQ and Lambda error alarms, and assertions proving no Scan or broad table mutation. Operations documentation covers dual-write verification, metadata-only DLQ locators, 24-hour stream replay, export/manifest rebuild beyond retention, and rollback without claiming pre-stream evidence preservation.

Review findings: 13 patches applied, 0 deferred, 0 rejected. Follow-up review is recommended because fixes changed AWS batch checkpointing, IAM scope, poison-record observability, and deployment recovery behavior.

Verification: database 190 tests, workers 147 tests, environment smoke 10 tests, infrastructure 8 tests, full `pnpm check`, and `git diff --check` passed.

Residual risk: stream retention is 24 hours and the SQS failure destination stores invocation metadata rather than the original record; recovery beyond retention depends on the immutable table plus a known partition manifest or export, never a production Scan.
