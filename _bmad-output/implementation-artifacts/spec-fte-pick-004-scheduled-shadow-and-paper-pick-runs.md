---
title: 'FTE-PICK-004 Scheduled Shadow and Paper-Pick Runs'
type: 'feature'
created: '2026-08-04'
status: 'in-review'
baseline_revision: '75448e3'
review_loop_iteration: 1
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0B-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-pick-003-ai-analysis-and-deterministic-ev-gate.md'
warnings: [oversized, multiple-goals]
---

<intent-contract>

## Intent

**Problem:** Approved paper strategies cannot yet evaluate upcoming events repeatedly because the evaluation service has no server-owned candidate assembly, scheduled orchestration, durable run ledger, or budget/concurrency/kill-switch controls.

**Approach:** Add a disabled-by-default EventBridge and Step Functions scheduling path that discovers bounded eligible candidates, executes only an exact server-owned shadow/paper allowlist through PICK-003, and durably converges retries under run, item, budget, and terminal-result fencing.

## Boundaries & Constraints

**Always:** Make shadow and paper explicit immutable execution modes; derive deterministic run/item identities from a versioned policy and UTC schedule generation; query upcoming events without Scan; recheck eligibility and durable kill-switch state before every model call; atomically reserve concurrency, model-call, token, and cost ceilings; treat uncertain paid-call usage conservatively; preserve exact run provenance on attempts/evaluations; resume retries without duplicate terminals or paper bets; expose safe alarmable counters; keep infrastructure and schedule disabled by default.

**Block If:** Enabling a paid production model adapter or credential, enabling the deployed schedule, or expanding the approved sport/league/strategy/market allowlist requires a choice not already captured in versioned server configuration.

**Never:** Represent real-money mode; place wagers; accept client prompts, strategy versions, schedule commands, or arbitrary candidates; let shadow create a paper bet; let paper run with a disabled/unapproved model; exceed budget or concurrency on uncertainty; mutate historical results; use Scan; log prompts, raw licensed evidence/output, credentials, or secrets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Approved shadow run | Fresh trusted schedule; allowlisted MLB/MLS tuple; eligible upcoming candidates | One deterministic run and one terminal per candidate; evaluations/attempts labeled shadow; no paper bet | Exact retry returns existing run/items |
| Approved paper run | Explicit enabled paper tuple plus approved model capability | PICK-003 persists idempotent Play/No Bet; Play may create one paper bet | Disabled model fails closed before paid work |
| Disabled or killed | Global disabled, empty allowlist, or kill switch before/mid-run | No new model call; run/item records truthfully skipped/partial | In-flight result may finish recording only |
| Limit reached | Event, concurrency, call, token, or cost ceiling exhausted/uncertain | Stop claiming work and persist limit reason | Reservation remains consumed when charge is unknown |
| Eligibility race | Event starts, closes, cancels, or becomes stale after discovery | Recheck immediately before invocation; no model call | Immutable skipped/attempt terminal |
| Retry/concurrency | Duplicate generation, SQS/SFN retry, or two workers claim same item | One owner and one authoritative terminal | Lease/fence loss fails closed; retry resumes |

</intent-contract>

## Code Map

- `packages/config/src/paper-pick-schedule.ts` -- exact versioned schedule, allowlist, mode, window, budget, and kill-switch policy.
- `packages/domain/src/paper-pick-run.ts` -- immutable run/item commands, states, counters, identities, modes, and provenance.
- `packages/domain/src/paper-evaluation.ts` -- bind execution mode and run provenance; shadow must be unable to create paper bets.
- `packages/database/src/paper-pick-run-repository.ts` -- memory run/item claim, lease, checkpoint, budget, and terminal contract.
- `packages/database/src/dynamodb-paper-pick-run-repository.ts` -- conditional production implementation with strong replay/fencing.
- `packages/database/src/evaluation-candidate-repository.ts` -- bounded league/day projection query and strong-current eligibility reads.
- `apps/workers/src/paper-pick-scheduler.ts` -- server-owned candidate/request assembly and controlled PICK-003 orchestration.
- `apps/workers/src/paper-pick-scheduler-lambda.ts` -- trusted EventBridge/SFN worker boundary and safe metrics.
- `infra/cdk/src/{foundation,app}.ts` -- disabled rule, Standard state machine, worker/DLQ, IAM, concurrency, alarms, and outputs.

## Tasks & Acceptance

**Execution:**
- [x] `packages/config/src/paper-pick-schedule.ts` and tests -- strictly validate versioned enablement, durable kill switch, exact tuple allowlist, eligibility windows, modes, and finite positive event/concurrency/call/token/cost ceilings; export a disabled empty default.
- [x] `packages/domain/src/paper-pick-run.ts`, `paper-evaluation.ts`, and tests -- add canonical run/item identities, legal monotonic states/counters, shadow/paper provenance, and a type/runtime invariant that shadow never creates a paper bet and real-money is unrepresentable.
- [x] `packages/database/src/{paper-pick-run-repository,dynamodb-paper-pick-run-repository}.ts` and parity/race tests -- implement idempotent create/claim, renewable lease fencing, item checkpoints, atomic conservative budget reservations/reconciliation, terminal replay, and no-Scan access.
- [x] `packages/database/src/evaluation-candidate-repository.ts` and tests -- query bounded upcoming exact allowlisted events/markets through projections and strong current reads with pagination, excluding started/non-scheduled candidates.
- [x] `apps/workers/src/paper-pick-scheduler.ts` and exhaustive fixtures/tests -- assemble server-owned PICK-003 inputs, reread eligibility/kill switch, reserve before calls, cap work/concurrency, reconcile usage, checkpoint every terminal, and converge partial/retried/concurrent runs.
- [x] `apps/workers/src/paper-pick-scheduler-lambda.ts` and tests -- accept only fresh exact internal EventBridge/SFN commands, compose approved capabilities, reject client-controlled fields, and emit redacted EMF run/mode/limit/failure metrics.
- [x] `infra/cdk/src/{foundation,app}.ts`, package dependencies, and assertions -- provision a disabled-by-default EventBridge rule, Standard Step Functions workflow with bounded concurrency/retry/catch, worker/DLQ/reserved concurrency, least-privilege Dynamo/queue/secret access, alarms, and no public trigger.
- [x] End-to-end fixture and `_bmad-output/implementation-artifacts/sprint-status.yaml` -- prove duplicate scheduled shadow/paper generations converge and advance the story only after full review.

**Acceptance Criteria:**
- Given any tuple outside the exact versioned allowlist, when scheduling runs, then no candidate is evaluated and no model call occurs.
- Given global disablement, kill switch, malformed config, uncertain/exhausted budget, or concurrency exhaustion, when work is offered, then it fails closed with an observable stable reason.
- Given a duplicate generation or worker retry, when the run resumes, then one run, one item terminal, and at most one evaluation/paper bet exist.
- Given shadow mode produces a qualifying Play, when persisted, then its evaluation remains auditable and no paper-bet record exists.
- Given paper mode lacks an approved model capability, when invoked, then it records model-disabled without any external paid call or fabricated Play.
- Given an event becomes ineligible after discovery, when the model-call boundary is reached, then it is skipped without a call.
- Given credential-free synthesis, when scheduling is not explicitly enabled, then the rule/state machine cannot initiate runs and exact IAM/alarms remain verifiable.

## Spec Change Log

- 2026-08-04: Implemented the disabled-by-default scheduled shadow/paper run capability, durable identities and ledgers, conservative budget/lease fencing, bounded candidate reads, internal worker boundary, and AWS workflow resources.
- 2026-08-04: Closed the convergence review: direct-addressed claims, atomic expired-lease concurrency transfer, generation-global event admission, durable production composition, replayable workflow failures, and one validated cadence binding.

## Review Triage Log

- Adversarial review classified 11 high/medium correctness and operability findings plus 3 practical hardening findings. The first pass fixed generation-scoped shared budgets, conservative usage reconciliation, exact policy-boundary validation, strong candidate rereads, transition guards, pagination, cadence validation, and limit telemetry.
- Convergence review resolved every remaining required finding: expired owners return a held concurrency slot atomically during claim transfer in Dynamo and memory; all claim mutations use the deterministic item address with no token query; one durable admission ledger enforces the event ceiling across tuples; production composes the real Dynamo candidate/run/evidence/evaluation repositories while the model and schedule stay disabled; Step Functions failures are written as replayable SQS commands; and a single validated cadence drives the EventBridge rule, command, and runtime validator. No required follow-up finding remains. Paid model capability and schedule enablement remain intentionally blocked by the intent contract rather than unfinished implementation.

## Design Notes

The first deployed configuration remains disabled and uses the production-disabled model boundary. This story delivers the complete controlled shadow/paper mechanism without silently purchasing or activating a model provider. Shadow persists evaluation evidence but never a paper bet; paper may create a paper bet only when a separately approved model adapter is configured. A durable kill switch and policy are authoritative; environment variables may only select a prevalidated deployment configuration.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/config test`
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm check`
- `git diff --check`

**Implementation verification (2026-08-04):**

- Focused/full suites passed: config 28, domain 41, database 162, workers 123, infrastructure 8.
- `pnpm check` passed the repository formatting, lint, boundaries, typecheck, test, and build gates; it is rerun after every final review correction before handoff.
- Infrastructure synthesis proves the EventBridge rule and production model capability are disabled, the workflow is Standard with retry/catch, and worker/DLQ/IAM/alarm resources contain no `dynamodb:Scan` permission or public trigger.
