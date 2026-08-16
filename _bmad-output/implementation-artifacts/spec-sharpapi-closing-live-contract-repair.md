---
title: 'SharpAPI closing live-contract repair'
type: 'bugfix'
created: '2026-08-15'
status: 'done'
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
- [x] Staging -- replace only the timestamp-qualified faulty repair batch, replay through production guards, rematerialize, and inspect the hosted board.
- [x] Repository -- run full validation, adversarial review, commit, push, merge, and deploy the exact revision.

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

**Deployed evidence:**
- PR #32 merged as `7062f0338b9cf175e98212fc2c430b000be5e240`; canonical closing capture and projection deployed to staging.
- PR #33 merged as `ca6017ced4eaa0c5052a597f9326a471dcfa25f1`; ordinary provider labels canonicalized at the serving boundary.
- Staging workflow `31921573332` passed, including the hosted MLB/MLS smoke.
- The materialized MLB board stores Marlins–Reds as `canonical-closing` with coherent moneyline, spread, and total markets.
- The signed-in Soccer board renders 28 events without an invalid-response failure.

## Suggested Review Order

**Provider contract and deterministic market selection**

- Start with the live closing parser and coherent native-market selection rules.
  [`sharp-api.ts:3163`](../../../packages/providers/src/sharp-api.ts#L3163)

- Review official/live-shaped regressions, including precision, alternates, and replay ordering.
  [`sharp-api-closing.test.ts:1`](../../../packages/providers/src/sharp-api-closing.test.ts#L1)

**Capture and public projection**

- Follow exact binding recovery, quota-gated capture, and per-book failure isolation.
  [`closing-lines-capture.ts:138`](../../../apps/workers/src/closing-lines-capture.ts#L138)

- Verify every served provider label is canonicalized against the event identity.
  [`games-repository.ts:944`](../../../packages/database/src/games-repository.ts#L944)

**Supporting proof**

- Confirm capture retries, immutable finalization, identity checks, and quota blocking.
  [`closing-lines-capture.test.ts:1`](../../../apps/workers/src/closing-lines-capture.test.ts#L1)

- Confirm soccer abbreviation normalization cannot invalidate the hosted page.
  [`games-repository.test.ts:1`](../../../packages/database/src/games-repository.test.ts#L1)
