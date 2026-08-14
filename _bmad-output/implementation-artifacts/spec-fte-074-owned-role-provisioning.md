---
title: 'FTE-074 Owned Role Provisioning'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: '97d70d2d22780aeab3d19e1347eec04f83e15b7a'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-session-roles.md'
---

<frozen-after-approval reason="user authorized the recommended autonomous FTE-074 sequence">

## Intent

**Problem:** Server-owned roles are readable but there is no bounded operator path to provision them. A direct table edit would lack stage binding, concurrency protection, optimistic fencing, immutable audit, and verified readback.

**Approach:** Add a protected GitHub-dispatched operator command that resolves the retained stage table, strongly reads one account, and atomically replaces its authorization record with an immutable audit row under a dedicated least-privilege OIDC role.

## Boundaries & Constraints

**Always:** Bind `main` to staging and `production` to prod; verify repository, ref, workflow, run, AWS account, region, stack, and table before mutation. Accept only an exact account id, one of four closed desired role sets, an expected current timestamp or `absent`, and explicit apply confirmation. Derive the non-PII operator id from GitHub actor id. Strongly read the exact account/current/audit keys. Fence the account, current authorization version, and immutable audit insert in one transaction. Revoke by storing empty roles. Preserve all identity, authorization, authorization-audit, OTP, entitlement, and Stripe-customer records during feed reset.

**Never:** Add an API or browser role-write surface; accept a phone number, token, table name, arbitrary role JSON, caller-supplied next/audit timestamp, or operator id; read identity secrets; Scan, Query, use a GSI, delete authorization, overwrite an audit, expose raw AWS errors, reuse one environment's account id in another, or change API/web/CDK route behavior. The expected current `updatedAt` remains an allowed optimistic-lock input.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Dry run | Valid target/account and desired set | Exact strong reads and a bounded plan; no write command | Invalid or corrupt state fails with a fixed safe code |
| First apply | Existing account, expected `absent` | Current record and immutable audit commit together | Concurrent creator loses the condition; no partial write |
| Update/revoke | Exact prior `updatedAt` | Canonical next roles, monotonic timestamp, linked audit | Stale marker or noncanonical current row fails closed |
| Same desired set | Current roles already match | Explicit no-op; current and audit remain untouched | N/A |
| Readback mismatch | Transaction reports success but exact rows differ | Operation fails and reports a sanitized verification code | No raw item or SDK error is printed |

</frozen-after-approval>

## Code Map

- `scripts/identity-authorization-provision.mjs` -- validation, target discovery, transaction construction, orchestration, and sanitized reporting.
- `.github/workflows/provision-identity-authorization.yml` -- protected manual operator entry point and branch/environment binding.
- `infra/github-actions-deploy-role.yml` -- isolated staging and production operator roles.
- `scripts/phase1-reset-feed.mjs` -- preserved shared-table identity and billing key families.
- `scripts/deployment-workflow.test.mjs` -- static workflow and OIDC guardrails.
- `docs/runbooks/identity-authorization.md` -- staging-first operation, verification, rollback, and prerequisites.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/identity-authorization-provision.mjs` and test -- implement strict dry-run/apply orchestration, exact target binding, conditional transaction, audit, readback, and sanitized failures.
- [x] `.github/workflows/provision-identity-authorization.yml`, `package.json`, and deployment workflow tests -- expose only the protected branch-bound manual path with shared deployment concurrency.
- [x] `infra/github-actions-deploy-role.yml` -- add dedicated environment roles limited to target discovery and exact account-partition reads/transactions.
- [x] `scripts/phase1-reset-feed.mjs` and tests -- preserve strict identity, role, audit, OTP, entitlement, and Stripe pointer keys without weakening unknown-key refusal.
- [x] `docs/runbooks/identity-authorization.md` and environment documentation -- record bootstrap, dry-run/apply, browser capability verification, rollback, and stage-specific account ids.

**Acceptance Criteria:**
- Given a valid protected-branch dispatch, when dry-run executes, then no Dynamo mutation command is issued and the exact current state is reported safely.
- Given an exact expected state, when apply executes, then account fence, current authorization replacement, and immutable audit creation commit atomically and both written rows pass strong exact-key readback.
- Given a stale expectation, malformed storage, wrong environment, or unrecognized input, when the command runs, then it fails closed without a Scan, Query, secret read, partial write, token, phone number, or raw AWS failure in output.
- Given a feed reset manifest containing owned identity and billing rows, when classified, then only exact known key families are preserved and malformed near-matches remain unexpected.

## Spec Change Log

- 2026-08-14, review iteration 1: corrected transaction-member IAM actions,
  constrained them to `TransactWriteItems`, added a final protected-branch
  freshness check, bound STS to the exact stage operator role, and fenced the
  complete normalized account and authorization maps before replacement.

## Design Notes

The desired role input represents complete state: `none`, `retrospective-reviewer`, `strategy-promoter`, or `both`. Apply derives `operator:github-<actorId>` and a unique change id from run id/attempt. The audit captures before/after roles, prior/new timestamps, operator, run identity, and checked-out SHA; it contains no phone, token, or secret. Production uses an independently obtained production account id and is attempted only after staging storage readback and owned-session capability verification.

## Verification

**Commands:**
- `node --test scripts/identity-authorization-provision.test.mjs scripts/phase1-reset-feed.test.mjs scripts/deployment-workflow.test.mjs` -- all operator, reset, workflow, and IAM safety cases pass.
- `pnpm prettier --check <changed files>` -- formatting passes.
- `pnpm lint` -- repository lint passes.
- `git diff --check` -- no whitespace errors.

**Verified:** 33 focused provisioning/workflow/reset tests pass. AWS
CloudFormation accepts the operator-role template and reports the expected
named-IAM capability. Blind re-review is clean and Edge Case Hunter reports no
remaining findings.

## Review Trail

- Blind and edge review found that DynamoDB transaction members require
  `ConditionCheckItem` and `PutItem`, not a blanket transaction action. The
  repaired roles allow those actions only when enclosed by
  `TransactWriteItems` and only for `ACCOUNT#*` keys in the exact stage table.
- A second branch-head comparison now runs immediately before provisioning,
  closing the checkout/test/credential setup race.
- STS caller validation now rejects the broad deploy role and a cross-stage
  operator role.
- Transaction conditions compare the complete normalized account and current
  authorization maps, so concurrent changes or malformed additions cannot be
  silently overwritten.
- Falsy corrupt authorization values fail closed and readback compares
  normalized fields semantically, independent of DynamoDB map order.

## Suggested Review Order

- Start with input, branch, workflow, and exact STS role binding in
  `scripts/identity-authorization-provision.mjs`.
- Inspect the three-member transaction and complete-map conditions in the same
  file, followed by exact-key strong readback.
- Verify the protected workflow's two branch-freshness checks and shared stage
  concurrency in `.github/workflows/provision-identity-authorization.yml`.
- Confirm the dedicated IAM roles permit only discovery, exact reads, and
  transaction-enclosed condition/write actions in
  `infra/github-actions-deploy-role.yml`.
- Finish with reset preservation and the focused test suites.
