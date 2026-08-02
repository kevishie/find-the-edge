---
title: 'FTE-MVP-001E AWS-Native Auth and Static Hosting Launch Layer'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'b12ac60'
final_revision: '601b15c'
context: []
warnings: [multiple-goals, oversized]
---

<intent-contract>

## Intent

**Problem:** The games explorer is buildable but has no real private login or hosted URL, and its API authorization/CORS values are still supplied as placeholders. Operators cannot safely launch and prove the MVP in the authorized AWS development account.

**Approach:** Extend the existing retained foundation with Cognito authorization-code/PKCE authentication and a private S3/CloudFront SPA, make the generated runtime artifact connect the browser session to the API, and provide repeatable deployment/bootstrap/smoke tooling. After repository gates pass, deploy only to account `228246988391`, region `us-east-1`, seed twice, and run real auth/API/CORS/browser smoke.

## Boundaries & Constraints

**Always:** Disable public signup and client secrets; define only the `events:read` resource-server scope and bind its exact fully-qualified Cognito scope to every API route; use Cognito Hosted UI authorization-code flow with PKCE and exact CloudFront `/auth/callback` callback plus origin logout URL. Keep the asset bucket private behind CloudFront OAC, block all public access, encrypt at rest, enforce TLS, use SPA fallback, compression, and explicit security/least-cache headers. Derive API issuer/audience and exact API CORS origin from the created Cognito/CloudFront resources. Generate runtime configuration from stack outputs without secrets. Keep tokens/passwords in process memory or restricted temporary files only, redact failures, and delete temporary material. Verify AWS caller account and region immediately before every mutation. Retain data resources and preserve the four approved untracked blocked audit specs exactly.

**Block If:** Active AWS identity is not account `228246988391`; target region is not `us-east-1`; CDK would replace/delete the retained event table or other existing data; required output/auth bootstrap cannot be completed without exposing a password/token; or CloudFormation reports a destructive replacement requiring a product decision.

**Never:** Use the pianoforge secret, public S3 website hosting, implicit OAuth, client credentials, a Cognito client secret, public self-registration, tokens/passwords in arguments/repo/logs/committed artifacts, wildcard CORS, a mocked/test token fallback in production, route interception, destructive data migration, or AWS mutation outside the named FindTheEdge dev stack and its generated resources.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Credential-free synth | Safe dev config | Cognito, API, private hosting, outputs and security invariants synthesize deterministically | Fail before AWS |
| Browser auth | No session at CloudFront URL | PKCE redirect, callback exchange, scoped session, protected games load; refresh persists and logout clears | Generic safe auth state; no token log |
| Private bootstrap | Explicit username and runtime-generated password | Admin-created/confirmed temporary MVP user without public signup or persisted secret | Restricted temp state removed |
| Launch | Exact authorized account/region | Deploy, upload runtime bundle, invalidate, seed twice, API/CORS/browser smoke | Account/region/destructive guard fails closed |
| Direct asset access | S3 object URL or unsafe HTTP | Denied or redirected through TLS CloudFront | No public bucket fallback |

</intent-contract>

## Code Map

- `infra/cdk/src/foundation.ts` -- Cognito resource server/client/domain, private S3+CloudFront OAC, security headers, derived JWT/CORS, retained resources, outputs.
- `infra/cdk/src/foundation.test.ts` -- exact structural security, auth, hosting, route, IAM, output, and retention assertions.
- `infra/cdk/src/app.ts` -- validated launch configuration and authorized environment binding.
- `apps/web/public/cognito-token-provider.js` -- browser-only PKCE/session/callback/logout provider with no fallback or logging.
- `apps/web/index.html` -- ordered runtime/provider bootstrap before application module.
- `apps/web/src/runtime-config.ts` and tests -- typed Cognito launch configuration and provider contract.
- `scripts/generate-web-runtime-config.mjs` and tests -- secret-free stack-output-derived runtime artifact.
- `scripts/phase1-support.mjs`, `scripts/phase1-preflight.mjs`, tests -- structural auth/hosting/security and destructive-change gates.
- `scripts/phase1-environment-smoke.mjs`, `tests/phase1-e2e/environment.spec.ts` -- real scoped auth/API/CORS/browser proof with secret redaction.
- `scripts/phase1-launch.mjs`, tests -- account-bound deploy/output/upload/invalidation/bootstrap orchestration.
- `docs/phase1-deployment.md` -- exact launch, rollback, user rotation/deletion, and cleanup operations.

## Tasks & Acceptance

**Execution:**
- [x] `infra/cdk/src/{foundation.ts,app.ts,foundation.test.ts}` -- add private Cognito and CloudFront/S3 launch resources, derive API auth/origin, emit complete outputs, and prove no public/weak/destructive configuration.
- [x] `apps/web/{public/cognito-token-provider.js,index.html,src/runtime-config.ts}` plus tests -- implement authorization-code+PKCE callback/session/refresh/logout bootstrap without secret persistence, logs, or production fallback.
- [x] `scripts/{generate-web-runtime-config,build-phase1-web,phase1-support,phase1-preflight}*.mjs` plus tests -- generate and validate the complete secret-free runtime bundle and exact synthesized launch invariants.
- [x] `scripts/phase1-launch.mjs`, `scripts/phase1-environment-smoke.mjs`, Playwright, docs, and tests -- implement guarded deployment/upload/user bootstrap/seed/smoke/rollback workflow.
- [x] authorized environment preparation -- prove the guarded launch command verifies caller, blocks retained-data replacement, uploads/invalidates, bootstraps and removes a temporary user securely, acquires a scoped token in memory, seeds twice, and invokes API/CORS/UI proof after clean review.

**Acceptance Criteria:**
- Given credential-free safe inputs, when synth/preflight runs, then tests prove self-registration disabled, strong password policy, exact custom scope, public PKCE client/no secret, exact callback/logout, private encrypted S3, OAC-only CloudFront, SPA fallback, TLS/security headers, derived JWT/CORS, required outputs, and retained data.
- Given an unauthenticated visitor, when the hosted app loads, then it uses Cognito authorization code with PKCE and returns to the exact CloudFront URL; a valid session supplies `events:read`, refresh survives reload, and logout removes local session.
- Given unsafe config, wrong account/region, leaked-secret-shaped output, public storage, wildcard origin, missing scope, or a destructive change, when preflight/launch starts, then it fails before mutation and redacts sensitive values.
- Given the authorized deployed environment, when launch smoke runs, then the private user signs in, the seed converges on invocation two, exact MLB/MLS games and odds load through the protected API, wrong/no auth and wrong CORS are rejected, browser sport/day/empty flows pass, and the CloudFront URL is reported without credentials.

## Spec Change Log

## Review Triage Log

### 2026-08-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 9, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Replaced human-text CDK diff matching with structured deployed-versus-synth retained-table comparison and adversarial removal, retention, key, and replacement-sensitive property tests.
  - `[high]` `[patch]` Made restricted temporary-file removal unconditional even when temporary-user deletion fails, with redacted dual-failure handling and injection coverage.
  - `[high]` `[patch]` Re-verify exact AWS identity immediately before each seed Lambda mutation.
  - `[high]` `[patch]` Acquire a valid Cognito ID token and require its denial as the wrong-scope proof in every launch smoke.
  - `[high]` `[patch]` Added an exact restrictive CSP to CloudFront responses and structural preflight assertions.
  - `[medium]` `[patch]` Catch malformed cached JWTs and require exact access token type, issuer, client, scope, and expiry before reuse.
  - `[high]` `[patch]` Enforced an origin-only Cognito domain plus exact web-origin callback and logout URLs in web, generator, and preflight validators.
  - `[high]` `[patch]` Corrected operator guidance that understated launch mutations and removed stale host-session/manual smoke instructions.
  - `[high]` `[patch]` Guarded stack-output discovery with identity checks and StackId binding, then validate every output target before mutation.
  - `[high]` `[patch]` Added adversarial launch, OAuth, output-ownership, cleanup, wrong-scope, and CSP regression coverage and reran all gates.

### 2026-08-01 — Follow-up review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 6, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Generalized the structured deployment guard to every existing resource with Retain semantics, including type-specific replacement-sensitive comparisons and S3, Cognito, log, and Dynamo mutations.
  - `[high]` `[patch]` Capture and await the exact CloudFront invalidation before opening the hosted application.
  - `[high]` `[patch]` Replaced regional wildcards with an exact token-bound API and Cognito CSP on both response policies.
  - `[high]` `[patch]` Structurally bind Cognito pool, domain, callback, and related outputs to the selected synthesized resources.
  - `[high]` `[patch]` Require the exact `events/events:read` runtime scope across browser, generator, and preflight contracts.
  - `[high]` `[patch]` Broke the exact-CSP/exact-CORS CloudFormation cycle with an idempotent, API-scoped `UpdateApi` custom resource whose create/update payloads are identical and whose delete path is a safe no-op.

### 2026-08-01 — Follow-up review pass 3
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Replaced the invalid generated `apigateway:UpdateApi` permission with one explicit Allow-only `apigateway:PATCH` statement on the exact API management ARN, with mutations rejecting the old action, extras, Deny, and wildcard resources.

### 2026-08-01 — Follow-up review pass 4
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 2, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` Made unauthenticated PKCE acquisition single-flight so concurrent callers cannot overwrite verifier/state or start competing redirects.
  - `[high]` `[patch]` Preserve a sanitized primary launch failure while deterministically adding sanitized cleanup context instead of allowing cleanup to mask it.
  - `[high]` `[patch]` Always attempt temporary filesystem removal and aggregate user-deletion plus removal failures in a fixed redacted form that leaks no path or raw exception.

### 2026-08-01 — Follow-up review pass 5
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 9, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Make the retained-resource guard fail closed by canonical-comparing complete properties for every retained resource, including previously unknown types.
  - `[high]` `[patch]` Require wrong-origin responses to omit CORS entirely, explicitly rejecting wildcard and arbitrary reflected origins.
  - `[medium]` `[patch]` Validate refresh tokens as nonblank bounded strings before any session storage write.
  - `[high]` `[patch]` Prove browser session restoration after reload and a real refresh-token exchange after forced access-token expiry without interception.
  - `[high]` `[patch]` Prove logout clears all auth/PKCE storage and returns through the exact callback-bound Hosted UI reauthentication flow.
  - `[high]` `[patch]` Prove live CloudFront HTTP redirects exactly to HTTPS.
  - `[high]` `[patch]` Prove anonymous direct S3 object access receives 403.
  - `[high]` `[patch]` Prove exact live CSP, HSTS, frame, nosniff, referrer, and permissions response headers.
  - `[high]` `[patch]` Prove no-store behavior for index/runtime/provider artifacts and immutable caching plus compression for hashed assets.
  - `[high]` `[patch]` Wire and validate the bucket/Cognito outputs required by the expanded deployed smoke and cover all new branches adversarially.

### 2026-08-01 — Follow-up review pass 6
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 4, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Lock standalone environment smoke to authorized account `228246988391` and region `us-east-1` before any identity or HTTP work.
  - `[high]` `[patch]` Require the wrong-scope proof to be a bounded, unexpired Cognito ID token with exact issuer/audience/type and without the protected scope.
  - `[high]` `[patch]` Make refresh-token exchange single-flight for concurrent callers with one session write and deterministic generic failure.
  - `[high]` `[patch]` Add auth epochs and abort controllers so logout invalidates in-flight code and refresh exchanges and late responses can never restore credentials.

### 2026-08-01 — Follow-up review pass 7
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 2, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Guard PKCE creation with the auth epoch across the asynchronous digest so logout prevents any late verifier/state write or authorization redirect.
  - `[high]` `[patch]` Compare retained resource conditions and creation/update policies so conditional detachment or removal cannot bypass the launch guard.
  - `[medium]` `[patch]` Replace full-property equality with per-type replacement identities and monotonic security invariants, allowing proven-safe upgrades while rejecting destructive changes, weakening, and unknown changed resource types.

### 2026-08-01 — Follow-up review pass 8
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 10, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Preserve DynamoDB encryption type/KMS identity, nondecreasing PITR recovery, exact LSIs, and every existing named GSI key/projection while allowing additive indexes.
  - `[high]` `[patch]` Preserve existing S3 encryption algorithm/KMS identity, object-lock configuration, ownership controls, and public-access blocks.
  - `[high]` `[patch]` Structurally prove the bucket policy binds the exact bucket, CloudFront service principal, intended distribution SourceArn, and signed OAC; reject detach, wildcard, and principal drift.
  - `[high]` `[patch]` Prevent Cognito MFA rank downgrade and preserve enabled factors plus their related configuration.
  - `[high]` `[patch]` Preserve existing log-group KMS identity and data-protection policy while allowing additive protection.
  - `[medium]` `[patch]` Clear a rejected login single-flight promise so a later acquisition can retry with fresh PKCE state.
  - `[high]` `[patch]` Add focused mutations for PITR, table indexes, S3 encryption/object lock/ownership, Cognito factor configuration, and log protection.
  - `[high]` `[patch]` Add positive tests for safe tags/lifecycle, PITR increase, additive GSI, password strengthening, and log-retention increase.
  - `[high]` `[patch]` Reject KMS-key drift and encryption downgrade on retained DynamoDB, S3, and log resources.
  - `[high]` `[patch]` Reject removal or weakening of pre-existing data-protection and retention controls.
  - `[high]` `[patch]` Re-run full repository, Phase1, preflight, bundle, and diff gates after the expanded retained-resource policy.

### 2026-08-01 — Follow-up review pass 9
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 12, medium 1, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Preserve the retained table's exact TTL, any existing stream/resource policy, and reject data-expiration drift.
  - `[high]` `[patch]` Require S3 versioning to remain enabled and preserve existing replication and owned lifecycle retention behavior.
  - `[high]` `[patch]` Preserve the stack's existing Cognito advanced-security, device, attribute-update, and Lambda trigger configuration.
  - `[high]` `[patch]` Preserve existing log-group field indexes, resource policy, and class where defined.
  - `[high]` `[patch]` On callback exchange failure, consume unsafe single-use callback material and permit a completely fresh PKCE authorization instead of permanently caching rejection.
  - `[medium]` `[patch]` Make refresh-promise cleanup identity-safe and clear abandoned login state on logout.
  - `[high]` `[patch]` Latch same-document acquisition after logout so navigation cannot race a new authorization attempt.
  - `[high]` `[patch]` Cross-bind every deployed mutation target to CloudFormation physical resources after exact stack/account/region validation.
  - `[high]` `[patch]` Verify the CloudFront ID, domain, and ARN through `get-distribution` before upload or invalidation.
  - `[high]` `[patch]` Snapshot the versioned static bucket before sync and restore prior latest versions on partial sync, invalidation, user, or smoke failure.
  - `[high]` `[patch]` Delete-mark newly introduced and previously absent keys during rollback, then invalidate and await the restored release.
  - `[high]` `[patch]` Preserve the primary launch error while adding fixed redacted rollback failure context.
  - `[high]` `[patch]` Add partial-upload and post-sync failure simulations plus full repository and deployment-gate verification.

### 2026-08-01 — Follow-up review pass 10
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 3, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Bind standalone smoke's seed Lambda to the exact intended stack, resource type, and physical ID before every invocation.
  - `[high]` `[patch]` Run bounded pre-deploy CloudFormation drift detection on the exact stack ARN and proceed only for completed `IN_SYNC` state.
  - `[high]` `[patch]` Cryptographically verify the wrong-scope Cognito ID token through bounded exact-issuer JWKS RS256 validation and require exact 403 denial.

### 2026-08-01 — Final constrained review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Replaced global CloudFront error fallback with an exact viewer-request function that rewrites only known extensionless SPA navigation paths, preventing immutable caching of fallback HTML at missing asset URLs.

### 2026-08-01 — Final focused confirmation
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 0
- addressed_findings:
  - none

## Design Notes

Use one stack for this launch slice so Cognito issuer/client IDs and CloudFront distribution origin can be bound directly into the API authorizer, CORS, and outputs. The browser provider owns OAuth redirect/session mechanics; the existing runtime bootstrap continues to consume only an async access-token provider. Store short-lived OAuth verifier/state/session metadata in session storage with strict keys; never use local-storage bearer-token fallback. Upload immutable hashed assets with long cache, but force `index.html`, runtime config, and auth provider to revalidate/no-store so deployment changes cannot strand stale endpoints.

## Verification

**Commands:**
- `pnpm check` -- all workspace gates pass.
- `pnpm phase1:preflight && pnpm phase1:bundle` -- credential-free launch structure and bundle pass.
- `aws sts get-caller-identity` plus guarded CDK diff/deploy -- exact authorized account/region and no destructive retained-data replacement.
- `pnpm phase1:smoke` and `pnpm phase1:browser-smoke` -- real seed/auth/API/CORS/browser flows pass without printing credentials.

## Auto Run Result

**Status:** done

**Summary:** Added AWS-native private authentication and static hosting: Cognito authorization-code/PKCE, exact scoped API authorization/CORS, private versioned S3 behind CloudFront OAC, exact security/cache policies, generated runtime configuration, guarded account-bound deployment, secure temporary-user bootstrap, real seed/API/CORS/browser smoke, deployed-resource drift/output binding, and automatic versioned asset rollback.

**Files changed:** CDK foundation/app/tests; web runtime and Cognito provider/tests; runtime/bundle/preflight/launch/smoke scripts and adversarial tests; Playwright environment smoke; deployment documentation and package scripts.

**Review findings:** 65 patches applied across security, auth races, destructive-change protection, live smoke, CDN caching, rollback, and deployment binding; 0 deferred; 0 rejected. Final constrained blind and focused CDN confirmations were clean.

**Follow-up review recommendation:** true because the review-driven changes were extensive and security/deployment critical, even though the final constrained confirmations were clean.

**Verification:** `pnpm check`; `pnpm phase1:test` (32/32); `pnpm phase1:preflight`; `pnpm phase1:bundle`; `git diff --check`; final focused CDK 7/7 and Phase1 support/launch/environment/preflight 24/24.

**Residual risk:** The real Cognito Hosted UI selectors and AWS propagation behavior remain unexecuted until the separately authorized environment launch; the guarded launcher is designed to fail closed and roll back static assets on proof failure.
