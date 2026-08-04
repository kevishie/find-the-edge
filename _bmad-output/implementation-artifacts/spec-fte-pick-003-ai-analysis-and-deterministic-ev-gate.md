---
title: 'FTE-PICK-003 AI Analysis, Deterministic +EV Qualification, and No-Bet Gate'
type: 'feature'
created: '2026-08-03T23:55:00-04:00'
status: 'in-review'
baseline_revision: '4321ed1'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0B-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-pick-001-reproducible-evaluation-and-paper-bet-records.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-pick-002-sport-rule-analysis-contracts.md'
warnings: [oversized, multiple-goals]
---

<intent-contract>

## Intent

**Problem:** Verified events, prices, and sport-analysis contracts still cannot produce an auditable paper Play or No Bet because there is no runtime composition layer, exact evaluation-evidence reader, model capability boundary, or deterministic qualification gate.

**Approach:** Add a callable, scheduler-independent evaluation service that assembles exact immutable evidence, invokes an injected structured-analysis adapter only when evidence permits, validates its output, computes consensus/no-vig/EV and every gate in deterministic code, then persists either the immutable PICK-001 ledger record or a separate immutable attempt result when no honest probability manifest exists.

## Boundaries & Constraints

**Always:** Strongly resolve CURRENT only to locate and then reread exact immutable snapshots; exclude target book from comparison consensus; require complete two/three-way vectors and versioned weights/minimum books/outlier/freshness/uncertainty/conservative-probability policies; validate model output exclusively through PICK-002; persist Play/No Bet exclusively through PICK-001; record pre-model abstention, model failure/timeout, and invalid output in an immutable attempt ledger without fabricating probability; use stable reason codes; exact retries converge; all logs/metrics are safe metadata; production defaults to model-disabled until an approved server-side adapter is configured.

**Block If:** Enabling a new paid model/provider or selecting vendor credentials is required; target/comparison sportsbook policy cannot be resolved from versioned config; a valid ledger record would require invented probability/evidence.

**Never:** Let model output supply or override odds conversion, consensus, no-vig, EV, thresholds, eligibility, decision, or reason authority; reference mutable CURRENT keys in manifests; create a Play from stale/partial/unsupported/live inputs; schedule runs (PICK-004); place bets, size bankroll, log prompts/raw evidence/raw output, or turn failures into a fake 0.5 probability.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Qualified Play | Fresh exact offered/comparison evidence, complete enrichment, valid cited analysis, conservative EV passes | Atomic Play evaluation + paper bet | Exact retry returns duplicate |
| Deterministic No Bet | Valid analysis but EV/edge/uncertainty/freshness/consensus gate fails | Immutable No Bet evaluation with authoritative reasons | No paper bet |
| Pre-model abstain | Missing hard evidence, planned/prohibited sport/market, event started | No model call; immutable attempt terminal result | No fabricated manifest |
| Model invalid/failure | Timeout, throw, wrong candidate/version/citation/schema | Immutable invalid/failed attempt | No evaluation or paper bet |
| Evidence invalid | Missing offered selection, incomplete vector, sparse/stale/outlier-only comparison | No Play; deterministic reason | Fail closed |
| Replay/change | Same semantic inputs, reordered books/evidence, or later odds/model/prompt/strategy | Same identity for same inputs; new identity for material change | Conflict on forged identity |

</intent-contract>

## Code Map

- `packages/database/src/fixture-odds-adapter.ts` -- current/exact snapshot storage shapes and strong-read gateway.
- `packages/database/src/evaluation-evidence-repository.ts` -- new exact offered/comparison evidence reader port and memory/Dynamo implementations.
- `packages/scouting/src/model-adapter.ts` -- new structured model capability port and deterministic fake; no vendor SDK.
- `packages/odds/src/qualification.ts` -- new pure consensus/EV/gating authority.
- `packages/domain/src/evaluation-attempt.ts` -- new immutable non-manifest terminal attempt record for abstain/invalid/failed outcomes.
- `packages/database/src/evaluation-attempt-repository.ts` -- append-only idempotent attempt persistence.
- `apps/workers/src/pick-evaluation.ts` -- orchestration service with injected ports, safe metrics, and terminal outcomes.

## Tasks & Acceptance

**Execution:**
- [x] `packages/config` strategy/evaluation policy -- define versioned target book, comparison weights, minimum books, outlier/freshness/uncertainty/edge/EV thresholds, and conservative range transform; include decision-driving values in manifest provenance/thresholds.
- [x] `packages/database/src/evaluation-evidence-repository.ts` plus tests -- strongly resolve canonical current items to exact immutable snapshots, validate event/version/market/selection/book/vector identity, exclude target book, and report explicit stale/sparse/incomplete states.
- [x] `packages/scouting/src/model-adapter.ts` plus tests -- define bounded structured analysis request/response/usage port and fake adapter; distinguish logical model version from deployment ID; default production-disabled adapter fails closed without paid calls.
- [x] `packages/odds/src/qualification.ts` plus exhaustive tests -- calculate weighted two/three-way consensus, conservative probability, no-vig comparison, decimal/implied odds, EV, and stable gates without accepting model-authored calculations.
- [x] `packages/domain/src/evaluation-attempt.ts` and database repository/tests -- append immutable, hashed, idempotent attempted/abstained/invalid/failed terminal metadata when a truthful PICK-001 probability manifest cannot exist; prohibit secrets/raw payloads.
- [x] `apps/workers/src/pick-evaluation.ts` plus fixtures/tests -- compose registry/strategy/evidence/request/prompt/model/validation/qualification/ledger in order; skip model for planned/evidence abstention; persist exactly one authoritative terminal result; emit safe logs/metrics.
- [x] Fixture matrix -- cover MLB two-way and soccer three-way Play; negative EV, high uncertainty, reduced/abstain, stale offered/comparison, sparse/incomplete market, prohibited market, started event, adapter throw/timeout, invalid output, duplicates, book/evidence reordering, and material version/price changes.
- [x] Package exports/dependencies and `_bmad-output/implementation-artifacts/sprint-status.yaml` -- expose service/contracts and advance only after review.

**Acceptance Criteria:**
- Given stale, partial, unsupported, sparse, or live evidence, when evaluated, then no Play is persisted and the stable deterministic reason is observable.
- Given valid model output containing any EV/no-vig/decision field, when validated, then it is rejected rather than trusted.
- Given identical semantic manifests, when retried, then one evaluation/paper pair exists and the retry is duplicate.
- Given valid analysis but nonpositive/below-threshold deterministic EV or excessive uncertainty, when qualified, then a reproducible No Bet is persisted.
- Given complete fixture evidence and passing conservative EV, when MLB or soccer is evaluated, then a reproducible Play with exact offered snapshot, probability, EV, uncertainty, reasons, and all versions is persisted.
- Given pre-model abstention or model failure/invalid output, when the run terminates, then a truthful immutable attempt record exists and no probability/evaluation/paper bet is fabricated.
- Given production has no approved model adapter, when called, then it fails closed with model-disabled and performs no external paid call.

## Spec Change Log

## Review Triage Log

### 2026-08-04 — Review hardening pass

- `intent_gap`: 0
- `bad_spec`: 0
- `patch`: 10 (`high`/`medium` findings fully addressed)
- `defer`: 0
- `reject`: 0
- Canonicalized selection order and bound terminal identity to every exact resolved evidence snapshot.
- Rejected duplicate books, duplicate selections, malformed two/three-way vectors, future evidence, and non-finite/incomplete policy controls.
- Preserved full comparison outcome evidence, included-book IDs, exact weights, outlier threshold, and conservative transform in the immutable decision manifest.
- Added stable outlier reporting, complete evidence failure reasons, model/evidence envelope failure attempts, isolated telemetry, and durable terminal claims preventing attempt/evaluation conflicts.

## Design Notes

The evaluation service is callable application logic only; PICK-004 owns scheduling. The immutable attempt ledger is deliberately separate from the PICK-001 analyzed decision ledger because an absent/invalid model probability cannot honestly satisfy that manifest. Fixtures use an injected fake adapter; adding a live vendor adapter is a separately approved operational choice.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/odds test`
- `pnpm --filter @find-the-edge/scouting test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm check`
- `git diff --check`

## Dev Agent Record

### Completion Notes

- Added a versioned evaluation policy with explicit target book, weighted comparison books, freshness, outlier, uncertainty, edge, EV, and conservative-probability controls.
- Added strong CURRENT-to-immutable evidence resolution, complete outcome-vector validation, target-book exclusion, and explicit stale/sparse/incomplete states.
- Added a production-disabled structured model port, deterministic fake, PICK-002-only output validation, timeout/failure handling, and safe usage metadata.
- Added pure two/three-way no-vig consensus and conservative +EV qualification, including reduced-analysis, outlier, uncertainty, freshness, edge, and minimum-book gates.
- Added immutable memory and Dynamo attempt ledgers for truthful abstained, invalid, and failed outcomes, plus the scheduler-independent evaluation service that persists PICK-001 Play/No Bet records.

### Verification Results

- Config: 18 tests passed.
- Domain: 39 tests passed.
- Database: 155 tests passed.
- Scouting: 42 tests passed.
- Odds: 42 tests passed.
- Workers: 111 tests passed.
- `pnpm check`: passed after implementation (format, lint, boundaries, typecheck, tests, builds).
- `git diff --check`: passed.

## File List

- `packages/config/src/evaluation-policy.ts`
- `packages/config/src/index.ts`
- `packages/domain/src/evaluation-attempt.ts`
- `packages/domain/src/evaluation-attempt.test.ts`
- `packages/domain/src/paper-evaluation.ts`
- `packages/domain/src/index.ts`
- `packages/database/src/evaluation-evidence-repository.ts`
- `packages/database/src/evaluation-evidence-repository.test.ts`
- `packages/database/src/evaluation-attempt-repository.ts`
- `packages/database/src/evaluation-attempt-repository.test.ts`
- `packages/database/src/dynamodb-evaluation-attempt-repository.ts`
- `packages/database/src/dynamodb-evaluation-attempt-repository.test.ts`
- `packages/database/src/evaluation-terminal-repository.ts`
- `packages/database/src/evaluation-terminal-repository.test.ts`
- `packages/database/src/dynamodb-evaluation-terminal-repository.ts`
- `packages/database/src/dynamodb-evaluation-terminal-repository.test.ts`
- `packages/database/src/fixture-odds-adapter.ts`
- `packages/database/src/index.ts`
- `packages/scouting/src/model-adapter.ts`
- `packages/scouting/src/model-adapter.test.ts`
- `packages/scouting/src/index.ts`
- `packages/odds/src/qualification.ts`
- `packages/odds/src/qualification.test.ts`
- `packages/odds/src/index.ts`
- `apps/workers/src/pick-evaluation.ts`
- `apps/workers/src/pick-evaluation.test.ts`
- `apps/workers/src/index.ts`
- `apps/workers/package.json`
- `pnpm-lock.yaml`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
