---
title: 'FTE-PICK-002 Sport-Rule Analysis Contracts for ML and Spread'
type: 'feature'
created: '2026-08-03T23:10:00-04:00'
status: 'in-review'
baseline_revision: '3d158fe'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0B-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-pick-001-reproducible-evaluation-and-paper-bet-records.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Generic scouting prompts cannot safely analyze materially different MLB and soccer moneyline/spread markets, and current contracts do not enforce evidence completeness, candidate fidelity, bounded probability/uncertainty, citations, abstention, or prompt-injection isolation.

**Approach:** Add executable, versioned sport-owned analysis policies plus strict scouting request/output validation and deterministic trusted-prompt/untrusted-evidence framing. Enable fixture-valid MLB and soccer contracts while tennis, NFL, and NBA fail closed as planned modules.

## Boundaries & Constraints

**Always:** Keep deterministic code authoritative for odds conversion, no-vig, EV, qualification, and Play/No Bet; require exact candidate echo and legal market/selection structure; bind every factual assertion to known evidence or an explicit inference/stale/conflicting/unavailable classification; force abstention for missing hard evidence and reduced maturity for time-conditional/soft gaps; distinguish two-way/three-way soccer moneyline and finite spread points; treat provider evidence as bounded untrusted data; version contract, prompt section, input/output schema, and model references; use canonical `spread` (MLB display “Run Line”); make prompt/bundle hashes independent of semantic-set input order; planned modules never invoke a model or validate complete output.

**Block If:** Required sport evidence semantics have more than one defensible interpretation; production readiness would require a new paid provider; canonical market migration would orphan persisted evidence without a compatibility path.

**Never:** Calculate or accept model-supplied EV/no-vig/qualification, analyze props, fabricate injuries/lineups/evidence, interpolate raw provider prose into trusted instructions, accept arbitrary client prompt text, treat line movement/splits as proof of sharp action, claim planned sports are production-ready, or permit guarantees/locks/risk-free claims.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Complete MLB/MLS | Legal candidate, verified hard evidence, bounded cited output | Valid complete analysis | No error |
| Evidence gap | Missing hard or conditional-near-start evidence | Abstain with deterministic missing-evidence codes | Reject complete/reduced output |
| Early lineup gap | Lineup unavailable before enforcement window | Reduced maturity | Record warning/missing category |
| Candidate/probability violation | Invented selection, illegal draw, missing spread point, reversed/wide/out-of-range probability or uncertainty | No validated output | Stable validation code |
| Citation violation | Unknown citation, uncited factual assertion, or verified claim cites nonverified evidence | No validated output | Stable citation code |
| Planned sport | Tennis/NFL/NBA request or claimed complete output | Deterministic planned-module-disabled abstention | Never invoke model |
| Injection payload | Evidence contains instructions, delimiters, control chars, tokens, or raw payload wrappers | Inert canonical JSON frame or input rejection | Trusted bundle/candidate unchanged |

</intent-contract>

## Code Map

- `packages/sports/src/shared/contracts.ts` -- sport module and market contract spine.
- `packages/sports/src/{mlb,soccer}/definition.ts` -- executable sport rules and market identities.
- `packages/sports/src/planned/definitions.ts` -- safe planned sport modules; add NBA.
- `packages/sports/src/registry.ts` -- module registration without core-conditionals.
- `packages/providers/src/coverage-registry.ts` -- align canonical `spread` coverage.
- `packages/scouting/src/index.ts` -- existing prompt composition compatibility surface.
- `packages/scouting/src/analysis-contract.ts` -- new bounded request/output/evidence validators.
- `packages/scouting/src/prompt-bundle.ts` -- new deterministic prompt sections and untrusted evidence framing.
- `prompts/shared`, `prompts/analysis`, `prompts/sports` -- versioned trusted instruction sources.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sports/src/shared/contracts.ts` and `shared/analysis.ts` -- define readonly versioned analysis policies for eligible markets/selections, evidence requirements, probability/uncertainty bounds, contraindications, prohibited claims, citations, schemas, prompt section, and planned behavior; attach to SportModule.
- [x] `packages/sports/src/mlb/definition.ts`, `soccer/definition.ts`, and strategy/coverage declarations -- implement MLB/MLS policies, migrate `run_line` to canonical `spread`, keep MLB strategy prohibition separate from mechanical support, add soccer spread and two/three-way draw rules.
- [x] `packages/sports/src/planned/definitions.ts`, registry, prompt/model metadata -- register planned tennis/NFL/NBA contracts that deterministically disable analysis; preserve NCAAF without substituting it for NBA.
- [x] `packages/sports/src/analysis-contract.test.ts` and registry/provider tests -- cover executable contracts, market migration, legal selections, strategy prohibition, planned abstention, NBA registration, and honest maturity.
- [x] `packages/scouting/src/analysis-contract.ts` -- strictly normalize bounded plain evidence/requests/outputs; enforce candidate fidelity, evidence timing/completeness, probability/range/uncertainty, assertion citations/classification, prohibited claims, safe fields, and deterministic validation codes.
- [x] `packages/scouting/src/prompt-bundle.ts` and `index.ts` -- require one section per kind, normalize/order/hash trusted sections, length-frame canonical sorted evidence separately, and expose deterministic analysis prompts without breaking existing callers.
- [x] `packages/scouting/src/fixtures/*`, analysis/prompt tests, and snapshots -- cover complete MLB/soccer, early/near-start lineup gaps, missing optional/hard evidence, illegal markets/selections, bounds, citations, inference, prohibited claims, planned modules, duplicate sections, ordering stability, delimiter/control-character injection, and secrets/raw wrappers.
- [x] `prompts/shared/evidence-safety.md`, `prompts/shared/analysis-output-contract.md`, `prompts/analysis/moneyline-spread.md`, and sport prompt updates -- state enforceable bounded instructions and sport-specific evidence rules; update prompt/model READMEs.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- advance FTE-PICK-002 only after verification and review.

**Acceptance Criteria:**
- Given complete fixture evidence, when MLB or soccer output echoes a legal ML/spread candidate with bounded probability and cited assertions, then validation succeeds deterministically.
- Given required evidence is missing, stale, or unavailable, when output claims completeness, then validation fails and the derived status is abstain or reduced maturity according to the versioned timing rule.
- Given an unsupported/invented selection or unbounded confidence, when normalized, then it is rejected with a stable code.
- Given any factual assertion, when it lacks a known evidence citation, then it is rejected unless explicitly classified as inference/stale/conflicting/unavailable.
- Given semantically identical trusted sections/evidence in different input order, when composed, then prompt text and SHA-256 hashes are identical.
- Given injection content in evidence, when framed, then it remains inert data and cannot alter trusted sections, schema, candidate, or hash semantics.
- Given tennis, NFL, or NBA, when analysis is requested, then the contract returns planned-module-disabled abstention without accepting complete output.

## Spec Change Log

- 2026-08-03: Hardened the implementation after adversarial review without changing the intent contract.

## Review Triage Log

### 2026-08-03 — Review hardening pass

- `intent_gap`: 0
- `bad_spec`: 0
- `patch`: 20 (`high`: 12, `medium`: 8, `low`: 0)
- `defer`: 0
- `reject`: 2 duplicated/no-action observations
- Patched policy/request/output version binding, evidence freshness and category validation, canonical assertion summaries, abstention reason completeness, uncertainty arithmetic, spread-point constraints, prohibited-claim matching, prompt-bundle integrity, structured trust boundaries, executable contraindications, cyclic-input guards, and canonical market compatibility across application boundaries.
- Rejected one duplicate legacy-run-line migration observation already covered by canonical boundary compatibility and one duplicate prompt-delimiter observation already covered by the structured trust-boundary patch; neither required an additional code change.

### 2026-08-03 — Final convergence pass 2

- `intent_gap`: 0
- `bad_spec`: 0
- `patch`: 7 (`high`: 5, `medium`: 2, `low`: 0)
- `defer`: 0
- `reject`: 0
- Bound the trusted request envelope to the normalized input hash, deterministic reason codes, full strategy state, candidate/evidence provenance hashes, and contract versions.
- Unified evidence freshness/conflict decisions across completeness and citations; failed closed for unresolved category conflicts and non-pregame boundaries.
- Completed legacy three-way-moneyline compatibility with canonical moneyline output, restricted abstention reasons, and hardened Sharp futures filtering for null or omitted participants.

## Design Notes

Sports own analysis policy; scouting owns generic validation and framing. Canonical markets use `moneyline` and `spread`; league-specific names are display metadata only. Hard evidence gaps abstain. Conditional lineup/XI gaps reduce maturity before a configured pregame boundary and abstain inside it. Prompt evidence is canonical JSON sorted by stable evidence ID and placed in a length-prefixed untrusted frame; no delimiter is interpreted.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/sports test`
- `pnpm --filter @find-the-edge/providers test`
- `pnpm --filter @find-the-edge/scouting test`
- `pnpm check`
- `git diff --check`

## Dev Agent Record

### Debug Log

- Loaded the epic context and PICK-001 immutable-ledger contract before implementation.
- Preserved legacy `run_line` as an analysis input alias while making new MLB module, strategy, provider, and coverage declarations canonical `spread`.
- Hardened plain-data validation against future evidence, nested/raw/secret-like material, invented candidates, unbounded probabilities, citation mismatches, and prohibited claims.
- Kept trusted prompt hashes independent from canonical, length-framed untrusted evidence and verified semantic-set order stability.
- Applied all 20 enforceable review findings and consolidated two duplicate/no-action observations without broadening the immutable intent contract.
- Applied the seven final convergence findings while preserving the intent contract and all earlier hardening.

### Completion Notes

- MLB and soccer now own executable, versioned moneyline/spread analysis policies with explicit evidence maturity and legal selection mechanics.
- Tennis, NFL, and NBA are registered as planned modules that fail closed and reject complete scout output; NCAAF remains independently registered.
- Deterministic validation and prompt framing preserve PICK-001 behavior and leave EV, no-vig, qualification, and Play/No Bet authority outside the model.
- Focused sport, provider, and scouting suites plus the repository-wide quality gate pass. Story is ready for adversarial review.
- Review hardening now binds policy/schema/prompt/model identity end to end, rejects stale or cyclic evidence deterministically, and preserves canonical spread semantics through providers, persistence, workers, and web surfaces.
- Final convergence binds deterministic request identity into model-visible trusted framing, aligns citation and completeness evidence decisions, and rejects live/completed pregame-analysis requests.

## File List

- `packages/sports/src/shared/analysis.ts`
- `packages/sports/src/shared/contracts.ts`
- `packages/sports/src/shared/create-module.ts`
- `packages/sports/src/mlb/definition.ts`
- `packages/sports/src/soccer/definition.ts`
- `packages/sports/src/planned/definitions.ts`
- `packages/sports/src/registry.ts`
- `packages/sports/src/registry.test.ts`
- `packages/sports/src/analysis-contract.test.ts`
- `packages/sports/src/index.ts`
- `packages/config/src/feed-coverage.ts`
- `packages/providers/src/coverage-registry.ts`
- `packages/providers/src/coverage-registry.test.ts`
- `packages/providers/src/the-odds-api.ts`
- `packages/providers/src/sharp-api.ts`
- `packages/providers/src/sharp-api.test.ts`
- `packages/providers/src/fixtures/mvp-odds.ts`
- `packages/database/src/games-repository.ts`
- `packages/database/src/games-repository.test.ts`
- `apps/workers/src/sharp-api-ingestion.ts`
- `apps/workers/src/sharp-api-ingestion.test.ts`
- `apps/workers/src/fixture-odds-seed.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `packages/scouting/src/analysis-contract.ts`
- `packages/scouting/src/analysis-contract.test.ts`
- `packages/scouting/src/fixtures/analysis.ts`
- `packages/scouting/src/prompt-bundle.ts`
- `packages/scouting/src/prompt-bundle.test.ts`
- `packages/scouting/src/__snapshots__/prompt-bundle.test.ts.snap`
- `packages/scouting/src/index.ts`
- `prompts/shared/evidence-safety.md`
- `prompts/shared/analysis-output-contract.md`
- `prompts/analysis/moneyline-spread.md`
- `prompts/sports/mlb.md`
- `prompts/sports/soccer.md`
- `prompts/sports/tennis.md`
- `prompts/sports/nfl.md`
- `prompts/sports/nba.md`
- `prompts/README.md`
- `models/README.md`
- `strategies/mlb/find-the-edge-v2.1.json`
- `strategies/soccer/find-the-edge-v1.json`
- `scripts/phase1-environment-smoke.mjs`
- `scripts/phase1-environment-smoke.test.mjs`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/spec-fte-pick-002-sport-rule-analysis-contracts.md`

## Change Log

- 2026-08-03: Implemented sport-owned ML/spread analysis contracts, strict scouting validation, deterministic injection-safe prompt bundles, planned NBA registration, canonical spread migration, and full contract tests; moved story to review.
- 2026-08-03: Addressed 20 adversarial-review findings, recorded two duplicate/no-action rejections, expanded cross-boundary canonical spread migration, and recommended a follow-up review.
- 2026-08-03: Applied final convergence pass 2 with seven patches (five high, two medium), no gaps, deferrals, or rejections; retained follow-up review recommendation.

## Status

In Review

## Auto Run Result

### Summary

Added executable, versioned MLB and soccer moneyline/spread analysis contracts; strict evidence, candidate, probability, citation, abstention, contraindication, and freshness validation; deterministic trusted prompt bundles with separately framed untrusted evidence; and fail-closed planned tennis, NFL, and NBA behavior. Canonical market compatibility now reaches provider, persistence, worker, UI, strategy, and smoke-test boundaries.

### Review Findings

- Review pass 1: 20 patches (12 high, 8 medium), 2 duplicate/no-action rejections.
- Final convergence pass: 7 patches (5 high, 2 medium), no gaps, deferrals, or rejections.
- Follow-up review recommended: true because review materially hardened cross-sport policy identity, evidence trust, prompt provenance, persistence compatibility, and pregame safety.

### Verification

- Sports: 12 tests passed.
- Providers: 42 tests passed.
- Scouting: 40 tests passed.
- Phase-one smoke unit coverage: 8 tests passed.
- `pnpm check`: passed.
- `git diff --check`: passed.

### Residual Risks

- Production MLB/soccer analysis must still abstain until PICK-003 supplies verified enrichment and invokes a model through these contracts.
- Legacy market aliases are accepted only at compatibility boundaries; all newly persisted and returned identities are canonical.
