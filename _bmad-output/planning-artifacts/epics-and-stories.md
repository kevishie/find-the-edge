---
title: "Epics and Stories: FIND THE EDGE"
status: "initial"
created: "2026-07-15"
updated: "2026-08-04"
workflow: "bmad-create-epics-and-stories"
stepsCompleted:
  - "validate-prerequisites"
  - "design-epics"
  - "create-stories"
sources:
  - "README.md"
  - "_bmad-output/planning-artifacts/product-brief.md"
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/architecture.md"
  - "_bmad-output/planning-artifacts/ux-design-specification.md"
  - "design/claude/Find The Edge.dc.html"
  - "design/claude/support.js"
  - "design/claude/README.md"
---

# Epics and Stories: FIND THE EDGE

## 0. Multi-Sport Rebaseline (2026-07-26)

This rebaseline is authoritative over soccer-first scope guardrails below. Existing stories remain useful but must consume generic domain, sport registry, strategy, provider-capability, and prompt-composition foundations.

### Epic 0: Multi-Sport Platform Foundation

#### FTE-SPORT-001: Sport-Agnostic Domain and Registry

- Outcome: New sports register without core-domain or pricing edits.
- In scope: universal IDs/entities, evidence/version references, `SportModule` contract, registry, maturity states, generic markets.
- Dependencies: FTE-001.
- Acceptance criteria: MLB and soccer register; a test sport registers without core edits; shared event has no sport-specific fields; registry rejects duplicates.
- Validation: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Status: done.

#### FTE-SPORT-002: Versioned Strategy Configuration

- Outcome: Product policy is separate from sport mechanics.
- In scope: strategy schema, validation, MLB v2.1 strategy, soccer draft strategy, planned sport strategies.
- Dependencies: FTE-SPORT-001.
- Acceptance criteria: approved/prohibited markets validate against module capabilities; thresholds and public-fade policy are versioned; invalid configurations fail explicitly.
- Validation: root quality gates and schema/unit tests.
- Status: done.

#### FTE-SPORT-003: Capability-Based Provider Ports

- Outcome: Providers can cover different sports and data capabilities.
- In scope: eight provider interfaces and capability/coverage metadata.
- Dependencies: FTE-SPORT-001.
- Acceptance criteria: no universal provider assumption; support resolution is testable by sport/league/market/capability.
- Validation: root quality gates and contract tests.
- Status: done.

#### FTE-SPORT-004: Composable Prompt and Scout Versioning

- Outcome: Scouts use shared + sport + strategy + analysis prompt sections and store exact versions.
- Dependencies: FTE-SPORT-001, FTE-SPORT-002.
- Acceptance criteria: deterministic composition order; missing sections fail; bundle version and model version are present; prompts cannot own pricing.
- Validation: root quality gates and prompt snapshot tests.
- Status: done.

#### FTE-SPORT-005: Generic Sport Selector and Event Explorer

- Outcome: The web shell discovers registered sports and uses module terminology without sport branching.
- Dependencies: FTE-002, FTE-SPORT-001.
- Acceptance criteria: maturity visible; generic routes include sport key; module switch requires no shared UI edit.
- Validation: root quality gates and UI tests.
- Status: done.

#### FTE-SPORT-006: MLB and Soccer Module Vertical Slice

- Outcome: Fixture data runs through registered modules, strategy, generic pricing, and generic UI.
- Dependencies: FTE-SPORT-001 through FTE-SPORT-005.
- Acceptance criteria: both modules produce auditable Play/No Bet evaluations; stored/displayed results include module and strategy version.
- Validation: root gates, integration tests, and browser smoke.
- Status: done.

#### FTE-SPORT-007: Weighted Consensus States

- Outcome: Generic pricing produces an auditable weighted no-vig consensus.
- Dependencies: FTE-SPORT-002.
- Acceptance criteria: two-way and three-way markets are supported; the offered sportsbook is excluded; stale, suspended, sparse, and outlier states are explicit.
- Validation: root quality gates and deterministic unit tests.
- Status: done.

Old sport-catalog, ingestion, scouting, and opportunity stories must depend on the applicable FTE-SPORT stories before implementation. Product/provider approval gates remain in force.

### Epic 0A: Multi-Sport Feed and Result Spine

This is an early platform epic. It establishes reusable acquisition and truth data before broad UI work or sport-by-sport prediction tuning.

#### FTE-DATA-001: Feed Coverage Registry and League Allowlist

- Epic: Multi-sport feed and result spine.
- Outcome: Each enabled league resolves to explicit schedule, odds, and results capabilities instead of assuming one universal feed.
- Context: MLB, tennis, NFL, NBA, MLS, international soccer, and future sports have different provider coverage and identifiers.
- In scope: league/competition registry, provider capability resolution, allowlists, maturity, refresh cadence, market coverage, unsupported-state reasons, quota estimates.
- Out of scope: Paid-provider purchase, production polling, prediction logic.
- Dependencies: FTE-SPORT-001, FTE-SPORT-003.
- Acceptance criteria: MLB and MLS resolve schedule/odds/results capabilities; tennis, NFL, NBA, and international soccer can be planned or enabled explicitly; missing coverage fails with a reason; adding a league requires registration rather than orchestrator edits.
- Required automated tests: Registry, duplicate-key, unsupported-capability, and test-league contract tests.
- Likely files/packages affected: `packages/domain`, `packages/providers`, `packages/config`.
- Observability: Coverage resolution logs include sport, league, capability, provider, and reason.
- Security: Provider secrets and commercial terms are excluded from registry output.
- Data migration/backfill impact: Existing sport/league configuration requires a one-time mapping.
- Definition of done: A versioned coverage report can be generated without calling a paid API.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-DATA-002: Checkpointed Upcoming-Event Ingestion Orchestrator

- Epic: Multi-sport feed and result spine.
- Outcome: Enabled feeds import and normalize upcoming games through one retry-safe workflow.
- Context: Event import must begin early so odds history and evaluation datasets accumulate before strategy tuning.
- In scope: ingestion-run contract, provider cursor/checkpoint, event upsert, canonical/provider ID mapping, schedule/status changes, manual trigger, scheduler-ready handler, fixture-backed MLB and soccer adapters.
- Out of scope: Odds snapshots, result grading, automatic AI picks, production scheduler activation.
- Dependencies: FTE-DATA-001, FTE-007.
- Acceptance criteria: Replaying a page is idempotent; checkpoints advance only after durable writes; rescheduled/cancelled events retain identity and history; one failing league does not discard successful league progress.
- Required automated tests: Fixture integration tests for new, duplicate, rescheduled, cancelled, partial, retry, and checkpoint-resume cases.
- Likely files/packages affected: `apps/workers`, `packages/providers`, `packages/database`, `packages/domain`, `infra/cdk`.
- Observability: Run records expose provider requests, created/updated/skipped events, checkpoint, quota, duration, and failure reasons.
- Security: Keys remain server-side; raw payload logs are redacted.
- Data migration/backfill impact: Initial bounded event backfill per enabled league.
- Definition of done: MLB and soccer fixture runs persist canonical events through the shared orchestrator.
- Risk: High.
- Approval required before merge: No.

#### FTE-DATA-003: Multi-Sport Odds Collection Policy and Snapshot Jobs

- Epic: Multi-sport feed and result spine.
- Outcome: Moneyline and spread evidence begins accumulating consistently for enabled leagues.
- Context: Picks cannot be reproduced or evaluated for CLV without immutable pregame price history.
- In scope: market collection policy by sport/league, scheduled/manual job contract, The Odds API adapter integration, immutable snapshots, offered-book and comparison-book prices, freshness and suspended/partial states.
- Out of scope: Live betting, player props, sportsbook placement, pick generation.
- Dependencies: FTE-DATA-002, FTE-SPORT-007.
- Acceptance criteria: Two-way, three-way, and spread selections normalize through registered market contracts; snapshots retain provider/retrieval timestamps; retries do not duplicate evidence; unsupported markets are explicit.
- Required automated tests: Adapter fixtures plus idempotency, stale, partial, suspended, and out-of-order snapshot tests.
- Likely files/packages affected: `apps/workers`, `packages/providers`, `packages/database`, `packages/odds`, `infra/cdk`.
- Observability: Requests, quota, snapshots, stale inputs, market gaps, and job lag are measurable by league.
- Security: Provider credentials and raw licensed payloads are not exposed to clients or logs.
- Data migration/backfill impact: Odds history begins at activation; no synthetic pre-activation history.
- Definition of done: An enabled event accumulates auditable moneyline/spread snapshots without manual database edits.
- Risk: High.
- Approval required before merge: No.

#### FTE-DATA-003B: SharpAPI Redundant Odds and Betting Splits

- Epic: Multi-sport feed and result spine.
- Outcome: Odds collection has a configurable second provider, and timestamped betting-ticket/money split evidence becomes available for analysis.
- Context: The Odds API is a single point of failure and does not provide the public betting splits needed to compare bet count with money/handle concentration.
- In scope: SharpAPI odds adapter, `odds` and `public-betting` capabilities, exact cross-provider canonical mapping, immutable split history/current projection, explicit primary/secondary failover policy, independent quota/health/entitlement handling, secret/IAM/telemetry/runbook coverage.
- Out of scope: Purchasing or upgrading a plan, production activation without approval, silent odds blending, double-weighting a sportsbook exposed by both aggregators, trusting provider-derived EV as local truth, live betting, bet placement, and synthetic pre-activation history.
- Dependencies: FTE-DATA-001, FTE-DATA-002, FTE-DATA-003, FTE-SPORT-003, FTE-SPORT-007.
- Acceptance criteria: SharpAPI normalizes through provider-neutral odds contracts; exact canonical mappings prevent cross-provider event mistakes; configured health/quota failures trigger auditable bounded failover; split observations retain separate source/retrieval timestamps and optional ticket/money percentages; missing entitlement degrades only the split capability; replay never duplicates evidence or regresses current state.
- Required automated tests: Strict adapter fixtures, two/three-way and spread/total normalization where enabled, cross-provider mapping, shared-book weighting policy, primary/secondary outage and recovery, quota/rate limit, entitlement denial, invalid/missing/stale/out-of-order split data, replay, persistence parity, secret/IAM synth.
- Likely files/packages affected: `packages/providers`, `packages/domain`, `apps/workers`, `packages/database`, `infra/cdk`, operations docs.
- Observability: Provider attempts, chosen source, failover/failback reason, health, quota/rate limit, odds/split counts, split freshness, mapping gaps, and entitlement state are measurable by league.
- Security: Separate server-side secret; raw licensed responses, credentials, and commercial terms are excluded from clients and logs.
- Data migration/backfill impact: New split evidence begins at approved activation; no historical data is inferred or purchased by this story.
- Definition of done: Fixture-backed provider failover and split ingestion pass end to end, infrastructure is deployable but SharpAPI activation remains disabled until account contract and plan approval are recorded.
- Risk: High.
- Approval required before merge: Yes.

#### FTE-DATA-003D: SharpAPI Entitled Sportsbook Ingestion

- Epic: Multi-sport feed and result spine.
- Outcome: The upgraded SharpAPI account's approved sportsbook set, including Pinnacle, is normalized and persisted without silently changing consensus policy.
- Context: The production parser currently rejects every sportsbook absent from the small canonical registry; the upgraded account exposes up to 25 books, but entitlement does not guarantee coverage for every event, league, or market.
- In scope: authenticated entitlement verification, redacted bookmaker catalog discovery, canonical aliases, collection-eligibility policy separated from evaluation weights, Pinnacle and approved-book ingestion through existing immutable snapshots/current projections, scoped availability evidence, bounded telemetry, canary, runbook, and rollback.
- Out of scope: direct Pinnacle access or scraping, vendor-derived EV/fair odds as truth, consensus reweighting, UI, backfill, additional providers, sports, leagues, markets, live odds, props, or SSE.
- Dependencies: FTE-DATA-001, FTE-DATA-003B, FTE-DATA-003C, FTE-020.
- Acceptance criteria: The account proves capacity for at least 25 books; exact returned IDs map through a collision-free reviewed allowlist; Pinnacle persists end-to-end when returned; approved books use existing strict normalization, exact canonical binding, immutable/replay-safe snapshots and monotonic current projections; collection eligibility is distinct from evaluation weights; missing evidence is league/market scoped; unknown books fail closed; telemetry and fixtures contain no secrets or raw licensed payloads.
- Required automated tests: Account/catalog fixtures, all approved aliases, Pinnacle MLB/soccer market structures, unknown/collision handling, pagination, suspension/partial/missing states, replay/out-of-order behavior, sportsbook-specific snapshot identity, scoped gap generation, unchanged default consensus weights, control-plane recovery, secret-safe synth.
- Likely files/packages affected: `packages/config`, `packages/providers`, `apps/workers`, operations docs; database schema and UI should not change.
- Observability: Bounded account capacity, approved/observed/unknown book counts, Pinnacle coverage state, normalized observations, and scoped expected-book gaps by canonical ID/league/market.
- Security: Reuse the server-side SharpAPI secret; never log or commit keys, raw licensed responses, commercial terms, or unbounded provider labels.
- Data migration/backfill impact: None. New evidence starts at activation; historical snapshots remain immutable and readable.
- Definition of done: Synthetic verification and quality gates pass, and an explicitly authorized paid canary proves Pinnacle observed/persisted or reports coverage-unverified without fabricating success.
- Risk: High.
- Approval required before merge: Yes; the plan upgrade does not itself authorize a paid live canary.

#### FTE-DATA-004: Completed-Event Result Ingestion and Correction History

- Epic: Multi-sport feed and result spine.
- Outcome: Final scores and official outcome state arrive automatically and remain auditable when corrected.
- Context: Next-day grading requires an independent, provenance-backed results truth source.
- In scope: completed-event polling, result normalization, regulation/overtime scope metadata, postponed/cancelled/no-contest states, idempotent persistence, correction versions, unresolved mapping queue.
- Out of scope: Bet grading rules, performance aggregation, unofficial live scores.
- Dependencies: FTE-DATA-002.
- Acceptance criteria: Repeated finals are idempotent; corrected scores append history; unknown event mappings remain unresolved rather than creating a duplicate event; sport modules validate result shape.
- Required automated tests: Fixture tests for final, delayed final, postponed, cancelled, correction, duplicate, and unmapped events.
- Likely files/packages affected: `apps/workers`, `packages/providers`, `packages/domain`, `packages/database`.
- Observability: Finalized, corrected, unresolved, stale, and failed counts are queryable by league and run.
- Security: Provider access stays server-side; correction audit is append-only.
- Data migration/backfill impact: Bounded result backfill for ingested historical events.
- Definition of done: Fixture-backed MLB and soccer results persist with provenance and correction history.
- Risk: High.
- Approval required before merge: No.

### Epic 0B: Versioned AI Paper-Pick Pipeline

This early epic turns verified event and price evidence into reproducible Play/No Bet decisions. AI supplies structured sport analysis; deterministic code owns pricing and qualification.

#### FTE-PICK-001: Reproducible Evaluation and Paper-Bet Records

- Epic: Versioned AI paper-pick pipeline.
- Outcome: Every decision can be reconstructed exactly after models, prompts, odds, or strategies change.
- Context: A trustworthy learning loop needs immutable decision-time inputs before generating picks at scale.
- In scope: evaluation input manifest, prediction probability/range, candidate selection, Play/No Bet reason, paper-bet entity, offered price snapshot reference, module/strategy/model/prompt/calculation versions, input hash and provenance.
- Out of scope: LLM invocation, grading, real-money bet entry.
- Dependencies: FTE-SPORT-002, FTE-SPORT-004, FTE-DATA-003.
- Acceptance criteria: Records cannot reference mutable current odds; No Bet is first-class; identical manifests hash identically; strategy changes do not rewrite historical decisions.
- Required automated tests: Schema, hash stability, immutability, version completeness, and repository condition tests.
- Likely files/packages affected: `packages/domain`, `packages/database`, `packages/scouting`, `packages/odds`.
- Observability: Evaluation logs include safe version IDs, input hash, decision, and reason codes.
- Security: Prompts and evidence are stored without provider keys or secrets.
- Data migration/backfill impact: Existing fixture evaluations map to a legacy version or remain explicitly non-reproducible.
- Definition of done: A fixture evaluation and paper bet round-trip with complete version provenance.
- Risk: High.
- Approval required before merge: No.

#### FTE-PICK-002: Sport-Rule Analysis Contracts for ML and Spread

- Epic: Versioned AI paper-pick pipeline.
- Outcome: Each sport supplies explicit evidence, rules, prohibited claims, and structured output for moneyline/spread analysis.
- Context: Baseball, tennis, football, basketball, and soccer cannot share one generic handicapping prompt.
- In scope: versioned module contracts for required/optional evidence, market eligibility, probability range, uncertainty, contraindications, citations/provenance, abstention; initial MLB and soccer contracts; planned tennis/NFL/NBA contracts.
- Out of scope: Claiming production readiness without provider evidence, player props, LLM-owned EV math.
- Dependencies: FTE-SPORT-004, FTE-DATA-001.
- Acceptance criteria: Missing required evidence forces abstain or reduced maturity; output schema rejects unsupported selections and unbounded confidence; prompt snapshots are deterministic; each assertion links to evidence or is marked inference.
- Required automated tests: Prompt snapshots, schema validation, missing-evidence, unsupported-market, injection, and abstention tests.
- Likely files/packages affected: `packages/sports`, `packages/scouting`, `prompts`, `models`.
- Observability: Analysis records expose evidence completeness, validation failures, latency, token use, and model version.
- Security: Provider content is delimited as untrusted data; prompt injection defenses are tested.
- Data migration/backfill impact: New prompt/contract versions apply prospectively.
- Definition of done: MLB and soccer fixture analyses validate; planned modules fail safely until enabled.
- Risk: High.
- Approval required before merge: No.

#### FTE-PICK-003: AI Analysis, Deterministic +EV Qualification, and No-Bet Gate

- Epic: Versioned AI paper-pick pipeline.
- Outcome: Eligible events produce auditable ML/spread paper picks only when price and evidence justify them.
- Context: The AI must estimate a structured probability, while deterministic code compares it with offered odds and consensus.
- In scope: manual/batch evaluation worker, structured model call, evidence validation, deterministic vig/EV calculations, configurable edge and uncertainty thresholds, data-quality gates, Play/No Bet output, idempotent paper-bet creation.
- Out of scope: Autonomous bankroll sizing, sportsbook placement, tuning on future results.
- Dependencies: FTE-PICK-001, FTE-PICK-002, FTE-SPORT-007.
- Acceptance criteria: The LLM cannot override calculation results; stale/partial/unsupported inputs cannot create a Play; repeated manifests do not duplicate picks; every Play includes offered price, estimated probability, EV, uncertainty, reasons, and versions.
- Required automated tests: End-to-end fixture tests for Play, No Bet, stale data, missing evidence, model failure, invalid output, negative EV, and duplicate run.
- Likely files/packages affected: `apps/workers`, `packages/scouting`, `packages/odds`, `packages/domain`, `packages/database`.
- Observability: Counts and rates for evaluated, Play, No Bet, invalid, failed, latency, cost, and reason codes.
- Security: Model credentials remain server-side; model output is schema-validated and never executed.
- Data migration/backfill impact: None; historical replay must be labeled backtest rather than decision-time paper play.
- Definition of done: A fixture event can produce a reproducible Play or No Bet without manual calculation.
- Risk: High.
- Approval required before merge: No.

#### FTE-PICK-004: Scheduled Shadow and Paper-Pick Runs

- Epic: Versioned AI paper-pick pipeline.
- Outcome: Approved paper strategies evaluate eligible upcoming events consistently without pretending to place wagers.
- Context: Dataset accumulation needs repeatable automation, budget controls, and clear separation between shadow, paper, and money modes.
- In scope: EventBridge/Step Functions schedule, eligibility window, strategy allowlist, concurrency and cost limits, run ledger, replay protection, kill switch, shadow/paper mode labels.
- Out of scope: Real-money mode, sportsbook integration, automatic strategy promotion.
- Dependencies: FTE-PICK-003, FTE-007.
- Acceptance criteria: Scheduler evaluates only approved sport/league/strategy combinations; kill switch prevents new calls; retries do not duplicate picks; budget/concurrency limits fail closed; all outputs are labeled shadow or paper.
- Required automated tests: Scheduler/CDK assertions, allowlist, retry, duplicate, budget-limit, and kill-switch tests.
- Likely files/packages affected: `apps/workers`, `infra/cdk`, `packages/config`, `packages/database`.
- Observability: Run status, eligible/evaluated counts, paper picks, model cost, quota, failures, and kill-switch state are alarmable.
- Security: Least-privilege job roles; no client-triggered arbitrary prompts or strategy versions.
- Data migration/backfill impact: None.
- Definition of done: A controlled scheduled run creates only idempotent shadow/paper decisions.
- Risk: High.
- Approval required before merge: Yes.

### Epic 0C: Automated Grading and Learning Governance

This early epic closes the feedback loop while preventing hindsight edits, leakage, and promotion based only on a headline win percentage.

#### FTE-LEARN-001: Deterministic ML and Spread Grading

- Epic: Automated grading and learning governance.
- Outcome: Imported finals settle eligible paper picks accurately and idempotently.
- Context: Grading rules vary by market and event scope but must never be delegated to an LLM.
- In scope: moneyline/two-way/three-way and spread grading, win/loss/push/void/unresolved, price-based units and ROI, result-version reference, regrade audit after official correction.
- Out of scope: Props, live bets, subjective grading, sportsbook settlement imports.
- Dependencies: FTE-DATA-004, FTE-PICK-001.
- Acceptance criteria: Sport/market fixtures cover ties, pushes, overtime/regulation scope, cancellations and corrections; duplicate grading is safe; corrections append a regrade record; unresolved rules never default to loss.
- Required automated tests: Table/property tests for supported market outcomes plus idempotency and correction integration tests.
- Likely files/packages affected: `packages/odds`, `packages/domain`, `packages/database`, `apps/workers`.
- Observability: Graded, regraded, unresolved, void, and failed counts with reason codes.
- Security: Grading records and audit history are append-only.
- Data migration/backfill impact: Existing reproducible paper picks may be graded from retained official results.
- Definition of done: A final result grades fixture paper picks with verified P/L and audit history.
- Risk: High.
- Approval required before merge: No.

#### FTE-LEARN-002: Cohort Metrics, Calibration, CLV, and Uncertainty

- Epic: Automated grading and learning governance.
- Outcome: Strategy quality is visible beyond raw win percentage.
- Context: A 60–70% hit rate can still lose money at expensive prices and can be meaningless at small sample sizes.
- In scope: immutable cohort definitions; sample size, W/L/P/V, win rate, average odds, units, ROI, estimated EV, CLV, Brier/calibration buckets, confidence intervals, drawdown; segments by sport, league, market, odds band, strategy/model, and paper/money mode.
- Out of scope: Causal claims, automatic tuning, public leaderboards.
- Dependencies: FTE-LEARN-001, FTE-DATA-003.
- Acceptance criteria: Voids/pushes use documented denominators; price-aware break-even is shown; small samples display uncertainty; aggregates trace to immutable pick/result records; unavailable closing lines do not become zero CLV.
- Required automated tests: Golden aggregate fixtures, denominator edge cases, confidence interval/calibration tests, and cohort reproducibility tests.
- Likely files/packages affected: `packages/domain`, `packages/odds`, `packages/database`, `apps/api`, `apps/web`.
- Observability: Aggregate version, cohort hash, source counts, query latency, and failures are recorded.
- Security: Private user data remains scoped; reports expose no credentials or licensed raw payloads.
- Data migration/backfill impact: Versioned aggregate backfill from immutable records.
- Definition of done: A paper cohort report distinguishes hit rate, profitability, calibration, CLV, and uncertainty.
- Risk: High.
- Approval required before merge: No.

#### FTE-LEARN-003: Versioned Retrospective and Error Taxonomy

- Epic: Automated grading and learning governance.
- Outcome: Losing and winning cohorts produce structured, evidence-backed lessons without rewriting history.
- Context: Retrospectives should identify data, price, model, rule, and execution failures rather than merely ask the LLM why a pick lost.
- In scope: retrospective record, frozen cohort manifest, error taxonomy, per-sport/market slices, false-positive/false-negative review, evidence gaps, proposed strategy/prompt/data changes, human approval state.
- Out of scope: Automatic production edits, tuning on evaluation cohorts, outcome-based narrative certainty.
- Dependencies: FTE-LEARN-002.
- Acceptance criteria: Retros use frozen cohort hashes; proposed changes create new version candidates; result knowledge is separated from decision-time evidence; no single game can trigger automatic promotion; reviewer decisions are audited.
- Required automated tests: Cohort freeze, version lineage, leakage guard, state transition, and audit tests.
- Likely files/packages affected: `packages/domain`, `packages/scouting`, `packages/database`, `apps/api`, `apps/web`.
- Observability: Retrospective version, cohort, proposal count, approval state, and validation failures are logged.
- Security: Only authorized users can approve candidates; prior retrospective versions remain readable.
- Data migration/backfill impact: None.
- Definition of done: A completed cohort can produce a reviewable retrospective and versioned change proposals.
- Risk: High.
- Approval required before merge: Yes.

#### FTE-LEARN-004: Walk-Forward Experiment and Strategy Promotion Gates

- Epic: Automated grading and learning governance.
- Outcome: Challenger strategies earn promotion through leakage-resistant evidence.
- Context: Repeatedly tuning against the same history inflates apparent win rate and creates false confidence.
- In scope: chronological train/tune/holdout windows, shadow comparison, baseline/challenger registry, minimum sample, ROI/CLV/calibration/drawdown criteria, regression guards, draft-to-approved transitions, rollback.
- Out of scope: Fully autonomous model training, guaranteed 60–70% outcomes, real-money activation.
- Dependencies: FTE-LEARN-003.
- Acceptance criteria: Holdout events cannot appear in tuning inputs; promotion requires configured multi-metric gates and human approval; failing challengers remain recorded; rollback changes future runs only; baseline history remains immutable.
- Required automated tests: Temporal leakage, cohort overlap, gate boundary, approval, rollback, and reproducibility tests.
- Likely files/packages affected: `packages/domain`, `packages/scouting`, `packages/database`, `apps/workers`, `apps/web`.
- Observability: Experiment window/version, overlap checks, gate results, approvals, promotion, and rollback are auditable.
- Security: Promotion is permission-gated and cannot be triggered by model output alone.
- Data migration/backfill impact: Existing strategies begin as unvalidated legacy or fixture baselines.
- Definition of done: A challenger can be rejected or promoted from frozen walk-forward evidence with an audit trail.
- Risk: High.
- Approval required before merge: Yes.

#### FTE-LEARN-005: Real-Money Readiness Gate and Kill Switch

- Epic: Automated grading and learning governance.
- Outcome: Paper success cannot silently enable real-money behavior.
- Context: Legal availability, bankroll risk, provider terms, and statistical uncertainty require a separate human decision.
- In scope: readiness checklist, jurisdiction/provider review record, bankroll and per-bet/daily/weekly loss limits, explicit mode indicator, dual confirmation, global kill switch, money-play ledger separation, rollback/runbook.
- Out of scope: Sportsbook credential storage, direct bet placement, bypassing sportsbook controls, unattended wagering.
- Dependencies: FTE-LEARN-004, FTE-056, FTE-058.
- Acceptance criteria: Default mode is paper; no metric automatically enables money mode; missing/expired approval fails closed; limits and kill switch are enforced at every money-mode entry point; paper and money results remain separately reportable.
- Required automated tests: Default-off, authorization, expired approval, limit, kill-switch, separation, and CDK/config tests.
- Likely files/packages affected: `packages/domain`, `packages/config`, `packages/database`, `apps/api`, `apps/web`, `infra/cdk`, `docs/runbooks`.
- Observability: Mode changes, approvals, limit decisions, and kill-switch actions are immutable audit events.
- Security: Human approval required; money-mode access is least privilege and separately feature-flagged.
- Data migration/backfill impact: All historical picks default to paper or legacy; none are inferred as money plays.
- Definition of done: A reviewed readiness artifact exists and the system demonstrably fails closed.
- Risk: Critical.
- Approval required before merge: Yes.

## 1. Purpose

This artifact decomposes the private, soccer-first FIND THE EDGE MVP into small, testable, implementation-ready stories suitable for a future Codex automation loop:

1. Select the next ready story.
2. Implement it on a feature branch.
3. Run tests.
4. Open a pull request.
5. Address failed checks.
6. Mark the story complete.
7. Move to the next ready story.

The Product Brief, PRD, Architecture, and UX specification are the source of truth. The Claude Design prototype is a visual reference only and does not override MVP scope, architecture decisions, data provenance rules, or deterministic calculation boundaries.

## 2. Scope Guardrails

MVP scope is private, soccer-first, and Hard Rock Florida-focused. Stories must preserve:

- React, Vite, TanStack Router, TanStack Query, TanStack Table, Tailwind, shadcn/ui, Recharts.
- TypeScript, pnpm workspaces, Turborepo, Vitest, Playwright, GitHub Actions.
- AWS Lambda, API Gateway HTTP API, DynamoDB, DynamoDB Streams, SQS, EventBridge Scheduler, Step Functions, S3, CloudFront, Cognito, Secrets Manager, CloudWatch, AWS CDK.
- The Odds API as the initial odds and betting-market event-discovery source.
- A separate unresolved soccer enrichment provider decision.
- Deterministic betting math outside React, AWS, provider DTOs, DynamoDB, and any LLM.
- Immutable odds snapshots, current-price projections, provider timestamps, retrieval timestamps, stale/partial/suspended states, and provider health/quota visibility.
- Manual scouting jobs and manual bet tracking for MVP.

Out of MVP scope: NFL, NBA, esports, live betting, player props, corners, cards, public registration, subscriptions, sportsbook bet placement, automatic bet settlement, native mobile apps, social publishing, automated graphics, machine-learning probability models, and fully automated scouting schedules. Automatic scouting preferences may appear only as disabled or future-facing settings.

## 3. Epic Sequence

0A. Multi-sport feed and result spine.
0B. Versioned AI paper-pick pipeline.
0C. Automated grading and learning governance.
1. Engineering foundation.
2. Authentication and application shell.
3. Sports catalog and event ingestion.
4. Odds ingestion and market normalization.
5. Deterministic betting engine.
6. +EV opportunity lifecycle and dashboard.
7. Manual scouting workflow.
8. Watchlist and change tracking.
9. Bet tracker and settlement.
10. Performance and settings.
11. Reliability, security, and production readiness.

## 4. Critical Dependency Chain

```text
FTE-001 -> FTE-002 -> FTE-007 -> FTE-008 -> FTE-014 -> FTE-013 -> FTE-015 -> FTE-018
        -> FTE-021 -> FTE-023 -> FTE-027 -> FTE-028 -> FTE-033 -> FTE-036 -> FTE-025
        -> FTE-038 -> FTE-042 -> FTE-044 -> FTE-045 -> FTE-048 -> FTE-052 -> FTE-058
```

Spike dependencies:

- FTE-019 must resolve the MVP soccer competition allowlist before broad production event ingestion.
- FTE-032 must resolve configurable consensus defaults before final opportunity qualification thresholds ship.
- FTE-039 must resolve the soccer enrichment provider recommendation before production scouting enrichment is implemented.

## 5. Story Field Standard

Every story below includes: Story ID, title, epic, user/system outcome, context, in scope, out of scope, dependencies, acceptance criteria, required automated tests, likely files/packages affected, observability, security, data migration/backfill impact, definition of done, risk, and whether human approval is required before merge.

## 6. Stories

### Epic 1: Engineering Foundation

#### FTE-001: Monorepo and TypeScript Tooling Foundation

- Epic: Engineering foundation.
- Outcome: Developers can install, typecheck, lint, format, and test an empty workspace with strict TypeScript boundaries.
- Context: This is the first safe implementation story and should create the buildable substrate only.
- In scope: pnpm workspace, Turborepo, package manager metadata, strict shared TypeScript configs, eslint/prettier or equivalent repo-standard formatting, root scripts, basic README dev commands.
- Out of scope: App screens, AWS resources, provider integrations, auth, production UI.
- Dependencies: None.
- Acceptance criteria: `pnpm install`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` run successfully; workspace package globs match Architecture; strict TypeScript is enabled; no product routes or infrastructure are scaffolded beyond empty package placeholders when required.
- Required automated tests: Workspace smoke test script and a trivial Vitest sanity test in a non-product package if a package is created.
- Likely files/packages affected: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig*.json`, lint/format configs, `packages/*`.
- Observability: None beyond script output.
- Security: Lockfile must be committed; dependency scripts should be minimal and auditable.
- Data migration/backfill impact: None.
- Definition of done: Clean install and all root quality commands pass locally.
- Risk: Low.
- Approval required before merge: No.

#### FTE-002: Vite React Web App Shell Baseline

- Epic: Engineering foundation.
- Outcome: A minimal React/Vite app can build and run without product functionality.
- Context: Required before application shell and route implementation.
- In scope: `apps/web` Vite React setup, Tailwind/shadcn-compatible styling baseline, TanStack Router placeholder root route, app-level error boundary placeholder, build/test scripts.
- Out of scope: Auth, product screens, real navigation, data fetching, charts.
- Dependencies: FTE-001.
- Acceptance criteria: Web app builds; root route renders a minimal private-product placeholder; no prototype runtime is imported; TypeScript strict mode passes.
- Required automated tests: Web smoke render test and build command in CI-ready script.
- Likely files/packages affected: `apps/web`, `packages/ui`, root workspace config.
- Observability: Browser console must be clean in dev smoke test.
- Security: No secrets or provider keys in frontend config.
- Data migration/backfill impact: None.
- Definition of done: `pnpm --filter web build` and root checks pass.
- Risk: Low.
- Approval required before merge: No.

#### FTE-003: Shared Package Structure and Dependency Boundaries

- Epic: Engineering foundation.
- Outcome: The repo has architecture-aligned packages with enforceable dependency direction.
- Context: Prevents betting math, provider DTOs, AWS code, and React code from bleeding across boundaries.
- In scope: package skeletons for `domain`, `odds`, `scouting`, `providers`, `database`, `auth`, `config`, `observability`, `ui`, and `test-utils`; dependency lint or package-boundary checks.
- Out of scope: Domain implementation beyond placeholders/types required for compile.
- Dependencies: FTE-001.
- Acceptance criteria: Packages compile; forbidden dependency examples fail the boundary rule; package README notes responsibilities.
- Required automated tests: Boundary-check command in CI and at least one negative fixture or static rule assertion.
- Likely files/packages affected: `packages/*`, lint config, workspace config.
- Observability: None.
- Security: Boundary rules prevent frontend imports of AWS/database/provider implementation code.
- Data migration/backfill impact: None.
- Definition of done: Boundary checks run in root quality script.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-004: Unit, Integration, and E2E Test Harness

- Epic: Engineering foundation.
- Outcome: Future stories can add deterministic unit tests and browser E2E tests consistently.
- Context: PRD depends on calculation correctness and UX state coverage.
- In scope: Vitest setup, Testing Library setup, Playwright setup, test fixtures directory, coverage thresholds starter policy, local test docs.
- Out of scope: Feature-specific tests for events, odds, auth, or scouting.
- Dependencies: FTE-001, FTE-002.
- Acceptance criteria: Unit and Playwright sample tests pass; commands are documented; CI can run headless.
- Required automated tests: Sample unit test and sample browser smoke test.
- Likely files/packages affected: `apps/web`, `packages/test-utils`, Playwright/Vitest configs.
- Observability: Test artifacts retained locally for failed Playwright runs.
- Security: Tests must not require real provider secrets.
- Data migration/backfill impact: None.
- Definition of done: `pnpm test` and `pnpm test:e2e` pass.
- Risk: Low.
- Approval required before merge: No.

#### FTE-005: GitHub Actions CI Quality Gates

- Epic: Engineering foundation.
- Outcome: Pull requests run install, lint, typecheck, unit tests, build, and E2E smoke.
- Context: Required for future automated Codex PR workflow.
- In scope: CI workflow, pnpm caching, Node runtime floor aligned to Architecture, artifact upload for E2E failures.
- Out of scope: Deployment, AWS credentials, provider integration tests.
- Dependencies: FTE-001, FTE-004.
- Acceptance criteria: CI passes on main; failed checks produce actionable logs; Node version is `>=20.19` per Architecture.
- Required automated tests: CI executes existing root test commands.
- Likely files/packages affected: `.github/workflows/*`, package scripts.
- Observability: CI artifacts for Playwright traces/screenshots.
- Security: No plaintext secrets; least-privilege GitHub token defaults.
- Data migration/backfill impact: None.
- Definition of done: A PR can be validated without manual local commands.
- Risk: Low.
- Approval required before merge: No.

#### FTE-006: Environment Validation and Local Development Documentation

- Epic: Engineering foundation.
- Outcome: Developers get clear failures for missing config and can run the repo locally.
- Context: Provider and AWS values will arrive later; early validation avoids silent misconfiguration.
- In scope: typed env schema package, `.env.example`, local dev documentation, placeholder variables grouped by future package.
- Out of scope: Real secrets, provider calls, AWS deployment.
- Dependencies: FTE-001.
- Acceptance criteria: Missing required envs fail in packages that need them; local no-provider mode works; docs distinguish local placeholder values from secrets.
- Required automated tests: Env schema unit tests for valid, missing, and malformed values.
- Likely files/packages affected: `packages/config`, `.env.example`, `docs/local-development.md`.
- Observability: Startup/config validation errors are structured and readable.
- Security: `.env` and `.env.*` stay ignored except examples; no secret defaults.
- Data migration/backfill impact: None.
- Definition of done: New developer can follow docs through all current checks.
- Risk: Low.
- Approval required before merge: No.

#### FTE-007: Base AWS CDK Application Skeleton

- Epic: Engineering foundation.
- Outcome: Infrastructure can be synthesized without deploying product resources.
- Context: Enables later Cognito, DynamoDB, API, queues, and CloudFront stories.
- In scope: `infra/cdk` app skeleton, environment config contract, synth command, placeholder stack boundaries.
- Out of scope: Real deployed resources, AWS account configuration, production deploy.
- Dependencies: FTE-001, FTE-006.
- Acceptance criteria: `cdk synth` or equivalent package script succeeds; no AWS credentials required for synth; stack names are environment-aware.
- Required automated tests: CDK synth test or snapshot-style assertion for empty/base stack.
- Likely files/packages affected: `infra/cdk`, `packages/config`.
- Observability: Synth output is deterministic.
- Security: No account IDs or secrets committed; termination/deletion policies deferred to resource stories.
- Data migration/backfill impact: None.
- Definition of done: CI can synth base infrastructure.
- Risk: Medium.
- Approval required before merge: No.

### Epic 2: Authentication and Application Shell

#### FTE-008: Cognito Private Authentication Infrastructure

- Epic: Authentication and application shell.
- Outcome: The private app has Cognito user pool infrastructure for Kevishie without public registration.
- Context: PRD requires secure login, password reset, session expiration, and future role context.
- In scope: Cognito CDK resources, app client, hosted/private flow configuration as chosen by implementation, private user provisioning path, password policy.
- Out of scope: Public self-signup, admin UI, social login.
- Dependencies: FTE-007.
- Acceptance criteria: Synth tests assert no public registration; user pool/client outputs are available; private user bootstrap process is documented.
- Required automated tests: CDK assertions for Cognito configuration and disabled self-registration.
- Likely files/packages affected: `infra/cdk`, `packages/auth`, `docs/local-development.md`.
- Observability: Auth-related CloudWatch/audit event hooks planned or emitted where available.
- Security: Strong password policy; no secrets in repo; least-privilege outputs.
- Data migration/backfill impact: None.
- Definition of done: Cognito stack can be synthesized and reviewed.
- Risk: Medium.
- Approval required before merge: Yes.

#### FTE-009: Login, Logout, Session Refresh, and Protected Routes

- Epic: Authentication and application shell.
- Outcome: Users must authenticate before viewing protected MVP routes.
- Context: All product surfaces are private.
- In scope: login screen, logout control, token/session storage integration, protected route guards, redirect-after-login, session refresh.
- Out of scope: Public registration, role admin, product screen implementation.
- Dependencies: FTE-002, FTE-008.
- Acceptance criteria: Unauthenticated direct navigation redirects to login; successful login reaches Dashboard placeholder; logout clears session; refresh preserves valid session.
- Required automated tests: Route guard unit tests and Playwright auth-flow smoke with mocked auth where needed.
- Likely files/packages affected: `apps/web`, `packages/auth`.
- Observability: Client auth errors logged without sensitive token details.
- Security: Tokens are handled with Cognito library guidance; no token values in logs.
- Data migration/backfill impact: None.
- Definition of done: Protected navigation works in local and deployed-like config.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-010: Password Reset and Session-Expired States

- Epic: Authentication and application shell.
- Outcome: The private user can recover access and understand expired sessions.
- Context: UX spec requires password reset and session-expired login state.
- In scope: forgot-password flow, reset confirmation, expired-session banner/state, unsaved input preservation where feasible.
- Out of scope: Account registration, multi-user recovery support.
- Dependencies: FTE-009.
- Acceptance criteria: Reset flow does not reveal whether an email is valid; expired sessions redirect safely; copy avoids public-product framing.
- Required automated tests: Form validation tests and Playwright reset/expired-state flows with mocks.
- Likely files/packages affected: `apps/web`, `packages/auth`.
- Observability: Password reset attempts emit non-sensitive audit events.
- Security: Non-specific errors; no reset codes logged.
- Data migration/backfill impact: None.
- Definition of done: Password reset UX and session-expired UX are covered by tests.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-011: Navigation Shell, Sidebar, Header, and Mobile Nav

- Epic: Authentication and application shell.
- Outcome: Authenticated users can move through MVP route placeholders in a prototype-aligned shell.
- Context: Prototype provides visual direction; Design group must not ship.
- In scope: desktop sidebar, sticky header, responsive mobile navigation, product route placeholders, active nav state, global refresh/add bet controls as disabled or placeholder where not ready.
- Out of scope: Design System/Documentation prototype routes, production feature content.
- Dependencies: FTE-009.
- Acceptance criteria: Product navigation order matches UX spec; mobile nav supports primary routes; unavailable route content is clearly placeholder or disabled; no prototype runtime is reused.
- Required automated tests: Responsive navigation Playwright checks and route rendering tests.
- Likely files/packages affected: `apps/web`, `packages/ui`.
- Observability: Navigation errors route to error boundary.
- Security: All shell routes remain protected.
- Data migration/backfill impact: None.
- Definition of done: Shell matches UX tokens enough for future screens without product logic.
- Risk: Low.
- Approval required before merge: No.

#### FTE-012: Authentication Audit Events

- Epic: Authentication and application shell.
- Outcome: Security-relevant auth events are traceable without exposing sensitive data.
- Context: PRD requires authentication audit events.
- In scope: login success/failure, logout, password reset requested/completed, session expired; correlation IDs where applicable.
- Out of scope: Full SIEM integration, user administration.
- Dependencies: FTE-008, FTE-009.
- Acceptance criteria: Audit event contract exists; API/worker or Cognito hook path records events; logs omit secrets and tokens.
- Required automated tests: Unit tests for event redaction and contract shape.
- Likely files/packages affected: `packages/auth`, `packages/observability`, `apps/api`, `infra/cdk`.
- Observability: Structured audit logs in CloudWatch-compatible format.
- Security: PII minimized; token/code redaction enforced.
- Data migration/backfill impact: None.
- Definition of done: Audit events can be queried in logs for auth flows.
- Risk: Medium.
- Approval required before merge: No.

### Epic 3: Sports Catalog and Event Ingestion

#### FTE-013: Soccer Domain Models and Event Lifecycle

- Epic: Sports catalog and event ingestion.
- Outcome: Soccer sports, competitions, teams, events, statuses, kickoff changes, postponements, and cancellations are represented canonically.
- Context: Event normalization underpins odds, scouting, watchlist, reports, and bets.
- In scope: domain types/value objects, canonical IDs, event status model, provider mapping contracts.
- Out of scope: Provider API calls, persistence, UI.
- Dependencies: FTE-003.
- Acceptance criteria: Domain package models scheduled, postponed, cancelled, completed, and unknown states; canonical IDs do not depend on provider IDs alone.
- Required automated tests: Unit tests for lifecycle transitions, ID validation, kickoff-change handling.
- Likely files/packages affected: `packages/domain`.
- Observability: Domain errors expose safe reason codes.
- Security: None beyond input validation.
- Data migration/backfill impact: None.
- Definition of done: Domain types compile and are tested without AWS/provider dependencies.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-014: The Odds API Adapter Foundation and Request Logging

- Epic: Sports catalog and event ingestion.
- Outcome: The codebase can call The Odds API through an adapter with safe logging and quota metadata.
- Context: The Odds API is the initial event and odds-market discovery source.
- In scope: provider client interface, The Odds API config, request/response DTO isolation, request logging, error classification, test fixtures.
- Out of scope: Production ingestion jobs, consensus, UI.
- Dependencies: FTE-006, FTE-013.
- Acceptance criteria: Adapter supports sports discovery and event/odds endpoints needed later; provider DTOs do not escape provider package; logs include provider, endpoint, status, quota fields, correlation ID.
- Required automated tests: Unit tests with mocked HTTP responses for success, rate limit, partial/error payloads, and redaction.
- Likely files/packages affected: `packages/providers`, `packages/config`, `packages/observability`.
- Observability: Structured provider request logs with quota and latency fields.
- Security: API key read from Secrets/env only; never logged.
- Data migration/backfill impact: None.
- Definition of done: Adapter contract is fixture-tested and boundary-safe.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-015: Upcoming Soccer Event Ingestion Worker

- Epic: Sports catalog and event ingestion.
- Outcome: Upcoming soccer events with betting markets can be ingested and normalized.
- Context: Event discovery comes from The Odds API for markets that exist.
- In scope: worker command, event normalization, kickoff changes, postponement/cancellation updates, idempotent provider mapping writes.
- Out of scope: Odds snapshots, UI, enrichment provider data.
- Dependencies: FTE-013, FTE-014, FTE-019.
- Acceptance criteria: Re-running the same provider payload is idempotent; changed kickoff/status updates canonical event safely; unsupported sports ignored.
- Required automated tests: Worker unit/integration tests with fixture payloads for new, changed, postponed, cancelled, duplicate events.
- Likely files/packages affected: `apps/workers`, `packages/domain`, `packages/providers`, `packages/database`.
- Observability: Logs ingestion counts, update counts, skipped counts, provider request IDs.
- Security: Provider keys remain server-side.
- Data migration/backfill impact: Initial event backfill command required for MVP data.
- Definition of done: Fixture-backed worker writes normalized event records through repository interface.
- Risk: High.
- Approval required before merge: No.

#### FTE-016: Event Repository, API, and Pagination

- Epic: Sports catalog and event ingestion.
- Outcome: The frontend can list and retrieve upcoming soccer events through typed APIs.
- Context: Events Explorer and Event Detail depend on stable API contracts.
- In scope: DynamoDB repository, list upcoming events by date/status/competition, get event detail, opaque pagination cursors, typed response envelope.
- Out of scope: Odds history, scouting reports, watchlist mutations.
- Dependencies: FTE-013, FTE-015.
- Acceptance criteria: APIs return Eastern Time display-ready metadata plus raw ISO fields; no table scans for normal reads; stale/missing flags included.
- Required automated tests: Repository tests, API handler tests, pagination cursor tests.
- Likely files/packages affected: `apps/api`, `packages/database`, `packages/domain`.
- Observability: API logs include route, user, cursor presence, result count, latency.
- Security: API requires authenticated user context.
- Data migration/backfill impact: None beyond existing ingested events.
- Definition of done: API contract supports Events Explorer requirements.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-017: Event Status and Data Freshness Indicators

- Epic: Sports catalog and event ingestion.
- Outcome: Missing, stale, partial, postponed, cancelled, and unavailable event data are explicit.
- Context: The product must never present missing data as verified.
- In scope: freshness thresholds for event metadata, status reason codes, API fields, UI badge mapping.
- Out of scope: Odds freshness, scouting provenance.
- Dependencies: FTE-016.
- Acceptance criteria: Event responses include status/freshness/missing-data reasons; UI components render distinct labels for stale vs unavailable vs postponed/cancelled.
- Required automated tests: Domain status tests, API serialization tests, UI badge tests.
- Likely files/packages affected: `packages/domain`, `apps/api`, `apps/web`, `packages/ui`.
- Observability: Stale event counts can be logged from list API.
- Security: None.
- Data migration/backfill impact: Existing events default missing fields to unavailable, not verified.
- Definition of done: Events never show placeholder facts as verified.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-018: Events Explorer Screen

- Epic: Sports catalog and event ingestion.
- Outcome: The user can browse, filter, and act on upcoming soccer events.
- Context: Prototype includes table/card views; UX spec prefers dense desktop table.
- In scope: Events route, date/competition/status/watchlist/scouted filters, search, table view, responsive card view, Scout Event and Watchlist affordances gated by readiness.
- Out of scope: Real scouting job creation if Epic 7 is not complete; odds comparison detail.
- Dependencies: FTE-011, FTE-016, FTE-017.
- Acceptance criteria: Filters combine correctly; empty states distinguish no matches from no data; Hard Rock and comparison coverage placeholders use unavailable states until odds coverage exists.
- Required automated tests: Component tests for filters/empty states and Playwright route/table smoke.
- Likely files/packages affected: `apps/web`, `packages/ui`.
- Observability: Query errors surface through UI error states without blank screens.
- Security: Route remains protected; no provider secrets client-side.
- Data migration/backfill impact: None.
- Definition of done: Events Explorer meets UX spec with live event API data.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-019: Spike - Initial Soccer Competitions Allowlist

- Epic: Sports catalog and event ingestion.
- Outcome: The MVP has an evidence-backed soccer competition allowlist.
- Context: PRD leaves MVP competitions open; event ingestion needs a bounded allowlist.
- In scope: Compare Hard Rock market availability, The Odds API coverage, future enrichment coverage, user relevance, schedule density, scouting completeness, quota cost; produce ADR/recommendation.
- Out of scope: Implementing ingestion for selected competitions.
- Dependencies: FTE-014.
- Acceptance criteria: ADR lists candidate competitions, evidence, tradeoffs, selected MVP allowlist, excluded competitions, and quota implications.
- Required automated tests: None; research artifact review checklist required.
- Likely files/packages affected: `docs/adr/*`, `_bmad-output/planning-artifacts/*`.
- Observability: N/A.
- Security: Do not publish provider credentials or paid-license details beyond permitted summaries.
- Data migration/backfill impact: Determines future initial ingestion/backfill scope.
- Definition of done: Human-approved ADR exists before production event ingestion expands.
- Risk: High.
- Approval required before merge: Yes.

### Epic 4: Odds Ingestion and Market Normalization

#### FTE-020: Bookmaker, Market, and Selection Normalization

- Epic: Odds ingestion and market normalization.
- Outcome: Provider odds are mapped to canonical bookmakers, markets, and selections.
- Context: Hard Rock Florida and comparison books must be stable across calculations.
- In scope: canonical bookmaker registry, Hard Rock Florida mapping, comparison book config, MVP market keys, selection normalization, unsupported market handling.
- Out of scope: Snapshot persistence, consensus calculations.
- Dependencies: FTE-013, FTE-014, FTE-032.
- Acceptance criteria: Moneyline, three-way moneyline, spread, totals, BTTS, and team totals normalize correctly from fixtures; unsupported markets are retained or ignored according to explicit reason codes.
- Required automated tests: Fixture tests for market/selection mappings and unknown bookmaker behavior.
- Likely files/packages affected: `packages/domain`, `packages/providers`, `packages/config`.
- Observability: Logs unknown bookmaker/market/selection counts with provider IDs.
- Security: None.
- Data migration/backfill impact: Mapping changes may require reprocessing provider payloads.
- Definition of done: Canonical mapping is deterministic and tested.
- Risk: High.
- Approval required before merge: No.

#### FTE-021: Immutable Odds Snapshot Persistence and Current Projection

- Epic: Odds ingestion and market normalization.
- Outcome: Odds retrievals create immutable snapshots and current-price projections.
- Context: PRD requires append-only odds history plus current display values.
- In scope: DynamoDB odds table repository, snapshot item mapper, current projection mapper, idempotent writes, provider/retrieval timestamps, content hashes.
- Out of scope: Streams worker if split into FTE-022, UI charts.
- Dependencies: FTE-020.
- Acceptance criteria: Duplicate payloads do not create duplicate snapshots; older current projections cannot overwrite newer ones; missing provider timestamps are marked unavailable.
- Required automated tests: Repository tests for idempotency, ordering, timestamp handling, and malformed odds rejection.
- Likely files/packages affected: `packages/database`, `packages/domain`, `apps/workers`.
- Observability: Snapshot write counts, duplicate counts, stale/partial counts.
- Security: Provider raw payloads are not logged verbatim.
- Data migration/backfill impact: First odds snapshot backfill creates immutable history from point of launch forward.
- Definition of done: Snapshot and projection writes are reliable under duplicate/retry execution.
- Risk: High.
- Approval required before merge: No.

#### FTE-022: DynamoDB Streams Projection Workflow

- Epic: Odds ingestion and market normalization.
- Outcome: Current-price projections can be maintained from immutable snapshots through a replayable workflow.
- Context: Architecture prefers stream projection for rebuild and deduplication.
- In scope: DynamoDB Streams handler, projection update idempotency, replay notes, DLQ path.
- Out of scope: Full historical replay tooling if not needed for MVP.
- Dependencies: FTE-021, FTE-007.
- Acceptance criteria: Stream handler updates current projections only from newer snapshots; duplicate records are safe; DLQ receives unrecoverable records.
- Required automated tests: Handler tests for insert, duplicate, out-of-order, malformed records.
- Likely files/packages affected: `apps/workers`, `infra/cdk`, `packages/database`.
- Observability: Projection lag, processed count, failure count, DLQ count.
- Security: Least-privilege read/write IAM in CDK assertions.
- Data migration/backfill impact: Projection rebuild procedure documented.
- Definition of done: Projection path is automated and test-covered.
- Risk: High.
- Approval required before merge: No.

#### FTE-023: Featured and Event-Specific Odds Ingestion

- Epic: Odds ingestion and market normalization.
- Outcome: The system retrieves odds for enabled soccer markets and events.
- Context: The Odds API may require sport-level and event-specific retrievals depending on market depth.
- In scope: ingestion command/job, request deduplication, featured markets, event-specific market retrieval where required, partial response handling.
- Out of scope: Consensus generation, UI.
- Dependencies: FTE-015, FTE-021.
- Acceptance criteria: Supported MVP markets are requested within quota limits; partial responses write available valid snapshots and mark missing pieces; failures are retryable with reason codes.
- Required automated tests: Fixture tests for full, partial, suspended, rate-limited, and missing-Hard-Rock payloads.
- Likely files/packages affected: `apps/workers`, `packages/providers`, `packages/database`, `packages/domain`.
- Observability: Request counts by endpoint/market, quota usage, snapshot counts, partial/failure counts.
- Security: API keys are server-only; raw payload archival redacts secrets.
- Data migration/backfill impact: Initial odds collection begins immutable history.
- Definition of done: Odds ingestion can run for the approved competition allowlist with fixture coverage.
- Risk: High.
- Approval required before merge: No.

#### FTE-024: Provider Quota, Retry, DLQ, and Suspended/Partial States

- Epic: Odds ingestion and market normalization.
- Outcome: Provider limitations and data-quality failures are visible and safe.
- Context: MVP must show quota and stale/partial/suspended states.
- In scope: quota tracking model, retry policy, DLQ handling, suspended-market representation, partial response status, provider health records.
- Out of scope: Dashboard visual summary if FTE-037 handles it.
- Dependencies: FTE-023.
- Acceptance criteria: Rate limits, network failures, malformed payloads, quota exhaustion, and suspended markets have distinct reason codes; retry policy avoids uncontrolled quota burn.
- Required automated tests: Unit tests for retry classification, quota counters, DLQ routing, suspended-market exclusion.
- Likely files/packages affected: `packages/providers`, `packages/database`, `apps/workers`, `infra/cdk`.
- Observability: CloudWatch metrics/logs for quota remaining, retries, failures, DLQ depth.
- Security: Provider errors do not expose secrets.
- Data migration/backfill impact: Provider health TTL may apply to transient records only.
- Definition of done: Provider failures cannot silently create active recommendations.
- Risk: High.
- Approval required before merge: No.

#### FTE-025: Event Detail Odds Comparison

- Epic: Odds ingestion and market normalization.
- Outcome: The user can compare Hard Rock Florida prices against comparison books on an event.
- Context: UX requires Event Detail even though prototype lacks it as a distinct screen.
- In scope: Event Detail odds section, market tabs/groups, bookmaker odds cells, freshness badges, suspended/unavailable labels, Hard Rock emphasis.
- Out of scope: Opportunity qualification explanation if FTE-035 handles it, chart history.
- Dependencies: FTE-011, FTE-016, FTE-021, FTE-020.
- Acceptance criteria: Hard Rock odds are visually distinct; missing Hard Rock disqualifies applicable comparisons; stale/suspended/partial prices are labeled and excluded from active calculation.
- Required automated tests: UI component tests for market states and Playwright Event Detail smoke.
- Likely files/packages affected: `apps/web`, `apps/api`, `packages/ui`, `packages/database`.
- Observability: API query errors show recoverable states.
- Security: Auth required; no provider internals beyond approved metadata.
- Data migration/backfill impact: None.
- Definition of done: Event Detail exposes current odds comparison with data-quality states.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-026: Complete Odds History API and Chart-Series Projection

- Epic: Odds ingestion and market normalization.
- Outcome: Every stored price for a game can be retrieved as trustworthy, chart-ready history across all available sportsbooks.
- Context: Immutable snapshots are already stored per event version, market, selection, and sportsbook, but a graph must see one continuous game history rather than leak storage partitions into the user experience.
- In scope: authenticated odds-history API; event-version aggregation; market and selection filters; all-book or selected-book scope; provider-time ordering with deterministic tie-breaking; cursor pagination; opening/current markers; raw point, American-odds, and implied-probability values; stale, suspended, missing, and unavailable intervals; chart-series DTOs; display-only collapse of consecutive identical observations without deleting immutable evidence.
- Out of scope: Chart rendering, synthetic observations, destructive history compaction, and causal claims such as sharp/public action.
- Dependencies: FTE-021, FTE-025, FTE-027.
- Acceptance criteria: A request for an event, market, and selection returns a separately identified chronological series for every requested sportsbook; harmless canonical-event version changes do not split the game history; spread and total observations include both point and price; moneyline observations include American odds and deterministic implied probability; exact retries do not appear as duplicate points; repeated unchanged observations may be collapsed only in the projection and retain their first/last timestamps; tied provider timestamps have stable ordering; missing opening price is explicitly unavailable; stale, suspended, and missing-book intervals are represented without invented prices; pagination is stable with no skipped or repeated observations; raw immutable snapshots remain unchanged and have no TTL until a separately approved retention policy exists.
- Required automated tests: Repository and API contract tests covering multiple books, event-version changes, point and price changes, identical observations, timestamp ties, sparse histories, suspended gaps, missing books, pagination boundaries, authorization, and malformed cursors.
- Likely files/packages affected: `apps/api`, `packages/database`, `packages/domain`, `packages/odds`.
- Observability: API logs event, market, selection, requested/returned book counts, raw/projected point counts, page size, and latency without logging provider payloads.
- Security: Auth required.
- Data migration/backfill impact: No synthetic historical backfill before snapshot collection starts.
- Definition of done: A documented, authenticated API can reconstruct continuous, paginated, chart-ready multi-book history from all retained snapshots for a supported event market and selection.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-026A: Multi-Sportsbook Line Movement Graph

- Epic: Odds ingestion and market normalization.
- Outcome: The user can visually compare how the line and price moved across every available sportsbook for a game or match.
- Context: A single current-price table hides whether books moved together, which book led or lagged, and how the market evolved before the current price.
- In scope: Event Detail history panel; market and selection controls; sportsbook multi-select with all books enabled by default; Recharts step-line series with one stable color and label per sportsbook; shared time axis; opening and current markers; legend and hover/focus details; spread/total point view with associated American price; moneyline American-odds and implied-probability views; visible stale, suspended, and unavailable gaps; zoom or time-window controls for long histories; responsive desktop/tablet/mobile presentation; accessible tabular alternative containing the plotted values and timestamps.
- Out of scope: Live streaming animation, predictive trend lines, claims about sharp/public action, and editing or deleting snapshots.
- Dependencies: FTE-025, FTE-026, FTE-027.
- Acceptance criteria: The graph can display every sportsbook returned by the history API without merging their series; sportsbook identity remains clear when colors are unavailable; lines use step interpolation rather than smoothing; hovering or keyboard-focusing a time shows each available book's point, price, provider timestamp, collection timestamp, and freshness; spread/total users can distinguish movement of the point from movement of its price; moneyline users can switch between American odds and implied probability; missing data produces a gap rather than a connected or zero-valued line; opening/current states are labeled per book; filters and time window do not mutate underlying history; long histories remain usable; the accessible data table and chart expose equivalent information; reduced-motion and WCAG 2.1 AA requirements are met.
- Required automated tests: Component tests for all-book rendering, book filtering, point-versus-price views, American-odds/implied-probability switching, timestamp details, opening/current markers, identical projected values, sparse/suspended gaps, empty and single-point histories, large histories, keyboard access, reduced motion, and accessible data-table parity; Playwright Event Detail coverage at desktop and mobile widths.
- Likely files/packages affected: `apps/web`, `packages/ui`.
- Observability: Client reports safe chart-load failures and render latency without sending odds payloads or user interaction details.
- Security: Authenticated Event Detail only; rendered labels and API values are treated as untrusted display data.
- Data migration/backfill impact: None; the graph begins when real snapshot collection begins and never fabricates an opening line.
- Definition of done: Event Detail shows a responsive, accessible multi-line history graph where every available sportsbook can be compared over the full retained life of the game.
- Risk: Medium.
- Approval required before merge: No.

### Epic 5: Deterministic Betting Engine

#### FTE-027: Pure Odds Conversion and Implied Probability Functions

- Epic: Deterministic betting engine.
- Outcome: Core odds conversion and implied probability are deterministic and heavily tested.
- Context: These functions are the foundation for every EV, movement, and CLV calculation.
- In scope: American-to-decimal, decimal-to-American, implied probability, validation errors, precision rules.
- Out of scope: Consensus, EV, Kelly, React, AWS, provider DTOs.
- Dependencies: FTE-003.
- Acceptance criteria: Positive, negative, even, invalid, zero, and boundary odds cases match known formulas; package has no forbidden dependencies.
- Required automated tests: Unit/property-style tests for conversion round trips and invalid inputs.
- Likely files/packages affected: `packages/odds`.
- Observability: N/A for pure package.
- Security: Reject malformed inputs instead of coercing silently.
- Data migration/backfill impact: None.
- Definition of done: Pure package tests cover formulas and precision.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-028: Two-Way and Three-Way No-Vig Consensus

- Epic: Deterministic betting engine.
- Outcome: The engine can remove vig and compute fair probabilities for two- and three-outcome markets.
- Context: Soccer requires three-way moneyline in addition to two-way markets.
- In scope: two-way no-vig, three-way no-vig, weighted consensus, contributing-book validation, Hard Rock exclusion from its own consensus.
- Out of scope: EV lifecycle, UI, settings persistence.
- Dependencies: FTE-027, FTE-032.
- Acceptance criteria: Missing selections, stale books, suspended markets, too-few books, and outliers are handled by explicit result states; Hard Rock never contributes to consensus for a Hard Rock opportunity.
- Required automated tests: Unit tests for formula examples, weighted books, missing/stale/suspended handling, Hard Rock exclusion.
- Likely files/packages affected: `packages/odds`, `packages/domain`.
- Observability: N/A for pure package.
- Security: No external calls or dynamic code.
- Data migration/backfill impact: Algorithm version stored in future derived records.
- Definition of done: Consensus results are reproducible from input snapshots and config.
- Risk: High.
- Approval required before merge: No.

#### FTE-029: Fair Odds, EV, Expected Profit, Kelly, and Fractional Kelly

- Epic: Deterministic betting engine.
- Outcome: The engine can estimate edge and informational stake sizing from offered odds and fair probability.
- Context: MVP needs EV, expected profit, and fractional Kelly while avoiding autonomous bankroll management.
- In scope: fair odds conversion, EV, expected profit for stake, Kelly fraction, fractional Kelly with configurable fraction and display labels.
- Out of scope: Auto bet placement, bankroll automation, UI persuasion copy.
- Dependencies: FTE-027, FTE-028.
- Acceptance criteria: Outputs include calculation version, inputs, precision-safe numeric values, and display-rounded values; Kelly is labeled informational.
- Required automated tests: Unit tests for known EV/Kelly examples, invalid probabilities, negative EV, rounding boundaries.
- Likely files/packages affected: `packages/odds`.
- Observability: N/A for pure package.
- Security: Reject impossible probabilities and odds.
- Data migration/backfill impact: Future recommendation records store calculation version.
- Definition of done: Calculation package remains pure and test-covered.
- Risk: High.
- Approval required before merge: No.

#### FTE-030: Movement, CLV, Outlier, and Market Disagreement Functions

- Epic: Deterministic betting engine.
- Outcome: The engine can quantify line movement, closing line value, outliers, and disagreement.
- Context: PRD measures process quality through CLV and flags low-quality markets.
- In scope: line movement in odds/probability terms, CLV benchmark calculations, outlier detection, disagreement score, significant movement threshold helpers.
- Out of scope: Bet settlement UI, causal claims, machine learning.
- Dependencies: FTE-027, FTE-032.
- Acceptance criteria: Functions return reason codes and never claim sharp/public movement; sparse data returns insufficient-data states.
- Required automated tests: Unit tests for movement direction, CLV examples, outlier fixtures, disagreement thresholds, sparse data.
- Likely files/packages affected: `packages/odds`.
- Observability: N/A for pure package.
- Security: Deterministic functions only.
- Data migration/backfill impact: Calculation version stored by dependent records.
- Definition of done: Outputs are deterministic, explainable, and versioned.
- Risk: High.
- Approval required before merge: No.

#### FTE-031: Calculation Versioning, Precision, and Display Rounding

- Epic: Deterministic betting engine.
- Outcome: Every calculation can be audited and displayed consistently.
- Context: Stored recommendations and reports must remain explainable after algorithm changes.
- In scope: algorithm version identifiers, input hash strategy, decimal precision policy, display-boundary rounding helpers.
- Out of scope: Recalculation/backfill jobs.
- Dependencies: FTE-027, FTE-028, FTE-029, FTE-030.
- Acceptance criteria: Calculation results include algorithm version and display-safe rounded values; stored values preserve greater precision than display values.
- Required automated tests: Unit tests for version propagation, rounding edge cases, input hash stability.
- Likely files/packages affected: `packages/odds`, `packages/domain`.
- Observability: Version appears in derived logs/records when used by apps.
- Security: Input hashes do not include secrets or PII.
- Data migration/backfill impact: Future algorithm changes require migration/recalculation ADR.
- Definition of done: Consumers can distinguish stored precision from UI display.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-032: Spike - Consensus and Qualification Defaults

- Epic: Deterministic betting engine.
- Outcome: MVP consensus and qualification defaults are evidence-backed and configurable.
- Context: PRD leaves comparison books, weights, thresholds, outlier policy, and CLV benchmark open.
- In scope: Recommend defaults for comparison books, weights, minimum EV, maximum odds age, minimum books, outlier policy, market disagreement threshold, CLV benchmark, snapshot retention; produce ADR.
- Out of scope: Hardcoding irreversible constants, implementing settings UI.
- Dependencies: FTE-014, FTE-019.
- Acceptance criteria: ADR lists defaults, rationale, risks, and all values as configurable; Hard Rock exclusion is explicit.
- Required automated tests: None; research artifact review checklist required.
- Likely files/packages affected: `docs/adr/*`, `_bmad-output/planning-artifacts/*`.
- Observability: N/A.
- Security: Do not expose proprietary provider terms beyond permitted summary.
- Data migration/backfill impact: Determines initial calculation configuration and retention policy.
- Definition of done: Human-approved ADR exists before qualification ships.
- Risk: High.
- Approval required before merge: Yes.

### Epic 6: +EV Opportunity Lifecycle and Dashboard

#### FTE-033: Candidate Opportunity Creation and Qualification Rules

- Epic: +EV opportunity lifecycle and dashboard.
- Outcome: The system creates candidate opportunities and records qualification/disqualification reasons.
- Context: The Dashboard must show only active, qualified +EV opportunities.
- In scope: candidate generation from current prices, minimum EV, minimum books, maximum odds age, outlier handling, disagreement warning, Hard Rock requirement, reason codes.
- Out of scope: Dashboard UI, report generation, bet entry.
- Dependencies: FTE-021, FTE-028, FTE-029, FTE-032.
- Acceptance criteria: Every candidate has qualified or disqualified status with reasons; stale/suspended/missing Hard Rock cannot qualify; result stores calculation version and input snapshot refs.
- Required automated tests: Unit/integration tests for each qualification/disqualification path.
- Likely files/packages affected: `packages/domain`, `packages/odds`, `apps/workers`, `packages/database`.
- Observability: Counts of candidates, qualified, disqualified, and reason-code distributions.
- Security: No client-side authoritative qualification.
- Data migration/backfill impact: First run creates recommendation records from current odds.
- Definition of done: Qualification output is auditable from stored inputs.
- Risk: High.
- Approval required before merge: No.

#### FTE-034: Opportunity Lifecycle States and Expiration

- Epic: +EV opportunity lifecycle and dashboard.
- Outcome: Opportunities move safely through active, stale, suspended, disqualified, and closed states.
- Context: Stale opportunities must expire from active ranking automatically.
- In scope: lifecycle model, expiration worker/scheduler, closed event handling, stale odds sweep.
- Out of scope: Dashboard UI.
- Dependencies: FTE-033.
- Acceptance criteria: Opportunities expire when max age is exceeded; suspended/closed event states remove active visibility; state changes preserve audit trail.
- Required automated tests: Lifecycle transition tests and expiration worker tests.
- Likely files/packages affected: `packages/domain`, `apps/workers`, `packages/database`, `infra/cdk`.
- Observability: Expiration counts and stale active count metric.
- Security: Worker uses least-privilege table access.
- Data migration/backfill impact: Existing active opportunities may be marked stale on deployment.
- Definition of done: No stale opportunity remains in active query results.
- Risk: High.
- Approval required before merge: No.

#### FTE-035: Ranked Opportunity API and Explanation

- Epic: +EV opportunity lifecycle and dashboard.
- Outcome: The frontend can fetch ranked opportunities with clear explanation fields.
- Context: Users need to understand Hard Rock implied probability, market consensus, EV, confidence, and data quality.
- In scope: active opportunities API, ranking logic, filters, opportunity detail explanation, data-quality fields, warning badges.
- Out of scope: Dashboard layout if split to FTE-036.
- Dependencies: FTE-033, FTE-034.
- Acceptance criteria: API excludes stale/inactive opportunities; explanation includes Hard Rock odds/implied probability, consensus probability, fair odds, EV, confidence, contributing books, warnings, timestamps.
- Required automated tests: API handler/repository tests and ranking fixture tests.
- Likely files/packages affected: `apps/api`, `packages/database`, `packages/domain`.
- Observability: Query latency, active count, filtered count.
- Security: Auth required; no raw provider payloads returned.
- Data migration/backfill impact: None.
- Definition of done: API supports Dashboard and +EV Scanner needs.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-036: Dashboard Layout and +EV Opportunity Cards

- Epic: +EV opportunity lifecycle and dashboard.
- Outcome: The Dashboard answers "Where is the edge right now?"
- Context: Prototype has the strongest visual reference for this screen.
- In scope: KPI tiles, ranked opportunity cards/rows, no-edge state, provider/quota summary placeholders or data integration, watched events/recent report placeholders as available.
- Out of scope: Bet entry implementation, unsupported prototype Design routes, automatic scouting.
- Dependencies: FTE-011, FTE-035.
- Acceptance criteria: Cards distinguish Hard Rock implied probability, market consensus probability, estimated EV, confidence, and data quality; no-edge state is positive and non-promotional; Add Bet is disabled or routes only when Bet Tracker exists.
- Required automated tests: Component tests for opportunity card states and Playwright Dashboard smoke.
- Likely files/packages affected: `apps/web`, `packages/ui`.
- Observability: Query error, loading, empty, stale-data states are visible.
- Security: Protected route; no sensitive logs.
- Data migration/backfill impact: None.
- Definition of done: Dashboard uses live opportunity API and handles empty/error/loading states.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-037: Provider Health and Quota Dashboard States

- Epic: +EV opportunity lifecycle and dashboard.
- Outcome: Provider health and quota limitations are visible on the Dashboard and Data Sources route.
- Context: PRD requires provider outage/quota visibility and misleading recommendation suppression.
- In scope: provider health API, quota summary, status cards, stale/outage/partial states, Data Sources screen MVP view.
- Out of scope: Provider configuration changes unless covered in Settings.
- Dependencies: FTE-024, FTE-036.
- Acceptance criteria: Quota exhausted, provider outage, stale data, and partial responses have distinct UI states; active recommendations are suppressed or warned according to qualification state.
- Required automated tests: API tests for health status and UI tests for each state.
- Likely files/packages affected: `apps/api`, `apps/web`, `packages/database`, `packages/ui`.
- Observability: Provider health metrics align with UI state.
- Security: Do not reveal API keys, account identifiers, or sensitive plan data.
- Data migration/backfill impact: Health detail records may use TTL.
- Definition of done: The user can tell when provider state affects edge visibility.
- Risk: Medium.
- Approval required before merge: No.

### Epic 7: Manual Scouting Workflow

#### FTE-038: Scout Event API, Idempotent Job Model, SQS, and Step Functions

- Epic: Manual scouting workflow.
- Outcome: The user can request a manual scouting job without creating duplicates.
- Context: MVP requires manual Scout Event, not fully automated scouting schedules.
- In scope: API command, idempotency key, job states, SQS queue, Step Functions skeleton, duplicate prevention, retryable/non-retryable failure states.
- Out of scope: Production soccer enrichment provider, final AI report content.
- Dependencies: FTE-016, FTE-007.
- Acceptance criteria: Duplicate in-progress jobs for same event/inputs return existing job; queued/in-progress/completed/failed states persist; retry creates a new attempt when allowed.
- Required automated tests: API tests, repository conditional-write tests, workflow unit tests, CDK assertions for queue/DLQ/state machine.
- Likely files/packages affected: `apps/api`, `apps/workers`, `packages/scouting`, `packages/database`, `infra/cdk`.
- Observability: Job creation, duplicate, state transition, failure, retry metrics/logs.
- Security: Auth required; worker IAM least privilege.
- Data migration/backfill impact: None.
- Definition of done: Manual scouting jobs can be created and tracked with fixture-only processing.
- Risk: High.
- Approval required before merge: No.

#### FTE-039: Spike - Soccer Enrichment Provider Evaluation

- Epic: Manual scouting workflow.
- Outcome: The production soccer enrichment provider decision is evidence-backed.
- Context: Exact provider must remain unresolved until evaluated.
- In scope: Compare providers on coverage, fixtures, venues, lineups, injuries, suspensions, team/player/match stats, refresh speed, rate limits, pricing, licensing, provenance, historical data, integration complexity; produce ADR/recommendation.
- Out of scope: Selecting a provider without evidence; implementing production adapter.
- Dependencies: FTE-019.
- Acceptance criteria: ADR recommends provider or staged fallback strategy with evidence and risks; licensing and data provenance constraints are explicit.
- Required automated tests: None; research artifact review checklist required.
- Likely files/packages affected: `docs/adr/*`, `_bmad-output/planning-artifacts/*`.
- Observability: N/A.
- Security: Do not commit provider credentials or restricted contract terms.
- Data migration/backfill impact: Determines future enrichment schemas and backfill needs.
- Definition of done: Human-approved provider recommendation exists before production enriched scouting.
- Risk: High.
- Approval required before merge: Yes.

#### FTE-040: Provider-Backed Scouting Input Contract and Development Stub

- Epic: Manual scouting workflow.
- Outcome: Scouting can be developed against a clear input contract without pretending stub data is production data.
- Context: Provider choice is unresolved, but report workflow needs contracts.
- In scope: scouting input schema, verification statuses, source/provenance metadata, fixture-backed dev stub clearly marked non-production.
- Out of scope: Production provider implementation.
- Dependencies: FTE-038, FTE-039.
- Acceptance criteria: Every factual input supports provider/source, provider timestamp when available, collection timestamp, verification status, freshness, confidence; stub data is labeled fixture/dev only.
- Required automated tests: Schema validation tests for verified, inferred, stale, conflicting, unavailable, and malformed data.
- Likely files/packages affected: `packages/scouting`, `packages/providers`, `packages/test-utils`.
- Observability: Stub usage is logged in non-production only.
- Security: Fixtures contain no real secrets or restricted provider payloads.
- Data migration/backfill impact: Future provider adapter must map to this contract or version it.
- Definition of done: Report generation can accept validated fixture-backed inputs safely.
- Risk: High.
- Approval required before merge: No.

#### FTE-041: AI Report Provider Interface and Structured Report Schema

- Epic: Manual scouting workflow.
- Outcome: LLM-assisted reports are constrained by schema and cannot perform authoritative betting math.
- Context: PRD allows narrative synthesis only from verified inputs.
- In scope: AI provider interface, prompt/model version metadata, structured report JSON schema, fixed section order, validation, deterministic calculation boundary markers.
- Out of scope: Real provider credentials, final prompt optimization.
- Dependencies: FTE-040, FTE-031.
- Acceptance criteria: Required report sections are always present; invalid/missing unsupported facts become unavailable, stale, inferred, or conflicting; odds math fields must come from deterministic inputs.
- Required automated tests: Schema validation tests, hallucination-boundary fixture tests, section-order tests.
- Likely files/packages affected: `packages/scouting`, `packages/odds`.
- Observability: Report generation logs model/prompt version and validation failure reason without full sensitive input dump.
- Security: Prompt/input logging is redacted; no unsupported facts are promoted to verified.
- Data migration/backfill impact: Report schema version stored with versions.
- Definition of done: AI output must validate before persistence.
- Risk: High.
- Approval required before merge: No.

#### FTE-042: Report Persistence, Versioning, and Source Provenance

- Epic: Manual scouting workflow.
- Outcome: Completed scouting reports are stored immutably with versions and provenance.
- Context: Users must review historical reports and audit source freshness.
- In scope: report head/version records, large payload S3 pointer if needed, associated odds snapshot IDs, provider data used, model/prompt version, changes-from-previous metadata.
- Out of scope: Report UI.
- Dependencies: FTE-041.
- Acceptance criteria: New completed job creates a new report version; historical versions remain readable; source/provenance metadata is queryable.
- Required automated tests: Repository tests for version insertion, duplicate prevention, latest pointer, S3 pointer mapping if used.
- Likely files/packages affected: `packages/database`, `packages/scouting`, `apps/workers`.
- Observability: Report version created, validation failed, persistence failed metrics/logs.
- Security: Report payloads avoid storing secrets; access requires auth.
- Data migration/backfill impact: Existing reports require schema version if migrated later.
- Definition of done: Scouting jobs can persist and retrieve versioned report data.
- Risk: High.
- Approval required before merge: No.

#### FTE-043: Scouting Progress UI and Retry States

- Epic: Manual scouting workflow.
- Outcome: The user can see scouting job progress, failures, partial data, and retry options.
- Context: UX spec requires a standalone job state even though prototype only implies it.
- In scope: job state component/screen, queued/collecting/generating/calculating/complete/failed/partial/retry states, duplicate-job redirect.
- Out of scope: Final report rendering.
- Dependencies: FTE-038.
- Acceptance criteria: User-friendly labels avoid AWS terms; failed jobs show safe reason and retry availability; partial data is not shown as complete.
- Required automated tests: Component tests for each state and Playwright Scout Event flow with mocked API.
- Likely files/packages affected: `apps/web`, `apps/api`, `packages/ui`.
- Observability: API polling errors show retryable UI state.
- Security: Error details are safe for user display.
- Data migration/backfill impact: None.
- Definition of done: Manual Scout Event action leads to a clear progress surface.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-044: Scouting Report Screen, Versions, Sources, and PASS State

- Epic: Manual scouting workflow.
- Outcome: The user can review a structured, versioned scouting report with source evidence and PASS outcome.
- Context: Prototype includes high-fidelity report reference.
- In scope: report route, fixed section order, version selector, source display, freshness/verification badges, Market Edge, Risk Assessment, Final Plays, Nuke or Pass/PASS state.
- Out of scope: Unsupported claims, automated scouting schedules, production provider selection if unresolved.
- Dependencies: FTE-042, FTE-043.
- Acceptance criteria: All required sections render in order; unavailable sections remain visible; deterministic calculation values are labeled separately from narrative; PASS/no-bet state is valid and prominent.
- Required automated tests: Component tests for full/partial/stale report fixtures and Playwright report/version navigation.
- Likely files/packages affected: `apps/web`, `apps/api`, `packages/ui`, `packages/scouting`.
- Observability: Report load/validation errors display safe states.
- Security: Protected route; source URLs/data are sanitized for display.
- Data migration/backfill impact: None.
- Definition of done: Report detail matches UX spec without using prototype runtime.
- Risk: High.
- Approval required before merge: No.

### Epic 8: Watchlist and Change Tracking

#### FTE-045: Watchlist API Add and Remove

- Epic: Watchlist and change tracking.
- Outcome: The user can curate events for follow-up.
- Context: Watchlist supports dashboard prioritization and repeated review.
- In scope: add/remove/list watchlist API, conditional writes, user-scoped records, event existence validation.
- Out of scope: Alerts, automatic scouting schedules.
- Dependencies: FTE-016.
- Acceptance criteria: Add/remove are idempotent; watchlist is user-scoped; deleted/missing events return safe errors.
- Required automated tests: API/repository tests for add/remove/list/idempotency/auth.
- Likely files/packages affected: `apps/api`, `packages/database`, `packages/domain`.
- Observability: Watchlist mutation logs with event/user/correlation ID.
- Security: Auth required; user cannot mutate another user's watchlist.
- Data migration/backfill impact: None.
- Definition of done: Watchlist state is persisted and available to event queries.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-046: Watchlist Screen and Empty State

- Epic: Watchlist and change tracking.
- Outcome: The user can see watched events, report status, and changes since last visit.
- Context: Prototype has Watchlist as a placeholder; UX requires a real MVP surface.
- In scope: Watchlist route, watched events table/cards, empty state, event/report/status columns, remove action, add from Events/Event Detail.
- Out of scope: Push alerts, automatic scouting.
- Dependencies: FTE-018, FTE-045.
- Acceptance criteria: Empty state guides user to Events; watched events show kickoff, odds freshness, report status, lineup placeholder, last change; remove is undo-friendly or confirmed.
- Required automated tests: Component tests and Playwright add/remove/list flow.
- Likely files/packages affected: `apps/web`, `packages/ui`.
- Observability: Query/mutation failures are visible and recoverable.
- Security: Protected route.
- Data migration/backfill impact: None.
- Definition of done: Watchlist can be used for manual event prioritization.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-047: Watched-Event Change Tracking and Prioritization

- Epic: Watchlist and change tracking.
- Outcome: Watched events can surface meaningful changes since last visit.
- Context: PRD mentions odds movement, report status, lineup status placeholder, and watched-event prioritization.
- In scope: last-viewed timestamp, odds movement summary, report status change, lineup placeholder state, prioritization score for watched events.
- Out of scope: Real lineup provider until enrichment provider story completes, push notifications.
- Dependencies: FTE-026, FTE-042, FTE-045.
- Acceptance criteria: Changes since last visit are computed from stored records; lineup status is unavailable/future until provider supports it; prioritization reasons are visible.
- Required automated tests: Unit tests for change summary and API tests for last-viewed updates.
- Likely files/packages affected: `packages/domain`, `apps/api`, `apps/web`, `packages/database`.
- Observability: Change summary computation errors are logged with event ID.
- Security: User-scoped last-viewed data.
- Data migration/backfill impact: Existing watchlist items default last viewed to creation or null.
- Definition of done: Watchlist and Dashboard can prioritize watched events.
- Risk: Medium.
- Approval required before merge: No.

### Epic 9: Bet Tracker and Settlement

#### FTE-048: Manual Bet Entry with Opportunity or Report Source Link

- Epic: Bet tracker and settlement.
- Outcome: The user can record a placed bet manually with enough context for later evaluation.
- Context: MVP does not place sportsbook bets directly.
- In scope: bet domain model, create bet API, bet entry drawer/form, link to opportunity/report/manual source, sportsbook, event, market, selection, odds, stake, placed time, notes.
- Out of scope: Direct sportsbook bet placement, automatic settlement, bankroll automation.
- Dependencies: FTE-025, FTE-035, FTE-044.
- Acceptance criteria: Add Bet from opportunity/report pre-fills source fields; manual entry validates odds/stake/selection; created bet is open by default; copy avoids guaranteed-profit language.
- Required automated tests: Form validation tests, API tests, Playwright create-bet flow with source link.
- Likely files/packages affected: `packages/domain`, `apps/api`, `apps/web`, `packages/database`.
- Observability: Bet create logs source type, event ID, and validation errors without sensitive notes where inappropriate.
- Security: Auth required; user-scoped bet records.
- Data migration/backfill impact: None.
- Definition of done: Open manual bets can be created from product surfaces.
- Risk: High.
- Approval required before merge: No.

#### FTE-049: Bet Tracker Screen and Status Filters

- Epic: Bet tracker and settlement.
- Outcome: The user can review open and historical bets.
- Context: Prototype includes a Bet Tracker screen.
- In scope: Bet Tracker route, table/cards, filters by status/date/source/market, source deep links, open/won/lost/push/void/cashed-out statuses.
- Out of scope: Performance aggregates and settlement calculations if split.
- Dependencies: FTE-048.
- Acceptance criteria: Bets display sportsbook, event, market, selection, odds, stake, placed time, source, current status, result fields where available; empty state supports manual entry.
- Required automated tests: Component tests for filters/status chips and Playwright route smoke.
- Likely files/packages affected: `apps/web`, `apps/api`, `packages/ui`.
- Observability: Query errors show nonblank recoverable states.
- Security: Protected route and user-scoped API.
- Data migration/backfill impact: None.
- Definition of done: Bet Tracker can display and filter user bets.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-050: Manual Settlement, Payout, Profit/Loss, and Audit

- Epic: Bet tracker and settlement.
- Outcome: The user can settle bets and see deterministic financial results.
- Context: MVP settlement is manual only.
- In scope: settlement API/form, won/lost/push/void/cashed-out statuses, payout, profit/loss, ROI per bet, settlement history/audit.
- Out of scope: Sportsbook import, automatic settlement.
- Dependencies: FTE-049, FTE-027.
- Acceptance criteria: Settlement calculations are deterministic; changing settlement creates audit history; invalid settlement transitions are rejected.
- Required automated tests: Domain calculation tests, API transition tests, UI settlement form tests.
- Likely files/packages affected: `packages/domain`, `packages/odds`, `apps/api`, `apps/web`, `packages/database`.
- Observability: Settlement mutations logged with status transition and correlation ID.
- Security: User-scoped mutations; no destructive deletion of settlement audit.
- Data migration/backfill impact: Existing open bets remain open until manually settled.
- Definition of done: User can settle a bet and see correct P/L.
- Risk: High.
- Approval required before merge: No.

#### FTE-051: Closing Odds and CLV Integration

- Epic: Bet tracker and settlement.
- Outcome: Settled bets can show closing line value against the configured benchmark.
- Context: Success metrics emphasize CLV over short-term hit rate.
- In scope: closing line snapshot lookup, benchmark status, CLV calculation integration, unavailable/insufficient data state.
- Out of scope: Automatic settlement, advanced model calibration.
- Dependencies: FTE-026, FTE-030, FTE-050, FTE-032.
- Acceptance criteria: CLV uses configured benchmark; unavailable closing line is explicit; CLV is stored/displayed with calculation version.
- Required automated tests: Integration tests for closing snapshot lookup and CLV outputs across win/loss/push.
- Likely files/packages affected: `packages/odds`, `packages/database`, `apps/api`, `apps/web`.
- Observability: CLV missing-data counts and calculation errors logged.
- Security: Auth required.
- Data migration/backfill impact: Older bets may show CLV unavailable until closing snapshots exist.
- Definition of done: Bet Tracker rows show CLV where data exists and honest unavailable states otherwise.
- Risk: High.
- Approval required before merge: No.

### Epic 10: Performance and Settings

#### FTE-052: Performance Aggregates and Screen

- Epic: Performance and settings.
- Outcome: The user can review ROI and CLV process quality over meaningful segments.
- Context: PRD cautions against over-reading small samples.
- In scope: aggregates by period, market, competition, source, confidence bucket; Performance route; insufficient-sample warnings; Recharts visualizations.
- Out of scope: ML prediction, advanced bankroll analytics.
- Dependencies: FTE-050, FTE-051.
- Acceptance criteria: Performance displays ROI, P/L, average CLV, bet count, win/loss/push/void/cashed-out counts; small samples are clearly labeled.
- Required automated tests: Aggregate unit tests, API tests, chart rendering tests with empty/small/full samples.
- Likely files/packages affected: `packages/domain`, `packages/database`, `apps/api`, `apps/web`.
- Observability: Aggregate job/query latency and failure logs.
- Security: User-scoped data only.
- Data migration/backfill impact: Initial aggregate backfill for existing bets may be required.
- Definition of done: Performance route provides process metrics without overclaiming.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-053: User Settings for Sportsbook, Markets, Thresholds, Weights, and Timezone

- Epic: Performance and settings.
- Outcome: The user can configure MVP decision thresholds and display preferences.
- Context: Consensus defaults must be configurable and auditable.
- In scope: Settings API/UI for target sportsbook, comparison books, weights, enabled markets, minimum EV, maximum odds age, minimum books, outlier policy, disagreement threshold, CLV benchmark, timezone.
- Out of scope: Public user admin, automatic scouting schedules except disabled/future UI.
- Dependencies: FTE-032, FTE-020, FTE-033.
- Acceptance criteria: Settings validate ranges; updates are versioned/auditable; changes affect future calculations and do not silently rewrite historical recommendations.
- Required automated tests: Schema tests, API optimistic-lock tests, UI form validation tests.
- Likely files/packages affected: `packages/domain`, `apps/api`, `apps/web`, `packages/database`.
- Observability: Settings update audit logs with changed keys, not secret values.
- Security: Auth required; settings are user-scoped.
- Data migration/backfill impact: Existing settings get initialized from approved defaults.
- Definition of done: User can safely view and update configurable MVP defaults.
- Risk: High.
- Approval required before merge: Yes.

#### FTE-054: Future Automatic Scouting Preferences Placeholder

- Epic: Performance and settings.
- Outcome: Settings can acknowledge future automation without enabling it in MVP.
- Context: Prototype mentions automatic scouting; PRD excludes fully automated scouting schedules.
- In scope: Disabled/future-facing UI section, explanatory copy, feature flag default off.
- Out of scope: Scheduler implementation, automatic scouting jobs, alerts.
- Dependencies: FTE-053.
- Acceptance criteria: Controls are disabled or clearly marked future; no scheduler or backend action is created; copy does not imply current automation.
- Required automated tests: UI tests assert controls disabled and no mutation occurs.
- Likely files/packages affected: `apps/web`, `packages/ui`.
- Observability: None.
- Security: No hidden automation endpoints.
- Data migration/backfill impact: None.
- Definition of done: Future feature is visible only as non-functional planning affordance.
- Risk: Low.
- Approval required before merge: No.

### Epic 11: Reliability, Security, and Production Readiness

#### FTE-055: Structured Logging, Correlation IDs, Metrics, and Alarms

- Epic: Reliability, security, and production readiness.
- Outcome: API, worker, provider, and calculation flows are traceable in production.
- Context: Provider failures and data-quality issues must be diagnosable.
- In scope: observability package, correlation ID propagation, JSON logs, metrics, alarms for provider failure, DLQ depth, stale active opportunities, job failures.
- Out of scope: Full external APM contract unless chosen later.
- Dependencies: FTE-024, FTE-034, FTE-038.
- Acceptance criteria: Core flows emit correlation IDs; alarms exist for DLQ/provider/stale/job failure; logs redact secrets and token values.
- Required automated tests: Logger redaction tests, metric emission tests, CDK alarm assertions.
- Likely files/packages affected: `packages/observability`, `apps/api`, `apps/workers`, `infra/cdk`.
- Observability: This story creates the shared observability baseline.
- Security: Redaction is mandatory and tested.
- Data migration/backfill impact: None.
- Definition of done: Production incidents have enough logs/metrics to trace failures.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-056: Secrets, IAM, Encryption, Throttling, and Audit Hardening

- Epic: Reliability, security, and production readiness.
- Outcome: Production resources follow least-privilege and private-app security practices.
- Context: Provider keys, auth, and betting data require careful handling.
- In scope: Secrets Manager usage, IAM policy review, table/S3 encryption, API throttling, CORS, audit log retention, dependency/license scanning.
- Out of scope: Compliance certification.
- Dependencies: FTE-008, FTE-023, FTE-038, FTE-048.
- Acceptance criteria: No provider secret in env files or frontend; IAM policies are scoped by resource/action; API throttling configured; security checklist passes.
- Required automated tests: CDK assertions for encryption/IAM/throttling and secret reference tests.
- Likely files/packages affected: `infra/cdk`, `packages/config`, `.github/workflows/*`.
- Observability: Security-relevant denies/errors are logged safely.
- Security: This story is primarily security hardening.
- Data migration/backfill impact: Existing resources may require replacement or migration if encryption policies change.
- Definition of done: Human-reviewed security checklist and passing automated assertions.
- Risk: High.
- Approval required before merge: Yes.

#### FTE-057: E2E Regression, Accessibility, and Provider-Outage Test Suite

- Epic: Reliability, security, and production readiness.
- Outcome: The MVP has automated coverage for the critical private betting workflow and failure states.
- Context: Future Codex automation needs confidence before merging changes.
- In scope: Playwright critical path tests, axe/accessibility checks where practical, provider outage/stale/no-edge/partial-data scenarios, responsive checks.
- Out of scope: Exhaustive visual regression unless added later.
- Dependencies: FTE-036, FTE-044, FTE-049, FTE-052.
- Acceptance criteria: Tests cover login, dashboard, events, event detail, scouting report, bet entry, settlement, performance, stale/provider failure states; no critical accessibility violations in tested routes.
- Required automated tests: This story creates the E2E/a11y suite.
- Likely files/packages affected: `apps/web`, `packages/test-utils`, Playwright config.
- Observability: Test artifacts attached on CI failure.
- Security: Test data contains no real credentials or real stakes beyond fixtures.
- Data migration/backfill impact: None.
- Definition of done: CI fails on critical workflow regression.
- Risk: Medium.
- Approval required before merge: No.

#### FTE-058: Production Deployment, Rollback, Cost, and Release Checklist

- Epic: Reliability, security, and production readiness.
- Outcome: The private MVP can be deployed, monitored, and rolled back safely.
- Context: Final readiness story before production use.
- In scope: CloudFront/S3 deploy, API/worker deploy, environment promotion, rollback notes, cost guardrails, release checklist, smoke tests.
- Out of scope: Public launch, subscriptions, multi-user admin.
- Dependencies: FTE-055, FTE-056, FTE-057.
- Acceptance criteria: Production deployment is documented and repeatable; rollback path is documented; smoke tests pass; cost/quota alarms exist.
- Required automated tests: Deployment synth tests, smoke test command, release checklist validation where possible.
- Likely files/packages affected: `infra/cdk`, `.github/workflows/*`, `docs/release-checklist.md`.
- Observability: Deployment emits version/commit metadata; smoke test confirms health.
- Security: Human review before production deployment; secrets injected through approved store.
- Data migration/backfill impact: Release checklist includes migration/backfill step review.
- Definition of done: Human-approved private MVP release is ready.
- Risk: High.
- Approval required before merge: Yes.

## 7. Initial Sprint Status Recommendation

Only FTE-001 should start as `ready`. All other stories should remain `backlog` until their dependencies and approval gates are satisfied. FTE-002 may become ready immediately after FTE-001 is complete.

## 8. Human Approval Gates

Stories requiring human approval before merge:

- FTE-008: Cognito Private Authentication Infrastructure.
- FTE-019: Spike - Initial Soccer Competitions Allowlist.
- FTE-032: Spike - Consensus and Qualification Defaults.
- FTE-039: Spike - Soccer Enrichment Provider Evaluation.
- FTE-053: User Settings for Sportsbook, Markets, Thresholds, Weights, and Timezone.
- FTE-056: Secrets, IAM, Encryption, Throttling, and Audit Hardening.
- FTE-058: Production Deployment, Rollback, Cost, and Release Checklist.

## 9. Prototype Alignment Notes

Features shown in the prototype and represented in stories:

- Dashboard: FTE-036, FTE-037.
- Events Explorer: FTE-018.
- +EV Scanner/opportunity ranking: FTE-033, FTE-034, FTE-035, FTE-036.
- Scouting Report: FTE-038 through FTE-044.
- Bet Tracker: FTE-048 through FTE-051.
- Data Sources/provider health: FTE-024, FTE-037.
- Performance: FTE-052.
- Settings: FTE-053, FTE-054.

MVP features required but missing or placeholder-only in the prototype:

- Login, logout, password reset, session expiration: FTE-008 through FTE-010.
- Event Detail as its own workflow: FTE-025.
- Scouting job progress screen: FTE-043.
- Watchlist screen and change tracking: FTE-045 through FTE-047.
- Odds history chart: FTE-026.
- Production infrastructure, auth, persistence, provider ingestion, and deterministic calculation packages: multiple backend stories.

Decorative or post-MVP prototype elements:

- Design System and Documentation routes are prototype-only.
- Automatic scouting is future-facing only in FTE-054.
- Any demo odds math in `support.js` is non-authoritative and must not be reused.

## 10. Readiness Review

- PRD traceability: Stories cover FR-001 through FR-067 areas: private auth, events, odds snapshots, deterministic math, +EV dashboard, scouting, odds history, watchlist, bet tracker, ROI/CLV, settings, provider health, and failure states.
- Architecture alignment: Stories preserve package boundaries, DynamoDB, serverless AWS, provider adapters, current projection, and deterministic domain packages.
- UX alignment: Stories implement the shell, Dashboard, Events, Event Detail, Scouting Report, Bet Tracker, Watchlist, Performance, Data Sources, Settings, and state coverage described in the UX spec.
- Soccer-first: All ingestion and scouting scope remains soccer-first.
- Prototype containment: Prototype visuals inform UI stories but do not add post-MVP scope.
- Testability: Each story includes acceptance criteria and required automated tests or, for spikes, review artifacts.
- Deterministic math: Calculation stories are pure and outside LLM/provider/UI boundaries.
- Provider provenance: Scouting and odds stories require source, timestamp, freshness, confidence, and verification states.
- Soccer enrichment unresolved: FTE-039 keeps provider choice explicitly unresolved until approved.
