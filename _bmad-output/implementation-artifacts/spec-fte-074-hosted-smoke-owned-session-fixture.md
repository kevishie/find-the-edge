---
title: 'Repair hosted smoke after owned-route cutover'
type: 'bugfix'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'c5ad045c31b69783b4ebedf9b791728a3b5e90f2'
context:
  - '_bmad-output/implementation-artifacts/epic-12-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-owned-ordinary-routes.md'
  - '_bmad-output/implementation-artifacts/spec-fte-074-owned-elevated-routes.md'
---

<frozen-after-approval reason="user authorized autonomous repair of the failed staging release gate">

## Intent

**Problem:** The FTE-074 staging infrastructure and browser bundle deployed successfully, but the hosted release smoke still seeds a deliberately synthetic client session while allowing its newly owned `GET /watchlist` request to reach the real API. The API correctly rejects that unverifiable token, the browser signs out, and the provider-board assertion times out on the login screen.

**Approach:** Keep the smoke's real staging `/games` and hosted-bundle coverage, but extend its existing synthetic-session boundary to mock only the account-owned empty watchlist response. Require an exact synthetic bearer and prove both entitlement and watchlist seams were exercised before accepting provider-board assertions.

## Boundaries & Constraints

**Always:** Preserve real hosted HTML/assets, real public provider-board reads, runtime configuration checks, event drill-in, and signed-out navigation. Mock only `GET`/`OPTIONS` for entitlement and watchlist under the explicit synthetic fixture; require the exact fixture bearer, return canonical no-store/CORS responses, reject unexpected methods, and assert both mocks were called.

**Ask First:** Any production-code authorization relaxation, use of a real user token in CI, product-enforcement change, rollback-policy change, or expansion beyond the hosted smoke fixture.

**Never:** Accept arbitrary authorization; mock `/games`, event detail, or all API traffic; place a phone, OTP, owned token, or account identifier in GitHub configuration/logs; bypass the protected deploy workflow; treat the fixture as proof of real identity verification.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Hosted provider smoke | Synthetic local session; entitlement and watchlist GETs | Exact bearer receives active entitlement and canonical empty watchlist; real `/games` renders | Both interceptions must be observed |
| Preflight | OPTIONS for either mocked route | 204 with exact CORS headers | No fixture counter increment |
| Wrong authority | Missing or different bearer | 401 no-store JSON | Browser cannot proceed as the fixture account |
| Unexpected method | Non-GET request to mocked collection | 405 | No permissive fallback |
| Signed-out smoke | No local session | Existing on-origin login assertion remains real | No mock may hide the login boundary |

</frozen-after-approval>

## Code Map

- `tests/phase1-e2e/environment.spec.ts` -- hosted synthetic-session setup and real staging provider-data assertions.
- `playwright.phase1.config.ts` -- isolated hosted-test configuration and timeout.
- `scripts/phase1-launch.mjs` -- deploys the verified bundle, then invokes the hosted smoke; unchanged unless verification exposes a harness integration defect.

## Tasks & Acceptance

**Execution:**
- [x] `tests/phase1-e2e/environment.spec.ts` -- add an exact-authority empty-watchlist fixture beside entitlement and assert both seams execute.
- [x] Focused hosted test -- run the repaired local test against the already-deployed staging release.
- [x] Repository gates -- run formatting, lint/typecheck as relevant, Phase 1 safety tests, and diff validation.

**Acceptance Criteria:**
- Given the synthetic hosted session, when the owned browser loads the event explorer, then entitlement and watchlist are both exercised with the exact bearer while provider boards still come from the live staging API.
- Given the current staging release, when the focused hosted suite runs, then all three scenarios pass without weakening server authorization or using a real session token.
- Given a subsequent protected deployment, when hosted smoke completes, then the live product-access readback step runs and confirms enforcement remains false.

## Spec Change Log

## Design Notes

The synthetic session is intentionally confined to browser rendering coverage. Server-owned authentication is proven separately by the live capability check and handler/repository matrices; this fixture must not pretend to validate token signatures. Returning an empty watchlist keeps account data isolated while allowing the event explorer to remain mounted long enough to exercise real provider boards.

## Verification

**Commands:**
- `FTE_PHASE1_API_BASE=https://api-staging.kevishie.com FTE_WEB_ORIGIN=https://staging.kevishie.com FTE_PHASE1_BROWSER_BASE_URL=https://staging.kevishie.com pnpm exec playwright test --config=playwright.phase1.config.ts` -- 3/3 passed.
- `pnpm phase1:test` -- 85/85 passed.
- `pnpm typecheck:tools` and scoped ESLint -- passed.
- Scoped Prettier check and `git diff --check` -- clean.

**Review:** Blind Hunter found that a fulfilled mock alone did not prove the
client parsed the watchlist response. The hosted provider test now also
requires the real row's enabled add-to-watchlist action, proving the fixture
reaches the ready UI state. Edge Case Hunter reported no findings.

## Suggested Review Order

**Synthetic owned-session boundary**

- Confines the mock to exact-authority entitlement and empty-watchlist reads.
  [`environment.spec.ts:94`](../../tests/phase1-e2e/environment.spec.ts#L94)

**False-positive prevention**

- Requires the owned watchlist request, rejecting stale pre-cutover bundles.
  [`environment.spec.ts:191`](../../tests/phase1-e2e/environment.spec.ts#L191)

- Proves the response parsed by requiring a usable control on real data.
  [`environment.spec.ts:203`](../../tests/phase1-e2e/environment.spec.ts#L203)
