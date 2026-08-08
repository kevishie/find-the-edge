---
title: 'Fix splits club-label drift'
type: 'bugfix'
created: '2026-08-08'
status: 'in-review'
baseline_commit: 'b01ef12'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fix-sharpapi-suffixless-split-persistence.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The `/splits` feed abbreviates clubs that the `/events` feed spells
out — `Athletics` against `Oakland Athletics` — and identity matching compared
labels for exact equality, so that club never received split evidence.

**Approach:** Accept a participant label whose words are all present in the
canonical label and whose nickname is identical. Change no day comparison,
persistence rule, cadence, or reconciliation rule.

## Boundaries & Constraints

**Always:** Require both participants to match, keep the Eastern-day comparison
exact, and keep the unique-canonical-candidate requirement so an ambiguous
matchup persists a gap instead of attaching.

**Ask First:** Any provider schema change, migration, cadence change, or
relaxation of the day or unique-candidate rules.

**Never:** Match on a nickname alone, match on a day alone, or attach a split
across games.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Abbreviated club | Split `Athletics`, canonical `Oakland Athletics` | Attribute to that canonical event | N/A |
| Shared-city clubs | Split `Chicago Cubs @ Boston Red Sox` vs canonical `Chicago Cubs @ Chicago White Sox` | Persist no split | Record mapping gap |
| Series game | Split dated `2026-08-08` and a `2026-08-07` game starting `00:15Z` | Attribute only to the `2026-08-08` game | N/A |

</frozen-after-approval>

## Code Map

- `apps/workers/src/sharp-api-ingestion.ts` -- participant label matching.
- `apps/workers/src/sharp-api-ingestion.test.ts` -- attribution regression coverage.

## Tasks & Acceptance

**Execution:**
- [x] Accept an abbreviated club label that shares its nickname and adds no words.
- [x] Cover abbreviated clubs, shared-city rejection, and series-day rejection.

**Acceptance Criteria:**
- Given a split label that abbreviates the canonical club, when the participants
  otherwise agree, then it is attributed to that game.
- Given two clubs that share a city, when a split names only one of them, then no
  split is attached and a gap is persisted.
- Given a split dated for one Eastern day, when the previous day's late game
  starts after `00:00Z`, then the split is never attributed to that late game.

## Spec Change Log

- 2026-08-08: Withdrew a proposed Eastern/UTC day relaxation. It was based on a
  faulty comparison that matched provider rows by club name and so paired a split
  with the wrong day's game. Both feeds date an event id by its Eastern day, and
  accepting the UTC day as well would have made every split in a multi-game series
  match two canonical events, dropping evidence that resolves correctly today.

## Design Notes

Splits are pre-game evidence. The provider stops publishing them once a game
starts and rolls the feed to the next slate, so a board legitimately freezes at
its final pre-game values rather than continuing to move. That is expected and is
not an ingestion fault.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/workers exec vitest run src/sharp-api-ingestion.test.ts` -- expected: pass.
- `pnpm check` -- expected: pass, including the browser suite.
