---
title: 'FTE-DATA-002 Checkpointed Upcoming-Event Ingestion Orchestrator'
type: 'feature'
created: '2026-07-30T00:00:00-04:00'
status: 'done'
baseline_revision: '6701400'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0A-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Upcoming-event feeds lack a shared retry-safe workflow, durable checkpoints, canonical event identity, provider mappings, and change history.

**Approach:** Add a provider-neutral paginated schedule contract and per-league worker that idempotently persists canonical events and mappings, advances checkpoints only after durable writes, and isolates league failures. Resolve identity by exact provider mapping first; otherwise query by normalized league, participants, and scheduled time, auto-link only when exactly one high-confidence candidate exists, and send zero or multiple candidates to an unresolved queue without creating an event.

## Boundaries & Constraints

**Always:** Preserve event identity across replay, reschedule, and cancellation; keep provider cursors opaque; use one league per SQS message; append change history idempotently; advance checkpoints with compare-and-set only after durable page writes; retain successful league progress when another league fails; use synthetic fixture payloads.

**Never:** Use provider IDs as universal canonical IDs; create an event when matching is unresolved or ambiguous; merge ambiguous events automatically; activate production schedules; ingest odds/results; expose raw provider payloads or credentials.

</intent-contract>

## Tasks & Acceptance

- [x] Replace persistence identifiers with collision-resistant SHA-256 digests and bound all Dynamo key/item material.
- [x] Runtime-validate complete checkpoint records and CAS the complete prior checkpoint state, including continuation and bootstrap progress.
- [x] Redesign continuation delivery so each bounded continuation receives a fresh queue delivery budget and concurrent workers short-circuit safely.
- [x] Persist bounded unresolved summaries plus append-only observations, and retain non-authoritative provider revisions without canonical mutation.
- [x] Harden bootstrap content/revision validation, global request budgets, durable attempted state, and cross-page duplicate detection.
- [x] Use stable versioned scheduler refresh generations with idempotent complete batch handling; add exact IAM and adversarial boundary tests.
- [x] Process FIFO records sequentially within each message group, concurrently across at most five groups, and fail the remainder of a group after its first failure.
- [x] Replace the continuation ceiling with indefinitely recoverable bounded fresh-message epochs and observable per-epoch audits.
- [x] Couple final checkpoint state, continuation intent, and run audit in one transactional outbox commit; replay and mark delivery idempotently after crashes.
- [x] Enforce canonical ISO commands, safe fixture cursors, conditional run writes, and parity tests for crash boundaries, long feeds, grouping, and outbox delivery.
- [x] Replace terminal weekly polling with overlapping refresh generations and stable retry identities so later schedule mutations remain discoverable.
- [x] Fence continuation commands to their expected checkpoint epoch/position and reject missing FIFO group metadata while grouping by sport and league.
- [x] Model outbox intent, leased claim, and delivered states; discover intents within their exact workflow and make lost transaction responses idempotently recoverable.
- [x] Add unresolved-observation TTL retention, bootstrap future-skew/material-repair checks, safe MLS limits, and ingestion alarms.
- [x] Scope continuation claims by checkpoint workflow, keep requested ingestion progressing after recovery, and persist late-continuation no-op audits truthfully.
- [x] Replace the shared pending-outbox partition with per-workflow pending partitions, conditional leases, and TTL-delivered archives.
- [x] Add hourly refresh generations with stable within-generation delayed retries, permanent unresolved idempotency markers, persisted-row validation, and backlog/age alarms.
- [x] Separate failed-attempt audit identity from workflow commit identity and make replay no-op audit timestamps deterministic.
- [x] Reject same-revision bootstrap content conflicts, cross-page provider IDs, and cross-page bootstrap identities; require canonical provider/bootstrap timestamps.
- [x] Strictly validate checkpoint hashes, canonical events, mappings, provider revisions, and complete continuation outbox commands at runtime.
- [x] Block provider work behind publication failures/active leases, order pending intents by epoch, classify Dynamo cancellation reasons, and durably account bootstrap calls before outcomes.
- [x] Enforce mapping-first, existing-candidate-second, trusted-zero-candidate bootstrap resolution and prohibit bootstrap from adding a second identity candidate.
- [x] Make terminal no-op audits deterministic; retain actual bootstrap-call accounting with separate failed outcome audits.
- [x] Complete strict canonical/mapping/revision/outbox/unresolved/identity-row validation and remove the artificial continuation epoch ceiling.
- [x] Add conditional normalized-identity ownership to Dynamo bootstrap creation/repair and deterministic identity-index failure behavior.
- [x] Anchor each scheduler horizon to the tick instant, validate outbox workflow digests, and persist manual continuations for external draining.
- [x] Harden unresolved nested observations/provider revision scope and safely roll continuation epochs at the safe-integer boundary.
- [x] Replace split identity index/owner authority with one validated atomic identity-claim invariant used consistently by creation, lookup, reschedule, repair, and both stores.
- [x] Align continuation validation and recovery so every accepted continuation remains readable and has an explicit delivery/drain mechanism.

## Acceptance Criteria

1. **Given** enabled MLB/MLS fixture coverage and trusted canonical bootstrap records, **when** invoked, **then** bootstrap creation is idempotent and provider events link/update canonical events through one shared workflow; ordinary zero/multiple-candidate ingestion still creates no event.
2. **Given** a durable page, **when** replayed, **then** events, mappings, and history are not duplicated and counters report skips.
3. **Given** multi-page output, **when** pages succeed, **then** processing continues to terminal or `maxPages`, CAS advances after each durable page, and terminal state is durable; any write failure leaves that page checkpoint unchanged.
4. **Given** no exact mapping, **when** normalized league/participants/time finds exactly one high-confidence candidate, **then** link it.
5. **Given** zero or multiple candidates, **when** processed, **then** write one idempotent unresolved record and create no event/mapping.
6. **Given** a newer reschedule/postponement/cancellation, **when** processed, **then** retain canonical ID, update state, and append history once.
7. **Given** revisions ordered by provider timestamp, nonnegative sequence, then code-unit token, **when** an older/identical revision arrives, **then** skip state/history mutation deterministically.
8. **Given** MLS fails while MLB succeeds, **when** messages run, **then** MLB progress remains; MLS checkpoint stays unchanged and retries independently.
9. **Given** valid trimmed/bounded manual/SQS input, **when** invoked, **then** both use the same function; malformed JSON, shapes, limits, windows, cursors, adapter output, or fixture cursor/time makes no durable progress and exposes only a redacted stable failure code.
10. **Given** credential-free synthesis, **when** run, **then** table, queue/DLQ, worker, IAM, and inactive scheduler-ready wiring are deterministic.
11. **Given** multiple FIFO records, **when** a message group is processed, **then** its records execute in order; after its first failure all later records in that group are returned failed without execution, while other groups may progress concurrently.
12. **Given** a valid nonterminal feed of arbitrary length, **when** bounded page work completes, **then** a fresh FIFO continuation epoch is durably recoverable without consuming the original message's receive budget or acknowledging a stranded checkpoint.
13. **Given** a crash before, during, or after continuation publication, **when** work resumes, **then** checkpoint state, continuation intent, and run audit remain atomic; pending outbox delivery replays idempotently and can be marked delivered safely.
14. **Given** a previously terminal refresh generation, **when** a later generation runs, **then** the overlapping upcoming horizon is polled again and additions, reschedules, and cancellations can be observed.
15. **Given** delayed producer retries or late continuation deliveries, **when** they execute outside SQS's deduplication interval, **then** stable attempt identity and expected checkpoint epoch/position make replay idempotent or a no-op.
16. **Given** concurrent outbox drainers, **when** they discover an intent, **then** one owns a bounded lease, delivery state remains distinguishable from intent, and expired claims can be recovered without racing provider work.
17. **Given** a checkpoint transaction commits but its response is lost, **when** retried, **then** identical checkpoint, run, and outbox state is accepted as idempotent success.
18. **Given** old unresolved observations or future-skewed/material bootstrap repairs, **when** replayed, **then** memory and Dynamo behave consistently, retained observations are bounded/TTL-eligible, and invalid future authority makes no progress.
19. **Given** pending continuations for multiple leagues, **when** one worker recovers delivery, **then** it can claim only its exact checkpoint workflow and never steals or skips another sport/league request.
20. **Given** a delivery claim, **when** publishing exceeds normal latency or the lease expires, **then** the lease exceeds the publisher timeout, conditional ownership prevents concurrent completion, and epoch fencing remains idempotent beyond FIFO deduplication.
21. **Given** delivered outboxes accumulate, **when** delivery completes, **then** they leave the pending partition, enter a TTL archive, and cannot create unbounded hot-partition growth.
22. **Given** an hourly scheduler tick or a delayed retry of that tick, **when** commands are produced, **then** a new hourly refresh observes same-day changes while retries reuse the same attempt/dedup identity and horizon.
23. **Given** a malformed persisted checkpoint, mapping, or outbox, **when** read, **then** runtime validation rejects it before state mutation; all provider revisions remain explicitly represented by provider-scoped revision rows.
24. **Given** a failed audit write or delivery failure, **when** the same workflow later succeeds, **then** the failed attempt has a distinct audit identity and cannot poison the successful workflow commit.
25. **Given** a late continuation replay, **when** it no-ops repeatedly, **then** its durable no-op audit is byte-identical and idempotent despite execution-time clock changes.
26. **Given** bootstrap/provider duplicates or conflicting equal revisions, **when** they appear across pages, **then** duplicate provider IDs, duplicate normalized bootstrap identities, and same-revision material conflicts are rejected before checkpoint advancement.
27. **Given** an undelivered intent with an active lease or a publication failure, **when** the current workflow executes, **then** provider work remains blocked until that exact outbox is delivered; pending claims choose the lowest epoch first.
28. **Given** Dynamo transaction cancellation, **when** reasons indicate conditional contention versus throttling/service failure, **then** only pure conditional cancellation becomes a conflict and operational failures propagate.
29. **Given** a bootstrap provider call, **when** later persistence succeeds or fails, **then** actual request/quota usage remains durable while the separate run audit records the outcome and a later refresh generation is not permanently poisoned.
30. **Given** an unmapped provider event, **when** resolution runs, **then** exact mapping is checked first, scoped candidates second, and trusted bootstrap creation occurs only for zero candidates; bootstrap never creates a second candidate for an existing identity.
31. **Given** terminal checkpoint replay, **when** invoked repeatedly, **then** the no-op audit uses deterministic checkpoint timestamps and remains byte-identical.
32. **Given** persisted canonical, revision, mapping, unresolved, identity-index, checkpoint, or outbox rows, **when** read, **then** required fields, bounds, enums, digest/scope relationships, timestamps, provider revision keys, and state discriminants are validated before use.
33. **Given** an arbitrarily long valid feed, **when** continuation epochs increase, **then** safe-integer validation applies without an artificial hard epoch stall.
34. **Given** concurrent trusted bootstrap creators, **when** they target one normalized identity, **then** a conditional ownership row permits one canonical owner and all losing creators resolve deterministically without creating a second ID.
35. **Given** an hourly scheduler tick, **when** its command is produced, **then** the window starts at the tick instant and ends exactly seven days later while retries retain the same generation identity.
36. **Given** manual/no-publisher work reaches `maxPages`, **when** a cursor remains, **then** checkpoint, audit, and recoverable outbox intent commit atomically and the store claim/delivery API permits a safe external drain.
37. **Given** continuation count reaches the safe-integer boundary, **when** another epoch is needed, **then** rollover remains safe and the cursor-bound outbox digest preserves replay fencing.

## I/O Matrix

| Input/state | Durable result | Checkpoint |
|---|---|---|
| One high-confidence candidate | Link/update it; append only real change | Advance after page |
| Exact provider mapping | Upsert same canonical ID | Advance after page |
| Zero/multiple candidates | Unresolved record; no event | Advance after write |
| Identical/older replay | Skip without history mutation | CAS safely |
| Reschedule/status change | Same ID; history once | Advance after page |
| Any page write failure | Record failed league run | Unchanged |
| Trusted bootstrap record | Create canonical candidate once, independent of provider ID | Before provider page |
| Terminal provider page | Complete all atomic writes | CAS to explicit terminal state |
| Page limit reached | Preserve opaque next cursor | CAS continuation state |

## Code Map and Design Notes

- Call FTE-DATA-001 `resolve(... capability: "schedule")`; preserve unsupported reasons. Add a paginated port beside generic `ScheduleProvider<T>`.
- Keep generic `RepositoryPort`; add ingestion-specific ports. Extend `Event` without sport branching.
- High confidence means exact normalized league, ordered participants, and instant. Exact mappings precede matching, preserving reschedules.
- A checkpoint is `{state:"cursor", cursor:string}` or `{state:"terminal"}`; missing checkpoint, empty cursor, and terminal are distinct. CAS compares the full prior state and never uses truthiness.
- `maxPages` is 1–20, page limit is 1–100, command text is trimmed and at most 256 code units, windows are ordered ISO instants no wider than 31 days, and provider output must match provider/sport/league/window/limit.
- Exact mappings are keyed by provider+sport+league+providerEventId. Candidate lookup is scoped by sport+league and normalized identity.
- Each provider event commits mapping+event+optional history atomically; unresolved is conditional/idempotent. Dynamo history is append-only. Checkpoint commits only after the whole page.
- Revision order is `(providerUpdatedAt epoch, revisionSequence safe integer, revisionToken code-unit order)`. Equal tuples are replays.
- Trusted bootstrap input has its own validated port and deterministic canonical ID independent of provider IDs. It is the only creation path; ordinary zero/multiple candidates remain unresolved.
- Deterministic hashes key mapping, unresolved, and history records. Never persist/log raw payloads.
- Run IDs and history IDs are collision-safe. Run-write failure is secondary and must never mask the original provider/persistence/CAS error. Failures store stable codes, never raw messages/payloads.
- Canonical and participant IDs derive from scoped semantic keys, never filtered indexes or universal provider IDs. Bootstrap payloads are runtime validated before durable creation.
- Registry construction rejects adapters lacking exact descriptor provider/sport/league schedule coverage.
- Immediate post-bootstrap matching uses a strongly consistent primary identity lookup. Any query operation paginates fully, and reschedules atomically move candidate identity indexes.
- Revision state is provider-scoped. Duplicate provider event IDs and empty, repeated, or non-progress cursors are invalid.
- Bootstrap runs only when identity is missing and its requests/quota count. Reaching `maxPages` with a cursor yields explicit bounded continuation.
- Run persistence identity includes provider, sport, league, checkpoint scope, and attempt. Success-run recording failure after checkpoint success cannot falsely report ingestion failure.
- Checkpoint scope binds the exact window. All time ordering compares parsed instants.
- Queue bounds fit the worker timeout. Scheduler-ready infrastructure omits active targeting until a valid per-league payload exists.
- Exact mappings are consulted and scope-validated before identity lookup or bootstrap.
- Canonical IDs exclude mutable schedule time and normalize Unicode to NFKC; provider identifiers remain mapping-local.
- Bootstrap targets only missing mappings, paginates within a 100-page call cap, persists a cumulative 2,000-request window budget, counts quota, rejects cross-page duplicates, and verifies or repairs canonical content, revision authority, and identity entries.
- Continuation uses a transactional outbox and a fresh FIFO message per bounded epoch; pending delivery is recovered only within the exact checkpoint workflow, then the current requested ingestion proceeds under FIFO ordering.
- Setup and coverage failures occur inside the durable run lifecycle. Provider transport failures remain distinct from invalid provider output.
- Canonical authority ordering combines explicit provider authority with provider-scoped revision ordering, preventing stale cross-provider regressions and concurrent lost updates.
- Unresolved records retain idempotent observation history rather than overwriting the first observation.
- Required run-record failure is retryable; success without its durable audit record is not acknowledged.
- Scheduler readiness uses a disabled producer with a fully valid per-league command payload.
- Bootstrap requests are constructed explicitly without cursor and paginate/target only missing identities; later resumed pages and windows larger than 100 cannot strand candidates or prewrite unrelated rows.
- Each continuation attempt has a unique durable run identity and a bounded retry ordinal below the queue DLQ max-receive budget.
- Scheduler commands derive upcoming windows at runtime through a producer contract, never fixed historical dates.
- Commands, identifiers, participants, cursors, keys, page sizes, maximum pages, and future revision skew have explicit realistic limits.
- Same-rank provider authority compares freshness before deterministic provider ID and never uses opaque revision token chronology across providers.
- Skipped outcomes perform no canonical mutation. Canonical `updatedAt` is monotonic.
- Unresolved IDs are compact stable digests; summaries update with append-only observation parity in memory and Dynamo.
- Candidate lookup stops safely after detecting ambiguity while preserving bounded pagination.

## Verification

- `pnpm --filter @find-the-edge/providers test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm --filter @find-the-edge/infra-cdk synth`
- `pnpm boundaries`
- `pnpm check`

## Dev Agent Record

### Debug Log

- Transactional-snapshot reset re-derived identity authority as a versioned aggregate and added aggregate+canonical transaction fences to every unmapped provider link.
- Identity-invariant repair iteration 1 replaced the rejected split owner/index behavior with one conditional claim protocol; lookup is read-only and legacy repair is confined to trusted bootstrap.
- Identity-invariant repair iteration 2 restored strict read-only legacy index resolution and transactional migration, then aligned lower-authority ordering, candidate fencing, claim shape, league scope, and continuation delivery semantics.
- Identity-invariant repair iteration 3 unified identity reconciliation across every consumer and added exact candidate/outbox lineage fences plus hourly generation alignment.
- Bad-spec repair iteration 1 reverted the implementation to baseline `6701400` before amending the story.
- Bad-spec repair iteration 2 reverted iteration-1 implementation to baseline `6701400` before re-deriving identity and consistency behavior.
- Bad-spec repair iteration 3 reverted iteration-2 implementation to baseline `6701400` before re-deriving mapping-first authority and retry behavior.
- Bad-spec repair iteration 4 reverted iteration-3 implementation to baseline `6701400` before re-deriving bootstrap coverage, bounded retries, and parity behavior.
- Bad-spec repair iteration 5 reverted iteration-4 implementation to baseline `6701400` before re-deriving collision resistance, continuation delivery, and bounded audit state.
- Reset-audit bad-spec repair iteration 1 reverted implementation files to baseline `6701400`, preserved the spec/context and KEEP decisions, then re-derived the approved FIFO/outbox design with freshness and delivery fencing.
- Reset-audit bad-spec repair iteration 2 reverted implementation files to baseline `6701400`, preserved the intent/KEEP decisions, and re-derived workflow-scoped recovery, bounded outbox lifecycle, hourly freshness, and deterministic parity.
- Reset-audit bad-spec repair iteration 3 reverted implementation files to baseline `6701400`, preserved intent/KEEP, and re-derived audit separation, strict durable schemas, duplicate protection, blocking delivery, and rollback-safe bootstrap accounting.
- Reset-audit bad-spec repair iteration 4 reverted implementation files to baseline `6701400`, preserved intent/KEEP, and re-derived creation-safe resolution ordering, truthful bootstrap budgets, deterministic terminal audits, and complete persisted schemas.
- Reset-audit bad-spec repair iteration 5 reverted implementation files to baseline `6701400`, preserved intent/KEEP, and re-derived conditional identity ownership, exact rolling horizons, external continuation recovery, and final nested/scope validation.

### Completion Notes

- Re-derived FTE-DATA-002 from baseline with SHA-256 persistence keys, bounded Dynamo records, validated full-state checkpoints, and full-state CAS.
- Added FIFO fresh-message continuations, durable bootstrap attempt accounting, cross-page duplicate rejection, stored non-authoritative revisions, and reconstructable checkpoint run IDs.
- Replaced rolling scheduler windows with stable seven-day buckets and validated complete idempotent FIFO batch results.
- `pnpm check` and credential-free CDK synth pass. CDK diff bundles successfully but cannot resolve an AWS account in this environment.
- Completed the user-approved non-convergence reset: FIFO records execute sequentially per message group with bounded cross-group concurrency and fail-fast group tails.
- Coupled checkpoint, continuation intent, and run audit in a transactional outbox; replay drains the outbox idempotently across publisher crashes without a hard continuation ceiling.
- Added canonical ISO timestamp and safe-integer cursor validation plus memory/Dynamo parity, crash-boundary, long-feed, FIFO-order, outbox-replay, worker, provider, and CDK coverage.
- Reset-audit iteration 1 added daily refresh generations, stable delayed producer retries, continuation epoch fencing, leased/global outbox recovery, lost-response idempotency, observation TTL, material bootstrap repair, and CloudWatch alarms.
- `pnpm check` and credential-free CDK synth pass after iteration 1. CDK diff bundles successfully and remains blocked only because this environment has no resolvable AWS account.
- Reset-audit iteration 2 added exact workflow-scoped claims, recovery-without-request-skipping, truthful no-op audits, 120-second conditional leases, pending removal/TTL delivery archives, hourly refresh versions, permanent unresolved replay markers, persisted mapping/outbox validation, and queue backlog/age alarms.
- `pnpm check` and credential-free CDK synth pass after iteration 2. CDK diff bundles successfully and remains blocked only because this environment has no resolvable AWS account.
- Reset-audit iteration 3 added unique failed-attempt audits, deterministic replay no-ops, strict full outbox/checkpoint/mapping/canonical/revision validation, canonical provider times, equal-revision conflict rejection, cross-page duplicate protection, active-lease blocking, epoch claim ordering, reason-aware Dynamo cancellation handling, and rollback-safe bootstrap accounting.
- `pnpm check` and credential-free CDK synth pass after iteration 3. CDK diff bundles successfully and remains blocked only because this environment has no resolvable AWS account.
- Reset-audit iteration 4 added mapping/candidate/bootstrap resolution ordering, second-candidate prevention, deterministic terminal audits, actual-call bootstrap budgeting with failed outcome audit separation, strict canonical/mapping/revision/outbox/unresolved/identity validation, digest checks, and safe unbounded continuation epochs.
- `pnpm check` and credential-free CDK synth pass after iteration 4. CDK diff bundles successfully and remains blocked only because this environment has no resolvable AWS account.
- Reset-audit iteration 5 added Dynamo identity-owner transactions and repair ownership moves, outbox checkpoint digest recomputation, nested unresolved validation, provider revision scope checks, exact tick-to-seven-day horizons, manual continuation intents, and safe epoch rollover.
- `pnpm check` and credential-free CDK synth pass after iteration 5. CDK diff bundles successfully and remains blocked only because this environment has no resolvable AWS account.
- Identity-invariant repair iteration 1 conditionally releases the old claim/index and acquires the destination claim in the same Dynamo transaction as canonical, mapping, revision, and history writes. Memory uses the same ownership rules; lookup performs no repair writes; trusted bootstrap owns legacy repair. Continuation rollover now chains attempt identity through the preceding durable run ID and exposes a public external drain operation. Full `pnpm check`, credential-free synth, and `git diff --check` pass. CDK diff remains environment-blocked because no AWS account is configured.
- Identity-invariant repair iteration 2 validates and exposes ownerless legacy index states without writes, migrates one candidate only inside a fenced ingestion transaction, preserves ambiguity, and prevents lower-authority ownership movement. Claims use exact event identity rather than a fake version, canonical rows retain league scope, and no-publisher runs explicitly return `delivery-required`. Full `pnpm check`, credential-free synth, and `git diff --check` pass.
- Identity-invariant repair iteration 3 reconciles owner/index/event state once for lookup, bootstrap, and ingestion; lower-authority legacy mapping atomically establishes the claim while candidate movement is transaction-fenced. Continuation predecessor lineage and hourly scheduler generation identity are validated. Full `pnpm check`, credential-free synth, and `git diff --check` pass.

## File List

- `apps/workers/**`
- `packages/domain/src/index.ts`
- `packages/providers/src/index.ts`, `packages/providers/src/upcoming-events*`, `packages/providers/src/fixtures/**`
- `packages/database/src/index.ts`, `packages/database/src/*event-ingestion*`, `packages/database/src/store-contract.test.ts`
- `infra/cdk/src/foundation.ts`, `infra/cdk/src/foundation.test.ts`
- `eslint.config.mjs`, workspace package manifests, `pnpm-lock.yaml`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-07-30: Implemented FTE-DATA-002 iteration 5 from baseline `6701400`; all local gates and CDK synth pass.
- 2026-07-30: Resumed after the user-approved audit reset; added grouped FIFO execution, unbounded fresh-message continuation epochs, and transactional continuation outbox recovery. Full local gates and CDK synth pass.
- 2026-07-30: Reset-audit repair iteration 1 re-derived from baseline `6701400`; fixed terminal freshness, delayed retry identity, continuation fencing, leased orphan outbox recovery, retention, material repair, and monitoring.
- 2026-07-30: Reset-audit repair iteration 2 re-derived from baseline `6701400`; fixed cross-workflow recovery, truthful audits, outbox partition lifecycle, hourly freshness, permanent unresolved replay identity, row validation, and queue-age monitoring.
- 2026-07-30: Reset-audit repair iteration 3 re-derived from baseline `6701400`; separated audit/workflow identities, hardened persisted schemas and duplicates, blocked work behind delivery, bounded replay markers, and made bootstrap accounting rollback-safe.
- 2026-07-30: Reset-audit repair iteration 4 re-derived from baseline `6701400`; fixed identity resolution/creation order, terminal audit determinism, bootstrap call truth, complete persisted schemas, and continuation ceiling.
- 2026-07-30: Reset-audit repair iteration 5 re-derived from baseline `6701400`; added atomic identity ownership, exact rolling horizons, manual continuation recovery, nested/scope validation, and safe rollover.
- 2026-07-30: Identity-invariant repair iteration 1 implemented conditional owner release/acquisition, read-only claim lookup, explicit bootstrap repair, strict durable schemas, non-reused rollover identities, and external continuation draining; full local gates and synth pass.

## Spec Change Log

### 2026-07-30 — Bad-spec repair iteration 1

- Defined trusted bootstrap creation without weakening zero/multiple-candidate unresolved policy.
- Defined terminal/bounded pagination, opaque cursor presence, full-state CAS, scoped mappings, adapter validation, revision ordering, atomic writes, append-only history, and failure preservation/redaction.
- Required behavioral Dynamo gateway and CDK assertions in addition to in-memory integration tests.

### 2026-07-30 — Bad-spec repair iteration 2

- Made canonical identity semantic and stable; removed eventual-consistency dependence from immediate matching; required full pagination and index movement.
- Defined provider-scoped revisions, bootstrap validation/accounting, cursor progress, bounded continuation, scoped attempts, and truthful post-checkpoint recording.
- Bound checkpoints to windows and strengthened SQS, scheduler-ready, concurrency, Dynamo, and CDK verification.

### 2026-07-30 — Bad-spec repair iteration 3

- Made exact mapping the first persistence decision and made semantic canonical IDs Unicode-normalized and independent of mutable time.
- Defined once-per-window bootstrap repair/accounting, authoritative cross-provider ordering, retry-required continuation/audit failure, and observation history.
- Required durable setup failures, precise provider/output classification, concurrent SQS safety, valid scheduler payloads, shared store contracts, and comprehensive CDK assertions.

### 2026-07-30 — Bad-spec repair iteration 4

- Defined explicit cursor-free targeted bootstrap pagination for resumed and >100-event windows.
- Defined unique bounded retry attempts, runtime upcoming-window production, canonical size/skew limits, freshness-based authority ties, and monotonic no-op semantics.
- Required compact unresolved summary/observation parity, bounded ambiguity queries, repair index moves, and exact IAM/DLQ verification.

### 2026-07-30 — Bad-spec repair iteration 5

- Required SHA-256 persistence identifiers, bounded Dynamo summaries/items, and runtime-validated full-state checkpoints.
- Replaced deterministic same-message continuation exhaustion with fresh-delivery continuation production and concurrency short-circuiting.
- Required durable bootstrap attempt state, material authority validation, stable scheduler buckets, partial-batch idempotency, and exact IAM assertions.

### 2026-07-30 — User-approved non-convergence reset

- Reset the review audit to iteration 0 without reverting the iteration-5 worktree.
- Approved per-group FIFO sequencing with bounded cross-group concurrency and fail-the-remainder behavior.
- Approved indefinitely recoverable fresh-message continuation epochs backed by an atomic checkpoint, outbox, and run-audit transaction.
- Preserved the intent contract and all prior canonical identity, validation, storage, and inactive-scheduler safeguards.

### 2026-07-30 — User-approved identity-invariant reset

- Reset the exhausted reset-audit counter to iteration 0.
- Require one coherent normalized-identity claim invariant across lookup, bootstrap creation, mapped reschedule, legacy repair, and deletion.
- Require every ownership move to conditionally release the old claim only when owned by the same canonical event and conditionally acquire the new claim only when absent or already owned by that event.
- Require memory and Dynamo stores to expose the same ownership behavior and adversarial contract tests.
- Require continuation counters, command validators, stored checkpoints, and delivery paths to share one bound and an explicit recoverable drain contract.
- Preserve the intent contract and all prior mapping-first, ambiguity-safe, durable checkpoint, transactional outbox, rolling-horizon, and strict-validation decisions.

### 2026-07-30 — User-approved transactional-snapshot reset

- Reset the exhausted identity-invariant audit to iteration 0.
- Require candidate identity ownership, bounded legacy indexes, and referenced canonical versions to be read atomically or fenced as one snapshot.
- Require every mapping/link transaction to prove the snapshot remains current before mutation.
- Require memory and Dynamo malformed-state, continuation archive, checkpoint, outbox, and replay-marker behavior to remain equivalent.
- Preserve the protected intent and all prior atomic transfer, migration, ambiguity, pagination, FIFO, scheduler, and validation safeguards.

### 2026-07-30 — Standing-approval pagination reset

- Applied the user's standing approval after the transactional-snapshot audit exceeded five repair iterations.
- Reset the review counter to iteration 0 without weakening the protected intent or prior KEEP decisions.
- Require `maxPages` to process the requested number of pages before yielding a continuation, with atomic recovery at every persisted cursor boundary.
- Require durable cursor-cycle and bootstrap-duplicate state across continuation executions.
- Require bounded, batch-oriented read behavior and retention alignment for durable replay markers.

### 2026-07-30 — Transactional-snapshot bad-spec repair iteration 1

- Prohibit duplicate Dynamo transaction targets: present aggregates are condition-checked or updated, never both.
- Define owner-without-index as valid aggregate-authoritative state; legacy indexes remain bounded migration inputs.
- Require mapped reschedules to resolve the destination aggregate and legacy candidates before acquisition.
- Keep aggregate versions monotonic and fence every present-state provider link to the exact aggregate version/candidate.
- Bound pending outbox discovery and validate claimant trimming plus delivered chronology.

### 2026-07-30 — Transactional-snapshot bad-spec repair iteration 2

- Removed the uncommitted legacy identity-index representation and migration path; one bounded, versioned identity aggregate is the sole authority.
- Defined aggregate states as missing (no row), present (one canonical candidate), or ambiguous (two canonical candidates), with every referenced canonical validated.
- Required bounded read/confirm retry and exact aggregate version/candidate transaction fences for mapping, unresolved observations, bootstrap, and reschedule movement.
- Required absent-state fences so a concurrent unique candidate cannot race an unresolved write, plus exact old-aggregate version fencing on transfers.
- Preserved operational persistence errors during bootstrap instead of reclassifying them as conditional conflicts.

### 2026-07-30 — Identity-invariant bad-spec repair iteration 2

- Preserve claim authority for all new state while requiring ownerless legacy indexes to remain readable, strictly validated, ambiguity-safe, and migrated only by an explicit ingestion/bootstrap transaction.
- Require lower-authority provider revisions to persist without canonical or ownership movement, and fence candidate linking against concurrent event movement.
- Remove the claim's meaningless version field; conditional ownership is fenced by exact canonical event identity while canonical mutation keeps its optimistic event version.
- Require explicit `delivery-required` results without a publisher, validated external drain claimants, bounded direct cursors, lineage-derived continuation attempts, and stale replay rejection across safe-integer rollover.
- KEEP the approved mapping-first resolution, transactional outbox, rolling scheduler horizon, durable audit behavior, and all strict persisted-schema safeguards.

### 2026-07-30 — Identity-invariant bad-spec repair iteration 3

- Require lookup, bootstrap, and ingestion to consume one reconciliation result built from the owner, every legacy index row, and every referenced canonical event.
- Treat exact owner/index agreement as present, one ownerless index as legacy-present, multiple/contradictory candidates as ambiguous, and malformed/dangling/cross-scope state as corrupt before mutation.
- Require lower-authority linking to establish a missing unambiguous claim atomically while leaving canonical state unchanged, with an exact event version/identity fence.
- Bind continuation outboxes to their predecessor run lineage at commit, distinguish pending delivery without a publisher, and derive scheduler windows and IDs from the same hourly generation instant.
- Tighten claim IDs, authority ranks, participants, provider revision cardinality, and memory/Dynamo malformed-state parity.

### 2026-07-30 — Identity-invariant bad-spec repair iteration 4

- Require contradictory owner/index state to classify identically in lookup, bootstrap, and ingestion, with no bypass around shared reconciliation.
- Treat legacy claim migration as identity maintenance even for stale/equal/lower-authority provider revisions, without canonical mutation.
- Validate newly constructed canonical rows before writes, reject a 65th canonical revision provider before persistence, and preserve bootstrap `updatedAt` parity.
- Make delivery-required runs actionable with their checkpoint key and make the public drain return distinct no-publisher/nothing/delivered outcomes.
- Bind scheduler retry IDs and the complete seven-day horizon to the exact generation tick, avoiding hour-floor collisions.
- Keep exact mapping-first resolution, strict durable validation, transactional checkpoint/outbox/audit state, and inactive production scheduling.

### 2026-07-30 — Identity-invariant final bad-spec repair iteration 5

- Make resolver state the exclusive authority: present/legacy-present link one event, ambiguity always carries two bounded competitors, and a lone owner/index disagreement is corrupt.
- Bound legacy index reads to two rows and include the owner ID in any two-candidate conflict without persisting additional candidates.
- Require stale/equal owner-backed unmapped observations to establish their provider mapping transactionally without canonical mutation.
- Require unresolved summaries to have observations and exactly match the latest retained observation; use one observation marker digest formula with per-event one-year replay retention.
- Make FIFO execution validate and sort decimal sequence numbers per group.
- Preserve exact-tick scheduler generations, full seven-day horizons, conditional identity/candidate fences, and all prior KEEP decisions.

## Review Triage Log

### 2026-07-30 — Review pass

- intent_gap: 0
- bad_spec: 15 (high 9, medium 6)
- patch: 0
- defer: 0
- reject: 0
- KEEP: approved identity policy, one-league isolation, opaque cursors, fixture adapters, purpose-built ports, runtime validation, and no production schedule.

### 2026-07-30 — Review pass 2

- intent_gap: 0
- bad_spec: 18 (high 11, medium 7)
- patch: 0
- defer: 0
- reject: 0
- KEEP: all iteration-1 decisions, including trusted bootstrap, terminal checkpoints, scoped mappings, deterministic revisions, atomic writes, append-only history, redacted failures, and CDK/Dynamo tests.

### 2026-07-30 — Review pass 3

- intent_gap: 0
- bad_spec: 21 (high 13, medium 8)
- patch: 0
- defer: 0
- reject: 0
- KEEP: all iteration-1 and iteration-2 decisions, including semantic scoped identity, strong primary lookup, full pagination, provider-scoped revisions, candidate moves, bounded commands, window-bound checkpoints, bootstrap accounting, redacted errors, and inactive production scheduling.

### 2026-07-30 — Review pass 4

- intent_gap: 0
- bad_spec: 19 (high 12, medium 7)
- patch: 0
- defer: 0
- reject: 0
- KEEP: all prior decisions, including mapping-first resolution, timeless NFKC semantic identity, explicit provider authority, optimistic versions, retry-required continuation, durable setup/audit lifecycle, concurrent capped SQS, strict raw-field exclusion, shared store contracts, and inactive scheduling.

### 2026-07-30 — Review pass 5

- intent_gap: 0
- bad_spec: 18 (high 12, medium 6)
- patch: 0
- defer: 0
- reject: 0
- KEEP: all prior decisions, including targeted bootstrap, stable canonical IDs, mapping-first resolution, bounded ambiguity reads, dynamic disabled scheduling, strict validation, optimistic writes, and shared memory/Dynamo contracts.

### 2026-07-30 — Review pass 6

- intent_gap: 0
- bad_spec: 3 (high 3, medium 0)
- patch: 0
- defer: 0
- reject: 32 (high 0, medium 14, low 18)
- addressed_findings:
  - none

### 2026-07-30 — Reset-audit review pass 6

- intent_gap: 0
- bad_spec: 8 (high 8, medium 0)
- patch: 0
- defer: 0
- reject: 19 (high 0, medium 8, low 11)
- addressed_findings:
  - none

### 2026-07-30 — Identity-invariant review pass 2

- intent_gap: 0
- bad_spec: 12 (high 7, medium 5)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - ownerless legacy candidate resolution and explicit transactional migration
  - lower-authority revision ordering before ownership checks
  - meaningful claim fencing without a fake version
  - read/link race fencing with Dynamo condition checks
  - safe-integer continuation lineage and stale replay
  - explicit no-publisher delivery-required state and validated external drain
  - cross-scope claim and canonical league validation
  - stricter persisted command, cursor, evidence, revision, and unresolved bounds

### 2026-07-30 — Identity-invariant review pass 3

- intent_gap: 0
- bad_spec: 15 (high 9, medium 6)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - unified owner/index/event reconciliation across lookup, bootstrap, and ingest
  - contradictory owner/index ambiguity and corrupt-row rejection
  - lower-authority atomic claim migration without canonical movement
  - exact candidate event version/identity transaction fencing
  - memory mapping validation and corrupt-state parity
  - bounded claim IDs, participants, authority, and revision providers
  - predecessor continuation lineage validation
  - distinct pending-without-publisher drain error
  - hourly generation-aligned scheduler windows and identities

### 2026-07-30 — Identity-invariant review pass 4

- intent_gap: 0
- bad_spec: 17 (high 10, medium 7)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - contradictory owner/index parity across lookup/bootstrap/ingest
  - stale/equal/lower-authority legacy claim maintenance
  - constructed canonical pre-write validation and revision-provider cap
  - bootstrap updatedAt parity
  - actionable delivery-required checkpoint reference and drain enum
  - evidence time ordering and bounded claim/index identifiers
  - exact tick scheduler lineage and full seven-day horizon
  - predecessor outbox lineage and safe rollover identity

### 2026-07-30 — Identity-invariant final review pass 5

- intent_gap: 0
- bad_spec: 16 (high 10, medium 6)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - resolver-state-only linking and corrupt lone owner/index mismatch
  - owner-inclusive bounded ambiguity and two-row early stop
  - stale owner-backed mapping maintenance
  - exact memory/Dynamo mapping scope validation
  - unresolved nonempty/latest-summary consistency
  - unified observation digest with per-event one-year replay horizon
  - drain enum without boolean ambiguity
  - exact-tick monotonic continuation/scheduler lineage
  - FIFO decimal sequence validation and ordering

### 2026-07-30 — Identity-invariant review pass 6

- intent_gap: 0
- bad_spec: 6 (high 6, medium 0)
- patch: 0
- defer: 0
- reject: 19 (high 0, medium 8, low 11)
- addressed_findings:
  - none

### 2026-07-30 — Transactional-snapshot review pass 1

- intent_gap: 0
- bad_spec: 12 (high 8, medium 4)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - duplicate Dynamo transaction targets
  - aggregate-authoritative owner-without-index behavior
  - mapped reschedule destination resolution
  - monotonic version/candidate snapshot fencing
  - bounded validated pending-outbox selection
  - claimant trimming and delivered chronology

### 2026-07-30 — Transactional-snapshot review pass 2

- intent_gap: 0
- bad_spec: 0
- patch: 7
- defer: 0
- reject: 0
- addressed_findings:
  - single authoritative versioned identity aggregate
  - deletion of legacy identity-index reads, writes, and validator
  - bounded aggregate/canonical read confirmation retry
  - exact candidate-list and version transaction fencing
  - unresolved missing-to-unique race prevention
  - exact old/new identity transfer fencing
  - bootstrap operational-error preservation

### 2026-07-30 — Transactional-snapshot review pass 3

- intent_gap: 0
- bad_spec: 0
- patch: 20 (high 14, medium 6, low 0)
- defer: 2 (high 0, medium 2, low 0)
- reject: 0
- addressed_findings:
  - durable empty identity tombstones instead of aggregate deletion
  - monotonic aggregate versions across removal and reuse
  - twice-confirmed first creation and missing reads
  - canonical candidate ordering and bounded registration
  - pre-mutation rejection of a third candidate
  - unresolved-marker checks after identity revalidation
  - exact aggregate version fencing during bootstrap repair
  - stable hourly floor scheduler identity and seven-day horizon
  - memory/Dynamo aggregate parity without legacy identity indexes

### 2026-07-30 — Transactional-snapshot review pass 4

- intent_gap: 0
- bad_spec: 0
- patch: 26 (high 19, medium 7, low 0)
- defer: 0
- reject: 5
- addressed_findings:
  - versioned equal-bootstrap tombstone repair parity
  - identity-compatible candidate idempotency
  - four-attempt identity tuple snapshot retry
  - transactional unresolved duplicate fencing
  - exact mapping canonical-scope validation
  - safe-integer aggregate exhaustion guards
  - stale mapped-reschedule resolution ordering
  - exact scheduler acknowledgement IDs
  - durable workflow-scoped provider-event duplicate fences across continuations
  - globally ordered cycle/epoch-prefixed pending continuation keys
  - bounded two-sample identity ambiguity with overflow/conflict count
  - thirty-day unresolved observation/marker retention parity
  - terminal checkpoint replay without continuation dereference
  - monotonic continuation ordering across safe-integer epoch rollover
  - strict pending-versus-delivered physical partition state
  - pre-existing third-candidate overflow parity
  - one-year provider-event fence retention
  - predecessor-bound continuation attempt and outbox validation
  - no-publisher delivery barrier before provider work
  - uncertain Dynamo checkpoint transaction reconciliation
  - exact mapped canonical target scope at mutation time
  - guarded bootstrap canonical version increments

### 2026-07-30 — Transactional-snapshot review pass 5

- intent_gap: 0
- bad_spec: 0
- patch: 15 (high 10, medium 5, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - identity-tuple and canonical-version snapshot comparison with bounded retry backoff
  - conditional same-position provider-event fences without pre-read amplification
  - transactional aggregate fencing for duplicate unresolved observations
  - identity-compatible version-fenced candidate registration
  - bounded idempotent overflow evidence without third-candidate canonical creation
  - aligned thirty-day unresolved observation marker and payload retention
  - bounded ordered pending-row validation without hidden corruption
  - cursor-bound continuation-command and predecessor-attempt lineage enforcement
  - safe rollover predecessor ordering in the Dynamo store contract
  - stable UTC hour-floor scheduler windows and retry identity
  - bounded FIFO sequence validation before `BigInt` conversion
  - all-group FIFO execution through a concurrency-five pool

### 2026-07-31 — Transactional-snapshot iteration-5 independent final review

- intent_gap: 0
- bad_spec: 12 (high 8, medium 4, low 0)
- patch: 12
- defer: 0
- reject: 1 (scheduler exact-tick critique; UTC hour-floor generation is explicit)
- addressed_findings:
  - atomic run, cursor checkpoint, and continuation-outbox commit for every page
  - strict cursor/terminal run-status and continuation lineage
  - exact bootstrap canonical and aggregate repair fencing
  - equal-revision material-conflict rejection before replay acceptance
  - bounded workflow-scoped pending validation and lease/version limits
  - memory/Dynamo exact mapping and bootstrap validation parity
  - unique validated unresolved candidates with bounded version increments
  - compact aggregate-only overflow evidence without orphan rows
  - cross-position replay rejection before bootstrap accounting or mutation
  - malformed FIFO sequence fail-tail behavior
  - duplicate bootstrap participant rejection
  - delivered-partition uncertain-commit reconciliation

## Auto Run Result

Status: done

Final reset-audit result (2026-07-31): review-clean. Provider revision ordering remains separate from exact equality; legacy fingerprint proof requires all five revision fields to match across incoming, persisted, and canonical evidence. Rank mismatches in either direction are non-mutating, exact matches backfill safely, and Dynamo canonical proof remains condition-fenced against concurrent change. Final verification passed with 57 database tests, 22 provider tests, 28 worker tests, 4 CDK tests, full `pnpm check`, credential-free CDK synth, and `git diff --check`. Fresh blind and edge/concurrency reviews returned no findings.

Standing-approval reset (2026-07-30): the decisive post-iteration-5 review found cross-continuation cursor cycles, ignored `maxPages`, and execution-local bootstrap duplicate detection. The audit counter was reset automatically under the user's instruction to continue without pausing.

User resolution (2026-07-30): approved the transactional-snapshot reset. Re-derive identity resolution so owner, indexes, and canonical versions are observed and fenced consistently, then close remaining store-parity and continuation-validation gaps before review.

Transactional-snapshot reset result (2026-07-30): review-ready. The scoped identity claim is now a validated versioned aggregate containing its single bounded canonical candidate. New identity state writes create this aggregate atomically with canonical/index state. Unmapped provider-link transactions condition-check the exact aggregate version/candidate and canonical version/identity observed during resolution; a contract test interleaves an aggregate-version transfer after resolution and proves the mapping transaction fails without persisting the mapping. Legacy indexes remain bounded migration inputs and can only create an aggregate under the same canonical event fence. Memory maintains matching aggregate versions and validates seeded malformed state. Exact mappings validate their digest/provider/provider-event/sport/league scope, pending outboxes validate before selection, checkpoints and outboxes enforce canonical identifiers and 31-day windows, unresolved observation markers use one per-event formula and retention policy, drain results are explicit enums with actionable checkpoint references, exact-tick scheduler generations remain internally consistent, and FIFO groups validate/sort decimal sequence numbers. `pnpm check`, credential-free CDK synth, and `git diff --check` pass. Best-effort CDK diff reached asset bundling but its filtered package execution could not resolve the workspace `esbuild` binary; synth already bundled the same assets successfully.

Transactional-snapshot repair iteration 1 result (2026-07-30): review-ready. Present-state stale/lower-authority transactions now condition-check the aggregate without also writing the same item; the contract gateway rejects duplicate transaction targets and the complete store contract passes. Owner-without-index is explicitly valid aggregate-authoritative state, while contradictory extras remain deterministic corruption/ambiguity. Mapped reschedules resolve the destination before acquisition. Aggregate rows contain one bounded candidate and a positive version; every present-state provider link fences that exact version/candidate, while legacy migration conditionally creates version 1. Pending outbox discovery is capped at 100 validated rows, claimant identifiers must be trimmed and bounded, and delivered timestamps cannot precede their claims. `pnpm check`, credential-free CDK synth, and `git diff --check` pass.

Transactional-snapshot repair iteration 2 result (2026-07-30): review-ready. Because the feature is new and uncommitted, the legacy identity-index representation and migration logic were deleted rather than retained. A single versioned `IDENTITY_OWNER` aggregate now authoritatively stores one or two bounded canonical candidates; lookup validates each canonical reference and confirms the aggregate version/candidate list with a bounded retry. Provider linking, unresolved recording, bootstrap repair, and reschedule transfers fence the exact aggregate snapshot or its absence in the same transaction. Tests cover an aggregate changing during lookup, a missing aggregate becoming unique before an unresolved write, ambiguous candidates, transfer races, malformed/dangling aggregates, and preservation of bootstrap operational failures. `pnpm check` passes with 28 database tests and 20 worker tests; credential-free CDK synth and `git diff --check` also pass.

Transactional-snapshot repair iteration 3 result (2026-07-30): review-ready. Once an identity aggregate is created it is replaced, never deleted; candidate removal stores an empty sorted candidate list and increments the aggregate version, preventing ABA reuse. Physical absence is confirmed twice and is reserved for first creation. Candidate registration supports new and existing canonical rows, validates exact material identity, is bounded to two sorted candidates, and rejects collisions, overflow, or version exhaustion before mutation. Duplicate unresolved observations are accepted only after re-reading and confirming the identity snapshot, while newly resolvable identity and transaction-contention paths restart bounded resolution. Exact mappings validate their canonical target before revision handling. Scheduler generations use the stable UTC hourly floor, retries within an hour are byte-identical, the window remains exactly seven days, and batch acknowledgements must exactly cover submitted IDs. Checkpoint commits now validate complete run/command scope and position lineage; outbox IDs bind predecessor/attempt lineage, recovered and pending rows validate physical storage scope, and claim/delivery chronology is enforced at both store boundaries. Failed-audit IDs and timestamps derive from bounded logical failure state rather than wall-clock start time. `pnpm check`, credential-free CDK synth, and `git diff --check` pass.

Transactional-snapshot repair iteration 4 result (2026-07-30): review-ready. Equal bootstrap replay repairs a durable tombstone through an exact expected-version replacement in memory and Dynamo. Candidate registration is idempotent against the identity-relevant canonical tuple at its current version; aggregates retain at most two sorted candidate samples while `conflictCount` and `overflow` preserve bounded ambiguity for third-plus candidates. Resolution uses four bounded aggregate/canonical tuple snapshots, and duplicate unresolved markers return only behind a transactional identity fence; contention restarts that bounded loop. Durable workflow/window/provider-event markers reject duplicates across separate continuation executions before checkpoint advancement and are retained for one year beyond the window. Pending continuation keys encode a monotonic cycle and padded epoch so `Query Limit 1` returns the true predecessor even across safe-integer rollover. Continuation commits require cursor work to carry a predecessor-derived attempt; pending/delivered partitions, recovery, claims, chronology, and uncertain Dynamo responses validate complete lineage. A no-publisher pending intent blocks new provider work. Scheduler commands use the UTC hour floor exclusively and batch acknowledgements must exactly cover submitted IDs. `pnpm check` passes with 48 database tests and 21 worker tests; credential-free CDK synth and `git diff --check` pass.

Transactional-snapshot repair iteration 5 result (2026-07-30): review-ready. Identity resolution now confirms only the scoped identity tuple and canonical version across four bounded snapshots with short exponential retry backoff. Provider-event replay fences are written conditionally in the ingestion transaction, preserve the first page-position digest, accept exact-position replay, and classify cross-position duplicates without a per-event pre-read. Duplicate unresolved outcomes still complete through an exact aggregate-version or aggregate-absence condition check. Candidate registration accepts identity-compatible canonical versions, while third-plus candidates update bounded idempotent overflow evidence without creating orphan canonical rows. Unresolved observation markers and payloads share thirty-day retention; one-year workflow fences remain beyond supported checkpoint replay. Pending continuation reads validate a bounded ordered prefix before selecting the true predecessor, and cursor-bound commits require a continuation command whose attempt derives from predecessor lineage. FIFO handling validates bounded decimal sequence numbers before `BigInt`, preserves fail-tail ordering, and processes every group through a concurrency-five pool. Scheduler commands remain byte-identical within the UTC hour-floor generation. `pnpm check` passes with 48 database tests and 23 worker tests; credential-free CDK synth and `git diff --check` pass.

Transactional-snapshot iteration-5 independent final repair result (2026-07-31): review-ready. Every cursor page now atomically commits its durable run, checkpoint, and predecessor-derived continuation outbox, then yields to that fresh continuation; no intermediate cursor CAS can strand work. Cursor and terminal commits reject contradictory statuses or continuation presence. Bootstrap replay and repair fence the exact canonical version/identity and aggregate snapshot, with memory precomputing all versions and validating target canonical state before mutation. Equal provider revisions reject material conflicts even on same-position replay. Pending scans validate a bounded workflow-scoped prefix, physical partitions, embedded checkpoint scope, state, lease duration, and safe versions; uncertain commit recovery accepts only a matching pending or delivered outbox. Unresolved candidates are unique and validated before persistence, mutable row versions use bounded increments, and third-plus identity evidence is compact aggregate-only state with no per-candidate rows or orphan canonicals. Cross-position provider duplicates are rejected before bootstrap accounting/mutation. Malformed FIFO sequence metadata fails the complete group tail, and bootstrap pages reject duplicate participant IDs. The UTC hour-floor scheduler decision remains explicit. `pnpm check` passes with 52 database tests, 22 provider tests, and 24 worker tests; credential-free CDK synth and `git diff --check` pass.

User resolution (2026-07-30): approved a second non-convergence reset. Re-derive the identity model around a single atomic claim invariant, enforce parity in memory and Dynamo, and align continuation bounds with a concrete delivery/drain contract. Preserve the protected intent and all previously approved safeguards.

Second-reset implementation result (2026-07-30): re-derived from `6701400` with intent/KEEP preserved. A validated scoped identity claim is now authoritative for candidate lookup and bootstrap ownership; Dynamo atomically writes claim+event+legacy index, validates referenced events, and repairs only a valid missing legacy claim. Malformed/dangling claims fail before mutation, mapped scope includes provider/provider-event identity, and memory rejects reschedule collisions before mutation. Existing continuation validation, manual drain, scheduler horizon, replay retention, and strict persisted schemas remain. Full `pnpm check`, credential-free synth, and `git diff --check` pass.

Second-reset review repair iteration 1 triage (2026-07-30): bad-spec repair required. The prior implementation did not satisfy the approved invariant because mapped reschedule could delete identity ownership unconditionally, lookup repaired legacy state as a side effect, and tests did not prove atomic owner/index/event/history movement or destination-conflict rollback. Reopen from baseline `6701400`; require conditional old-owner release, conditional destination acquisition, conditional old-index deletion, event/history/mapping mutation in one transaction, read-only validated lookup, explicit legacy repair, memory/Dynamo parity, and adversarial transaction-item tests. Also replace continuation epoch reuse and prove a real no-publisher drain contract before returning to review.

Identity-invariant repair iteration 1 result (2026-07-30): review-ready. Dynamo mapped reschedules now condition-delete the old owner and legacy index for the exact canonical event, condition-acquire the destination only when absent or already owned by that event, and perform those writes with canonical/history/mapping/revision mutation in one transaction. A destination conflict rolls back all writes. Claim lookup strictly validates scope and referenced canonical identity without writing; trusted bootstrap is the only legacy repair path. Memory parity and tests cover release/reuse, destination protection, concurrent same-revision moves, malformed/dangling claims, read-only legacy lookup, replay, and generated Dynamo conditions. Continuation rollover chains identity through the prior durable run ID, cursors are bounded consistently, and `drainPendingContinuation` is the explicit external delivery API. Canonical evidence, provider revision rows, unresolved records, and embedded outbox windows received stricter exact validation. `pnpm check`, credential-free CDK synth, and `git diff --check` pass; CDK diff cannot run without an AWS account/app environment.

Identity-invariant repair iteration 2 result (2026-07-30): review-ready. Ownerless legacy indexes now resolve read-only as missing, one validated legacy candidate, or ambiguity; trusted ingestion migrates a single candidate claim transactionally and ambiguity remains unresolved. Lower-authority revisions are persisted before ownership-transfer checks without canonical/claim changes, with a conditional candidate-version/identity fence preventing stale links. Claims no longer carry a fake version, and canonical rows now retain validated league scope. No-publisher continuation work returns `delivery-required`; the public drain validates claimant/workflow identifiers. Direct and embedded cursors are bounded, and safe-integer rollover derives a new attempt lineage from the preceding durable run ID with stale-boundary replay tests. `pnpm check`, credential-free CDK synth, and `git diff --check` pass; CDK diff remains unavailable without a configured AWS account.

Identity-invariant repair iteration 3 result (2026-07-30): review-ready. A single reconciliation routine now validates owner, all legacy indexes, and every referenced canonical before classifying identity state, and is shared by lookup, bootstrap, and ingestion. Lower-authority legacy linking conditionally establishes the claim and maps the provider without canonical mutation; mapping transactions fence the exact candidate event version and identity. Memory validates seeded mappings/canonical rows through the same runtime validators. Continuation commits validate predecessor lineage, pending drains without a publisher raise a distinct delivery-required error, and scheduler commands use the exact hourly generation instant. Claim IDs, authority ranks, participants, and canonical provider revision counts are bounded. `pnpm check`, credential-free CDK synth, and `git diff --check` pass; CDK diff remains unavailable without a configured AWS account.

Identity-invariant repair iteration 4 result (2026-07-30): review-ready. Contradictory owner/index rows now produce ambiguity consistently in lookup, bootstrap, and ingestion tests. Legacy claim migration occurs before stale/equal revision exit and transactionally establishes mapping/claim with an exact event fence without canonical changes. Newly constructed canonical rows validate before writes, a 65th canonical revision provider is rejected before mutation, bootstrap material repair advances `updatedAt` monotonically, and evidence observation cannot follow retrieval. Delivery-required run records include the actionable checkpoint key; the public drain distinguishes no publisher, no work, and delivered. Scheduler IDs and seven-day windows derive from the exact generation tick rather than an hour floor. `pnpm check`, credential-free CDK synth, and `git diff --check` pass; CDK diff remains unavailable without a configured AWS account.

Identity-invariant final repair iteration 5 result (2026-07-30): review-ready. Identity resolution reads at most two legacy rows, validates every observed reference, rejects a lone owner/index mismatch as corrupt, and emits exactly two owner-inclusive candidate IDs for ambiguity. Stale/equal owner-backed unmapped events now establish mapping/claim maintenance without canonical mutation. Unresolved records require a nonempty observation history whose latest entry exactly matches the summary, and memory/Dynamo use the same per-event observation digest; Dynamo retains replay markers for the documented one-year horizon while post-horizon duplicate observations are explicitly acceptable. FIFO batches require decimal sequence metadata and sort within each message group. `pnpm check`, credential-free CDK synth, and `git diff --check` pass; CDK diff remains unavailable without a configured AWS account.

User resolution (2026-07-30): reset the exhausted review audit to iteration 0 and approve the FIFO group executor, indefinitely recoverable fresh-message continuation epochs, and transactional checkpoint/continuation/audit outbox design. Resume from the iteration-5 worktree without a baseline revert and preserve the intent contract plus all identity and storage safeguards.

Reset-audit repair iteration 1 (2026-07-30): implementation files were reset to baseline `6701400` while the intent contract, project context, and KEEP decisions were preserved. The implementation was re-derived with daily freshness, stable producer replay, strict sport+league FIFO groups, checkpoint epoch fencing, leased/discoverable outboxes, idempotent lost-response recovery, retention, repair validation, and alarms. Full local gates and credential-free synth pass; account-bound CDK diff remains unavailable.

Reset-audit repair iteration 2 (2026-07-30): implementation files were again reset to baseline `6701400` while preserving the intent contract and all KEEP decisions. Recovery is now exact-workflow scoped, does not steal cross-league work or silently skip the current request, and records late no-ops. Pending outboxes are workflow-partitioned and removed into TTL archives after conditional delivery; hourly refresh generations preserve delayed-retry identity while observing same-day changes. Permanent unresolved observation IDs remain idempotent after summary truncation/TTL, provider revisions have an explicit provider-row representation, and persisted mappings/outboxes are runtime validated. Full local gates and synth pass; CDK diff remains account-blocked.

Reset-audit repair iteration 3 (2026-07-30): implementation files were reset to baseline `6701400` again with intent and KEEP preserved. Failed attempts now use separate audit identities, replay no-ops are deterministic, equal bootstrap revisions cannot change material content, duplicate provider/bootstrap identities are rejected across pages, and all provider timestamps are canonical ISO. Persisted checkpoints validate their hash and full state; canonical events, mappings, provider revisions, and complete outbox commands reject malformed/unknown content. Active delivery leases and publish failures block provider work, pending intents order by epoch, Dynamo cancellation reasons distinguish contention from service failure, retained unresolved markers are bounded/TTL-backed, and bootstrap accounting conditionally rolls back on write failure. Full local gates and synth pass; CDK diff remains account-blocked.

Reset-audit repair iteration 4 (2026-07-30): implementation files were reset to baseline `6701400` with intent and KEEP preserved. Resolution now checks exact mapping, then scoped candidates, and invokes trusted bootstrap only for zero candidates; both stores reject a second canonical candidate for an existing identity. Terminal no-op audits use checkpoint time deterministically. Bootstrap request accounting retains actual provider calls even if later persistence fails, while the distinct failure audit records outcome and hourly workflow generations avoid permanent poisoning. Canonical events, provider revision versions, mappings, unresolved summaries, identity index rows, checkpoints, and outboxes now validate complete bounded schemas and digest/state relationships. Observation markers use documented one-year archive-safe retention, quota sums remain safe, and continuation epochs have no artificial ceiling. Full local gates and synth pass; CDK diff remains account-blocked.

Reset-audit final repair iteration 5 (2026-07-30): implementation files were reset to baseline `6701400` with intent and KEEP preserved. Dynamo bootstrap creation now conditionally claims a compact normalized-identity owner in the same transaction as the canonical event/index, and identity repair moves ownership transactionally; concurrent losers resolve without creating a second ID. Identity rows, unresolved nested observations, provider revision scope, and outbox command/checkpoint digests are strictly validated. Scheduler windows run from the exact tick instant through seven days, manual/no-publisher pagination commits a recoverable continuation outbox, and continuation epochs roll safely at the maximum safe integer. Compact unresolved markers remain retained for the documented one-year replay horizon. Full local gates and synth pass; CDK diff remains account-blocked.

## Status

done

## Completion Note

Ultimate context engine analysis completed — comprehensive developer guide created.

## Pagination Reset Implementation Log

### 2026-07-31 — Standing-approval pagination reset iteration 0

- Preserved the protected intent contract, prior KEEP decisions, and historical review logs while re-opening implementation at review iteration 0.
- Changed bounded execution to consume the exact atomically committed page continuation locally while page budget remains, so `maxPages` is honored without publishing a competing continuation; a crash after any page commit still leaves recoverable durable work, and the page-limit boundary retains one fresh pending continuation.
- Added a bounded durable cursor digest history and digest chain to checkpoints. Cursor repetition across separate continuation executions now fails with `cursor-stalled`, and exhaustion of the bounded history fails closed rather than continuing indefinitely.
- Replaced per-event provider-fence reads with a strongly consistent Dynamo `BatchGet` path using bounded 100-key chunks and bounded unprocessed-key retries.
- Changed foreground pending continuation claims to read and validate only the ordered head (`Query Limit 1`); the separate undelivered audit path remains bounded independently.
- Rejected duplicate FIFO `SequenceNumber` values for an entire message group before execution.
- Made scheduler enablement an explicit configuration flag that defaults to false, and added an optional configured SNS alarm action hook for all ingestion alarms.
- Added regression coverage for full `maxPages` execution, no competing publication, durable cross-execution cursor-cycle detection, duplicate FIFO sequence rejection, scheduler enable configuration, and SNS alarm actions.

### 2026-07-31 — Pagination reset repair iteration 1

- Moved next-position, cursor repetition, and continuation rollover validation immediately after provider-page validation and before bootstrap, canonical, mapping, history, or page-fence mutation.
- Replaced the fixed 256-cursor termination with a bounded 32-entry active tail, an append-only digest chain, and workflow-scoped individual Dynamo cursor markers retained through the replay horizon. Active cursor checkpoints require the current cursor digest at the history tail; start checkpoints require empty history.
- Kept a locally consumed predecessor in a claimed/recoverable state until the successor checkpoint, run, and continuation outbox commit succeeds. A successor commit failure leaves the predecessor claimed for lease-based recovery instead of falsely archiving it.
- Canonicalized semantic continuation comparison so object property insertion order cannot change uncertain-commit recovery behavior.
- Anchored provider-event fence expiry to the later of workflow end and observation time plus the replay horizon.
- Required canonical decimal FIFO sequence numbers, including rejection of leading-zero aliases, and preserved duplicate rejection before `BigInt` conversion.
- Added normalized bootstrap participant-ID uniqueness, a producer error alarm, strict scheduler environment parsing, and SNS topic ARN/stack-region validation.
- Added a crash-boundary regression proving predecessor recovery when the successor commit fails.
- Added workflow/window-scoped bootstrap markers for both canonical bootstrap IDs and normalized identities. Marker pairs are written as one bounded transaction, accept exact-position replay, and reject cross-position replay before canonical or identity mutation in memory and Dynamo.
- Added durable checkpoint bootstrap request/quota reservation and outcome state. A reservation is CAS-persisted before the provider call, provider/validation/marker failures persist a failed outcome, and retry cannot allocate or execute another call for that reservation.
- Bootstrap repair authority now compares against the canonical authoritative winner before the older bootstrap revision, preventing a lower-authority bootstrap repair from moving canonical or identity state.
- Provider-specific revision evidence now stores a bounded material fingerprint for normalized identity, start instant, and status; equal non-authoritative replay is compared against that provider's own prior payload rather than the current canonical winner.

### 2026-07-31 — Pagination reset repair iteration 2

- Bootstrap reservations now bind the bootstrap cursor and page ordinal. Successful validated responses are durably bounded in the checkpoint, actual quota is reconciled rather than pre-spent, and restart reuses the response without another provider call. Bootstrap cursor progress advances only after every canonical item completes idempotently.
- Reserved calls with an uncertain response return retry-required without re-calling the provider; failed calls remain deterministic failures. Reservation validation is status-dependent and succeeded reservations require a complete bounded response.
- Bootstrap ID/identity markers bind the reservation/page position, preflight the complete page before marker or canonical writes, and avoid empty Dynamo transactions.
- Added a durable provider-page fingerprint keyed by checkpoint position so same-position replay cannot union two incompatible page payloads.
- Canonical authority now selects the maximum of bootstrap and authoritative revisions. Provider ordering also includes a same-provider bootstrap revision, while legacy provider rows without fingerprints are atomically backfilled and skipped without comparing unrelated canonical material.
- Checkpoint commits validate the cursor-chain transition from the previous durable chain and require the active cursor digest at the history tail.
- Failure and retry audits use the active continuation command for the current page.
- Capped SQS event-source concurrency at five and added a received-minus-deleted partial-batch/backlog alarm alongside Lambda, queue-age, and DLQ alarms. The approved UTC hour-floor scheduler generation remains unchanged.

### 2026-07-31 — Pagination reset repair iteration 3

- Made predecessor consumption atomic with the successor checkpoint, run, and continuation-outbox commit; uncertain Dynamo responses verify the delivered predecessor archive before accepting recovery. Startup now drains the complete bounded pending chain, and delivery-required replay uses the durable checkpoint timestamp.
- Replaced embedded bootstrap responses with immutable response rows referenced by digest from the checkpoint. Reservations have five-minute leases and expired reservations can be taken over without spending another request allocation; successful restart replay validates and reuses the stored response without another provider call.
- Added durable bootstrap cursor history and chain state, including empty-page progress, and bound page markers to reservation/cursor position. Provider pages also persist a semantic fingerprint after duplicate preflight so same-position payload drift fails closed.
- Canonical authority compares every stored provider revision plus authoritative and bootstrap winners. Safe legacy fingerprint backfill preserves the stored revision tuple and only occurs when canonical identity/material and provider ownership match.
- Bounded event persistence to concurrency-five chunks within each page. Partial SQS batch failures now emit a direct CloudWatch embedded `FailedRecords` metric, and the alarm consumes that metric instead of inferring failure from received-versus-deleted queue traffic.
- The approved UTC hour-floor scheduler generation remains unchanged. Full `pnpm check` passes with 54 database, 22 provider, 28 worker, and 4 CDK tests.

### 2026-07-31 — Pagination reset repair iteration 4

- Bound atomic predecessor consumption to the exact claimed outbox ID, claimant, predecessor run, workflow scope, active continuation command, expected checkpoint position, and successor run. Pending-chain recovery now verifies emptiness after its bounded drain, so an exact boundary count succeeds while excess work is reported accurately.
- Bootstrap reservations persist an immutable identities/request digest envelope, canonical five-minute leases, cursor/page scope, and durable accounting. Every real provider retry consumes a new request allocation, transient failures remain retryable, and every restart checks the immutable response row before considering a provider re-call.
- Bootstrap response rows use a distinct content-addressed ID and validated `{id,reservationId,digest,payload}` envelope. Payload digests use an explicit canonical projection; memory storage clones on write and read. Checkpoints enforce reservation cursor/page/quota consistency and recompute the scoped bootstrap cursor chain and active tail.
- Canonical rows validate their authority pointer against the maximum bootstrap/provider revision, while candidate registration repairs legacy missing pointers without replacing newer revision evidence.
- Page event writes use bounded concurrency with `Promise.allSettled`, ensuring all sibling writes finish before failure propagation. Audit counters reset when a locally consumed continuation advances to a new run.
- Effective deployed FIFO group concurrency is capped at five by combining batch size one with event-source maximum concurrency five; page-write concurrency remains independently bounded at five. The approved UTC hour-floor scheduler generation remains unchanged.

### 2026-07-31 — Pagination reset final repair iteration 5

- Consumed predecessors now carry and validate the complete canonical active command, including page limits, page budget, scope, window, and expected continuation, in addition to recomputed outbox identity and exact checkpoint/run lineage. This is the explicit compatibility boundary for the new uncommitted format; no ambiguous legacy predecessor is consumed.
- Request limits apply only when allocating a real new provider attempt, allowing an already successful final allocation to replay. Stored successful responses add no cumulative or run quota, while fresh validated provider returns update the active run counters before later processing can fail. A succeeded reservation cannot be downgraded by a later validation path.
- Reservations preserve their original identity set across partial canonical progress and now persist authority rank. Checkpoint validation recomputes reservation ID and request digest from exact persisted scope, page position, cursor, ordinal, identities, provider, authority, window, and fixed limit; it also requires durable request/quota accounting.
- Bootstrap response fingerprints now include every canonical material field—league, participants and labels, phase, canonical key, status, cursor, quota, and complete revision tuple—in a stable explicit projection. Response envelope identity/reference/digest is checked before provider validation and replay.
- Bootstrap cursor-cycle rejection leaves the successful reservation intact instead of constructing a contradictory failed checkpoint. Cursor history/chain remains scoped and reset at a new targeted search, with exact chain and tail validation.
- Concurrent page persistence waits for every sibling and accumulates all fulfilled outcomes before propagating a failure, preserving accurate failure audits. Run counters remain isolated per locally advanced continuation run. The approved UTC hour-floor scheduler generation remains unchanged.

### 2026-07-31 — New pagination reset iteration 0

- Reset the pagination repair audit after final-5 nonconvergence while preserving the protected intent, KEEP decisions, and prior repair history.
- Lease timestamps now derive from one captured instant and remain exactly within the five-minute bound. Bootstrap provider identity, authority, and future-skew checks occur before any successful reservation transition.
- Dynamo bootstrap responses are split into immutable sub-90KB event chunks plus a compact manifest and reconstructed only after every bounded chunk is present. The manifest remains the final publication point, preventing a partial chunk set from appearing complete.
- A terminal bootstrap chain writes a checkpoint-scoped completion-position fence before provider-page persistence. Restart skips the already completed cursor-free bootstrap search instead of issuing it again.
- Continuation outbox identity now hashes the complete canonical command. Read compatibility accepts the prior uncommitted ID solely for discovery, while atomic consumption requires the new recomputed ID and full active-command equality.
- Successor commands carry the remaining local page budget, making crash recovery and local continuation consumption use the same budget topology. Root/manual commands are rejected at active cursor checkpoints unless they carry the exact expected continuation lineage.
- Bootstrap response fingerprints cover every material canonical field. Page event `allSettled` accounting and the authority-pointer safeguards from the prior repair remain intact.

### 2026-07-31 — New pagination reset repair iteration 1

- Terminal response manifests omit `nextCursor` instead of persisting an undefined attribute. Manifest reads require an exact envelope/payload schema, safe bounded chunk count, and complete chunk set; corrupt durable state is classified as persistence failure. Chunk and manifest conflict checks use recursively canonicalized semantic storage digests rather than object insertion order.
- A structurally valid real bootstrap response is charged to the active run immediately. Provider identity, authority, future-skew, duplicate, and quota rejection writes a durable failed outcome containing the actual request/quota usage before returning, preventing that spend from being reused; successful replay remains free.
- Failed reservation validation now permits only its bounded actual usage fields and never response references. Succeeded reservations remain non-downgradable.
- Continuation discovery retains explicit compatibility for the prior uncommitted outbox ID, but full-command identity is required for new writes and atomic consumption. Manual cursor entry remains rejected and successor commands retain deterministic remaining-budget topology.
- Provider legacy fingerprint comparison uses a persisted fingerprint only when that exact persisted revision is the selected provider prior, avoiding comparison of a lower provider row against a later winner.

### 2026-07-31 — New pagination reset repair iteration 2

- Every response chunk now has an exact `{index,digest,events}` schema. The compact manifest binds the ordered digest list and exact count; reassembly validates manifest schema, chunk presence, physical order/index, per-chunk semantic digest, and the existing aggregate payload digest before use.
- Provider throws and structurally invalid raw responses conservatively consume one request and one quota unit in the durable failed reservation. Structurally valid responses persist their actual usage before provider identity, authority, future-skew, duplicate, or quota rejection, preventing the same allocation or spend from being reused.
- Equal legacy provider evidence without a material fingerprint is accepted only when the selected provider prior is also represented by same-provider canonical authoritative/bootstrap material that exactly matches. Otherwise the ambiguous equal revision fails closed; a lower unrelated persisted row is never treated as proof.
- Store-level atomic predecessor consumption validates successor immutable scope/window/page limit and derives its remaining `maxPages` as `max(1, active.maxPages - 1)`, rejecting forged or inflated locally chained successors in both store implementations.

### 2026-07-31 — New pagination reset repair iteration 3

- Equal legacy provider evidence without a stored material fingerprint is no longer treated as automatically safe. Replay now requires same-provider authoritative or bootstrap evidence at the exact selected revision plus exact identity, start-time, and status agreement; missing proof or a mismatch fails closed with a provider revision content conflict.
- When that exact proof exists, the memory and DynamoDB implementations preserve replay behavior and backfill the material fingerprint so later comparisons use the normal fingerprint fence.
- Full quality gates pass after this repair: formatting, linting, typechecking, 54 database tests, 22 provider tests, 28 worker tests, 4 CDK tests, and production builds.

### 2026-07-31 — New pagination reset repair iteration 4

- DynamoDB legacy fingerprint backfill now condition-checks the complete canonical event snapshot used as proof in the same transaction as the revision-row replacement. This atomically fences its version, identity, start time, status, provider ownership, and authoritative/bootstrap revision evidence for both mapped and newly mapped replay paths.
- Added a DynamoDB race regression that changes canonical material after the proof read but before the transaction. The stale backfill is rejected and the legacy provider revision remains without a fingerprint.
- Memory storage remains atomic within its synchronous mutation path. Database coverage increases to 55 tests.

### 2026-07-31 — New pagination reset repair iteration 5

- Legacy fingerprint backfill now requires one exact revision across the incoming observation, persisted legacy provider row, and same-provider canonical authoritative/bootstrap proof. Provider-name agreement alone cannot authorize a backfill in either DynamoDB or memory storage.
- Older/equal mixed-revision combinations remain non-mutating: a persisted R1 row is not fingerprinted from canonical/input R2 material, and persisted R2 is not fingerprinted when canonical is R3 and input is R1. Exact persisted/input/canonical revision agreement still backfills normally.
- Added DynamoDB regressions covering the two mixed-revision cases and the exact-match success case. Database coverage increases to 56 tests.

### 2026-07-31 — Legacy fingerprint proof reset audit iteration 0

- Separated provider revision ordering from exact equality. Legacy fingerprint proof now compares all persisted revision fields—provider ID, authority rank, update timestamp, sequence, and revision token—across the incoming observation, legacy provider row, and canonical authoritative/bootstrap evidence.
- DynamoDB and memory regressions cover authority-rank mismatches in both directions, prove the legacy row remains unchanged, and preserve exact-match backfill. The existing DynamoDB interleaving regression continues to prove canonical evidence is transactionally fenced against concurrent changes.
- Database coverage increases to 57 tests; `compareRevision` remains limited to ordering decisions.
