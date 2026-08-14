# Epic 12 Context: Owned Phone/OTP Authentication and Paid Access

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Replace the obsolete Cognito-hosted authentication path with a first-party phone and one-time-code experience, then separate proven identity from paid product access. Public acquisition and account-entry surfaces remain available to everyone, while Events, Splits, Scanner, Watchlist, Reports, and every account-specific API fail closed unless the request carries a valid owned session and the server's current entitlement projection grants access. The result is an on-origin sign-in flow, a seven-day trial and $99/month subscription path, private per-account product data, and no remaining Cognito resource or shipped code path.

## Stories

- Story FTE-070: Own Phone/OTP Identity Service
- Story FTE-071: Sign-In Form and Client Session
- Story FTE-072: Stripe Subscriptions, Trial, and Entitlement
- Story FTE-073: Public and Entitled Route Split
- Story FTE-074: Retire Cognito Infrastructure

## Requirements & Constraints

- A supported E.164 phone number can request, resend, and verify a short-lived, single-use OTP. Request and verification responses are enumeration-safe; per-phone and per-IP/device limits, cooldowns, attempt bounds, and lockout constrain abuse.
- OTPs are generated cryptographically, stored only through one-way verification, compared in constant time, and never exposed in responses, logs, metrics, or recoverable storage. Delivery telemetry contains outcomes and bounded failure classes, never codes or full phone numbers.
- Successful verification creates or resumes an internal account and issues an owned, signed session token with account identity, expiry, and rotation-ready key handling. Refresh, expiry, explicit revocation, and sign-out must work without redirect loops.
- Authentication and entitlement are independent. The browser cannot assert entitlement, customer, subscription, price, or checkout truth. Every protected API derives access from a valid session plus a trusted server-side entitlement record.
- Public surfaces include landing, legal, phone entry, OTP verification, pricing/paywall, checkout return, and billing recovery. Product data and account-specific APIs require both authentication and entitlement; unauthenticated or unentitled users see an on-site sign-in or paywall rather than third-party navigation.
- Stripe Checkout and Customer Portal sessions are created server-side from owned account and price configuration. Webhooks require raw-body signature verification, immutable event idempotency, and ordering/version guards so duplicate or stale events cannot incorrectly grant or regress access.
- `trialing` and `active` grant access. Cancellation at period end grants through the recorded boundary; other non-eligible states fail closed unless a versioned grace policy explicitly says otherwise. Checkout return parameters alone never grant access.
- Phone and billing identifiers are sensitive data: minimize and encrypt retained values, use least-privilege access, and keep raw values out of partition keys and telemetry. Tests and CI use fake SMS and Stripe adapters without production secrets, messages, or payments.
- Cognito retirement is complete only when its authorizer, pool, clients, domain, scopes, runtime configuration, helpers, preflight assumptions, and shipped source references are gone. The cutover must preserve authentication on every formerly protected route and must not migrate or destroy needed account data.

## Technical Decisions

- The internal account ID is the durable owner key. A phone number is a verified login alias and a Stripe customer ID is a billing alias; neither is a domain primary key.
- API authorization builds one trusted access context from owned-token verification and the current server-side entitlement projection. Product handlers consume that context instead of interpreting browser claims.
- The identity service owns OTP lifecycle, hashed challenge persistence, throttle/idempotency records, signed token issuance, refresh, and revocation. Signing material and digest peppers live in Secrets Manager and support key rotation.
- Persistence follows access-pattern-owned DynamoDB records for identity, phone alias, OTP limits, Stripe customer association, subscription projection, product entitlement, immutable billing events, and versioned legal consent. Raw OTPs and payment details are never stored.
- Billing projection is auditable and replay-safe: verified Stripe events are immutable inputs, duplicates are no-ops, older events cannot regress newer state, and reconciliation can rebuild the projection from Stripe without browser edits.
- SMS and Stripe SDK types remain inside provider adapters. Domain and UI layers use normalized contracts; local and CI environments use deterministic fake seams.
- CloudWatch metrics remain privacy-safe and cover OTP delivery/limits, authentication outcomes, checkout creation, webhook verification and lag, subscription transitions, entitlement denials, and reconciliation. Asynchronous billing work requires retry, dead-letter, alarm, and idempotent replay coverage.
- Epic 12's owned session authority supersedes older planning statements that prescribe Cognito custom challenges or Cognito JWTs. FTE-008 through FTE-012 are obsolete.

## UX & Interaction Patterns

- Phone entry, code entry, resend cooldown, invalid/expired/used code, lockout, provider failure, session expiry, sign-out, paywall, checkout pending, abandonment, and billing recovery are explicit on-origin states.
- A successful sign-in safely restores the intended product destination. Destination validation must prevent open redirects, and public pages must never be hijacked by authentication navigation.
- Browser session persistence in local storage is a deliberate product constraint. Keep tokens short-lived with refresh, maintain a strict CSP, inject no third-party scripts, clear state on sign-out, and treat the token as opaque client-side.
- Authentication and paywall surfaces are responsive and target WCAG 2.1 AA: keyboard access, visible focus, labels and status text independent of color, live-region announcements, reduced-motion support, and practical 44px mobile targets.

## Cross-Story Dependencies

FTE-070 depends on the base platform and establishes the owned identity/session seam. FTE-071 and FTE-072 both depend on FTE-070 and can then deliver client session handling and server-derived billing entitlement. FTE-073 depends on both client session and entitlement behavior to divide public and product routes safely. FTE-074 depends on FTE-070 and FTE-073 and must be the final cutover: owned verification must protect every product route before Cognito resources or scope plumbing are removed.
