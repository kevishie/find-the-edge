---
title: 'FTE-LEARN-004 Walk-Forward Experiment and Strategy Promotion Gates'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'a02dd54d546e28c0a03df8a7efefc8f43b64a843'
final_revision: '7d80654'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-learn-003-versioned-retrospective-and-error-taxonomy.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** The product can grade frozen cohorts and preserve retrospectives, but it cannot prove that a challenger improved on a baseline using time-separated evidence or govern which immutable strategy version future paper runs use. Repeated reuse of tuning history would inflate confidence and an unaudited version switch would erase the meaning of historical results.

**Approach:** Add an immutable walk-forward experiment, multi-metric promotion-gate, human approval, activation, and rollback system. Grade real shadow decisions, freeze exact chronological evidence, fail closed on leakage or unavailable metrics, and resolve only deployed approved strategy versions for future paper runs.

## Boundaries & Constraints

**Always:** Use exact half-open train/tune/holdout windows and frozen sorted member/evidence manifests; reject cross-window event/member overlap and a challenger frozen after holdout begins; allow baseline and challenger to share only the same paired holdout event universe; record evidence-use lineage so reused tuning/holdout data cannot masquerade as fresh validation; grade real shadow decisions without fabricating paper bets; evaluate a versioned configured set of sample, ROI, CLV, calibration, drawdown, and regression gates from authoritative stored reports; treat every missing metric as a failed gate; retain failed challengers and all baseline history; require a human promoter with dedicated scope/group, exact digest, expected state/version, reason, and idempotency key; activate or roll back only a deployed, previously approved artifact for future paper runs; preserve every prior run's frozen strategy version; use transactions, signed bounded Query-only pagination, safe telemetry, and immutable audits.

**Block If:** Real deterministic shadow outcomes cannot be bound to exact provider/result evidence; an artifact version cannot be mapped to deployed code/config and its digest; promotion authorization, baseline identity, or evidence provenance is absent; a requested policy change would decide statistical thresholds not already configured by server-owned policy.

**Never:** Train or tune autonomously; accept model output as approval; synthesize shadow wagers or user-supplied aggregate metrics; recompute authoritative performance in API/web; overwrite a strategy, experiment, approval, activation, rollback, run, evaluation, or baseline record; select an undeployed/unapproved artifact; enable or place real-money bets; expose secrets, JWT subjects, raw licensed payloads, prompts, or arbitrary storage keys; use Scan or unsigned cursors.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Reproducible experiment | Same frozen evidence in different input/page order | Stable manifest, experiment, gate, and evidence digests | Binding or replay mismatch conflicts safely |
| Leakage | Holdout member appears in train/tune or prior tuning ledger | Challenger remains recorded and cannot await approval | Explicit failed overlap/leakage result and safe metric |
| Paired shadow comparison | Baseline/challenger decisions share one holdout event set | Both are graded independently and compared from authoritative reports | Missing/mismatched decision evidence fails closed |
| Gate boundary | Metric equals its configured inclusive/exclusive boundary | Deterministic documented pass/fail | Null, unavailable, or formula mismatch fails |
| Human promotion | All gates pass and authorized promoter submits exact state/digest | Append approval and future-effective activation | Unauthorized, stale, duplicate mismatch, or unknown artifact cannot mutate state |
| Rollback | Authorized target is a prior approved deployed version | Append future-effective activation to target | Historical runs and prior active history remain unchanged |

</intent-contract>

## Code Map

- `packages/domain/src/strategy-experiment.ts` -- canonical strategy artifacts, windows, experiments, gates, reviews, activations, identities, validators, and transitions.
- `packages/domain/src/{paper-evaluation,paper-grade,cohort}.ts` -- gradeable shadow evaluation evidence and experiment-only shadow cohorts without paper-wager semantics.
- `packages/odds/src/performance.ts` -- authoritative ROI, CLV, calibration, interval, and drawdown metrics consumed by gates.
- `packages/database/src/{strategy-experiment,dynamodb-strategy-experiment}-repository.ts` -- immutable versions, evidence ledger, active projection, decisions, audits, transactions, and bounded indexes.
- `apps/workers/src/{walk-forward-experiment,strategy-promotion}.ts` -- exact-evidence orchestration and deterministic gate evaluation without auto-promotion.
- `packages/sports/src/strategy-registry.ts` and `apps/workers/src/paper-pick-scheduler*.ts` -- deployed artifact lookup and future-effective approved-version resolution.
- `apps/api/src/{handler,lambda}.ts` -- public analytical reads and narrowly authorized review/promotion/rollback mutations.
- `apps/web/src/{api,App,styles}.ts*` -- experiment evidence, timeline, gates, audit, promotion, and rollback UI.
- `infra/cdk/src/foundation.ts` -- routes, promoter identity, IAM, metrics, alarms, and SPA rewrites.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/strategy-experiment.ts`, shadow grading/cohort domain files, exports, and tests -- define immutable artifacts, exact chronological manifests, gradeable shadow outcomes, gate policies/results, lifecycle, human decisions, activations, rollback, stable digests, and leakage invariants.
- [x] `packages/database/src/{strategy-experiment,dynamodb-strategy-experiment}-repository.ts`, exports, and tests -- persist immutable artifacts/experiments/gates/evidence-use/decisions/activations/audits with conditional transactions, exact idempotent replay, signed filter-bound cursors, and Query-only reads.
- [x] `apps/workers/src/{walk-forward-experiment,strategy-promotion}.ts`, shadow grading/materialization integration, exports, metrics, and tests -- resolve and grade exact evidence, build reproducible paired comparisons, validate chronology/lineage, evaluate every configured gate, retain failures, and stop at human approval.
- [x] `packages/sports/src/strategy-registry.ts`, `packages/config/src/paper-pick-schedule.ts`, and `apps/workers/src/paper-pick-scheduler*.ts` with tests -- register immutable deployed artifacts and freeze the approved future-effective version into each new paper run while failing closed on unknown/stale artifacts.
- [x] `apps/api/src/{handler,lambda}.ts` and tests -- expose bounded strategy/experiment reads and strict promoter-only review, promotion, and rollback mutations with safe validation/status mapping and server-owned identity/time.
- [x] `apps/web/src/{api,App,styles}.ts*` and tests -- add responsive experiment list/detail with walk-forward timeline, exact provenance, paired metrics, gate evidence, unavailable states, immutable history, scoped confirmation, conflict refresh, and future-paper-only copy.
- [x] `infra/cdk/src/{foundation,foundation.test}.ts`, deployment assertions, `docs/runbooks/strategy-experiments.md`, package exports, and sprint status -- deploy scopes/groups/routes/IAM/SPA rewrites/alarms, document recovery and rollback, retain governance evidence, and complete release verification.

**Acceptance Criteria:**
- Given the same exact shadow decisions, results, reports, and policy in any order or retry, when an experiment is built, then its window manifest, evidence lineage, metrics, gates, and identity are byte-for-byte reproducible.
- Given train, tune, and holdout windows, when any event/member overlaps across windows, the challenger was frozen late, or holdout evidence was previously consumed by its lineage, then the experiment records the failure and cannot progress to approval.
- Given paired baseline and challenger shadow decisions over the same holdout universe, when graded, then each uses real immutable outcome evidence, ordinary paper-performance views remain unaffected, and no synthetic wager is created.
- Given configured sample, ROI/interval, CLV, calibration, drawdown, and baseline-regression gates, when evaluated at boundaries or with missing data, then every result is explicit and deterministic and all gates must pass before human review.
- Given an authorized approval, promotion, or rollback request, when its state/version/digest/idempotency and deployed artifact are valid, then one immutable audit and future-effective activation is appended; otherwise no partial mutation occurs.
- Given any promotion or rollback, when prior and later paper runs are inspected, then earlier manifests retain their original strategy version and only runs scheduled after the effective activation resolve the new active approved version.
- Given public/read-only, promoter, empty, partial, conflict, and unavailable states, when the experiment UI is used, then it accurately communicates evidence limits and never implies autonomous training, guaranteed outcomes, or real-money activation.

## Spec Change Log

- 2026-08-04: Implemented immutable walk-forward evidence, deterministic multi-metric promotion gates, durable approval/activation/rollback governance, future-effective strategy selection, promoter-only API/UI controls, production worker wiring, observability, and operational guidance.

## Review Triage Log

### 2026-08-04 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 16: (high 14, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Made production scheduling fail closed without the durable approved-version resolver and registered deployed artifact digests.
  - `[high]` `[patch]` Added a production walk-forward worker that resolves stored artifacts, windows, reports, result evidence, and policy instead of accepting caller-supplied aggregate metrics.
  - `[high]` `[patch]` Enforced tune and holdout evidence-use lineage, exact paired event/member universes, and durable retention of failed challengers.
  - `[high]` `[patch]` Corrected Dynamo pagination and made approval, activation, lifecycle projections, global approval lineage, audit, and the per-strategy active head transactional and race-safe.
  - `[high]` `[patch]` Bound idempotent replay to every approval/activation input and required server-future effective times.
  - `[high]` `[patch]` Separated retrospective-reviewer and strategy-promoter authorization and rejected null/array mutation bodies.
  - `[medium]` `[patch]` Bound rollback controls to the global active head and prior approved artifact lineage, with conflict refresh and future-paper-only confirmation.

## Design Notes

Shadow is an execution mode, not a wager mode. A shadow Play needs a deterministic outcome record linked to the evaluation and exact event/result evidence; it may participate in experiment-only cohorts but must not enter ordinary paper-bet accounting. Promotion updates a future-effective strategy pointer only after the code/config artifact digest is present in the deployed registry. Rollback appends another activation to a previously approved version rather than mutating history.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/api test`
- `pnpm --filter @find-the-edge/web test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm check`
- `git diff --check`

**Results (2026-08-04):** `pnpm check` passed formatting, lint, package boundaries, all 15 package typechecks, tool typechecking, every test suite, and production builds. Focused final verification passed 52 domain, 181 database, 140 worker, 12 API, 63 web, and 8 infrastructure tests; `git diff --check` passed.

## Auto Run Result

**Summary:** Added a leakage-resistant walk-forward strategy promotion system using real immutable evidence, configured statistical gates, human-only approval, future-effective activation and rollback, and preserved historical strategy/run lineage.

**Files changed:** Domain models and tests define evidence/gates/lifecycle; memory and Dynamo repositories persist immutable records and transactional active heads; workers build experiments and resolve approved strategies; API and UI expose read evidence and promoter-only controls; CDK provisions the worker, routes, identity, IAM, SPA rewrites, metrics, and alarms; the runbook documents recovery and rollback.

**Review findings:** 16 implementation findings were patched (14 high, 2 medium); nothing was deferred or rejected. Significant security, concurrency, evidence-lineage, pagination, lifecycle, and production-wiring repairs justify an independent follow-up review.

**Verification:** Full `pnpm check`, all focused package suites, infrastructure synthesis, production builds, and `git diff --check` are green.

**Residual risks:** Promotion remains intentionally paper-only and requires a dedicated human promoter session. Statistical thresholds remain server-owned policy and should be re-evaluated only through a separate governed change.
