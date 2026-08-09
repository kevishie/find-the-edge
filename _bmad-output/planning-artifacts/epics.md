---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
  - templates/Find The Edge - Landing Page.html
---

# FIND THE EDGE - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for FIND THE EDGE. The current product direction supersedes the original single-private-user authentication scope: the landing page becomes the public acquisition surface, accounts use phone-number OTP authentication, and paid product access is enforced through Stripe-backed entitlements.

## Requirements Inventory

### Functional Requirements

FR1: Represent the universal betting domain without sport-specific shared fields.
FR2: Register every sport through a versioned SportModule contract with explicit maturity and capabilities.
FR3: Separate immutable sport mechanics from versioned product strategy.
FR4: Keep shared database keys, APIs, routes, pricing, and UI surfaces sport-generic.
FR5: Resolve external providers by declared capability, sport, league, market, freshness, and quality.
FR6: Store module, strategy, model, calculation, schema, prompt, and provenance versions for reproducibility.
FR7: Display each sport module's honest planned, experimental, beta, or production maturity.
FR8: Prove new sports can be registered without core-domain, pricing, storage-key, or generic-route changes.
FR9: Import upcoming events for enabled sports with configurable coverage, checkpoints, and cadence.
FR10: Preserve timestamped odds snapshots as immutable evidence for historical decisions.
FR11: Store probability, offered price, no-vig comparison, EV, thresholds, decision, versions, hashes, and provenance for each evaluation.
FR12: Apply versioned sport-specific AI instructions while keeping deterministic calculations outside the LLM.
FR13: Record qualified recommendations in an immutable paper-bet ledger.
FR14: Import results and grade supported selections idempotently with correction history.
FR15: Report performance using profitability, CLV, calibration, uncertainty, drawdown, and useful segments rather than win rate alone.
FR16: Evaluate strategy changes with frozen cohorts and leakage-resistant holdout or walk-forward methods.
FR17: Promote strategy versions through controlled lifecycle states using evidence-based gates.
FR18: Keep real-money sportsbook execution disabled unless separately reviewed and explicitly approved.
FR19: Authenticate users before granting product access.
FR20: Let users explicitly sign out and invalidate their session.
FR21: Protect all product routes and restore safe intended destinations after authentication.
FR22: Expire sessions according to configured security policy while preserving recoverable input where feasible.
FR23: Store identity and permission context that supports future roles and subscriptions.
FR24: Discover and normalize upcoming events with provider and retrieval metadata.
FR25: Let users browse and filter upcoming events by date, competition, status, sport, and watchlist.
FR26: Show bookmaker and market coverage with missing and stale states.
FR27: Ingest target and comparison sportsbook odds and capture provider health, errors, and quota use.
FR28: Let authorized configuration select the target sportsbook, comparison books, weights, sports, competitions, and markets.
FR29: Normalize bookmakers, events, participants, markets, and selections into canonical identities.
FR30: Deterministically convert odds and calculate implied probability, no-vig probability, weighted consensus, fair odds, EV, expected profit, and informational fractional Kelly.
FR31: Qualify opportunities only when EV, contributing-book, freshness, completeness, outlier, and disagreement policies pass.
FR32: Persist and display explicit qualification and disqualification reasons.
FR33: Rank only fresh active opportunities using configured EV, confidence, freshness, and strategy inputs.
FR34: Avoid promotional certainty, guaranteed-win, must-play, and no-risk language.
FR35: Present a dashboard with ranked opportunities, provider state, watched events, line movement, reports, and an intelligible no-edge state.
FR36: Let users start scouting jobs and view queued, running, completed, partial, failed, and retry states.
FR37: Prevent duplicate equivalent scouting work and version every completed report.
FR38: Render all fourteen required scouting-report sections in stable order, including unavailable sections.
FR39: Attach source, timestamps, verification, freshness, confidence, model, prompt, inputs, and version metadata to reports.
FR40: Never present invented sports facts and distinguish provider facts, deterministic calculations, and AI interpretation.
FR41: Show opening, current, and historical odds movement without unsupported causal claims.
FR42: Let users add, remove, browse, and monitor watched events and changes since last visit.
FR43: Let users create manual and recommendation-linked bet records with sportsbook, event, market, selection, odds, stake, timestamps, notes, and source.
FR44: Support Open, Won, Lost, Push, Void, and Cashed Out bet states.
FR45: Deterministically calculate settlement, profit/loss, ROI, and CLV.
FR46: Report performance by time, sport, competition, market, confidence, strategy, model, and paper-versus-money mode with small-sample warnings.
FR47: Let authorized users configure qualification, freshness, consensus, timezone, display, and future-automation preferences.
FR48: Serve the supplied landing-page design as the public root experience without requiring authentication.
FR49: Adapt the landing-page HTML into the production React design system rather than embedding its demo runtime as authoritative application code.
FR50: Provide clear landing-page calls to action for account creation, sign-in, pricing, and subscription access.
FR51: Let a user enter a normalized phone number and request a one-time passcode.
FR52: Deliver OTP codes through a pluggable SMS provider and never expose whether an account exists through unsafe messaging.
FR53: Let a user verify a valid, unexpired, single-use OTP and create or resume an authenticated session.
FR54: Rate-limit OTP requests and verification attempts by phone, IP/device signals, and configurable windows.
FR55: Support resend cooldowns, attempt limits, expiry, lockout/recovery states, and abuse-safe errors.
FR56: Require explicit acceptance of terms, privacy policy, and applicable betting-risk language during account onboarding.
FR57: Keep public acquisition routes accessible while protecting subscriber product routes server-side and client-side.
FR58: Show an authenticated but unsubscribed user the paywall with current plan, price, included access, and checkout action.
FR59: Create Stripe Checkout sessions on the server for the authenticated user and configured subscription price.
FR60: Associate Stripe customer and subscription identifiers with the internal user without trusting client-supplied entitlement claims.
FR61: Process verified, replay-safe Stripe webhooks and update subscription state idempotently.
FR62: Grant product entitlement only for eligible subscription states and revoke or limit it for canceled, unpaid, incomplete, or expired states according to policy.
FR63: Redirect successful checkout through a server-confirmed entitlement refresh before opening paid routes.
FR64: Provide billing-management access through Stripe's hosted customer portal.
FR65: Show subscription status, renewal/cancellation context, payment-recovery guidance, and safe failure states.
FR66: Handle webhook delay, duplicate delivery, out-of-order events, checkout abandonment, and payment failure without accidental access.
FR67: Allow admin/support reconciliation of Stripe state without directly editing entitlement truth in the browser.

### NonFunctional Requirements

NFR1: Protect private routes, sessions, OTP data, Stripe identifiers, webhook secrets, provider tokens, and user records using least privilege and encryption in transit and at rest.
NFR2: Treat identity, phone numbers, billing metadata, bet history, reports, and settings as private by default and minimize retained sensitive data.
NFR3: Degrade gracefully during provider, SMS, Stripe, or analytics outages with truthful cached/stale states and retry guidance.
NFR4: Keep landing, authentication, checkout initiation, dashboard, and event interactions responsive; long-running jobs must not block the UI.
NFR5: Meet WCAG 2.1 AA for navigation, forms, OTP entry, paywall, tables, dialogs, contrast, keyboard use, and live status messaging.
NFR6: Emit correlated, privacy-safe logs and metrics for auth, OTP abuse controls, checkout, webhooks, entitlement decisions, providers, ingestion, scouting, and calculations.
NFR7: Expose data freshness wherever odds, event, report, subscription, or provider state may be stale.
NFR8: Preserve immutable audit context for odds, reports, picks, billing events, and entitlement transitions.
NFR9: Make ingestion, OTP submission, checkout creation, webhook handling, job creation, retries, and grading idempotent where repetition is expected.
NFR10: Preserve the AWS serverless and DynamoDB-compatible scaling direction without coupling the core product to one sport or provider.
NFR11: Keep auth, billing, provider adapters, calculation logic, sport modules, prompts, and UI features modular and independently testable.
NFR12: Never produce active recommendations or paid entitlements from missing, unverified, stale, or client-asserted state.
NFR13: Control and observe SMS, Stripe, provider, AI, AWS, and polling costs and quotas.
NFR14: Retain sufficient sources, timestamps, versions, hashes, and decisions to reconstruct recommendations and access decisions.
NFR15: Verify Stripe webhook signatures against the raw request body and defend against replay and out-of-order delivery.
NFR16: OTP codes must be short-lived, single-use, attempt-limited, non-logged, and stored only as secure verification artifacts.
NFR17: Authentication and billing responses must avoid phone-number or account enumeration.
NFR18: Paid-route authorization must be enforced by trusted backend entitlement checks, not UI visibility alone.
NFR19: Landing-page metadata, semantic structure, and performance should support discoverability and fast public loading without exposing protected data.
NFR20: Subscription, price, legal, tax, refund, cancellation, and responsible-gaming copy must be configurable and reviewed before launch.

### Additional Requirements

- Preserve the existing strict TypeScript pnpm/Turborepo structure and package dependency boundaries.
- Use Cognito-compatible custom authentication or an explicitly approved equivalent for phone + OTP; the original email/password Cognito flow is superseded.
- Model user identity separately from phone aliases, Stripe customer identity, subscription records, and derived entitlements.
- Add a billing boundary with server-only Stripe SDK usage, Checkout session creation, Customer Portal creation, verified webhook ingestion, and entitlement projection.
- Add public routes for landing, legal content, authentication, OTP verification, pricing/paywall, checkout return, and billing recovery.
- Keep paid application APIs behind both authentication and current entitlement authorization.
- Use conditional writes and event identifiers to make subscription and entitlement projection idempotent and auditable.
- Store Stripe and SMS secrets in Secrets Manager; never put secret keys in frontend bundles or source control.
- Preserve generic sport routes, registered module maturity, capability-based provider resolution, and deterministic calculation ownership.
- Continue using immutable odds evidence, append-oriented report/pick/billing history, opaque cursor pagination, typed response envelopes, Zod validation, and correlation IDs.
- Provide local fakes/fixtures for SMS and Stripe so tests require no paid service or real message delivery.
- Add contract and integration tests for OTP lifecycle, checkout creation, webhook signature verification, subscription state transitions, and paid-route denial.
- Add end-to-end coverage for landing -> phone entry -> OTP -> paywall -> checkout return -> entitled product, plus cancellation/payment-failure paths.
- Preserve the supplied landing template as a design reference while converting it into maintained React components and production assets.
- Resolve product decisions before launch: SMS provider and sender registration, countries/phone formats, trial and plan structure, subscription price/currency, grace-period policy, taxes, refunds, legal terms, responsible-gaming copy, account deletion, and support path.

### UX Design Requirements

UX-DR1: Implement the public landing page from the supplied template with responsive production components, semantic HTML, accessible navigation, and fast-loading assets.
UX-DR2: Preserve the premium dark analytical identity: near-black surfaces, restrained purple brand emphasis, evidence-first copy, and no casino or guaranteed-win aesthetics.
UX-DR3: Use the specified color, typography, spacing, radius, border, and restrained-motion tokens, reserving green for verified positive EV or process outcomes.
UX-DR4: Provide clear landing-page hierarchy for value proposition, evidence, product preview, pricing, risk context, FAQ, and sign-up/sign-in calls to action.
UX-DR5: Design phone entry, OTP verification, resend, expiry, loading, error, lockout, and recovery states for keyboard and mobile use.
UX-DR6: Design the paywall to clearly communicate plan price, billing cadence, included access, renewal/cancellation terms, and what happens after checkout.
UX-DR7: Provide distinct checkout-pending, activation-delayed, payment-failed, canceled, expired, and billing-recovery states without granting ambiguous access.
UX-DR8: Retain the product's desktop terminal shell, tablet navigation adaptation, and mobile bottom-navigation priorities after entitlement is granted.
UX-DR9: Implement reusable AppShell, navigation, header, stat tile, opportunity card, dense table, filter, status/freshness badge, confidence meter, odds cell, provider row, quota bar, toast, dialog, drawer, skeleton, and empty-state components.
UX-DR10: Implement Event Detail, Scouting Job State, Odds Terminal, Watchlist, Performance, Settings, Reports Library, and Bet Entry surfaces missing from the prototype.
UX-DR11: Use explicit loading, empty, partial, stale, unavailable, suspended, error, and no-edge/PASS states throughout the app.
UX-DR12: Render provenance through verified/inferred/stale/unavailable badges, source pills, calculation/version detail, AI-interpretation labels, timestamps, and progressive disclosure.
UX-DR13: Keep the fourteen scouting sections in exact order with sticky navigation, collapsible panels, version selection, citations, and change indicators.
UX-DR14: Use dense semantic tables with accessible sorting and horizontal overflow for Events, Scanner, Odds Terminal, Bets, and Performance.
UX-DR15: Provide charts with text alternatives and underlying data tables; prioritize ROI, CLV, calibration, and uncertainty over raw win rate.
UX-DR16: Ensure all actions, filters, rows, tabs, drawers, dialogs, OTP inputs, and billing controls work by keyboard with visible focus and status announced by polite live regions.
UX-DR17: Respect reduced-motion preferences and maintain practical 44px mobile touch targets.
UX-DR18: Keep authoritative betting and entitlement decisions out of React components and label client-visible data according to source and freshness.

### FR Coverage Map

FR1: Epic 4 - Universal sport-agnostic betting domain.
FR2: Epic 4 - Registered versioned sport modules.
FR3: Epic 4 - Mechanics and strategy separation.
FR4: Epic 4 - Generic storage, APIs, routes, pricing, and UI.
FR5: Epic 4 - Capability-based provider resolution.
FR6: Epic 4 - Reproducible versions and provenance.
FR7: Epic 4 - Visible module maturity.
FR8: Epic 4 - Contract-tested sport extensibility.
FR9: Epic 4 - Multi-sport schedule ingestion.
FR10: Epic 4 - Immutable odds evidence.
FR11: Epic 5 - Complete versioned evaluation records.
FR12: Epic 6 - Sport-specific AI policy and deterministic boundaries.
FR13: Epic 8 - Immutable paper-pick ledger.
FR14: Epic 8 - Automated results and grading.
FR15: Epic 8 - Evaluation beyond win rate.
FR16: Epic 8 - Leakage-resistant retrospectives.
FR17: Epic 8 - Controlled strategy promotion.
FR18: Epic 8 - Real-money safety boundary.
FR19: Epic 2 - User authentication.
FR20: Epic 2 - Sign-out and session invalidation.
FR21: Epic 2 - Protected routes and safe redirect restoration.
FR22: Epic 2 - Session expiry behavior.
FR23: Epic 2 - Extensible identity and permission context.
FR24: Epic 4 - Event discovery and normalization.
FR25: Epic 4 - Event browsing and filtering.
FR26: Epic 4 - Coverage, missing, and stale states.
FR27: Epic 4 - Target/comparison odds and provider health capture.
FR28: Epic 4 - Sportsbook, competition, market, and weight configuration.
FR29: Epic 4 - Canonical entity normalization.
FR30: Epic 4 - Deterministic betting calculations.
FR31: Epic 5 - Opportunity qualification policies.
FR32: Epic 5 - Qualification and disqualification explanations.
FR33: Epic 5 - Fresh active opportunity ranking.
FR34: Epic 5 - Restrained non-promotional language.
FR35: Epic 5 - Decision-focused dashboard.
FR36: Epic 6 - Scouting jobs and progress states.
FR37: Epic 6 - Duplicate prevention and report versioning.
FR38: Epic 6 - Complete structured reports.
FR39: Epic 6 - Report provenance and version metadata.
FR40: Epic 6 - No invented facts and clear responsibility boundaries.
FR41: Epic 4 - Odds history and movement.
FR42: Epic 7 - Watchlists and change monitoring.
FR43: Epic 7 - Manual and recommendation-linked bet records.
FR44: Epic 7 - Complete bet lifecycle states.
FR45: Epic 7 - Settlement, profit/loss, ROI, and CLV.
FR46: Epic 7 - Segmented performance reporting.
FR47: Epic 4 - User-configurable analysis and display settings.
FR48: Epic 1 - Public landing experience.
FR49: Epic 1 - Production React adaptation of supplied design.
FR50: Epic 1 - Acquisition and pricing calls to action.
FR51: Epic 2 - Phone-number OTP request.
FR52: Epic 2 - Pluggable, enumeration-safe SMS delivery.
FR53: Epic 2 - OTP verification and session creation.
FR54: Epic 2 - OTP abuse rate limits.
FR55: Epic 2 - Resend, expiry, lockout, and recovery states.
FR56: Epic 2 - Terms, privacy, and risk acceptance.
FR57: Epic 3 - Public-route and paid-route access boundary.
FR58: Epic 3 - Subscriber paywall.
FR59: Epic 3 - Server-created Stripe Checkout.
FR60: Epic 3 - Trusted Stripe identity association.
FR61: Epic 3 - Verified idempotent Stripe webhooks.
FR62: Epic 3 - Subscription-derived entitlements.
FR63: Epic 3 - Server-confirmed checkout activation.
FR64: Epic 3 - Stripe Customer Portal access.
FR65: Epic 3 - Subscription and recovery UX.
FR66: Epic 3 - Billing race and failure handling.
FR67: Epic 3 - Support reconciliation.

## Epic List

### Epic 1: Discover FIND THE EDGE
Visitors can understand the product, its evidence-first approach, pricing path, and risk posture through a polished public landing experience adapted from the supplied design.
**FRs covered:** FR48, FR49, FR50.

### Epic 2: Create and Secure an Account
Visitors can accept required terms, sign in using phone number and OTP, recover from common verification problems, maintain a secure session, and sign out.
**FRs covered:** FR19, FR20, FR21, FR22, FR23, FR51, FR52, FR53, FR54, FR55, FR56.

### Epic 3: Subscribe and Unlock the Product
Authenticated users can understand the paid offering, subscribe through Stripe, gain server-verified access, manage billing, and recover from payment or entitlement problems.
**FRs covered:** FR57, FR58, FR59, FR60, FR61, FR62, FR63, FR64, FR65, FR66, FR67.

### Epic 4: Explore Trustworthy Sports Markets
Subscribers can browse registered sports and upcoming events, inspect normalized target/comparison odds and movement, understand freshness and provider coverage, and configure their analysis preferences using reproducible deterministic data.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR41, FR47.

### Epic 5: Find and Understand the Edge
Subscribers can open a decision-focused dashboard, see only fresh qualified opportunities, and understand the evidence, confidence, and exact reasons to play or pass.
**FRs covered:** FR11, FR31, FR32, FR33, FR34, FR35.

### Epic 6: Scout an Event with Verifiable Evidence
Subscribers can launch and monitor scouting, review versioned structured reports, distinguish verified facts from deterministic calculations and AI interpretation, and receive an honest PASS when evidence is insufficient.
**FRs covered:** FR12, FR36, FR37, FR38, FR39, FR40.

### Epic 7: Track Decisions and Measure Process Quality
Subscribers can maintain a watchlist, record and settle bets, and evaluate ROI, CLV, confidence, and performance segments without over-weighting short-term win rate.
**FRs covered:** FR42, FR43, FR44, FR45, FR46.

### Epic 8: Learn Safely from Paper Picks
Subscribers and product operators can run an immutable paper-pick feedback loop, grade results, evaluate strategies without leakage, and promote improvements through controlled evidence-based gates while real-money execution remains disabled.
**FRs covered:** FR13, FR14, FR15, FR16, FR17, FR18.

## Epic 1: Discover FIND THE EDGE

Visitors can understand the product, its evidence-first approach, pricing path, and risk posture through a polished public landing experience adapted from the supplied design.

### Story 1.1: Publish the Public Landing Experience

**Requirements:** FR48, FR49; NFR5, NFR19; UX-DR1, UX-DR2, UX-DR3.

As a prospective subscriber,
I want to visit a polished public FIND THE EDGE landing page,
So that I can understand the product before creating an account.

**Acceptance Criteria:**

**Given** an unauthenticated visitor
**When** they open the root route
**Then** the supplied design is rendered as maintained React components without requiring authentication
**And** prototype-only scripts, protected data, and authoritative calculations are not embedded in the page.

**Given** a desktop, tablet, or mobile viewport
**When** the page renders
**Then** content, navigation, focus states, motion preferences, and touch targets remain usable
**And** the page has semantic landmarks, optimized assets, and meaningful public metadata.

### Story 1.2: Explain the Evidence-First Value

**Requirements:** FR49; FR34 (copy constraint); UX-DR2, UX-DR3, UX-DR4.

As a prospective subscriber,
I want a clear explanation of how FIND THE EDGE evaluates opportunities,
So that I can decide whether the product is relevant and trustworthy.

**Acceptance Criteria:**

**Given** a visitor reads the landing page
**When** they move through its content
**Then** they encounter the value proposition, workflow, evidence, product preview, risk context, and FAQ
**And** the visual language follows the approved dark analytical tokens.

**Given** the page describes recommendations or performance
**When** copy is displayed
**Then** it avoids certainty, guaranteed-win, must-play, no-risk, or picks-selling language
**And** PASS or no-edge outcomes are presented as valid decisions.

### Story 1.3: Guide Visitors to Account and Pricing

**Requirements:** FR50; NFR20; UX-DR4.

As a prospective subscriber,
I want clear account, sign-in, pricing, and legal paths,
So that I know how to access the paid product.

**Acceptance Criteria:**

**Given** a configured phone-authentication entry point
**When** a visitor activates an account or sign-in CTA
**Then** that entry point opens with safe intended-destination context
**And** no public email/password flow is offered.

**Given** account access is not yet enabled in an environment
**When** the CTA renders
**Then** it presents an honest availability state instead of a broken destination
**And** the rest of the landing experience remains complete and usable.

**Given** pricing is displayed
**When** plan content loads
**Then** price, currency, cadence, included access, and renewal/cancellation context come from configuration
**And** unresolved values are not presented as production truth.

**Given** legal or risk information is referenced
**When** its link is activated
**Then** accessible Terms, Privacy, and responsible-gaming destinations are available
**And** unapproved content is clearly identified before launch.

## Epic 2: Create and Secure an Account

Visitors can accept required terms, sign in using phone number and OTP, recover from common verification problems, maintain a secure session, and sign out.

### Story 2.1: Request a Phone Verification Code

**Requirements:** FR19, FR51, FR52, FR56; NFR2, NFR16, NFR17; UX-DR5.

As a visitor,
I want to request a one-time code using my phone number,
So that I can securely begin account access.

**Acceptance Criteria:**

**Given** a supported phone number and required consent
**When** the user requests a code
**Then** the number is normalized, an expiring verification challenge is created, and the SMS adapter is invoked
**And** the response does not disclose whether an account already exists.

**Given** invalid input, unsupported geography, or missing consent
**When** submission occurs
**Then** accessible field guidance is shown and no challenge is issued
**And** sensitive input and OTP artifacts are not logged.

### Story 2.2: Resist OTP Abuse

**Requirements:** FR54, FR55; NFR6, NFR9, NFR13, NFR16, NFR17; UX-DR5.

As the product owner,
I want verification requests and attempts constrained,
So that user accounts and messaging costs are protected from abuse.

**Acceptance Criteria:**

**Given** configured phone, IP, and device windows
**When** request or verification limits are exceeded
**Then** the action is rejected with an enumeration-safe retry response
**And** privacy-safe metrics record the limit category.

**Given** a resend request
**When** cooldown has not elapsed
**Then** no additional SMS is sent and the remaining wait is communicated accessibly
**And** repeated requests remain idempotent within the configured window.

### Story 2.3: Verify OTP and Establish a Session

**Requirements:** FR19, FR23, FR53, FR55; NFR1, NFR16, NFR17; UX-DR5.

As a visitor with a code,
I want to verify it and establish my account session,
So that I can continue to subscription or the product.

**Acceptance Criteria:**

**Given** a valid unexpired unused code
**When** the user submits it
**Then** the challenge is consumed once, an identity is created or resumed, and a secure session is established
**And** the user proceeds to their safe destination or paywall.

**Given** an invalid, expired, used, or attempt-limited code
**When** it is submitted
**Then** access is denied with resend or recovery guidance appropriate to the state
**And** the response does not reveal account existence.

### Story 2.4: Protect Routes and Manage Sessions

**Requirements:** FR21, FR22; NFR1, NFR2, NFR18.

As an authenticated user,
I want predictable session and route protection behavior,
So that my private information remains secure without losing context unnecessarily.

**Acceptance Criteria:**

**Given** an unauthenticated request to a protected route or API
**When** authorization is evaluated
**Then** protected data is denied and browser navigation is redirected to authentication
**And** only a validated internal destination may be restored.

**Given** an expired or revoked session
**When** the user acts
**Then** reauthentication is required with an accessible session-expired state
**And** recoverable unsaved input is preserved where safe.

### Story 2.5: Sign Out Securely

**Requirements:** FR20; NFR1, NFR2.

As an authenticated user,
I want to sign out explicitly,
So that another person using my device cannot access my account.

**Acceptance Criteria:**

**Given** an active session
**When** sign out is confirmed
**Then** server and local session material is invalidated and protected caches are cleared
**And** revisiting a protected route requires authentication.

## Epic 3: Subscribe and Unlock the Product

Authenticated users can understand the paid offering, subscribe through Stripe, gain server-verified access, manage billing, and recover from payment or entitlement problems.

### Story 3.1: Present the Subscriber Paywall

**Requirements:** FR57, FR58, FR65; NFR5, NFR18, NFR20; UX-DR6, UX-DR7.

As an authenticated user without access,
I want a clear subscription offer,
So that I can decide whether to unlock the product.

**Acceptance Criteria:**

**Given** an authenticated user without eligible entitlement
**When** they request a paid route
**Then** the server denies product data and the UI presents the configured plan, price, cadence, inclusions, and terms
**And** loading, unavailable-price, and existing-subscription states are distinct.

### Story 3.2: Start Stripe Checkout

**Requirements:** FR59, FR60; NFR1, NFR9, NFR13, NFR18.

As an authenticated user,
I want to begin a secure Stripe checkout,
So that I can purchase product access.

**Acceptance Criteria:**

**Given** a valid configured price and authenticated user
**When** checkout is requested
**Then** the server creates or reuses the trusted Stripe customer and creates a Checkout session
**And** the client cannot choose arbitrary prices, customers, entitlement, success URLs, or metadata.

**Given** repeated equivalent checkout requests
**When** they occur within the idempotency window
**Then** duplicate active subscriptions are avoided
**And** Stripe or configuration failures return safe recovery guidance.

### Story 3.3: Project Subscription Entitlements from Webhooks

**Requirements:** FR60, FR61, FR62, FR66; NFR8, NFR9, NFR14, NFR15, NFR18.

As a subscriber,
I want access to reflect my verified Stripe subscription,
So that activation and revocation are accurate.

**Acceptance Criteria:**

**Given** a Stripe webhook with a valid signature and unprocessed event ID
**When** it is received using the raw request body
**Then** the billing event is stored and subscription state is projected idempotently
**And** duplicate or out-of-order events cannot regress newer trusted state.

**Given** a subscription state governed by entitlement policy
**When** projection completes
**Then** eligible states grant access and ineligible states deny or enter the configured grace policy
**And** every transition is reconstructable from audit records.

### Story 3.4: Complete Checkout and Confirm Access

**Requirements:** FR57, FR62, FR63, FR66; NFR3, NFR18; UX-DR7.

As a newly paying subscriber,
I want checkout return to confirm my access,
So that I enter the product only after payment state is trusted.

**Acceptance Criteria:**

**Given** a user returns from successful Checkout
**When** entitlement has been confirmed by trusted server state
**Then** paid routes open and the intended destination is restored
**And** client URL parameters alone never grant access.

**Given** webhook processing is delayed or checkout is abandoned
**When** the return page loads
**Then** a bounded pending or canceled state is shown with refresh and support guidance
**And** protected product data remains unavailable.

### Story 3.5: Manage Billing and Recover Payment

**Requirements:** FR64, FR65, FR66, FR67; NFR3, NFR14, NFR18, NFR20; UX-DR7.

As a subscriber,
I want to view status and manage billing securely,
So that I can update payment, cancel, or recover access.

**Acceptance Criteria:**

**Given** an authenticated Stripe-linked user
**When** billing management is requested
**Then** the server creates a scoped Customer Portal session and redirects safely
**And** secret billing details are never returned to the browser.

**Given** a failed, canceled, unpaid, incomplete, or expired subscription
**When** the account or paywall renders
**Then** the correct status, access effect, and recovery action are shown
**And** a support reconciliation command can re-read Stripe without browser-edited entitlement truth.

## Epic 4: Explore Trustworthy Sports Markets

Subscribers can browse registered sports and upcoming events, inspect normalized target/comparison odds and movement, understand freshness and provider coverage, and configure their analysis preferences using reproducible deterministic data.

### Story 4.1: Browse Registered Sports and Upcoming Events

**Requirements:** FR1, FR2, FR4, FR7, FR8, FR24, FR25, FR26; NFR4, NFR5, NFR10; UX-DR8, UX-DR9, UX-DR10, UX-DR11, UX-DR14.

As a subscriber,
I want to browse enabled sports and upcoming events,
So that I can find markets worth investigating.

**Acceptance Criteria:**

**Given** registered modules of different maturity
**When** sports and events load
**Then** shared routes and models render module-provided terminology and visible maturity without sport-specific core branching
**And** date, sport, competition, status, and watchlist filters are combinable and cursor-paginated.

**Given** no matches, provider failure, partial data, or stale data
**When** the explorer renders
**Then** each condition has a distinct accessible state
**And** unavailable facts are not inferred.

### Story 4.2: Ingest and Preserve Event and Odds Evidence

**Requirements:** FR5, FR6, FR9, FR10, FR24, FR27, FR29; NFR3, NFR6, NFR7, NFR8, NFR9, NFR12, NFR14.

As a subscriber,
I want market data backed by immutable provider evidence,
So that historical decisions remain reproducible.

**Acceptance Criteria:**

**Given** a capability-matched provider response
**When** schedule or odds ingestion runs
**Then** canonical events, participants, books, markets, selections, timestamps, coverage, health, quota, and checkpoints are persisted idempotently
**And** later prices append immutable snapshots instead of overwriting evidence.

**Given** a provider error, suspended market, incomplete selection set, or older payload
**When** ingestion evaluates it
**Then** safe current projections are not overwritten or fabricated
**And** health and freshness consequences are observable.

### Story 4.3: Calculate Fair Market Values Deterministically

**Requirements:** FR3, FR6, FR30; NFR8, NFR11, NFR12, NFR14; UX-DR18.

As a subscriber,
I want consistent fair prices and EV inputs,
So that market comparisons are auditable rather than guessed.

**Acceptance Criteria:**

**Given** valid generic market selections and configured comparison books
**When** calculations run
**Then** odds conversion, implied probability, two/three-way no-vig, weights, fair odds, EV, expected profit, and informational Kelly use pure versioned functions
**And** rounding occurs only at display boundaries.

**Given** invalid odds, missing selections, stale inputs, or insufficient books
**When** calculations run
**Then** typed failures and disqualification inputs are returned without throwing for normal invalid data
**And** golden, unit, and property-style tests cover known cases.

### Story 4.4: Inspect Event Markets and Odds History

**Requirements:** FR26, FR27, FR41; NFR4, NFR5, NFR7; UX-DR9, UX-DR10, UX-DR11, UX-DR12, UX-DR14.

As a subscriber,
I want an event detail and odds terminal,
So that I can compare books, freshness, movement, and source evidence.

**Acceptance Criteria:**

**Given** current and historical snapshots
**When** an event or market is opened
**Then** target, comparisons, best price, fair price, opening/current movement, timestamps, disagreement, and missing/suspended states are visible
**And** significant movement never claims unsupported sharp or public action.

**Given** a wide table or small viewport
**When** the view renders
**Then** semantic headers, accessible sorting, horizontal overflow, and drill-in detail preserve usability
**And** source/provenance details use progressive disclosure.

### Story 4.5: Configure Market Analysis Preferences

**Requirements:** FR28, FR47; NFR8, NFR11, NFR14; UX-DR10.

As a subscriber,
I want to configure my target book and analysis rules,
So that product outputs reflect my decision context.

**Acceptance Criteria:**

**Given** valid target book, comparison books, weights, sports, competitions, markets, thresholds, freshness, timezone, and display settings
**When** a versioned update succeeds
**Then** future analysis uses the new configuration and the change is audited
**And** optimistic conflicts require refresh rather than silent overwrite.

**Given** future automation settings
**When** they are stored
**Then** the UI labels them as inactive preferences until automation exists
**And** they do not schedule work implicitly.

## Epic 5: Find and Understand the Edge

Subscribers can open a decision-focused dashboard, see only fresh qualified opportunities, and understand the evidence, confidence, and exact reasons to play or pass.

### Story 5.1: Evaluate Every Candidate Transparently

**Requirements:** FR11, FR31, FR32; NFR7, NFR8, NFR12, NFR14; UX-DR12, UX-DR18.

As a subscriber,
I want each candidate evaluated against explicit rules,
So that I can understand why it qualifies or fails.

**Acceptance Criteria:**

**Given** target odds, comparison prices, strategy, freshness, and provider health
**When** evaluation runs
**Then** EV, threshold, decision, confidence, versions, input hash, provenance, and all qualification/disqualification reasons are stored
**And** missing, stale, suspended, outlier, disagreement, or insufficient-book conditions fail closed.

### Story 5.2: View Ranked Active Opportunities

**Requirements:** FR33, FR35; NFR3, NFR4, NFR7, NFR12; UX-DR8, UX-DR9, UX-DR11, UX-DR12.

As a subscriber,
I want fresh opportunities ranked on the dashboard,
So that I can focus on the strongest current decisions.

**Acceptance Criteria:**

**Given** qualified fresh opportunities
**When** the dashboard loads
**Then** it ranks them by configured logic and shows event, market, target/fair odds, EV, confidence, book count, freshness, warnings, and actions
**And** stale, suspended, closed, or unsafe opportunities are excluded from active ranking.

**Given** provider degradation
**When** the dashboard loads
**Then** health and quota state are visible and misleading recommendations are suppressed
**And** historical content is labeled with its freshness.

### Story 5.3: Understand a No-Edge Decision

**Requirements:** FR32, FR34, FR35; UX-DR2, UX-DR11.

As a subscriber,
I want a useful PASS state when nothing qualifies,
So that I do not feel pushed toward a weak bet.

**Acceptance Criteria:**

**Given** no candidate meets policy
**When** dashboard or event decision surfaces render
**Then** they show a calm no-edge state with leading disqualification reasons
**And** copy avoids certainty, urgency, guaranteed-win, and must-play language.

### Story 5.4: Scan and Filter Opportunities

**Requirements:** FR31, FR33; NFR4, NFR5; UX-DR9, UX-DR10, UX-DR11, UX-DR12, UX-DR14.

As a subscriber,
I want to filter and sort opportunity candidates,
So that I can investigate relevant edges and failure states.

**Acceptance Criteria:**

**Given** opportunity records
**When** filters or sorting are applied
**Then** competition, window, market, target, EV, confidence, book count, age, watchlist, scouting, and lifecycle filters work together
**And** results remain accessible, cursor-paginated, and source-aware.

## Epic 6: Scout an Event with Verifiable Evidence

Subscribers can launch and monitor scouting, review versioned structured reports, distinguish verified facts from deterministic calculations and AI interpretation, and receive an honest PASS when evidence is insufficient.

### Story 6.1: Launch and Monitor Event Scouting

**Requirements:** FR36, FR37; NFR4, NFR6, NFR9, NFR11; UX-DR10, UX-DR11.

As a subscriber,
I want to start and monitor scouting for an event,
So that I know when deeper evidence is ready.

**Acceptance Criteria:**

**Given** an eligible event and input snapshot set
**When** scouting is requested
**Then** an idempotent job enters a user-friendly queued/running lifecycle and duplicate clicks open the existing work
**And** progress avoids exposing infrastructure terminology.

**Given** partial, retryable, terminal, or timed-out work
**When** status is displayed
**Then** the correct warning and action are provided
**And** retries create linked attempts without mutating prior attempts.

### Story 6.2: Generate a Grounded Structured Report

**Requirements:** FR6, FR12, FR39, FR40; NFR7, NFR8, NFR11, NFR12, NFR14; UX-DR12, UX-DR18.

As a subscriber,
I want a scouting report grounded in verified evidence,
So that interpretation never masquerades as fact.

**Acceptance Criteria:**

**Given** collected provider facts and deterministic market outputs
**When** sport-specific prompt composition and AI synthesis run
**Then** structured output is schema-validated and every fact carries source, verification, freshness, timestamps, and confidence
**And** unavailable data is labeled rather than invented.

**Given** betting calculations appear in a report
**When** provenance is inspected
**Then** they reference deterministic calculation/version outputs rather than LLM arithmetic
**And** AI interpretation is visibly labeled and cited.

### Story 6.3: Review All Report Sections and Verdicts

**Requirements:** FR34, FR38, FR40; NFR5, NFR7; UX-DR11, UX-DR12, UX-DR13, UX-DR16, UX-DR17.

As a subscriber,
I want a navigable complete report,
So that I can review context, market edge, risk, and the final play-or-pass verdict.

**Acceptance Criteria:**

**Given** a completed or partial report
**When** it renders
**Then** all fourteen required sections appear in exact order with sticky navigation, collapsible panels, statuses, citations, and confidence
**And** missing sections appear as unavailable rather than disappearing.

**Given** evidence is insufficient
**When** the verdict renders
**Then** PASS is presented as a valid outcome with specific limitations
**And** promotional certainty is absent.

### Story 6.4: Compare Immutable Report Versions

**Requirements:** FR37, FR39; NFR8, NFR14; UX-DR12, UX-DR13.

As a subscriber,
I want to inspect prior report versions and changes,
So that later information does not rewrite what was known earlier.

**Acceptance Criteria:**

**Given** multiple report runs
**When** version history is opened
**Then** each immutable version exposes generation time, sources, snapshots, model, prompt, calculation, and validation metadata
**And** change indicators distinguish added, removed, stale, conflicting, and updated evidence.

## Epic 7: Track Decisions and Measure Process Quality

Subscribers can maintain a watchlist, record and settle bets, and evaluate ROI, CLV, confidence, and performance segments without over-weighting short-term win rate.

### Story 7.1: Monitor a Watchlist

**Requirements:** FR42; NFR4, NFR7, NFR8; UX-DR9, UX-DR10, UX-DR11.

As a subscriber,
I want to add and monitor events on a watchlist,
So that important changes are easy to revisit.

**Acceptance Criteria:**

**Given** an event
**When** the user adds or removes it
**Then** per-user watch state updates idempotently without deleting event history
**And** watched views show kickoff, opportunity, report, freshness, movement, and verified changes since last visit.

### Story 7.2: Record a Bet Decision

**Requirements:** FR43; NFR2, NFR5, NFR8, NFR9, NFR14; UX-DR9, UX-DR10, UX-DR16, UX-DR17.

As a subscriber,
I want to record a manual or recommendation-linked bet,
So that I can evaluate the decision later.

**Acceptance Criteria:**

**Given** an opportunity or manual entry
**When** a bet is saved
**Then** sportsbook, event, market, selection, odds, stake, placement time, source, notes, and open status persist
**And** the exact source recommendation/report and available price remain reproducible when present.

**Given** desktop or mobile
**When** bet entry opens
**Then** it uses an accessible drawer/dialog or full-height sheet with validated inputs
**And** duplicate submissions are safely handled.

### Story 7.3: Settle a Bet and Calculate CLV

**Requirements:** FR44, FR45; NFR8, NFR9, NFR14; UX-DR12, UX-DR18.

As a subscriber,
I want to settle a tracked bet,
So that outcome and process quality are calculated consistently.

**Acceptance Criteria:**

**Given** an open bet and settlement inputs
**When** Won, Lost, Push, Void, or Cashed Out is recorded
**Then** payout, profit/loss, and ROI calculate deterministically and settlement history is auditable
**And** missing closing evidence marks CLV unavailable rather than estimated.

**Given** valid configured closing consensus
**When** CLV is calculated
**Then** the benchmark, timestamps, inputs, and version are stored
**And** outcome remains visually distinct from process quality.

### Story 7.4: Review Performance with Proper Context

**Requirements:** FR46; NFR4, NFR5; UX-DR10, UX-DR11, UX-DR15, UX-DR16.

As a subscriber,
I want performance reports with uncertainty and useful segments,
So that I can improve process without overreacting to win rate.

**Acceptance Criteria:**

**Given** tracked decisions
**When** performance loads
**Then** units, ROI, CLV, win rate, average odds/EV, drawdown, and supported segments are available
**And** recommended versus manual and paper versus money modes remain distinguishable.

**Given** a small sample
**When** charts or summaries render
**Then** neutral caution and uncertainty are shown, ROI and CLV outrank raw win rate, and charts provide text/data alternatives
**And** no metric implies guaranteed future performance.

## Epic 8: Learn Safely from Paper Picks

Subscribers and product operators can run an immutable paper-pick feedback loop, grade results, evaluate strategies without leakage, and promote improvements through controlled evidence-based gates while real-money execution remains disabled.

### Story 8.1: Record Qualified Paper Picks

**Requirements:** FR13; NFR8, NFR9, NFR14.

As a product operator,
I want qualified recommendations captured as immutable paper picks,
So that the strategy can be measured without real-money execution.

**Acceptance Criteria:**

**Given** a qualified recommendation
**When** paper recording runs
**Then** the exact available price, decision time, probability, EV, confidence, mode, versions, hash, and provenance are stored immutably
**And** later odds or strategy changes cannot rewrite the pick.

### Story 8.2: Import Results and Grade Picks

**Requirements:** FR14; NFR3, NFR6, NFR8, NFR9, NFR14.

As a product operator,
I want completed events imported and picks graded automatically,
So that evaluation data stays current and consistent.

**Acceptance Criteria:**

**Given** a completed event from a capability-matched results provider
**When** scheduled grading runs
**Then** supported moneyline and spread picks resolve deterministically to win, loss, push, void, or unresolved
**And** reruns are idempotent with provider provenance.

**Given** a corrected provider result
**When** it is ingested
**Then** correction history is appended and affected aggregates are rebuilt safely
**And** prior result evidence is not deleted.

### Story 8.3: Evaluate Frozen Performance Cohorts

**Requirements:** FR15, FR16; NFR8, NFR14; UX-DR15.

As a product operator,
I want leakage-resistant cohort reports,
So that strategy changes are evaluated honestly.

**Acceptance Criteria:**

**Given** a frozen baseline and challenger cohort
**When** evaluation runs
**Then** sample size, price, units, ROI, EV, CLV, calibration, confidence intervals, drawdown, and supported segments are reported
**And** training/tuning observations are excluded from validation evidence.

**Given** insufficient data
**When** results are presented
**Then** uncertainty and unmet gates are explicit
**And** a target hit rate alone cannot justify promotion.

### Story 8.4: Promote Strategy Versions Safely

**Requirements:** FR17, FR18; NFR1, NFR6, NFR8, NFR12, NFR14.

As a product operator,
I want controlled strategy lifecycle transitions,
So that only evidence-backed versions become approved.

**Acceptance Criteria:**

**Given** a version in draft, shadow, paper, candidate, or approved state
**When** promotion is requested
**Then** configured sample, ROI, CLV, calibration, and risk gates are evaluated and the transition is audited
**And** failed gates preserve the current state with reasons.

**Given** the initial product release
**When** any workflow requests real-money sportsbook execution
**Then** it is denied by default behind a kill switch and separately approved release boundary
**And** paper tracking continues independently.
