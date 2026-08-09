---
title: 'Story 1.1: Publish the Public Landing Experience'
type: 'feature'
created: '2026-08-09'
status: 'in-review'
baseline_commit: '790a90da22f70726e17ed45d95524a6d0e77496b'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The root route currently redirects visitors into the terminal, so FIND THE EDGE has no public acquisition surface and the supplied landing-page design exists only as a prototype artifact.

**Approach:** Replace the root redirect with a production React landing page that captures the supplied design's hero, product-preview, provider, feature, workflow, pricing-preview, FAQ, closing-callout, and responsible-gaming structure while remaining independent from authenticated product routes.

## Boundaries & Constraints

**Always:** Keep `/` public; preserve all existing terminal routes and behavior; use semantic landmarks/headings, keyboard-visible links, responsive layouts, practical touch targets, and reduced-motion handling; describe examples as illustrative; keep green reserved for positive evidence; use restrained, non-promotional language; retain the template unchanged as reference.

**Ask First:** Adding a dependency, changing existing product-route URLs, or publishing final subscription/legal terms.

**Never:** Import the prototype runtime; expose protected/provider data; calculate authoritative odds in the landing component; claim guaranteed results, live sport coverage, finalized pricing, or an active free trial; implement OTP or Stripe in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Public visit | `/` | Complete landing page renders without terminal chrome or authentication | No provider/API dependency is required |
| Existing product route | `/events`, `/splits`, or another registered route | Existing terminal shell and screen render unchanged | Existing route error boundaries remain active |
| Narrow/reduced-motion client | Mobile viewport or reduced-motion preference | Content reflows without clipping and decorative motion is disabled | Navigation and calls to action remain keyboard reachable |

</frozen-after-approval>

## Code Map

- `apps/web/src/landing-page.tsx` -- New static public route component and illustrative preview data.
- `apps/web/src/App.tsx` -- Root-route registration and conditional terminal shell ownership.
- `apps/web/src/styles.css` -- Landing-specific tokenized responsive styling and accessibility states.
- `apps/web/src/App.test.tsx` -- Route isolation, public content, disclaimer, and existing terminal-route regression coverage.
- `apps/web/index.html` -- Public metadata for the acquisition surface.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/landing-page.tsx` -- implement semantic, data-independent landing sections based on the supplied reference -- make the visual artifact maintainable React rather than prototype runtime.
- [x] `apps/web/src/App.tsx` -- make `/` render the landing component outside terminal chrome while leaving registered product routes intact -- establish the public/product surface boundary.
- [x] `apps/web/src/styles.css` -- add scoped desktop, tablet, mobile, focus-visible, and reduced-motion landing styles -- meet the visual and accessibility contract without disturbing terminal selectors.
- [x] `apps/web/index.html` -- refine title and description -- describe the public evidence-first product accurately.
- [x] `apps/web/src/App.test.tsx` -- cover root rendering, no terminal shell, illustrative-data labeling, disclaimer, and `/splits` shell regression -- protect the route boundary and core claims.

**Acceptance Criteria:**
- Given an unauthenticated visitor, when `/` loads, then a complete FIND THE EDGE landing experience renders without authentication, terminal navigation, API calls, or runtime configuration.
- Given the supplied prototype, when production code is inspected, then its visual/content structure is represented through maintained React and scoped CSS without importing prototype scripts or authoritative demo calculations.
- Given desktop, tablet, mobile, keyboard, or reduced-motion use, when the page is navigated, then semantic structure, focus states, responsive content, and motion behavior remain usable.
- Given an existing direct product-route visitor, when `/events`, `/splits`, or another registered route loads, then the current terminal shell and route behavior remain available.
- Given landing copy and illustrative market rows, when displayed, then they are labeled as illustrative and include 21+, informational-only, no-wager, no-guarantee, and 1-800-GAMBLER context.

## Spec Change Log

## Design Notes

Keep the landing DOM under a `.landing-page` root and prefix component classes with `landing-` so broad legacy terminal selectors do not leak. The public route should not mount `AppShell`; a small root-layout component can choose the landing outlet or terminal shell from the current pathname.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test -- --run` -- expected: landing and existing web tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: no TypeScript errors.
- `pnpm --filter @find-the-edge/web build` -- expected: production bundle succeeds.
