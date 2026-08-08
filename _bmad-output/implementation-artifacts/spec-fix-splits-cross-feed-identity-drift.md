---
title: 'Fix splits cross-feed identity drift'
type: 'bugfix'
created: '2026-08-08'
status: 'in-review'
baseline_commit: 'b01ef12'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fix-sharpapi-suffixless-split-persistence.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Betting splits stop updating for the whole evening slate every night at
8pm Eastern, and one club never receives splits at all. Both are cross-feed
identity drift, confirmed against the live provider on 2026-08-07:

- The `/splits` feed dates an event ID by its **UTC** day while `/events` dates the
  same game by its **Eastern** day. `mlb_orioles_rangers_2026-08-08` in splits is
  `mlb_orioles_rangers_2026-08-07_b3` in the schedule, starting `00:15Z`. Identity
  matching demanded the Eastern day, so every game starting after `00:00Z` failed
  attribution and its split evidence froze at the last pre-rollover value.
- The `/splits` feed abbreviates clubs the schedule feed spells out — `Athletics`
  against `Oakland Athletics` — so exact label equality dropped that club forever.

**Approach:** Accept either the Eastern or the UTC day for a split's provider event
day. Accept a participant label whose words are all present in the canonical label
and whose nickname is identical. Change no persistence, cadence, or reconciliation
rule.

## Boundaries & Constraints

**Always:** Require both participants to match, keep the unique-canonical-candidate
requirement so an ambiguous matchup persists a gap instead of attaching, and keep
splits on their existing five-minute checkpoint.

**Ask First:** Any provider schema change, database migration, cadence change, or
relaxation of the unique-candidate rule.

**Never:** Match on a nickname alone, match on a day alone, attach a split across
games, or manufacture split data.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Late Eastern game | Split id dated UTC day, canonical dated Eastern day | Attribute to that canonical event | N/A |
| Abbreviated club | Split `Athletics`, canonical `Oakland Athletics` | Attribute to that canonical event | N/A |
| Shared-city clubs | Split `Chicago Cubs @ Boston Red Sox` vs canonical `Chicago Cubs @ Chicago White Sox` | Persist no split | Record mapping gap |
| Ambiguous day | Same matchup on adjacent days both resolve | Persist no split | Record mapping gap |

</frozen-after-approval>

## Code Map

- `apps/workers/src/sharp-api-ingestion.ts` -- split identity day and participant
  label matching.
- `apps/workers/src/sharp-api-ingestion.test.ts` -- attribution regression coverage.

## Tasks & Acceptance

**Execution:**
- [x] Accept the Eastern or UTC provider day for MLB split identity.
- [x] Accept an abbreviated club label that shares its nickname and adds no words.
- [x] Cover late-Eastern attribution, abbreviated clubs, and shared-city rejection.

**Acceptance Criteria:**
- Given a split whose provider id carries the UTC day of a game starting after 8pm
  Eastern, when the control plane ingests it, then it is attributed to that game.
- Given a split label that abbreviates the canonical club, when the participants
  otherwise agree, then it is attributed to that game.
- Given two clubs that share a city, when a split names only one of them, then no
  split is attached and a gap is persisted.

## Spec Change Log

## Design Notes

Both relaxations widen candidate acceptance only. Attribution still requires two
matching participants and exactly one surviving canonical event, so the failure
mode of a wrong relaxation is a persisted gap rather than a split attached to the
wrong game.

The provider publishes no rescheduled start time and no postponed status — its
status vocabulary is exactly `upcoming` and `live` — so a delayed game keeps its
original time in every feed. That is tracked separately and is not in scope here.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/workers exec vitest run src/sharp-api-ingestion.test.ts` -- expected: pass.
- `pnpm check` -- expected: pass, including the browser suite.
