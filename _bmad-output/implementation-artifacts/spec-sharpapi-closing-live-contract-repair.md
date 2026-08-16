---
title: 'SharpAPI closing live-contract repair'
type: 'bugfix'
created: '2026-08-15'
status: 'in-review'
review_loop_iteration: 0
baseline_commit: '49d26616c1798f27667a11aec393b8031498c803'
context:
  - '{project-root}/docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Staging receives official SharpAPI closing snapshots but rejects valid rows, leaving started MLB games on partial pregame snapshots with blank spreads and totals. The live endpoint emits full-precision decimals, abbreviated team labels, alternate line pairs, and nullable `fair_close_decimal` values that differ from the narrow synthetic fixtures.

**Approach:** Align the closing-only parser with the official endpoint and observed live contract while preserving exact event/side identity, DynamoDB numeric safety, immutable book finalization, and fail-closed behavior for incoherent markets. Repair only the staging rows written by the faulty operator pass, replay canonical snapshots, rematerialize boards, and verify the hosted result.

## Boundaries & Constraints

**Always:** Use exact provider event bindings; validate `canonical_key` against event, market, side, and line; accept only DynamoDB-marshallable numbers; choose one deterministic coherent line pair; preserve bounded rejection evidence; use the shared quota authority; prove durable books and hosted rendering.

**Ask First:** None; the user explicitly approved the repair, AWS commands, push, and staging deployment.

**Never:** Guess event identity from names/time, mix books or provider event IDs, overwrite unrelated immutable records, log the API key/raw paid payload, weaken ordinary odds ingestion, or label a pregame fallback as a canonical close.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Full precision | 16–17 digit closing probabilities and nanosecond timestamps | Accept and normalize Dynamo-safe prices | Reject nonfinite, unsafe, or lossy HTTP number lexemes |
| Alternate lines | Multiple coherent spread/total pairs | Select the most balanced pair deterministically | Retain bounded rejection when no pair is coherent |
| Abbreviated labels | Exact event/side key with shortened provider label | Accept the bound participant side | Reject wrong event/canonical side |
| Nullable fair decimal | `fair_close_decimal=null`, valid positive `closing_probability` | Derive `1 / closing_probability` | Reject invalid non-null values or zero probability |
| Faulty staging batch | Exact repair-run timestamps | Delete only those keys and replay | Conditional delete prevents unrelated mutation |

</frozen-after-approval>

## Code Map

- `packages/providers/src/sharp-api.ts` -- closing response validation and coherent-market selection.
- `packages/providers/src/sharp-api-closing.test.ts` -- official/live-shaped contract regressions.
- `apps/workers/src/closing-lines-capture.ts` -- quota-gated immutable capture orchestration.
- `packages/database/src/closing-lines-repository.ts` -- durable book projection used by serving.
- `packages/database/src/games-repository.ts` -- canonical event-market ordering for hosted projection.

## Tasks & Acceptance

**Execution:**
- [x] `packages/providers/src/sharp-api.ts` -- accept the live closing numeric/label/null contract and select coherent primary markets.
- [x] `packages/providers/src/sharp-api-closing.test.ts` -- pin full precision, nanoseconds, abbreviations, nullable fair decimal, and alternate-line behavior.
- [x] `apps/workers/src/closing-lines-capture.ts` and `packages/database/src/games-repository.ts` -- normalize canonical participant labels and restore canonical side/market ordering at the public projection boundary.
- [ ] Staging -- replace only the timestamp-qualified faulty repair batch, replay through production guards, rematerialize, and inspect the hosted board.
- [ ] Repository -- run full validation, adversarial review, commit, push, merge, and deploy the exact revision.

**Acceptance Criteria:**
- Given a valid official closing snapshot, when it contains live-shaped precision and alternate markets, then the preferred display book exposes coherent moneyline, spread, and total selections.
- Given a started staging game with an exact binding, when capture and materialization finish, then the hosted board labels canonical evidence `closing lines` and no longer shows blank supported markets when SharpAPI supplied them.
- Given an identity mismatch, when capture runs, then it writes no canonical book and reports a bounded failure.

## Spec Change Log

## Design Notes

Primary-line selection minimizes side probability imbalance, then overround, with canonical-key ordering as a stable tie-break. This favors the provider's near-even main proposition without combining books, event IDs, or incompatible points.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test -- sharp-api-closing.test.ts` -- provider contract suite passes.
- `pnpm check && git diff --check` -- all repository gates pass.
- AWS DynamoDB queries and hosted browser inspection -- exact books and visible canonical markets are present.
