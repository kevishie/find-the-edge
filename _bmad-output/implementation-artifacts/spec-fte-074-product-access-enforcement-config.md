---
title: 'FTE-074 Product Access Enforcement Configuration'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: '4dfd00eb4ad6156a8d84626a7fc875bbdbe06238'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-12-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-product-transport.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-074-owned-session-roles.md'
---

<frozen-after-approval reason="user authorized the recommended autonomous FTE-074 sequence">

## Intent

**Problem:** The API supports `FTE_PRODUCT_ACCESS_ENFORCED`, but the deployment entry point does not carry an environment-owned value into the stack. Every deployment therefore silently synthesizes `false`, and a future cutover could not be reviewed, tested, or independently controlled by stage.

**Approach:** Make the setting an explicit, exact boolean at the CDK boundary and in every protected deployment path. Bind each protected branch case to its own reviewed value, validate before AWS mutation, and keep both staging and production explicitly `false` in this release.

## Boundaries & Constraints

**Always:** Accept only the exact strings `true` and `false`; require a value for staging and production preflight/launch; carry the parsed boolean unchanged through `FoundationConfig` and `FoundationStack`; assert the synthesized Event API value; bind both protected branch cases to explicit reviewed values; document the independent stage mapping and the live verification command.

**Never:** Enable enforcement, permit a protected launch with `true`, detach a Cognito authorizer, change route authorization, change entitlement decisions, infer a default for a protected environment, accept case/whitespace/numeric aliases, reuse one stage's value for another, or claim FTE-074 complete.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Local synth | Variable absent | Synthesize with enforcement disabled | N/A |
| Protected preflight/launch | Exact `false` | Validate and synthesize Event API with `"false"` | N/A |
| Future representation | Exact `true` at the typed CDK boundary | Synthesize Event API with `"true"` in an isolated test | Protected launch refuses it until a later reviewed cutover change |
| Protected value absent | staging or prod | Refuse before AWS mutation | Fixed configuration error |
| Malformed value | Any stage | Refuse rather than coerce | Fixed configuration error |

</frozen-after-approval>

## Code Map

- `infra/cdk/src/environments.ts` -- exact boolean parsing and protected-stage requirement.
- `infra/cdk/src/app.ts` -- deployment environment ingestion.
- `infra/cdk/src/foundation.ts` -- required typed config propagation into the Event API.
- `scripts/phase1-support.mjs` and `scripts/phase1-launch.mjs` -- credential-free and live deployment validation.
- `.github/workflows/ci.yml` and `.github/workflows/deploy-phase1.yml` -- explicit false CI value and reviewed branch-case deployment values.
- `scripts/deployment-workflow.test.mjs` and focused infrastructure/deployment tests -- static and synthesized guardrails.
- `docs/environment-promotion.md` and `docs/phase1-deployment.md` -- stage setup, cutover prohibition, and live verification.

## Tasks & Acceptance

**Execution:**
- [x] Add exact boolean parsing and required typed propagation through CDK.
- [x] Require the setting in protected preflight and launch before any AWS mutation.
- [x] Bind both protected branch cases to reviewed explicit false outputs and keep CI explicitly false.
- [x] Add parser, launch, workflow, and synthesis tests for false, true, absent, and malformed values.
- [x] Document independent stage configuration and the no-cutover boundary.

**Acceptance Criteria:**
- Given staging or production without the setting, when preflight or launch starts, then it fails before AWS access or deployment.
- Given exact `false`, when either protected stage synthesizes, then the Event API receives `FTE_PRODUCT_ACCESS_ENFORCED=false`.
- Given exact `true`, when the typed configuration is synthesized in a test, then the Event API receives `true` without changing any route authorization, while protected launch still refuses the cutover.
- Given a malformed value, when parsed, then it is rejected without trimming or coercion.
- Given this release's reviewed branch mapping, when staging or production deploys, then its own branch case supplies explicit `false` and rechecks it before cloud credentials.

## Design Notes

This is configuration plumbing, not the access cutover. Enabling the value remains blocked on a real owned and entitled staging session, negative 401/402 smoke, ordinary and elevated route migration, and a staging soak. The workflow emits `FTE_PRODUCT_ACCESS_ENFORCED=false` separately from the `main`/staging and `production`/prod branch cases and rechecks it before cloud credentials. No merged GitHub variable or new privileged token participates in the decision.

## Verification

**Commands:**
- `node --test scripts/phase1-support.test.mjs scripts/phase1-launch.test.mjs scripts/deployment-workflow.test.mjs` -- 44/44 focused deployment-control tests pass.
- `pnpm --filter @find-the-edge/infra-cdk test -- src/environments.test.ts src/foundation.test.ts` -- 27/27 infrastructure tests pass.
- `FTE_AWS_STAGE=staging FTE_PRODUCT_ACCESS_ENFORCED=false pnpm phase1:preflight` and the matching prod command -- both credential-free preflights pass.
- `pnpm check` -- full repository formatting, lint, boundaries, typechecks, tests, builds, and 34 desktop/mobile browser flows pass.
- `git diff --check` -- no whitespace errors.

**Review:** Blind Hunter is clean, Edge Case Hunter reports `[]`, and Acceptance Auditor is CLEAN / PASS after the final branch-case and spec-coherence repairs.

## Spec Change Log

- 2026-08-14, review iteration 1: added both-stage CI preflight, pre-credential cutover refusal, exact live API-integration Lambda readback, legacy launch fencing, unique manual verification, and explicit reviewed branch-case outputs. Removed the proposed GitHub variable/API dependency so no fallback or extra token can influence this release.

## Review Trail

- The initial workflow validated only after a secret mutation; validation now runs before checkout, credentials, and all cloud writes.
- Both staging and production CI preflights now synthesize the explicit disabled value.
- Post-deploy verification follows stack output to the unique capabilities route and integration, validates the exact account/region Lambda ARN including any qualifier, and checks the invoked configuration remains false.
- A merged GitHub variable could have fallen back across scopes, while direct Environment API lookup would require a new privileged token. The final design instead emits literal false separately from both protected branch cases and revalidates it in the launcher.
- Runbooks now use valid stage-specific preflight commands and fail closed on ambiguous Event API discovery.

## Suggested Review Order

- Start with exact parsing and protected-stage absence behavior.
- Follow each protected branch-case output through launch/preflight into the synthesized Event API Lambda.
- Confirm tests cover both boolean values and all malformed inputs.
- Finish by verifying both branch cases emit `false`, live staging/prod Lambdas remain `false`, and no route/authorizer diff exists.
