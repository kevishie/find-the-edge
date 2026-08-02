---
title: 'FTE-DATA-003A Durable Odds Provider Page Recovery'
type: 'feature'
created: '2026-08-01T00:00:00-04:00'
status: 'blocked'
baseline_revision: '986fdf6'
review_loop_iteration: 6
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0A-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-001-feed-coverage-registry-and-league-allowlist.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-002-checkpointed-upcoming-event-ingestion-orchestrator.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003-multi-sport-odds-collection-policy-and-snapshot-jobs.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Odds provider pages can consume quota and return normalized material before downstream work finishes, but without a durable page recovery boundary a retry can call the provider again, lose the page, finalize incomplete work, or publish a different continuation.

**Approach:** Implement one bounded provider-page normalization and recovery slice: reserve each physical call atomically, seal a complete immutable PagePlan with attempt success before any per-event processing, resume strictly from that plan, prove ordered receipts before page finalization, and persist/replay one complete continuation intent.

## Boundaries & Constraints

**Always:** Consume an exact resolved DATA001 odds policy; bind quota and a never-reused physical attempt identity to policy/provider/sport/league/page/request; validate and normalize one bounded page before persistence; atomically write attempt success and the complete immutable PagePlan; treat PagePlan as the only replay source; require exact ordered EventReceipts; finalize through an expected-position CAS with immutable PageReceipt and full continuation intent; publish and mark continuation delivery idempotently; validate persisted records strictly and keep provider credentials/raw payloads out of storage and logs.

**Block If:** The resolved policy is absent/unsupported, licensed raw payload retention is required, or the provider contract cannot expose a bounded replayable page without an unresolved commercial decision.

**Never:** Persist odds snapshots or CURRENT projections; implement canonical-event eligibility or the full coverage/gap matrix; add scheduling, CDK, alarms, runbooks, picks, live/prop markets, or history synthesis; infer a successful PagePlan from a partial provider response.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| First page call | Valid policy-bound command and no PagePlan | Atomically reserve quota/attempt, call once, validate fully, then atomically seal success plus complete PagePlan | Provider/validation failure leaves no successful plan; typed failure propagates |
| Retry after sealed plan | Exact PagePlan exists | Load it and process missing receipts with zero provider calls and zero quota reservations | Mismatched command/plan is a durable conflict |
| Partial receipt crash | Prefix of ordered receipts exists | Validate existing receipts and create only missing exact receipts in order | Any mismatched index/event/digest/outcome fails closed |
| Finalize and continuation crash | Complete receipts and persisted continuation intent | CAS page position/totals/PageReceipt once; republish the same undelivered full command idempotently | Out-of-order/concurrent finalization rejects or reconciles exact replay |
| Malformed or oversized page | Duplicate IDs/keys, invalid time/price/point/cursor/quota, or bounds exceeded | No PagePlan is persisted | Bounded non-secret provider error |
| Terminal page | Complete plan with no next cursor | Finalize with immutable PageReceipt and no continuation | Replay returns the same terminal result |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- minimal attempt, PagePlan, receipt, page-position, and full continuation contracts.
- `packages/providers/src/odds-page.ts`, `packages/providers/src/the-odds-api-page.ts` -- one-page provider port and strict normalized wire adapter.
- `packages/database/src/odds-page-recovery.ts` -- recovery repository contract and exact validators/digests.
- `packages/database/src/{memory,dynamodb}-odds-page-recovery.ts` -- parity implementations for quota, PagePlan, receipts, finalization, and delivery.
- `apps/workers/src/odds-page-orchestrator.ts` -- no-call plan recovery, ordered receipt processing, finalization, and continuation drain.
- `packages/**/src/*odds-page*.test.ts`, `apps/workers/src/odds-page-orchestrator.test.ts` -- executable recovery and concurrency contracts.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts`, `packages/providers/src/{odds-page,the-odds-api-page}.ts` and tests -- add identical bounded canonical identifiers/numerics at normalization and persistence boundaries.
- [x] `packages/database/src/odds-page-recovery.ts`, memory/Dynamo implementations and tests -- enforce derived identities/chronology, authoritative attempt transition fields, renewable leased claims with receipt-absence fencing, exact outcome reconciliation, exact run-position/continuation/terminal validation, and ambiguous delivery parity.
- [x] `apps/workers/src/odds-page-orchestrator.ts` and tests -- use repository-allocated fresh attempts, renewable leased replay-safe processing, terminal audit, and authoritative continuation delivery state.
- [x] package exports/manifests and sprint metadata -- expose only the scoped recovery slice without infrastructure or evidence persistence.

**Acceptance Criteria:**
- Given an exact existing PagePlan, when the same page command retries, then no provider request or quota reservation occurs and only missing exact receipts are processed.
- Given a successful physical provider call, when its result becomes recoverable, then attempt success and the complete immutable normalized PagePlan exist atomically or neither does.
- Given complete ordered receipts, when finalization races, is lost, or retries after cycle advancement, then exactly one PageReceipt and full continuation intent are authoritative and an undelivered continuation is republished idempotently.
- Given concurrent quota reservations at the configured daily boundary, when one exceeds the limit, then the atomic reservation rejects it and every actual provider call has one unique policy-scoped attempt identity.
- Given a job reaches `requestsPerRun`, when another physical attempt is reserved, then the same atomic reservation rejects it even when daily quota remains.
- Given any command, plan, receipt, continuation, or delivery record contains unknown keys, invalid calendar values, noncanonical timestamps, untrimmed identifiers, mismatched parent digests, or an impossible next page ordinal, when it is validated or read, then it fails closed and no raw/runtime-only field is persisted or published.
- Given malformed, duplicate, or oversized nested provider material, when normalization runs, then it fails before PagePlan persistence without leaking raw payloads or credentials.
- Given workspace gates, when the slice is verified, then provider, memory/Dynamo, and worker recovery tests plus `pnpm check` pass with no snapshot/CURRENT, scheduler/CDK, alarm, or full-gap implementation added.

## Spec Change Log

- 2026-08-01: Review repair iteration 1. Fresh blind and edge-case review found incomplete policy identity, exact-schema validation, calendar/timestamp validation, nested-key rejection, immutable memory reads, authoritative stored-plan/receipt finalization, receipt/continuation linkage, publisher idempotency identity, exact delivery reconciliation, per-run quota, seal ownership reconciliation, recovery-time policy validation, terminal page bounds, and provider-error preservation. Reopened from baseline `986fdf6`; amended the repository/orchestrator tasks, acceptance criteria, and design rules to prevent forged recovery state, quota bypass, leaked runtime fields, duplicate publication, and false finalization. KEEP: the small DATA003A boundary, strict bounded provider normalization, policy-scoped physical attempts, atomic attempt-success plus complete PagePlan, no-call recovery, ordered processing receipts, PageReceipt/continuation CAS, memory/Dynamo parity, and explicit exclusion of evidence storage and infrastructure.
- 2026-08-01: Review repair iteration 2. Fresh review found the repaired design still allowed an unfinalizable max-page continuation, under-bound continuation scope/cursor, command-digest-derived page identity, under-scoped run positions, unverified attempt ownership on plan recovery/seal, memory/Dynamo divergence for position/failure/delivery/replay, incomplete continuation-presence checks, non-exact Dynamo envelopes, missing ambiguous-commit reconciliation, and unredacted provider exceptions. Reopened from baseline `986fdf6`; strengthened the repository/orchestrator tasks and design rules to prevent duplicate calls, cross-stream position collisions, corrupted replay, impossible continuation plans, and secret-bearing error escape. KEEP: all iteration-1 schema, quota, authoritative-read, idempotency, and small-slice constraints that remain compatible.
- 2026-08-01: Review repair iteration 3. Fresh review found plan recovery and downstream operations still failed to prove successful attempt ownership, Dynamo reservation lacked an atomic plan-absence fence, attempt/time/command/plan/outcome bounds were incomplete, receipts were insufficiently exact, continuation digest linkage and terminal cursor parity were incomplete, and concurrent workers could process one missing receipt twice. Reopened from baseline `986fdf6`; required authoritative plan loading at every transition, exact canonical reservation identity/time, strict material bounds, and per-index processing claims before side effects. KEEP: all compatible iteration-1/2 policy, quota, schema, stable identity, ambiguous-reconciliation, continuation, and small-slice constraints.
- 2026-08-01: Review repair iteration 4. Fresh review found processing claims could permanently strand a page, attempt and collection identities could collide or cross scope, memory did not persist successful attempts, replay did not always load authoritative continuation delivery state, exact validators and ambiguous delivery reconciliation were incomplete, finalization was not atomic in memory, numeric/identifier bounds diverged, policy comparison depended on property order, and failed attempts lacked a durable terminal audit. Reopened from baseline `986fdf6`; required leased claim recovery, collision-safe digests, caller-owned unique attempt tokens, canonical policy comparison, exact continuation/claim/finalized validators, atomic parity, and terminal bounded failure records. KEEP: all compatible authoritative plan, quota, bounds, stable page, receipt, continuation, and scope exclusions.
- 2026-08-01: Review repair iteration 5 (final normal repair). Fresh review found caller-authored attempt transitions could overwrite reservation fields, attempt/claim identity derivation and chronology were not revalidated, claim acquisition raced completed receipts and lacked safe renewal, completion reconciliation could accept different outcomes, terminal attempts could be reused, run-position/continuation policy validation was incomplete, and terminal pages did not prove continuation absence. Reopened from baseline `986fdf6`; required repository-owned attempt transitions, exact derived identities, receipt-fenced renewable leases, exact outcome reconciliation, terminal-attempt rejection, exact position/continuation validation, and terminal absence proofs. KEEP: all compatible iteration-1 through iteration-4 recovery, quota, scope, strict validation, continuation, and exclusion constraints.

- 2026-08-01: Implemented the isolated durable provider-page recovery slice from baseline `986fdf6`; provider, memory/Dynamo, worker, and full workspace gates pass without adding snapshots, CURRENT projections, scheduling, or infrastructure.

## Review Triage Log

### 2026-08-01 — Review pass
- intent_gap: 0
- bad_spec: 17: (high 17, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Bound recovered commands to an authoritative resolved policy version/digest and require policy validation before every recovery path.
  - `[high]` `[bad_spec]` Required exact schemas and canonical values for commands, PagePlans, events, receipts, continuations, delivery records, dates, timestamps, identifiers, and page bounds; continuations are explicitly reconstructed.
  - `[high]` `[bad_spec]` Required duplicate bookmaker/market rejection before PagePlan persistence and deep-cloned immutable memory reads.
  - `[high]` `[bad_spec]` Required finalization and replay to load and prove the authoritative stored PagePlan and exact persisted ordered receipts, with strict parent linkage on every read.
  - `[high]` `[bad_spec]` Required publisher transport deduplication from the persisted continuation identity and exact delivered tombstone reconciliation.
  - `[high]` `[bad_spec]` Added atomic per-run quota enforcement alongside daily quota and exact attempt-ownership checks during lost-response seal reconciliation.
  - `[high]` `[bad_spec]` Required provider failure-recording errors not to replace the original bounded provider error.

### 2026-08-01 — Review pass
- intent_gap: 0
- bad_spec: 15: (high 15, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Required max-page next cursors to be rejected before sealing and continuations to equal the canonical parent command plus exact plan cursor across every inherited field.
  - `[high]` `[bad_spec]` Required stable collection/run/page keys independent of command digest and authoritative scope on run-position records.
  - `[high]` `[bad_spec]` Required recovery and seal reconciliation to prove the exact persisted successful attempt owns the PagePlan.
  - `[high]` `[bad_spec]` Required memory/Dynamo parity for run-position CAS, immutable failure audits, delivery digest tombstones, and terminal/nonterminal continuation presence and identity.
  - `[high]` `[bad_spec]` Required exact whole-envelope Dynamo validation and redundant digest checks on all reads.
  - `[high]` `[bad_spec]` Required ambiguous seal/finalize commit reconciliation and bounded redacted worker provider errors.

### 2026-08-01 — Review pass
- intent_gap: 0
- bad_spec: 13: (high 13, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Required every recovered/sealed plan to prove an exact successful owning attempt and every reservation transaction to fence plan absence before quota or provider work.
  - `[high]` `[bad_spec]` Required canonical bounded attempt identities and trusted canonical ISO reservation times before quota-day derivation.
  - `[high]` `[bad_spec]` Required authoritative plan loads for receipt writes/finalization and one exact receipt validator across memory and Dynamo.
  - `[high]` `[bad_spec]` Required continuation ID and digest presence/linkage, terminal cursor clearing, and strict memory/Dynamo parity.
  - `[high]` `[bad_spec]` Added explicit policy-array, string, page, ordinal, provider-event, outcome, and numeric bounds to command/normalization/persisted-plan validation.
  - `[high]` `[bad_spec]` Required an atomic per-plan-index processing claim so concurrent retries cannot execute the same processor side effect twice.

### 2026-08-01 — Review pass
- intent_gap: 0
- bad_spec: 16: (high 16, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Replaced permanent random processing claims with exact leased claims that support safe expiry/takeover and preserve immutable completion.
  - `[high]` `[bad_spec]` Required caller-unique attempts, persisted reserved-to-succeeded parity, command ownership, and durable terminal failure audit.
  - `[high]` `[bad_spec]` Required collision-safe digest identities containing policy/provider/sport/league/run/page scope for every plan, quota, and position key.
  - `[high]` `[bad_spec]` Required exact validators and authoritative reads for claims, PageReceipts, continuations, delivery tombstones, and finalize replay/delivery state.
  - `[high]` `[bad_spec]` Required ambiguous delivery reconciliation and terminal/nonterminal continuation presence across normal and lost-response paths.
  - `[high]` `[bad_spec]` Required memory finalization prevalidation before mutation, domain magnitude bounds, canonical policy digest comparison, and identical provider/persistence identifier bounds.

### 2026-08-01 — Review pass
- intent_gap: 0
- bad_spec: 14: (high 14, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Required attempt and claim IDs to be recomputed from exact canonical fields, with trusted attempt chronology and repository-owned transitions that cannot overwrite reserved values.
  - `[high]` `[bad_spec]` Required terminal attempts never to authorize another physical call and fresh attempt allocation to use unique repository-validated nonces.
  - `[high]` `[bad_spec]` Required claim acquisition/renewal to be transactionally fenced by receipt absence, support sufficient renewal/heartbeat, and prevent processing after lease loss.
  - `[high]` `[bad_spec]` Required completion replay to compare the exact expected receipt/outcome digest in memory and Dynamo before accepting a concurrent result.
  - `[high]` `[bad_spec]` Required exact run-position envelopes, canonical continuation policy-digest validation, ambiguous delivery reconciliation, and proof that terminal pages have no continuation.

### 2026-08-01 — Review pass (mandatory non-convergence halt)
- intent_gap: 0
- bad_spec: 15: (high 15, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - none

## Design Notes

EventReceipts in this slice certify deterministic processing of a planned event item only; they do not claim that odds evidence was stored. Later slices may consume PagePlan material and replace or extend the processing outcome without weakening this recovery boundary.

All persisted records use exact allowlisted schemas. Finalization accepts identities, not caller-authored durable facts: the repository consistently loads the sealed PagePlan and each ordered receipt, validates their parent/index/material linkage, and only then performs its atomic position/PageReceipt/continuation transition. Continuation publishing receives the persisted intent identity as its FIFO or transport idempotency key; delivery reconciliation requires the exact persisted digest. Memory reads deep-clone nested records.

Collection identity is the exact policy/provider/sport/league/run tuple. Page records are keyed by that collection identity plus ordinal, never by a mutable command digest; changed commands for the same page conflict before quota or provider work. Run-position CAS uses the same identity. A continuation is the canonical explicit parent command with only `pageOrdinal + 1` and `cursor = plan.nextCursor`; every other field and policy value must match. A max-ordinal plan cannot carry a next cursor. Seal and finalization reconcile ambiguous transaction responses by consistently rereading and fully validating the exact attempt/plan or PageReceipt/continuation relation.

Page recovery always validates the exact successful owning attempt; its absence or mismatch makes the plan corrupt. Reservation atomically fences plan absence with daily/run quota and the unique attempt record. `reservedAt` is trusted canonical ISO and quota day is derived from that parsed instant. All commands, policy arrays, events, nested selections, points, page counts, ordinals, and processing outcomes have explicit finite/cardinality/byte bounds. Before executing a per-event processor, the repository atomically claims the exact plan index; completion replaces that claim with the immutable receipt, and replay reconciles only the exact claim/receipt identity.

All internal identities are collision-safe digests of length-delimited canonical tuples and include policy/provider/sport/league/run plus page/index as applicable. Attempt identity contains a caller-generated unique nonce and can never be inferred solely from time. Processing claims bind plan/index/owner and a trusted `leaseUntil`; only the exact owner may complete while valid, and an expired claim may be atomically taken over. The processor must be replay-safe because a crash after its external side effect but before receipt completion can cause a lease takeover. Attempts move immutably through reserved to succeeded or failed, with bounded typed failure audit. Replay always returns the stored continuation and its actual delivered state; no continuation is synthesized over authoritative storage.

Attempt success/failure transitions load the reserved record and preserve every authoritative field; caller inputs are identities plus terminal material only. Validators recompute attempt and claim IDs and require `finishedAt >= reservedAt`. A reservation API never returns a terminal attempt as callable. Claim creation or renewal includes receipt absence in the same transaction; owners renew before processing past the lease safety margin, completion requires an unexpired exact owner lease, and a lost lease aborts completion. Concurrent completion reconciles only a byte-identical expected receipt digest. Exact run-position records are validated on read, continuation policy digest is recomputed, and terminal finalized pages explicitly prove continuation absence.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test` -- strict bounded provider-page normalization passes.
- `pnpm --filter @find-the-edge/database test` -- memory/Dynamo quota, PagePlan, receipt, finalize, and continuation parity passes.
- `pnpm --filter @find-the-edge/workers test` -- no-call recovery and idempotent continuation replay passes.
- `pnpm check && git diff --check` -- all workspace and patch-hygiene gates pass.

## Auto Run Result

- Status: blocked.
- Blocking condition: `review repair loop exceeded 5 iterations (non-convergence)`.
- Residual defects: Dynamo reservation cancellation can authorize a stale attempt after plan seal; memory/Dynamo continuation identity parity is broken; plans are not consistently bound to their successful owning attempts; normalized plans and receipts are not deeply revalidated at persistence boundaries; claim completion can certify forged material/outcomes; claim lease/index/renewal CAS validation is incomplete; later-page position, terminal continuation absence, failure audit, and final-state envelope validation remain incomplete; provider material is not constrained to the resolved policy.
- Verification before halt: full `pnpm check`, focused provider/database/worker suites, `git diff --check`, and scoped security audits passed, but final fresh adversarial review found the residual defects above.
- Dirty implementation preserved for diagnosis; no commit created.

**Result:** Repair iteration 1 passes `pnpm check` (15/15 typecheck and build tasks; all workspace tests). Focused totals after final concurrency/schema coverage: providers 26, database 72, workers 33. `git diff --check` and scoped source audits pass. No commit created.

**Result:** Repair iteration 2 independently re-derived the bounded page-recovery slice from baseline `986fdf6`. Full `pnpm check` passes; focused totals are providers 26, database 69, and workers 30. Stable policy-scoped page identity, strict nested normalization and persisted digests, daily/run quota reservation, atomic plan sealing, authoritative ordered receipts, scoped position CAS, exact continuation/delivery replay, and redacted failure preservation are implemented without snapshots, CURRENT projections, scheduling, or infrastructure. No commit created.

**Result:** Repair iteration 3 independently re-derived the slice from baseline `986fdf6`. Full `pnpm check` passes; focused totals are providers 28, database 66, and workers 30. Authoritative successful-attempt plan recovery, atomic plan-absence quota reservation, bounded canonical attempts/timestamps/commands/material, exact receipts, per-index claims, run-position CAS, and terminal/nonterminal continuation linkage are implemented. No snapshots, CURRENT projections, scheduling, or infrastructure were added. No commit created.

**Result:** Repair iteration 4 independently re-derived the slice from baseline `986fdf6`. Full `pnpm check` passes; focused totals are providers 30, database 69, and workers 31. The implementation includes length-delimited policy/provider/sport/league/run/page/index identities; caller-owned nonce attempts with immutable reserved/succeeded/failed audit; trusted leased processing claims with expiry takeover; exact persisted validators and Dynamo envelopes; authoritative finalization and delivered-state replay; ambiguous delivery reconciliation; canonical policy material comparison; aligned identifier and finite price/point bounds; and bounded redacted provider failures. Scope remains limited to page recovery, with no odds evidence, CURRENT, scheduling, CDK, alarms, or gap-matrix implementation. `git diff --check` and scoped security/suppression audits pass. No commit created.

**Result:** Final normal repair iteration 5 is review-ready from baseline `986fdf6`. Repository-owned transitions recompute scoped attempt and claim identities, preserve reservation fields and chronology, reject terminal attempt reuse, fence claim acquisition/renewal on receipt absence, require an exact valid lease and outcome digest for completion, validate collection-scoped run position, and replay authoritative continuation delivery state. The native Dynamo implementation uses conditional multi-item transactions for quota, plans, claims, receipts, finalization, and lost-response reconciliation while propagating non-conditional service failures. The worker heartbeats leases and aborts completion after ownership loss. `pnpm check` passes; focused totals are providers 25, database 67, and workers 29. `git diff --check` and scope/security audits pass. No commit created.

## File List

- `packages/domain/src/index.ts`
- `packages/providers/src/{index,odds-page,the-odds-api-page}.ts` and `odds-page.test.ts`
- `packages/database/src/{index,odds-page-recovery,memory-odds-page-recovery,dynamodb-odds-page-recovery}.ts` and `odds-page-recovery.test.ts`
- `apps/workers/src/{index,odds-page-orchestrator}.ts` and `odds-page-orchestrator.test.ts`
- `pnpm-lock.yaml`
- `_bmad-output/implementation-artifacts/{spec-fte-data-003a-durable-odds-provider-page-recovery.md,sprint-status.yaml}`
