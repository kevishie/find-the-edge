---
title: 'FTE-074 Capability-Aware Elevated Browser Controls'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: '97d70d240279be100ffb6d1dfdb1526d011279ce'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-session-roles.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-product-transport.md'
---

<frozen-after-approval reason="user authorized the recommended autonomous FTE-074 sequence">

## Intent

**Problem:** Retrospective and strategy controls still infer elevated authority by decoding unsigned Cognito access-token claims in the browser. The server-owned capabilities endpoint exists, but these screens do not use it and their asynchronous checks can outlive a route or active session.

**Approach:** Make the strict, account-fenced owned capabilities response the browser's only elevated precheck, both when showing controls and immediately before each mutation. Keep Cognito as an opaque temporary POST bearer so the existing Gateway authorizers and mutation transport remain unchanged.

## Boundaries & Constraints

**Always:** Default controls to read-only; pass an `AbortSignal` through every capability check; reset authority before rechecking; key screen checks to the active owned session; repeat the capability check immediately before each elevated POST; handle capability absence, malformed responses, request failure, abort, account replacement, and missing legacy bearer without sending a mutation. Preserve existing mutation concurrency bodies and response handling.

**Ask First:** Any change outside the web package and this spec, any cache for capabilities, or any change to the elevated HTTP request/authorization contract.

**Never:** Decode JWT payloads or Cognito groups/scopes in browser code; trust UI visibility as mutation authorization; attach `fte1` to an elevated mutation; remove the legacy token provider; detach or modify Gateway authorizers; change runtime configuration; infer a role from account identity; or fall back to Cognito claims when owned capabilities fail.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Elevated owned account | Exact owned capability and usable opaque legacy bearer | Controls render; mutation rechecks capability, then sends the unchanged Cognito-authorized POST | Existing conflict/request handling remains |
| Ordinary owned account | Empty or different capability list | Controls stay read-only and direct mutation calls fail before reading the legacy provider | No POST is sent |
| Capability uncertainty | Missing method, invalid response, network failure, abort, or account switch | Controls stay/reset read-only | Rejections are handled; no stale state or unhandled promise |
| Session replacement | Account or token changes while the detail screen remains mounted | Prior authority is cleared and a new abortable check runs | A late result cannot re-enable controls |
| Legacy bearer unavailable | Owned capability exists but provider/token is absent or invalid | Mutation fails closed | No POST is sent |

</frozen-after-approval>

## Code Map

- `apps/web/src/api.ts` -- elevated client interfaces, strict owned capability loader, legacy bearer access, and retrospective/strategy mutation prechecks.
- `apps/web/src/App.tsx` -- UI-facing abortable elevated-capability interface.
- `apps/web/src/experiments.tsx` -- strategy-control capability lifecycle.
- `apps/web/src/retrospectives.tsx` -- retrospective-control capability lifecycle.
- `apps/web/src/api.test.ts` -- client authority, opaque-bearer, denial, and mutation recheck contracts.
- `apps/web/src/App.test.tsx` -- rendered controls, fail-closed state, cancellation, and session replacement behavior.

## Tasks & Acceptance

**Execution:**

- [x] `apps/web/src/api.ts` -- replace Cognito claim decoders with an opaque bounded legacy bearer accessor; centralize owned capability resolution; make both `can...` methods abortable; capability-gate every elevated mutation before retrieving or sending the legacy bearer.
- [x] `apps/web/src/App.tsx` -- keep the UI client contract aligned with abortable capability checks.
- [x] `apps/web/src/experiments.tsx` and `apps/web/src/retrospectives.tsx` -- bind capability checks to the current owned session, reset before checking, abort on replacement/unmount, and handle both fulfillment and rejection without stale writes.
- [x] `apps/web/src/api.test.ts` -- prove exact capability selection, denial/error/abort behavior, opaque legacy bearer use, and a fresh capability check before each mutation for both elevated domains.
- [x] `apps/web/src/App.test.tsx` -- prove controls remain read-only on uncertainty, become available only for owned capability, and cannot be re-enabled by a stale result after session replacement or unmount.

**Acceptance Criteria:**

- Given any browser session, when elevated controls or mutations are evaluated, then no Cognito token payload, group, or scope is decoded and owned capabilities are the sole browser authority signal.
- Given an owned capability and a usable legacy bearer, when an elevated action is confirmed, then the existing Cognito-authorized POST shape is preserved and the server remains final authority.
- Given capability denial, uncertainty, cancellation, or session replacement, when a check settles, then controls remain read-only and no elevated POST occurs.
- Given the capability endpoint has already been read for UI state, when a mutation begins, then authority is fetched and fenced again rather than trusted from rendered state or cache.

## Spec Change Log

- 2026-08-14, review iteration 1: fenced the terminal owned session before
  elevated POSTs, made legacy bearer lookup abortable and syntax-bounded,
  canceled pending mutations on session replacement/unmount, clarified
  uncertainty copy, and expanded symmetric browser regressions.

## Design Notes

This is deliberately dual-gated during migration: the owned role must pass the browser precheck, and the unchanged Cognito Gateway authorizer must still accept the opaque mutation bearer. A role or account can change after any client precheck; that final race closes only when the server mutation authority changes, so this slice does not pretend browser state is authoritative.

## Verification

**Commands:**

- `pnpm --filter @find-the-edge/web test` -- expected: the complete web suite passes.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: abortable client and session-aware UI contracts compile.
- `pnpm --filter @find-the-edge/web lint` -- expected: changed web files satisfy lint rules.
- `pnpm exec prettier --check apps/web/src _bmad-output/implementation-artifacts/spec-fte-074-capability-aware-elevated-ui.md` -- expected: formatting passes.
- `git diff --check` -- expected: no whitespace errors and no out-of-scope API, infrastructure, script, or runtime-config changes.

**Verified:** 10 web test files / 397 tests pass, including symmetric elevated-domain authority, post-capability session fences, invalid legacy bearers, session replacement, and unmount aborts. Web typecheck, lint, Prettier, and diff-check pass. Browser source contains no Cognito elevated group decoder.

## Review Trail

- Blind Hunter findings accepted and repaired: invalid opaque bearer acceptance, ambiguous uncertainty copy, incomplete provider/order coverage, and missing lifecycle regressions.
- Edge Case Hunter findings accepted and repaired: exact post-capability owned-session fencing and pending mutation cancellation on session replacement or unmount.
- Same-account token refresh during the capability GET remains accepted because capabilities are account/version-bound; the terminal refreshed token is captured and must remain exact until POST.
- Rendered authority is reset behaviorally by client-and-session-key fencing, so stale state is never usable while a new check is pending.

## Suggested Review Order

**Authority boundary**

- Start with strict owned capability resolution and the final exact-session fence.
  [`api.ts:3746`](../../apps/web/src/api.ts#L3746)

- Confirm legacy Cognito credentials are opaque, bounded, abortable, and syntax-checked.
  [`api.ts:3235`](../../apps/web/src/api.ts#L3235)

- Strategy mutations require owned authority before the unchanged legacy POST.
  [`api.ts:4366`](../../apps/web/src/api.ts#L4366)

- Retrospective mutations use the same dual-gated transition boundary.
  [`api.ts:4957`](../../apps/web/src/api.ts#L4957)

**Session-aware controls**

- Strategy controls mask stale authority and abort checks or mutations on replacement.
  [`experiments.tsx:93`](../../apps/web/src/experiments.tsx#L93)

- Retrospective controls apply the same fail-closed lifecycle discipline.
  [`retrospectives.tsx:113`](../../apps/web/src/retrospectives.tsx#L113)

**Regression evidence**

- Symmetric client tests pin capability order, denial, abort, bearer, and session races.
  [`api.test.ts:982`](../../apps/web/src/api.test.ts#L982)

- Screen tests pin pending state, refresh, rejection, and unmount cleanup.
  [`App.test.tsx:654`](../../apps/web/src/App.test.tsx#L654)
