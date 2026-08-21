---
title: 'Move ordinary authenticated routes to owned sessions'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f4d87ec04914eccd22f818f80e6425893811b5d6'
context:
  - '_bmad-output/implementation-artifacts/epic-12-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-owned-product-transport.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-capability-aware-elevated-ui.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Ten ordinary authenticated API methods still depend on Cognito JWT authorization, while the signed-in web application owns an `fte1` session and its scouting, report, and watchlist clients still send legacy Cognito credentials. Detaching only the gateway authorizer would make all nine active browser methods fail closed with 401.

**Approach:** Atomically move those browser calls to the existing refreshed owned-session transport and synthesize all ten ordinary routes with API Gateway `NONE`, relying on the Lambda's verified owned-token authorization context and existing handler scope/subject checks. Preserve Cognito and the exact four elevated JWT methods as rollback and transition infrastructure.

## Boundaries & Constraints

**Always:** Re-authorize immediately before every physical request, including polling and report reads; send only the current bounded `fte1` token and account; preserve abort, timeout, idempotency, content-type, response parsing, neutral cross-account 404s, and exact status mappings. Invalid, expired, revoked, foreign, or missing owned authority must fail closed before data access. A current-session 401 must use the existing exact-token refusal fence, a 402 must remain a distinct account-fenced payment refusal, and a stale completion must not clear or redirect a replacement account. The ten ordinary routes must synthesize without an authorizer while the four elevated mutations retain their exact JWT scopes.

**Ask First:** Any need to change the owned token format, identity/account storage, handler authorization semantics, product-access enforcement value, elevated roles/scopes, or the staged rollout boundary.

**Never:** Remove Cognito resources, clients, groups, domain, runtime configuration, outputs, or CSP support; change elevated mutation transport; decode Cognito claims for ordinary calls; enable `FTE_PRODUCT_ACCESS_ENFORCED`; claim entitlement cutover; deploy or mutate live AWS in this slice.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Ordinary request | Current owned account/session | Exact method, path, body, and latest `Bearer fte1`; handler sees owned subject/scopes | Preserve existing success contract |
| Repeated request | Token refresh between calls | Each request resolves and sends the newer token | Never reuse cached authority |
| No valid authority | Missing, malformed, expired, revoked, or foreign token | 401 and no repository mutation/read beyond identity verification | Fail closed; no legacy-provider fallback |
| Session changes in flight | Account/token replaced before completion | Stale result cannot affect replacement session | Reject/fence stale completion |
| Abort or timeout | Authorization or fetch pending | Settle promptly; no late fetch or session side effect | Preserve AbortError or bounded unavailable error |
| API denial | 401 / 402 / 403 / 404 / 409 / 422 | Authentication / payment / forbidden / neutral missing / conflict / eligibility mapping remains distinct | Refuse only with the existing token/account fence |
| Elevated request | Review or experiment mutation | Owned capability precheck plus opaque legacy bearer and JWT gateway scope remain | No ordinary-transport substitution |

</frozen-after-approval>

## Code Map

- `apps/web/src/api.ts` -- ordinary scouting, report, and watchlist request helpers; shared owned-session transport; elevated legacy seam.
- `apps/web/src/api.test.ts` -- nine-method transport, refresh, refusal, abort, timeout, and response-contract matrix.
- `apps/api/src/lambda.ts` and adapter tests -- raw bearer classification and verified owned authorization composition for all ten routes.
- `infra/cdk/src/foundation.ts` -- API Gateway authorization boundary and retained Cognito/elevated routes.
- `infra/cdk/src/foundation.test.ts` -- exact ten `NONE` and four JWT route contract.
- `scripts/phase1-support.mjs` and `.test.mjs` -- deployment template validation for the same authorization partition.
- `tests/e2e/session.ts`, `tests/e2e/scouting.spec.ts`, `tests/e2e/watchlist.spec.ts` -- browser request authority and owned-session flows.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/api.ts` -- replace ordinary Cognito token acquisition with the injected owned transport, expose all nine active methods without Cognito launch fields, and preserve elevated legacy transport.
- [x] `apps/web/src/api.test.ts` -- pin every ordinary method's current-token request and the frozen edge-case matrix, including reports and refresh.
- [x] `apps/api/src/*test.ts` -- prove the raw-header adapter accepts a valid owned session and rejects absent/invalid/revoked/foreign authority for all ten routes without side effects.
- [x] `infra/cdk/src/foundation.ts` and `.test.ts` -- detach exactly ten ordinary methods and retain one authorizer plus four exact elevated JWT methods.
- [x] `scripts/phase1-support.mjs` and `.test.mjs` -- update preflight validation to enforce the same split and reject partial/mixed cutovers.
- [x] `tests/e2e/session.ts`, scouting, and watchlist specs -- remove ordinary Cognito fixtures and observe exact owned authority across active routes.

**Acceptance Criteria:**
- Given synthesized infrastructure, exactly the ten listed ordinary methods are `NONE`, exactly four elevated methods remain JWT with canonical scopes, and Cognito resources remain.
- Given a production-configured browser without usable Cognito fields, all nine active ordinary client methods exist and use refreshed owned authority while elevated behavior is unchanged.
- Given a request reaching Lambda after authorizer detachment, only a verified current owned account can populate subject and ordinary scopes; invalid authority cannot reach protected storage behavior.
- Given deployment preflight, reattaching JWT to any ordinary route or detaching JWT from an elevated route is rejected.

## Spec Change Log

## Design Notes

`GET /events` has no active browser caller; it still moves with the server route family and is covered at the adapter/infrastructure boundary. Product enforcement remains explicitly false, so this slice changes identity authentication, not entitlement enforcement. The current infrastructure-first deployment order creates a brief old-browser compatibility window; this slice does not claim zero downtime. Rollback must revert browser and gateway artifacts together because an API Gateway JWT authorizer rejects `fte1` before Lambda.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test && pnpm --filter @find-the-edge/web typecheck && pnpm --filter @find-the-edge/web lint` -- web transport and UI contracts pass.
- `pnpm --filter @find-the-edge/api test && pnpm --filter @find-the-edge/api typecheck && pnpm --filter @find-the-edge/api lint` -- adapter/handler boundary passes.
- `pnpm --filter @find-the-edge/infra-cdk test && pnpm phase1:test` -- synthesized and preflight route contracts pass.
- `pnpm test:e2e` -- owned scouting/watchlist browser flows pass.
- `pnpm check && git diff --check` -- repository gate and whitespace checks pass.

**Verified:** Full `pnpm check`; web 429 tests; API 256 tests; infrastructure 27 tests; phase-one validation 85 tests; Playwright 34/34 desktop and mobile; typecheck, lint, build, formatting, boundaries, and diff-check all pass. Blind Hunter final result: CLEAN. Edge Case Hunter final result: `[]`.

## Suggested Review Order

**Server authority boundary**

- Start with the exact ten-route owned-session classification and fail-closed projection.
  [`authorization-context.ts:43`](../../apps/api/src/authorization-context.ts#L43)

- Follow the production Lambda composition from raw headers into handler fields.
  [`lambda.ts:331`](../../apps/api/src/lambda.ts#L331)

**Browser transport and isolation**

- Ordinary requests reauthorize, parse under timeout, and fence every terminal outcome.
  [`api.ts:3357`](../../apps/web/src/api.ts#L3357)

- Watchlist state and mutations synchronously mask data owned by another session.
  [`App.tsx:699`](../../apps/web/src/App.tsx#L699)

- Create and retry persistence is account-scoped across switches and token refreshes.
  [`scouting.tsx:132`](../../apps/web/src/scouting.tsx#L132)

- Progress rendering and actions remain exact-session-owned through polling and retries.
  [`scouting.tsx:466`](../../apps/web/src/scouting.tsx#L466)

- Report and version-history requests mask old owners and abort on replacement.
  [`scout-report.tsx:299`](../../apps/web/src/scout-report.tsx#L299)

**Gateway and release contract**

- CDK detaches only ordinary methods while retaining elevated Cognito authorization.
  [`foundation.ts:1493`](../../infra/cdk/src/foundation.ts#L1493)

- Preflight rejects partial cutovers or accidental elevated-route detachment.
  [`phase1-support.mjs:725`](../../scripts/phase1-support.mjs#L725)

**Regression evidence**

- Raw route/header cases invoke real handlers and prove protected repositories remain untouched.
  [`authorization-context.test.ts:93`](../../apps/api/src/authorization-context.test.ts#L93)

- Browser tests pin refresh, refusal, malformed-body, timeout, and stale-completion behavior.
  [`api.test.ts:150`](../../apps/web/src/api.test.ts#L150)

- E2E authority observation covers every active scouting, report, and watchlist method.
  [`session.ts:15`](../../tests/e2e/session.ts#L15)
