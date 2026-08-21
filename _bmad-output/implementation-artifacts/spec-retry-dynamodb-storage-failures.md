---
title: 'Retry transient DynamoDB storage failures without acknowledging live-odds work'
type: 'bugfix'
created: '2026-08-18'
status: 'done'
baseline_commit: 'eb0e3c6deb511da1850e0be3db42d0a384d5dccc'
review_loop_iteration: 0
context:
  - '_bmad-output/planning-artifacts/research/technical-dynamodb-cost-reduction-research-2026-08-17.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The live-odds worker recognizes DynamoDB failures but treats them as terminal, loses them inside wrappers or production subflows, and can acknowledge the FIFO message. A transient throttle or service outage can therefore discard a cadence run instead of reaching the existing five-receive DLQ policy.

**Approach:** Preserve a closed, reason-aware storage taxonomy through database, orchestration, summary, and Lambda boundaries. Retry only demonstrably transient storage failures through SQS partial-batch failure; keep deterministic failures terminal and observable.

## Boundaries & Constraints

**Always:** Traverse bounded, cycle-safe `cause` and `sourceError` chains; inspect sanitized transaction reason codes without logging provider/AWS messages; retry only `storage-throttled`, `storage-unavailable`, and `storage-transaction-in-progress`; retain message ownership on receives 1–5 so SQS performs configured redrive; preserve the staging scheduled/SQS no-op fence before AWS setup; surface transient failures from odds, schedule, split, account, and quota-reservation paths.

**Ask First:** Any queue/DLQ/redrive-policy change, database schema change, ingestion-cadence change, billing-mode change, or expansion beyond the live-odds storage boundary.

**Never:** Blanket-retry `TransactionCanceledException`; retry validation, missing-resource, access-denied, conditional, malformed, or unknown cancellations; weaken provider terminal handling or idempotency/ownership checks; change infrastructure capacity; touch `.claude/` or unrelated dirty files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Direct transient | Dynamo throttle, request limit, service unavailable, or transaction-in-progress | Stable transient storage reason | FIFO item remains failed through receive 5 |
| Wrapped transient | Same error under bounded `cause` or fixture `sourceError` | Same classification as direct error | Cycle/depth overflow fails closed |
| Retryable cancellation | All non-`None` reasons are one recognized family: throttle or transaction conflict | Throttle or transaction-in-progress classification | Missing, unknown, mixed-family, or deterministic reasons are terminal cancellation |
| Deterministic storage | Validation, resource missing, access denied, conditional cancellation | Terminal stable reason | Message is acknowledged; bounded diagnostics remain |
| Nested/production failure | Odds summary or schedule/split/account branch reports transient storage failure | Lambda retains retry ownership | Failure is not reduced to generic provider error or swallowed |
| Quota reservation | Transaction cancellation contains throttle/conflict rather than a failed condition | Error propagates for retry | Conditional reservation loss still returns `false` |
| Staging scheduled message | Staging SQS event with missing runtime configuration | No AWS/provider initialization | Acknowledge as intentional no-op |

</frozen-after-approval>

## Code Map

- `apps/workers/src/odds-control-plane.ts` -- central failure taxonomy and retry decision.
- `apps/workers/src/live-odds-lambda.ts` -- thrown/summary SQS acknowledgement boundary.
- `apps/workers/src/production-odds-control-plane.ts` -- schedule, split, and account catches that currently erase failures.
- `packages/database/src/odds-control-plane.ts` -- quota transactions that currently swallow every cancellation.
- Matching `*.test.ts` files -- reason matrix, propagation, receive-five, and staging-fence regressions.
- `infra/cdk/src/foundation.ts` -- existing queue contract; verification only, no production change.

## Tasks & Acceptance

**Execution:**
- [x] `apps/workers/src/odds-control-plane.ts` and test -- add bounded recursive classification, reason-aware cancellations, and the exact transient storage set.
- [x] `packages/database/src/odds-control-plane.ts` and test -- return `false` only for proven reservation/condition loss; propagate throttle/conflict cancellations.
- [x] `apps/workers/src/production-odds-control-plane.ts` and test -- preserve shared storage taxonomy and ensure transient schedule, split, and account failures cannot be acknowledged after bookkeeping.
- [x] `apps/workers/src/live-odds-lambda.ts` and test -- recognize exact transient storage reasons in nested summaries and prove receive 1–5 plus real staging-handler behavior.
- [x] Run focused and full gates; inspect the final diff for unrelated changes.

**Acceptance Criteria:**
- Given any proven transient DynamoDB failure before the live-odds acknowledgement boundary, when an SQS message is processed, then its identifier is returned in `batchItemFailures`, including receive 5 for DLQ redrive.
- Given a deterministic or unclassified storage failure, when it is processed, then it is not retried and no raw cancellation message, request payload, or secret is emitted.
- Given a conditional quota race, when reservation loses, then it remains a normal `false` result; a throttled/conflicted transaction is never misreported as quota exhaustion.
- Given staging recurring ingestion is disabled, when a scheduled FIFO message arrives, then the handler acknowledges before reading environment configuration, DynamoDB, Secrets Manager, or SharpAPI.

## Spec Change Log

## Design Notes

Transaction cancellation is retryable only when every non-`None` code is recognized and belongs to one transient family. This deliberately prefers a terminal false negative over replaying a transaction that contains a conditional or unknown failure. Existing FIFO batch size one, partial-batch response, five receives, DLQ, and alarms remain the retry mechanism.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database exec vitest run src/odds-control-plane.test.ts` -- quota cancellation matrix passes.
- `pnpm --filter @find-the-edge/workers exec vitest run src/odds-control-plane.test.ts src/live-odds-lambda.test.ts src/production-odds-control-plane.test.ts` -- retry and propagation matrix passes.
- `pnpm --filter @find-the-edge/workers typecheck && pnpm --filter @find-the-edge/workers lint && pnpm --filter @find-the-edge/workers test && pnpm --filter @find-the-edge/workers build` -- worker package is green.
- `pnpm --filter @find-the-edge/infra-cdk test` -- existing queue/redrive contract remains green.
- `pnpm check && git diff --check` -- repository gate and whitespace check pass.

## Suggested Review Order

**Failure classification**

- Centralizes bounded wrapper traversal and the closed transient storage taxonomy.
  [`odds-control-plane.ts:338`](../../apps/workers/src/odds-control-plane.ts#L338)

- Proves cancellation-family, wrapper, cycle, and terminal-precedence boundaries.
  [`odds-control-plane.test.ts:269`](../../apps/workers/src/odds-control-plane.test.ts#L269)

**SQS retry ownership**

- Retains failed-item ownership even when visibility extension itself fails.
  [`live-odds-lambda.ts:309`](../../apps/workers/src/live-odds-lambda.ts#L309)

- Surfaces fast-lane storage failures instead of acknowledging successful initial passes.
  [`live-odds-lambda.ts:460`](../../apps/workers/src/live-odds-lambda.ts#L460)

- Covers receive-five redrive, summaries, staging fences, and visibility failures.
  [`live-odds-lambda.test.ts:184`](../../apps/workers/src/live-odds-lambda.test.ts#L184)

**Production propagation**

- Preserves shared storage taxonomy across every schedule acquisition stage.
  [`production-odds-control-plane.ts:492`](../../apps/workers/src/production-odds-control-plane.ts#L492)

- Guarantees bookkeeping cannot replace an original transient schedule failure.
  [`production-odds-control-plane.ts:1968`](../../apps/workers/src/production-odds-control-plane.ts#L1968)

- Verifies schedule, split, and account propagation under failing bookkeeping.
  [`production-odds-control-plane.test.ts:432`](../../apps/workers/src/production-odds-control-plane.test.ts#L432)

**Quota transaction semantics**

- Distinguishes proven conditional reservation loss from retryable transaction failure.
  [`odds-control-plane.ts:911`](../../packages/database/src/odds-control-plane.ts#L911)

- Locks the conditional, throttle, conflict, mixed, and missing-reason matrix.
  [`odds-control-plane.test.ts:620`](../../packages/database/src/odds-control-plane.test.ts#L620)
