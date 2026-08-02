---
title: 'FTE-MVP-001A Persistent Fixture Odds Store and Seed'
type: 'feature'
created: '2026-08-01'
status: 'blocked'
review_loop_iteration: 1
followup_review_recommended: false
baseline_revision: '986fdf6f76c'
context:
  - '_bmad-output/implementation-artifacts/spec-fte-data-002-checkpointed-upcoming-event-ingestion-orchestrator.md'
  - '_bmad-output/implementation-artifacts/spec-fte-mvp-001-fixture-backed-games-and-odds-vertical-slice.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** MVP001 failed review twice because persistence, deployment, API, UI, and browser identity were coupled. The prerequisite is a proven fixture-only odds store and seed path whose Dynamo semantics match its in-memory contract.

**Approach:** Implement only deterministic MLB/MLS fixture observations, canonical-version-aware immutable Dynamo snapshots, monotonic current projection, parity tests, and a separately invokable dev seed Lambda/command. API and UI work remain outside this corrective slice.

## Boundaries & Constraints

**Always:** Resolve the exact persisted DATA002 provider mapping and canonical event immediately before building each event's odds observations; bind sport, canonical event ID, and current canonical version; validate/encode every key component; validate timestamps and American prices before writes. Snapshot identity must be recomputed from canonical normalized content. Store every distinct valid observation immutably even when it is older than CURRENT. Advance CURRENT only for a newer observation, or a deterministic hash tie-break at the same time. Identical concurrent replays return success/existing after conflict reread. A same-ID/different-content state is corruption. Memory and Dynamo implementations must share the same validation and transition rules. Seed is dev-gated, separately invokable, rerunnable after canonical version changes, and bounded to MLB/MLS fixture events.

**Block If:** The existing Dynamo gateway cannot express conditional snapshot insertion plus independent monotonic current advancement without adding a small exact operation, or canonical version cannot be read through the existing DATA002 store contract.

**Never:** Add `/games`, web UI, browser auth, CORS, external providers, pagination, quotas, retries/recovery jobs, scans, recommendations, or production scheduling. Never hard-code canonical version. Never place snapshot insertion and a possibly stale CURRENT condition in one all-or-nothing transaction.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| First/newer | Valid observation tied to current canonical record | Immutable snapshot exists and CURRENT advances | Atomic per exact operation |
| Older arrival | Valid distinct observation older than CURRENT | Snapshot persists; CURRENT remains unchanged | Not an ingest failure |
| Concurrent replay | Two identical writes race | One creates; both resolve success/existing | Conditional conflict triggers exact reread |
| Collision | Existing snapshot ID has different normalized content | Existing snapshot unchanged | Corruption error |
| Canonical update | DATA002 event advances version then seed reruns | New observations bind current version and seed succeeds | Stale caller version rejected |
| Invalid input | Bad time, price, sport, delimiter-bearing ID, or unknown mapping | Nothing written | Typed input/binding error |

</intent-contract>

## Code Map

- `packages/odds/src/` -- normalized content/hash and snapshot/current DTOs.
- `packages/providers/src/fixtures/` -- deterministic bounded MLB/MLS odds material without canonical version assumptions.
- `packages/database/src/` -- shared validator/transition rules, memory parity store, Dynamo exact operations, and concurrency/late-arrival tests.
- `apps/workers/src/` -- DATA002-composed fixture seed service and environment-gated Lambda entry.
- `infra/cdk/src/` -- separately invokable dev seed function and least-privilege shared-table IAM.

## Tasks & Acceptance

**Execution:**
- [x] `packages/odds/src/` and `packages/providers/src/fixtures/` -- add strict normalized fixture observation contracts and deterministic content hashing.
- [x] `packages/database/src/` -- implement memory+Dynamo parity for canonical binding, immutable insert, conflict reread, and independent monotonic CURRENT.
- [x] `apps/workers/src/` -- resolve DATA002 mapping/canonical version per event and seed bounded fixture observations idempotently.
- [x] `infra/cdk/src/` -- deploy only a gated, operator-invokable fixture seed Lambda with exact table permissions and outputs.
- [x] tests -- cover invalid/collision/cross-sport/version mismatch, older/newer/equal-time, partial current failure, concurrent identical replay, canonical-version advance, and rerun stability.

**Acceptance Criteria:**
- Given a newer then older observation, when both ingest, then both immutable snapshots exist and CURRENT still identifies the newer deterministic winner.
- Given concurrent identical replay, when conditional creation races, then callers converge on one unchanged snapshot without a surfaced conflict.
- Given a canonical fixture event advances version, when seed reruns, then it reads and binds the current version rather than using a constant.
- Given credential-free dev configuration, when tests and CDK synth run, then the invokable seed and least-privilege shared-table wiring are proven without an API/UI or external provider.

## Spec Change Log

- 2026-08-01 loop 1: Reviews showed the corrective slice still coupled the pure transition contract, Dynamo concurrency/TOCTOU mechanics, DATA002 mapping conditions, and deployment gating. Marked blocked for non-convergence and decomposed again. KEEP: normalized content identity, immutable history independent from CURRENT, dynamic canonical version resolution, exact dev-only operator boundary.

## Review Triage Log

- 2026-08-01 loop 1: intent_gap 0; bad_spec 5 (high 4, medium 1); patch 5 (high 3, medium 2); defer 0; reject 0. Findings: mapping/canonical TOCTOU, ambiguous transaction-cancellation replay, absent-real-winner visibility, Dynamo aggregate key/item limits, fake ConditionCheck coverage, and non-dev seed enablement. Story blocked and decomposed into pure contract/state-machine then adapter slices.

## Design Notes

Snapshot creation and CURRENT advancement are two exact idempotent operations because a stale CURRENT predicate must never roll back valid history. If CURRENT advancement fails for a transient reason after snapshot creation, rerunning the same observation resumes safely from the immutable snapshot and retries CURRENT.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test` -- parity, race, and late-arrival cases pass.
- `pnpm --filter @find-the-edge/workers test` -- dynamic canonical version and rerun cases pass.
- `pnpm --filter @find-the-edge/infra-cdk test` -- seed deployment/IAM assertions pass.
- `pnpm check` -- workspace gates pass.
- `pnpm synth` -- configured dev stack synthesizes without external credentials.

## Auto Run Result

Implemented the bounded fixture-odds persistence prerequisite without API, UI, authentication, browser, live-provider, scheduling, or recovery changes. MLB/MLS fixture material is normalized and content-addressed; memory and Dynamo paths share validation, canonical binding, immutable snapshot, monotonic CURRENT, late-arrival, collision, conflict-reread, and resume-after-partial-failure semantics. The seed bootstraps/ingests the DATA002 provider event, immediately resolves its persisted provider mapping and current canonical version, then writes observations using that returned binding. CDK deploys a dev-gated, operator-invokable seed Lambda with table-scoped Get/Query/Put/TransactWrite permissions and a function-name output.

Verification: database 65/65 tests, workers 29/29 tests, and CDK 5/5 tests pass; all focused typechecks pass; `pnpm check` passes formatting, lint, boundaries, 15 package typechecks, tooling typecheck, all workspace tests, and all 15 builds; configured credential-free dev `pnpm synth` succeeds; `git diff --check` succeeds. No commit was created.

Files changed: `packages/odds/src/index.ts`; `packages/providers/src/{index.ts,fixtures/mvp-odds.ts}`; `packages/database/src/{event-ingestion.ts,memory-event-ingestion.ts,dynamodb-event-ingestion.ts,index.ts,fixture-odds-store.ts,fixture-odds-store.test.ts}`; `apps/workers/src/{index.ts,fixture-odds-seed.ts,fixture-odds-seed-lambda.ts,fixture-odds-seed.test.ts}`; `infra/cdk/src/{app.ts,foundation.ts,foundation.test.ts}`.
