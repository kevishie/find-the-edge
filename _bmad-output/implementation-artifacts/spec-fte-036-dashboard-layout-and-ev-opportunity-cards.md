---
title: 'FTE-036: Dashboard Layout and +EV Opportunity Cards'
type: 'feature'
created: '2026-08-07'
status: 'in-review'
baseline_revision: '4f522c875892766eb3deec5012ab2303f81ac7ab'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-6-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-035-ranked-opportunity-api-and-explanation.md'
warnings:
  - oversized
---

<intent-contract>

## Intent

**Problem:** The ranking engine and public opportunity API are complete, but the product still lands on a fixture-only calculator and provides no fast, trustworthy answer to “Where is the edge right now?”

**Approach:** Make the root route a responsive live Dashboard that preserves the server’s ranking, explains each opportunity with auditable price/probability/quality evidence, and presents honest loading, empty, partial, expiring, and unavailable states.

## Boundaries & Constraints

**Always:** Keep opportunity reads public, matching FTE-035 and the user-approved removal of authentication. Treat the API as authoritative for qualification, ordering, EV, confidence, data quality, and freshness; React only validates and formats returned values. Use the configurable target sportsbook and local approved labels/logos rather than hardcoding Hard Rock. Preserve server order and show `evaluationState`, continuation, exclusions, snapshot time, and expiry honestly. Never call a loaded subset an exact global total. Use Eastern kickoff from the DTO, text plus color for status, semantic headings/lists/definitions/times, keyboard-visible focus, reduced-motion loading, and a usable compact mobile navigation. Poll/revalidate often enough that an expired card cannot remain presented as active. Keep “Open Event” canonical and “Add Bet” disabled with a visible reason until Bet Tracker exists.

**Block If:** The FTE-035 response cannot provide a required explanatory field, the existing Event Detail route cannot accept the returned event identity, or a new business calculation/qualification rule would be required.

**Never:** Re-rank or recompute authoritative EV/fair probability/confidence in React; fabricate provider health, quota, exposure, CLV, watchlist, report, or line-movement summaries; log opportunity payloads or sensitive provider data; restore Cognito; add bet placement; use stale cards after `expiresAt`; imply positive EV guarantees profit; or ship prototype-only Design routes/runtime.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Ranked dashboard | Complete nonempty page | Server-ordered cards show event, market/selection, target and best comparison prices, consensus, probabilities, EV, confidence/components, books, freshness, warnings, and actions | No error expected |
| No edge | Complete page with zero items | Positive restrained “No qualified edge” state explains that thresholds were not met | Never manufacture a recommendation |
| Partial evidence | Partial page, unknown continuation, filtered/stale/join counts, or cursor | Verified cards remain visible with an explicit incomplete/lower-bound notice | Do not claim a complete total |
| Expiry | Card reaches `expiresAt` while open | Revalidate and remove it from active presentation | Never style expired evidence as current |
| Unavailable | Missing client, network/503, malformed response | Safe error panel retains sport choice and offers retry | No provider internals or raw payloads |
| Sparse card | Null best comparison or point; warnings empty/present | Explicit unavailable comparison, clean point omission, textual warning badges | No zero/substitute values |

</intent-contract>

## Code Map

- `apps/web/src/api.ts` -- public ranked-opportunity transport, strict page validation, and safe errors.
- `apps/web/src/dashboard.tsx` -- query ownership, KPI/placeholder/state layout, ranked cards, expiry revalidation, and mobile-safe interactions.
- `apps/web/src/App.tsx` -- root route, client injection, Dashboard navigation, and compact product navigation.
- `apps/web/src/styles.css` -- scoped premium terminal layout, cards, confidence/freshness states, focus, responsive behavior, and reduced motion.
- `apps/web/src/api.test.ts` -- public transport and hostile-response contract regressions.
- `apps/web/src/App.test.tsx` -- dashboard/card state and navigation component coverage.
- `tests/e2e/app-shell.spec.ts` -- local desktop/mobile Dashboard smoke without deploying.
- `apps/web/package.json`, `pnpm-lock.yaml` -- TanStack Query dependency required by Epic 6 architecture.

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/package.json`, `pnpm-lock.yaml`, and `apps/web/src/App.tsx` -- install/provide TanStack Query with test-safe retries, make `/` the Dashboard, retain public access, and provide compact navigation to implemented product routes.
- [x] `apps/web/src/api.ts` and `apps/web/src/api.test.ts` -- add `listOpportunities` with exact page/DTO validation, public request behavior, safe 503/network/malformed handling, stable identity/order checks, and complete partial/cursor metadata.
- [x] `apps/web/src/dashboard.tsx` -- render server-ranked opportunities and all required evidence; resolve participant/market/book labels without calculations; expose truthful lower-bound KPIs, unavailable future-module tiles, retry/no-edge/partial states, expiry-aware polling, canonical Event Detail links, and disabled Add Bet.
- [x] `apps/web/src/styles.css` -- implement dense desktop/tablet scanning, one-column mobile cards and product navigation, 44px mobile actions, no viewport overflow, accessible focus/status contrast, and reduced-motion skeletons.
- [x] `apps/web/src/App.test.tsx` -- cover loading, complete, empty, error/retry, partial, sparse, warning, confidence/quality, expiry, API order, sport isolation, disabled action, and Event Detail navigation states.
- [x] `tests/e2e/app-shell.spec.ts` -- mock the public API and prove Dashboard render/order, key evidence, actions, mobile navigation, and zero document overflow in both configured Playwright projects.
- [x] Full local verification -- run focused web tests, Playwright Dashboard smoke, repository checks, and diff hygiene without deploying.

**Acceptance Criteria:**
- Given a validated nonempty opportunity page, when Dashboard renders, then cards remain in API order and visibly distinguish target implied probability, consensus/fair probability, EV, confidence, data quality, book coverage, freshness, and warnings.
- Given complete empty, loading, retryable failure, partial/unknown, sparse comparison, or expiring evidence, when state changes, then the Dashboard communicates the exact limitation and never shows fabricated or stale betting evidence.
- Given any supported viewport and keyboard navigation, when the user scans or opens an opportunity, then product navigation remains usable, the card has an accessible matchup-specific Event Detail link, Add Bet is disabled with a reason, and the page has no document-level horizontal overflow.
- Given the public FTE-035 contract, when Dashboard requests opportunities, then it sends no credentials, validates the full response boundary, preserves configurable sportsbook identity, and performs no authoritative betting calculation client-side.

## Spec Change Log

- 2026-08-07: Implemented the public ranked Dashboard, strict transport validation, responsive evidence cards, expiry-aware refresh, and desktop/mobile regression coverage.

## Review Triage Log

### 2026-08-07 — Blind Hunter and Edge Case Hunter

- **Reviewed:** the complete FTE-036 working-tree diff using two fresh, independent review agents.
- **Patched (16):** corrected baseline metadata; made expiry scheduling resilient to delayed responses and failed refreshes; separated expired evidence from a true no-edge result; corrected exact/lower-bound/continuation counts; rejected invalid American odds, impossible expiry windows, contradictory comparison books, future evidence, and Eastern-day mismatches; restored compact links to every implemented module; stopped background polling; normalized sport labels; removed duplicate screen-reader book announcements; and bounded stalled requests.
- **Deferred:** 0.
- **Rejected:** 0.
- **Classification:** 8 high, 5 medium, and 3 low implementation findings; no intent gaps or specification defects.
- **Follow-up review:** recommended because the review produced substantial boundary-validation and evidence-lifecycle hardening.

## Design Notes

The FTE-035 page has no global total. The “Active +EV shown” KPI is a lower bound: render `N` only for a complete terminal page and `N+` when continuation or unknown evaluation remains. “Open Exposure,” “Recent CLV,” provider health/quota, watched events, and reports must say unavailable/not connected rather than `0`. The first ranked item may supply “Highest EV” because the API order is authoritative.

The root route becomes Dashboard to match the documented landing flow and avoid a new CloudFront SPA rewrite. The old Edge Lab remains source-only during this story rather than adding a prototype route to product navigation.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- focused transport/component cases pass.
- `pnpm exec playwright test tests/e2e/app-shell.spec.ts` -- Dashboard works locally at desktop and mobile widths.
- `pnpm check` -- repository lint, typecheck, tests, and build pass.
- `git diff --check` -- no whitespace errors.

## Dev Agent Record

### Completion Notes

- Replaced the root fixture calculator route with the live public Dashboard while retaining Edge Lab source for later disposition.
- Added strict fail-closed parsing for ranked pages and preserved the API's authoritative ordering and calculations.
- Added accessible responsive cards, lower-bound/empty/error/partial states, explicit unavailable future modules, exact expiry removal, and safe canonical actions.
- Verified focused web tests, both Playwright viewports, and the full repository check without deploying.

### File List

- `_bmad-output/implementation-artifacts/spec-fte-036-dashboard-layout-and-ev-opportunity-cards.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/web/package.json`
- `apps/web/src/App.test.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/api.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/styles.css`
- `pnpm-lock.yaml`
- `tests/e2e/app-shell.spec.ts`

## Auto Run Result

- **Summary:** Delivered a public, server-ranked decision dashboard with dense opportunity cards, trustworthy evidence states, responsive navigation, strict API validation, and expiry-safe refresh behavior.
- **Review outcome:** 16 findings patched; 0 deferred; 0 rejected. Follow-up review is recommended.
- **Verification:** 140 focused web tests, two local Playwright viewport checks, the complete repository `pnpm check`, and diff hygiene all pass without deploying.
- **Residual risk:** live usefulness still depends on provider health and quota visibility (FTE-037), and the page intentionally reports a lower bound whenever the server indicates additional ranked results or unknown evaluation coverage.
