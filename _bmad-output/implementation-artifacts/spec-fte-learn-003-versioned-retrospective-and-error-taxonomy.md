---
title: 'FTE-LEARN-003 Versioned Retrospective and Error Taxonomy'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: '09318c5'
final_revision: '7917e22'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0C-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-learn-002-cohort-performance-calibration-clv-uncertainty.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Frozen performance cohorts now quantify outcomes, but the product cannot preserve structured lessons, distinguish decision-time facts from later result knowledge, or create reviewable version candidates without risking hindsight leakage and historical rewrites.

**Approach:** Build immutable, versioned retrospectives over exact cohort/report evidence with a closed error taxonomy, visibly separated evidence layers, non-executable change candidates, append-only human review/audit history, public analytical reads, and narrowly authorized mutations.

## Boundaries & Constraints

**Always:** Bind each retrospective to an exact frozen cohort and performance-report revision; hash sorted exact evidence and separate decision-time from post-decision evidence; use versioned closed taxonomy codes for data, price, model, rule, execution, false-positive, false-negative, and evidence-gap review; preserve prior versions; require optimistic state/version checks, idempotency, reviewer identity, reason codes, and transactional audit evidence for mutations; make candidates non-executable with explicit lineage; show cohort/member/sport/league/market slices and sample caution; create a linked new retrospective version after corrections; use bounded indexed reads without Scan.

**Block If:** A proposed mutation would require inventing a reviewer, approval scope, evidence provenance, candidate lineage, or frozen non-play universe. False-negative classification remains `not-evaluable` until such a universe exists.

**Never:** Treat a loss as proof of error or a win as proof of correctness; mix result/closing/grade knowledge into decision-time claims; rewrite historical versions; infer causal certainty; tune on evaluation cohorts; execute prompt/data/strategy changes; promote a strategy, schedule a challenger, or enable money mode; expose JWT subjects, secrets, prompts, licensed raw evidence, or arbitrary storage keys; use current pointers as authoritative evidence or Scan.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Frozen draft | Exact completed cohort/report and evidence | Stable retrospective/version IDs, slices, cautious observations, zero executable changes | Binding/digest/cutoff mismatch fails closed |
| Evidence layers | Opening/evaluation plus later grade/result/close | Separate digests and visibly separate claims/refs | Post-decision ref in decision claim is rejected |
| False-negative review | Play-only cohort without frozen non-play universe | `not-evaluable` evidence-gap state | Never widen or reconstruct cohort |
| Human review | Authorized reviewer, idempotency key, expected version/state | Append-only decision/audit and legal transition | 401/403/404/409/400 are distinct and safe |
| Correction | New immutable report revision | Linked retrospective vN+1; old version readable | Same identity/different content conflicts |
| Single member | One-game cohort | Review flags and caution allowed; no promotion side effect | Candidate remains non-executable |

</intent-contract>

## Code Map

- `packages/domain/src/retrospective.ts` -- canonical manifests, taxonomy, candidates, versions, reviews, identities, and transitions.
- `packages/scouting/src/retrospective.ts` -- pure deterministic retrospective/slice/observation construction.
- `packages/database/src/{retrospective,dynamodb-retrospective}-repository.ts` -- immutable versions, current projection, proposals, decisions, audits, and bounded indexes.
- `apps/workers/src/retrospective-builder.ts` -- exact cohort/report/evidence orchestration and correction lineage.
- `apps/api/src/{handler,lambda}.ts` -- public reads and approval-scoped review/revision mutations.
- `apps/web/src/{api,App,styles}.ts*` -- retrospective list/detail, evidence separation, lineage, proposals, and review controls.
- `infra/cdk/src/foundation.ts` -- routes, JWT approval scope, worker wiring, IAM, metrics, and alarms.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/retrospective.ts`, exports, and tests -- define strict closed taxonomy/code registry, exact two-layer evidence manifest, normalized IDs/digests, immutable versions/candidates/decisions, legal transitions, bounded safe text/change sets, single-member caution, and no-promotion invariant.
- [x] `packages/scouting/src/retrospective.ts`, package dependency/exports, and golden tests -- deterministically derive outcome and sport/league/market slices plus defensible evidence-backed observations without recomputing authoritative metrics or equating outcome with cause; mark false negatives not evaluable.
- [x] `packages/database/src/{retrospective,dynamodb-retrospective}-repository.ts`, exports, and race/pagination/corruption tests -- transactionally persist version/current/list/proposal/decision/audit rows; validate exact lineage/content on replay/read; preserve prior versions; use signed filter-bound cursors and Query only.
- [x] `apps/workers/src/retrospective-builder.ts`, performance runtime integration, metrics, and tests -- create one idempotent draft per completed report revision from exact frozen records, create correction-linked revisions, emit safe counts/latency/failures, and never log notes/raw evidence.
- [x] `apps/api/src/{handler,lambda}.ts` and tests -- add strict public list/detail/version/state reads plus JWT `retrospectives:approve` mutations with server reviewer/time, bounded body, content type, idempotency, expected version/state, safe status mapping, and redacted public audit state.
- [x] `apps/web/src/{api,App,styles}.ts*` and tests -- add responsive Retrospectives navigation/list/detail with frozen provenance, outcome/dimension slices, taxonomy matrix, member review, explicit decision-time/post-event panels, false-negative unavailable state, proposal lineage, version history, and scope-gated confirmation/conflict states.
- [x] `infra/cdk/src/{foundation,foundation.test}.ts`, `docs/runbooks/retrospectives.md`, exports/dependencies, and sprint status -- deploy routes/authorizer/scope/runtime/IAM/CORS/alarms, document exact-ID bounded rebuild and rollback, retain immutable records, and complete release checks.

**Acceptance Criteria:**
- Given the same frozen cohort/report/evidence in any input order or retry, when drafted, then retrospective content, evidence-layer digests, version identity, slices, observations, and proposal count are identical.
- Given a decision-time claim, when its references are validated, then only evidence knowable by the evaluation cutoff is accepted and later outcome/close/grade evidence cannot contaminate it.
- Given losses, wins, missing data, or a single-game cohort, when classified, then wording remains review-oriented, false-negative is unavailable without a frozen non-play universe, and no automatic change or promotion occurs.
- Given a correction or reviewer-requested changes, when a revision is created, then vN+1 links to the exact predecessor while all prior content, decisions, and audits remain readable and immutable.
- Given an unauthorized, stale, duplicate, malformed, or conflicting mutation, when submitted, then it fails with the correct safe response and cannot partially update current state, candidates, or audit history.
- Given the Retrospectives UI, when data is complete, partial, empty, or read-only, then evidence layers, lineage, caution, taxonomy, proposals, and permission state are accessible and never imply hindsight certainty.

## Spec Change Log

- 2026-08-04: Implemented immutable two-layer retrospective evidence, a closed taxonomy and cautious deterministic slices, correction-linked versions, Query-only persistence, optimistic/idempotent approval reviews, scheduled production building, public reads, approval-scoped mutations, the responsive Retrospectives UI, deployment wiring, monitoring, and the operator runbook.

## Review Triage Log

- 2026-08-04 — Review pass
  - intent_gap: 0
  - bad_spec: 0
  - patch: 28: (high 10, medium 16, low 2)
  - defer: 0
  - reject: 2: (high 0, medium 1, low 1)
  - addressed_findings:
    - `[high]` `[patch]` Secured and deduplicated retrospective pagination, newest-first current indexes, stored-row reconstruction, and atomic/idempotent review replay.
    - `[high]` `[patch]` Enforced decision/post-decision chronology and citations, removed outcome-based causal labels, and rejected conflicting frozen evidence.
    - `[high]` `[patch]` Made scheduled report/retrospective recovery idempotent across partial failures and correction races with deterministic replay comparison.
    - `[high]` `[patch]` Narrowed approval to a dedicated reviewer client, scope, and Cognito group while preserving public read-only analytics.
    - `[medium]` `[patch]` Added strict deep DTO validation, exhaustive guarded pagination, immutable history navigation, full audit display, evidence traceability, and accessible review confirmation/conflict handling.
    - `[medium]` `[patch]` Added bounded member retries, runtime enum validation, complete low-cardinality telemetry, aligned alarms, and operator guidance.

- 2026-08-04 adversarial repair: replaced public/forgeable pagination with secret-signed, scope-bound cursors; validated cursor targets and index/current/version links; reduced the global index to one current row per retrospective.
- 2026-08-04 adversarial repair: added exact report-to-version idempotency indexes, transaction-race replay payload equality, bounded correction retries, EventBridge-time retry identity, partial-failure report reuse, replay/success/failure/latency metrics, and bounded audit pagination.
- 2026-08-04 adversarial repair: bound every evidence ref to its decision cutoff, enforced both temporal layers and matching observation citations, rejected conflicting duplicate evidence IDs, and stopped labeling an ordinary losing outcome as a false positive.
- 2026-08-04 adversarial repair: added strict deep web validation, guarded list/version pagination, complete version and audit history, and an explicit reviewer-only mutation flow with action, note, confirmation, idempotency, optimistic concurrency, conflict reload, success refresh, and accessible status.
- 2026-08-04 adversarial repair: removed approval scope from the ordinary web client, added a dedicated reviewer client and Cognito reviewer group, required both group and scope server-side, accepted case-insensitive content type, corrected API write IAM, and removed duplicate worker IAM actions.
- 2026-08-04 convergence repair: exhausted report and audit pagination with cross-page duplicate/cycle/bound guards; made the Dynamo current index newest-first with one validated row per retrospective; linked every historical UI row to its immutable version and exposed units/ROI.
- 2026-08-04 convergence repair: reconstructed exact replay content before accepting report idempotency; checkpointed successful per-member evidence reads during bounded retries; removed arbitrary member citations from the cohort-policy false-negative limitation; fully validated replay decisions, audit keys, observation/candidate/review enums, and review-response bindings.
- 2026-08-04 convergence repair: added low-cardinality retrospective latency/replay/validation and review success/conflict/forbidden telemetry, meaningful validation/conflict/forbidden alarms, regression coverage, and matching operator guidance.

## Design Notes

False-positive and false-negative are review labels, not deterministic claims. A losing result alone never creates a false-positive observation; that label requires independent cited evidence. Current cohorts freeze Plays only, so false negatives remain explicitly unavailable until a later story introduces a frozen non-play universe. Approval here accepts only a non-executable review record; it does not promote, deploy, edit configuration, or enable wagering.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/scouting test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/api test`
- `pnpm --filter @find-the-edge/web test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm check`
- `git diff --check`

**Results (2026-08-04):** `pnpm check` passed across formatting, lint, package boundaries, all 15 package typechecks, tool typechecking, all tests (including 50 domain, 179 database, 134 worker, and 63 web tests), and production builds. Infrastructure synthesis tests passed for the separate ordinary/reviewer clients, reviewer group, routes, least-privilege IAM, and retrospective health alarms.
