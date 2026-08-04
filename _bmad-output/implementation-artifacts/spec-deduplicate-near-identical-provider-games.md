---
title: 'Deduplicate near-identical provider games'
type: 'bugfix'
created: '2026-08-04'
status: 'done'
baseline_commit: '876454d'
review_loop_iteration: 2
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** SharpAPI can publish one matchup under multiple book-specific event IDs whose start times differ by about one minute. Exact timestamp identity creates duplicate games, while derivative catalog rows such as “Away Total Runs vs Home Total Runs” leak into the schedule as fake games.

**Approach:** Before bootstrapping a new game, reconcile an unmapped provider event to one uniquely matching canonical game with the same ordered participants, league, scheduled state, and a start time within 120 seconds. Keep every raw provider event ID as an exact provenance mapping, fail closed on ambiguity, and exclude recognizable derivative matchups before canonical ingestion.

## Boundaries & Constraints

**Always:** Preserve raw provider IDs; require exact normalized ordered participant labels and league; use an inclusive 120-second tolerance; accept a near match only when exactly one live canonical candidate exists; keep doubleheaders separate; apply reconciliation to both primary and fallback schedule providers; retain strict pagination and response validation.

**Ask First:** Merging or deleting already-persisted production records, widening the tolerance, reversing participant order, or introducing a provider-specific team allowlist.

**Never:** Strip `_bN` suffixes, round timestamps into global buckets, silently pick among multiple candidates, merge by team names without a bounded time check, or manufacture a game from proposition/derivative labels.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Near duplicate | Same league/ordered teams, different provider ID, start delta 0–120s | New provider ID maps to the existing canonical game | Preserve existing canonical start and identity |
| Outside window | Same teams with start delta above 120s | Bootstrap or bind as a separate game | Supports doubleheaders |
| Ambiguous window | More than one matching canonical candidate | No merge or bootstrap | Record/return an ambiguous mapping failure |
| Reversed participants | Home/away order differs | Do not merge | Fail closed unless a future league policy allows it |
| Derivative catalog row | Participant labels describe team totals, props, innings, or awards | Skip before canonical ingestion | Do not create projections or mappings |

</frozen-after-approval>

## Code Map

- `packages/database/src/event-ingestion.ts` -- event-store port and near-candidate contract.
- `packages/database/src/memory-event-ingestion.ts` -- deterministic in-memory reference implementation.
- `packages/database/src/dynamodb-event-ingestion.ts` -- production near-candidate lookup from current league/day projections.
- `packages/database/src/dynamodb-event-ingestion.ts` -- serialize same-matchup/day reconciliation so candidate lookup and alias/bootstrap decisions cannot race.
- `apps/workers/src/production-odds-control-plane.ts` -- schedule binding, bootstrap decision, and provider alias mapping.
- `apps/workers/src/sharp-api-ingestion.ts` -- non-control-plane Sharp ingestion must share the same reconciliation behavior.
- `packages/providers/src/sharp-api.ts` -- schedule response classification and derivative exclusion.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts` and `packages/database/src/event-ingestion.ts` -- persist explicit source/alias mapping provenance and define a store-level reconcile-and-bind operation with a write-time ownership fence.
- [x] `packages/database/src/memory-event-ingestion.ts`, `packages/database/src/dynamodb-event-ingestion.ts`, and the Dynamo gateway -- implement ordered-participant reconciliation with renewable token ownership; require the live token in final mapping/bootstrap writes; surface ownership loss; deterministically ignore/repair stale projection versions.
- [x] `apps/workers/src/production-odds-control-plane.ts` and `apps/workers/src/sharp-api-ingestion.ts` -- use explicit mapping provenance so source corrections advance schedule truth while alias replays cannot move it.
- [x] `packages/providers/src/sharp-api.ts` and `apps/workers/src/sharp-api-ingestion.ts` -- enforce structural ID uniqueness before classification and require compatible paired derivative grammar including first/last/extra and ordinal/spelled innings variants.
- [x] Relevant tests -- cover 0/60/120/121-second deltas, ambiguity persistence, reversed participants, doubleheaders, source corrections, cross-provider raw-ID collision, alias replay, concurrency beyond lease duration, takeover/release failure, Eastern-day boundaries, stale/missing/multiple projections, and derivative positive/negative/duplicate-ID cases.

**Acceptance Criteria:**
- Given book-specific Sharp records for the same matchup one minute apart, when ingestion runs, then one canonical game is queryable and every raw event ID resolves to it.
- Given two legitimate same-day games between the same teams outside the tolerance, when ingestion runs, then both remain distinct.
- Given a derivative matchup row, when parsing and ingestion run, then it cannot appear in the games API.
- Given an ambiguous near-match set, when binding runs, then ingestion fails closed without creating another canonical game.

## Spec Change Log

- 2026-08-04: Implemented bounded alias reconciliation, production and memory candidate lookup, derivative exclusion, and boundary/ambiguity/replay coverage.
- 2026-08-04 review loop 1: concurrency and stale-snapshot findings required store-level serialized reconciliation; exact-mapping replay must preserve legitimate canonical-source corrections; derivative validation/classification must be shared and structural-first. KEEP the inclusive 120-second exact ordered-team rule, raw provider IDs, fail-closed ambiguity, fallback-provider coverage, and current targeted tests.
- 2026-08-04 review loop 2: fixed leases without renewal/fencing could overlap, ID equality could not prove mapping ownership, and stale projection ordering/classifier uniqueness remained unsafe. Require renewable token ownership checked in final writes, explicit source/alias provenance, deterministic current-projection selection, durable ambiguity, and structural ID uniqueness. KEEP all review-loop-1 behavior and tests.
- 2026-08-04 review loop 1 implementation: added matchup-scoped memory serialization and conditional Dynamo leases, candidate revalidation, source/alias distinction, stale-projection filtering, shared paired derivative grammar, and concurrency/correction/midnight/parser regression coverage.
- 2026-08-04 review loop 2 implementation: added renewable fenced reconciliation, persisted provenance compatibility, lease-safe takeover, terminal fence checks, stricter derivative classification, and full repository verification.

## Design Notes

Near-match resolution is a fallback only after exact provider mapping and exact semantic identity miss. The winning candidate’s existing normalized identity and start time are passed into ingestion so alias creation cannot move or rewrite canonical schedule truth.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test` -- all store-contract tests pass.
- `pnpm --filter @find-the-edge/providers test` -- Sharp parser tests pass.
- `pnpm --filter @find-the-edge/workers test` -- ingestion/control-plane tests pass.
- `pnpm check` -- repository quality gate passes.

## Suggested Review Order

**Reconciliation design**

- Start with the serialized decision path that preserves one canonical game.
  [`event-ingestion.ts:181`](../../packages/database/src/event-ingestion.ts#L181)

- Review the production renewable lease and final-write fencing.
  [`dynamodb-event-ingestion.ts:681`](../../packages/database/src/dynamodb-event-ingestion.ts#L681)

- See the shared worker entry point used by every schedule provider.
  [`schedule-reconciliation.ts:24`](../../apps/workers/src/schedule-reconciliation.ts#L24)

**Provider hygiene**

- Verify derivative catalog rows are excluded before canonical ingestion.
  [`sharp-api.ts:122`](../../packages/providers/src/sharp-api.ts#L122)

- Confirm Sharp schedule ingestion delegates to the shared reconciler.
  [`sharp-api-ingestion.ts:227`](../../apps/workers/src/sharp-api-ingestion.ts#L227)

**Persistence and coverage**

- Inspect explicit source/alias provenance on durable mappings.
  [`index.ts:428`](../../packages/domain/src/index.ts#L428)

- Finish with boundary, replay, ambiguity, and concurrency regressions.
  [`schedule-reconciliation.test.ts:36`](../../apps/workers/src/schedule-reconciliation.test.ts#L36)
