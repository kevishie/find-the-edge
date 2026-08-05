---
title: 'Reset SharpAPI Feed State and Re-ingest'
type: 'bugfix'
created: '2026-08-05T10:00:00-04:00'
status: 'done'
review_loop_iteration: 1
baseline_commit: '4e1bd471c320ff9927e822919194f6441a1efe2d'
context:
  - '{project-root}/docs/phase1-deployment.md'
  - '{project-root}/docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The deployed development environment can retain stale or partially ingested SharpAPI events after provider recovery failures. The UI then shows an incomplete schedule with no attached odds or splits even though SharpAPI is returning current data.

**Approach:** Add a guarded development-environment maintenance operation that backs up the retained DynamoDB table, clears only provider-generated feed records and ingestion state, performs one forced SharpAPI ingest, and verifies today's unique games, odds, and splits. Expose it as a manually dispatched GitHub Action so it uses the existing short-lived AWS deployment role when a local AWS session is unavailable.

## Boundaries & Constraints

**Always:** Target only AWS account `228246988391`, region `us-east-1`, stack `FindTheEdge-dev-Foundation`, and the table resolved from that stack. Confirm the live-ingestion Lambda references the same table. Require point-in-time recovery, create and await an on-demand backup, pause the ingestion schedule and event source, classify every scanned key against an explicit feed allowlist, show dry-run counts, retry unprocessed batch deletions, prove zero matching rows remain, purge stale cadence messages, force one ingest, validate the public API, and restore the exact prior scheduler/event-source states even on failure. Never expose secrets or licensed payloads.

**Ask First:** Any target other than the development stack, any deletion outside the approved key families, any table replacement, or any provider/account plan change.

**Never:** Delete the table, secrets, infrastructure, users, results, paper bets, evaluations, performance records, strategies, experiments, or retrospectives. Never use The Odds API, silently accept unexpected key families, skip the backup, weaken SharpAPI normalization, or treat deployment as a substitute for local tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Dry run | Verified dev stack and table | Counts approved feed keys without mutation | Abort on identity mismatch or unclassified target |
| Apply | Explicit apply flag after dry run | Backup, quiesce, delete approved keys, re-ingest, verify, restore | Fail closed; restore scheduler/event source in `finally` |
| Backup failure | PITR disabled or backup unavailable | No records deleted | Exit nonzero with bounded diagnostic |
| Concurrent ingestion | Active scheduler/SQS mapping | Pause inputs and wait boundedly before deletion | Abort rather than race a writer |
| Partial batch delete | DynamoDB returns unprocessed keys | Retry with a bounded backoff | Exit nonzero if retry budget is exhausted |
| Provider failure | Forced ingest cannot obtain current data | Empty clean state remains visibly unavailable, not stale | Exit nonzero and preserve backup/recovery details |

</frozen-after-approval>

## Code Map

- `scripts/phase1-reset-feed.mjs` -- guarded reset, backup, quiesce, deletion, forced ingest, and verification orchestration.
- `scripts/phase1-reset-feed.test.mjs` -- key classification, target validation, pagination, batching, retry, cleanup, and failure-path tests.
- `apps/workers/src/live-odds-lambda.ts` -- maintenance-lease ownership gate that prevents any other invocation from ingesting while reset temporarily grants one unit of concurrency.
- `apps/workers/src/live-odds-lambda.test.ts` -- invocation-token and active/expired maintenance-lease coverage.
- `packages/phase1-reset-feed/package.json` -- focused Turbo test target used by the spec verification command.
- `scripts/check-boundaries.mjs` -- declares the dependency-free reset test package boundary.
- `turbo.json` -- forces the focused reset test package to execute instead of replaying a stale cache for its out-of-package test files.
- `.github/workflows/reset-phase1-feed.yml` -- manual dry-run/apply entry point using the existing GitHub AWS role.
- `package.json` -- operator command aliases.
- `docs/phase1-deployment.md` -- operator procedure and recovery instructions.
- `infra/cdk/src/foundation.ts` -- source of the retained PITR table and ingestion resources; no broad destructive permissions added to runtime Lambdas.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/phase1-reset-feed.mjs` -- implement exported pure validators/classifiers plus the guarded AWS operation -- make destructive scope explicit and testable.
- [x] `scripts/phase1-reset-feed.test.mjs` -- cover every I/O scenario and preserved key family -- prevent reset regressions.
- [x] `.github/workflows/reset-phase1-feed.yml` -- add manual `dry-run`/`apply` dispatch with OIDC, environment checks, and concurrency fencing -- provide safe short-lived AWS access.
- [x] `package.json` -- add a local read-only dry-run command; require the protected GitHub workflow for apply -- make the runbook reproducible without allowing uncoordinated mutation.
- [x] `docs/phase1-deployment.md` -- document backup naming, expected output, recovery, and post-ingest validation -- support future operations.

**Acceptance Criteria:**
- Given the verified dev environment contains stale feed records and unrelated product records, when dry-run executes, then it reports only allowlisted feed records and changes nothing.
- Given dry-run succeeds and apply is explicit, when reset completes, then an available backup exists, all allowlisted records are replaced by one current SharpAPI ingest, unrelated records remain, and prior schedule/event-source states are restored.
- Given SharpAPI returns today's MLB odds and splits, when post-reset verification runs, then the API exposes unique Eastern-day matchups with nonzero current odds and available split observations; otherwise the operation fails visibly.
- Given any target, backup, deletion, ingestion, or verification invariant fails, when the operation exits, then no broader target is attempted and no secret or raw licensed payload is printed.

## Spec Change Log

- 2026-08-05: Implemented the guarded reset, focused tests, manual OIDC workflow, operator commands, and recovery runbook. Local verification is green; live dry-run/apply acceptance remains intentionally unexecuted in this implementation workstream.
- 2026-08-05: Closed adversarial review findings: immutable odds evidence is preserved and digest-checked; key classification is exact and fail-closed; writers are concurrency-fenced and exactly restored; batch retries reject injected keys; target/provider/API verification is stricter; deployment and reset share one mutation mutex.
- 2026-08-05: Closed the clean-room rereview: all live, legacy, and stream-projection writers are bound and fenced; SQS purge completion is awaited; every production control/split key shape is covered; apply is workflow-provenance locked; and a short-lived maintenance lease gives the forced SharpAPI invocation exclusive ingestion ownership.
- 2026-08-05: Added a bounded, secret-safe forced-ingestion summary after the first live apply exposed only a generic incomplete-league error. The reset now identifies each enabled league's status, reason, pages, and quota cost without printing licensed payloads.
- 2026-08-05: Reproduced and repaired both live-ingestion blockers locally: exact SharpAPI event bindings now tolerate credible schedule/odds team aliases and bounded start-time drift while failing closed on unrelated games, and the live worker's standalone delete permission now includes only reconciliation and odds-continuation lease keys. Schedule readiness is recorded only after lease cleanup succeeds.

## Design Notes

The reset is an exceptional maintenance scan, not an application read path. It scans only `pk` and `sk`, creates auditable deletion and preservation digest/count summaries, and deletes explicit keys in DynamoDB's 25-item batch limit. The allowlist includes canonical event projections, mapping/reconciliation state, current odds and availability, split observations/gaps, and SharpAPI control-plane checkpoints. Immutable fixture-odds snapshots, exact-ID indexes, odds-history mirrors, and every result or decision-learning family are preserved.

## Verification

**Commands:**
- `pnpm test --filter phase1-reset-feed` -- expected: all reset unit tests pass.
- `pnpm check` -- expected: repository quality gate passes locally.
- `pnpm phase1:reset-feed -- --mode=dry-run` -- expected: verified target and bounded allowlisted counts with zero writes.
- Manual GitHub `apply` dispatch -- expected: backup becomes available, feed rows are cleared, forced ingestion succeeds, hosted API shows unique current games with odds and splits, and scheduler/event source return to their prior states.

**Local evidence (2026-08-05):**

- `pnpm test --filter phase1-reset-feed` / `pnpm test:phase1-reset-feed` -- passed, 15/15 reset tests with cache bypass forced for the external test files.
- `pnpm phase1:test` -- passed after the diagnostic repair, 60/60 Phase 1 tests.
- `pnpm check` -- passed after the SharpAPI alias and least-privilege IAM repairs: formatting, lint, boundaries, type checks, all tests (including 170 worker tests), and production builds.
- Both GitHub workflow YAML files parsed successfully and `git diff --check` passed.
- Live dry-run passed with 37,513 feed rows selected and 25,926 unrelated/evidence rows preserved. The first manual `apply` created an available backup and removed the stale feed, then failed closed because at least one forced SharpAPI league did not meet the strict completion contract; the bounded diagnostic added here is the next-step evidence needed to finish the re-ingest.

## Suggested Review Order

**Guarded operation contract**

- Start with the manual entry point, provenance lock, timeout, and shared deployment mutex.
  [`reset-phase1-feed.yml:1`](../../.github/workflows/reset-phase1-feed.yml#L1)

- Follow the fail-closed sequence from dry-run manifest through restoration.
  [`phase1-reset-feed.mjs:934`](../../scripts/phase1-reset-feed.mjs#L934)

- Inspect the exact environment binding, operation budgets, and public verification wiring.
  [`phase1-reset-feed.mjs:1849`](../../scripts/phase1-reset-feed.mjs#L1849)

**Exclusive ingestion and recovery**

- Review complete writer fencing, queue draining, deadlines, and exact state restoration.
  [`phase1-reset-feed.mjs:1463`](../../scripts/phase1-reset-feed.mjs#L1463)

- Review maintenance-lease acquisition, sole-worker invocation, refencing, and independent cleanup.
  [`phase1-reset-feed.mjs:1745`](../../scripts/phase1-reset-feed.mjs#L1745)

- Confirm every live ingestion invocation validates maintenance ownership before provider access.
  [`live-odds-lambda.ts:143`](../../apps/workers/src/live-odds-lambda.ts#L143)

**Verification and operator support**

- Confirm hosted verification requires matching current games, fresh odds, and fresh splits.
  [`phase1-reset-feed.mjs:900`](../../scripts/phase1-reset-feed.mjs#L900)

- Read the recovery-aware operator procedure before dispatching apply.
  [`phase1-deployment.md:107`](../../docs/phase1-deployment.md#L107)

- Finish with failure-path coverage for fencing, deadlines, queues, and restoration.
  [`phase1-reset-feed.test.mjs:927`](../../scripts/phase1-reset-feed.test.mjs#L927)

- Confirm only the active reset lease owner can run paid ingestion.
  [`live-odds-lambda.test.ts:191`](../../apps/workers/src/live-odds-lambda.test.ts#L191)
