---
title: 'FTE-074 Server-Owned Roles and Capabilities'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 2
baseline_commit: '3f0f3b9f0a9ec52bdc40d2707f8077ad77e92793'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-session-authorization-seam.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-product-transport.md'
---

<frozen-after-approval reason="user authorized the recommended autonomous FTE-074 sequence">

## Intent

**Problem:** Reviewer and strategy-promoter authority still comes exclusively from Cognito groups. The owned `fte1` session has no server-owned elevated-role source, and the handlers compare legacy bare scope strings that do not match the deployed Cognito resource-server scopes.

**Approach:** Add a strict server-owned authorization record in the existing single table, project it only after owned-token/account-version verification, expose a read-only owned-session capabilities endpoint, and normalize elevated handler checks to the deployed fully qualified scopes. This prepares the later authorizer cutover without performing it.

## Boundaries & Constraints

**Always:** Default missing role data to no elevated authority. Strongly read the role record only for the capabilities endpoint and elevated routes. Return capabilities in canonical order with the verified account id. Fail closed and sanitize malformed/storage failures. Keep ordinary owned scopes unchanged.

**Never:** Put roles in `fte1`, infer them in the browser, add a public role-write endpoint, scan the table, grant a default role, detach a Cognito authorizer, enable `FTE_PRODUCT_ACCESS_ENFORCED`, or switch elevated browser mutations to the owned transport in this slice.

## I/O & Edge-Case Matrix

| Scenario | Expected behavior |
| --- | --- |
| Valid owned session, no authorization row | 200 capabilities response with the verified account id and an empty array |
| One or both known roles | Canonical full capabilities are returned and projected into trusted handler booleans/scopes |
| Invalid, expired, revoked, or wrong-version session | 401; role storage is not trusted |
| Malformed authorization row or repository failure | Sanitized 500; no role or key material is exposed |
| Legacy Cognito elevated request | Existing group projection remains; full deployed scope string is required |
| Ordinary product request | No new authorization-row read |

</frozen-after-approval>

## Data and HTTP Contracts

- Dynamo key: `pk=ACCOUNT#<accountId>`, `sk=AUTHORIZATION`.
- Value schema: `identity-authorization-v1` with exact `accountId`, canonical unique `roles`, canonical `updatedAt`, and bounded non-PII `operatorId`.
- Roles: `retrospective-reviewer`, `strategy-promoter`.
- Endpoint: `GET /auth/session/capabilities`, Gateway authorizer `NONE`, owned bearer required, product-entitlement gate excluded, `cache-control: no-store`.
- Response: `owned-session-capabilities-v1` with `accountId` and canonical `capabilities` drawn only from `events/retrospectives:approve` and `events/strategies:promote`.

## Tasks & Acceptance

- [x] Add and export the strict domain record and capability projection.
- [x] Add and export a strongly consistent Dynamo repository with missing-row and malformed-row behavior.
- [x] Extend owned authorization resolution to load elevated roles only where requested and preserve legacy Cognito projection.
- [x] Add the capabilities route and exact 200/401/500/no-store contracts.
- [x] Normalize retrospective and strategy handler scope checks to fully qualified deployed values.
- [x] Add the unauthorizer-free CDK route while pinning all existing Cognito authorizers/scopes.
- [x] Add a strict browser capabilities client fenced to the current owned account; do not change elevated mutation transport.
- [x] Pass domain, database, API, web, and CDK tests/typecheck/lint plus repository-wide validation.
- [x] Complete parallel Blind Hunter, Edge Case Hunter, and Acceptance Auditor review and repair all accepted findings.

## Deployment Gate

This slice may be deployed with product enforcement still false and all Cognito authorizers still attached. It does not authorize owned elevated mutation traffic through API Gateway. Role provisioning and elevated authorizer detachment remain later, separately verified rollout steps.

## Implementation Map

- `packages/domain/src/identity-authorization.ts`: exact authorization record, canonical roles, and role-to-capability projection.
- `packages/database/src/identity-authorization-repository.ts`: strongly consistent account-bound authorization read.
- `apps/api/src/authorization-context.ts`: owned-session verification followed by optional server-owned role projection.
- `apps/api/src/lambda.ts`, `handler.ts`, and `product-access.ts`: capability routing, safe authorization composition, full elevated scopes, and entitlement-gate exclusion.
- `infra/cdk/src/foundation.ts`: unauthorizer-free capability route while legacy elevated routes remain Cognito-protected.
- `apps/web/src/api.ts`: exact account-fenced capability response parser and client.

## Review Trail

- Iteration 1 repaired two accepted findings: stored noncanonical role order now fails closed instead of being repaired into authority, and an in-flight capability response is rejected after an account switch while a valid same-account token refresh remains accepted.
- Iteration 2 repaired the completion fence so a malformed replacement token for the same account is also rejected.
- Final independent results: Blind Hunter `CLEAN`; Edge Case Hunter `[]`; Acceptance Auditor `CLEAN / PASS`.

## Verification

- Repository-wide `pnpm check` passed after the final repairs: formatting, lint, package boundaries, all type checks, all package tests, all builds, and 34/34 Playwright tests across desktop and mobile.
- Focused final web verification passed 10 files / 370 tests plus typecheck and lint.
- The credential-free Phase 1 preflight and its structural route-contract tests pass with the new capability route pinned as unauthorizer-free.

## Suggested Review Order

1. `packages/domain/src/identity-authorization.ts` and its tests.
2. `packages/database/src/identity-authorization-repository.ts` and its tests.
3. `apps/api/src/authorization-context.ts`, `lambda.ts`, `handler.ts`, and capability tests.
4. `infra/cdk/src/foundation.ts` route-preservation assertions.
5. `apps/web/src/api.ts` parser, request authority, and in-flight account fencing tests.
