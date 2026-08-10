---
title: 'Story 1.3: Guide Visitors to Account and Pricing'
type: 'feature'
created: '2026-08-09'
status: 'in-review'
baseline_commit: 'b7d2b37b4d0326aa29dabccca65b49924a200c59'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The public landing page currently ends with a generic “coming soon” access state and has no durable pricing presentation or legal destinations, so visitors cannot understand how gated access will work.

**Approach:** Translate the approved landing-page template pixel-for-pixel, publish its approved $99 monthly / $999 annual seven-day-trial offer, wire account CTAs to a configured phone-auth route when available, and publish substantive U.S. Terms of Use and Privacy Policy routes tailored to the product.

## Boundaries & Constraints

**Always:** Treat the approved HTML template as the desktop visual and commercial-copy source of truth; preserve the $99 monthly / $999 annual seven-day-trial presentation until a human changes it; keep auth availability configurable; keep production legal terms public, readable, and consistent with the product; preserve the existing landing and terminal route boundary.

**Ask First:** Changing the approved price, trial promise, refund position, arbitration terms, governing law, or privacy practices; adding a dependency; implementing OTP, Stripe Checkout, or subscription entitlement.

**Never:** Invent commercial terms beyond the approved template; imply checkout is already active; expose secrets or protected data; move product APIs behind a client-only gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Public offer | No auth URL configured | Approved $99 monthly / $999 annual offer and seven-day trial render exactly as the template; CTAs scroll to pricing | No checkout-active claim |
| Configured auth | Safe internal auth path configured | Primary CTA navigates to phone entry | Unsafe/external path is rejected to unavailable state |
| Public legal visit | `/terms` or `/privacy` | Accessible production legal page renders outside terminal chrome | Terms match the disclosed product and data practices |

</frozen-after-approval>

## Code Map

- `apps/web/src/landing-config.ts` -- safe internal phone-auth path validation; commercial copy remains fixed to the approved template.
- `apps/web/src/landing-page.tsx` -- pricing/access presentation, CTA state, and legal navigation.
- `apps/web/src/public-legal.tsx` -- substantive public U.S. Terms of Use and Privacy Policy pages.
- `apps/web/src/App.tsx` -- public legal route registration and root-layout public-route selection.
- `apps/web/src/styles.css` -- pricing cards, unavailable CTA, and legal-page layouts.
- `apps/web/src/App.test.tsx` -- prelaunch honesty, legal routes, route isolation, and safe CTA tests.

## Tasks & Acceptance

**Execution:**
- [x] Add typed prelaunch-safe landing configuration and validation.
- [x] Replace generic access copy with configurable pricing/access presentation and non-broken CTA states.
- [x] Add public production Terms and Privacy routes outside terminal chrome.
- [x] Add responsive/accessibility styles and regression tests.

**Acceptance Criteria:**
- Given the approved commercial template, when the landing page renders, then it shows $99 monthly, $999 annual, and a seven-day trial without claiming checkout is already active.
- Given a 1280×900 viewport, when the React landing page is compared with the approved HTML template, then the header, hero, scanner, section headings, and total document height have matching measured geometry.
- Given a safe configured phone-auth path, when the access CTA renders, then it links internally to that path; unsafe or absent paths produce an honest unavailable state.
- Given `/terms` or `/privacy`, when an unauthenticated visitor loads it, then a semantic production legal page renders without terminal navigation and includes an effective date and owner contact channel.
- Given any existing product route, when it loads, then terminal shell behavior remains unchanged.

## Spec Change Log

- 2026-08-09: Human approved the template as the pixel-perfect and commercial-copy source of truth, superseding the earlier unpriced prelaunch default.
- 2026-08-09: Human requested production U.S. legal terms and privacy disclosures and approved x.com/kevishie as the public contact channel, superseding the draft legal placeholders.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test -- --run` -- expected: all web tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: no TypeScript errors.
- `pnpm --filter @find-the-edge/web build` -- expected: production bundle succeeds.
