---
title: 'FTE-PICK-001 Reproducible Evaluation and Paper-Bet Records'
type: 'feature'
created: '2026-08-03T22:45:00-04:00'
status: 'in-review'
baseline_revision: '2e98bea'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0B-context.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** FIND THE EDGE cannot yet reconstruct a paper decision after odds, strategies, prompts, models, or calculations change because it lacks an immutable, version-complete decision-time ledger.

**Approach:** Introduce strict domain manifests and append-only memory/DynamoDB repositories that deterministically hash exact immutable odds evidence, persist Play and No Bet evaluations, and atomically pair each Play with its paper-bet record.

## Boundaries & Constraints

**Always:** Reference exact immutable snapshot partition/sort keys and snapshot IDs, never CURRENT projections; require sport-module, strategy, model, prompt-bundle-or-explicit-null, calculation, input-schema, and manifest-schema versions; include decision-time thresholds, probability/range, uncertainty, no-vig comparison, evidence completeness, and safe provenance; canonicalize semantic sets before hashing; recompute caller-supplied hashes and IDs; deep-freeze normalized records; make exact retries idempotent and conflicting replays fail closed; persist Play plus paper bet atomically while No Bet remains a complete standalone result; label decision-time versus backtest mode.

**Block If:** Exact immutable snapshot identity cannot be represented by existing evidence; a required legacy migration would fabricate missing provenance; licensed storage terms prohibit the normalized decision-time fields.

**Never:** Invoke an LLM, grade outcomes, create real-money bets or stakes, retain credentials/raw licensed payloads, derive identity from operational timestamps/request IDs, overwrite historical records, accept incomplete versions, or treat a conditional-write failure as a duplicate without strongly consistent content comparison.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Deterministic evaluation | Semantically identical manifests with reordered object keys or set-like evidence/reason arrays | Same canonical input hash and evaluation ID | Reject non-plain, ambiguous, oversized, or unexpected values |
| Play | Valid manifest, Play decision, exact immutable offered snapshot | Evaluation and deterministic paper bet persist in one transaction | Partial/conflicting prior state fails closed |
| No Bet | Valid manifest, No Bet reason codes | Evaluation persists without a paper bet | Reject supplied paper bet |
| Exact retry | Stored records byte-match normalized retry | Return duplicate/idempotent outcome and original record | Strongly reread every intended item |
| Conflicting retry | Same derived identity but different content or only part of a Play pair exists | No mutation | Raise replay conflict |
| Mutable or incomplete evidence | CURRENT key, missing snapshot ID/version, absent required version, secret-like/raw payload | No record or hash produced | Validation error before persistence |

</intent-contract>

## Code Map

- `packages/domain/src/fixture-odds.ts` -- canonical immutable snapshot identity and strict normalization precedent.
- `packages/domain/src/paper-evaluation.ts` -- new manifest, evaluation, paper-bet schemas, validation, canonicalization, hashing, and constructors.
- `packages/domain/src/index.ts` -- public exports without replacing compatibility Pick/Recommendation types.
- `packages/database/src/result-repository.ts` -- append-only/idempotent repository precedent.
- `packages/database/src/paper-evaluation-repository.ts` -- new repository port, memory implementation, and replay conflict.
- `packages/database/src/dynamodb-paper-evaluation-repository.ts` -- new conditional transactional persistence and exact reads.
- `packages/database/src/index.ts` -- database exports.
- `packages/sports/src/shared/contracts.ts` -- registered module/strategy version fixtures.
- `packages/scouting/src/index.ts` -- prompt-bundle/model version fixture.
- `packages/odds/src/index.ts` -- deterministic calculation version/value fixture.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/paper-evaluation.ts` -- define strict readonly records and bounded normalizers; normalize set-like fields, canonicalize JSON, derive SHA-256 input/evaluation/paper-bet identities, enforce Play/No Bet invariants, immutable snapshot-only references, explicit modes, complete versions, safe provenance, and deep immutability.
- [x] `packages/domain/src/paper-evaluation.test.ts` -- cover schema bounds, forbidden CURRENT/secret/raw fields, version completeness, point/range probabilities, meaningful versus semantic ordering, hash changes, forged IDs, decisions, and deep freeze.
- [x] `packages/domain/src/index.ts` -- export the new contracts without breaking current UI compatibility types.
- [x] `packages/database/src/paper-evaluation-repository.ts` -- add the port and defensive-cloning memory repository supporting exact get and atomic evaluation/paper pair persistence.
- [x] `packages/database/src/dynamodb-paper-evaluation-repository.ts` -- transact conditional puts in one evaluation partition; on cancellation strongly reread and compare all intended records before returning duplicate; reject partial or conflicting state.
- [x] `packages/database/src/paper-evaluation-repository.test.ts` and `packages/database/src/dynamodb-paper-evaluation-repository.test.ts` -- run the repository contract for Play/No Bet, exact retry, conflict, partial state, concurrency cancellation, consistent reads, immutable clones, and key/condition expressions.
- [x] `packages/database/src/index.ts` -- export both repository implementations and errors.
- [x] `packages/database/src/paper-evaluation-round-trip.test.ts` -- create an exact fixture odds snapshot plus registered sport/strategy, model/prompt, calculation, and schema versions; persist and retrieve a complete evaluation/paper-bet pair.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- move FTE-PICK-001 through review to done only after all acceptance and verification checks pass.

**Acceptance Criteria:**
- Given an evaluation manifest, when it references odds, then it contains an exact immutable snapshot key and snapshot ID and rejects any mutable CURRENT identity.
- Given semantically identical complete manifests, when they are normalized independently, then their input hashes, evaluation IDs, and resulting records are identical.
- Given any required version or decision-time threshold changes, when a new manifest is created, then it receives a different hash while the prior record remains unchanged.
- Given a No Bet outcome, when persisted, then its reasons and complete provenance are queryable without creating a paper bet.
- Given a Play outcome, when persisted or retried, then evaluation and paper bet are atomically complete, idempotent for exact replay, and conflict-safe otherwise.
- Given fixture odds and registered version fixtures, when the round-trip test runs, then retrieved evaluation and paper bet reconstruct the original decision-time inputs exactly.

## Spec Change Log

## Review Triage Log

### 2026-08-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 6, medium 6, low 0)
- defer: 0
- reject: 4
- addressed_findings:
  - `[high]` `[patch]` Excluded `createdAt` from replay identity so the first audit timestamp survives exact retries.
  - `[high]` `[patch]` Canonically validated and dimension-bound offered and comparison snapshot evidence.
  - `[high]` `[patch]` Limited duplicate recovery to conditional cancellations and preserved retriable AWS failures.
  - `[high]` `[patch]` Runtime-validated stored records and propagated Dynamo read failures accurately.
  - `[high]` `[patch]` Enforced canonical evaluation/paper IDs and immutable snapshot key/hash shapes.
  - `[high]` `[patch]` Rejected embedded credentials, authorization material, cookies, and raw payload provenance.
  - `[medium]` `[patch]` Replaced plausible version strings with registered sport, strategy, prompt, model, and calculation fixtures.
  - `[medium]` `[patch]` Added the No Bet conditional-cancellation exact-retry path.
  - `[medium]` `[patch]` Asserted exact Dynamo table, keys, conditions, and transaction values.
  - `[medium]` `[patch]` Added memory partial-state, concurrency, corruption, and nested-clone coverage.
  - `[medium]` `[patch]` Verified mismatched offered evidence cannot attach to another evaluated dimension.
  - `[medium]` `[patch]` Verified mismatched comparison evidence cannot contaminate no-vig context.

## Design Notes

Hash identity covers normalized decision inputs, not `createdAt`; the first successful writer owns the audit timestamp and exact retries return that stored record. Object keys sort bytewise. Only fields declared semantic sets—comparison evidence, reason codes, and provenance references—are deduplicated and sorted; meaningful ordered arrays remain ordered. A Play uses `pk=EVALUATION#<inputHash>`, `sk=RECORD` and `sk=PAPER_BET` in one transaction so neither half can exist alone.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- all schema, hash, immutability, and invariant tests pass.
- `pnpm --filter @find-the-edge/database test` -- memory/Dynamo contracts and fixture round-trip pass.
- `pnpm check` -- formatting, lint, typecheck, tests, and builds pass repository-wide.
- `git diff --check` -- no whitespace defects.

## Dev Agent Record

### Debug Log

- Implemented strict manifest normalization and deterministic SHA-256 identities over immutable decision inputs.
- Added atomic memory and DynamoDB repositories with strongly consistent replay verification.
- Corrected promise-boundary conflict handling and isolated reusable test fixtures during verification.

### Completion Notes

- Play and No Bet records preserve complete version and provenance context while rejecting mutable odds references and unsafe input shapes.
- Exact Play retries require both records to match; partial or conflicting states fail closed.
- All focused and repository-wide checks pass. Story is ready for adversarial review.

## File List

- `packages/domain/src/paper-evaluation.ts`
- `packages/domain/src/paper-evaluation.test.ts`
- `packages/domain/src/index.ts`
- `packages/database/src/paper-evaluation-repository.ts`
- `packages/database/src/dynamodb-paper-evaluation-repository.ts`
- `packages/database/src/paper-evaluation-repository.test.ts`
- `packages/database/src/dynamodb-paper-evaluation-repository.test.ts`
- `packages/database/src/paper-evaluation-round-trip.test.ts`
- `packages/database/src/paper-evaluation-test-fixture.ts`
- `packages/database/src/index.ts`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

- 2026-08-03: Implemented reproducible evaluation manifests and atomic paper-bet persistence; moved story to review.

## Status

In Review

## Auto Run Result

### Summary

Added a reproducible paper-evaluation ledger whose immutable manifest fingerprints the exact offered odds evidence, candidate, probability, thresholds, evidence quality, provenance, and every decision-driving version. Play records atomically include a paper bet; No Bet remains a complete first-class outcome.

### Files Changed

- `packages/domain/src/paper-evaluation.ts` — strict schemas, canonical normalization, stable hashes, constructors, and safety guards.
- `packages/database/src/paper-evaluation-repository.ts` — atomic in-memory ledger contract and implementation.
- `packages/database/src/dynamodb-paper-evaluation-repository.ts` — conditional DynamoDB transactions and strongly consistent replay verification.
- Domain/database tests and fixtures — schema, idempotency, conflict, corruption, concurrency, and full registered-version round-trip coverage.
- Package exports/dependencies and sprint artifacts — expose the ledger and record story progress.

### Review Findings

- Patches applied: 12 (6 high, 6 medium).
- Deferred: 0.
- Rejected: 4 (out-of-scope or duplicate findings).
- Follow-up review recommended: true because the final pass materially hardened identity, persistence, AWS error classification, and secret-safety behavior.

### Verification

- Domain: 36 tests passed.
- Database: 138 tests passed.
- `pnpm check`: passed.
- `git diff --check`: passed.

### Residual Risks

- This story establishes storage and reproducibility only; AI invocation, deterministic qualification, scheduling, and result grading remain later stories.
