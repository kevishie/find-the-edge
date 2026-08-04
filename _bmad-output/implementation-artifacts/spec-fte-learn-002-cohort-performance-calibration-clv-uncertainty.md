---
title: 'FTE-LEARN-002 Cohort Metrics, Calibration, CLV, and Uncertainty'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'bf594ea'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0C-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-learn-001-deterministic-ml-and-spread-grading.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003-multi-sport-odds-collection-policy-and-snapshot-jobs.md'
warnings: [oversized, multiple-goals]
---

<intent-contract>

## Intent

**Problem:** Immutable evaluations and grades exist, but users cannot tell whether a strategy is profitable, calibrated, beating closing prices, or merely showing a noisy hit rate because there is no reproducible cohort/report model or Performance UI.

**Approach:** Freeze versioned paper cohorts from bounded indexes and exact immutable evidence, compute deterministic price-aware performance/calibration/CLV/uncertainty/drawdown reports, persist append-only revisions, expose strict read-only APIs, and replace the placeholder Performance page with an evidence-first dashboard.

## Boundaries & Constraints

**Always:** Define UTC half-open cohort windows and exact sport/league/market/odds-band/strategy/model/wager-mode filters; hash normalized definitions and sorted exact members; freeze exact grade/result/opening/closing evidence at a cutoff; expose every denominator; treat unavailable metrics as null with reasons; average decimal odds, not American odds; use versioned Wilson hit-rate intervals, approximate ROI intervals, Brier/ECE deciles, deterministic drawdown, and a 15-minute same-book/same-line pregame CLV freshness rule; bind scheduled start and future point probability into new decision manifests while legacy calibration uses the actual conservative low probability; make corrections create new report revisions; paginate without Scan; scope existing records as system paper only; show small-sample and missing-CLV states honestly.

**Block If:** A money/user-owner scope, closing-line definition, odds-band policy, formula version, or migration source is not represented by trusted server-owned versioned configuration. Do not infer closing evidence or ownership.

**Never:** Make causal claims; automatically tune/promote strategies; expose a public leaderboard; convert missing CLV/confidence/calibration to zero; average American odds; use mutable CURRENT pointers in frozen manifests; recalculate authoritative metrics in the browser; Scan for paper bets/grades/odds; expose licensed raw payloads, secrets, prompts, or arbitrary storage keys; fabricate money-mode data.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Frozen cohort | Trusted definition, indexed Plays, exact evidence | Stable cohort hash/members/report across page sizes/retries | Conflict on same identity/different content |
| Mixed outcomes | W/L/P/V/unresolved grades | Explicit counts; win rate W/(W+L); ROI units/(W+L+P) | Zero denominator returns null reason |
| Calibration | Point probability or legacy conservative low plus W/L | Brier, decile buckets, Wilson intervals, ECE | Push/void/unresolved excluded |
| Closing line | Latest active same-book/event/version/market/selection/point within 15m pre-start | Price and implied-probability CLV | Missing/stale/post-start/gap is null reason |
| Correction | Higher-authority grade after prior report | New immutable report revision | Prior cohort/report remains readable |
| Small sample | Fewer than 30 decisions | Metrics plus `insufficient` caution and wide/null intervals | Never imply established performance |

</intent-contract>

## Code Map

- `packages/domain/src/cohort.ts` -- normalized cohort definitions, exact members, immutable report identity/provenance.
- `packages/domain/src/paper-evaluation.ts` -- scheduled start and persisted model point probability for future reports.
- `packages/odds/src/performance.ts` -- pure denominators, profitability, EV, Wilson/ROI intervals, calibration, CLV, uncertainty, and drawdown.
- `packages/database/src/paper-evaluation-repository.ts` -- atomic paper-bet UTC-day index and bounded query.
- `packages/database/src/{cohort,performance-evidence,closing-odds}-repository.ts` -- frozen build/report storage and exact evidence ports.
- `apps/workers/src/{cohort-builder,performance-report}.ts` -- deterministic freeze/build/compute/persist orchestration.
- `apps/api/src/handler.ts` -- strict read-only cohort report/member endpoints.
- `apps/web/src/{api,App,styles}.ts*` -- Performance route, filters, metric cards, calibration/drawdown, and provenance states.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/cohort.ts`, `paper-evaluation.ts`, and tests -- define canonical definitions/members/reports and persist scheduled start, point probability, wager mode, exact evidence IDs, cutoff, versions, membership digest, and immutable revision identity.
- [x] `packages/odds/src/performance.ts` and golden/property tests -- implement documented denominators, units/ROI/EV/decimal-average/break-even, Wilson and approximate ROI intervals, Brier/ECE deciles, uncertainty summaries, deterministic drawdown, odds bands, and null reasons.
- [x] `packages/database/src/paper-evaluation-repository.ts` plus memory/Dynamo contracts -- atomically index paper Plays by UTC decision day, validate opaque filter-bound pagination, verify index on replay, detect partial state, and provide bounded no-Scan date queries/backfill guidance.
- [x] `packages/database/src/{performance-evidence,closing-odds}-repository.ts` and tests -- strongly resolve exact evaluation/grade/result/open evidence; select latest qualifying active same-book/same-line snapshot within 15 minutes before scheduled start; return bounded CLV unavailable reasons for gaps, point changes, legacy, stale, or post-start evidence.
- [x] `packages/database/src/{cohort,dynamodb-cohort}-repository.ts` and race/pagination tests -- append canonical definition/member/final/report rows, finalize only against exact count/digest, preserve correction revisions, reject partial/conflicting/tampered state, and never Scan.
- [x] `apps/workers/src/{cohort-builder,performance-report}.ts` and end-to-end fixtures -- freeze membership/evidence as of cutoff, compute pure reports, persist idempotently, emit safe source/grade/CLV/sample/latency/failure metrics, and prove correction creates a new report without rewriting old.
- [x] `apps/api` handler/lambda/infra tests -- add authenticated scoped list/detail/member endpoints with strict server filters, DTO validation, opaque pagination, bounded reads, 404/corruption/500 behavior, and no authoritative math. Product-owner-approved public Performance reads supersede authentication for those routes only.
- [x] `apps/web/src/{api,App,styles}.ts*` and tests -- make Performance a real responsive route with filters, units/ROI/odds/EV/CLV cards, explicit W/L/P/V/unresolved denominators, Wilson interval, calibration/Brier/ECE, uncertainty, cumulative-units/drawdown, dimension facets, version provenance, accessible loading/error/empty/small-sample/missing-data states.
- [x] Runbook/backfill, exports/dependencies, infrastructure alarms, and sprint status -- document pre-index replay, correction revisions, CLV trust prerequisites, expose safe query-latency/build/failure metrics, and advance only after review.

**Acceptance Criteria:**
- Given the same versioned definition, cutoff, and exact evidence, when built under different pagination/retry orders, then cohort membership, hash, metrics, and report ID are identical.
- Given W/L/P/V/unresolved mixtures or empty denominators, when reported, then documented counts, win rate, ROI, units, EV, odds, and null reasons are mathematically correct.
- Given small or sparse samples, when viewed, then Wilson/ROI intervals and caution state remain visible without certainty claims.
- Given forecast probabilities and outcomes, when aggregated, then Brier, decile calibration, ECE, and uncertainty use only eligible exact records and expose their counts.
- Given trustworthy matching pregame closing evidence, when CLV is calculated, then both price and implied-probability movement are reproducible; otherwise CLV is null with a stable reason, never zero.
- Given an official correction, when rebuilding at a later cutoff, then a new report revision references the corrected exact grade while the old report remains unchanged.
- Given the Performance route, when data loads or is empty/partial/unavailable, then the UI distinguishes hit rate, profitability, calibration, CLV, uncertainty, and drawdown with exact provenance and accessible states.

## Spec Change Log

- 2026-08-04: Added the canonical cohort model, deterministic price-aware metric engine, immutable in-memory report contract, strict closing-line selector, build orchestration, read-only API surface, responsive Performance dashboard, and operating guidance. Production persistence/runtime wiring remains review-visible work.
- 2026-08-04: Applied the product owner's newer public-access directive to Performance reads. This intentionally overrides the older authenticated-read wording while retaining strict read-only filters, validation, and no secret/raw-evidence exposure.

## Review Triage Log

- 2026-08-04: Closed identity/cutoff findings: report identity and digest bind cohort members, decisions, revision, and cutoff; exact evidence timestamps and opening/closing dimensions are cutoff-validated; canonical external IDs are enforced.
- 2026-08-04: Closed persistence/query findings: append-only Dynamo cohort rows, created-time/revision report ordering, opaque bound pagination, repeated-cursor detection, bounded evidence concurrency, and decision-day no-Scan cohort traversal are implemented.
- 2026-08-04: Closed API/UI findings: deeply validated metric DTOs, honest empty state, Wilson and ROI intervals, break-even, implied-probability CLV, cumulative units, facets, and provenance are rendered; a route-specific performance-reports alarm and builder success/failure metrics were added.
- 2026-08-04: Follow-up review pass repaired production generation and integrity gaps: exact snapshot indexing/materialization, scheduled Lambda/EventBridge composition, atomic report/index persistence, referential validation, correction revisions, stored-row validation, CLV reason propagation, strict routes, reproducibility guards, and deployed EMF monitoring. No Scan/current-pointer fallback was introduced.
- 2026-08-04 — Review pass
  - intent_gap: 0
  - bad_spec: 0
  - patch: 18: (high 7, medium 10, low 1)
  - defer: 0
  - reject: 3: (high 0, medium 2, low 1)
  - addressed_findings:
    - `[high]` `[patch]` Bound immutable report identity and evidence resolution to exact IDs, revision, cutoff, event/market/selection/book/point, and correction lineage.
    - `[high]` `[patch]` Added exact snapshot indexing, production cohort/evidence materializers, scheduled Lambda/EventBridge deployment, and server-owned versioned policy.
    - `[high]` `[patch]` Made report and listing persistence atomic, referentially validated, corruption-detecting, and deterministically ordered.
    - `[high]` `[patch]` Added no-Scan reproducibility guards, strict opaque pagination, cursor-cycle detection, and bounded evidence concurrency.
    - `[medium]` `[patch]` Preserved detailed CLV unavailable reasons and exposed complete uncertainty, calibration, drawdown, facets, and provenance through API and UI.
    - `[medium]` `[patch]` Hardened runtime enum, outcome, identifier, query, timestamp, nested DTO, and stored-row validation.
    - `[medium]` `[patch]` Connected builders to EMF metrics and aligned route/build/report alarms with the deployed runtime.

## Design Notes

Win-rate denominator is wins+losses. ROI denominator is resolved exposure wins+losses+pushes. Voids and unresolved are excluded from both. Estimated EV includes every frozen decision. Calibration uses persisted point probability for new records and the actual conservative interval low for legacy records; it never invents a midpoint. CLV uses `openingDecimal/closingDecimal-1` and `closingImplied-openingImplied`; positive means the selected opening beat the close. Reports are system-paper scoped until a future owner model is explicitly designed.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/odds test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/api test`
- `pnpm --filter @find-the-edge/web test`
- `pnpm --filter @find-the-edge/infra-cdk test`
- `pnpm check`
- `git diff --check`

**Final pass:** `pnpm check` passes, including 46 domain, 52 odds, 176 database, 129 worker, 9 API, and 59 web tests, plus infrastructure synthesis tests and all builds. `git diff --check` passes. Production scheduling uses exact snapshot evidence and immutable cohort/report persistence; unsafe inference, mutable current-price fallback, and Scan were not introduced.
