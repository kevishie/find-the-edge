---
title: "PRD: FIND THE EDGE"
status: "final"
created: "2026-07-15"
updated: "2026-07-26"
source: "_bmad-output/planning-artifacts/product-brief.md"
---

# PRD: FIND THE EDGE

## 0A. Binding Multi-Sport Product Amendment (2026-07-26)

This amendment supersedes soccer-first platform assumptions in the original PRD while preserving soccer requirements as module requirements. FIND THE EDGE must support MLB, soccer/MLS, tennis, NFL, NCAAF, and later sports through registration rather than core rewrites.

### Platform requirements

**FR-MS-001 — Universal betting domain.** The system represents sports, leagues, seasons, competitions, events, participants, teams, players, venues, markets, selections, sportsbooks, immutable odds, consensus, fair probability/price, EV, confidence, scouts, recommendations, picks, bets, results, closing lines, CLV, ROI, model/strategy versions, freshness, and provider health without sport-specific shared fields.

**FR-MS-002 — Registered sport modules.** Every enabled sport implements the versioned `SportModule` contract and declares metadata, maturity, leagues, participant/event mechanics, market definitions, data needs, scouting categories, methodologies, recommendation/roster/grading rules, prompt/output/validation contracts, and UI terminology.

**FR-MS-003 — Mechanics versus strategy.** Immutable sport mechanics and possible markets are separated from versioned product strategy. Strategy selects approved/prohibited markets, thresholds, target sportsbook, public-fade behavior, confidence policy, and recommendation preferences.

**FR-MS-004 — Generic platform surfaces.** Database keys, API routes, event explorer, sport selector, opportunity views, evaluation storage, and prompt infrastructure use `sportKey` and registered configuration. Shared code contains no sport-specific branching.

**FR-MS-005 — Capability-based providers.** Providers declare capabilities, supported sports/leagues/markets, rate limits, freshness, and quality. No workflow assumes a single vendor covers all sports.

**FR-MS-006 — Versioned reproducibility.** Every scout, recommendation, and pick stores sport module, strategy, model, calculation, input-schema, and prompt-bundle versions plus input provenance.

**FR-MS-007 — Honest maturity.** Module maturity is one of planned, experimental, beta, or production and is displayed to users. Presence in the registry does not imply production readiness.

**FR-MS-008 — Routine extensibility.** Contract tests prove that a test sport can be added through module creation and registration without core-domain, core-pricing, storage-key, or generic-route changes.

### Initial sport scope

- MLB beta strategy: moneyline, starting-pitcher strikeouts, or No Bet; no run lines by default.
- Soccer experimental strategy: To Advance, BTTS, goal totals, team totals, anytime scorer, requested shots-on-target, and selectively priced moneyline.
- Tennis planned: match moneyline; set/game/player markets only when enabled.
- NFL planned: moneyline, spread, totals, and configured player props.
- NCAAF planned: moneyline, spread, totals, with higher uncertainty requirements than NFL.

These declarations describe platform scope, not claims that all modules or data integrations are complete. The first complete vertical slice may use fixture data and the module with the most working infrastructure.

### Acceptance outcomes

1. MLB and soccer register through the same contract.
2. Tennis, NFL, and NCAAF have registered planned specifications.
3. Shared pricing receives generic selections and strategy thresholds.
4. Prompt construction composes shared + sport + strategy + analysis-type sections.
5. No paid API, infrastructure, or AI service is required for local contract and fixture tests.

The remaining original PRD is retained for detailed workflow requirements. References to a fixed Hard Rock target become configurable target-sportsbook requirements; soccer-specific requirements belong to the soccer module.

## 0. Document Purpose

This Product Requirements Document translates the FIND THE EDGE Product Brief into clear, testable requirements for the first deployable private MVP. It is written for product planning, downstream BMAD workflows, architecture, UX, epics, stories, and future automated tests. The Product Brief remains the source of truth for vision and scope; this PRD preserves the soccer-first MVP, Hard Rock Bet Florida focus, Agon-aligned AWS stack, DynamoDB direction, deterministic betting calculations, and unresolved soccer enrichment provider decision.

## 1. Vision

FIND THE EDGE is a private, login-protected sports betting intelligence web application for identifying positive expected value (+EV) opportunities and improving long-term betting process quality. It is not a pick-selling product, a sportsbook clone, or a winner-prediction engine. Its core promise is disciplined decision support: compare Hard Rock Bet Florida odds against the broader market, calculate fair value deterministically, preserve data provenance, and show when the best decision is no bet.

The MVP is built for Kevishie as a single private user. It focuses on soccer first because the betting markets, event cadence, and required scouting context need tight product boundaries before expanding to NFL, NBA, esports, or automated scouting schedules.

The product should feel premium, analytical, and trustworthy without casino aesthetics. It should reward patience, provenance, and closing line value (CLV) over action volume or short-term win rate.

## 2. Scope Thesis

The first deployable version must prove the core loop:

1. Ingest upcoming soccer events and odds from The Odds API.
2. Normalize events, teams, bookmakers, markets, selections, and odds.
3. Compare Hard Rock Bet Florida prices against configurable comparison books.
4. Calculate implied probability, no-vig consensus, fair odds, EV, expected profit, and informational fractional Kelly outside any LLM.
5. Surface qualified active +EV opportunities with freshness, confidence, and disqualification reasons.
6. Let Kevishie manually scout an event and review a structured, provenance-backed report.
7. Track bets, results, ROI, and CLV.

Everything outside that loop is post-MVP unless it is a foundational setting, data model requirement, or extensibility seam needed to avoid rework.

## 3. Target User

### 3.1 Primary User

Kevishie is the initial and only MVP user. He primarily uses Hard Rock Bet in Florida and wants a private soccer-first workflow that helps answer: "Where is the edge right now?"

### 3.2 Jobs To Be Done

- When upcoming soccer matches have active betting markets, Kevishie wants to see the best current +EV opportunities so he can focus attention on decisions worth reviewing.
- When considering a specific match, Kevishie wants a structured scouting report so he can understand context without relying on invented or stale facts.
- When Hard Rock Florida has a price, Kevishie wants to compare it against a no-vig market consensus so he can identify whether the price is favorable.
- When a bet is placed, Kevishie wants to track result, ROI, and CLV so he can judge process quality instead of only win/loss outcome.
- When data is missing, stale, or conflicted, Kevishie wants the system to say so plainly and avoid forcing recommendations.

### 3.3 Non-Users for MVP

- Public registrants.
- Paying subscribers.
- Social followers or picks buyers.
- Multi-user admin teams.
- Sportsbook operators.
- Users seeking certain outcomes or autonomous bankroll management.

## 4. Glossary

- **Active +EV Opportunity** — A Qualified Opportunity that has not expired, is not stale, and remains visible on the Dashboard.
- **American Odds** — Odds expressed as positive or negative American format, such as +120 or -150.
- **Bet Tracker** — The product area for manual bet entry, settlement, ROI, and CLV.
- **Bookmaker** — A sportsbook represented by an odds provider.
- **CLV** — Closing Line Value, the difference between the placed price and the selected closing benchmark.
- **Collection Timestamp** — The timestamp when FIND THE EDGE collected or generated a data point.
- **Comparison Bookmaker** — A configurable Bookmaker used in market consensus calculations.
- **Confidence** — A product score or label describing data completeness, market agreement, freshness, and provenance quality.
- **Dashboard** — The primary surface that answers "Where is the edge right now?"
- **Expected Profit** — Expected monetary return for a stake, calculated deterministically from EV and stake.
- **Expected Value** or **EV** — The estimated edge between offered odds and estimated fair probability, calculated deterministically.
- **Fair Odds** — Odds derived from no-vig estimated fair probability.
- **Freshness** — Whether data is current enough under configured thresholds.
- **Hard Rock Florida** — The target sportsbook context for Hard Rock Bet in Florida.
- **Implied Probability** — Probability derived from odds before removing vig.
- **LLM-Assisted Scouting** — Narrative synthesis or comparison generated only from verified inputs.
- **Market** — A betting market such as Moneyline, Three-Way Moneyline, Spread, Totals, Both Teams to Score, or Team Totals.
- **No-Vig Consensus** — Estimated fair probability after removing vig from contributing Comparison Bookmakers and applying configured weights.
- **Odds Snapshot** — Immutable record of odds, provider metadata, and collection metadata at a point in time.
- **Provider Timestamp** — Timestamp supplied by a provider when available.
- **Qualified Opportunity** — A candidate edge that meets configured thresholds for EV, freshness, contributing books, and data quality.
- **Scouting Report** — Structured event report generated from provider-backed facts, deterministic calculations, and LLM-assisted narrative.
- **Selection** — The specific side or outcome within a Market.
- **Stale Odds** — Odds older than the configured maximum odds age.
- **Verification Status** — Status for a data point: verified, unavailable, inferred, stale, or conflicting.
- **Watchlist** — User-curated list of events prioritized for review and scouting.

## 5. User Journeys

### UJ-1. Kevishie logs in and finds the best current edge.

Kevishie opens FIND THE EDGE from a private device. He logs in, lands on the Dashboard, and sees ranked Active +EV Opportunities. He scans event, kickoff time in Eastern Time, market, selection, Hard Rock odds, fair odds, EV, contributing books, Confidence, and warning badges. The value lands when he can identify whether there is a current opportunity worth reviewing or whether the correct action is no bet.

### UJ-2. Kevishie browses upcoming soccer events.

Kevishie opens Upcoming Events, filters by date, competition, status, and Watchlist, and reviews events discovered through The Odds API. He checks kickoff time in Eastern Time, available Bookmakers, available Markets, and any missing or stale event data. The value lands when he can decide which events deserve scouting attention.

### UJ-3. Kevishie launches a manual scouting report.

Kevishie selects an event and clicks Scout Event. The system prevents duplicate jobs, shows queued and in-progress states, and then marks the Scouting Report complete or failed. If failed, it shows retry guidance. The value lands when Kevishie can open a versioned report with source, timestamp, freshness, and verification metadata.

### UJ-4. Kevishie reviews a completed scouting report.

Kevishie opens a completed Scouting Report and reads sections in the required order from Match Snapshot through Nuke or Pass. He sees unavailable, inferred, stale, or conflicting information marked clearly. The value lands when the report helps him understand match context without pretending unsupported facts are known.

### UJ-5. Kevishie compares Hard Rock odds against the market.

Kevishie opens a Market view for an event and sees Hard Rock Florida odds beside Comparison Bookmaker prices, No-Vig Consensus, Fair Odds, EV, and data freshness. The value lands when he understands why an opportunity qualifies, does not qualify, or needs caution.

### UJ-6. Kevishie adds a qualified opportunity to the Bet Tracker.

Kevishie chooses a Qualified Opportunity and creates a manual Bet Tracker entry. The system pre-fills event, market, selection, odds, recommendation source, and timestamp where available. Kevishie enters stake and notes. The value lands when the bet has enough context to evaluate later.

### UJ-7. Kevishie settles a bet and reviews CLV.

After an event ends, Kevishie updates a Bet Tracker entry to Won, Lost, Push, Void, or Cashed Out. The system calculates payout, profit/loss, ROI, and CLV using the configured benchmark. The value lands when he can separate outcome from process quality.

### UJ-8. Kevishie handles provider outage or stale odds.

Kevishie opens the Dashboard during provider failure or stale data. The system shows provider health, quota status, stale warnings, and suppresses stale opportunities from active ranking. The value lands when the product avoids misleading him and explains what data is unavailable.

### UJ-9. Kevishie reviews an event with no betting edge.

Kevishie opens an event and sees available odds and market analysis, but the system shows no Qualified Opportunity because EV, freshness, Confidence, or contributing-book thresholds are not met. The value lands when "Nuke or Pass" clearly supports passing instead of forcing action.

## 6. MVP Features and Functional Requirements

### 6.1 Authentication and Private Access

**Description:** FIND THE EDGE is private and login-protected for the MVP. Authentication should support secure access for Kevishie while preserving a future path to roles without building a full user administration system.

#### FR-001: Secure login

The user can log in with configured credentials before accessing the application. Realizes UJ-1.

**Consequences:**
- Unauthenticated users cannot access protected application routes.
- Failed login attempts return a non-specific error.
- Successful login creates an authenticated session.

#### FR-002: Logout

The user can explicitly log out from the application.

**Consequences:**
- Logging out invalidates the local session.
- After logout, protected routes require login again.

#### FR-003: Protected routes

All application routes containing events, odds, scouting, dashboard, settings, or bet tracking require authentication.

**Consequences:**
- Direct navigation to a protected route while unauthenticated redirects to login.
- Previously requested route can be restored after login when safe.

#### FR-004: Password reset

The user can initiate and complete a password reset flow.

**Consequences:**
- Password reset does not expose whether a specific email is valid.
- A completed reset allows login with the new password.

#### FR-005: Session expiration

Authenticated sessions expire after a configured inactivity or token lifetime.

**Consequences:**
- Expired sessions require reauthentication.
- Expiration is communicated without losing unsaved manual input when feasible.

#### FR-006: Future role support

The authentication model stores enough user identity and permission context to support future roles without implementing MVP multi-user administration.

**Consequences:**
- MVP can treat Kevishie as the only active user.
- Role concepts are not exposed as admin UI in MVP.

### 6.2 Upcoming Soccer Events

**Description:** The product displays upcoming soccer events that have betting markets, using The Odds API as the initial event discovery source.

#### FR-007: Event discovery from The Odds API

The system ingests upcoming soccer events from The Odds API where betting markets are available. Realizes UJ-2.

**Consequences:**
- Events without any available betting markets may be omitted from MVP event discovery.
- Provider and retrieval metadata are stored with each event ingestion.

#### FR-008: Upcoming events list

The user can view upcoming soccer events in a list or table.

**Consequences:**
- Each event shows teams, competition when available, status, and kickoff time.
- Kickoff time is displayed in Eastern Time by default.

#### FR-009: Event filters

The user can filter upcoming events by date, competition, event status, and Watchlist membership.

**Consequences:**
- Filters can be combined.
- Empty states explain whether no events match filters or no data is available.

#### FR-010: Bookmaker and market coverage

Each event shows available Bookmaker and Market coverage.

**Consequences:**
- Coverage distinguishes Hard Rock Florida from Comparison Bookmakers.
- Missing Market coverage is shown as unavailable, not inferred.

#### FR-011: Missing and stale event data indicators

The event list and event detail view show missing or stale event data.

**Consequences:**
- Stale indicators use configured freshness thresholds.
- Missing data never displays placeholder facts as if verified.

### 6.3 Odds Ingestion and Snapshots

**Description:** The product ingests odds from The Odds API, stores immutable Odds Snapshots, and tracks provider health, request usage, and staleness.

#### FR-012: Odds ingestion from The Odds API

The system retrieves odds from The Odds API for enabled soccer competitions and Markets.

**Consequences:**
- Retrieval stores provider response metadata where available.
- Retrieval failures are recorded for provider health reporting.

#### FR-013: Hard Rock Florida odds

The system stores and displays Hard Rock Florida odds when The Odds API provides them.

**Consequences:**
- Hard Rock Florida availability is explicit per Event, Market, and Selection.
- Missing Hard Rock Florida odds disqualify opportunities that require Hard Rock comparison.

#### FR-014: Configurable Comparison Bookmakers

The user can configure which Comparison Bookmakers contribute to consensus.

**Consequences:**
- Disabled Bookmakers do not contribute to No-Vig Consensus.
- Configuration changes affect future calculations and are auditable by timestamp.

#### FR-015: Immutable Odds Snapshots

Each odds retrieval creates immutable Odds Snapshots.

**Consequences:**
- Stored snapshots are append-only from the product perspective.
- Later odds changes create new snapshots rather than mutating prior snapshots.

#### FR-016: Provider and retrieval timestamps

Odds Snapshots store Provider Timestamp when available and Collection Timestamp for every retrieval.

**Consequences:**
- The UI can distinguish provider-reported age from collection age.
- Missing Provider Timestamp is marked unavailable.

#### FR-017: Stale odds detection

The system marks odds as stale when they exceed the configured maximum odds age.

**Consequences:**
- Stale odds cannot remain Active +EV Opportunities.
- Stale odds may remain visible in history with clear status.

#### FR-018: Suspended and incomplete market handling

The system represents unavailable, suspended, or incomplete Markets without inventing prices.

**Consequences:**
- Suspended Markets are excluded from active qualification.
- Incomplete Markets show disqualification reasons when relevant.

#### FR-019: Provider quota tracking

The system tracks provider quota and request usage for The Odds API.

**Consequences:**
- Dashboard or provider health surfaces quota state.
- Request failures caused by quota are distinguishable from network or provider errors.

### 6.4 Market Normalization and Betting Calculations

**Description:** The product normalizes provider data and performs all betting calculations deterministically outside any LLM.

#### FR-020: Bookmaker normalization

The system maps provider Bookmaker identifiers to internal canonical Bookmakers.

**Consequences:**
- Hard Rock Florida is identified consistently across ingestions.
- Unknown Bookmakers are stored but do not silently contribute to consensus without configuration.

#### FR-021: Event and team normalization

The system maps provider Event and team identifiers to internal canonical Events and teams.

**Consequences:**
- Duplicate provider events are detectable.
- Team names retain provider source metadata where needed for audit.

#### FR-022: Market and selection normalization

The system maps provider Markets and Selections to canonical Markets and Selections.

**Consequences:**
- Supported MVP Markets include Moneyline, Three-Way Moneyline, Spread, Totals, Both Teams to Score, and Team Totals when available.
- Unsupported Markets do not appear as MVP opportunities.

#### FR-023: Odds format conversion

The system converts American Odds and decimal odds deterministically.

**Consequences:**
- Conversion results are testable against known examples.
- Invalid or missing odds are rejected from calculation.

#### FR-024: Implied probability calculation

The system calculates Implied Probability from odds deterministically.

**Consequences:**
- Positive and negative American Odds are handled correctly.
- Calculations are independent of LLM output.

#### FR-025: Two-way no-vig calculation

The system calculates two-way No-Vig Consensus probability for two-outcome Markets.

**Consequences:**
- Both sides must have sufficient contributing prices.
- Vig removal is deterministic and testable.

#### FR-026: Three-way no-vig calculation

The system calculates three-way No-Vig Consensus probability for three-outcome Markets.

**Consequences:**
- Home, draw, and away selections must be represented when required.
- Missing selections disqualify the market from three-way consensus.

#### FR-027: Weighted market consensus

The system applies configurable Bookmaker weights to contributing prices.

**Consequences:**
- Bookmaker weights can be configured in Settings.
- Zero-weight Bookmakers do not affect consensus.

#### FR-028: Fair odds calculation

The system converts estimated fair probability to Fair Odds.

**Consequences:**
- Fair Odds can be displayed in American and decimal formats.
- Calculation output is reproducible from stored inputs.

#### FR-029: EV and expected profit calculation

The system calculates Expected Value and Expected Profit for a stake.

**Consequences:**
- EV calculation uses offered Hard Rock Florida odds and estimated fair probability.
- Expected Profit requires a stake and never substitutes for certain profit.

#### FR-030: Fractional Kelly informational calculation

The system calculates fractional Kelly as informational only when sufficient inputs exist.

**Consequences:**
- Fractional Kelly output is labeled informational.
- Fractional Kelly does not create autonomous bet sizing or bankroll management.

### 6.5 +EV Detection and Qualification

**Description:** The system compares Hard Rock Florida prices against configurable No-Vig Consensus and ranks Qualified Opportunities only when thresholds and data-quality rules are met.

#### FR-031: Minimum EV threshold

The system qualifies opportunities only when EV meets or exceeds the configured minimum EV threshold.

**Consequences:**
- Opportunities below threshold are disqualified with a reason.
- Threshold changes apply to future qualification runs.

#### FR-032: Minimum contributing books

The system qualifies opportunities only when the configured minimum number of Comparison Bookmakers contributes valid prices.

**Consequences:**
- Markets with too few books are disqualified.
- The contributing book count is visible to the user.

#### FR-033: Maximum odds age

The system qualifies opportunities only when Hard Rock Florida odds and contributing Comparison Bookmaker odds are within the configured maximum odds age.

**Consequences:**
- Stale odds are disqualified.
- Active opportunities expire when they become stale.

#### FR-034: Outlier handling

The system flags or excludes outlier prices according to configured outlier rules.

**Consequences:**
- Outlier handling behavior is visible in opportunity details.
- Outlier exclusion is deterministic and auditable.

#### FR-035: Market disagreement warnings

The system warns when contributing books materially disagree beyond configured thresholds.

**Consequences:**
- Market disagreement can reduce Confidence.
- Warning badges do not invent reasons such as sharp action or public action.

#### FR-036: Qualification and disqualification reasons

Every candidate opportunity records qualification or disqualification reasons.

**Consequences:**
- The user can see why an opportunity appears or does not appear.
- Missing data produces explicit disqualification reasons.

#### FR-037: Opportunity ranking

The Dashboard ranks Active +EV Opportunities by configured ranking logic using EV, Confidence, freshness, and other MVP signals.

**Consequences:**
- Ranking inputs are visible enough for user trust.
- Stale opportunities are removed from active ranking.

#### FR-038: Restricted promotional language

The product must not label any opportunity with promotional certainty, must-play, no-risk, or equivalent language.

**Consequences:**
- UI copy and report copy avoid prohibited promotional language.
- Opportunities are framed as estimates based on available data.

### 6.6 Dashboard

**Description:** The Dashboard answers "Where is the edge right now?" with ranked Active +EV Opportunities, operational context, and recent activity.

#### FR-039: Ranked active opportunities

The Dashboard displays ranked Active +EV Opportunities. Realizes UJ-1 and UJ-9.

**Consequences:**
- Each row includes Event, Competition, kickoff time, Market, Selection, Hard Rock odds, best comparison odds, Consensus Fair Odds, Hard Rock Implied Probability, estimated fair probability, estimated EV, contributing book count, Confidence, Data Freshness, and warning badges.
- No active opportunities state explains why nothing qualifies when known.

#### FR-040: Recently completed scouting reports

The Dashboard displays recently completed Scouting Reports.

**Consequences:**
- Each item links to the report version.
- Failed or stale reports are not presented as completed reports.

#### FR-041: Upcoming watched events

The Dashboard displays upcoming Watchlist events.

**Consequences:**
- Watched events can be prioritized for manual scouting.
- Changes since last visit are indicated when available.

#### FR-042: Recent line movement

The Dashboard displays recent significant line movement.

**Consequences:**
- Movement is shown in American Odds and Implied Probability terms.
- The product does not claim sharp action, public action, or steam without verified supporting data.

#### FR-043: Provider health and quota status

The Dashboard displays provider health and quota status.

**Consequences:**
- Provider outage, quota, and stale-data states are visible.
- Provider failure suppresses misleading active recommendations.

### 6.7 Manual Scouting Jobs

**Description:** The user can manually launch a Scouting Report for an Event and track job status through completion or failure.

#### FR-044: Scout Event action

The user can launch Scout Event from eligible Event surfaces. Realizes UJ-3.

**Consequences:**
- Scout Event is disabled or warns when required data is unavailable.
- Scout Event creates a traceable scouting job.

#### FR-045: Scouting job states

Scouting jobs show queued, in-progress, completed, and failed states.

**Consequences:**
- Status is visible from the Event and report surfaces.
- Failed jobs preserve error context suitable for retry or support.

#### FR-046: Retry behavior

The user can retry a failed scouting job when the failure is retryable.

**Consequences:**
- Retry creates a new attempt linked to the same Event.
- Non-retryable failures explain what must change.

#### FR-047: Duplicate job prevention

The system prevents duplicate in-progress scouting jobs for the same Event and equivalent inputs.

**Consequences:**
- Repeated clicks do not create duplicate jobs.
- The user is directed to the existing job.

#### FR-048: Report versioning

Each completed scouting job creates a new Scouting Report version.

**Consequences:**
- Historical versions remain viewable.
- New versions can reference changes from previous versions.

### 6.8 Structured Soccer Scouting Report

**Description:** Scouting Reports use a fixed section order and strict provenance rules. LLM-assisted narrative may summarize verified inputs but cannot invent facts or independently calculate betting metrics.

#### FR-049: Required report section order

Each Scouting Report contains sections in this exact order: Match Snapshot, Venue & Weather, Team Scouting, Tactical Matchup, Player Matchups, X-Factor / Cinderella Check, Betting Market Analysis, Line Movement, Advanced Metrics, Historical Trends, Market Edge, Risk Assessment, Final Plays, Nuke or Pass. Realizes UJ-4.

**Consequences:**
- Missing sections are represented with unavailable status rather than omitted.
- Section order is stable across report versions.

#### FR-050: Factual data provenance

Each factual data point supports source provider or URL, Provider Timestamp when available, Collection Timestamp, Verification Status, Freshness, Confidence, and unavailable status.

**Consequences:**
- Unsupported facts cannot be presented as verified.
- The report can be audited after generation.

#### FR-051: No invented sports facts

The system must not invent injuries, suspensions, lineups, weather, venues, odds, statistical data, or betting-market movement.

**Consequences:**
- Unverified information is marked unavailable, inferred, stale, or conflicting.
- LLM-assisted text must be grounded in available data points.

#### FR-052: Scouting responsibility boundaries

The report distinguishes deterministic calculations, provider-backed facts, and LLM-assisted narrative.

**Consequences:**
- Odds conversions, Implied Probability, No-Vig Consensus, Fair Odds, EV, Kelly sizing, and CLV are never calculated by an LLM.
- The LLM may summarize, explain, compare, identify tactical themes, and generate structured narrative from verified inputs.

#### FR-053: Report storage metadata

Each report version stores generation time, associated Odds Snapshot, provider data used, model version, prompt version, and changes from previous report when available.

**Consequences:**
- The user can view historical versions.
- Report provenance remains available after underlying provider data changes.

### 6.9 Odds History and Movement

**Description:** The product preserves Odds Snapshots and shows how lines changed over time without unsupported causal claims.

#### FR-054: Odds history view

The user can view opening price when available, current price, historical snapshots, and timestamped movement for an Event, Market, and Selection.

**Consequences:**
- Missing opening price is marked unavailable.
- History is derived from stored Odds Snapshots.

#### FR-055: Movement calculations

The system shows movement in American Odds and Implied Probability terms.

**Consequences:**
- Calculations are deterministic.
- Stale gaps are identified when snapshot intervals exceed configured thresholds.

#### FR-056: Significant movement indicators

The system flags significant movement based on configured thresholds.

**Consequences:**
- Suspended Markets are labeled separately from price movement.
- The product does not claim sharp action, public action, or steam unless verified data supports that claim.

### 6.10 Watchlist

**Description:** The Watchlist lets Kevishie prioritize events for review and scouting.

#### FR-057: Add and remove Watchlist events

The user can add an Event to the Watchlist and remove it later. Realizes UJ-2.

**Consequences:**
- Watchlist state is persisted.
- Removing an Event does not delete event or odds history.

#### FR-058: View watched events

The user can view watched Events from Dashboard and event filters.

**Consequences:**
- Watched Events can be prioritized for scouting.
- Empty Watchlist state is clear.

#### FR-059: Changes since last visit

The system indicates changes to watched Events since the user's last visit when available.

**Consequences:**
- Changes can include odds movement, market availability, scouting status, or freshness changes.
- Unknown prior state is handled without invented change claims.

### 6.11 Bet Tracker

**Description:** The MVP supports manual bet entry, settlement, and process-quality tracking.

#### FR-060: Manual bet entry

The user can manually create a Bet Tracker entry. Realizes UJ-6.

**Consequences:**
- Fields include Sportsbook, Event, Market, Selection, Odds, Stake, Placement Timestamp, Recommendation Source, Notes, Status, Payout, and Closing Odds.
- Entries can be created from a Qualified Opportunity or manually.

#### FR-061: Bet statuses

Each Bet Tracker entry supports Open, Won, Lost, Push, Void, and Cashed Out statuses.

**Consequences:**
- Status changes are persisted.
- Settlement calculations update when status changes.

#### FR-062: Profit, loss, and ROI calculation

The system calculates profit/loss and ROI for settled bets.

**Consequences:**
- Push and Void outcomes calculate zero profit/loss unless fees or cash-out rules are explicitly entered.
- ROI is not treated as the primary product success metric.

#### FR-063: CLV calculation

The system calculates CLV using the configured CLV benchmark and Closing Odds.

**Consequences:**
- Missing Closing Odds marks CLV unavailable.
- CLV remains visible alongside outcome.

#### FR-064: Performance reporting

The system reports Total Profit, ROI, Win Rate, Average Odds, Average Estimated EV, CLV, performance by Market, performance by Competition, performance by Confidence bucket, and recommended bets versus manually entered bets.

**Consequences:**
- CLV and ROI are emphasized over short-term Win Rate.
- Reports handle small sample sizes with cautionary context.

### 6.12 Settings

**Description:** Settings control provider, market, consensus, freshness, and display behavior. Automatic scouting preferences can be captured for future use without implementing scheduled scouting in MVP.

#### FR-065: Sportsbook and market settings

The user can configure target sportsbook, Comparison Bookmakers, enabled competitions, and enabled Markets.

**Consequences:**
- Hard Rock Florida is the MVP target sportsbook.
- Disabled Markets do not appear as MVP opportunities.

#### FR-066: Consensus and qualification settings

The user can configure Bookmaker weights, minimum EV, maximum odds age, minimum contributing books, and fractional Kelly percentage.

**Consequences:**
- Settings affect qualification and calculations.
- Fractional Kelly percentage is informational only.

#### FR-067: Display and future automation settings

The user can configure display timezone and automatic scouting preferences for future use.

**Consequences:**
- Eastern Time is the default display timezone.
- Automatic scouting preferences do not require MVP scheduled scouting behavior.

## 7. Non-Functional Requirements

#### NFR-001: Security

The MVP must protect private routes, credentials, tokens, and provider secrets using the selected authentication and secret-management services.

#### NFR-002: Privacy

The MVP must treat all user data, bet history, scouting reports, and settings as private by default.

#### NFR-003: Reliability

Core read surfaces should degrade gracefully when providers are unavailable by showing cached historical data only with clear freshness status.

#### NFR-004: Performance

Dashboard and event list interactions should feel responsive for private MVP scale and avoid blocking the UI on long-running scouting jobs.

#### NFR-005: Accessibility

The web application should target WCAG 2.1 AA patterns for forms, tables, navigation, contrast, keyboard access, and status messaging.

#### NFR-006: Observability

The system must emit logs and operational signals for provider requests, quota usage, ingestion failures, scouting job status, and calculation errors.

#### NFR-007: Data freshness

All odds, event, and scouting facts must expose freshness status derived from Provider Timestamp and/or Collection Timestamp.

#### NFR-008: Data integrity

Odds Snapshots and Scouting Report versions must preserve immutable historical context and avoid silent mutation of audit-relevant records.

#### NFR-009: Idempotency

Ingestion, scouting job creation, retry, and duplicate-click paths must avoid duplicate active work for equivalent inputs.

#### NFR-010: Scalability

The MVP should use the Agon-aligned AWS serverless direction and DynamoDB-compatible access patterns so future users, sports, and providers can be added without replacing the persistence model.

#### NFR-011: Maintainability

Provider integrations, calculation logic, and LLM-assisted scouting prompts must be modular enough to test and change independently.

#### NFR-012: Provider failure handling

Provider errors, quota exhaustion, stale data, and partial responses must be visible to the user and must not produce active misleading recommendations.

#### NFR-013: Cost awareness

Provider requests, scheduled or manual scouting, and AWS usage must be designed with quota and cost visibility appropriate for a private MVP.

#### NFR-014: Auditability

The system must preserve enough source, timestamp, version, and calculation input data to reconstruct why an opportunity qualified or why a report said what it said.

## 8. Acceptance Criteria by Major Capability

### AC-001: Authentication

Given an unauthenticated visitor, when they navigate to Dashboard, then they are redirected to login.

Given Kevishie has a valid session, when he opens Dashboard, then protected data is visible.

Given Kevishie logs out, when he attempts to revisit a protected route, then login is required.

### AC-002: Upcoming Soccer Events

Given The Odds API returns upcoming soccer events with markets, when ingestion completes, then events appear with Eastern Time kickoff, competition when available, status, Bookmaker coverage, Market coverage, and freshness indicators.

Given no event matches the selected filters, when Kevishie views Upcoming Events, then the empty state distinguishes no matches from provider failure.

### AC-003: Odds Ingestion

Given The Odds API returns Hard Rock Florida and Comparison Bookmaker prices, when odds are ingested, then immutable Odds Snapshots are stored with Provider Timestamp when available and Collection Timestamp always.

Given odds are older than maximum odds age, when qualification runs, then those odds are marked stale and cannot remain active.

### AC-004: Betting Calculations

Given known American Odds examples, when conversion and Implied Probability calculations run, then outputs match deterministic expected values.

Given a complete two-way or three-way Market with enough contributing books, when no-vig calculation runs, then No-Vig Consensus and Fair Odds are reproducible from stored inputs.

Given an LLM-assisted report is generated, when betting metrics appear, then those metrics come from deterministic calculation outputs, not LLM computation.

### AC-005: +EV Detection

Given Hard Rock Florida odds beat the configured No-Vig Consensus and all thresholds are met, when qualification runs, then the opportunity is marked qualified with EV, Confidence, contributing books, and reasons.

Given EV, freshness, contributing books, or data quality thresholds are not met, when qualification runs, then the candidate is disqualified with explicit reasons.

### AC-006: Dashboard

Given at least one Active +EV Opportunity exists, when Kevishie opens Dashboard, then ranked opportunities show all required fields and warning badges.

Given no opportunities qualify, when Kevishie opens Dashboard, then the product explains no qualified edge exists instead of forcing a recommendation.

Given provider quota or health is degraded, when Kevishie opens Dashboard, then health and quota status are visible.

### AC-007: Manual Scouting

Given an eligible Event, when Kevishie clicks Scout Event, then a scouting job is created and shows queued or in-progress status.

Given a scouting job is already active for equivalent inputs, when Kevishie clicks Scout Event again, then the system prevents duplicate work and links to the active job.

Given a retryable failure, when Kevishie retries, then a new attempt is created and linked to the same Event.

### AC-008: Structured Scouting Report

Given a Scouting Report completes, when Kevishie opens it, then all fourteen required sections appear in exact order.

Given a required factual data point is unavailable or unverified, when the report renders, then it is marked unavailable, inferred, stale, or conflicting rather than invented.

Given a report has prior versions, when Kevishie views history, then earlier versions remain accessible.

### AC-009: Odds History and Movement

Given multiple Odds Snapshots exist for a Market, when Kevishie opens odds history, then opening price when available, current price, timestamped movement, stale gaps, and suspended market status are visible.

Given significant movement occurs, when movement indicators render, then they describe price movement only and do not claim sharp action, public action, or steam without verified support.

### AC-010: Watchlist

Given Kevishie adds an Event to the Watchlist, when he filters by Watchlist or opens Dashboard, then the Event appears in watched contexts.

Given watched Event data changes since last visit, when available, then the system displays change indicators without inventing unknown prior state.

### AC-011: Bet Tracker and Performance

Given Kevishie creates a manual Bet Tracker entry, when he saves it, then all required fields persist.

Given a bet is settled, when status, payout, and Closing Odds are present, then profit/loss, ROI, and CLV calculate deterministically.

Given performance reports render, when sample sizes are small, then reports avoid presenting betting profit alone as product success.

### AC-012: Settings

Given Kevishie updates minimum EV, maximum odds age, or contributing-book settings, when qualification runs next, then new settings affect future results.

Given automatic scouting preferences are configured, when the MVP runs, then those settings are stored for future use but do not imply scheduled scouting is active.

## 9. MVP Scope

### 9.1 Required for First Deployable MVP

- Secure private login, logout, password reset, protected routes, and session expiration.
- Single-user private access for Kevishie.
- Soccer-first event discovery through The Odds API.
- Upcoming Events list with filters and Watchlist.
- Odds ingestion for Hard Rock Florida and configurable Comparison Bookmakers.
- Immutable Odds Snapshots with provider and retrieval timestamps.
- Market normalization for Moneyline, Three-Way Moneyline, Spread, Totals, Both Teams to Score, and Team Totals when available.
- Deterministic odds conversion, Implied Probability, No-Vig Consensus, Fair Odds, EV, Expected Profit, and informational Fractional Kelly.
- +EV qualification, disqualification, and ranking.
- Dashboard answering "Where is the edge right now?"
- Manual Scout Event flow with job states, retry, duplicate prevention, report versioning, and report provenance.
- Structured soccer Scouting Report with the required fourteen sections.
- Odds history and movement display.
- Manual Bet Tracker, settlement, ROI, and CLV.
- Settings for target sportsbook, Comparison Bookmakers, weights, thresholds, timezone, enabled competitions, enabled Markets, and future automatic scouting preferences.
- Provider health and quota visibility.

### 9.2 Post-MVP

- Automatic scouting schedules.
- NFL.
- NBA.
- Esports.
- Live betting.
- Player props.
- Corners.
- Cards.
- Notifications.
- Mobile application.
- Multi-user subscriptions.
- Full multi-user administration UI.
- Machine-learning probability models.
- Automatic bet settlement.
- Direct sportsbook integrations for placing bets.
- Social publishing.
- Automated FIND THE EDGE graphics.

## 10. Non-Goals

- Placing bets directly through sportsbooks.
- Guaranteeing profitable outcomes.
- Using promotional certainty, must-play, no-risk, or equivalent language.
- Copying sportsbook interfaces.
- Treating LLM output as verified data.
- Supporting every sport or market at launch.
- Public registration.
- Selling picks.
- Fully autonomous bankroll management.
- Replacing DynamoDB with PostgreSQL.
- Creating architecture diagrams or app scaffolding in this PRD task.

## 11. Technology and Data Direction

The implementation direction remains aligned with the Product Brief and the existing Agon platform: TypeScript, React, Vite, TanStack Router, TanStack Query, TanStack Table, Tailwind CSS, shadcn/ui, React Hook Form, Zod, AWS Lambda, API Gateway HTTP API, DynamoDB, DynamoDB Streams, SQS, EventBridge Scheduler, Step Functions, S3, CloudFront, Cognito, Secrets Manager, CloudWatch, AWS CDK, pnpm workspaces, and Turborepo.

DynamoDB is the persistence direction. Provider abstractions are required. The Odds API is the initial provider for sportsbook markets, odds, and event discovery. A separate soccer enrichment provider is required for fixtures, teams, venues, lineups, injuries, and statistics, but the exact provider remains unresolved.

## 12. Open Decisions

| ID | Decision | Why It Matters | Resolve By | Owner | Blocks MVP Development |
| --- | --- | --- | --- | --- | --- |
| OD-001 | Soccer enrichment provider | Determines fixtures, teams, venues, lineups, injuries, and statistics coverage. | Before enriched scouting implementation | Product/Engineering | Partially |
| OD-002 | Initial soccer leagues and competitions | Controls event scope, provider cost, and testing fixtures. | Before event ingestion configuration | Product | Yes |
| OD-003 | Comparison sportsbook set | Defines consensus quality and coverage. | Before +EV qualification tuning | Product | Yes |
| OD-004 | Bookmaker weights | Affects No-Vig Consensus and Fair Odds. | Before production qualification | Product | Yes |
| OD-005 | Minimum EV threshold | Determines what qualifies as an edge. | Before Dashboard launch | Product | Yes |
| OD-006 | Odds freshness threshold | Prevents stale opportunity exposure. | Before odds qualification | Product/Engineering | Yes |
| OD-007 | Minimum contributing books | Controls consensus reliability. | Before +EV qualification | Product | Yes |
| OD-008 | Outlier handling rules | Prevents bad prices from distorting consensus. | Before +EV qualification | Product/Engineering | Yes |
| OD-009 | CLV benchmark | Determines CLV interpretation. | Before Bet Tracker CLV release | Product | Partially |
| OD-010 | Snapshot retention | Affects storage cost and audit history. | Before production data retention policy | Product/Engineering | Partially |
| OD-011 | Authentication implementation details | Selects exact Cognito/session behavior and password policy. | Before auth implementation | Engineering | Yes |
| OD-012 | Compliance and responsible-gaming language | Reduces risk in betting-related product copy. | Before user-facing launch copy | Product/Legal review if available | Partially |

## 13. Success Metrics

### Primary Metrics

- **SM-001: Event ingestion reliability** — Percentage of scheduled or manual soccer event ingestion runs that complete without provider or normalization failure. Validates FR-007, FR-012, NFR-003.
- **SM-002: Odds freshness** — Percentage of Active +EV Opportunities whose Hard Rock Florida and consensus inputs are within maximum odds age. Validates FR-017, FR-033, NFR-007.
- **SM-003: Calculation correctness** — Automated test pass rate for odds conversion, Implied Probability, no-vig, Fair Odds, EV, Expected Profit, Kelly, ROI, and CLV examples. Validates FR-023 through FR-030, FR-062, FR-063.
- **SM-004: Time to find an opportunity** — Median time from login to identifying the top Active +EV Opportunity or a no-edge state. Validates FR-039, UJ-1.
- **SM-005: Provenance completeness** — Percentage of Scouting Report factual data points with source, timestamp, Verification Status, Freshness, and Confidence. Validates FR-050, NFR-014.
- **SM-006: CLV tracking completeness** — Percentage of settled tracked bets with Closing Odds and CLV status. Validates FR-063.

### Secondary Metrics

- **SM-007: Scouting completion rate** — Percentage of manual scouting jobs that complete successfully or fail with actionable retry status. Validates FR-044 through FR-048.
- **SM-008: Provider quota efficiency** — Useful odds ingestions per provider request and rate of quota-related failures. Validates FR-019, NFR-013.
- **SM-009: User engagement** — Weekly count of events reviewed, scouting reports opened, and bets tracked. Validates UJ-2, UJ-4, UJ-6.
- **SM-010: System error rate** — Rate of unhandled application errors during auth, ingestion, scouting, calculation, and bet tracking workflows. Validates NFR-006, NFR-012.

### Counter-Metrics

- **SM-C001: Betting profit alone** — Do not treat short-term profit as the primary product success metric because it is noisy and can reward poor process over small samples.
- **SM-C002: Number of recommendations** — Do not optimize for more opportunities if doing so lowers freshness, Confidence, or provenance quality.
- **SM-C003: Win rate alone** — Do not optimize for win rate over CLV, ROI, and EV process quality.

## 14. Traceability

| Product Goal | User Journeys | Functional Requirements | Non-Functional Requirements | Acceptance Criteria | Future Epic Candidate |
| --- | --- | --- | --- | --- | --- |
| Private access | UJ-1 | FR-001-FR-006 | NFR-001, NFR-002 | AC-001 | Authentication and access |
| Soccer event discovery | UJ-2 | FR-007-FR-011 | NFR-003, NFR-007, NFR-012 | AC-002 | Soccer events |
| Odds ingestion and snapshots | UJ-5, UJ-8 | FR-012-FR-019 | NFR-006-NFR-009, NFR-012-NFR-014 | AC-003 | Odds ingestion |
| Deterministic calculations | UJ-5, UJ-9 | FR-020-FR-030 | NFR-008, NFR-011, NFR-014 | AC-004 | Market normalization and calculations |
| +EV detection | UJ-1, UJ-5, UJ-9 | FR-031-FR-038 | NFR-007, NFR-012, NFR-014 | AC-005 | Opportunity engine |
| Dashboard | UJ-1, UJ-8, UJ-9 | FR-039-FR-043 | NFR-004, NFR-005, NFR-006 | AC-006 | Edge dashboard |
| Manual scouting | UJ-3, UJ-4 | FR-044-FR-053 | NFR-009, NFR-011, NFR-014 | AC-007, AC-008 | Scouting reports |
| Odds history | UJ-5 | FR-054-FR-056 | NFR-008, NFR-014 | AC-009 | Line movement |
| Watchlist | UJ-2 | FR-057-FR-059 | NFR-004, NFR-008 | AC-010 | Watchlist |
| Bet tracking and performance | UJ-6, UJ-7 | FR-060-FR-064 | NFR-008, NFR-014 | AC-011 | Bet tracker and performance |
| User-configurable thresholds | UJ-1, UJ-5, UJ-9 | FR-065-FR-067 | NFR-011, NFR-013 | AC-012 | Settings |

## 15. Assumptions

- MVP uses Kevishie as the only active user and does not expose public registration.
- The Odds API can provide enough soccer event and odds coverage to support the first MVP.
- Hard Rock Florida odds are available through The Odds API for at least some target soccer Markets.
- Exact threshold values are intentionally deferred to Open Decisions rather than invented in this PRD.
- The soccer enrichment provider is unresolved and may require separate research before enriched scouting sections can be fully implemented.
- Automatic scouting preferences are stored for future use, but scheduled automatic scouting is post-MVP.
- The Agon-aligned AWS and DynamoDB direction remains preferred unless a later architecture workflow identifies a blocking issue.

## 16. Review Notes

- Compared against Product Brief: aligned.
- Scope creep removed: NFL, NBA, esports, live betting, notifications, public registration, direct bet placement, and automatic scouting schedules are post-MVP.
- MVP remains soccer-first: confirmed.
- DynamoDB and Agon-aligned AWS direction: preserved.
- Soccer enrichment provider: unresolved and tracked as OD-001.
- Calculations: deterministic and outside LLM.
- Facts: require provenance, timestamp, freshness, and Verification Status.
- Requirements: globally numbered and testable.
- Application code: not added.

## 17. Recommended Next BMAD Workflow

Run `bmad-architecture` next to define the technical architecture and data model spine for the PRD. After architecture, run `bmad-create-epics-and-stories` to break this PRD into implementation epics and stories.
