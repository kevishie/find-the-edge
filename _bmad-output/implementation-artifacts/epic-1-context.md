# Epic 1 Context: Discover FIND THE EDGE

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver the complete public acquisition surface for FIND THE EDGE: a fast, accessible landing page that explains the evidence-first sports intelligence product, builds trust without promotional betting language, and gives visitors a clear path toward phone-based account access and a future paid subscription. The supplied HTML is a visual reference, not production runtime code.

## Stories

- Story 1.1: Publish the Public Landing Experience
- Story 1.2: Explain the Evidence-First Value
- Story 1.3: Guide Visitors to Account and Pricing

## Requirements & Constraints

- The root route is public and must never require authentication or expose protected subscriber data.
- Adapt `templates/Find The Edge - Landing Page.html` into maintained React components; do not import prototype scripts or treat demo calculations as authoritative.
- Explain the value proposition, workflow, product evidence, preview, risk posture, pricing path, and FAQ in a restrained, trustworthy voice.
- Calls to action must support account creation/sign-in and pricing. They should use a configured phone-auth destination when available and show an honest unavailable state when it is not.
- Pricing, currency, billing cadence, inclusions, renewal, and cancellation content must be configurable. Do not invent unresolved production pricing.
- Provide accessible Terms, Privacy, and responsible-gaming destinations; unapproved legal text must be identified before launch.
- Avoid guaranteed-win, no-risk, must-play, certainty, casino, or picks-selling framing. PASS and no-edge decisions are valid product outcomes.
- Meet WCAG 2.1 AA patterns: semantic landmarks and headings, keyboard access, visible focus, status not conveyed by color alone, reduced-motion support, and practical mobile touch targets.
- Optimize public metadata and assets for a fast discoverable page while keeping secrets and protected data out of the bundle.

## Technical Decisions

- The application remains React and Vite. Build the landing experience inside the existing web application and follow its current routing/runtime conventions.
- Authoritative betting calculations stay outside React components. Landing examples are explanatory presentation only.
- Preserve the supplied template as a reference artifact; production components and styles become the maintained source.
- Use existing project packages and conventions before adding dependencies.

## UX & Interaction Patterns

- Visual character: premium sports intelligence terminal; dark, analytical, controlled, evidence before persuasion.
- Core palette: near-black backgrounds, charcoal panels, purple brand/actions, green reserved for verified positive EV or positive process outcomes, amber for warning/incomplete state, red for errors/risk.
- Typography direction: Anton for display, Space Grotesk for UI/body, IBM Plex Mono for numeric metadata, with performant fallbacks where necessary.
- Responsive model: polished desktop composition, adapted tablet layout, and full-width mobile content without compressing dense terminal UI into unreadable tables.
- Motion should be short and restrained and must respect `prefers-reduced-motion`.

## Cross-Story Dependencies

- Story 1.1 establishes the public route, component structure, responsive shell, and visual foundation used by Stories 1.2 and 1.3.
- Story 1.2 builds the evidence-first narrative on that foundation.
- Story 1.3 adds configured acquisition, pricing, and legal paths. It remains usable before Epic 2 by rendering an honest account-access availability state.
