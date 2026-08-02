---
title: 'FTE-MVP-001D Phase1 Deployment and Environment Smoke'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'fcf38c2'
final_revision: 'c38c4ec'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The fixture seed, authenticated games API, runtime bootstrap, and UI are implemented, but operators lack one validated deployment bundle/workflow and a smoke command that proves a configured environment without hiding missing outputs, JWT/CORS errors, or seed failures.

**Approach:** Add Phase1 preflight/bundle/operator scripts and documentation that build the static web artifact with B2 runtime config, validate the dev CDK template/outputs, invoke the dev fixture seed, and smoke the authenticated API plus browser. Make all repository checks credential-free; permit real AWS/environment actions only when the operator explicitly supplies account/region/endpoints/token.

## Boundaries & Constraints

**Always:** Provide a deterministic preflight command validating Node/pnpm, clean required inputs, dev stage, JWT issuer/audience, cursor-secret ARN shape, web origin, fixture seed enabled, and no secret/token output. Produce a static hosting directory from the production web build plus B2-generated `runtime-config.js`; validate preload order, HTTPS API base (localhost only explicit local mode), no embedded token/fallback, and manifest/checksums. Validate synthesized dev template contains JWT `GET /games`, exact CORS origin, API endpoint output, enabled fixture-seed function output, table-scoped required IAM, and no Scan/public unauthenticated route. Operator commands are explicit and noninteractive: synth/preflight, optional CDK deploy, resolve outputs, invoke seed, authenticated API checks for MLB/MLS fixture days, serve/upload static bundle, browser smoke. Environment smoke accepts token only from a process environment/async injected provider, never arguments/files/logs; applies bounded timeout/redacted failures; verifies unchanged canonical IDs, odds, CORS, 401 without token, 403/denial for wrong scope where observable, and browser sport/day/empty flow. Missing credentials/account/outputs/token skips or fails with a clear preflight result; never silently deploys.

**Block If:** Actual AWS deployment/smoke is requested without explicit account, region, authenticated credentials, JWT issuer/audience, cursor secret, web origin, and a valid scoped access token/provider.

**Never:** Deploy or mutate AWS automatically during tests; create cloud credentials/secrets; store/log token; weaken JWT/CORS; add live providers/schedules/recovery/betting; change application behavior; use route interception or fixture ID rewriting in browser smoke; assume hosting vendor.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Local preflight | Explicit safe dev placeholders | Template/bundle/manifest validated | Credential-free pass |
| Missing/unsafe config | Prod stage, HTTP prod API, wildcard CORS, missing output | No bundle/deploy/smoke | Redacted actionable failure |
| Seed/API smoke | Explicit environment+token | Seed converges; MLB/MLS games+odds validate | Bounded fail closed |
| Auth/CORS | Missing token or wrong origin/scope | Protected behavior observed | No secret leak |
| Browser smoke | Hosted bundle + configured provider | Sport/day/empty flow works | No interception/rewrite |

</intent-contract>

## Code Map

- `scripts/phase1-preflight.mjs` -- config, synth-template, security/output validation.
- `scripts/build-phase1-web.mjs` -- production build/runtime artifact/manifest/checksum bundle.
- `scripts/phase1-environment-smoke.mjs` -- optional explicit seed/API/CORS/auth smoke with redaction/timeouts.
- `tests/e2e/phase1-environment.spec.ts` or dedicated Playwright config -- optional real configured browser smoke, skipped without explicit environment.
- `docs/phase1-deployment.md` -- exact build/deploy/output/seed/API/static-host/browser/rollback commands and prerequisites.
- package scripts/tests -- credential-free local validation and optional environment commands.

## Tasks & Acceptance

**Execution:**
- [x] preflight/bundle -- implement tested config/template/security validation and deterministic static hosting artifact+manifest using B2 generator.
- [x] environment smoke -- implement explicit opt-in seed/API/auth/CORS/browser checks with token redaction, timeouts, and no interception.
- [x] operator docs/scripts -- document exact CDK deploy/output/seed/static-host/smoke/rollback commands and credential prerequisites.

**Acceptance Criteria:**
- Given credential-free local placeholders, when Phase1 preflight/build runs, then synth and hosting bundle validate route/JWT/CORS/IAM/outputs/runtime config/checksums without AWS mutation.
- Given explicit valid environment credentials/config/token, when smoke runs, then seed, MLB/MLS API odds, auth/CORS, and browser filters are proven end-to-end without rewriting/interception.
- Given missing or unsafe configuration, when any deploy/smoke command starts, then it fails before mutation and reveals no token/secret.
- Given full gates, then docs and scripts are reproducible and no application/live-provider behavior changes.

## Spec Change Log

## Review Triage Log

- 2026-08-01 loop 0: patch 14 (critical 2, high 6, medium 5, low 1). The structural gate now requires the exact intended route set and proves every route targets the same API-bound Lambda integration through exact CloudFormation reference shapes. The API endpoint output must be the exact API endpoint plus `/dev`; adversarial mutations cover missing/extra routes, missing/wrong targets, wrong API/Lambda/attribute integration bindings, and output prefix/suffix/order changes.

- 2026-08-01 loop 0: patch 12 (critical 2, high 5, medium 4, low 1). Final structural-gate patches require exact CORS methods/headers/origin; require every intended API route to use the exact scoped JWT authorizer; reject public/default routes and DynamoDB Scan; and positively bind exact allow-only API and fixture-seed DynamoDB action sets to their own roles and the exact event table ARN. Adversarial tests cover wrong/missing route scopes and authorizers, deny-only permissions, missing actions, and extra actions.

## Verification

**Commands:**
- `pnpm phase1:preflight` -- credential-free synth/template security validation passes.
- `pnpm phase1:bundle` -- deterministic hosting bundle/runtime manifest validates.
- `pnpm phase1:smoke` -- skips clearly without explicit environment or validates configured environment.
- `pnpm check` -- workspace gates pass.
