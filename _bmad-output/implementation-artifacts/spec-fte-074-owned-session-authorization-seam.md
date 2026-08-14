---
title: 'FTE-074 Owned Session Authorization Seam'
type: 'feature'
created: '2026-08-13'
status: 'done'
review_loop_iteration: 2
baseline_commit: '129b3a3d1901605532c9fcb7598e20ff2ff9c3bd'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** API handlers for event listing, scouting, reports, watchlists, retrospective review, and strategy promotion still receive identity and permissions only from Cognito gateway claims. The owned `fte1` session can protect billing and entitlement paths but cannot yet supply the trusted handler context needed for the final Cognito cutover.

**Approach:** Add one server-side owned-session authorization seam that validates the bearer token, checks the current account revocation fence, and projects only ordinary product permissions. Integrate it beside the existing gateway context: owned-session candidates fail closed, while non-owned requests retain current gateway behavior. Elevated reviewer/promoter access stays default-deny.

## Boundaries & Constraints

**Always:** Treat the bearer token as untrusted until its `fte1` signature, expiry, canonical payload, account existence, and stored `tokenVersion` all pass. Use the stored account ID as the handler subject. Derive ordinary read/scouting permissions server-side and force reviewer/promoter booleans false for owned sessions. Propagate repository/storage failures rather than guessing. Keep logs and errors free of tokens and account identifiers.

**Ask First:** Any design that grants elevated permissions to an owned session, changes entitlement enforcement, changes API Gateway route authorization, or mutates deployed identity resources.

**Never:** Delete or detach Cognito; enable production product-access enforcement; trust browser scopes, roles, account IDs, or entitlement claims; accept a revoked, expired, malformed, foreign, or missing-account token; weaken existing Cognito behavior; add an identity migration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Valid owned session | Canonical live `fte1` bearer; matching stored account/version | Trusted account subject plus ordinary event/scouting permissions; elevated permissions false | N/A |
| Invalid owned session | Malformed, tampered, expired, unknown-key, missing-account, or stale-version `fte1` token | No authorization context; never fall back to gateway claims | Handler remains unauthorized; no token detail exposed |
| Storage failure | Valid token; account lookup fails | No authorization guess | Failure propagates to the existing safe server error path |
| Legacy gateway request | Valid existing gateway claims | Existing subject/scopes/groups remain authoritative | No deployment behavior change |

</frozen-after-approval>

## Code Map

- `packages/domain/src/identity.ts` -- authoritative `fte1` validation and session payload contract.
- `packages/database/src/identity-repository.ts` -- consistent account lookup and `tokenVersion` revocation authority.
- `apps/api/src/authorization-context.ts` -- new pure authorization-context projection boundary.
- `apps/api/src/lambda.ts` -- request adapter that currently maps Cognito claims directly into handlers.
- `apps/api/src/authorization-context.test.ts` -- focused owned-session and legacy-context security matrix.

## Tasks & Acceptance

**Execution:**

- [x] `apps/api/src/authorization-context.ts` -- parse bounded bearer input, validate owned sessions against current account state, project ordinary permissions, and keep elevated permissions false.
- [x] `apps/api/src/lambda.ts` -- resolve authorization through the owned seam for `fte1` candidates and fail closed when invalid; preserve existing gateway context only for non-owned requests, without changing infrastructure or enforcement.
- [x] `apps/api/src/authorization-context.test.ts` -- cover valid, malformed, tampered, expired, foreign-key, missing-account, revoked-version, storage-failure, server-derived permission, and legacy-context behavior.

### Review Findings

- [x] [Review][Patch] Keep owned-session dependency failures inside the API's safe JSON 500 boundary [`apps/api/src/lambda.ts`:345]
- [x] [Review][Patch] Use one case-insensitive bearer grammar in classification, verification, and entitlement enforcement [`apps/api/src/authorization-context.ts`:80]
- [x] [Review][Patch] Reuse the request-scoped account lookup across authorization and entitlement enforcement [`apps/api/src/lambda.ts`:184]
- [x] [Review][Patch] Sanitize propagated account-storage errors before the safe boundary logs them [`apps/api/src/authorization-context.ts`:116]
- [x] [Review][Patch] Keep a failing diagnostic sink from escaping the safe Lambda boundary [`apps/api/src/lambda-boundary.ts`:25]
- [x] [Review][Defer] Cold-start configuration validation still precedes the request boundary [`apps/api/src/lambda.ts`:89] — deferred, pre-existing

**Acceptance Criteria:**

- Given a valid owned session and matching account record, when the request adapter builds handler input, then the handler receives the stored account ID and only ordinary product permissions.
- Given any invalid or revoked owned session, when authorization resolves, then no trusted owned identity or privilege reaches a handler.
- Given an owned session, when elevated authorization is inspected, then retrospective review and strategy promotion remain denied.
- Given a current Cognito-authorized request, when this slice is deployed, then its existing subject, scopes, and group-derived permissions are unchanged.
- Given the synthesized stack and runtime configuration, when verification runs, then no Cognito resource, authorizer, scope, output, or production enforcement setting changed in this slice.

## Spec Change Log

## Design Notes

The seam returns the handler's existing authorization shape deliberately. That keeps this slice reviewable and lets the later infrastructure cutover remove the legacy gateway source without combining resource deletion, entitlement rollout, and handler refactoring in one irreversible deployment.

## Verification

**Commands:**

- `pnpm --filter @find-the-edge/api test -- authorization-context` -- expected: focused authorization security matrix passes.
- `pnpm --filter @find-the-edge/api typecheck` -- expected: handler adapter and context types compile strictly.
- `pnpm --filter @find-the-edge/api lint` -- expected: changed API files satisfy lint rules.
- `pnpm --filter @find-the-edge/infra-cdk test` -- expected: existing Cognito infrastructure contract remains unchanged.
- `git diff --check` -- expected: no whitespace errors.
