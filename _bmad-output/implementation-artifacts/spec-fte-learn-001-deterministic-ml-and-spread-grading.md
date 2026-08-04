---
title: 'FTE-LEARN-001 Deterministic ML and Spread Grading'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'b316bea'
final_revision: '5a7cae5'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0C-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-004-completed-event-result-ingestion-and-correction-history.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-pick-001-reproducible-evaluation-and-paper-bet-records.md'
warnings: [oversized, multiple-goals]
---

<intent-contract>

## Intent

**Problem:** Official final results and immutable paper bets exist, but eligible moneyline and spread picks cannot be settled reproducibly, corrected results cannot append regrades, and current pick manifests lack enough participant/market/scope context for honest grading.

**Approach:** Add versioned decision-time grading terms, pure sport-owned deterministic grading, exact result/odds evidence reads, an event-indexed paper-bet discovery path, and an append-only grade/current projection that safely replays duplicates and appends official corrections.

## Boundaries & Constraints

**Always:** Grade only Play paper bets against exact immutable offered odds and exact authoritative result observations; preserve ordered away/home participants, event version, two/three-way structure, and regulation/full-event scope in the decision hash; calculate outcomes and one-unit P/L deterministically; append won/lost/push/void/unresolved grades; treat official corrections as immutable regrades linked to prior grades; strongly reread current only to locate exact evidence; paginate without Scan; isolate per-pick unsupported outcomes while surfacing corruption; keep production result scheduling disabled until an authoritative adapter is approved.

**Block If:** A sportsbook-specific settlement rule, production result source/participant mapper, or migration source for legacy paper bets cannot be resolved from retained versioned evidence. Legacy ambiguity must remain unresolved rather than guessed.

**Never:** Use AI/LLMs or subjective judgment for grading; default ties, missing scope, legacy terms, postponements, unknown selections, or mismatched participants to loss; mutate a prior grade, result, paper bet, evaluation, or odds snapshot; grade No Bet/shadow records; use CURRENT identities in grade provenance; Scan for paper bets; ingest sportsbook settlements; grade props/live markets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Moneyline final | Exact 2-way/3-way terms and ordered scores | Selected winner loses/wins; draw wins only in 3-way | Two-way tie is unresolved |
| Spread final | Selected team score plus exact stored point | Positive adjusted margin wins, negative loses, zero pushes | Missing/non-finite point unresolved |
| Cancel/no-contest | Authoritative terminal cancellation | Void, zero profit, returned stake | Postponed remains unresolved |
| Scope mismatch | Overtime/extra innings with regulation-only terms, or unknown scope | Unresolved with stable reason | Never infer from score |
| Duplicate result | Same paper bet/result/policy replay | Exact duplicate and same current grade | Conflict on same identity/different content |
| Official correction | New authoritative result observation/version | Append regrade with supersedes link; advance current | Stale authority cannot replace current |
| Legacy bet | Missing grading terms or event index | Append unresolved if explicitly supplied/backfilled | No regular-path Scan or inferred terms |

</intent-contract>

## Code Map

- `packages/domain/src/paper-evaluation.ts` -- decision-time participant order, market structure, result scope, and event-version terms.
- `packages/domain/src/paper-grade.ts` -- immutable grade/regrade identity, exact evidence, financial invariants, and safe provenance.
- `packages/odds/src/grading.ts` -- pure outcome and one-unit profit/payout/ROI calculations.
- `packages/sports/src/{shared,mlb,soccer}` -- explicit versioned supported result scopes and sport grading adapters.
- `packages/database/src/paper-evaluation-repository.ts` -- append-only event index for paper-bet discovery.
- `packages/database/src/paper-grading-evidence-repository.ts` -- strong exact paper/evaluation/odds/result evidence reader.
- `packages/database/src/paper-grade-repository.ts` -- memory append-only history/current contract.
- `packages/database/src/dynamodb-paper-grade-repository.ts` -- transactional correction/current advancement and audit pagination.
- `apps/workers/src/paper-grading.ts` -- bounded per-result grading/regrading service.
- `apps/workers/src/completed-result-orchestrator.ts` -- invoke grading after every persisted/replayed current result for crash repair.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/{paper-evaluation,paper-grade}.ts` and tests -- bind grading terms into new decision hashes and define strict immutable grade/regrade records with exact result/odds references, financial invariants, supersession, canonical IDs, and safe legacy-unresolved behavior.
- [x] `packages/odds/src/grading.ts` and table/property tests -- implement deterministic 2/3-way moneyline and spread win/loss/push/void/unresolved grading plus American-price one-unit profit, payout, and ROI without clocks or persistence.
- [x] `packages/sports/src/shared` plus MLB/soccer adapters/tests -- own versioned supported market/result-scope rules; planned/unsupported sports return unresolved without core sport conditionals.
- [x] `packages/database/src/paper-evaluation-repository.ts`, Dynamo implementation, and contract tests -- transactionally index only paper bets by event with bounded cursor pagination, exact replay verification, partial-state detection, concurrency safety, and no Scan.
- [x] `packages/database/src/paper-grading-evidence-repository.ts` and tests -- strongly resolve stored exact paper/evaluation/odds/result references and reject CURRENT, mismatched, future, missing, or substituted evidence.
- [x] `packages/database/src/{paper-grade-repository,dynamodb-paper-grade-repository}.ts` and parity/race tests -- append exact idempotent grades, conditionally advance current by result authority, preserve correction history/supersedes ordinal, reject stale/conflicting/partial state, and paginate audit history.
- [x] `apps/workers/src/pick-evaluation.ts` and fixtures/tests -- populate exact grading terms from the registered sport/market candidate before PICK-001 persistence.
- [x] `apps/workers/src/paper-grading.ts`, completed-result integration, and tests -- page event paper bets, grade exact current observations, repair result-written/grade-missing crashes on duplicate replay, isolate supported unresolved picks, emit safe counters/reasons, and never regrade from stale input.
- [x] `infra/cdk`, exports/runbook, end-to-end fixture, and sprint status -- grant exact transactional/index permissions, alarm grading failures/unresolved/regrades, document replay/backfill, prove final then correction history/P&L, and advance only after review.

**Acceptance Criteria:**
- Given complete exact moneyline or spread evidence, when an official final arrives, then every eligible paper bet receives the deterministic outcome and reproducible one-unit P/L.
- Given a tie, push, cancellation, postponement, missing scope/terms/point, mismatched participants, or unsupported rule, when graded, then it becomes push/void/unresolved according to explicit rules and never silently lost.
- Given an exact result replay or post-result/pre-grade crash, when processing retries, then one grade exists and missing grading is repaired without duplicating history.
- Given an official correction, when its higher-authority exact observation becomes current, then a linked immutable regrade advances current while the original grade remains unchanged.
- Given a stale result observation, when processing occurs, then it cannot replace or regrade the authoritative current grade.
- Given a No Bet, shadow evaluation, or unindexed/legacy record, when normal grading runs, then no fabricated paper settlement is created and no Scan occurs.

## Spec Change Log

- 2026-08-04: Implemented deterministic grading, immutable correction history, exact evidence resolution, event-indexed discovery, result replay repair, alarms, and operational guidance while retaining the disabled production results boundary.

## Review Triage Log

### 2026-08-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 16: (high 12, medium 4, low 0)
- defer: 0
- reject: 3
- addressed_findings:
  - `[high]` `[patch]` Recomputed exact replays and routed them through repository persistence so CURRENT and immutable HISTORY are strongly verified instead of trusted by result ID alone.
  - `[high]` `[patch]` Made Dynamo grade replay, stale classification, transaction-race recovery, current/history partial-state detection, and memory parity explicit and regression-tested.
  - `[high]` `[patch]` Bound grading to the exact paper/evaluation odds keys, snapshot ID, sport, canonical event version, result identity, index value, and requested event.
  - `[high]` `[patch]` Closed grade identifiers, result-authority ordering, policy reason codes, outcome finances, and impossible two-way draw selections.
  - `[high]` `[patch]` Validated Dynamo event-index rows and both event-index and grade-history cursors before pagination.
  - `[high]` `[patch]` Added Dynamo transaction/race/corruption coverage and a real in-memory Play-to-final-to-correction fixture proving retained P/L history and supersession.
  - `[medium]` `[patch]` Added bounded failure-reason counters and an EMF telemetry adapter whose namespace/metric names exactly match the grading alarms.
  - `[medium]` `[patch]` Added direct completed-result duplicate-replay hook coverage and public worker exports.

### 2026-08-04 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 9, medium 3, low 0)
- defer: 1
- reject: 1
- addressed_findings:
  - `[high]` `[patch]` Added a direct exact-result index with memory/Dynamo parity, replay repair, and a regression proving exact reads never traverse result history.
  - `[high]` `[patch]` Fenced CURRENT again after the exact result read so a concurrent official correction cannot grade against stale evidence.
  - `[high]` `[patch]` Bound manifest grading terms to the manifest market and closed legal outcome/reason/financial combinations.
  - `[high]` `[patch]` Included event, evaluation, exact odds, exact result authority, and policy provenance in recursive canonical grade identity.
  - `[high]` `[patch]` Enforced correction paper identity, exact prior-current supersession, and ordinal progression in memory and Dynamo repositories.
  - `[high]` `[patch]` Required adapter event identity plus finite, safe, nonnegative integer final scores.
  - `[high]` `[patch]` Required exact decision-time odds evidence even for void outcomes; settlement state cannot bypass evidence validation.
  - `[medium]` `[patch]` Returned and emitted bounded per-pick failure audits containing only a safe code and canonical paper-bet ID.
  - `[medium]` `[patch]` Distinguished missing terms on supported legacy sports from genuinely unsupported sport grading.
- deferred_findings:
  - `[high]` `[defer]` Pre-index completed-result history requires a bounded authoritative replay/backfill before grading; the runbook now makes this rollout prerequisite explicit.
- rejected_findings:
  - `[high]` `[reject]` Enabling a production result runtime or schedule conflicts with the story's explicit boundary and remains intentionally disabled.

## Design Notes

The event paper-bet index is written atomically with the Play evaluation/paper bet so grading never scans hash-partitioned evaluations. New manifests include grading terms; legacy records remain readable but grade unresolved unless an explicit bounded migration supplies retained evidence. A correction is a new grade keyed by the new exact result observation and points to the prior current grade. Postponed is unresolved because sportsbook-specific settlement imports are out of scope.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- 44 tests passed.
- `pnpm --filter @find-the-edge/odds test` -- 49 tests passed.
- `pnpm --filter @find-the-edge/sports test` -- 17 tests passed.
- `pnpm --filter @find-the-edge/database test` -- 172 tests passed.
- `pnpm --filter @find-the-edge/workers test` -- 128 tests passed.
- `pnpm --filter @find-the-edge/infra-cdk test` -- 8 tests passed.
- `pnpm check` -- formatting, lint, boundaries, 15-package typecheck, tools typecheck, all tests, and all 15 builds passed.
- `git diff --check` -- passed.

## Auto Run Result

### Summary

Implemented exact, deterministic paper-bet grading for MLB and soccer moneyline/spread decisions. Every grade binds to immutable decision-time odds and authoritative result evidence, uses reproducible one-unit P/L, and preserves official corrections as linked append-only regrades.

### Review Findings

- Applied 16 review patches: 12 high-consequence correctness/data-integrity fixes and 4 medium observability/pagination/integration fixes.
- Deferred 0 findings.
- Rejected 3 findings that conflicted with the explicit disabled production-results boundary or were repaired by bounded result replay rather than expanding this story's lifecycle.
- Independent follow-up review is recommended because the review materially hardened evidence identity, Dynamo transaction races, replay behavior, telemetry, and audit pagination.

### Residual Risk

Production completed-result ingestion and its EventBridge schedule intentionally remain disabled until an authoritative results adapter and exact participant mappings are approved. Legacy paper bets without retained grading terms/event indexes remain unresolved and require an explicit bounded evidence-backed migration; no terms are inferred. Pre-index completed-result observations must be replayed through normal result persistence (or equivalently backfilled in a bounded job) before exact grading reads are enabled.
