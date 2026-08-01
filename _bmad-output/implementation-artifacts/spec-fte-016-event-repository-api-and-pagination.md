---
title: 'FTE-016 Event Repository, API, and Pagination'
type: 'feature'
created: '2026-07-31T00:00:00-04:00'
status: 'done'
baseline_revision: 'fd6c1cf'
final_revision: '679a89b'
review_loop_iteration: 5
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Canonical games are durable but cannot be listed without a table scan and omit the participant labels required by the Events Explorer. The frontend also lacks an authenticated, typed API for upcoming-event lists and event detail.

**Approach:** Persist display-ready canonical metadata and atomic scan-free event read projections, add a repository with signed filter-bound pagination, and expose authenticated list/detail HTTP endpoints with raw ISO and Eastern Time metadata. Treat FTE-DATA-002 as the multi-sport replacement for the older FTE-013/FTE-015 ingestion dependencies.

## Boundaries & Constraints

**Always:** Keep canonical event writes and read projections atomic; require sport, status, and Eastern calendar day for list queries; order by kickoff then event ID; recompute server-side query plans; authenticate every endpoint; return honest unavailable values when canonical competition metadata is absent; preserve raw ISO timestamps alongside `America/New_York` display metadata.

**Block If:** Deployment cannot receive a JWT issuer/audience or cursor-signing secret through configuration; a requested list shape cannot be served by DynamoDB Query without Scan; implementation would require exposing a provider credential or unsigned cursor.

**Never:** Scan the event table for normal reads; expose DynamoDB keys in cursors; accept cursor reuse under different filters; fabricate competition names; make routes public; add odds, watchlists, picks, or web-screen wiring in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| List day | Valid user, sport/status/Eastern day, optional league, limit | Stable kickoff-ordered page plus signed next cursor and freshness timestamp | No error expected |
| Detail | Valid user and existing event ID | Display DTO with participant labels, raw ISO, Eastern time zone, status and league key | Missing returns 404 |
| Invalid cursor | Tampered, expired, oversized, or different filters | No query executes | Safe 400 |
| Invalid auth | Missing subject or rejected JWT context | No repository read | Safe 401 |
| DST day | Spring/fall Eastern calendar date | Exact UTC half-open day range, no duplicate/skip at boundary | Safe 400 for invalid date |
| Corrupt storage | Malformed canonical/projection row | No partial response | Safe 500 and redacted structured log |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- canonical event schema and API-facing event DTO contracts.
- `packages/database/src/event-ingestion.ts` -- shared event validation and projection invariants.
- `packages/database/src/dynamodb-event-ingestion.ts` -- atomic canonical/projection bootstrap and movement.
- `packages/database/src/memory-event-ingestion.ts` -- production-contract parity for projection behavior.
- `packages/database/src/aws-dynamo-gateway.ts` -- strongly consistent base-partition Query primitives and atomic ingestion transactions; runtime roles never Scan.
- `packages/database/src/event-repository.ts` -- repository ports, filters, signed cursor envelope, and page contracts.
- `packages/database/src/dynamodb-event-repository.ts` -- scan-free list/detail implementation.
- `apps/api/src/` -- authenticated event HTTP contracts, handlers, Lambda adapter, and tests.
- `infra/cdk/src/foundation.ts` -- protected HTTP routes, authorizer, secret/config, exact non-Scan IAM, alarms, and fresh-table deployment precondition.
- `docs/event-api-deployment.md` -- fresh-table post-deploy fixture/provider ingestion and readiness/API smoke procedure.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` -- dependency substitution and story state.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts` -- persist bounded participant labels and define strict list/detail DTOs with ISO and Eastern metadata.
- [x] `packages/database/src/event-ingestion.ts`, `dynamodb-event-ingestion.ts`, `memory-event-ingestion.ts` -- construct and atomically move validated list projections whenever canonical kickoff, status, sport, or league visibility changes.
- [x] `packages/database/src/aws-dynamo-gateway.ts` -- add bounded strongly consistent base-partition Query operations and exact atomic projection writes without a Scan gateway.
- [x] `packages/database/src/event-repository.ts`, `dynamodb-event-repository.ts` -- implement detail and list-by-sport/status/Eastern-day or league/day with strict signed, expiring, filter-bound cursors.
- [x] `apps/api/src/**` -- add authenticated list/detail routes, typed envelopes, safe errors, and redacted structured observability.
- [x] `infra/cdk/src/foundation.ts`, `foundation.test.ts`, `app.ts` -- provision a new table plus protected scoped HTTP API, config-driven JWT/secret inputs, exact non-Scan IAM, metrics, and alarms without caller-controlled deployment gates.
- [x] `docs/event-api-deployment.md` -- document fixture/provider ingestion and explicit readiness/API smoke checks after fresh-table deployment.
- [x] `packages/database/src/*test.ts`, `apps/api/src/*test.ts`, `infra/cdk/src/foundation.test.ts` -- cover projection atomicity/movement, DST, pagination integrity, cursor attacks, authentication, corruption, and infrastructure.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- replace FTE-013/FTE-015 dependency with completed FTE-DATA-002 and mark lifecycle accurately.

**Acceptance Criteria:**
- Given a fixture-backed canonical event, when ingestion commits, then participant labels and its list projection commit atomically, replay is idempotent, and a kickoff/status/league change removes old visibility and creates new visibility in the same transaction.
- Given authenticated list filters, when the repository reads a page, then it uses DynamoDB Query only, returns stable kickoff/event-ID order, and traversing every signed page produces no duplicates or gaps.
- Given an Eastern calendar day including DST transitions, when converted to storage bounds, then the query covers exactly that local day as a half-open UTC range.
- Given a tampered, expired, oversized, or cross-filter cursor, when requested, then the API returns 400 without executing a database query or logging cursor contents.
- Given valid authentication with `events:read`, when list or detail succeeds, then the response includes raw ISO timestamps, `America/New_York` display metadata, league key as an explicitly provisional competition value, `projectionState: ready`, snapshot/nullable freshness metadata, and explicit event status.
- Given missing authentication, a missing event, or malformed stored data, when requested, then the API returns 401, 404, or redacted 500 respectively.
- Given synthesized infrastructure, when inspected, then a new owned table and protected `events:read` routes exist, JWT/secret inputs are configuration-driven, every deployed role lacks Scan, no import/migration/Step Functions resources or caller smoke boolean exists, and the post-deploy fixture/provider readiness smoke is documented.

## Spec Change Log

- 2026-07-31: Implemented FTE-016 and moved the story to review.
- 2026-07-31: Standing-approved simplification reset, audit iteration 0. Confirmed there is no deployed/prod brownfield target, reset implementation to `fd6c1cf`, and rederived a fresh-table-only contract. Removed all migration application, Scan gateway, Step Functions, migration IAM, marker/generation/job/outcome/receipt/snapshot-metadata, and backfill-runbook complexity. Canonical ingestion now owns labels plus detail/sport/league projections from its first atomic write; disposable environments reset and reingest. Added an operator predeploy projection smoke check and CDK confirmation block. KEEP from prior reviews where still relevant: strong primary partitions, temporal snapshot pagination, exact projection/pointer validation, seven-day closed-row retention, cursor/filter binding and rotation grace, scoped `events:read`, typed/redacted errors, telemetry, DST behavior, provisional competition metadata, and Dynamo/memory parity. All later migration-specific notes in this document are preserved as superseded audit history, not current requirements.
- 2026-07-31: Fresh-table bad-spec repair iteration 1. Removed the caller-controlled deployment boolean and projection-check script. CDK now always owns a newly created table; first canonical ingestion atomically establishes exact temporal detail/list projections plus a versioned readiness marker. Valid requests distinguish absent/uninitialized readiness from ready-empty partitions. Added strict TypeScript-only storage contracts, memory/Dynamo parity, bounded strong BatchGet retries, explicit fixture/provider post-deploy smoke guidance, HTTP no-store/error semantics, route-dimensional EMF, and API Lambda/5xx/latency/caught-5xx alarms.
- 2026-07-31: Bad-spec repair iteration 1. Trigger: the first implementation could not safely paginate a mutable GSI snapshot and had no brownfield path for canonical rows created before participant labels/projections existed. Amended the design to use retained temporal projection states bound to a fixed cursor `asOf`, stable keyset pagination shared by Dynamo and memory repositories, strict physical projection validation, authoritative-update repair, and a bounded explicit admin backfill. Also required domain-separated cursor keys loaded from Secrets Manager, mandatory deployment configuration, conservative freshness, runtime filter validation, custom 5xx telemetry, API access logs, and narrow projection writes. Known-bad state avoided: mutable replace/delete projections, numeric in-memory offsets, raw environment cursor secrets, fallback JWT values, and legacy rows that could never become listable. KEEP: atomic ingestion writes, Query-only normal reads, exact Eastern/DST bounds, authenticated typed APIs, provisional league metadata, cursor/filter binding and redaction, least-privilege API table access, and structured pseudonymous observability.
- 2026-07-31: Bad-spec repair iteration 2. Trigger: temporal rows on an eventually consistent GSI still cannot guarantee that page continuations see all projection writes committed before the fixed snapshot; migration and IAM boundaries were also not executable or narrow enough. Replaced the list critical path with strongly consistent base-table day partitions, server-commit temporal boundaries, bounded evaluated-row traversal, independently repairable projection families, and a separately deployed migration Lambda/CLI/runbook. Tightened migration filtering, physical-key validation, race guards, corrupt-row hashing, secret-ring reuse/schema, access-log redaction, worker IAM, and identity snapshot reads. Known-bad state avoided: GSI pagination gaps, provider timestamps as temporal truth, uncapped filtered queries, migration scans hidden inside runtime code, broad worker read/write grants, and access logs containing integration error messages. KEEP: all iteration-1 migration, temporal retention, keyset cursor, authenticated API, DST, provisional metadata, conservative freshness, secret rotation, observability, and strict validation decisions except the superseded GSI list path.
- 2026-07-31: Bad-spec repair iteration 3. Trigger: API errors were classified from message text, detail/backfill validation was incomplete, migration could falsely declare completion, and continuation was caller-driven with injectable Dynamo state. Amended the design with typed boundary errors, fully guarded auth, exact physical/detail/list validators, non-aborting durable migration accounting, strict generation completion markers, workflow-owned opaque continuation, active-list pointers on detail projections, canonical material CAS, repository-boundary filter validation, safe continuation on invisible-history budgets, and explicit snapshot/migration/freshness response fields. Known-bad state avoided: prefix-based 4xx/5xx decisions, malformed detail leakage, abort-on-first-corrupt migration, false-current empty results, raw Dynamo cursors accepted from callers, projection lifecycle drift after non-display revisions, inadequate retention TTLs, and history caps becoming 500s. KEEP: all iteration-2 strong base partitions, trusted chronology, isolated migration IAM, secret/error/access-log redaction, executable runbook, temporal snapshot, bounded work, authenticated API, DST and provisional metadata decisions.
- 2026-07-31: Bad-spec repair iteration 4. Trigger: in-memory commit-time allocation was not safe across Lambda instances, active projection integrity was not checked on every ingestion, migration restart/race behavior remained lossy, cursor/secret schemas were underconstrained, and read authorization lacked a required scope. Amended the design with persisted-detail-derived monotonic commit instants, exact detail/pointer CAS with reload/retry, strong active-row validation on all ingestions, independent backfill family repair, durable per-page workflow jobs, bounded targeted race retries, immutable outcome rows, validated completion state, internal empty-history advancement, exact partition-bound cursors, timed secret rotation grace, and `events:read` authorization. Known-bad state avoided: equal/reversed cross-Lambda effective times, silent skipped mutation with missing pointers, duplicate active rows after non-display revisions, migration restart from zero, false success with unresolved outcomes, chains of empty pages, loose LEKs, expired rotation keys, and authenticated-but-unauthorized event reads. KEEP: all iteration-3 typed errors, strong base partitions, trusted chronology, exact validators, temporal retention, isolated migration role, redacted telemetry/access logs, DST/provisional metadata, and snapshot/migration/freshness separation.
- 2026-07-31: Final bad-spec repair iteration 5. Trigger: incomplete migration markers were rejected as corruption, migration metadata could drift across pages, capped zero-visible pages could not advance, migration retry/state CAS was not durable enough, and projection freshness/material binding remained ambiguous. Amended the design so exact `complete:false` markers produce incomplete state, signed cursors bind migration generation/state and expose evaluation state, any capped LEK yields an advancing cursor, query limits honor hard remaining budgets, retry recomputes from strongly reread canonical/projection state, job state is authoritative and CAS-updated idempotently, remediation creates linked generations, failure output retains durable references, pointer reads are strong and transaction-fenced, freshness semantics are separated, and outcomes have bounded retention/deduplication. Known-bad state avoided: incomplete-as-corrupt responses, traversal metadata changes, stranded empty pages, over-budget queries, conflict retries using stale writes, concurrent job overwrites, count resets on resume, lost failure context, weak BatchGet reads, partially fenced transitions, and incoherent freshness. KEEP: all iteration-4 monotonic CAS, always-on pointer integrity, Dynamo/memory parity, typed errors, strong base partitions, secret rotation grace, scoped authorization, isolated migration role, exact validation, redacted telemetry, DST/provisional metadata, and seven-day temporal retention.
- 2026-07-31: Standing-approval non-convergence reset iteration 0. Trigger: migration schema version was still conflated with lineage generation, marker selection assumed one generation, invalid cursors could reach repository reads, and page side effects were not sufficiently owned by durable job progress. Reset the audit counter while preserving the intent and all prior KEEP constraints. Amended the design to separate fixed schema constants from arbitrary positive safe lineage generations, select markers by monotonic lineage tokens, validate filters/cursors before any repository read, retain cached rotation keys, conditionally prevent stale terminal regression, fully bind existing projections and saved pages, reconcile deterministic page side effects with authoritative CAS, strictly validate all job relationships, resume same-job nonterminal state automatically, constrain remediation ancestry, and distinguish page-full from evaluation-cap partial states. Known-bad state avoided: hardcoded generation selection, old jobs overwriting newer markers, DB access on malformed cursors, unowned audit effects after stale attempts, loose saved-page/job schemas, truthiness-based generation checks, and ambiguous evaluation state.
- 2026-07-31: Convergence bad-spec repair iteration 1. Trigger: migration repaired multiple unrelated events in one projection transaction, reused job generation as event material version, trusted canonical update time for visibility, and allowed operators to influence lineage ordinals. Amended the design to plan and transact each event independently under exact canonical/detail/pointer fences, use per-event material versions and trusted monotonic commit instants, replan bounded conflicts, allocate global migration ordinals atomically from a dedicated counter, link remediation to the exact terminal predecessor, reconcile page counts from deterministic per-event outcomes, tighten projection/secret/cursor validators, separate operational failures, correct request/error telemetry, validate event IDs as requests, and assert transaction/page/timeout budgets. Known-bad state avoided: mixed-event transaction overflow/coupling, generation/material collisions, historical visibility from provider timestamps, skipped lineage numbers, stale active rows during remediation, success metrics counted as failures, invalid TTL intervals, expired cursor acceptance, and corruption classification of operational errors. KEEP: all convergence-reset decisions including schema/lineage separation, strong base partitions, exact markers/job schemas, invalid-input zero reads, temporal pointers, Dynamo/memory parity, authenticated scoped API, isolated migration role, redacted telemetry, durable workflow state, and snapshot-stable pagination.
- 2026-07-31: Convergence bad-spec repair iteration 2. Trigger: per-event repairs were not durably receipted in the same transaction, page ownership did not fence stale workers, pointer/canonical validators could accept cross-event or incomplete material, and retry/cancellation/remediation semantics remained ambiguous. Amended the design with same-transaction event receipts and page-lease condition checks, exact receipt/page-result schemas, replay counting, strict pointer/canonical validators, bounded material increment, conditional-only race classification, terminal/idempotent conflict rereads, marker-loss semantics, targeted remediation from unresolved outcomes, bounded scan/repair budgets, keyed secret caches with rejected-load eviction, and executable concurrency/lost-response/fence tests. Known-bad state avoided: repeated material versions on retry, stale workers mutating after lease loss, closing another event’s rows, labels-unavailable treated as corruption, throttling treated as race, generation-minus-one assumptions, old marker losers failing terminal completion, full rescans for remediation, and cache poisoning across ARNs/clients. KEEP: all repair-1 per-event transactions, independent material/job lineage, globally allocated ordinals, trusted commit time, strong list partitions, scoped API, temporal validation, telemetry, memory parity, isolated migration IAM, and durable workflow decisions.
- 2026-07-31: Final convergence bad-spec repair iteration 5. Trigger: migration pagination synthesized continuation keys and skipped filtered canonicals; cached recovery trusted an unverified summary; remediation did not prove target retention/completeness; projection/cursor validators and terminal CAS behavior remained underconstrained. Amended the implementation contract to use DynamoDB’s actual LEK with an evaluated limit of 25, process every filtered canonical, renew/fence every event transaction, reconstruct cached pages from exact source snapshots and receipt rows, bind remediation to retained target count/digest, use the shared physical projection validator everywhere, distinguish exact page exhaustion, use constant-time cursor authentication with bounded issuance lifetime, retry failure CAS conflicts, and let older jobs terminalize without regressing a newer marker. Known-bad state avoided: synthesized LEKs, skipped matches, stale cached counts, expired remediation targets, malformed pointer date math, phantom cursors on exact pages, timing-leaky signatures, and marker races blocking audit completion. KEEP: all convergence repair-2 receipt, lease, lineage, strong-query, authenticated API, temporal retention, isolated migration IAM, and redacted observability decisions.
- 2026-07-31: Fresh-table bad-spec repair iteration 4. Trigger: fixed-snapshot pagination deleted/replaced projection history and could gap or duplicate under concurrent ingestion; handler error classification was overly broad; date, readiness, pointer-race, participant-label, cursor-secret, and empty-cursor contracts were incomplete. Amended the binding fresh-table design to retain versioned temporal projection rows beyond cursor validity, derive visibility from trusted monotonic materialization time, skip well-formed rows outside the cursor snapshot, use typed request errors only for 400 responses, validate real calendar dates, expose honest uninitialized list/detail state, retry bounded detail snapshot races, include authoritative labels in material identity, reject empty cursors, and enforce an exact refreshable secret-ring schema with canonical encodings. Known-bad state avoided: mutable projection deletion, provider-time visibility, false corruption/404 during updates, storage failures mapped to 400, normalized impossible dates, falsely ready empty/detail responses, idempotent label changes being ignored, partial rotation acceptance, and stale rejected secret caches. KEEP: fresh-table-only ownership with no migration/Scan resources, atomic canonical/detail/list projections, transactional detail reads, explicit DTO mapping, authenticated scoped API, redacted telemetry, memory/Dynamo parity, initialized readiness marker, bounded evaluation with `evaluationState`/`hasMoreUnknown`, DST correctness, and all prior green coverage.
- 2026-08-01: Fresh-table bad-spec repair iteration 5. Trigger: temporal transitions could reconstruct prior boundaries instead of fencing the strongly read persisted active bundle; detail snapshots did not prove complete cross-family public/material identity; exact-limit pages could emit phantom cursors; caught-error EMF and HTTP stage access logging were not fully deployable/observable; and previous cursor-key acceptance incorrectly coupled token expiry to rotation acceptance cutoff. Amended the binding design to strongly read and transaction-fence exact detail pointers plus active sport/league rows, allocate `commitAt` strictly after persisted active `visibleFrom` even across repeated/nonmonotonic provider timestamps, validate one transactional detail snapshot across every public/binding field, perform a bounded physical-successor probe at exact page capacity, emit valid route-dimensional `Caught5xx` EMF matching alarms, provision an explicit HTTP API stage and retained redacted access-log group, and accept an unexpired previous-key token only while trusted now is before `acceptUntil` while ignoring expired previous configuration without affecting current issuance. Known-bad state avoided: reconstructed temporal boundaries, equal/reversed visibility transitions, mixed-material detail DTOs, empty continuation pages, inert custom alarms, unobservable authorizer rejections, premature previous-key cursor invalidation, and previous-key configuration breaking current signing. KEEP: all repair-4 fresh-table-only, temporal-history, strict validation, typed error, DTO, bounded-query, scope/auth, redaction, DST, readiness, Dynamo/memory parity, secret-cache, and green-test decisions.

## Review Triage Log

### 2026-07-31 — Review pass
- intent_gap: 0
- bad_spec: 14: (high 8, medium 6, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Mutable projection replacement/deletion could skip or duplicate events across pages; rederive with retained temporal states and a cursor-fixed snapshot.
  - `[high]` `[bad_spec]` Legacy canonical events lacked participant labels/projections and replace-on-missing repair failed; add authoritative-update population plus explicit idempotent backfill.
  - `[high]` `[bad_spec]` Dynamo and memory repositories used divergent continuation models; require one persisted keyset contract.
  - `[high]` `[bad_spec]` Projection rows were not validated against physical keys, filter scope, IDs, or derived display fields; require strict end-to-end validation.
  - `[high]` `[bad_spec]` Cursor encryption/signing reused one raw environment secret; require domain-separated keys and cached Secrets Manager loading with rotation.
  - `[high]` `[bad_spec]` CDK synthesized public-contract infrastructure with invalid fallback JWT configuration; make issuer, audience, and secret configuration mandatory.
  - `[high]` `[bad_spec]` API caught 5xx responses bypassed Lambda error alarms; emit a custom metric and provision access logging plus 5xx/latency alarms.
  - `[high]` `[bad_spec]` Freshness reported request time for empty results and newest included data otherwise; return conservative oldest included freshness or explicit unavailable freshness.
  - `[medium]` `[bad_spec]` Runtime sport/status/league/event filters and decimal limit parsing were too permissive; define strict bounded validators.
  - `[medium]` `[bad_spec]` Projection updates rewrote visibility even for irrelevant provider revisions; emit projection writes only when index/display state changes or repair is required.
  - `[medium]` `[bad_spec]` Cursor retention was not tied to cursor lifetime; retain temporal states beyond maximum cursor validity.
  - `[medium]` `[bad_spec]` Equal-kickoff and all cross-filter cursor cases lacked complete coverage; add multi-page keyset and tampering tests.
  - `[medium]` `[bad_spec]` Concurrent status/league/kickoff movement and storage corruption paths lacked full tests; add transaction and validation coverage.
  - `[medium]` `[bad_spec]` Migration behavior was unspecified; add a bounded admin-only scan command with validation, unavailable reporting, idempotency, and fixture reingest/backfill tests.

### 2026-07-31 — Review pass 2
- intent_gap: 0
- bad_spec: 12: (high 8, medium 4, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Eventually consistent GSI reads can omit projection writes committed before cursor snapshot; move all list reads to strongly consistent base-table day partitions.
  - `[high]` `[bad_spec]` Provider observation time is not trusted transaction chronology; derive effective boundaries and TTL from monotonic server commit time.
  - `[high]` `[bad_spec]` Filtered temporal queries lacked evaluated-row/iteration caps and robust continuation state; bind snapshot plus physical LEK and enforce bounds.
  - `[high]` `[bad_spec]` Backfill did not validate physical canonical keys or independently repair detail/sport/league projections under races; require exact canonical material/version condition checks.
  - `[high]` `[bad_spec]` Migration was library-only and not operationally executable; add a separate Lambda/manual CLI, CDK resource/output, and runbook.
  - `[high]` `[bad_spec]` Normal worker retained Scan and broad read/write grants; replace with exact actions/resources and isolate Scan to migration role.
  - `[high]` `[bad_spec]` Secret ring could be loaded more than once and accepted weak rotation schemas; load once per request and validate exact current/previous distinct key IDs.
  - `[high]` `[bad_spec]` Access logs included integration error messages; remove potentially sensitive integration detail.
  - `[medium]` `[bad_spec]` Snapshot time and data freshness were conflated, especially for empty/migration-unavailable pages; define separate response fields/states.
  - `[medium]` `[bad_spec]` Projection versions could collide at the same server instant; enforce monotonic unique commit version/timestamp ordering.
  - `[medium]` `[bad_spec]` Backfill scan/filter accounting and corrupt-row reports were insufficiently bounded/stable; add evaluated/matched counters, continuation, targeted filtering, and hashed keys.
  - `[medium]` `[bad_spec]` Identity snapshot reads loaded excess canonical material; reduce them to the tuple/version required for transaction validation.

### 2026-07-31 — Review pass 3
- intent_gap: 0
- bad_spec: 13: (high 9, medium 4, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Message-prefix error classification can turn storage corruption into 400; introduce typed errors and explicit HTTP mapping.
  - `[high]` `[bad_spec]` JWT authorizer dereference occurred outside guarded handling; keep auth extraction safe and map missing subject only to 401.
  - `[high]` `[bad_spec]` Detail and existing projection rows lacked full physical/exact-schema validation; validate every key, field, bound, status, timestamp, version and derived display value.
  - `[high]` `[bad_spec]` Migration aborted on corrupt/unavailable rows and could lose progress; record stable outcomes and continue within bounded work.
  - `[high]` `[bad_spec]` Completion markers could report current with unresolved rows; require exact generation markers and zero corrupt/unavailable/raced outcomes after exhausted scan.
  - `[high]` `[bad_spec]` Caller-owned raw Dynamo continuation was injectable and not durable; automate continuation through Step Functions or SQS with opaque workflow-owned state, retries and failure visibility.
  - `[high]` `[bad_spec]` Existing detail/sport/league families were not independently validated/repaired under exact canonical CAS; make every family explicit.
  - `[high]` `[bad_spec]` Detail did not retain authoritative active list keys, allowing non-display revisions to break later closures; persist active keys and test non-display then display movement.
  - `[high]` `[bad_spec]` Invisible temporal history exhausting work caps became a 500 or unsafe terminal page; return a safe continuation and guarantee progress.
  - `[medium]` `[bad_spec]` Repository filters did not enforce canonical sport/league/status patterns and a real calendar date; validate before any read.
  - `[medium]` `[bad_spec]` Projection retention checks did not prove TTL exceeds maximum cursor expiry plus margin; bind validation to trusted clock and constants.
  - `[medium]` `[bad_spec]` Empty/current results conflated snapshot, migration state and freshness; expose separate fields and nullable freshness.
  - `[medium]` `[bad_spec]` Filtered migration Scan cost/metrics and failure visibility were underdocumented; add metrics and runbook guidance.

### 2026-07-31 — Review pass 4
- intent_gap: 0
- bad_spec: 13: (high 10, medium 3, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Process-local commit clocks can collide or reverse across Lambda instances; derive each instant from persisted active detail and trusted now under CAS/retry.
  - `[high]` `[bad_spec]` Non-display ingestions could skip validation of missing/corrupt active rows; strongly load and validate detail plus pointed sport/league rows every time.
  - `[high]` `[bad_spec]` Detail version advancement without display movement could duplicate or orphan active pointers; update detail/version idempotently while retaining exactly one active pair.
  - `[high]` `[bad_spec]` Backfill treated projection families as one unit; independently repair missing valid detail/sport/league while reporting corrupt families and requiring active detail.
  - `[high]` `[bad_spec]` Migration workflow could complete with unresolved outcomes or restart from the beginning; persist job state each page and branch strictly on outcome classes.
  - `[high]` `[bad_spec]` Canonical races were terminal without bounded targeted retry; retry raced IDs before final failure and keep immutable conditional outcomes.
  - `[high]` `[bad_spec]` API migration completeness did not validate the exact job/generation marker; require strict marker validation before reporting complete.
  - `[high]` `[bad_spec]` Detail reads could return while pointed list rows were missing/corrupt; verify pointers or a transaction-bound integrity stamp.
  - `[high]` `[bad_spec]` Repeated invisible-history pages could force clients through empty cursor chains; advance internally within caps and expose explicit unknown-more state only when necessary.
  - `[high]` `[bad_spec]` Cursor LEKs and snapshot values were not exact canonical physical schemas; bind non-empty key state to the expected partition and ISO snapshot.
  - `[medium]` `[bad_spec]` Retention lacked a generous explicit clock-skew margin; use and validate at least cursor lifetime plus margin, preferably 24 hours or seven days.
  - `[medium]` `[bad_spec]` Secret rotation metadata/encoding/grace was incomplete; require exact IDs/timestamps and accepted 32-byte base64 variants with sufficient previous-key validity.
  - `[medium]` `[bad_spec]` Authentication did not require event-read authorization; require `events:read` in both API Gateway authorizer configuration and handler context.

### 2026-07-31 — Final review repair pass 5
- intent_gap: 0
- bad_spec: 13: (high 10, medium 3, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Exact incomplete migration markers were treated as corrupt; validate both complete states and report incomplete honestly.
  - `[high]` `[bad_spec]` Migration generation/state could change between list pages; bind it into the signed initial cursor and continuation contract.
  - `[high]` `[bad_spec]` Work-capped pages with zero visible rows could strand clients; return an advancing signed cursor and explicit partial evaluation state whenever LEK remains.
  - `[high]` `[bad_spec]` Query calls could exceed the hard remaining evaluation budget; cap every request to a positive remaining allowance.
  - `[high]` `[bad_spec]` Backfill conditional retries reused stale writes; strongly reread canonical plus all families and recompute each retry, recognizing already-repaired state.
  - `[high]` `[bad_spec]` Canonical version/detail mismatch was misclassified as corruption; treat it as a race while preserving true material corruption reports.
  - `[high]` `[bad_spec]` Operational failures were folded into corrupt-row outcomes; propagate them for workflow retry.
  - `[high]` `[bad_spec]` Step Functions input could overwrite authoritative job state and lost-response retries could double count; use exact versioned job-state CAS and idempotent pages.
  - `[high]` `[bad_spec]` Concurrent same-job executions and mid-scan resumes could overwrite cursor/counts; serialize through persisted versioned state and retain cumulative counts.
  - `[high]` `[bad_spec]` Terminal remediation reused old counts/generation; create a linked new generation and preserve prior job audit.
  - `[medium]` `[bad_spec]` Failure output omitted durable job/cursor context; retain job ID, generation, counts and cursor reference for alarm/runbook recovery.
  - `[medium]` `[bad_spec]` Detail pointer BatchGet consistency and ingestion transaction fencing were not explicit enough; require strong reads and one exact fenced pointer/material bundle.
  - `[medium]` `[bad_spec]` Non-material updates and outcome retention had ambiguous freshness/deduplication; separate freshness clocks and define TTL/cleanup with cross-job dedupe.

### 2026-07-31 — Standing-approval convergence reset
- intent_gap: 0
- bad_spec: 11: (high 8, medium 3, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Migration schema version and lineage generation were conflated; separate constants and accept any bounded positive generation.
  - `[high]` `[bad_spec]` Marker reads expected one hardcoded generation; select the latest valid monotonic lineage token and enforce predecessor relationships.
  - `[high]` `[bad_spec]` Stale terminal jobs could regress a newer marker; conditionally publish only newer valid lineage.
  - `[high]` `[bad_spec]` Invalid filters/cursors could cause marker/event reads; fully validate request and signed cursor with cached keys first.
  - `[high]` `[bad_spec]` Page projection/outcome effects could outlive a failed job-state CAS; transact them together or reconcile deterministic effects before authoritative progress CAS.
  - `[high]` `[bad_spec]` Existing list rows were not fully material-bound to detail during backfill; validate exact binding before reuse or repair.
  - `[high]` `[bad_spec]` Migration job and saved page-result schemas allowed relationship ambiguity; require exact fields and cross-field invariants.
  - `[high]` `[bad_spec]` Same-job restart and remediation ancestry were not safely defined; resume current nonterminal state and require terminal-incomplete predecessor for new generation.
  - `[medium]` `[bad_spec]` Safe integer checks relied on truthiness in places; validate zero/positive semantics explicitly.
  - `[medium]` `[bad_spec]` State-machine execution lacked an explicit timeout; add bounded workflow timeout and retained failure context.
  - `[medium]` `[bad_spec]` `evaluationState` did not distinguish a full visible page from evaluation-cap partial work; define separate states and marker/cursor semantics.

### 2026-07-31 — Convergence repair pass 1
- intent_gap: 0
- bad_spec: 12: (high 8, medium 4, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Page transactions mixed unrelated event repairs; transact one event at a time under exact fences.
  - `[high]` `[bad_spec]` Migration generation was reused as event material version; allocate independent per-event material versions.
  - `[high]` `[bad_spec]` Migration visibility used canonical/provider time; derive `visibleFrom` only from trusted monotonic commit time.
  - `[high]` `[bad_spec]` Canonical/detail/pointer races were not fenced in the event transaction; condition-check exact physical/material snapshots and replan bounded conflicts.
  - `[high]` `[bad_spec]` Remediation did not reliably close existing active rows; load exact pointers and idempotently close/move them.
  - `[high]` `[bad_spec]` Operators could choose or skip lineage generations; atomically allocate a global ordinal and require exact predecessor linkage.
  - `[high]` `[bad_spec]` Page job counts could precede durable per-event results; reconcile authoritative counts from deterministic event outcomes.
  - `[high]` `[bad_spec]` Operational failures were classified with data outcomes; propagate them for retry while retaining distinct race/unavailable/corrupt results.
  - `[medium]` `[bad_spec]` Projection temporal/TTL/display validation was incomplete; enforce valid intervals, retention margin, and derived Eastern values.
  - `[medium]` `[bad_spec]` Secret/cursor validation allowed ambiguous encodings or expired states; require canonical distinct rings, grace, and strict expiry.
  - `[medium]` `[bad_spec]` API request/error metrics were inconsistent and invalid event IDs could become server errors; correct EMF and typed 400 mapping.
  - `[medium]` `[bad_spec]` Transaction/page/timeout budgets were not mechanically asserted; add limits and tests.

### 2026-07-31 — Convergence repair pass 2
- intent_gap: 0
- bad_spec: 12: (high 9, medium 3, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Event repair had no atomic idempotency receipt; write an exact receipt in the same fenced transaction as projection changes.
  - `[high]` `[bad_spec]` Replayed pages could allocate new material versions and count again; validate receipts and count each physical canonical once.
  - `[high]` `[bad_spec]` Stale workers could repair after page lease loss; condition-check exact job/page lease token in every event transaction.
  - `[high]` `[bad_spec]` Pointer validation could close another event's rows; fully bind physical and embedded event/family/material fields.
  - `[high]` `[bad_spec]` Canonical validation was insufficient before writes; require strict bounded participants, labels, keys, status and timestamps with unavailable labels distinct.
  - `[high]` `[bad_spec]` Material-version increment could overflow; explicitly guard safe increment.
  - `[high]` `[bad_spec]` All Dynamo cancellations were treated as races; only pure conditional failures are races and service failures propagate.
  - `[high]` `[bad_spec]` Page result/cache and terminal conflict semantics were loosely bound; require exact schemas and idempotent terminal rereads.
  - `[high]` `[bad_spec]` Remediation rescanned broadly and assumed adjacent generations; target unresolved receipts/outcomes and link any lower allocated terminal predecessor.
  - `[medium]` `[bad_spec]` Older jobs losing marker CAS were incorrectly prevented from terminal completion; terminalize job without advancing current marker.
  - `[medium]` `[bad_spec]` Scan and repair page budgets were too broad; bound evaluated rows and at most five canonical repairs per page with metrics.
  - `[medium]` `[bad_spec]` Secret cache and previous-key expiry behavior could poison issuance/decode; key cache by configuration, evict rejected loads, and enforce per-cursor previous acceptance.

### 2026-07-31 — Fresh-table repair pass 4
- intent_gap: 0
- bad_spec: 10: (high 6, medium 4, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Concurrent ingestion could delete or replace rows needed by a fixed-snapshot cursor; retain closed versioned rows through cursor lifetime and use trusted monotonic visibility boundaries.
  - `[high]` `[bad_spec]` Ordinary well-formed temporal rows outside `asOf` were treated as corruption or could disturb continuation; skip them while advancing the physical keyset without gaps or duplicates.
  - `[high]` `[bad_spec]` HTTP 400 classification included errors beyond the two request-boundary types; map only `EventInputError` and `EventCursorError` to 400 and redact all storage failures as 500.
  - `[high]` `[bad_spec]` Detail pointer races could become false 404/corruption; transact exact pointer/material reads and retry bounded snapshot mismatch before deciding the result.
  - `[high]` `[bad_spec]` Participant-label updates were absent from idempotency/conflict material identity; make labels authoritative in Dynamo and memory fingerprints.
  - `[high]` `[bad_spec]` Uninitialized storage could be reported as ready-empty or missing detail; define an honest `projectionState: uninitialized` response contract for both list and detail.
  - `[medium]` `[bad_spec]` Calendar-day validation could normalize impossible dates; round-trip a real Gregorian date before deriving Eastern bounds.
  - `[medium]` `[bad_spec]` Empty cursor input was ambiguous; reject it before any repository read.
  - `[medium]` `[bad_spec]` Partial previous-key rotation objects and noncanonical secret encodings were accepted; require an exact all-or-none previous schema and canonical base64.
  - `[medium]` `[bad_spec]` Secret caches did not guarantee warm refresh or rejected-load eviction while expired previous keys could disrupt current issuance; refresh by TTL, evict rejected promises, ignore expired previous keys for decode, and keep current issuance healthy.

### 2026-08-01 — Fresh-table repair pass 5
- intent_gap: 0
- bad_spec: 6: (high 5, medium 1, low 0)
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[bad_spec]` Temporal transitions did not strongly read and fence the persisted detail pointer plus active list rows, and could reuse or reconstruct a visibility boundary; require exact persisted-bundle fencing and `commitAt` strictly later than every active `visibleFrom`, with three-or-more repeated/nonmonotonic timestamp tests in Dynamo and memory.
  - `[high]` `[bad_spec]` Detail reads could return a cross-family mixed-material DTO; require one transactional snapshot whose active sport and league rows exactly match the detail pointer and every public/binding field, otherwise raise typed storage corruption and return a safe redacted 500.
  - `[high]` `[bad_spec]` A page accepting exactly `limit` items could create a cursor when no physical successor existed; require one bounded successor probe that preserves the global evaluation cap and emits a continuation only when more physical work exists.
  - `[high]` `[bad_spec]` Caught-server-error telemetry was not guaranteed to be valid CloudWatch EMF matching the deployed alarm; require exact namespace, metric name, dimensions, and executable tests.
  - `[high]` `[bad_spec]` The HTTP API lacked an explicit retained, redacted access-log stage able to observe authorization rejections; provision and test the concrete stage, log group, safe format, retention, and alarms.
  - `[medium]` `[bad_spec]` Previous cursor-key decoding incorrectly required token expiry to precede the key acceptance cutoff; accept any otherwise-unexpired previous token while trusted now is before `acceptUntil`, ignore expired previous configuration, and keep current-key issuance operational.

### 2026-08-01 — Final review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` Cursor secret parsing accepted malformed rotation timestamps and a previous-key grace shorter than the advertised cursor lifetime; added canonical timestamp and minimum-grace validation with focused API coverage.
  - `[medium]` `[patch]` Stored projections could expose duplicate or excessive participant identifiers; bounded participant counts and rejected duplicates with repository corruption coverage.

## Design Notes

### Current binding fresh-table design

- This MVP has no deployed/prod brownfield table. `apps/migrations`, migration markers, generations, jobs, receipts, outcomes, repair scans, Step Functions, migration IAM, and the migration runbook are intentionally removed. The detailed migration notes below are preserved only as superseded review history and are not implementation requirements.
- Every FTE-DATA-002 bootstrap and authoritative canonical write includes bounded participant labels and atomically writes or moves the exact detail, sport-day, and league-day projection families. A canonical-only state is never a successful write. Disposable local/dev data is recreated and reingested from fixtures or the manual ingestion path.
- CDK always creates a new table and has no import/existing-table or caller-confirmation path. After deployment, operators run a fixture or configured provider ingestion and verify the readiness marker and authenticated API as a smoke test. Deployed ingestion/API roles have no Scan permission.
- The first successful canonical-plus-projection transaction writes exact `ProjectionReadiness` schema version 1; later successful ingestions update it in the same transaction. Valid requests read it before projections: absence reports `projectionState: uninitialized`; validity reports `ready`, including honest ready-empty days without fabricated freshness.
- List reads use strongly consistent primary day partitions and signed temporal snapshot cursors. Every queried row is physically and semantically validated before visibility filtering; malformed projections are storage corruption and return a redacted 500.
- Active projection rows omit `expiresAt`. Closed rows use exactly `ceil(effectiveTo/1000) + seven-day retention`; expired-but-not-yet-deleted closed rows remain invisible and are not corruption. Cursor lifetime is at most fifteen minutes.
- Cursor validation binds the exact filter and physical continuation, uses canonical delimiter-safe key IDs and base64url components, and enforces issuance, snapshot, future-skew, expiration, and previous-key grace bounds. Limits accept only canonical decimal strings.
- Projection `projectionUpdatedAt` equals `effectiveFrom`, canonical freshness never exceeds materialization, participant/source identifiers are unique, and detail pointer rows are loaded with strongly consistent BatchGet.
- Snapshot pagination retains immutable versioned list material after movement. Before every transition, Dynamo strongly reads the authoritative canonical plus persisted detail pointer and both active pointed list rows; memory uses the same authoritative persisted bundle. The transaction fences their exact physical keys, material version, visibility, and pointer identity, closes only those active rows, and creates replacements at `commitAt = max(trustedNow, every persisted active visibleFrom + 1ms)`. Provider `observedAt`/canonical `updatedAt` may inform canonical freshness but never reconstructs or lowers the temporal boundary. Closed rows remain retained for at least cursor lifetime plus safety margin. A cursor fixes `asOf`; well-formed rows whose interval does not contain `asOf` are normal history, are skipped rather than reported corrupt, and their physical keys still advance bounded traversal. Concurrent inserts/moves therefore cannot create cross-page gaps or duplicates.
- Dynamo detail uses one `TransactGetItems` snapshot for readiness/detail and its exact sport/league pointer keys, with a bounded retry only for a demonstrable concurrent pointer transition. Both pointed rows must be active (`visibleUntil: null`), eligible at the snapshot, and materially identical to detail across full physical PK/SK, embedded event/family identity, sport, league, status, day, labels, start/display timestamps, source freshness, material version, and every public DTO field. Any stable mismatch is typed `EventStorageCorruption` and produces a redacted safe 500; it is never combined into a partial DTO. Detail returns 404 only after a stable ready snapshot proves absence. Both list and detail return a documented unavailable envelope with `projectionState: uninitialized` when the exact initialized marker is absent; they never imply ready-empty or missing-event certainty before initialization.
- Participant labels are authoritative canonical display material. Their normalized bounded value participates in Dynamo and memory idempotency/conflict fingerprints and material-version decisions, so a label-only authoritative update atomically creates a new temporal detail/list state.
- Request boundaries map only `EventInputError` and `EventCursorError` to 400. Authentication/scope retain their explicit statuses; every gateway, malformed-storage, cryptographic-load, and unexpected failure is a redacted 500 with caught-failure telemetry. Eastern days must round-trip as an actual Gregorian `YYYY-MM-DD` before zone conversion.
- Cursor query parameters reject missing-value/empty cursor tokens. When a query accepts exactly the requested result limit, it performs at most one bounded physical-successor Query/probe within the same total evaluation cap; it issues a cursor only when a successor exists, so exact terminal pages never lead to an empty continuation page. Secret rings use an exact no-extra schema: canonical base64-encoded 32-byte current secret plus ID/creation time, and either every previous field or none. Invalid partial previous data fails closed. A previous key may decode an otherwise-unexpired token whenever trusted `now < acceptUntil`; token expiry need not be at or before `acceptUntil`. Previous configuration already outside its acceptance window is ignored without disabling current-key issuance. A container cache is keyed by secret/config identity, refreshes on a bounded TTL, shares in-flight warm loads, and evicts rejected promises.
- Caught server failures emit syntactically valid CloudWatch EMF with the exact deployed namespace, `Caught5xx` metric name, unit, and low-cardinality route dimension used by the alarm. CDK provisions an explicit HTTP API stage, a dedicated access-log group with finite retention, and a redacted format that records request/route/status/latency and authorization failures without JWTs, cursor values, integration error messages, provider credentials, or response bodies. Tests synthesize and bind these exact telemetry and stage properties.

### Superseded review design history

- Store append-only, versioned temporal projections directly in strongly consistent base-table partitions: `LIST#SPORT#{sport}#STATUS#{status}#DAY#{easternDay}` and `LIST#LEAGUE#{sport}#{league}#STATUS#{status}#DAY#{easternDay}`, ordered by `{startsAt}#{eventId}#{version}`. Normal list queries address exactly one partition and never use a GSI or Scan.
- Persist bounded `effectiveFrom`/`effectiveTo` visibility and retention longer than the maximum cursor lifetime. Effective boundaries, TTL, and monotonic unique versions come from trusted server commit time, never provider observation time. A first page fixes `snapshotAsOf`; every continuation carries the physical LEK and uses that snapshot so later inserts and event moves cannot create duplicates or gaps. Cap query iterations and evaluated rows. Dynamo and memory repositories share this persisted keyset model.
- Cursor payloads are versioned, opaque, expiring, and contain the fixed `asOf`, query fingerprint, and stable keyset. Derive independent encryption and signing keys with domain-separated KDF labels from a cached Secrets Manager value; accept the current and bounded previous rotation version. Clients never choose physical keys.
- Brownfield compatibility is explicit: legacy canonicals may omit participant labels. The next authoritative provider update supplies bounded labels and atomically creates missing projections without replace-on-missing assumptions. A bounded admin backfill may Scan only as an explicit migration, validates every legacy row, idempotently writes projections for label-complete rows, reports unavailable rows, and is never used by normal reads.
- Projection validators must bind value fields to physical base-table PK/SK keys, event ID, query filters, status/sport/league/day scope, temporal visibility, and display metadata derived from `startsAt`.
- Distinguish `snapshotAsOf` (pagination consistency boundary) from `freshnessAsOf` (oldest included source freshness). A fully evaluated empty partition returns `data: []` with explicit empty/current freshness state; migration-incomplete data reports unavailable rather than pretending there are no events.
- Backfill scans must use the strongest Dynamo filter available for `EVENT#.../CURRENT`, validate physical keys before values, bound evaluated and matched counts with continuation, repair detail/sport/league families independently, and condition-check the exact canonical version/material in each transaction. Corrupt rows expose only a stable hash of the physical key. Ship the migration as a separate Lambda/manual command and runbook; only its role receives Scan.
- The normal ingestion worker uses explicit required Dynamo actions/resources without Scan or broad `grantReadWriteData`. Secret rings are loaded once per request for both decode and encode, require an exact schema and distinct current/previous key IDs, and access logs omit integration error messages.
- Use a typed error taxonomy across repository/API/migration boundaries. Only validated request failures map to 400, absent authentication to 401, missing events to 404, and all storage/projection corruption to a redacted 500 plus caught-failure metric. Authorizer access is guarded.
- Detail projections persist the exact active sport/league list partition keys. Non-display canonical revisions retain these pointers; display or visibility changes conditionally close exactly those active rows and atomically establish the new set. Existing detail/list rows undergo exact physical and value validation before reuse or repair.
- Migration processes corrupt, label-unavailable, and canonical-race outcomes as durable bounded counters instead of aborting. Its exact generation completion marker is written only after the scan is exhausted and all such counters are zero; otherwise migration state remains incomplete. Continuation is owned by a Step Functions or durable SQS workflow with retries/backoff, DLQ or failed-execution visibility, schema-validated opaque state, an explicit start command, and no caller-supplied raw Dynamo cursor.
- Repository filters validate canonical sport, league, status, and real Eastern calendar dates before reads. Temporal retention validation proves TTL is at least maximum cursor expiry plus a safety margin using trusted server time. If invisible retained history consumes the evaluation budget, return a safe advancing continuation rather than a 500 or false terminal page.
- API list envelopes expose `snapshotAsOf`, `migrationState`, and nullable `freshnessAsOf` separately. Empty current pages never invent source freshness. Migration Scan cost and evaluated/matched/outcome metrics are documented and observable.
- Allocate each event projection commit instant as `max(trustedNow, persistedDetail.effectiveFrom + 1ms)` and condition-check the exact detail version/pointers plus canonical material in the same transaction. On conditional conflict, reload and retry within a bound. Retain closed states for at least the maximum cursor lifetime plus an explicit generous clock-skew margin.
- Every ingestion, including non-display revisions, strongly loads and fully validates active detail and both pointed list rows before deciding no projection movement is required. Missing or corrupt active state raises `EventStorageCorruption`; display/visibility changes close exactly those rows. Non-display canonical version advances update detail metadata idempotently without duplicating active list rows.
- Backfill repairs missing detail, sport, and league families independently but reports corrupt families. Current detail must be active (`effectiveTo: null`). Outcome rows are immutable conditional records. Durable workflow state persists job ID, generation, opaque continuation and cumulative counts after each page; restarts resume it. Zero unresolved outcomes completes, corrupt/unavailable outcomes fail and alarm, and raced IDs receive bounded targeted retry before failure.
- Detail reads verify their pointed active list rows (or a transaction-bound integrity stamp). List repositories consume invisible history internally within bounded work and only return a continuation with results, or an explicit `hasMoreUnknown` state when the server cap prevents certainty.
- Cursor payloads require canonical ISO `snapshotAsOf`, an exact non-empty physical LEK schema, and partition binding. Secret rings require exact distinct key IDs, `createdAt`, optional `previousValidUntil`, supported padded/unpadded base64/base64url encodings that decode to exactly 32 bytes, and previous-key grace no shorter than maximum cursor validity.
- API Gateway and the handler both require the `events:read` JWT scope. Authentication without this scope is forbidden and performs no repository read. Repository methods remain independently strict about all filters.
- Migration marker validation accepts exact versioned `complete:true` and `complete:false` schemas; incomplete is an honest migration state, not storage corruption. The first signed cursor binds migration job/generation/state, and continuations preserve it or reject a state mismatch. API pages expose `migrationState`, `evaluationState`, and `hasMoreUnknown` explicitly.
- If bounded evaluation stops with a physical LEK, always return a signed advancing cursor—even when no visible rows were produced—and label the page partial. Every Query limit is `min(configuredPageLimit, positiveHardRemainingAllowance)`; never issue a zero, negative, or over-budget read.
- Backfill retries strongly reread the exact canonical and detail/sport/league rows, recompute the repair plan, treat already-repaired families as success, classify version advancement as a race, retain corrupt-family reporting, and propagate operational failures. Strong BatchGet is mandatory for pointer bundles, and ingestion transactions fence one exact canonical/detail/list material bundle.
- Persisted migration job state, not workflow input, is authoritative. Exact schema/version CAS advances opaque cursor and cumulative counts once per idempotent page; concurrent executions cannot overwrite, and lost responses safely replay. Mid-scan restart resumes the same job. Remediation after terminal unresolved outcomes starts a linked new generation with reset counters and retained prior audit. Failure output and alarms retain job/generation/counts/cursor reference.
- Separate canonical/detail freshness from list projection freshness in DTOs, or transactionally rewrite list freshness on non-material updates; never imply projection evidence was refreshed when only metadata changed. Migration outcome rows use bounded TTL/cleanup and stable cross-job deduplication keys.
- Define `MIGRATION_SCHEMA_VERSION` independently from lineage `generation`. Generation is any explicitly validated positive safe integer. Current marker selection validates exact schema and chooses a monotonic lineage token derived from generation, job ID and predecessor; incomplete markers require unresolved outcomes and complete markers require zero.
- Validate all HTTP filters and the non-empty signed cursor structure/signature with a container-cached, TTL-refreshed current/previous secret ring before any marker, detail or list read. Rotation retains the previous key long enough to decode existing cursors. Invalid input performs no DynamoDB operation.
- Terminal marker writes are conditional on a newer valid lineage and predecessor relationship, so an older job cannot regress state. Existing list rows in backfill must exactly bind to detail material. Deterministic projection/outcome/page writes transact with job progress when possible; otherwise reconciliation proves ownership before a versioned CAS advances authoritative state, and stale attempts leave no unowned audit state.
- Migration job state and saved page results use exact no-extra schemas with explicit safe-integer checks and invariants across job ID, generation, predecessor, page ID/digest, cursor reference, cumulative counts, timestamps, status and version. The same job ID resumes its durable nonterminal generation automatically. A remediation generation requires the prior same-job lineage to be terminal incomplete.
- Bound the migration state-machine execution with an explicit timeout. `evaluationState` distinguishes a page filled to the requested visible limit from evaluation-cap partial progress; marker and cursor state remain stable and mutually consistent throughout traversal.
- Migration repairs one event per transaction. Strongly reread and validate canonical `EVENT#.../CURRENT`, exact detail and pointed rows; calculate `materialVersion=(existingDetail.materialVersion ?? 0)+1` and `commitAt=max(trustedNow, priorVisibleFrom+1ms)`. Close exact active rows and create replacement rows while condition-checking canonical key/version/updatedAt/material digest and existing detail version/pointers. Conditional conflict triggers bounded replan for that event; operational errors propagate.
- Remediation uses the same event planner, closes any prior active rows, and is idempotent when the exact desired projection already exists. `visibleFrom` is always trusted `commitAt`, never canonical/provider timestamps. Assert the maximum transaction-item count.
- Allocate migration lineage ordinals from a dedicated global counter through an atomic conditional operation. Callers cannot choose or skip ordinals. A remediation job receives the next ordinal only when linked to the exact terminal-incomplete predecessor; terminal marker CAS uses the allocated ordinal and lineage.
- Page progress derives authoritative cumulative counts only after deterministic per-event outcomes reconcile. Outcomes distinguish race, unavailable and corrupt data from operational failure, use stable physical cross-job dedupe keys and bounded TTL, and preserve per-job audit links.
- Projection validation requires `visibleUntil` null or later than `visibleFrom`, integer TTL no earlier than closed time plus cursor lifetime/skew margin, exact material binding, and Eastern day/local time recomputed from `startsAt`. Detail reads strongly validate pointed rows.
- Cursor secret rings require exact distinct key IDs and canonical accepted 32-byte base64 encodings with previous-key grace. Cursor expiry at or before trusted now is invalid. Invalid event IDs are typed request errors. Successful API telemetry emits one request and latency without `Caught5xx`; caught server failures emit `Caught5xx=1`. Scan page size, evaluation metrics, workflow timeout and transaction budgets are practical and asserted.
- Every migration event transaction condition-checks the exact canonical material and active page lease, applies close/put projection writes, and inserts a receipt keyed by job ID, generation, page ID and canonical physical key with `attribute_not_exists`. The exact no-extra receipt stores outcome, materialVersion and deterministic material/pointer digests. Retry validates an existing receipt and reconciles its count exactly once; it never creates another projection version.
- Page claim/progress CAS establishes an explicit lease token before execution. A worker whose lease expired or changed cannot write any event receipt/projection. Per-generation audit rows retain job/generation identity; separate stable unresolved fingerprints may deduplicate cross-generation remediation and use bounded TTL.
- Detail and all pointed rows validate full physical PK/SK plus embedded event ID, family, sport/league/day/status/labels/materialVersion and visibility intervals before closure. Canonical validation bounds participant counts/IDs/labels, keys, status and timestamps; missing labels yield `unavailable`, not corruption. Material versions increment only below `Number.MAX_SAFE_INTEGER`.
- Classify a Dynamo transaction cancellation as race only when every relevant cancellation reason is conditional; throttling, timeout and service errors propagate. After progress/terminal conflicts, reread exact persisted state and return the idempotent terminal result where applicable. An older job that loses current-marker CAS may still terminalize without advancing the marker.
- Saved page results use an exact schema bound to page/job/generation/source cursor and digest. Remediation links the exact same-job terminal-incomplete predecessor at any lower allocated ordinal and consumes its targeted unresolved receipts/outcomes instead of rescanning the entire table. Normal scan evaluates a practical bounded page and repairs at most five canonical events, emitting evaluated/matched/repair metrics.
- Cache secret-ring promises in a container Map keyed by ARN plus client/config identity and evict rejected promises. Current-key issuance remains valid when the previous key nears expiry; previous-key decoding succeeds only when the cursor expiration is within that key's `acceptUntil`. Add executable migration tests for start, run, fail, concurrency, lost-response replay, lease fences, marker loss and remediation.
- Infrastructure synthesis requires explicit JWT issuer, audience, and Secrets Manager cursor-secret identity. The API emits a custom metric for caught 5xx responses and provisions structured access logs plus 5xx and latency alarms.
- The old FTE-013/FTE-015 dependency is superseded by completed FTE-DATA-002, which provides the same ingestion/event lifecycle contract across multiple sports.

## Verification

**Commands:**
- `pnpm check` -- all formatting, lint, typecheck, unit, and build gates pass.
- `pnpm --filter @find-the-edge/database test` -- repository, projection, cursor, pagination, and DST tests pass.
- `pnpm --filter @find-the-edge/api test` -- auth, list/detail, error, and observability tests pass.
- `pnpm --filter @find-the-edge/infra-cdk test` -- strong base-partition reads, protected scoped routes, migration workflow, configuration, alarms, and exact IAM assertions pass.
- `FTE_JWT_ISSUER=... FTE_JWT_AUDIENCE=... FTE_EVENT_CURSOR_SECRET_ARN=... pnpm --filter @find-the-edge/infra-cdk synth` -- explicit-configuration synthesis succeeds and missing configuration fails closed.
- `git diff --check` -- no whitespace errors.

## Dev Agent Record

### Debug Log

- The customization resolver could not run because the system Python lacks `tomllib`; the documented manual fallback resolved the default workflow with no activation hooks and an empty completion hook.
- Added encrypted, HMAC-authenticated cursor bodies so DynamoDB continuation keys remain opaque rather than merely base64 encoded.
- Replaced CDK's broad read grant with explicit `GetItem` and `Query` permissions for the table and event GSI.
- Bad-spec repair iteration 1 reset the implementation surface to `fd6c1cf` and rederived it around retained temporal projection states, fixed-snapshot keysets, explicit brownfield repair/backfill, and Secrets Manager key rotation.

### Completion Notes

- Fresh-table repair iteration 5 was rederived cleanly from `fd6c1cf` as native strict TypeScript. Every authoritative transition strongly reads the persisted detail pointer and both active list rows, validates their exact material, and transactionally fences the old values while allocating `commitAt` strictly after both persisted `visibleFrom` values. Dynamo and memory tests cover three repeated/nonmonotonic observed timestamps.
- Detail reads validate one exact pointer-bound transactional sport/league snapshot across every public/material field and reject stable corruption. Exact-limit list pages perform a bounded successor probe before issuing a cursor. Previous cursor keys decode unexpired tokens only while `now < acceptUntil`, without coupling token expiry to the cutoff or disrupting current issuance.
- The handler emits valid `FindTheEdge/EventApi` EMF with route-dimensional `Caught5xx`. CDK provisions matching alarms, an explicit JWT-protected HTTP stage, and a retained 30-day redacted access-log group. Full `pnpm check`, 62 database tests, 4 API tests, 28 worker tests, 4 infrastructure tests, configured CDK synthesis, `git diff --check`, and the production-source artifact/suppression audit passed.

- Fresh-table repair iteration 4 was rederived cleanly from `fd6c1cf` as native strict TypeScript. Canonical writes now include authoritative participant labels in conflict identity and atomically create or move retained temporal detail/sport/league projections plus the initialized readiness marker.
- Snapshot list reads use bounded strong Query pages, skip valid history outside fixed `asOf`, and preserve physical continuation. Detail reads return honest uninitialized state and retry pointer/material snapshot races. API request typing, calendar validation, empty-cursor rejection, exact secret-ring parsing/cache refresh, scoped authorization, redacted telemetry, no-Scan IAM, alarms, and deployment guidance are implemented.
- Verification passed full `pnpm check` (57 database tests, 3 API tests, 28 worker tests, 4 infrastructure tests and all remaining workspace tests/builds), configured CDK synthesis, `git diff --check`, and an explicit production-source artifact audit with no `.js`, `.d.ts`, or source-map residue.

- Convergence repair iteration 3 rebuilds from `fd6c1cf`. Migration scans advance only from DynamoDB's actual `LastEvaluatedKey`, evaluate at most 25 rows, and process every returned canonical before advancing. Page ownership uses renewable generation/version/token leases; active owners receive a workflow-compatible `retryAt`, and repair/page transactions fence the renewed lease.
- Migration commands validate job identifiers, receipts retain exact no-extra schemas, page results bind their source cursor and deterministic receipt digest, and terminal conflict paths reread durable state. Executable migration contracts cover parsing, predecessor generations, lease claims/fences, lost-response receipts, and conditional-versus-operational failures.

- Standing-approval convergence reset rebuilt FTE-016 from baseline `fd6c1cf` without replaying historical patches. Canonical bootstrap and authoritative ingestion now transact exact temporal detail, sport/day and league/day projections with monotonic persisted detail commits, conditional active-pointer fencing, retained closed rows, and equivalent memory behavior.
- List/detail repositories validate exact physical and value schemas, query strongly consistent base-table partitions with bounded evaluation, preserve fixed snapshots, and authenticate encrypted filter-bound cursors against a cached rotating Secrets Manager key ring before any database access.
- The migration worker separates schema version from arbitrary safe lineage generation, strongly rereads filtered canonical scan results, independently repairs projection families, persists deterministic retained outcomes, atomically owns saved page results and versioned job progress, resumes lost responses, fences concurrent writers, emits monotonic terminal markers, and supports linked incomplete-generation remediation. The bounded Standard Step Functions loop retries service failures and records durable failure context before terminating.
- API and infrastructure enforce `events:read`, typed/redacted errors, caught-5xx EMF and alarm visibility, required JWT/secret configuration, Query/GetItem-only normal API reads, no Scan for ingestion/API roles, and Scan only for the migration role.

- Standing-approval convergence reset rebuilt FTE-016 from baseline `fd6c1cf` without replaying historical patches. Canonical bootstrap and authoritative ingestion now transact exact temporal detail, sport/day and league/day projections with monotonic persisted detail commits, conditional active-pointer fencing, retained closed rows, and equivalent memory behavior.
- List/detail repositories validate exact physical and value schemas, query strongly consistent base-table partitions with bounded evaluation, preserve fixed snapshots, and authenticate encrypted filter-bound cursors against a cached rotating Secrets Manager key ring before any database access.
- The migration worker separates schema version from arbitrary safe lineage generation, strongly rereads filtered canonical scan results, independently repairs projection families, persists deterministic retained outcomes, atomically owns saved page results and versioned job progress, resumes lost responses, fences concurrent writers, emits monotonic terminal markers, and supports linked incomplete-generation remediation. The bounded Standard Step Functions loop retries service failures and records durable failure context before terminating.
- API and infrastructure enforce `events:read`, typed/redacted errors, caught-5xx EMF and alarm visibility, required JWT/secret configuration, Query/GetItem-only normal API reads, no Scan for ingestion/API roles, and Scan only for the migration role.

- Convergence repair iteration 1 rebuilt from `fd6c1cf`. Migration lineage ordinals are allocated atomically by a dedicated counter; callers cannot choose or skip them, and remediation must name the exact immediately preceding terminal-incomplete lineage.
- Migration repairs one event per bounded transaction. Each attempt strongly rereads and validates the canonical row and active detail/list pointers, derives a per-event material version, allocates visibility from trusted wall time after the prior boundary, conditionally closes active rows, and fences canonical material and detail state. Conflicts replan within a bound; operational failures remain retryable rather than being mislabeled as corrupt data.
- Page totals advance only after deterministic per-event repairs or durable cross-job-deduplicated outcomes. Projection retention exceeds cursor lifetime and skew, while the workflow retains bounded page execution, timeout, retry, and durable failure behavior.
- API telemetry now emits `Requests=1` and latency for success without a failure metric, and `Caught5xx=1` only for caught server failures. Invalid event identifiers are typed 400 requests. Cursor expiration is exclusive and rotating secret rings require exact canonical base64 secrets, distinct IDs, and sufficient previous-key grace.

- Standing-approval convergence reset rebuilt FTE-016 from baseline `fd6c1cf` without replaying historical patches. Canonical bootstrap and authoritative ingestion now transact exact temporal detail, sport/day and league/day projections with monotonic persisted detail commits, conditional active-pointer fencing, retained closed rows, and equivalent memory behavior.
- List/detail repositories validate exact physical and value schemas, query strongly consistent base-table partitions with bounded evaluation, preserve fixed snapshots, and authenticate encrypted filter-bound cursors against a cached rotating Secrets Manager key ring before any database access.
- The migration worker separates schema version from arbitrary safe lineage generation, strongly rereads filtered canonical scan results, independently repairs projection families, persists deterministic retained outcomes, atomically owns saved page results and versioned job progress, resumes lost responses, fences concurrent writers, emits monotonic terminal markers, and supports linked incomplete-generation remediation. The bounded Standard Step Functions loop retries service failures and records durable failure context before terminating.
- API and infrastructure enforce `events:read`, typed/redacted errors, caught-5xx EMF and alarm visibility, required JWT/secret configuration, Query/GetItem-only normal API reads, no Scan for ingestion/API roles, and Scan only for the migration role.

- Convergence repair iteration 2 rebuilt the implementation from `fd6c1cf`. Migration event writes now carry exact job/generation/page/canonical receipts in the same transaction as the canonical fence and projection close/put operations, while each transaction condition-checks the page's current unexpired lease token.
- Page ownership is established by a versioned job CAS before scanning or remediation. Lost responses reuse exact cached page results and receipts without allocating another material version or count; terminal jobs commit independently of a losing older marker CAS.
- Canonical, detail, and pointed list material now use bounded exact validation, deterministic digests, safe material increments, and event/family/partition binding. Missing labels remain an explicit unavailable outcome, and only pure conditional cancellations are treated as races.
- Remediation allocates the next global ordinal for the same job from an exact terminal-incomplete predecessor and reads targeted unresolved rows rather than scanning. Scan work evaluates bounded pages, repairs at most five canonicals, and preserves the fifth physical key when more matches remain.
- Secret-ring promises are cached by ARN, client identity, and TTL configuration with rejected-load eviction. Current issuance is independent of previous-key age, while previous decoding is constrained by the individual cursor expiration.
- Executable migration, cursor/DST, API/auth/telemetry, secret-cache, ingestion parity, and infrastructure tests cover the iteration-2 contracts.

- Convergence repair iteration 1 rebuilt from `fd6c1cf`. Migration lineage ordinals are allocated atomically by a dedicated counter; callers cannot choose or skip them, and remediation must name the exact immediately preceding terminal-incomplete lineage.
- Migration repairs one event per bounded transaction. Each attempt strongly rereads and validates the canonical row and active detail/list pointers, derives a per-event material version, allocates visibility from trusted wall time after the prior boundary, conditionally closes active rows, and fences canonical material and detail state. Conflicts replan within a bound; operational failures remain retryable rather than being mislabeled as corrupt data.
- Page totals advance only after deterministic per-event repairs or durable cross-job-deduplicated outcomes. Projection retention exceeds cursor lifetime and skew, while the workflow retains bounded page execution, timeout, retry, and durable failure behavior.
- API telemetry now emits `Requests=1` and latency for success without a failure metric, and `Caught5xx=1` only for caught server failures. Invalid event identifiers are typed 400 requests. Cursor expiration is exclusive and rotating secret rings require exact canonical base64 secrets, distinct IDs, and sufficient previous-key grace.

- Standing-approval convergence reset rebuilt FTE-016 from baseline `fd6c1cf` without replaying historical patches. Canonical bootstrap and authoritative ingestion now transact exact temporal detail, sport/day and league/day projections with monotonic persisted detail commits, conditional active-pointer fencing, retained closed rows, and equivalent memory behavior.
- List/detail repositories validate exact physical and value schemas, query strongly consistent base-table partitions with bounded evaluation, preserve fixed snapshots, and authenticate encrypted filter-bound cursors against a cached rotating Secrets Manager key ring before any database access.
- The migration worker separates schema version from arbitrary safe lineage generation, strongly rereads filtered canonical scan results, independently repairs projection families, persists deterministic retained outcomes, atomically owns saved page results and versioned job progress, resumes lost responses, fences concurrent writers, emits monotonic terminal markers, and supports linked incomplete-generation remediation. The bounded Standard Step Functions loop retries service failures and records durable failure context before terminating.
- API and infrastructure enforce `events:read`, typed/redacted errors, caught-5xx EMF and alarm visibility, required JWT/secret configuration, Query/GetItem-only normal API reads, no Scan for ingestion/API roles, and Scan only for the migration role.

- Final repair iteration 5 binds honest incomplete migration metadata to signed traversal cursors and exposes `evaluationState`/`hasMoreUnknown`; capped pages always return a positive-budget advancing cursor when a physical LEK remains, including zero-visible pages.
- Migration schema 5 makes persisted job state authoritative with versioned CAS, deterministic immutable page results, lost-response replay without recounting, concurrent-writer fencing, cumulative mid-scan resume, linked remediation generations, 90-day deduplicated outcomes, strict terminal markers, and retained failure context.
- Backfill conflicts strongly reread and recompute canonical/detail/sport/league repairs; canonical advancement is a race, already-repaired state succeeds, corrupt material remains explicit, and operational failures propagate for workflow retry.
- Final iteration 5 verification passed `pnpm check`, configured CDK synthesis, focused database/API/migration/infrastructure tests, and `git diff --check`.

- Repair iteration 4 derives monotonic per-event commit instants from persisted active detail under exact canonical/detail/pointer CAS and bounded conflict reload. Every Dynamo and memory ingestion validates detail and both pointed active rows, including skip/non-display paths; non-display revisions update detail metadata without duplicating list rows, and display moves close exactly the retained pointers.
- Closed rows use validated seven-day retention. Detail reads verify transaction-bound integrity. Strict cursors bind canonical snapshot ISO and exact non-empty physical partition keys, internally advance invisible history within caps, and use rotation metadata whose previous-key grace covers cursor lifetime.
- Migration jobs durably persist job/generation/counters/opaque continuation per page, conditionally write immutable outcomes, retry raced IDs, and complete only with zero unresolved outcomes. API Gateway and handlers both require `events:read`.
- Iteration 4 verification passed `pnpm check`, 60 database contract tests including Dynamo/memory parity, configured CDK synthesis and infrastructure assertions, and `git diff --check`.

- Repair iteration 3 replaced message-text classification with typed request/auth/not-found/storage error boundaries and guards JWT authorizer access. Exact detail/list validators bind physical keys, exact row/value schemas, bounded labels and fields, canonical timestamps/status/version, derived Eastern display values, active pointers, and retention.
- Detail projections now preserve authoritative active sport/league keys across non-display revisions. Display changes close exactly those retained keys using trusted monotonic commit time, establish new versioned rows, and update the detail pointer atomically with canonical CAS; missing families repair independently.
- Migration iteration is workflow-owned by a retrying/backing-off Standard Step Functions loop. The public start command creates schema/job state, so operators never inject Dynamo cursors. Corrupt, label-unavailable and raced outcomes are hashed and durably recorded while bounded pages continue.
- Exact generation markers become complete only after scan exhaustion with zero unresolved outcomes. API envelopes expose snapshot, nullable source freshness, and migration state separately; evaluation-budget history returns an advancing signed continuation.
- Worker IAM excludes Scan and broad grants; migration Scan is isolated. JWT/secret configuration is mandatory, access logs omit integration errors, and caught storage failures emit redacted EMF. The runbook documents filtered Scan cost and workflow/failure metrics.

- Repair iteration 2 moved list reads to strongly consistent base-table sport/status/day and league/status/day partitions. Cursors retain the physical DynamoDB last-evaluated key and one fixed server snapshot while bounded traversal prevents unbounded evaluated work.
- Canonical bootstrap and material authoritative updates now persist labels and atomically create or move detail/sport/league projections. Closed temporal rows retain the original visibility boundary and live beyond cursor expiry; memory ingestion uses the same physical projection model.
- The operational backfill ships as a separate Lambda and manual CLI with evaluated/matched bounds, continuation, canonical scan filtering, physical-key-first validation, exact canonical snapshot checks, independent family repair, and hashed corrupt-key reports.
- The normal worker no longer receives broad Dynamo read/write or Scan permissions. Only the migration role can Scan; the API receives table GetItem/Query and its configured Secrets Manager read.
- The API uses mandatory issuer/audience/secret configuration, JWT-protected list/detail routes, an exact rotating secret-ring schema loaded once per request, redacted access logs, caught-5xx telemetry, and latency/error alarms.
- Iteration 2 verification passed `pnpm check`, focused database/API/infrastructure type checks and tests, explicit configured CDK synth, and `git diff --check`.

- Repair iteration 1 replaced mutable projections and offset pagination with retained temporal states and one `{startsAt,eventId,version}` keyset shared by Dynamo and memory repositories. Cursors fix `asOf`, so later inserts or lifecycle moves cannot create gaps or duplicates.
- Legacy events remain valid without labels; authoritative reingest fills labels and repairs missing projections, while the bounded admin-only migration reports unavailable rows and idempotently backfills label-complete rows.
- Projection validation binds canonical value, physical keys, GSI scope, filter scope, derived Eastern display values, temporal intervals, and cursor-safe retention. Empty freshness is explicitly unavailable; populated pages use the oldest included observation.
- Cursor keys are independently derived for encryption, signing, and filter binding from cached current/previous Secrets Manager rotations. Deployment configuration is mandatory, with no placeholder JWT or secret defaults.
- API infrastructure now includes structured access logs, custom caught-5xx metrics, and 5xx/latency alarms while retaining explicit Query/GetItem-only normal-read IAM.

- Canonical bootstrap now persists bounded participant labels and atomically creates detail, sport/status, and league/status projections; authoritative lifecycle updates atomically move all projections.
- Added scan-free Dynamo and in-memory repositories, exact Eastern-day/DST bounds, stable ordering, and encrypted signed expiring filter-bound pagination.
- Added authenticated list/detail API handlers with typed envelopes, safe 400/401/404/500 behavior, and redacted logs.
- Added bounded success and failure telemetry with pseudonymous authenticated-user IDs, route, cursor presence, result count, status, and latency; cursor and token values are never logged.
- Added the DynamoDB GSI, API Lambda, protected JWT routes, configuration-driven secret, least-privilege IAM, and API error alarm.
- Verification passed: `pnpm check`, focused database/API/infrastructure tests, CDK synth, and `git diff --check`.

### File List

- `_bmad-output/implementation-artifacts/epic-3-context.md`
- `_bmad-output/implementation-artifacts/spec-fte-016-event-repository-api-and-pagination.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/api/package.json`
- `apps/api/tsconfig.build.json`
- `apps/api/tsconfig.json`
- `apps/api/src/handler.ts`
- `apps/api/src/handler.test.ts`
- `apps/api/src/index.ts`
- `apps/api/src/lambda.ts`
- `apps/api/src/secrets.ts`
- `apps/workers/src/upcoming-event-orchestrator.ts`
- `docs/event-api-deployment.md`
- `infra/cdk/src/app.ts`
- `infra/cdk/src/foundation.test.ts`
- `infra/cdk/src/foundation.ts`
- `packages/database/src/aws-dynamo-gateway.ts`
- `packages/database/src/dynamodb-event-ingestion.ts`
- `packages/database/src/dynamodb-event-repository.ts`
- `packages/database/src/event-errors.ts`
- `packages/database/src/event-ingestion.ts`
- `packages/database/src/event-read-projection.ts`
- `packages/database/src/event-repository.ts`
- `packages/database/src/event-repository.test.ts`
- `packages/database/src/index.ts`
- `packages/database/src/memory-event-ingestion.ts`
- `packages/database/src/memory-event-repository.ts`
- `packages/database/src/store-contract.test.ts`
- `packages/database/tsconfig.json`
- `packages/domain/src/index.ts`
- `pnpm-lock.yaml`

### Change Log

- 2026-08-01: Fresh-table bad-spec repair iteration 5 rebuilt from `fd6c1cf`. Temporal transitions now fence strongly read persisted detail/sport/league material and remain strictly monotonic across repeated clocks; detail reads prove exact active cross-family identity; exact-limit pages probe for a physical successor; previous-key decode uses current acceptance time rather than token-expiry coupling; caught failures emit alarm-compatible EMF; and an explicit retained redacted HTTP stage observes authentication rejections.
- 2026-08-01: Repair iteration 5 verification passed full `pnpm check`, 62 database tests, 4 API tests, 28 worker tests, 4 infrastructure tests, configured CDK synthesis, `git diff --check`, and production-source artifact/suppression audits.

- 2026-07-31: Fresh-table bad-spec repair iteration 3 rebuilt production code from `fd6c1cf`. Detail now confirms the pointer plus both sport/league material rows with a transactionally consistent snapshot and exposes only `toEventDisplayDto` output. Projection, pointer, canonical identifier/status/time, active visibility, physical key and material-version contracts are exact. Cursor parsing is canonical base64url with fixed version/timing/filter-partition validation before readiness reads, AES-GCM authentication, bounded lifetime, distinct current/previous rotation IDs and refreshable rejected-evicting secret caches. Bounded Query pagination distinguishes complete/partial evaluation, reports unknown continuation honestly, and omits a terminal cursor when the exact physical page is exhausted. Fresh-table ingestion atomically creates/moves detail and list projections plus initialized-only readiness state in Dynamo and memory implementations. Protected API routes expose evaluation state and redacted dimensional EMF; deployment requires JWT/secret configuration, grants no role `Scan`, and documents separate FTE-DATA-002 count auditing.
- 2026-07-31: Repair iteration 3 verification passed full `pnpm check`, 60 database tests, 2 API tests, 4 infrastructure tests, configured CDK synthesis, and `git diff --check`.

- 2026-07-31: Fresh-table bad-spec repair iteration 2 rebuilt from `fd6c1cf`. Active temporal rows no longer carry TTLs; closed rows use ceiling-second close time plus retention and validators tolerate DynamoDB TTL lag. Pagination now uses bounded strong Query pages with actual physical LEKs inside encrypted, authenticated, versioned, filter-bound cursors; it can advance partial invisible-history pages without whole-partition reads. Readiness is an immutable initialized marker established atomically with the first projection transaction, detail uses strong pointer-bound BatchGet, non-display canonical revisions create fresh temporal material, API limits are strict decimal input, freshness is page-specific, and success/4xx telemetry omits the caught-5xx metric entirely.
- 2026-07-31: Fresh-table repair iteration 2 verification passed full `pnpm check`, 60 database tests, 2 API tests, 28 worker tests, 4 infrastructure tests, configured CDK synthesis, and `git diff --check`.

- 2026-07-31: Simplification reset iteration 0 rederived FTE-016 for a fresh table, removed every migration runtime/resource, made projection writes mandatory from first ingestion, added deployment smoke gating and local re-ingestion documentation, and retained the hardened query/cursor/auth/validation contracts.
- 2026-07-31: Simplification reset verification passed full `pnpm check`, 61 database tests, 3 API tests, 28 worker tests, 5 infrastructure tests, 2 predeploy smoke tests, configured CDK synthesis, explicit migration/Scan resource absence checks, and `git diff --check`.
- 2026-07-31: Added atomic event read projections, authenticated event APIs, secure pagination, infrastructure, and acceptance coverage.
- 2026-07-31: Reimplemented after bad-spec review with temporal snapshots, brownfield migration, rotated secret loading, strict validators, and API operational telemetry.
- 2026-07-31: Repair iteration 2 replaced the GSI critical path with strongly consistent base-table partitions and delivered isolated migration operations, exact IAM, physical-LEK cursors, bounded backfill/list work, and mandatory authenticated API configuration.
- 2026-07-31: Repair iteration 3 added typed boundary errors, exact active-pointer validation, durable non-aborting migration accounting, strict generation completion, Step Functions-owned continuation, and honest snapshot/migration/freshness envelopes.
- 2026-07-31: Repair iteration 4 added cross-Lambda monotonic detail CAS, always-on active-pointer integrity, Dynamo/memory parity, resumable strict-outcome migration jobs, exact cursor/rotation schemas, and scoped event-read authorization.
- 2026-07-31: Final repair iteration 5 added migration-bound partial-page cursors, authoritative versioned job CAS, replay-safe page accounting, linked remediation, retained deduplicated outcomes, and strict failure/completion recovery context.
- 2026-07-31: Convergence repair iteration 4 rebuilt from `fd6c1cf`, corrected continuation to the last physically processed row, restored exact shared projection/detail/pointer validation, bound migration marker identity into cursors, hardened job/page/receipt/lease and remediation semantics, added a timestamp-based lease wait, and passed full gates plus configured synthesis.

## Status

done

## Auto Run Result

- Summary: Added a scan-free authenticated event repository and HTTP API with stable temporal pagination, strict detail integrity, readiness/freshness metadata, and deployable observability.
- Files changed: Domain display metadata; DynamoDB and memory ingestion/read projections; repository, cursor, API, worker, CDK, deployment documentation, tests, and BMad tracking artifacts.
- Review findings: Two localized validation patches applied in the final pass; no deferred or rejected items.
- Follow-up review recommendation: false.
- Verification: `pnpm check`, 62 database tests, 4 API tests, 28 worker tests, 4 infrastructure tests, configured CDK synthesis, `git diff --check`, and generated-source audit all passed.
- Residual risks: Production data availability still depends on configured provider adapters/credentials; odds ingestion and Events Explorer UI remain subsequent MVP stories.
