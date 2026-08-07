---
title: 'Fix SharpAPI suffixless split persistence'
type: 'bugfix'
created: '2026-08-07'
status: 'in-review'
baseline_commit: '975fe82'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Production split ingestion receives an empty canonical-odds candidate set, so SharpAPI consensus rows whose event IDs omit the schedule suffix can remain unmapped even after the matching odds event was accepted.

**Approach:** Retain canonical odds candidates from the current control-plane run by league and supply them to split persistence. Keep a durable exact-alias fallback for runs without fresh odds candidates, but accept it only when participant-compatible aliases resolve to one canonical game.

## Boundaries & Constraints

**Always:** Match the same league, teams, and Eastern game day; deduplicate aliases resolving to the same canonical event; persist an explicit gap when attribution is absent or ambiguous.

**Ask First:** Any provider schema change, database migration, destructive cleanup, or broad reconciliation-policy change.

**Never:** Match on a suffix alone, attach a split across games, manufacture split data, modify reset logic, or modify games repositories.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Current-run match | Suffixless split and one matching canonical odds event | Persist split against that canonical event | N/A |
| Durable replay | No current odds candidates; one compatible suffixed exact binding | Persist through exact binding | N/A |
| Conflicting aliases | Suffix probes resolve to different games | Persist no split | Record mapping gap |
| Unrelated candidate | Candidate differs by participant or game day | Persist no split | Record mapping gap |

</frozen-after-approval>

## Code Map

- `apps/workers/src/production-odds-control-plane.ts` -- orchestrates odds before splits but currently discards canonical odds candidates.
- `apps/workers/src/sharp-api-ingestion.ts` -- resolves split rows to canonical games and persists split evidence.
- `apps/workers/src/production-odds-control-plane.test.ts` -- production composition regression coverage.
- `apps/workers/src/sharp-api-ingestion.test.ts` -- exact fallback and cross-game safety coverage.

## Tasks & Acceptance

**Execution:**
- [x] `apps/workers/src/production-odds-control-plane.ts` -- retain current-run canonical odds candidates per league and pass them to split persistence.
- [x] `apps/workers/src/sharp-api-ingestion.ts` -- require a unique participant-compatible canonical result across exact suffix aliases and candidate fallback.
- [x] Worker tests -- cover production suffixless persistence, durable replay, conflicting aliases, and unrelated candidates.

**Acceptance Criteria:**
- Given a suffixless MLB consensus split and a matching accepted odds event, when the production control plane ingests both, then the split is persisted against that canonical event.
- Given several candidate events or exact aliases, when none or more than one canonical game matches the split identity, then no split is attached and an explicit gap is persisted.

## Spec Change Log

## Design Notes

The current-run candidate set is authoritative only inside the invocation that produced it. Durable retries still query exact provider mappings, but uniqueness is evaluated after participant validation so aliases for one canonical event remain safe while conflicting games fail closed.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/workers exec vitest run src/sharp-api-ingestion.test.ts src/production-odds-control-plane.test.ts` -- expected: focused worker tests pass.
- `pnpm --filter @find-the-edge/workers typecheck` -- expected: no TypeScript errors.
- `pnpm --filter @find-the-edge/workers lint` -- expected: no lint errors.
