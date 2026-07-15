---
title: "Product Brief: FIND THE EDGE"
status: "complete"
created: "2026-07-15"
updated: "2026-07-15"
---

# Product Brief: FIND THE EDGE

## Executive Summary

FIND THE EDGE is a private, login-protected sports betting intelligence web application for identifying positive expected value (+EV) opportunities and improving long-term return on investment. The product is not a pick generator and does not optimize for winner prediction or short-term hit rate. It helps the user compare sportsbook pricing, quantify the edge, track decision quality, and learn from results over time.

The first version is for a single primary user, Kevishie, with a practical focus on Hard Rock Bet in Florida. The product should remain private and focused at launch while keeping the architecture ready for additional users, roles, sports, and providers later.

The north star is disciplined betting intelligence: source-backed sports information, deterministic calculations, explicit uncertainty, and a clear bias toward "no bet" when the data does not support an edge.

## Product Vision

FIND THE EDGE should become a premium sports betting command center that surfaces only qualified, evidence-backed opportunities. It should combine market data, scouting context, odds history, and performance tracking into a single workflow: discover events, scout them, compare prices, identify +EV spots, place only justified bets, and measure whether the process is improving through ROI and closing line value (CLV).

The long-term vision is a private intelligence platform that supports multiple sports and data providers without becoming a casino-like experience or a speculative prediction engine. The product should feel analytical, trustworthy, and sharp.

## Problem Statement

Sports betting workflows are fragmented. A bettor may move between sportsbook apps, odds comparison sites, manual notes, injury reports, lineup news, market movement, and spreadsheets. This makes it hard to know whether a bet is actually +EV, whether the information behind it is fresh, and whether the bettor's process is improving.

For a Florida bettor primarily using Hard Rock Bet, the key question is often not "who will win?" but "is Hard Rock offering a price that is meaningfully better than the market's fair view?" Without reliable odds comparison, no-vig consensus calculations, historical snapshots, and bet-result tracking, decisions can drift toward intuition, stale information, or chasing short-term outcomes.

The cost of the status quo is poor process quality: missed edges, forced bets, untracked assumptions, unclear CLV, and difficulty separating a good bet that lost from a bad bet that happened to win.

## Target User

The initial user is Kevishie, a single private user in Florida who primarily places bets through Hard Rock Bet. Kevishie needs a focused tool for soccer-first betting intelligence that compares Hard Rock Florida odds against other sportsbooks and helps identify qualified +EV opportunities.

The product should support a future path to additional users and roles, but the first version should avoid multi-tenant complexity unless required by foundational architecture choices such as authentication, authorization boundaries, and data ownership.

## User Needs

- See upcoming soccer events with available betting markets.
- Launch a scouting report manually for a selected event.
- Compare Hard Rock Florida odds against a broader sportsbook consensus.
- Calculate implied probability, no-vig consensus probability, fair odds, and expected value deterministically.
- Separate qualified +EV opportunities from weak or unsupported recommendations.
- Understand the source, timestamp, freshness, and verification status of sports information.
- Track odds movement through immutable snapshots.
- Record placed bets, results, ROI, and CLV.
- Review prior scouting reports and decision history.
- Avoid fabricated injuries, lineups, weather, venues, odds, or other changing sports facts.

## Current Workflow and Pain Points

Today, the workflow likely requires multiple tools: sportsbook apps for available lines, odds or market references for comparison, soccer sites for fixtures and team news, manual judgment for edge, and spreadsheets or notes for bet tracking. This creates several pain points:

- Odds comparison is manual and easy to miss, especially across markets and books.
- The difference between a better price and a true +EV opportunity is not always calculated consistently.
- Sports context can become stale quickly, especially for lineups, injuries, venues, weather, and market movement.
- Bet outcomes can over-influence confidence when CLV and expected value are not tracked.
- Manual notes make it hard to audit why a bet was placed.
- The bettor may feel pressure to find action even when the correct decision is no bet.

## Proposed Solution

FIND THE EDGE will provide a secure private web application that organizes the soccer betting workflow around events, scouting reports, odds comparison, +EV detection, and performance tracking.

For each event, the system should store structured data from provider integrations, source metadata, freshness indicators, odds snapshots, and scouting-report history. The user can manually trigger a Scout Event action to gather and organize available context, then review ranked opportunities where Hard Rock Florida odds diverge favorably from the no-vig market consensus.

All betting math should be deterministic and auditable. The LLM may help synthesize scouting reports from source-backed data, but it must not invent facts or perform opaque calculations. When information is missing, stale, unverified, or conflicting, the product should say so clearly and avoid forcing a recommendation.

## MVP Scope

The MVP is soccer-first and private. It should include:

- Secure login.
- Upcoming soccer events.
- The Odds API integration for sportsbook markets, odds, and event discovery where betting markets exist.
- Hard Rock Florida odds support.
- Comparison sportsbook odds.
- Supported markets when available: moneyline, three-way moneyline, spread, totals, both teams to score (BTTS), and team totals.
- Manual Scout Event action.
- Stored structured scouting reports.
- Report history for previously scouted events.
- Implied probability calculations.
- No-vig consensus probability calculations.
- Fair odds calculations.
- Preliminary +EV detection.
- Ranked +EV dashboard.
- Immutable odds snapshots and odds history.
- Basic bet tracking.
- Result, ROI, and CLV tracking.
- Source, timestamp, freshness, and verification status for scouting data.

## Explicit Non-Goals

- Do not scaffold or implement the application during product planning.
- Do not optimize for predicting winners as the primary product promise.
- Do not use language such as guaranteed, lock, or risk-free.
- Do not invent injuries, lineups, weather, venues, odds, statistics, or other changing sports information.
- Do not replace DynamoDB with PostgreSQL.
- Do not prioritize NFL, NBA, or esports in the MVP.
- Do not build a public community, marketplace, picks-selling product, or social betting experience for the MVP.
- Do not overbuild multi-user administration before the private single-user workflow is validated.
- Do not treat an LLM-generated scouting narrative as a substitute for source-backed data and deterministic calculations.

## Differentiators

- +EV-first workflow rather than winner-prediction-first workflow.
- Hard Rock Florida comparison as a first-class use case.
- No-vig consensus and fair-odds calculations built into the core decision loop.
- CLV and ROI tracking to evaluate process quality over time.
- Immutable odds snapshots that preserve what was known when a bet was considered.
- Source-backed sports context with freshness and verification indicators.
- "No bet" as a valid and preferred outcome when edge is insufficient.
- Premium, analytical visual identity that avoids casino aesthetics.

## Technology Direction

The stack should closely resemble the existing Agon platform:

- TypeScript.
- React.
- Vite.
- TanStack Router.
- TanStack Query.
- TanStack Table.
- Tailwind CSS.
- shadcn/ui.
- React Hook Form.
- Zod.
- AWS Lambda.
- API Gateway HTTP API.
- DynamoDB.
- DynamoDB Streams.
- SQS.
- EventBridge Scheduler.
- Step Functions.
- S3.
- CloudFront.
- Cognito.
- Secrets Manager.
- CloudWatch.
- AWS CDK.
- pnpm workspaces.
- Turborepo.

DynamoDB is the intended database direction. The architecture should plan for provider abstractions so that The Odds API, soccer enrichment data, future league-specific providers, weather sources, and esports sources can evolve independently.

## Data Provider Direction

Initial provider planning should separate odds data from soccer enrichment data.

The Odds API should provide sportsbook markets, odds, and discovery of events that have betting markets. A separate soccer data provider should provide fixtures, teams, venues, lineups, injuries, and statistics.

The exact soccer enrichment provider is not finalized. This must remain an open product and technical decision until options are evaluated for coverage, accuracy, latency, licensing, cost, and integration fit.

## Product Principles

- Positive expected value over win percentage.
- Closing line value over short-term results.
- Accuracy over forced recommendations.
- No bet when there is insufficient edge.
- Deterministic calculations outside the LLM.
- Source-backed sports information.
- Clear uncertainty and stale-data warnings.
- No guaranteed, lock, or risk-free language.
- Premium FIND THE EDGE visual identity without casino aesthetics.

## Success Metrics

- Percentage of qualified opportunities with complete source, timestamp, freshness, and verification metadata.
- Number of manually scouted soccer events reviewed per week.
- Percentage of surfaced opportunities that include complete implied probability, no-vig consensus probability, fair odds, and EV calculations.
- Bet tracking completeness: placed bets with stake, odds, market, timestamp, result, ROI, and CLV.
- CLV trend over time by market, league, and sportsbook.
- ROI over a meaningful sample size, reported with caution against over-reading small samples.
- Reduction in manually maintained spreadsheets or notes for the covered workflow.
- Frequency of "no bet" outcomes when edge or data quality is insufficient.

## Risks

- Sports data licensing, coverage, and freshness may constrain provider choices.
- Hard Rock Florida odds availability may be limited by provider coverage or market-specific behavior.
- Odds and scouting data can become stale quickly, creating risk of misleading recommendations.
- +EV detection can be misunderstood if users over-trust preliminary calculations on thin or incomplete markets.
- Soccer market structures vary by league and sportsbook, especially for three-way moneyline, BTTS, and team totals.
- DynamoDB modeling decisions need care because odds history, snapshots, events, reports, and bet tracking have different access patterns.
- LLM-generated narratives could introduce hallucination risk unless strictly grounded in verified source data.
- Early ROI may be noisy and should not be treated as proof of product quality without sufficient sample size.

## Assumptions

- The MVP remains a private single-user application for Kevishie.
- Hard Rock Bet Florida is the primary sportsbook to compare against the market.
- The Odds API can support enough sportsbook and market coverage for the initial soccer workflow.
- A separate soccer enrichment provider will be selected before implementation of enriched scouting reports.
- The Agon-aligned AWS serverless stack is preferred for implementation continuity.
- DynamoDB is the chosen persistence layer.
- The product can begin with manual Scout Event actions before broader automation is added.
- Deterministic EV, fair odds, and no-vig calculations can be specified and tested independently of any LLM-assisted scouting summary.

## Open Questions

- Which soccer enrichment provider should be used for fixtures, teams, venues, lineups, injuries, and statistics?
- Which soccer leagues and competitions should be included in the MVP?
- Which comparison sportsbooks should define the initial no-vig consensus set?
- How should the product handle low-liquidity books, stale books, outlier odds, and missing markets in consensus calculations?
- What exact EV threshold qualifies an opportunity for the dashboard?
- What confidence or freshness thresholds should suppress a recommendation?
- How should the MVP represent stake sizing, if at all?
- How will placed-bet results be entered: manual entry only, sportsbook export, or future integration?
- Which CLV benchmark should be used for each market: closing consensus, Hard Rock closing line, or another reference?
- What retention policy is required for immutable odds snapshots?
- What authentication posture is sufficient for private single-user use while preserving future multi-user expansion?
- What parts of scouting should be LLM-assisted versus strictly structured and deterministic?
- What compliance, responsible-gaming, or jurisdiction-specific language should appear in the product?

## Future Expansion

After the soccer MVP, FIND THE EDGE can expand to NFL, NBA, selected esports, additional sportsbook coverage, weather providers, deeper automated scouting, richer trend analysis, and role-based access for additional users. Future versions may support automated scheduled scouting, alerts for qualified opportunities, advanced bankroll analytics, richer provider reconciliation, and sport-specific models.

Expansion should happen only after the MVP proves that the core loop works: discover events, scout selectively, compare odds, identify +EV, track bets, measure CLV and ROI, and learn from outcomes.

## Recommended Next BMAD Workflow

Run the BMAD PRD workflow next: `bmad-prd`.

The PRD should convert this brief into product requirements, user journeys, MVP boundaries, data-quality rules, calculation requirements, and acceptance criteria. It should preserve the soccer-first MVP, the Agon-aligned AWS and DynamoDB direction, and the unresolved soccer enrichment provider decision.
