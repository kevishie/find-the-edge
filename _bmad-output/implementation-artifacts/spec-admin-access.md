---
title: 'Super-Admin and Manual Subscriber Access'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '5cf7c20053d2a08dfa51913e391899a5dc7e26b8'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-session-roles.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-product-transport.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FIND THE EDGE cannot list accounts or grant complimentary product access independently of Stripe. It also lacks a securely bound owner account that can administer access and use the product without paying.

**Approach:** Add one server-owned `super_admin`, independent manual subscriber grants, a queryable privacy-minimized user directory, composed access evaluation, protected admin APIs/UI, immutable audit evidence, and deploy-safe bootstrap/migration tooling.

## Boundaries & Constraints

**Always:** Bind owner bootstrap to a deployment-configured expected account ID before opening new-environment signup; preserve exactly one super admin; calculate product access as verified `super_admin OR eligible Stripe OR active manual grant`; keep every source independent; derive grant targets from normalized E.164 with the existing account pepper; persist only the last-two phone hint; transact each access mutation with exactly one audit event; paginate without runtime table scans; strongly authorize every admin request; make retries idempotent and stale writes conflict; keep rollout disabled until bootstrap or legacy migration is verified.

**Ask First:** Storing recoverable/full phone numbers, enabling the feature in a deployed stage, performing a production backfill or owner recovery, changing Stripe state, or changing the approved sole-owner policy.

**Never:** Store `subscriber` as an authorization role; put roles/access in browser tokens; let the client select a role; appoint the next arbitrary login as owner; let a failed source negate another verified positive source; delete audit history; expose super-admin assignment/recovery through the product UI; add staff roles, expiring grants, invitation SMS, bulk import, or impersonation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Owner bootstrap | Configured owner verifies before bootstrap closes | Atomically create/claim owner, authorization, directory, and audit; owner bypasses paywall | Other account or legacy ambiguity fails closed; replay is idempotent |
| Grant by phone | Existing or unseen normalized E.164 | Active manual grant; unseen account appears pending and becomes active on verified login | Invalid phone is 400; stale/conflicting mutation is 409 |
| Revoke manual access | Active grant with current version | Revoke only manual source and retain Stripe/super-admin access | Unauthorized is 403; replay returns authoritative state |
| Access-source outage | One verified positive; another unavailable | Grant access from the verified source and report canonical sources | No positive plus unavailable returns `access-unavailable` |
| User directory | Authorized cursor request | 25 default/100 max rows with hint, display reference, lifecycle, timestamps, and sources | Invalid cursor/limit is 400; storage uncertainty fails closed |

</frozen-after-approval>

## Code Map

- `packages/domain/src/admin-access.ts`, `identity-authorization.ts` -- strict admin records, closed role/capabilities, composed-access kernel.
- `packages/database/src/admin-access-repository.ts`, `identity-repository.ts` -- transactional bootstrap/login/grant/revoke/audit and cursor directory projection.
- `apps/api/src/admin-handler.ts`, `identity-handler.ts`, `product-access.ts`, `authorization-context.ts`, `handler.ts`, `lambda.ts`, `identity-secrets.ts` -- authenticated admin contracts, bootstrap reconciliation, and composed access wiring.
- `apps/web/src/admin-users.tsx`, `api.ts`, `App.tsx`, `session.ts`, `styles.css` -- capability-gated route/navigation and accessible directory/grant/revoke UI.
- `infra/cdk/src/foundation.ts`, environment/deployment scripts -- routes, IAM/config, SPA rewrite, owner migration/recovery gates.
- Matching `*.test.ts(x)` and provisioning-script tests -- domain through browser coverage.

## Tasks & Acceptance

**Execution:**
- [x] Add/export strict domain types and canonical access decisions; extend the closed authorization role/capability projection.
- [x] Implement DynamoDB and memory/testing repositories with deterministic keys, conditional transactions, immutable audits, pagination, and login reconciliation.
- [x] Add deploy-safe configured-owner bootstrap plus explicit legacy owner/directory migration and offline recovery tooling.
- [x] Implement strict owned-session admin endpoints and extend protected-product access with independent sources.
- [x] Add capability-gated Admin navigation/route and accessible users, pending-grant, grant, and source-specific revoke states.
- [x] Extend CDK routes/config/IAM/SPA behavior and comprehensive unit, integration, contract, and browser tests.

**Acceptance Criteria:**
- Given concurrent or unauthorized first-account attempts, when bootstrap runs, then only the configured owner can become the single super admin and exactly one audit event exists.
- Given Stripe-only, manual-only, combined, super-admin, revoked, absent, or unavailable sources, when a protected request is evaluated, then the canonical access matrix is enforced without cross-source mutation.
- Given a phone that has never signed in, when the owner grants access and that person later verifies OTP, then one pending logical entry becomes one active account with uninterrupted access.
- Given an ordinary subscriber or direct admin URL/API request, when authorization runs, then admin data and mutations remain inaccessible.
- Given grant/revoke retries, races, audit failure, pagination, malformed storage, or account/session replacement, when operations settle, then state converges or fails closed without leaked PII, duplicate evidence, or stale UI authority.

## Spec Change Log

## Design Notes

Use a separate manual-grant record rather than modifying Stripe entitlement. A directory projection is required because current account rows are neither listable nor phone-recoverable. Existing stages require an explicit operator migration; runtime code must never scan to infer the first account.

## Verification

**Commands:**
- `pnpm format:check && pnpm lint && pnpm boundaries && pnpm typecheck && pnpm typecheck:tools` -- static and package-boundary checks pass.
- `pnpm test && pnpm build` -- all package tests and builds pass.
- `pnpm test:e2e` -- desktop/mobile browser flows, including admin authorization and manual access, pass.
- `git diff --check` -- no whitespace errors.

## Suggested Review Order

**Access model and durable invariants**

- Start with the canonical three-source access decision and privacy-safe record contracts.
  [`admin-access.ts:340`](../../packages/domain/src/admin-access.ts#L340)

- Follow the atomic owner bootstrap, login reconciliation, and strict evidence validation.
  [`admin-access-repository.ts:222`](../../packages/database/src/admin-access-repository.ts#L222)

- Review idempotent, versioned manual grant and revoke transactions.
  [`admin-access-repository.ts:771`](../../packages/database/src/admin-access-repository.ts#L771)

**Server authorization and transport**

- See the strongly authorized admin request contract and canonical response projection.
  [`admin-handler.ts:59`](../../apps/api/src/admin-handler.ts#L59)

- Trace route dispatch, rollout fencing, and source composition wiring.
  [`lambda.ts:164`](../../apps/api/src/lambda.ts#L164)

- Confirm protected-product access tolerates independent-source outages.
  [`product-access.ts:103`](../../apps/api/src/product-access.ts#L103)

**Owner interface**

- Review the capability-gated direct route before the presentation component.
  [`App.tsx:3462`](../../apps/web/src/App.tsx#L3462)

- Inspect pending grants, stable retry keys, pagination, and manual-only revoke behavior.
  [`admin-users.tsx:15`](../../apps/web/src/admin-users.tsx#L15)

**Rollout and recovery**

- Verify disabled-by-default fresh-versus-verified deployment configuration.
  [`environments.ts:46`](../../infra/cdk/src/environments.ts#L46)

- Inspect account-bound, role-preserving, recoverable operator transactions.
  [`admin-access-provision.mjs:95`](../../scripts/admin-access-provision.mjs#L95)

**Regression coverage**

- Finish with Dynamo concurrency, rollback, replay, PII, and recovery tests.
  [`admin-access-repository.test.ts:181`](../../packages/database/src/admin-access-repository.test.ts#L181)

- Confirm browser authorization and the complete grant/revoke flow.
  [`admin-access.spec.ts:36`](../../tests/e2e/admin-access.spec.ts#L36)
