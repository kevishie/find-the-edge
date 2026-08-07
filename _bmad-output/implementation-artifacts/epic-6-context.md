# Epic 6 Context: +EV Opportunity Lifecycle and Dashboard

<!-- Generated from the Product Brief, PRD, Architecture, UX specification, and Epics and Stories planning artifacts. -->

## Goal

Turn current market prices and deterministic betting calculations into an auditable lifecycle of candidate, qualified, active, stale, suspended, disqualified, and closed opportunities, then present only safe, current opportunities in a dashboard that answers “Where is the edge right now?” The experience must make the calculation, confidence, freshness, warnings, and provider limitations understandable and must support “no qualified edge” as a valid outcome.

Although the original epic is soccer- and Hard Rock-focused, the binding multi-sport rebaseline governs implementation: opportunity processing and shared UI are sport-agnostic, `sportKey`-aware, and driven by versioned sport modules and strategies. The target sportsbook is configurable rather than a domain constant.

## Stories

- **FTE-033 — Candidate Opportunity Creation and Qualification Rules:** Create a candidate from current prices, evaluate all qualification gates, and retain qualified/disqualified status, reason codes, calculation version, and input snapshot references.
- **FTE-034 — Opportunity Lifecycle States and Expiration:** Move opportunities through explicit lifecycle states, automatically remove stale, suspended, or closed opportunities from active visibility, and preserve the transition audit trail.
- **FTE-035 — Ranked Opportunity API and Explanation:** Expose authenticated, filterable active opportunities in ranked order with the price, probability, EV, confidence, contributing-book, warning, freshness, and timestamp fields needed to explain each result.
- **FTE-036 — Dashboard Layout and +EV Opportunity Cards:** Build the protected dashboard around KPI summaries and ranked opportunity cards/rows, including loading, error, stale-data, and no-edge states.
- **FTE-037 — Provider Health and Quota Dashboard States:** Expose provider health and quota information on the Dashboard and Data Sources view, with distinct outage, quota-exhausted, stale, and partial-data states.

## Requirements & Constraints

- Qualification is deterministic and server-authoritative. React and any LLM may display or interpret results but must not perform authoritative pricing, EV, confidence, or qualification decisions.
- Each candidate must record why it qualified or failed. Gates include a valid target-book price, minimum EV, enough eligible independent comparison books, maximum odds age, outlier rules, disagreement policy, market and event status, and provider health. Missing or unsafe input must fail closed; values must never be fabricated.
- Active ranking may contain only fresh, qualified opportunities. Stale target or comparison prices, suspended or incomplete markets, started/postponed/cancelled/closed events, and unsafe provider state remove or suppress active visibility while retaining history.
- Ranking uses configured signals including EV, confidence, freshness, and data quality. Explanations must expose ranking inputs sufficiently for user trust and include target odds/implied probability, consensus probability and fair odds, estimated EV, book count, warnings, and timestamps.
- Avoid promotional certainty such as “must-play,” “no-risk,” or similar claims. A positive, restrained no-edge state must explain known qualification failures without forcing a recommendation.
- All routes and APIs are authenticated. Provider status must not reveal API keys, account identifiers, or sensitive plan details. UI status messaging, tables, keyboard access, and contrast should follow WCAG 2.1 AA patterns.
- Provider failures, partial responses, quota exhaustion, ingestion/calculation errors, candidate counts, qualification reason distributions, stale-active counts, and query latency require observable signals aligned with user-visible status.

## Technical Decisions

- Consume generic market selections and versioned strategy configuration. Every recommendation stores `sportKey`, sport-module version, strategy version, calculation version, and exact input provenance; AI/prompt versions apply only when AI contributed.
- The initial policy is versioned and configurable: equal comparison-book weights, a sport-configured provisional EV threshold, a 15-minute maximum odds age, at least three eligible independent comparison books, and exclusion of a book when any outcome deviates eight percentage points from the market median. The offered/target sportsbook is excluded from its comparison consensus by default.
- Derive opportunities from immutable odds snapshots and current-price projections. Preserve input links so a qualification can be reconstructed; immutable snapshots have no MVP TTL. Current projections are updated or marked stale rather than expired by TTL.
- Persist recommendations and provider-health records in the core DynamoDB model. Support an active-opportunity index ordered by rank score and a stale-candidate cleanup access pattern; TTL is appropriate only for transient provider-health detail.
- Use generic sport-scoped opportunity routes (for example, `/sports/:sportKey/opportunities`) while preserving the authenticated ranked-list contract. API responses use validated envelopes and never expose raw provider payloads.
- TanStack Query owns opportunity/provider server state; API boundaries remain outside React components. Error boundaries distinguish authentication expiry, provider unavailability, stale data, and unknown errors. Stale odds are never styled as current.

## UX & Interaction Patterns

- Opportunity cards/rows show event, competition, Eastern Time kickoff, market, selection, target odds, best comparison odds, consensus fair odds, target implied probability, estimated fair probability, EV, confidence, contributing books, last update, freshness, and warning badges.
- “Open Event” goes to Event Detail. “Add Bet” remains disabled or deferred until the Bet Tracker dependency exists; once available, it opens manual bet entry with source context prefilled.
- The dashboard also reserves space for watched events, recent line movement, recent completed reports, and provider/quota summaries, but those modules must not imply data or capabilities that their owning epics have not delivered.
- Optimize dense scanning for laptop/tablet while keeping mobile usable. Provider outage, quota, stale, and partial states must be visually distinct and must explain their effect on opportunity visibility.

## Cross-Story Dependencies

- FTE-033 consumes immutable current-price data and deterministic consensus/EV outputs from FTE-021, FTE-028, FTE-029, and the configuration decisions from FTE-032, plus the applicable multi-sport domain, registry, strategy, and weighted-consensus foundations.
- Epic flow is FTE-033 → FTE-034 → FTE-035 → FTE-036. FTE-037 additionally depends on provider retry/quota/health behavior from FTE-024 and the dashboard surface from FTE-036.
- FTE-036 also requires the protected application shell from FTE-011. Scouting reports, watched events, line movement, and bet entry are integrations with later or separate stories; placeholders must degrade honestly until those capabilities exist.
