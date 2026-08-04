---
title: 'Preserve Exact Schedule Reconciliation Failure'
type: 'bugfix'
created: '2026-08-04'
status: 'done'
baseline_commit: '3968fc4'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/spec-sharpapi-schedule-row-conflict-isolation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Live SharpAPI schedule retrieval succeeds, but every league fails during canonical event reconciliation. The deployment summary collapses the internal reason to `event-reconcile`, preventing a safe choice between lock recovery, retained-data migration, and a code repair.

**Approach:** Preserve only explicitly allowlisted reconciliation reason codes across the worker boundary and deployment diagnostic. Keep unknown exceptions redacted, then use the exact deployed result to implement the correct retained-state repair rather than deleting data speculatively.

## Boundaries & Constraints

**Always:** Keep SharpAPI as the sole production provider; classify from a closed reason-code set; retain unknown-error redaction; add regression coverage for every newly exposed reason; require hosted evidence before changing retained AWS data.

**Ask First:** Broad deletion outside the exact development event namespace or weakening canonical identity/projection invariants.

**Never:** Restore The Odds API fallback; expose raw exception text, provider payloads, team names, event IDs, secrets, Dynamo keys, or AWS request details; classify unknown failures by substring; claim real odds are working without API and browser proof.

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Known reconciliation failure | A closed internal reason reaches the schedule boundary | Summary includes the exact bounded reason | League remains failed and no odds run starts |
| Unknown failure | Arbitrary error text or non-error value | Summary includes only the reconciliation stage | Raw material remains redacted |
| Hosted diagnosis | Deployment runs against retained development data | Exact failure determines the repair path | No speculative reset |

</frozen-after-approval>

## Code Map

- `apps/workers/src/production-odds-control-plane.ts` -- bounded schedule failure classification.
- `apps/workers/src/production-odds-control-plane.test.ts` -- classifier and orchestration regressions.
- `scripts/phase1-environment-smoke.mjs` -- accepted bounded deployment diagnostics.
- `scripts/phase1-environment-smoke.test.mjs` -- public diagnostic allowlist coverage.

## Tasks & Acceptance

**Execution:**
- [x] Extend the closed reconciliation classifier to all safe internal reasons reachable from the canonical reconciliation transaction.
- [x] Keep unknown Error messages, exception names, and non-Error values stage-redacted.
- [x] Extend deployment smoke validation without accepting arbitrary diagnostic text.
- [x] Run focused and full local quality gates and prepare the bounded diagnostic release for deployment.

**Acceptance Criteria:**
- Given a known internal reconciliation invariant failure, when live ingestion returns its summary, then the exact allowlisted code is visible without sensitive context.
- Given an unknown failure, when the same boundary runs, then only `schedule-provider-error-event-reconcile` is visible.
- Given the next deployment, when ingestion fails, then its bounded result identifies an actionable repair category.

## Spec Change Log

- 2026-08-04: Implemented exact-first schedule classification, removed broad substring classification from the schedule boundary, and added exhaustive worker/deployment allowlist regressions. Hosted verification remains pending deployment.

## Review Triage Log

- 2026-08-04 adversarial review: Restricted exact reconciliation diagnostics to the `event-reconcile` stage; introduced a closed typed and runtime-validated stage vocabulary; covered every explicit capability alias and failure; added orchestration proof for failed summary, run, schedule health, and odds suppression; accepted the two established bounded schedule-conflict outcomes in deployment validation; and replaced coincidental throw assertions with direct mixed-result allowlist tests. Hosted verification remains pending.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/workers test`
- `pnpm phase1:preflight`
- `pnpm check`
- GitHub deployment smoke against the retained development environment

## Dev Agent Record

### Completion Notes

- At the `event-reconcile` stage, exact reconciliation codes take precedence over the legacy general capability classifier, so bounded `mapping-*` invariants remain visible instead of collapsing to `mapping-quarantine`; the same codes at any other stage remain stage-redacted.
- The schedule boundary uses a closed stage type with runtime validation, accepts only exact capability failures and four explicit internal aliases, and never interpolates arbitrary stage input. Unknown messages containing words such as `mapping` or `pagination`, custom exception names, non-Error strings, objects, and null values all reduce to a bounded stage-only diagnostic.
- Worker coverage exercises every exposed reconciliation code, explicit alias, exact capability failure, cross-stage rejection, unknown-value category, and the full failed orchestration path. Deployment-smoke coverage directly proves the closed set and established conflict outcomes are accepted in a mixed result set while near-matches are rejected.
- Verification passed: all 165 worker tests, all 12 deployment-smoke tests, worker typecheck, `pnpm check`, `pnpm phase1:preflight`, and `git diff --check`. Commit, push, and hosted evidence remain for the deployment owner.

### File List

- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `scripts/phase1-environment-smoke.test.mjs`
- `_bmad-output/implementation-artifacts/spec-preserve-exact-schedule-reconciliation-failure.md`

## Suggested Review Order

**Closed diagnostic boundary**

- Exact invariant codes survive only at reconciliation; all other failures remain bounded.
  [`production-odds-control-plane.ts:260`](../../apps/workers/src/production-odds-control-plane.ts#L260)

- Deployment validation accepts the same closed vocabulary and established conflict states.
  [`phase1-environment-smoke.mjs:194`](../../scripts/phase1-environment-smoke.mjs#L194)

**End-to-end safety proof**

- Orchestration proves exact failure, unhealthy schedule state, and suppressed odds collection.
  [`production-odds-control-plane.test.ts:1264`](../../apps/workers/src/production-odds-control-plane.test.ts#L1264)

- Mixed deployment results retain approved diagnostics while rejecting near-matches.
  [`phase1-environment-smoke.test.mjs:306`](../../scripts/phase1-environment-smoke.test.mjs#L306)
