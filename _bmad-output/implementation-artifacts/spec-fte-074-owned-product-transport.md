---
title: 'FTE-074 Owned Product Transport'
type: 'feature'
created: '2026-08-13'
status: 'done'
review_loop_iteration: 5
baseline_commit: 'a5f06e71bf7fabdbe11e3b2b65fe38e579eb8def'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-session-authorization-seam.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The browser owns and refreshes an `fte1` session, but ordinary product requests do not send it and protected route entry checks identity without resolving server-owned entitlement. Enabling the existing API gate would therefore sign out or paywall every product reader.

**Approach:** Inject the owned session store into the web API client, use one transport boundary to attach a freshly authorized `fte1` bearer to every existing authorizer-free product request, and resolve the existing billing-entitlement endpoint before protected routes render. Preserve all public, identity, billing, and Cognito request behavior for the later infrastructure cutover.

## Boundaries & Constraints

**Always:** Obtain the token through `SessionStore.authorize()` immediately before each product fetch, including every page of paginated reads. Preserve existing request options and response validation. A product 401 clears the owned session and produces an authentication result; a 402 remains distinct so the UI can show the on-site paywall. Route entry sends a missing/invalid session to `/login`, an unentitled session to `/subscribe`, and an entitled session to its requested route. `/subscribe` performs only its existing live-session check.

**Ask First:** Any change to the API, CDK, deployment flags, product-access enforcement, Cognito route transport, runtime Cognito configuration, or protected-route inventory.

**Never:** Attach `fte1` to provider status, OTP request/verify, Stripe webhook, or the existing Cognito scouting/watchlist/reviewer/promoter requests. Never infer entitlement from browser state, token contents, checkout return parameters, or a failed entitlement request. Never fall back from a rejected owned token to Cognito.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Product fetch | Live or refreshable owned session | Current `fte1` is sent as the sole bearer; pagination reauthorizes each page | Existing parsing/network errors remain unchanged |
| Session refusal | Missing token or product response 401 | No trusted request continues; stored session is cleared | Surface authentication and route to sign-in |
| Entitlement refusal | Valid session; entitlement says no access or product responds 402 | Product is not rendered | Surface payment-required and route to `/subscribe` |
| Public or legacy call | Provider/OTP/billing/Cognito path | Existing headers and token provider remain byte-for-byte in authority | Existing behavior remains unchanged |

</frozen-after-approval>

## Code Map

- `apps/web/src/session.ts` -- owned token refresh, persistence, invalidation, and route classification.
- `apps/web/src/api.ts` -- browser request implementations and the new owned product transport boundary.
- `apps/web/src/main.tsx` -- production composition root for the default session store and games client.
- `apps/web/src/App.tsx` -- TanStack Router session and entitlement guards.
- `apps/web/src/api.test.ts`, `apps/web/src/session.test.ts`, `apps/web/src/App.test.tsx` -- focused transport, lifecycle, and navigation contracts.
- `tests/e2e/session.ts` and protected E2E specs -- explicit owned access fixtures and browser-level authority checks.

## Tasks & Acceptance

**Execution:**

- [x] `apps/web/src/api.ts` -- add an injected owned-session transport, attach it only to authorizer-free product fetches, and normalize missing token/401/402 without changing other request families.
- [x] `apps/web/src/main.tsx` -- wire owned authorization plus centralized refusal navigation into the production client.
- [x] `apps/web/src/App.tsx` -- resolve refreshed identity and server entitlement before protected routes; retain the session-only subscribe guard.
- [x] `apps/web/src/api.test.ts` -- cover all product request families and pagination plus missing token, refresh, 401, 402, and unchanged public/Cognito calls.
- [x] `apps/web/src/session.test.ts` and `apps/web/src/App.test.tsx` -- pin session invalidation and anonymous/unentitled/entitled/no-loop navigation.
- [x] `tests/e2e/session.ts` and protected E2E specs -- seed entitled owned sessions, retain anonymous sign-in lifecycle coverage, and assert exact product bearer authority across desktop and mobile.

**Acceptance Criteria:**

- Given an entitled owned session, when any existing authorizer-free product screen reads one or more pages, then every request carries the current refreshed `fte1` bearer and the screen behaves unchanged.
- Given no usable owned session, when a protected route is entered or a product request begins, then no product response is trusted and the reader reaches on-origin sign-in.
- Given a valid but unentitled session, when a protected route is entered or a product request returns 402, then payment-required remains distinguishable and the reader sees `/subscribe` without a redirect loop.
- Given provider, OTP, billing, or Cognito-backed behavior, when this slice ships, then its authorization source and request headers are unchanged.

## Spec Change Log

- Review loop 1: independent adversarial and edge-case review found that the implementation contract did not explicitly map post-entry 401/402 responses into navigation, fence stale refusals against a newer token, require first-render refresher installation, or check cancellation after asynchronous authorization. It also found that the compatibility note allowed a missing entitlement resolver to pass a protected route. The implementation and tests now preserve the centralized product-fetch seam while making those states fail closed; missing client/entitlement configuration is an error, never implicit access.
- Review loop 2: re-review found a paywall prefetch reload loop, token-versus-account ambiguity for payment refusals, delayed cancellation while authorization was pending, missing-session navigation after route entry, and stale route-entitlement decisions after token replacement. The transport now carries request token and account identity, cancellation races authorization without canceling shared refresh, payment navigation is paywall-idempotent, public routes do not prefetch product data, and entitlement retries once for a replacement token before failing closed.
- Review loop 3: targeted re-review found that missing entitlement configuration preceded anonymous identity routing, route authorization did not settle with canceled navigation, and an old in-flight refresh could overwrite or clear a replacement account. Identity now resolves before entitlement configuration, canceled guards settle through a router-safe sentinel without later side effects, and refresh success/error paths require the initiating token to remain current before changing or authorizing store state.
- Review loop 4: final concurrency review found that a replacement account could still inherit the prior account's globally shared refresh promise. In-flight renewal is now keyed by its source token: concurrent requests for one token share, a replacement token starts independently, and each completion clears only its own entry.
- Review loop 5: root validation exposed that protected Playwright scenarios seeded browser identity without serving the new entitlement dependency, so they correctly redirected to sign-in. The E2E harness now provides separate entitled-product and anonymous-lifecycle fixtures, verifies exact owned bearer authority, and leaves production guards unchanged.

## Design Notes

The production games client always exposes the owned entitlement method, and protected routing fails closed if composition does not provide it. Tests may inject a narrow entitlement resolver independently of their screen client, but no runtime path treats a missing resolver as authorization. Authentication refusals are fenced by exact token so a late 401 cannot sign out a refreshed session. Payment refusals are fenced by account identity, preserving a 402 across same-account refresh while isolating an account switch.

## Verification

**Commands:**

- `pnpm --filter @find-the-edge/web test` -- expected: complete web suite passes.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: router context and transport contracts compile strictly.
- `pnpm --filter @find-the-edge/web lint` -- expected: changed web files satisfy lint rules.
- `pnpm exec playwright test` -- expected: all protected and anonymous desktop/mobile scenarios pass.
- `pnpm exec prettier --check apps/web/src _bmad-output/implementation-artifacts/spec-fte-074-owned-product-transport.md` -- expected: formatting passes.
- `git diff --check` -- expected: no whitespace errors and no API/CDK/flag changes.

**Verified:** 10 web test files / 357 tests and 34 Playwright desktop/mobile scenarios pass; web typecheck/lint, tools typecheck, targeted E2E lint, Prettier, and diff-check pass.

## Suggested Review Order

**Owned product authority**

- Start with the fail-closed transport that refreshes and classifies every product request.
  [`api.ts:1099`](../../apps/web/src/api.ts#L1099)

- Confirm production installs transport and refresh authority before router startup.
  [`main.tsx:16`](../../apps/web/src/main.tsx#L16)

**Session refusal and route access**

- Token-fenced authentication and account-fenced payment preserve the correct refusal authority.
  [`session.ts:174`](../../apps/web/src/session.ts#L174)

- Protected entry resolves owned identity and server entitlement, failing closed on uncertainty.
  [`App.tsx:106`](../../apps/web/src/App.tsx#L106)

- App composition preserves synchronous production refresh while supporting explicit test injection.
  [`App.tsx:3515`](../../apps/web/src/App.tsx#L3515)

**Regression coverage**

- E2E fixtures separate entitled product access from anonymous sign-in lifecycle.
  [`session.ts:1`](../../tests/e2e/session.ts#L1)

- Transport tests pin refusal classification, pagination refresh, and cancellation boundaries.
  [`api.test.ts:676`](../../apps/web/src/api.test.ts#L676)

- Session tests prove current-token navigation and stale-token isolation.
  [`session.test.ts:224`](../../apps/web/src/session.test.ts#L224)

- Router tests cover anonymous, unentitled, entitled, failure, and startup-refresh paths.
  [`App.test.tsx:75`](../../apps/web/src/App.test.tsx#L75)
