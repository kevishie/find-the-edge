---
title: 'FTE-042: Report Persistence, Versioning, and Source Provenance'
type: 'feature'
created: '2026-08-07'
status: 'in-progress'
baseline_revision: '1591d06'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-7-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-038-scout-event-api-idempotent-job-model-sqs-and-step-functions.md'
  - '_bmad-output/implementation-artifacts/spec-fte-040-provider-backed-scouting-input-contract-and-development-stub.md'
  - '_bmad-output/implementation-artifacts/spec-fte-041-ai-report-provider-interface-and-structured-report-schema.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** A validated scouting report currently exists only in memory, while the workflow can mark a job complete without a durable report. Users cannot audit historical versions, source freshness, or the exact evidence and calculation versions behind a result.

**Approach:** Add transport-neutral report head/version/completion contracts, a scouting-owned canonical persistence projection, and memory plus DynamoDB repositories. Complete an attempt with one atomic transaction that inserts an immutable report version, compare-and-swaps the report head, binds the job and successful attempt to that version, releases the active lock, and marks the lifecycle complete.

## Boundaries & Constraints

**Always:** Accept a new insertion only from a validated FTE-041 canonical report and the exact currently claimed attempt; resolve replay from the immutable job-to-version binding before requiring an active attempt; create exactly one immutable version per newly completed job; allocate monotonically increasing versions through head compare-and-swap; make same-job exact replay idempotent and conflicting replay a stable no-mutation conflict; keep historical versions readable; preserve directly queryable source, odds-snapshot, calculation, input, prompt, model, validation, generation, lineage, and deterministic change metadata; require owner-scoped reads; reject corrupt or oversized records; emit metadata-only operational signals.

**Block If:** Completion cannot use one DynamoDB transaction covering the exact event-version condition, report version, head, job replay binding, job, attempt, and active-lock tombstone; the canonical report or provenance fails revalidation; a Dynamo access pattern requires Scan; the canonical serialized version envelope exceeds 196,608 UTF-8 bytes; or implementation needs production provider/model activation.

**Never:** Mark a job or attempt completed without a report pointer; mutate or overwrite a historical version; reuse a version number for different material; expose another requester's report existence; store secrets, raw provider payloads, prompts, credentials, or unrestricted evidence locators; weaken package boundaries; add S3, report API routes, report UI, model adapters, provider credentials, new betting formulas, or deployment-only testing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| First completion | Current claimed attempt plus validated report | Insert version 1, create head, bind completion, release active lock atomically | No partial writes |
| Later completion | New completed job for same owner/event | Insert next version, advance head, retain prior version and deterministic change summary | CAS retry or bounded conflict |
| Exact replay | Completed job plus matching persisted-authority fingerprint | Resolve the immutable job binding and return the first stored version without requiring an active attempt or mutating first-write telemetry | Emit replay metadata only |
| Conflicting replay | Same job with different draft/report material | No mutation | Stable conflict failure |
| Concurrent completion | Two eligible jobs race on one report head | Unique sequential versions; no overwrite, gap, lost update, or diff against a non-predecessor | Loser reloads/revalidates the winning predecessor, recomputes changes/version, and retries boundedly |
| Stale attempt/event | Attempt is not currently claimed or the exact event-version condition fails | No report/head/completion mutation | Return stable terminal classification; a separate fenced lifecycle path may record failure afterward |
| Legacy completion | Existing schema-v1 job/attempt is completed without a report pointer | Read as explicit legacy reportless completion, never corrupt and never fabricated | No silent migration or history rewrite |
| Foreign read | Valid identity owned by another requester | Neutral missing result | Do not reveal existence |
| Corrupt/oversized input | Invalid hashes, provenance, pointers, payload, or item size | No mutation | Stable validation/storage failure without payload echo |

</intent-contract>

## Code Map

- `packages/domain/src/scouting-report-version.ts` and `scouting-job.ts` -- storage-neutral report/version/head/change/provenance/completion-pointer contracts, stable failure taxonomy, schema-v2 write rules, and backward-compatible schema-v1 reads.
- `packages/scouting/src/report-persistence.ts` -- revalidate/project FTE-041 canonical reports into bounded immutable inline payloads, extract sorted provenance, and calculate deterministic changes.
- `packages/database/src/scouting-report-repository.ts` -- in-memory behavior contract for owner-scoped heads, immutable versions, job replay, exact-event fencing, and atomic lifecycle completion.
- `packages/database/src/dynamodb-scouting-report-repository.ts` -- DynamoDB exact-key reads and one conditional transaction with no Scan; dispatch outbox publication state is deliberately not part of completion.
- `packages/database/src/scouting-job-repository.ts` and Dynamo counterpart -- require an internal report completion pointer for completed states and remove plain reportless completion.
- `apps/workers/src/scouting-workflow.ts` and Lambda composition -- persist validated report completion or fail honestly; no empty successful fixture completion.
- `infra/cdk/src/foundation.ts` and tests -- least-privilege report-key access and safe persistence signals only if existing worker bindings require it.
- Public exports, package manifests, Epic 7 context, sprint status, and cross-package conformance tests -- additive wiring only.

## Tasks & Acceptance

**Execution:**
- [x] Define exact report identity, head, immutable version, provenance, predecessor-fenced change summary, persistence fingerprint, stable failure taxonomy, and lifecycle completion-pointer contracts in `domain`, including bounded validators, canonical identifiers, schema-v2 writes, and backward-compatible schema-v1 reads.
- [x] Add scouting-owned persistence projection that revalidates canonical FTE-041 material, stores a bounded inline payload, extracts sorted cited facts/provider observations/evidence references/calculation versions/reference hashes/odds snapshot IDs, and computes deterministic prior-version changes.
- [x] Implement an in-memory repository proving immutable insertion, latest-head CAS over predecessor ID/number/draft hash, same-job replay, conflicting replay, sequential allocation, historical reads, owner scoping, exact event fencing, and atomic job/attempt completion.
- [x] Implement DynamoDB parity with exact keys, one `TransactWriteCommand`, an in-transaction canonical event/version `ConditionCheck`, transactional conditions, bounded reread/recompute retry, corrupt-item rejection, and no Scan/S3 dependency.
- [x] Update scouting lifecycle contracts and repositories so `completed` requires an exact report pointer and plain `finishAttempt(...completed)` is impossible.
- [x] Compose validated report persistence into the worker using a trusted worker `generatedAt` bounded by attempt chronology; validation or persistence failure must leave no completed lifecycle and map to terminal validation/replay/stale failures, retryable Dynamo failures, or retryable ambiguous outcomes without ever claiming completion.
- [x] Add package and cross-package tests for first version, identical-content new job, material changes, exact persistence-fingerprint replay/conflict, concurrency with predecessor-correct diffs, rollback, history, provenance queries, corrupt records, owner isolation, schema-v1 legacy rows, reportless schema-v2 rejection, size caps, and failure taxonomy.
- [x] Keep report API/UI, S3 payloads, and production provider/model activation out of scope; update sprint routing to FTE-044 only after completion.

**Acceptance Criteria:**
- Given a validated FTE-041 report from the current attempt, when completion succeeds, then one immutable version, its latest head, job/attempt report pointers, lock release, and completed states commit atomically.
- Given the same job is replayed, when its persistence fingerprint matches authoritative report/event/input/prompt/model/provenance/calculation material while usage or latency differs, then the first stored version and telemetry are returned unchanged; when authoritative material differs, no state changes and a stable conflict is returned.
- Given separate jobs complete for the same owner/event, when versions are allocated concurrently or sequentially, then every job receives one unique contiguous version, every change summary is fenced to the exact predecessor ID/number/draft hash, and every historical version remains readable.
- Given a report version is read, then directly queryable metadata identifies the exact input, prompt, model, module/strategy/report/calculation versions, cited source observations, odds snapshots, validation outcome, generation time, predecessor, and deterministic changes without loading raw provider payloads.
- Given another requester or malformed/corrupt material or a canonical serialized version envelope above 196,608 UTF-8 bytes, when persistence or retrieval is attempted, then the operation fails closed or returns neutral missing with no partial write or existence leak.
- Given legacy schema-v1 jobs, when read, then queued/failed rows remain valid and reportless-completed rows remain explicit legacy completions; given any newly written schema-v2 completion, then no code path can produce a completed job or attempt without a report pointer. Report APIs and UI remain unchanged for FTE-044.

## Spec Change Log

- 2026-08-07: Opened from completed FTE-041. Chose bounded inline DynamoDB payloads rather than S3 because the canonical report is already capped below 65,536 bytes and cross-service atomicity is unnecessary. Defined atomic report-plus-lifecycle completion as the central invariant.

## Review Triage Log

No review passes yet.

## Design Notes

Use one owner/event report history. Derive `reportId` from requester plus canonical event; derive `reportVersionId` from report identity, job identity, and draft hash. Define the replay fingerprint from authoritative report material and identities (draft/event/input/report/prompt/model/provenance/calculation manifests), excluding usage and latency; first-write telemetry wins. Store the head separately from append-only versions and a job replay binding. The candidate carries the predecessor version ID, number, and draft hash used for changes, and the head CAS checks all three. `generatedAt` comes only from the trusted worker clock and must follow attempt start without exceeding completion time. Provider data used means cited observations/facts only; the complete normalized input remains bound by its manifest and input hashes. FTE-044 owns authenticated report APIs, the version selector, source expansion, changes, and report rendering.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test && pnpm --filter @find-the-edge/domain typecheck && pnpm --filter @find-the-edge/domain lint`
- `pnpm --filter @find-the-edge/scouting test && pnpm --filter @find-the-edge/scouting typecheck && pnpm --filter @find-the-edge/scouting lint`
- `pnpm --filter @find-the-edge/database test && pnpm --filter @find-the-edge/database typecheck && pnpm --filter @find-the-edge/database lint`
- `pnpm --filter @find-the-edge/workers test && pnpm --filter @find-the-edge/workers typecheck && pnpm --filter @find-the-edge/workers lint`
- `pnpm check && git diff --check && git diff --cached --check`
