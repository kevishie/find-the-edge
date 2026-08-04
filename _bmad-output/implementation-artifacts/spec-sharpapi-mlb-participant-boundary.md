---
title: 'SharpAPI MLB Participant Boundary'
type: 'bugfix'
created: '2026-08-04'
status: 'done'
baseline_commit: '4fa4c27'
review_loop_iteration: 3
context:
  - '_bmad-output/implementation-artifacts/spec-fte-023-featured-and-event-specific-odds-ingestion.md'
  - '_bmad-output/implementation-artifacts/spec-fte-024-provider-quota-retry-dlq-and-suspended-partial-states.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** SharpAPI's exact `league=mlb` schedule feed currently contains at least one Japanese baseball matchup whose row is itself labeled `mlb`. The existing suffix-based display normalization can turn labels such as `Yomiuri Giants` and `Hanshin Tigers` into valid-looking MLB nicknames, allowing provider catalogue contamination to become a canonical MLB event.

**Approach:** Establish one explicit, exact MLB participant catalogue at the domain boundary and require both schedule participants to resolve to distinct MLB clubs before accepting an MLB row. Apply the same membership contract defensively to MLB odds identities while retaining provider-mislabeled rows only as excluded evidence, never canonical games or prices.

## Boundaries & Constraints

**Always:** Cover all 30 MLB clubs and deliberately supported aliases; normalize case, Unicode accents, spacing, and punctuation before exact alias lookup; preserve home/away order; require two distinct known clubs; filter provider-mislabeled but structurally valid out-of-scope rows without failing the entire page; continue rejecting malformed in-scope payloads; keep SharpAPI as the sole production source; emit bounded exclusion evidence/metrics where the current contract supports it.

**Ask First:** Expanding accepted aliases beyond current product labels, changing the approved league list, or deleting already-stored contaminated historical records rather than suppressing them at reads.

**Never:** Infer MLB membership by suffix, substring, fuzzy match, city-only match, or provider `league` alone; hard-code the observed Japanese teams as a one-off denylist; move league-specific policy into generic reconciliation/database contracts; weaken event identity timing or participant-order rules; reintroduce The Odds API or another fallback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Valid MLB | Full official names or approved aliases for two clubs | Accept with stable canonical club keys and original away/home order | N/A |
| Provider contamination | Japanese/foreign teams on a row labeled `mlb` | Exclude from schedule, expected IDs, checkpoint starts, and odds persistence | Bounded out-of-scope reason; page remains healthy |
| Alias trap | `Yomiuri Giants`, `Hanshin Tigers`, or prefixed nickname collision | Do not reduce to `giants`/`tigers`; exclude | Never fuzzy/suffix match |
| Same club twice | Two aliases resolving to one MLB club | Exclude as invalid matchup | Explicit non-actionable outcome |
| Other leagues | MLS/EPL/Liga MX/UEFA rows | Existing exact-league behavior remains unchanged | No MLB catalogue applied |

</frozen-after-approval>

## Code Map

- `packages/domain/src/index.ts` -- current suffix-based MLB display normalization and duplicate keys.
- `packages/domain/src/event-display-deduplication.test.ts` -- participant normalization and duplicate display coverage.
- `packages/providers/src/sharp-api.ts` -- earliest Sharp schedule/odds parsing trust boundary.
- `packages/providers/src/sharp-api.test.ts` -- mixed provider-page and identity validation fixtures.
- `apps/workers/src/production-odds-control-plane.test.ts` -- schedule checkpoint/reconciliation integration.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts` (or a focused exported domain module) -- replace suffix inference with a single exact normalized alias-to-club catalogue for all 30 MLB teams and expose a distinct-matchup predicate.
- [x] `packages/domain/src/event-display-deduplication.test.ts` -- prove official names/approved aliases, punctuation/case/Unicode normalization, foreign nickname traps, unknown teams, and same-club aliases.
- [x] `packages/providers/src/sharp-api.ts` -- filter contaminated MLB schedule rows before identities escape and defensively exclude contaminated MLB odds events without changing other leagues.
- [x] `packages/providers/src/sharp-api.test.ts` -- cover mixed valid/foreign pages, one-known/one-foreign, approved aliases, same-team aliases, and unchanged soccer parsing.
- [x] `apps/workers/src/production-odds-control-plane.test.ts` -- prove excluded events never enter reconciliation, expected provider IDs, or continuation starts while valid rows complete normally.

**Acceptance Criteria:**
- Given SharpAPI returns a structurally valid row labeled `mlb` with non-MLB participants, when schedule or odds parsing runs, then the row cannot create or update a canonical event, odds snapshot, continuation identity, or UI game.
- Given any legitimate MLB matchup using official names or an approved existing alias, when parsed and reconciled, then it retains stable canonical participant identity and home/away order.
- Given foreign labels ending in an MLB nickname, when normalized, then they remain unknown rather than collapsing to an MLB club.
- Given a mixed schedule page, when one row is contaminated, then valid MLB siblings persist and provider health remains successful with bounded exclusion evidence.

## Spec Change Log

- 2026-08-04: Implemented the exact MLB participant boundary and moved the bugfix to review.
- 2026-08-04: Addressed adversarial review pass one (1 high, 7 medium findings): contamination-aware pagination, league-key enforcement, idempotent metrics, pre-derivative classification, Unicode hardening, stable club identities, distinct diagnostics, and alias-collision assertions.
- 2026-08-04: Addressed adversarial review pass two: stable schedule-to-odds club identity, alternate-label Dynamo reconciliation, bounded duplicate-aware backfill, boundary-specific durable gaps, and exhaustive declared-alias coverage.
- 2026-08-04: Addressed clean review pass three: exact-catalogue migration matching for legacy canonical events, cross-page schedule event deduplication, and durable per-page metric delivery markers for crash/replay recovery.

## Design Notes

The catalogue is an allowlist, not a display formatter heuristic. Exact normalized aliases such as `San Francisco Giants` and deliberately supported `Giants` may map to `giants`; `Yomiuri Giants` must not. The same exported resolver should drive display deduplication and provider membership checks so they cannot drift.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- all participant and deduplication cases pass.
- `pnpm --filter @find-the-edge/providers test` -- mixed schedule/odds pages enforce the boundary.
- `pnpm --filter @find-the-edge/workers test` -- continuation/reconciliation integration excludes contamination.
- `pnpm check` -- repository quality gate passes.
- `pnpm phase1:preflight` -- production synthesis remains SharpAPI-only and valid.

## Suggested Review Order

**Canonical MLB boundary**

- Exact aliases replace unsafe nickname suffix inference and expose stable club identity.
  [`index.ts:471`](../../packages/domain/src/index.ts#L471)

- Sharp schedule and odds parsing rejects foreign or same-club MLB identities early.
  [`sharp-api.ts:275`](../../packages/providers/src/sharp-api.ts#L275)

**Persistence and read safety**

- Stable IDs reconcile legacy labels without creating duplicate canonical events.
  [`dynamodb-event-ingestion.ts:645`](../../packages/database/src/dynamodb-event-ingestion.ts#L645)

- Bounded duplicate-aware backfill prevents hidden rows from emptying valid pages.
  [`games-repository.ts:163`](../../packages/database/src/games-repository.ts#L163)

**Ingestion evidence**

- Schedule pagination deduplicates IDs and persists reason-specific exclusion evidence.
  [`production-odds-control-plane.ts:958`](../../apps/workers/src/production-odds-control-plane.ts#L958)

- Durable delivery markers make exclusion metrics recoverable across replay.
  [`odds-control-plane.ts:378`](../../packages/database/src/odds-control-plane.ts#L378)

- Odds ingestion preserves the same stable participant keys established by schedules.
  [`sharp-api-ingestion.ts:56`](../../apps/workers/src/sharp-api-ingestion.ts#L56)

## Dev Agent Record

### Implementation Notes

- Replaced suffix matching with one exact 30-club catalogue shared by display deduplication and the SharpAPI trust boundary. Cosmetic case, spacing, punctuation, and Unicode differences normalize before exact lookup; unknown prefixes never match. Existing contaminated canonical history is retained but suppressed from game-list reads.
- Canonicalized accepted MLB aliases to stable official participant labels while retaining the original away/home orientation. Both schedule rows and odds identities require two distinct known clubs.
- Retained structurally valid provider contamination as bounded schedule exclusion evidence and row-level odds rejection evidence. Mixed pages continue normally, and the production control plane emits one low-cardinality exclusion metric per sealed page.
- Added production-path coverage proving contaminated IDs never enter canonical mappings, checkpoint expected IDs, or upcoming starts while valid siblings complete and provider health remains successful. The ad hoc launch bugfix is not a numbered sprint story, so no sprint tracker status was changed.
- Verification passed: domain 69 tests, providers 60 tests, database 196 tests, web 96 tests, workers 157 tests, full `pnpm check`, credential-free Phase 1 preflight, and `git diff --check`.

### File List

- `_bmad-output/implementation-artifacts/spec-sharpapi-mlb-participant-boundary.md`
- `apps/web/src/api.test.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/schedule-reconciliation.ts`
- `apps/workers/src/fixture-odds-seed.test.ts`
- `apps/workers/src/sharp-api-ingestion.test.ts`
- `packages/domain/src/event-display-deduplication.test.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/fixture-odds.ts`
- `packages/database/src/games-repository.test.ts`
- `packages/database/src/store-contract.test.ts`
- `packages/database/src/games-repository.ts`
- `packages/database/src/event-ingestion.ts`
- `packages/database/src/memory-event-ingestion.ts`
- `packages/database/src/dynamodb-event-ingestion.ts`
- `packages/database/src/odds-control-plane.ts`
- `packages/providers/src/sharp-api.test.ts`
- `packages/providers/src/sharp-api.ts`
- `packages/providers/src/upcoming-events.ts`
- `packages/providers/src/fixtures/mlb-schedule.ts`
- `packages/providers/src/fixtures/mvp-odds.ts`
