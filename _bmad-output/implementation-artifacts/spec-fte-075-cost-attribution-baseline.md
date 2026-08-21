---
title: 'FTE-075: Cost Attribution Baseline for the Ingestion Table'
type: 'feature'
created: '2026-08-13'
status: 'in-progress'
review_loop_iteration: 0
context:
  - '_bmad-output/implementation-artifacts/epic-13-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The ingestion table's current cost is known only as a total and an old top-key spot reading, so later optimizations cannot be judged against an honest, reproducible baseline.

**Approach:** Capture consumed capacity at the shared live-odds DynamoDB boundary, correlate it only to bounded operation/prefix/resource labels, enable DynamoDB Contributor Insights, and provide one fail-loud collector plus a recorded baseline and cost reconciliation.

## Boundaries & Constraints

**Always:** Keep Contributor Insights access frequency separate from consumed-capacity attribution; request `INDEXES` capacity; emit table and GSI units without double-counting; classify mixed-prefix operations as `mixed` and unknowable work as `unattributed`; keep metric failures non-authoritative; export prefixes only, never keys or item contents; state UTC measurement and settled-bill windows.

**Ask First:** Production deployment or any cloud mutation beyond the repository's normal reviewed deployment path. The user's standing approval covers story/spec checkpoints, not bypassing that path.

**Never:** Change DynamoDB read/write volume for optimization; infer per-item capacity from transaction totals; report Contributor Insights access percentages as capacity percentages; turn missing datapoints into zero; include full partition keys, provider payloads, or table contents in telemetry/artifacts.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Attributable request | One bounded partition prefix and returned table/index capacity | Read/write units emitted with operation, prefix, and resource | Metric sink failure does not change the database result |
| Mixed transaction/batch | More than one bounded prefix | Aggregate capacity uses prefix `mixed` | Never allocate units across individual items |
| Unknowable request | Scan, missing key expression, or no returned capacity | Operation is counted and capacity remains explicit residual | Collector reports `unattributed`; it does not guess |
| Incomplete evidence | Any required CloudWatch, Contributor Insights, or billing datapoint is missing/empty | No baseline is emitted | Command exits non-zero with the missing series named |

</frozen-after-approval>

## Code Map

- `packages/database/src/dynamo-capacity-attribution.ts` -- shared request/response attribution wrapper and bounded key classifier.
- `packages/database/src/dynamo-capacity-attribution.test.ts` -- read, write, batch, transaction, GSI, redaction, and metric-failure coverage.
- `apps/workers/src/live-odds-lambda.ts` -- wraps the single shared ingestion client.
- `apps/workers/src/odds-control-plane.ts` -- privacy-safe EMF capacity and operation sink.
- `infra/cdk/src/foundation.ts` -- table and GSI Contributor Insights configuration.
- `scripts/ingestion-cost-attribution.mjs` -- read-only, fail-loud AWS evidence collector and dollar model.
- `scripts/ingestion-cost-attribution.test.mjs` -- fixture-driven validation and missing-series failures.
- `docs/runbooks/ingestion-cost-attribution.md` -- rerun command, methodology, residuals, and pricing assumptions.
- `_bmad-output/implementation-artifacts/fte-075-ingestion-cost-baseline.json` -- sanitized recorded evidence referenced by FTE-078.

## Tasks & Acceptance

**Execution:**
- [x] Add the capacity wrapper, bounded classifier, and unit tests in `packages/database`.
- [x] Wire privacy-safe EMF into the shared live-odds client without affecting persistence outcomes.
- [x] Enable table/GSI Contributor Insights through CDK and cover the synthesized contract.
- [x] Add the read-only collector, cost model, fixture tests, and single-command runbook.
- [ ] After reviewed deployment and metric settlement, record the baseline artifact and reconcile a settled billing period.

**Acceptance Criteria:**
- Given live-odds DynamoDB work, every successful returned capacity value is assigned to exactly one bounded `prefix × operation × resource` bucket, including explicit `mixed` and `unattributed` buckets.
- Given a completed window, the collector reports the five largest attributable prefixes with percentages, reports residual capacity separately, and does not reinterpret access counts as capacity.
- Given the documented command, another operator can reproduce the same schema without exposing keys or contents.
- Given a settled billing period, the model's table-plus-index estimate differs from the observed DynamoDB bill by no more than 15%, with assumptions recorded.

## Design Notes

`ReturnConsumedCapacity=INDEXES` is authoritative at request scope. A transaction spanning prefixes remains `mixed`; failed conditional writes and requests without a normal capacity response remain part of the native CloudWatch total and therefore the explicit residual. Contributor Insights independently ranks hot accessed keys and is sanitized to prefix groups before export.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test && pnpm --filter @find-the-edge/workers test` -- attribution and integration behavior passes.
- `node --test scripts/ingestion-cost-attribution.test.mjs` -- collector rejects missing/empty evidence and validates the model.
- `pnpm synth && pnpm check` -- infrastructure and repository contracts remain green.
- Documented attribution command -- produces a non-empty sanitized artifact only after every required series is present.

## Implementation Status

The measurement machinery is implemented and deployed. On 2026-08-14, both staging and production reported Contributor Insights enabled and emitted stage-scoped capacity metrics. Collection began after 01:15 UTC, so no fully instrumented UTC day has closed yet; the earlier `[2026-08-13, 2026-08-14)` billing period also still reports `Estimated=true`. FTE-075 remains `in-progress` until a later closed window has complete metrics and Cost Explorer settles it.
