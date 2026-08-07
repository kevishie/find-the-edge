---
title: 'FTE-043: Scouting Progress UI and Retry States'
type: 'feature'
created: '2026-08-07'
status: 'in-review'
baseline_revision: '7471d9970e0932f8d0a16a1f7d8f142461c3f047'
baseline_commit: '7471d9970e0932f8d0a16a1f7d8f142461c3f047'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/epic-7-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-038-scout-event-api-idempotent-job-model-sqs-and-step-functions.md'
warnings:
  - oversized
---

<intent-contract>

## Intent

**Problem:** The protected Scout Event job API is live in the codebase, but every game surface still says scouting is unavailable. A user cannot start a job, follow it after navigation or refresh, understand a safe failure, or retry a permitted attempt.

**Approach:** Restore selective click-triggered Cognito access without restoring a login wall, add a strict browser client for the FTE-038 command/status contract, and provide a deep-linkable progress surface that polls only real server states, preserves monotonic evidence, and offers fenced retry when allowed.

## Boundaries & Constraints

**Always:** Keep games, splits, odds, and provider-status browsing anonymous; authentication begins only when a protected scouting action or job link requests a token. Request exactly event-read plus scouting-read/write scopes, validate the access-token issuer/client/use/expiry/scopes, and send it only to the configured API origin. Enable Scout for any scheduled canonical event and disable it with an explicit reason for every other lifecycle state. Generate one cryptographically strong idempotency key per logical create/retry action, keep it across double-clicks, uncertain transport outcomes, and same-session refresh, and clear it only after a validated authoritative response. Accept both `200` convergence and `202` creation. Strictly validate the exact public job DTO, IDs, timestamps, attempt/state chronology, failure consistency, and `Location`/body identity before rendering. Map only `queued`, `in_progress`, `completed`, `failed_retryable`, `failed_terminal`, and `cancelled` to text-labelled UI states. Load `/scout-jobs/$jobId` entirely from its route, poll only queued/in-progress jobs, pause while hidden, abort on route/unmount, retain the last valid state during transient refresh failures, and never apply a lower `stateVersion` or same-version contradictory response. Retry only the latest `failed_retryable` job whose public failure says retryable, using its exact state version and a new stable action key; reconcile `409`/`422` by re-reading server state. Announce real status changes once, provide safe focusable actions, retain usable mobile layout, and use event context only as current display context rather than pretending it is the immutable job snapshot.

**Block If:** The browser cannot acquire and locally validate all required scopes from the existing Cognito client; a progress state would require data absent from the public job contract; or safe retry cannot be fenced to the latest server state.

**Never:** Restore a blanket authentication wall; redirect during anonymous page load; fabricate collecting/generating/calculating substeps, percentages, partial-data states, reports, or completion timing; expose `workflowIntent`, raw failure codes, provider/AWS terms, response bodies, tokens, requester identity, or internal errors; retry completed, terminal, cancelled, active, or exhausted work; poll in the background or after terminal state; use automatic scouting language; weaken protected API scopes; or deploy merely to test.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Start scouting | Scheduled event, no pending action | One protected `POST {}` with stable key; validated `200/202` opens returned job route | Button is single-flight; uncertain outcome retains key for explicit retry |
| Direct progress link | Valid job ID after refresh | Acquire scoped session, read job, render exact status and event link | Malformed ID makes no request; missing/foreign job share neutral unavailable copy |
| Active progress | Queued or in-progress DTO | Poll with bounded backoff, pause hidden, apply only monotonic state | Transient/503 keeps last state and shows reconnect action; abort stale requests |
| Successful terminal | Completed DTO | Stop polling; show calm completion and View game | Do not invent or link a report |
| Retryable failure | Failed-retryable DTO with `failure.retryable=true` | Safe explanation and one fenced Retry action | `409/422` re-read current state; no blind second retry |
| Nonretryable terminal | Failed, cancelled, or attempt-limit DTO | Stop polling; safe next-step guidance without Retry | Raw failure code/message never rendered |
| Authentication failure | Missing/expired session or insufficient scopes | Click-triggered login or safe sign-in/permission state | `401/403` stop polling and reveal no job details |
| Stale response race | Poll resolves after retry/newer response | Lower version ignored; same-version mismatch is invalid evidence | Preserve newest valid state and expose safe refresh failure |

</intent-contract>

## Code Map

- `apps/web/public/cognito-token-provider.js`, `apps/web/index.html` -- dormant PKCE session provider and script order; restore lazy acquisition without page-load redirect.
- `apps/web/src/runtime-config.ts` and tests -- exact non-secret multi-scope launch configuration accepted by the browser.
- `scripts/generate-web-runtime-config.mjs`, `build-phase1-web.mjs`, `phase1-support.mjs`, launch/support/provider tests -- generate and verify the same selective-auth runtime contract in local bundles and release tooling.
- `apps/web/src/api.ts` and `api.test.ts` -- strict job parser, common scoped-session boundary, protected create/read/retry methods, status/error mapping, and idempotency headers.
- `apps/web/src/scouting.tsx` and tests -- mutation-key persistence, monotonic polling/retry controller, safe state presentation, focus/live-region behavior, and event link.
- `apps/web/src/App.tsx`, `App.test.tsx`, and `styles.css` -- enable eligible desktop/mobile/detail Scout actions, register the deep-link route, and style accessible responsive progress states.
- `infra/cdk/src/foundation.ts` and tests -- emit the exact browser scope set and preserve `/scout-jobs/*` as an SPA route.
- `tests/e2e/scouting.spec.ts` -- mocked desktop/mobile start, progress, failure, refresh, and retry flows without deployment.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/public/cognito-token-provider.js`, `apps/web/index.html`, runtime-config/build/launch/support scripts and tests -- restore a lazy PKCE provider requesting and validating the exact three-scope set while preserving anonymous startup and secret-free artifacts.
- [x] `apps/web/src/api.ts`, `apps/web/src/api.test.ts` -- add strict `PublicScoutingJob` parsing plus scoped create/get/retry methods with exact headers, status mapping, abort behavior, and safe typed failures.
- [x] `apps/web/src/scouting.tsx`, `apps/web/src/scouting.test.tsx` -- implement stable mutation-key storage, monotonic visible-only polling, direct-link loading, terminal states, transient reconnect, and fenced retry.
- [x] `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`, `apps/web/src/styles.css` -- wire Scout from scheduled rows/cards/detail, register `/scout-jobs/$jobId`, preserve anonymous browsing, and deliver keyboard/mobile/live-region UX.
- [x] `infra/cdk/src/foundation.ts`, `infra/cdk/src/foundation.test.ts`, `tests/e2e/scouting.spec.ts` -- synthesize the exact runtime scopes/SPA deep link and prove representative desktop/mobile flows.
- [x] Run focused browser/script/infrastructure/E2E suites, full `pnpm check`, local viewport checks, and diff/secret hygiene without deployment.

**Acceptance Criteria:**
- Given an anonymous visitor on a public game page, when the page loads, then no auth redirect or protected request occurs; when Scout is clicked on a scheduled event, then the existing PKCE flow requests all scouting scopes and one logical idempotent create opens the authoritative job route.
- Given a queued or in-progress job, when its route is opened directly, refreshed, hidden, restored, or receives out-of-order network responses, then progress remains monotonic, visible-only polling is bounded and abortable, transient failures do not erase confirmed state, and terminal states stop all polling.
- Given any server status or safe API failure, when it is rendered on desktop or a narrow viewport, then text and semantics—not color or animation alone—communicate the state, raw internals never appear, and Retry exists only for the latest server-authorized retryable attempt.
- Given an uncertain mutation response, duplicate click, convergence response, retry conflict, or attempt limit, when the user continues, then the same logical key is reused until authority is known, `200/202` converge to one job, `409/422` trigger a read rather than duplicate work, and stale responses cannot regress the UI.
- Given FTE-040 through FTE-044 are not complete, when FTE-043 reports progress or completion, then it does not fabricate provider phases, partial data, a report, PASS, recommendations, or automatic scouting.

## Spec Change Log

## Review Triage Log

### 2026-08-07 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 11 (high: 8, medium: 3, low: 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Aligned launch CSP, preflight, and exact scope validation so selective Cognito access is launchable.
  - `[high]` `[patch]` Added the `/auth/callback` SPA rewrite and prevented callback failures from redirecting in a loop.
  - `[high]` `[patch]` Enforced immutable public job identity and chronology across higher-version responses.
  - `[high]` `[patch]` Made token acquisition and protected requests abortable and time-bounded.
  - `[high]` `[patch]` Invalidated a cached access token after an API `401` so explicit recovery can acquire a new session.
  - `[medium]` `[patch]` Cleared stale refresh and retry errors after authoritative reconciliation.
  - `[medium]` `[patch]` Replaced key-order-sensitive DTO comparison with semantic equality.

### 2026-08-07 — Follow-up review pass

- intent_gap: 0
- bad_spec: 0
- patch: 5 (high: 4, medium: 1, low: 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Required expected DynamoDB actions to remain table-bound and allowed index-only resources only for safe query operations.
  - `[high]` `[patch]` Added a bounded timeout to the Cognito authorization-code exchange.
  - `[high]` `[patch]` Neutralized authoritative `404`, authentication, and authorization responses so stale job details cannot remain visible.
  - `[medium]` `[patch]` Allowed a later explicit sign-in attempt after a callback failure while still rejecting the failed attempt once.

### 2026-08-07 — Convergence review pass

- intent_gap: 0
- bad_spec: 0
- patch: 1 (high: 1, medium: 0, low: 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Consumed stale resume markers even when an event is temporarily ineligible, preventing a later protected mutation without a fresh user action.
- follow-up verification: Blind review returned no findings; the edge-case reviewer confirmed the final patch resolved its finding.

## Design Notes

The browser remains public-first. Loading the token-provider script installs a non-secret function only; its first call may redirect through Cognito. The progress route is protected because job existence is owner-scoped, but the surrounding shell and every existing read-only route remain publicly usable.

The canonical progress route is `/scout-jobs/$jobId`. Completion and failure offer `View game` using the job's canonical `eventId`; no return-search state or report identifier is required. Scout is sport-agnostic for scheduled events because the server contract is sport-agnostic and the product is soccer-first, not soccer-only.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test && pnpm --filter @find-the-edge/web typecheck && pnpm --filter @find-the-edge/web lint && pnpm --filter @find-the-edge/web build` -- strict client and progress UI pass locally.
- `node --test scripts/generate-web-runtime-config.test.mjs scripts/cognito-token-provider.test.mjs scripts/phase1-support.test.mjs scripts/phase1-launch.test.mjs` -- lazy scoped-auth bundle/release contract passes.
- `pnpm --filter @find-the-edge/infra-cdk test && pnpm --filter @find-the-edge/infra-cdk typecheck` -- protected routes, scope output, and SPA deep link synthesize correctly.
- `pnpm exec playwright test tests/e2e/scouting.spec.ts` -- mocked desktop/mobile journey and retry flow pass locally.
- `pnpm check && git diff --check` -- complete repository gate and diff hygiene pass without deployment.

## Auto Run Result

### Summary

Implemented a public-first scouting experience with click-triggered scoped Cognito access, strict public job validation, idempotent create/retry actions, deep-linked progress, monotonic visible-only polling, safe failure recovery, and responsive scheduled-game Scout actions.

### Review Breakdown

- Initial review: 11 patches applied (8 high, 3 medium).
- Follow-up review: 5 patches applied (4 high, 1 medium).
- Convergence review: 1 high patch applied and independently verified; the companion blind review returned no findings.
- `followup_review_recommended: false` because three review passes converged with no unresolved, deferred, rejected, or specification findings.

### Verification Evidence

- `pnpm check` passed, including 190 web tests and all repository format, lint, boundary, type, infrastructure, script, and build gates.
- `node scripts/phase1-preflight.mjs` passed against the locally synthesized credential-free launch template.
- `pnpm exec playwright test tests/e2e/scouting.spec.ts` passed 4/4 desktop and mobile flows.
- `git diff --check` passed.
- No deployment was performed for testing.

### Residual Risks

- The live Cognito and API exchange still requires environment validation after release; local tests cover the complete browser contract with mocked network boundaries and synthesized infrastructure.
- The web build emits a non-blocking JavaScript chunk-size warning at approximately 510 kB; future route-level splitting can reduce initial transfer size.
