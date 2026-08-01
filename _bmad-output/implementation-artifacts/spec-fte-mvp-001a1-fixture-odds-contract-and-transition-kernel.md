---
title: 'FTE-MVP-001A1 Fixture Odds Contract and Transition Kernel'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
baseline_revision: '986fdf6f76c'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Dynamo and deployment mechanics cannot converge until immutable observation identity and CURRENT selection are expressed as a small, exhaustively tested, storage-neutral contract.

**Approach:** Add a browser-safe normalized fixture-odds contract and a pure in-memory transition kernel that decides snapshot creation/replay/corruption and CURRENT advance/retain outcomes. It performs no I/O.

## Boundaries & Constraints

**Always:** Accept only bounded ASCII identifiers whose canonical-array or length-prefixed composite is unambiguous, includes canonical event version, and stays below DynamoDB's 1,024-byte sort-key limit; bound every label and normalized record below a conservative item-size ceiling; require canonical event ID/version/sport, market, selection, sportsbook, American odds, and canonical ISO observation/retrieval times. Define each state as exactly one partition identified by those six binding dimensions. Before every transition, inspect only own snapshot properties, validate every retained normalized record against its key and partition, deep-clone/freeze retained data, and require CURRENT to equal the deterministic maximum retained snapshot. Recompute deterministic content identity using a browser-safe algorithm and canonical field order. Equal normalized content produces the same ID. Same ID with different content is corruption. A distinct older observation creates history but retains CURRENT. Newer observed time advances CURRENT. Equal observed time uses code-unit lexicographic snapshot ID comparison, never locale comparison. Every transition is immutable and free of wall-clock/global state.

**Block If:** A browser-safe deterministic hash already used by this repository cannot provide at least 128 bits of collision resistance without a new dependency.

**Never:** Add DynamoDB/AWS imports, repositories/gateways, DATA002 mapping reads, workers, fixtures, seed commands, CDK, API, UI, auth, retries, pagination, or recovery workflows. Do not use Node-only modules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Normalize | Valid bounded observation | Canonical normalized value and deterministic ID | No error |
| Replay | Identical snapshot already exists | `existing`; no mutation | No error |
| Collision | Same ID maps to different content | No mutation | Typed corruption error |
| Late arrival | Distinct older snapshot | `created`; CURRENT retained | No error |
| New/equal time | Newer, or equal time with winning ID | `created`; CURRENT advances | No error |
| Invalid/bounds | Bad date/odds/ID/oversize/composite byte length | No transition | Typed input error |
| Malformed state | Mixed partition, forged record/key, inherited property, non-max CURRENT, or mutable alias | No transition | Typed state-corruption error |

</intent-contract>

## Code Map

- `packages/domain/src/fixture-odds.ts` -- normalized types, browser-safe content identity, validation, transition result/error types, pure transition kernel.
- `packages/domain/src/fixture-odds.test.ts` -- exhaustive deterministic/boundary/property-style cases.
- `packages/domain/src/index.ts` -- public exports only.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/fixture-odds.ts` -- implement bounded normalization, unambiguous partition identity, canonical serialization/hash, full prior-state validation, and pure immutable snapshot/CURRENT transition.
- [x] `packages/domain/src/fixture-odds.test.ts` -- cover valid/replay/collision, old/new/equal ordering, timezone canonicalization, invalid numeric/time/ASCII and exact byte boundaries, explicit partition/version isolation, forged/mixed/inherited/non-max states, deep alias immutability, and deterministic repeated execution.
- [x] `packages/domain/src/index.ts` -- export the stable contract without adding runtime dependencies.

**Acceptance Criteria:**
- Given any accepted observation, when normalized repeatedly in browser and Node builds, then canonical content and ID are identical and bounded for future Dynamo keys/items.
- Given any order of distinct observations, when transitions are applied, then all valid snapshots are retained and CURRENT is the maximum by observed time then snapshot ID.
- Given identical replay or an ID/content collision, when transitioned, then replay is unchanged and collision fails without mutating prior state.
- Given the repository workspace, when full gates run, then browser consumers still build and no AWS/Node-only dependency enters the domain package.

## Spec Change Log

- 2026-08-01 loop 1: Blind/Edge reviews found state partition scope and prior-state trust rules under-specified. Amended Always, matrix, and tests to require one explicit versioned stream partition, canonical-array/length-prefixed composite identity, full own-record validation, recomputed maximal CURRENT, code-unit tie-break, and deep clone/freeze. KEEP: browser-safe 256-bit identity, storage-neutral pure kernel, no I/O/dependencies.

## Review Triage Log

- 2026-08-01 loop 1: intent_gap 1 (high 1); bad_spec 5 (high 5); patch 4 (high 1, medium 3); defer 0; reject 0. Addressed global-state ambiguity, delimiter/version collision, forged replay, stale CURRENT, prototype inheritance, locale ordering, and alias mutation by re-derivation.
- 2026-08-01 loop 1 implementation review: intent_gap 0; bad_spec 0; patch 4 (high 1, medium 2, low 1); defer 0; reject 0. Applied all localized patches: observations and retained state are captured once through own enumerable data descriptors; accessors and descriptor TOCTOU shapes are rejected without invocation; symbolic, hidden, unexpected, explicitly-undefined optional, and inherited properties cannot enter canonical input or state. Focused and full gates pass; ready for fresh review.

## Design Notes

The kernel returns the next immutable state plus explicit snapshot/current decisions. Future memory and Dynamo adapters must implement those decisions but are separate stories, allowing transaction and TOCTOU behavior to be reviewed independently.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- exhaustive kernel cases pass.
- `pnpm check` -- full format/lint/boundary/type/test/build gates pass including browser build.

## Auto Run Result

Implemented the storage-neutral fixture-odds contract and pure immutable transition kernel. The contract uses a dependency-free browser-safe SHA-256 implementation, canonical JSON arrays for versioned six-dimension partition identity and content identity, conservative identifier/label/key/item bounds, canonical ISO timestamps, and deterministic code-unit ordering. Every transition reconstructs prior state from exact own-key plain records, recomputes snapshot identities and the maximal CURRENT pointer, rejects forged/mixed/inherited/stale state, and returns deeply cloned/frozen data.

Verification: 28/28 domain tests pass, including descriptor/accessor and canonical-shape regressions; domain typecheck, lint, and build pass; `pnpm check` passes repository formatting, lint, boundaries, all 15 package typechecks, tooling typecheck, all workspace tests, and all 15 builds including the browser production build; `git diff --check` passes. No dependency, Node/AWS import, persistence, worker, infrastructure, API, UI, or commit was added.
