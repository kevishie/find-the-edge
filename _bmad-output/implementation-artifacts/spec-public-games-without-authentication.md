---
title: 'Public Games and Odds Without Authentication'
type: 'feature'
created: '2026-08-02'
status: 'done'
review_loop_iteration: 0
baseline_commit: '7c7e891d076cc7ffee82770bc3dfd64dabb5b32d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-mvp-001e-aws-native-auth-and-static-hosting-launch-layer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Public visitors are redirected from the deployed games UI to an unbranded Cognito login, preventing them from immediately viewing games and odds.

**Approach:** Make the Phase 1 games read routes anonymously accessible and make the web application call them without acquiring a token. Preserve the private static-hosting controls and all data, validation, pagination, CORS, security-header, and deployment safeguards.

## Boundaries & Constraints

**Always:** A visitor opening the CloudFront URL must reach the games UI directly. `GET /games` and its supported detail routes must work without an Authorization header while retaining strict query validation, bounded DynamoDB access, exact-origin CORS, safe error responses, and read-only IAM. Automated deployment must prove anonymous API and browser access to MLB/MLS games and odds.

**Ask First:** Any destructive cleanup of existing Cognito resources or retained data; making write, seed, operator, or future administrative endpoints public; broadening CORS beyond the deployed web origin.

**Never:** Add a shared token, API key, browser-held secret, fake client-side bypass, wildcard CORS, public S3 bucket, or unauthenticated mutation path. Do not weaken odds validation, cursor binding, rate/bounds behavior, logging redaction, HTTPS, CSP, or hosting security.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| First visit | Anonymous browser opens hosted origin | Games UI loads directly with no Cognito redirect | UI shows existing safe API error state if data service fails |
| Public read | Valid sport/day query without Authorization | API returns chronological games and current odds | Existing bounded validation and redacted server errors remain |
| Invalid query | Unsupported sport/day/limit/cursor | API returns the established 400 response | No auth challenge or internal detail leakage |
| Cross-origin read | Request from an unapproved origin | No permissive CORS response | Browser cannot read the response |

</frozen-after-approval>

## Code Map

- `infra/cdk/src/foundation.ts` -- currently attaches Cognito JWT authorization and scopes to public read routes and emits hosting/API resources.
- `apps/api/src/lambda.ts` -- currently rejects requests lacking JWT claims before routing reads.
- `apps/web/src/runtime-config.ts` and `apps/web/src/api.ts` -- currently resolve a browser token provider and attach a bearer token to every request.
- `apps/web/index.html` and `apps/web/public/cognito-token-provider.js` -- currently bootstrap the Cognito redirect/session flow before the application.
- `scripts/phase1-{support,launch,environment-smoke}.mjs` -- currently validate and exercise authenticated deployment behavior.
- `tests/phase1-e2e/environment.spec.ts` -- currently proves login, refresh, and logout rather than direct anonymous entry.

## Tasks & Acceptance

**Execution:**
- [x] `infra/cdk/src/foundation.ts`, `apps/api/src/lambda.ts`, and tests -- remove JWT enforcement from read-only games routes while preserving all non-auth API invariants.
- [x] `apps/web/src/{runtime-config.ts,api.ts}`, `apps/web/index.html`, public assets, and tests -- remove token acquisition/header injection so initial render goes directly to games.
- [x] `scripts/phase1-*.mjs`, deployment docs, and tests -- replace authentication prerequisites and smoke assertions with anonymous-read guarantees; keep existing Cognito resources dormant to avoid destructive cleanup in this change.
- [x] `tests/e2e/*.ts` -- prove direct hosted entry, filters/days, odds, API failures, invalid queries, and cross-origin denial without credentials.

**Acceptance Criteria:**
- Given a new browser with no session, when the deployed CloudFront URL is opened, then games and odds display without leaving the site or showing a login.
- Given the automated release pipeline, when quality gates pass, then deployment and live smoke prove anonymous MLB/MLS reads and the production UI.
- Given existing retained infrastructure, when the stack updates, then no table, bucket, log group, or Cognito resource is destructively replaced or deleted.

## Spec Change Log

## Design Notes

Cognito resources remain provisioned but unused for this focused release. That prevents an authentication-policy change from becoming an irreversible identity-resource deletion; cleanup can be handled separately after confirming no private flows depend on the pool.

## Verification

**Commands:**
- `pnpm check` -- expected: format, lint, boundaries, types, unit tests, and builds pass.
- `pnpm test:e2e` -- expected: local desktop/mobile anonymous games flow passes.
- `pnpm phase1:preflight` -- expected: synthesized stack validates public read routes plus existing hosting/data safeguards.
- GitHub quality and deploy workflows -- expected: live anonymous API/browser smoke passes and reports the CloudFront URL.

## Suggested Review Order

**Public API boundary**

- Public games and details bypass JWT while the internal event feed stays scoped.
  [`foundation.ts:416`](../../../infra/cdk/src/foundation.ts#L416)

- Lambda routes public game requests without discarding internal-route identity claims.
  [`lambda.ts:50`](../../../apps/api/src/lambda.ts#L50)

**Anonymous browser flow**

- Games load directly from the configured API without token acquisition or headers.
  [`api.ts:282`](../../../apps/web/src/api.ts#L282)

- Runtime configuration accepts the minimal anonymous deployment shape.
  [`runtime-config.ts:96`](../../../apps/web/src/runtime-config.ts#L96)

**Deployment safeguards**

- Public endpoints retain bounded stage throttling and exact-origin CORS.
  [`foundation.ts:445`](../../../infra/cdk/src/foundation.ts#L445)

- Live smoke proves anonymous MLB/MLS games, odds, and hostile-origin denial.
  [`phase1-environment-smoke.mjs:396`](../../../scripts/phase1-environment-smoke.mjs#L396)

**Browser proof**

- Hosted tests verify direct entry, reloads, and absence of Cognito session state.
  [`environment.spec.ts:61`](../../../tests/phase1-e2e/environment.spec.ts#L61)
