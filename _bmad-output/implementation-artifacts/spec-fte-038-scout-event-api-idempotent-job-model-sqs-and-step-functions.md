---
title: 'FTE-038: Scout Event API, Idempotent Job Model, SQS, and Step Functions'
type: 'feature'
created: '2026-08-07'
status: 'in-review'
baseline_revision: '6c31eecffd09544b404400c41ff85e152269c608'
review_loop_iteration: 1
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/spec-fte-016-event-repository-api-and-pagination.md'
  - '_bmad-output/planning-artifacts/architecture.md'
warnings:
  - oversized
---

<intent-contract>

## Intent

**Problem:** The product has canonical events but no reliable command path for requesting a manual scouting run. A naive database write followed by a queue send can lose work, while repeated clicks, lost responses, queue redelivery, and concurrent retries can create duplicate analysis.

**Approach:** Add a versioned Scout Event job contract with requester-scoped request idempotency, event/input-scoped active-work convergence, immutable attempts, fenced state transitions, and a transactional dispatch outbox. Publish outbox records through a FIFO SQS buffer to a deterministic Standard Step Functions execution that runs only a fixture-labelled workflow skeleton. Expose authenticated create, status, and retry commands without defining the provider-backed scouting input or final report owned by later stories.

## Boundaries & Constraints

**Always:** Bind every job to an authenticated requester, exact canonical event ID/version, minimal server-authored workflow version, stable command digest, and safe timestamps. Require `events/scouting:write` for create/retry and `events/scouting:read` plus ownership for status. Persist the job, first attempt, idempotency receipt, active lock, and outbox atomically; use exact keys and conditional transactions without Scan. Treat the idempotency key and semantic active-work key as separate guarantees. Make attempts append-only, transitions version/state/attempt fenced, retries bounded to three total attempts, and duplicate/out-of-order messages idempotent. Accept only scheduled events with a stable initialized projection and recheck event version/status immediately before processing. Use a FIFO queue with DLQ, deterministic execution identity, Standard Step Functions timeout/retry/catch, least-privilege IAM, redacted logs, allowlisted safe failure codes, and low-cardinality metrics.

**Block If:** The command cannot verify an exact event/version; an anonymous mutation would be required; durable dispatch cannot be atomic with job creation; workflow state cannot be fenced to the current attempt; or implementation would freeze a production enrichment/report contract before FTE-039/FTE-040/FTE-041.

**Never:** Make Scout Event public; trust caller-supplied actor, event version, timestamps, input digest, state, attempt, execution ARN, or failure details; use SQS FIFO deduplication as the source of truth; overwrite an old attempt; retry a completed, active, or non-retryable job; expose internal keys, queue/Step Functions identifiers, raw exceptions, or provider payloads; scan DynamoDB; fabricate scouting inputs or a completed report; restore the removed hosted-login UI; or deploy merely to test.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| First request | Authorized requester, exact scheduled event, valid idempotency key | `202`, queued job, attempt 1, status location, one active lock and outbox | No error expected |
| Request replay | Same requester/key and exact normalized command | Return stored job without another attempt/outbox | Conflicting key reuse is safe `409` |
| Equivalent concurrent request | Different keys, same requester/event/version/workflow input | One transaction wins; loser returns the same active job | Never duplicate work |
| Event unavailable | Projection uninitialized/unstable, missing, non-scheduled, or version changes | No mixed-version job; safe unavailable/not-found/conflict response | No partial job records |
| Dispatch redelivery | Duplicate stream/SQS message or execution start | Exact current queued attempt starts once; later duplicates acknowledge | Malformed messages fail closed to DLQ |
| Workflow success | Current attempt claimed and fixture skeleton completes | `queued → in-progress → completed`; active lock released | No report is fabricated |
| Workflow failure | Allowlisted transient or terminal skeleton failure | Current attempt becomes retryable or terminal failed with safe code | Raw exception remains internal |
| Retry | Owner retries current retryable failure below limit | One linked next attempt and outbox; concurrent retries converge | Other states/limit return safe conflict |
| Lost response/publish failure | Transaction commits but delivery or HTTP response fails | Durable outbox/replay preserves recoverability | Job remains honestly queued |
| Unauthorized status | Missing scope, wrong requester, malformed/missing/corrupt job | `401`/`403`/`400`/`404`/redacted `500` | No existence or internals leak |

</intent-contract>

## Code Map

- `packages/domain/src/scouting-job.ts`, `packages/domain/src/index.ts` -- exact job/attempt/public DTO schemas, deterministic identities, legal transitions, safe failure codes, and retry policy.
- `packages/database/src/scouting-job-repository.ts`, `packages/database/src/dynamodb-scouting-job-repository.ts`, `packages/database/src/index.ts` -- memory/Dynamo parity for atomic create/deduplicate, ownership reads, attempt claims, terminals, retry, active locks, and outbox records.
- `apps/api/src/scouting-handler.ts`, `apps/api/src/handler.ts`, `apps/api/src/lambda.ts` -- strict authenticated create/status/retry boundary, canonical event lookup, safe HTTP mapping, and production repository wiring.
- `apps/workers/src/scouting-outbox-lambda.ts` -- filtered Dynamo stream publisher that validates exact outbox records and sends stable FIFO commands.
- `apps/workers/src/scouting-dispatcher-lambda.ts` -- SQS consumer that validates commands, starts the deterministic Standard workflow, and converges duplicate executions.
- `apps/workers/src/scouting-workflow.ts`, `apps/workers/src/scouting-workflow-lambda.ts` -- fixture-only claim/complete/failure skeleton with current-attempt fencing and safe retry classification.
- `infra/cdk/src/foundation.ts`, `infra/cdk/src/foundation.test.ts` -- protected routes/scopes, stream publisher, encrypted FIFO queue/DLQ, dispatcher, state machine, least-privilege IAM, outputs, metrics, and alarms.
- `packages/*/package.json`, `pnpm-lock.yaml` -- only the AWS SDK/runtime dependencies required by the new boundaries.

## Tasks & Acceptance

**Execution:**
- [x] Define the strict versioned Scout Event job/attempt command and public status contracts with deterministic hashes, exact state chronology, safe failure vocabulary, and three-attempt retry policy.
- [x] Implement memory and Dynamo repositories with exact-key reads and atomic idempotency receipt, semantic active lock, job, attempt, event-version condition, and outbox writes; add fenced claim/terminal/retry transitions and parity/concurrency tests.
- [x] Add authenticated `POST /events/{eventId}/scout`, `GET /scout-jobs/{jobId}`, and `POST /scout-jobs/{jobId}/retry` handlers with exact body/header/query validation, ownership, scopes, status/location semantics, and redacted typed errors.
- [x] Add a filtered Dynamo stream outbox publisher, FIFO SQS dispatcher, deterministic Step Functions execution, and fixture-only workflow transition handler that acknowledges exact replays and rejects stale attempts.
- [x] Provision protected API routes, Cognito scopes, encrypted queue/DLQ, Standard state machine, bounded retry/catch/timeout, narrow IAM, alarms, and safe outputs through CDK assertions.
- [x] Run focused domain/database/API/worker/infrastructure tests, the full local repository gate, and diff hygiene without deployment.

**Acceptance Criteria:**
- Given a valid authorized scheduled event, when Scout Event is requested, then the API derives the event version/workflow identity server-side and atomically persists exactly one queued job, first attempt, requester-scoped receipt, active semantic lock, and dispatch outbox before returning `202` with a safe status location.
- Given a lost response, same-key replay, or concurrent equivalent command with a different key, when creation repeats, then exact replay returns the original job, conflicting key reuse returns `409`, equivalent active work returns its winner, and no second attempt or outbox is created.
- Given duplicate, delayed, malformed, or out-of-order stream/SQS/workflow input, when processing occurs, then only the exact current queued attempt can claim and transition; duplicates converge safely, malformed work is redriven, and stale workers cannot overwrite a newer attempt.
- Given fixture success, retryable failure, terminal failure, workflow timeout, or retry, when the state changes, then chronology and state versions remain valid, safe failure metadata is persisted, the active lock is conditionally released at terminal state, and only one next attempt can be created below the fixed limit.
- Given create/status/retry HTTP traffic, when identity, scope, owner, event, method, content type, body, query, idempotency key, or job ID is invalid, then the API returns the correct safe `400`/`401`/`403`/`404`/`409`/`422`/`503` response without leaking raw errors or performing unauthorized work.
- Given synthesized infrastructure, when inspected, then Scout mutations are JWT-protected, no public write route exists, queue/DLQ encryption/redrive and Standard workflow timeout/retry/catch are explicit, IAM excludes Scan and wildcards, and queue-age/DLQ/workflow/API failure signals exist.

## Spec Change Log

- 2026-08-07: Created the executable FTE-038 contract from the Epic 7 story, existing event/idempotency/outbox patterns, and parallel API/infrastructure/edge-case discovery.

## Review Triage Log

- 2026-08-07 adversarial review: 17 unique findings across blind, edge-case, and acceptance layers; 16 fixed and regression-tested.
- Fixed event-version drift before claim, ambiguous workflow-task retry, poisoned outbox delivery, retry/create lock races, missing/corrupt active locks, claimed concurrent retries, failed deterministic execution recovery, iterator/outbox lag alerting, impossible job chronology, unstable event snapshot mapping, conflicting terminal metadata, hostile event pointers, fast-completing concurrent creates, Dynamo cancellation coverage, HTTP failure paths, and lifecycle observability.
- Rejected one shared EventApi key-prefix finding: that Lambda already serves legacy table families, so applying scouting-only leading-key conditions would break existing routes. The role remains constrained to the exact table and operations; every dedicated scouting worker role is additionally key-prefix fenced. A future split Lambda may narrow the shared boundary without coupling it to this story.
- Follow-up review remains recommended because this is a high-risk distributed state machine, even though all identified correctness gaps are closed locally.

## Design Notes

The provider-backed factual input contract is intentionally not part of this story. The only accepted command material beyond the event snapshot is a fixed server-owned `fixture-v1` workflow intent, so later provider selection can version the input without pretending a development fixture is production evidence.

The transactional outbox is required because a successful job write followed by a failed queue send would otherwise create a permanently stuck job. The outbox stream publisher may deliver more than once; repository fencing and deterministic workflow execution, not temporary FIFO deduplication, provide correctness.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test && pnpm --filter @find-the-edge/database test` -- job invariants and memory/Dynamo concurrency parity.
- `pnpm --filter @find-the-edge/api test && pnpm --filter @find-the-edge/workers test && pnpm --filter @find-the-edge/infra-cdk test` -- HTTP, dispatch, workflow, IAM, and infrastructure matrices.
- `pnpm check && git diff --check` -- complete local repository quality gate without deployment.

## Dev Agent Record

### Implementation Plan

Build the exact state machine and persistence contract first, then expose the protected command API, add durable dispatch/workflow infrastructure, prove duplicate and retry convergence, and only then run the full local gate.

### Completion Notes

- Added a requester-owned, event-version-bound scouting job API with strict replay, conflict, ownership, and retry semantics.
- Added memory and Dynamo persistence with transactional receipts, active/terminal semantic markers, immutable attempts, durable outboxes, exact event fences, and bounded retry convergence.
- Added FIFO dispatch, deterministic Standard Step Functions execution, fixture-only workflow transitions, failure reconciliation, stream redrive, and low-cardinality telemetry.
- Closed all accepted adversarial findings with focused regression tests, then passed the complete local repository gate without deployment.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-038-scout-event-api-idempotent-job-model-sqs-and-step-functions.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/api/src/handler.ts`
- `apps/api/src/handler.test.ts`
- `apps/api/src/lambda.ts`
- `apps/api/src/scouting-handler.ts`
- `apps/api/src/scouting-handler.test.ts`
- `apps/workers/package.json`
- `apps/workers/src/scouting-dispatcher-lambda.ts`
- `apps/workers/src/scouting-dispatcher-lambda.test.ts`
- `apps/workers/src/scouting-outbox-lambda.ts`
- `apps/workers/src/scouting-outbox-lambda.test.ts`
- `apps/workers/src/scouting-workflow.ts`
- `apps/workers/src/scouting-workflow.test.ts`
- `apps/workers/src/scouting-workflow-lambda.ts`
- `apps/workers/src/scouting-workflow-lambda.test.ts`
- `infra/cdk/src/foundation.ts`
- `infra/cdk/src/foundation.test.ts`
- `packages/database/src/index.ts`
- `packages/database/src/scouting-job-repository.ts`
- `packages/database/src/scouting-job-repository.test.ts`
- `packages/database/src/dynamodb-scouting-job-repository.ts`
- `packages/database/src/dynamodb-scouting-job-repository.test.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/scouting-job.ts`
- `packages/domain/src/scouting-job.test.ts`
- `pnpm-lock.yaml`

## Change Log

- 2026-08-07: Advanced FTE-038 to in-progress after story discovery and specification.
- 2026-08-07: Implemented the protected idempotent scouting workflow and closed the first adversarial review loop locally.
