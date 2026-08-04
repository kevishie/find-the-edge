# Epic 0B Context: Versioned AI Paper-Pick Pipeline

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn verified event, market, and price evidence into reproducible Play or No Bet decisions that can be audited after odds, models, prompts, sport modules, calculations, or strategies change. AI contributes structured sport-specific analysis and bounded probability estimates; deterministic code retains authority over odds conversion, vig removal, expected value, eligibility, qualification, and the decision recorded in the immutable paper ledger.

## Stories

- Story FTE-PICK-001: Reproducible Evaluation and Paper-Bet Records
- Story FTE-PICK-002: Sport-Rule Analysis Contracts for ML and Spread
- Story FTE-PICK-003: AI Analysis, Deterministic +EV Qualification, and No-Bet Gate
- Story FTE-PICK-004: Scheduled Shadow and Paper-Pick Runs

## Requirements & Constraints

- Every evaluation must preserve its exact decision-time manifest: immutable offered-price evidence, candidate and selection, estimated probability or range, no-vig comparison, expected value, thresholds, uncertainty, decision reason, input hash, provenance, and all applicable sport-module, strategy, model, calculation, input-schema, and prompt-bundle versions.
- Historical decisions and paper bets are immutable. Later odds, strategy, prompt, or model versions must not rewrite them, and identical manifests must hash consistently and remain idempotent. Historical replay is a labeled backtest, not a decision-time paper play.
- Play and No Bet are equally valid first-class outcomes. Missing, stale, partial, conflicting, unsupported, or insufficient evidence must abstain or reduce maturity rather than force a recommendation. No Bet and disqualification reason codes must remain observable.
- Sport analysis follows versioned module-owned contracts for eligible markets, required and optional evidence, probability bounds, uncertainty, contraindications, citations, prohibited claims, and abstention. Initial executable contracts cover MLB and soccer; planned sports fail safely until enabled.
- Provider content is untrusted data. Structured model output must be schema-validated, bounded, citation-aware, and never executed. Each factual assertion links to verified evidence or is explicitly marked inferred, stale, conflicting, or unavailable.
- Deterministic code alone performs authoritative odds conversion, vig removal, EV, price qualification, and decision gating. Model output cannot override failed freshness, evidence, market, uncertainty, or positive-EV checks.
- Scheduled automation is limited to explicitly approved sport, league, and strategy combinations in shadow or paper mode. It must enforce eligibility windows, replay protection, concurrency and cost ceilings, retry-safe idempotency, and a kill switch that fails closed.
- Real-money placement, autonomous bankroll sizing, arbitrary client-submitted prompts, automatic strategy promotion, and tuning on future results are outside this epic. Real-money mode remains disabled and requires a separately approved release.
- Local contract and fixture tests must not require paid provider, AI, or infrastructure access. Logs and metrics may expose safe version IDs, hashes, decisions, reason codes, evidence completeness, latency, token use, cost, quota, and failures, but never credentials, provider keys, or licensed raw payloads.

## Technical Decisions

- Shared evaluation infrastructure is sport-agnostic and keyed by stable sport, league, event, participant, market, selection, strategy, and model identifiers. Sport-specific mechanics and analysis contracts live in registered, versioned sport modules; product thresholds and allowed markets live in separately versioned strategies.
- AI is optional and composable. Prompt construction combines shared, sport, strategy, and analysis-type sections, while deterministic pricing and qualification stay in pure domain logic independent of prompts, providers, React, or AWS.
- Persist operational and immutable evaluation records with DynamoDB-compatible, access-pattern-first models. Use conditional writes and content or manifest hashes for duplicate prevention; preserve append-oriented audit history rather than mutating prior evidence or decisions.
- Asynchronous evaluation uses the AWS serverless workflow direction: EventBridge scheduling, SQS buffering with failure isolation, Step Functions orchestration where multi-step control is needed, and workers with explicit retry and terminal states. Scheduled runs maintain a run ledger and must not create duplicate decisions on retry.
- All boundary inputs and structured model outputs require runtime validation. Provider and model adapters remain behind capability-specific interfaces, and model credentials stay server-side in Secrets Manager under least-privilege worker roles.
- Version identifiers and provenance are part of the domain record, not incidental log metadata. Observability must support evaluation, Play, No Bet, invalid, failure, cost, quota, kill-switch, and reason-code analysis by sport, league, strategy, and run.

## UX & Interaction Patterns

- Present the experience as a controlled intelligence terminal, not a sportsbook, casino, or picks-selling product. Evidence precedes persuasion, and PASS or No Bet is displayed as a successful disciplined outcome.
- Keep probability, confidence, expected value, and data quality visually distinct. Reserve green for verified positive EV or positive process outcomes; use amber for aging or incomplete evidence, red for unsafe/error states, and purple for brand emphasis and primary actions.
- Label AI-assisted content as interpretation and pair it with citations and evidence status. Label deterministic outputs as calculations and expose their algorithm or version through progressive disclosure.
- Default views should remain concise while showing decision, freshness, confidence, and warnings. Expanded detail should reveal source, provider timestamp, collection timestamp, provenance, unavailable evidence, calculation version, model version, prompt version, and decision reasons.

## Cross-Story Dependencies

- FTE-PICK-001 depends on registered sport modules, strategy configuration, and production odds evidence; it establishes the immutable records and hashing used by all later stories.
- FTE-PICK-002 depends on the sport-module contract and evidence spine and supplies the validated analysis contracts required by FTE-PICK-003.
- FTE-PICK-003 composes FTE-PICK-001 records, FTE-PICK-002 analysis, and deterministic strategy qualification into idempotent Play or No Bet decisions.
- FTE-PICK-004 schedules only the evaluation pipeline completed by FTE-PICK-003 and depends on approved runtime controls and foundational deployment infrastructure.
- Result grading, cohort performance, retrospective learning, and strategy promotion consume this epic's immutable paper records in later epics and must never alter decision-time inputs.
