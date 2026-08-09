---
stepsCompleted:
  - step-01-validate-prerequisites
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
