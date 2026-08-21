---
title: 'Add root back chevron to sign-in'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '5cf7c20053d2a08dfa51913e391899a5dc7e26b8'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-design-specification.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The sign-in page has no visible way to return to the public root landing page, leaving visitors dependent on browser navigation. The missing control is especially noticeable because the centered authentication card otherwise occupies an isolated full-screen surface.

**Approach:** Add a standalone left-chevron link in the sign-in page's top-left corner. Give it deliberate edge spacing, a clear interactive target, keyboard focus treatment, and an accessible name; activating it always routes to `/`.

## Boundaries & Constraints

**Always:** Keep the control outside the sign-in card; place it at the viewport's top-left with responsive padding; use the app router for same-origin navigation; expose an accessible link name while keeping the visible treatment icon-only; preserve the current centered form layout and all authentication behavior.

**Ask First:** Any change to the sign-in card content, authentication flow, return URL semantics, or root landing page.

**Never:** Use browser-history back, because `/login` may be opened directly or reached from a protected route; navigate to a return URL; add a third-party icon dependency; display instructional text beside the chevron; alter other public or product routes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Return home | Visitor activates the top-left chevron from `/login`, with or without a `returnUrl` query | Router navigates to `/` | N/A |
| Direct login visit | Visitor opens `/login` without prior in-app history | Chevron remains visible and routes to `/` | Does not depend on browser history |
| Keyboard navigation | Visitor tabs to the control and activates it | Link has a visible focus indicator and navigates to `/` | N/A |
| Narrow viewport | Sign-in renders on a phone-sized screen | Control retains safe edge spacing and does not overlap the card | Responsive inset preserves usable layout |

</frozen-after-approval>

## Code Map

- `apps/web/src/sign-in.tsx` -- Owns the full-screen sign-in surface and will render the router link and inline chevron icon.
- `apps/web/src/App.tsx` -- Owns the `/login` route and supplies the registered router link to the sign-in surface.
- `apps/web/src/styles.css` -- Owns sign-in layout, responsive positioning, interaction states, and focus-visible styling.
- `apps/web/src/sign-in.test.tsx` -- Covers sign-in semantics and routing integration, including the existing assumption that the page has no links.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/sign-in.tsx` -- add an accessible icon-only router-link slot before the sign-in card -- provide deterministic navigation from every sign-in state.
- [x] `apps/web/src/App.tsx` -- supply the `/` router link and inline chevron from the registered `/login` route -- preserve client-side navigation and avoid browser-history behavior.
- [x] `apps/web/src/styles.css` -- position and style the control at the top-left with responsive insets, a comfortable hit target, and hover/focus feedback -- satisfy placement and accessibility without shifting the card.
- [x] `apps/web/src/sign-in.test.tsx` -- add route-level coverage for the home link -- protect its label, destination, and independence from `returnUrl`.

**Acceptance Criteria:**
- Given any sign-in step or configuration state, when the page renders, then an icon-only left chevron named “Back to home” is visible at the viewport's top-left outside the card.
- Given a pointer or keyboard user, when the chevron receives hover or focus, then its interactive state is visually apparent without reducing the usable target below 44 by 44 CSS pixels.
- Given the chevron on `/login?returnUrl=%2Fsplits`, when activated, then the app renders the root landing page rather than `/splits` or a browser-history destination.
- Given desktop and narrow layouts, when the sign-in page renders, then the card remains centered and the chevron keeps appropriate edge spacing without overlap.

## Spec Change Log

## Design Notes

Use an inline SVG chevron with `aria-hidden="true"` inside a router `Link` carrying `aria-label="Back to home"`. Absolute positioning within the full-viewport `.sign-in-page` keeps the control independent from the centered card; use the existing purple/charcoal palette and `:focus-visible` conventions.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test -- --run apps/web/src/sign-in.test.tsx` -- expected: sign-in component and route navigation tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: TypeScript completes without errors, if the package exposes this script.
- `pnpm --filter @find-the-edge/web lint` -- expected: touched React and CSS-adjacent code passes configured linting, if the package exposes this script.

**Manual checks:**
- Inspect `/login` at desktop and phone widths; confirm the chevron is top-left with balanced spacing, does not move the card, and shows hover and keyboard-focus feedback.

## Suggested Review Order

**Navigation entry point**

- The login route supplies one reusable router link during loading and normal rendering.
  [`App.tsx:3272`](../../apps/web/src/App.tsx#L3272)

- The icon-only link has a stable accessible name and deterministic root destination.
  [`App.tsx:3297`](../../apps/web/src/App.tsx#L3297)

**Layout and accessibility**

- The full-width surface anchors the control without disturbing the centered card.
  [`styles.css:6749`](../../apps/web/src/styles.css#L6749)

- Responsive spacing, short-height clearance, and reduced-motion behavior cover constrained viewports.
  [`styles.css:6803`](../../apps/web/src/styles.css#L6803)

- The sign-in screen exposes a layout slot outside its authentication card.
  [`sign-in.tsx:249`](../../apps/web/src/sign-in.tsx#L249)

**Regression coverage**

- Route coverage proves the chevron ignores `returnUrl` and renders the landing page.
  [`sign-in.test.tsx:258`](../../apps/web/src/sign-in.test.tsx#L258)
