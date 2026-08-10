---
title: 'Fix Public Legal Direct Navigation'
type: 'bugfix'
created: '2026-08-10'
status: 'done'
baseline_commit: 'ccdeb7fb20a2ca33b2cb369c23655ccb82cdcb17'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-public-access-pricing-legal.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-mvp-001e-aws-native-auth-and-static-hosting-launch-layer.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The landing-page Privacy Policy and Terms links navigate to React routes that work after the app shell has loaded, but a direct request to either staging URL returns S3 `AccessDenied` XML. Public legal pages must remain reachable on first load, refresh, and copied links.

**Approach:** Extend the existing exact CloudFront viewer-request SPA route allowlist to include the two public legal routes, preserve asset-miss behavior, and cover the synthesized and preflight contracts with regression tests.

## Boundaries & Constraints

**Always:** Rewrite exact `/privacy` and `/terms` requests to `/index.html` before S3; keep the private S3 origin, OAC, TLS, cache, and security-header controls unchanged; keep route ownership in the React app; validate the exact deployed navigation contract before launch.

**Ask First:** Replacing the exact route allowlist with a global extensionless fallback; changing CDN caching or security policies; changing legal copy or URLs.

**Never:** Add duplicate static legal documents, make the S3 bucket public, use CloudFront custom-error fallback, or rewrite asset/file requests to HTML.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Direct privacy visit | `GET /privacy` at the CDN | Viewer request becomes `/index.html`; React renders Privacy Policy | No S3 XML response |
| Direct terms visit | `GET /terms` at the CDN | Viewer request becomes `/index.html`; React renders Terms of Use | No S3 XML response |
| Missing asset | `GET /assets/missing.hash.js` | URI is unchanged and the origin reports the miss | Never serve app HTML as JavaScript |
| Unknown dotted path | `GET /any.dotted/path` | URI is unchanged | Never mask missing objects with app HTML |

</frozen-after-approval>

## Code Map

- `infra/cdk/src/foundation.ts` -- defines the exact CloudFront Function SPA navigation allowlist.
- `infra/cdk/src/foundation.test.ts` -- asserts synthesized navigation code and legal-route coverage.
- `scripts/phase1-support.mjs` -- validates the synthesized CloudFront Function before deployment.
- `scripts/phase1-support.test.mjs` -- executes the validated function against route and asset examples.

## Tasks & Acceptance

**Execution:**
- [x] `infra/cdk/src/foundation.ts` and `scripts/phase1-support.mjs` -- add exact `/privacy` and `/terms` rewrites to the shared deployment contract.
- [x] `infra/cdk/src/foundation.test.ts` and `scripts/phase1-support.test.mjs` -- prove both legal routes rewrite and asset/file requests do not.
- [x] Run focused infrastructure and deployment-contract tests, then the repository check.

**Acceptance Criteria:**
- Given a fresh browser or page refresh, when a visitor requests `https://staging.kevishie.com/privacy` or `/terms`, then CloudFront serves the app shell and the matching legal page renders instead of S3 `AccessDenied` XML.
- Given a request for an asset or dotted unknown path, when the CloudFront Function runs, then it preserves the request URI and does not return `index.html`.
- Given a synthesized deployment template without either legal route, when preflight validation runs, then it fails closed.

## Spec Change Log

## Design Notes

The hosting layer intentionally uses an exact SPA route allowlist instead of a global fallback so a missing immutable asset cannot be cached as HTML. The legal routes belong in that allowlist alongside existing public and authenticated client routes.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/infra-cdk test` -- expected: synthesized CloudFront contract passes.
- `node --test scripts/phase1-support.test.mjs` -- expected: route rewrite and fail-closed mutations pass.
- `pnpm check` -- expected: all repository gates pass.

**Manual checks:**
- After staging deploy, direct-load and refresh `/privacy` and `/terms`; both return HTML and render the intended legal page.

## Suggested Review Order

**CDN navigation contract**

- Exact legal-route rewrites preserve strict handling for missing assets.
  [`foundation.ts:469`](../../infra/cdk/src/foundation.ts#L469)

- Preflight requires the deployed function to match the safe route contract.
  [`phase1-support.mjs:293`](../../scripts/phase1-support.mjs#L293)

**Regression proof**

- Executable cases prove legal rewrites, asset preservation, and fail-closed validation.
  [`phase1-support.test.mjs:823`](../../scripts/phase1-support.test.mjs#L823)

- Synthesized infrastructure must contain the same exact function code.
  [`foundation.test.ts:486`](../../infra/cdk/src/foundation.test.ts#L486)
