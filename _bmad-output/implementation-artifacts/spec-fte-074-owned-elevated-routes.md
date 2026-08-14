---
title: 'Move elevated mutations to owned roles'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: '4bb0255'
context:
  - '_bmad-output/implementation-artifacts/epic-12-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-owned-session-roles.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-capability-aware-elevated-ui.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-owned-ordinary-routes.md'
---

<frozen-after-approval reason="user authorized the recommended autonomous FTE-074 sequence">

## Intent

**Problem:** Retrospective review and strategy approve/promote/rollback still send a Cognito bearer through four JWT-authorized Gateway methods, even though server-owned roles and a strict owned capabilities projection now exist. Cognito cannot be retired while these last mutations depend on it.

**Approach:** Atomically send the current owned `fte1` session for all four mutations and synthesize those methods without a Gateway authorizer. Keep the existing capability precheck, then let Lambda verify the owned session, strongly load server-owned roles, and let handlers enforce both canonical scope and role boolean.

## Boundaries & Constraints

**Always:** Fetch and validate capabilities immediately before every mutation; bind capability account to mutation account; obtain/fence the exact current owned authorization before dispatch and through every terminal success/error; preserve abort, bodies, concurrency versions, 403/409/validation/response contracts, and current token-fenced 401/account-fenced 402 refusal semantics. Missing, malformed, expired, revoked, foreign, absent-role, or wrong-role authority must fail closed before mutation repositories. Exactly four elevated POST methods become `NONE` while all Cognito resources/runtime plumbing remain available for coordinated rollback.

**Ask First:** Any live deploy/cutover, role provisioning, product-enforcement change, handler authorization relaxation, token/schema change, Cognito resource deletion, or change to role/capability definitions.

**Never:** Infer role from browser state or account identity; trust a prior UI capability read for mutation; fall back from owned authority to Cognito; send a legacy bearer; weaken the handler's full-scope-plus-role check; enable `FTE_PRODUCT_ACCESS_ENFORCED`; claim FTE-074 complete; mutate AWS or GitHub state in this slice.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Authorized mutation | Current owned role and matching capability | Capability GET then exact owned POST; existing success response | Final exact-session fence |
| Ordinary/wrong-role account | Missing required capability or role | No mutation or handler 403; zero repository mutation | Do not sign out |
| Invalid authority | Missing/malformed/expired/revoked/foreign token | 401 before role/mutation access as applicable | Token-fenced refusal only for current session |
| Session replacement | Account/token changes during check, dispatch, or response | Old operation cannot use or affect replacement authority | Cancellation; no stale UI write |
| Same-account refresh | Token rotates during capability resolution | Re-resolve exact token for POST; never send the old token accidentally | Preserve account role, fence exact request |
| Abort/timeout | Check or POST pending | Settle promptly; no late fetch/refusal/UI effect | Preserve cancellation semantics |
| Concurrent mutation | 409 or validation rejection | Existing domain-specific result remains | No authority fallback or automatic replay |

</frozen-after-approval>

## Code Map

- `apps/web/src/api.ts` and `.test.ts` -- elevated capability-to-mutation owned transport and race/refusal contracts.
- `apps/api/src/authorization-context.ts`, `lambda.ts`, and tests -- owned role projection into real elevated handlers.
- `infra/cdk/src/foundation.ts` and `.test.ts` -- exact four-route Gateway detachment with retained Cognito resources.
- `scripts/phase1-support.mjs` and `.test.mjs` -- deployment template partition validation.
- `apps/web/src/experiments.tsx`, `retrospectives.tsx`, and UI tests -- existing abortable capability/action lifecycle, changed only if owned transport exposes a new cancellation boundary.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api.ts` -- replace legacy elevated bearer reads with a fresh owned mutation request after the capability check; fence all terminal outcomes.
- [x] `apps/web/src/api.test.ts` -- prove all four owned POSTs, denial, refresh, replacement, refusal, abort, and existing response mappings.
- [x] `apps/api/src/authorization-context.ts`, `lambda.ts`, and tests -- inventory the exact four detached elevated route keys, suppress stale/synthetic Gateway claims, and drive raw owned headers through actual elevated handlers to prove role success and invalid/no/wrong-role no-mutation behavior.
- [x] `infra/cdk/src/foundation.ts` and `.test.ts` -- detach exactly four elevated routes while retaining Cognito resources and false product enforcement.
- [x] `scripts/phase1-support.mjs` and `.test.mjs` -- require the complete owned-route partition and reject partial reattachment.
- [x] Existing elevated UI tests -- confirm read-only defaults, session replacement cancellation, and no stale mutation effect remain green.

**Acceptance Criteria:**
- Given a valid owned account with the exact server role, each elevated mutation uses only its current `fte1` bearer and reaches the existing handler contract.
- Given any invalid, revoked, unprivileged, or wrong-role account, no elevated repository mutation occurs and the response is 401 or 403 as appropriate.
- Given synthesized/preflight infrastructure, all formerly protected product routes are handler-authenticated, the four elevated methods have no authorizer/scopes, and Cognito resources remain unchanged for rollback.
- Given a detached elevated route with stale synthetic Gateway claims but no valid owned bearer, the production adapter supplies no subject, scope, or role authority.
- Given no verified live staging role row, this code remains undeployed and FTE-074 remains incomplete.

## Spec Change Log

## Design Notes

The capability response is a browser affordance and preflight, never final authority. The same owned POST is independently verified in Lambda and checked again by the handler. Local implementation can complete without live credentials; deployment requires stage-specific role provisioning and positive/negative staging smokes.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test && pnpm --filter @find-the-edge/web typecheck && pnpm --filter @find-the-edge/web lint`
- `pnpm --filter @find-the-edge/api test && pnpm --filter @find-the-edge/api typecheck && pnpm --filter @find-the-edge/api lint`
- `pnpm --filter @find-the-edge/infra-cdk test && pnpm phase1:test`
- `pnpm check && git diff --check`

**Verified locally:** Web 10 files / 436 tests, API 17 files / 264 tests, infrastructure synthesis tests, Phase 1 template validation 85/85, package lint/typecheck, `git diff --check`, and the full repository `pnpm check` all pass. The full gate includes formatting, boundaries, all package tests/builds, and 34/34 Playwright desktop/mobile tests. Final independent results: Blind Hunter `CLEAN`; Edge Case Hunter `[]`.

**Deferred staging gate:** No deployment or live role mutation was performed. After a stage-specific role row is provisioned, use authorized owned POSTs against canonical nonexistent retrospective/experiment IDs to prove the request crosses authentication and role checks into a non-mutating 404, paired with wrong-role 403 and invalid-token 401 checks, before exercising any real mutation.

## Suggested Review Order

**Owned server authority**

- Start with the exact detached elevated-route inventory and stale-Gateway suppression.
  [`authorization-context.ts:56`](../../apps/api/src/authorization-context.ts#L56)

- Follow raw owned authority through actual elevated handlers and repository guards.
  [`authorization-context.test.ts:368`](../../apps/api/src/authorization-context.test.ts#L368)

**Capability-to-mutation transport**

- Capability terminals are account-fenced before either approval or error can escape.
  [`api.ts:3707`](../../apps/web/src/api.ts#L3707)

- Strategy actions reauthorize and send only the fresh owned mutation bearer.
  [`api.ts:4298`](../../apps/web/src/api.ts#L4298)

- Retrospective review preserves validation while replacing the legacy bearer path.
  [`api.ts:4890`](../../apps/web/src/api.ts#L4890)

**Gateway and release boundary**

- All four elevated methods now delegate authentication to Lambda without an authorizer.
  [`foundation.ts:1576`](../../infra/cdk/src/foundation.ts#L1576)

- Preflight requires zero API Gateway authorizers and rejects partial rollback states.
  [`phase1-support.mjs:656`](../../scripts/phase1-support.mjs#L656)

**Regression evidence**

- Browser tests cover refresh, replacement, refusal, abort, and malformed capability races.
  [`api.test.ts:1298`](../../apps/web/src/api.test.ts#L1298)

- Structural tests preserve Cognito rollback resources while removing route dependencies.
  [`foundation.test.ts:610`](../../infra/cdk/src/foundation.test.ts#L610)
