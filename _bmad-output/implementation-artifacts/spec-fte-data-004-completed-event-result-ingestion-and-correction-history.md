---
title: 'FTE-DATA-004 Completed-Event Result Ingestion and Correction History'
type: 'feature'
created: '2026-08-03T19:00:00-04:00'
status: 'done'
baseline_revision: '2f1def3'
final_revision: '050561d'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0A-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** FIND THE EDGE has canonical schedules and immutable odds, but no authoritative completed-event pipeline. Grading and performance work cannot safely begin until final scores, terminal states, provenance, and later official corrections are durable and auditable.

**Approach:** Add strict provider-neutral result contracts, MLB/MLS validation, fixture-backed result adapters, exact-mapping orchestration, and a separate append-only result repository with a monotonic current projection. Poll recent completed events through a scheduler-ready worker while retaining unresolved mappings and correction history.

## Boundaries & Constraints

**Always:** Bind results only through an exact provider-event mapping; preserve provider and retrieval timestamps, provider revision, observed canonical version, terminal state, score scope, and source provenance; append every unique result version; advance current only by deterministic authority ordering; keep missing provider semantics explicitly `unknown`; isolate league failures and expose finalized/corrected/duplicate/unresolved/stale/failed counters.

**Block If:** A production provider cannot supply an authoritative terminal state or participant score without inference and no fixture-backed contract can preserve the distinction; enabling a paid provider or expanding licensed-data retention is required; a result correction would require destructive history rewriting.

**Never:** Name-match or bootstrap canonical events from result payloads; infer overtime, extra innings, postponement, cancellation, or no-contest from scores alone; overwrite result history; implement grading, performance aggregation, live scores, picks, or synthetic historical results; expose credentials or raw licensed payloads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First final | Exact mapping and valid final score | Append version 1 and advance current | Count finalized |
| Exact replay | Same provider revision and content | No duplicate history/current change | Count duplicate |
| Official correction | Newer provider revision with changed score | Append next version and advance current | Count corrected |
| Older arrival | Older provider timestamp/revision | Retain immutable evidence; do not regress current | Count stale |
| Unknown event | No exact provider mapping | Persist unresolved result observation only | Count unresolved; never create event |
| Terminal without score | Postponed, cancelled, or no-contest | Persist explicit terminal state with absent score | Reject contradictory score/state combinations |
| Delayed final | Event initially absent/non-final, then final appears | Later poll persists the final exactly once | Checkpoint remains retry-safe |
| Partial league failure | One league/provider page fails | Preserve successful league progress | Record redacted failure and retry only failed work |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- add provider-neutral immutable result observation, state, score, scope, and correction contracts without breaking the grading-facing legacy result.
- `packages/sports/src/shared/contracts.ts` -- add the sport-module result-validation port.
- `packages/sports/src/mlb/result.ts` and `packages/sports/src/soccer/result.ts` -- validate module-owned score shapes and legal final outcomes.
- `packages/providers/src/completed-results.ts` -- strict bounded result page contracts, adapter registry, and fixture adapters.
- `packages/database/src/result-repository.ts` -- memory contract and deterministic append/current transition rules.
- `packages/database/src/dynamodb-result-repository.ts` -- append-only history, conditional current projection, and unresolved-result persistence.
- `apps/workers/src/completed-result-orchestrator.ts` -- checkpointed exact-mapping ingestion and league/run telemetry.
- `apps/workers/src/completed-result-lambda.ts` -- strict scheduled/manual command boundary and runtime composition.
- `packages/config/src/feed-coverage.ts` -- versioned real/fixture results coverage and hourly cadence.
- `infra/cdk/src/foundation.ts` -- result worker, hourly rule, existing secret/table access, alarms, and least-privilege IAM.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts`, `packages/sports/src/shared/contracts.ts`, `packages/sports/src/{mlb,soccer}/result.ts` -- define result evidence and strict sport validators while keeping grading out of scope.
- [x] `packages/providers/src/completed-results.ts` and fixtures/tests -- implement bounded MLB/MLS result pages, registry resolution, revision/timestamp validation, and redacted stable failures.
- [x] `packages/database/src/result-repository.ts`, `packages/database/src/dynamodb-result-repository.ts`, and tests -- persist deterministic immutable versions, monotonic current state, conflicts, stale evidence, and queryable unresolved mappings with memory/Dynamo parity.
- [x] `apps/workers/src/completed-result-orchestrator.ts` and tests -- resolve `results` coverage, resume bounded pages, exact-bind events, validate by sport, persist results/gaps, and report per-league run counters without cross-league rollback.
- [x] `apps/workers/src/completed-result-lambda.ts`, `packages/config/src/feed-coverage.ts`, `infra/cdk/src/foundation.ts`, and tests -- wire hourly recent-result polling plus a bounded manual backfill command, using the existing table/secret and no broad IAM actions.
- [x] `docs/runbooks/results-ingestion.md` -- document polling window, delayed finals, correction audit, unresolved remediation, bounded backfill, alarms, credential handling, and rollback.

**Acceptance Criteria:**
- Given MLB and MLS fixture result feeds, when recent completed events are polled, then valid finals and terminal non-score states persist through the shared contracts with provider provenance and sport validation.
- Given a repeated final, when ingestion replays it, then history and current remain unchanged; given a newer corrected score, then a new immutable version is appended and current advances.
- Given stale, conflicting, malformed, oversized, cursor-stalled, or contradictory data, when processed, then it fails closed or remains non-current with a stable redacted reason and no partial authoritative result.
- Given an unknown or scope-mismatched provider event, when processed, then an unresolved observation is queryable and no canonical event or result is fabricated.
- Given one league fails, when a multi-league run completes, then successful league checkpoints remain durable and finalized/corrected/unresolved/stale/failed counts are queryable by run and league.
- Given infrastructure synthesis, when inspected, then the result worker is separately scheduled, concurrency-bounded, alarmed, secret values remain absent, and IAM does not permit table scans or unrelated secrets.

## Spec Change Log

- 2026-08-03: Implemented completed-result contracts, adapters, append-only persistence, exact-mapping orchestration, hourly infrastructure, tests, and operations runbook.

## Review Triage Log

### 2026-08-03 — Review pass 1
- intent_gap: 0
- bad_spec: 0
- patch: 20 (high 10, medium 9, low 1)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Disabled fixture-only scheduling and tied CDK assertions to the exact result worker, rule, alarm, and least-privilege policy.
  - `[high]` `[patch]` Added durable cursor checkpoints and continuation so bounded page runs resume without starving later results.
  - `[high]` `[patch]` Made duplicate-history retries repair the current projection and made unresolved-result replay idempotent with conflict detection.
  - `[high]` `[patch]` Replaced provider-participant casting with exact canonical participant resolution and exact-set validation.
  - `[high]` `[patch]` Added a single cross-provider current projection with direct numeric authority ordering.
  - `[high]` `[patch]` Persisted league/run counters and stable failure codes, then surfaced failed runs to Lambda retry and alarm behavior after independent work completes.
  - `[medium]` `[patch]` Added strict provider/revision/window/detail/participant validation, canonical score ordering, and null-safe manual command validation.
  - `[medium]` `[patch]` Added pagination for correction history and unresolved-result audit queries.
  - `[low]` `[patch]` Strengthened infrastructure tests so unrelated pre-existing resources cannot satisfy result-worker assertions.

### 2026-08-03 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 14 (high 6, medium 8, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Isolated scheduled and backfill checkpoint identities, rejected corrupt checkpoints before provider calls, and protected later league commands from secondary run-record failures.
  - `[high]` `[patch]` Preserved complete unresolved provider evidence and applied strict result, revision, timestamp, detail, and quarantine validation at the repository boundary.
  - `[high]` `[patch]` Made cross-runtime authority comparison bytewise deterministic and Dynamo history pagination globally ordered with validated opaque cursors.
  - `[high]` `[patch]` Corrected concurrent current-write classification and made partial-write recovery telemetry expose both duplicate history and repaired projection transitions.
  - `[medium]` `[patch]` Hardened invalid command handling, page bounds, future timestamps, authority values, and exact participant/result evidence contracts.
  - `[medium]` `[patch]` Made the fixture-only deployed handler fail closed and documented that production scheduling remains disabled until an authoritative adapter and mappings are configured.

### 2026-08-03 — Review pass 3
- intent_gap: 0
- bad_spec: 0
- patch: 10 (high 4, medium 6, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Made scheduled pagination resume under a stable checkpoint identity while retaining the original bounded window until completion.
  - `[high]` `[patch]` Replaced positional participant resolution with explicit provider-to-canonical associations so reordered mappings cannot swap scores.
  - `[high]` `[patch]` Bound pagination cursors to query kind and identity across memory and Dynamo repositories.
  - `[high]` `[patch]` Corrected duplicate-only replay telemetry while preserving duplicate-history/current-repair transition counts.
  - `[medium]` `[patch]` Enforced invocation cardinality, timestamp validity/skew, storage-key bounds, and stable redacted validation errors before provider work.
  - `[medium]` `[patch]` Rejected unknown revision fields at both provider and persistence boundaries.

### 2026-08-03 — Review pass 4
- intent_gap: 0
- bad_spec: 0
- patch: 5 (high 2, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Made resolved and unresolved identities ignore retrieval time so hourly re-polls deduplicate while immutable first-seen evidence is retained.
  - `[medium]` `[patch]` Applied sport validation before unresolved quarantine and closed/size-bounded provider result and score schemas.
  - `[medium]` `[patch]` Replaced mutable-offset memory history cursors with scoped stable authority keys to prevent concurrent insertions from skipping or duplicating audit rows.

### 2026-08-03 — Review pass 5
- intent_gap: 0
- bad_spec: 0
- patch: 4 (high 1, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Prevalidated complete provider pages before writes so a malformed later item cannot leave partial authoritative page state.
  - `[medium]` `[patch]` Fully validated persisted scheduled checkpoint windows before provider work and required unknown score scope for every non-final state.
  - `[medium]` `[patch]` Made normalized unresolved records replay-safe by verifying and stripping their generated IDs before stable identity comparison.

### 2026-08-03 — Review pass 6
- intent_gap: 0
- bad_spec: 0
- patch: 3 (high 1, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Rejected page items whose revision timestamp exceeds retrieval time before any page writes.
  - `[medium]` `[patch]` Canonicalized nested material for stable replay identity and guarded cumulative run counters against unsafe-integer overflow.

### 2026-08-03 — Review pass 7
- intent_gap: 0
- bad_spec: 0
- patch: 4 (high 2, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Rejected same-authority conflicting result content and removed canonical schedule version from provider-result identity while preserving first-seen metadata.
  - `[medium]` `[patch]` Closed resolved/unresolved persistence schemas and required a fresh, exact EventBridge envelope before selecting scheduled checkpoint mode.

### 2026-08-03 — Review pass 8
- intent_gap: 0
- bad_spec: 0
- patch: 1 (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Closed the Dynamo concurrent same-authority race by rechecking the consistent current record and failing conflicting content with `result-authority-conflict`.

### 2026-08-03 — Review pass 9
- intent_gap: 0
- bad_spec: 0
- patch: 3 (high 1, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Removed ID-based equal-authority current advancement so concurrent conflicting revisions cannot become authoritative by hash ordering.
  - `[medium]` `[patch]` Closed manual invocation envelopes and converted undefined/non-serializable detail failures into stable redacted provider errors.

## Design Notes

Result history is a separate aggregate from mutable canonical schedule history. A result record binds to stable canonical event ID and records the canonical version observed at ingestion; corrections never alter prior grading evidence. Provider semantics that are unavailable remain `unknown`, allowing a later authoritative provider to enrich future versions without fabricated metadata.

## Verification

**Commands:**
- `pnpm check` -- all formatting, lint, typecheck, unit, and build gates pass.
- `pnpm synth` -- credential-free infrastructure synthesis and assertions pass.
- `pnpm test:e2e` -- existing public application smoke remains green.
- `git diff --check` -- no whitespace or patch integrity errors.

## Dev Agent Record

### Implementation Plan

- Keep authoritative results separate from grading and mutable schedule history.
- Validate provider pages, exact mappings, participant scope, and sport semantics before persistence.
- Store immutable evidence first, then conditionally advance a deterministic current projection.
- Run each league as an independent bounded command and expose stable counters/failure codes.

### Debug Log

- The repository customization resolver required Python 3.11; customization was resolved manually from the base/team/user TOML layers as directed by the workflow.
- Credential-free CDK synthesis still requires the repository's existing cursor-secret ARN input; verification used a non-secret synthetic ARN.

### Completion Notes

- Added provider-neutral final, postponed, cancelled, and no-contest evidence with explicit score scope and provider authority.
- Added MLB and soccer validation, fixture result pages, exact-binding orchestration, unresolved quarantine, replay/correction/stale behavior, and Dynamo-backed append/current storage.
- Added an hourly, concurrency-bounded worker with restricted table permissions and an alarm; no secret access or table scans were introduced.
- `pnpm check`, `pnpm synth` (with synthetic ARN), `pnpm test:e2e`, and `git diff --check` all pass.
- Review hardening disabled fixture-only scheduling, added durable provider cursor continuation and run records, exact participant resolution, a single cross-provider current projection, numeric authority ordering, paginated repository reads, strict unresolved replay handling, and fail-after-independent-run signaling.
- Review hardening pass 2 scopes checkpoints by mode and polling window, preserves full unresolved evidence, enforces strict repository boundaries and globally stable pagination, isolates malformed commands and run-record failures, and makes the deployed fixture-only handler fail closed; fixtures execute only in acceptance tests.
- Review hardening pass 3 gives hourly schedules a stable continuation identity while retaining the original window, validates every invocation before execution, uses explicit participant associations, binds opaque cursors to their query, rejects unknown revision fields/future retrieval evidence, and distinguishes exact replays from repaired projections.
- Review hardening pass 4 makes repeated retrieval timestamps idempotent while retaining immutable first-seen evidence, validates sport semantics before unresolved quarantine, bounds and closes provider payload schemas, and uses last-sort-key memory pagination for concurrent-insert parity with DynamoDB.
- Review hardening pass 5 strictly validates persisted continuation envelopes before provider access, requires unknown scope for non-final terminal states, validates every page's mapping-independent sport semantics before any page write, and permits verified normalized unresolved records to replay idempotently.
- Review hardening pass 6 bounds revision timestamps by page retrieval, canonicalizes nested evidence objects for deterministic memory/Dynamo replay identity, and prevents cumulative counter overflow with a stable failure code.
- Review hardening pass 7 rejects same-authority material conflicts before history/current advancement, excludes canonical schedule version metadata from provider identity while retaining first-seen history, closes persistence top-level/score schemas, and requires a fresh exact EventBridge scheduled-event envelope for scheduled checkpoint mode.
- Final hardening removes content-hash tie-breaking from Dynamo current authority, proves both equal-authority race orders fail closed, closes the manual invocation envelope, and redacts undefined/circular detail failures as stable invalid-result errors.
- Expanded tests cover partial-write repair, unresolved replay conflicts, Dynamo continuation cursors, out-of-window/provider/participant rejection, strict manual command validation, durable cursor resume, failed-run signaling, and exact CDK result-resource boundaries.

## File List

- _bmad-output/implementation-artifacts/spec-fte-data-004-completed-event-result-ingestion-and-correction-history.md
- _bmad-output/implementation-artifacts/sprint-status.yaml
- apps/workers/package.json
- apps/workers/src/completed-result-lambda.ts
- apps/workers/src/completed-result-lambda.test.ts
- apps/workers/src/completed-result-orchestrator.test.ts
- apps/workers/src/completed-result-orchestrator.ts
- docs/runbooks/results-ingestion.md
- infra/cdk/src/foundation.test.ts
- infra/cdk/src/foundation.ts
- packages/config/src/feed-coverage.ts
- packages/config/src/index.test.ts
- packages/database/src/dynamodb-result-repository.ts
- packages/database/src/dynamodb-result-repository.test.ts
- packages/database/src/index.ts
- packages/database/src/result-repository.test.ts
- packages/database/src/result-repository.ts
- packages/domain/src/index.ts
- packages/providers/src/completed-results.ts
- packages/providers/src/completed-results.test.ts
- packages/providers/src/index.ts
- packages/sports/src/index.ts
- packages/sports/src/mlb/result.ts
- packages/sports/src/result.test.ts
- packages/sports/src/shared/contracts.ts
- packages/sports/src/soccer/result.ts
- pnpm-lock.yaml

## Auto Run Result

- Summary: Added fixture-backed MLB/MLS completed-result ingestion with strict provider and sport validation, exact event/participant mapping, append-only correction history, monotonic cross-provider current truth, unresolved evidence quarantine, durable continuation/run records, and disabled-by-default infrastructure pending a real authoritative adapter.
- Review: Nine adversarial passes repaired concurrency, replay identity, checkpoint, pagination, strict-schema, telemetry, page-atomicity, invocation provenance, and Dynamo current-projection edge cases. No work was deferred or rejected as noise.
- Verification: `pnpm check`, credential-free `pnpm synth`, `pnpm test:e2e` (6/6), and `git diff --check` passed after the final hardening pass.
- Residual risk: The deployed result scheduler intentionally remains disabled and its fixture-only runtime fails closed until an authoritative production results adapter and exact participant mappings are configured.
