---
title: 'FTE-075: Repair the documented collector command'
type: 'bugfix'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 1
baseline_commit: ae6fd3a77d0a45412ce3e0ae25b1bd226ec527e8
context:
  - '_bmad-output/implementation-artifacts/epic-13-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-075-cost-attribution-baseline.md'
---

<frozen-after-approval reason="user-authorized continuation of FTE-075">

## Intent

Make the documented `pnpm ingestion-cost:baseline -- --stage ...` command reach the live evidence checks while preserving the collector's fail-loud, no-artifact-on-failure contract.

## Boundaries & Constraints

**Always:** Accept exactly one conventional leading argument delimiter, allow only the collector's named options, reject malformed or ambiguous arguments, and stay within the live CloudWatch Contributor Insights request limit.

**Never:** Weaken evidence validation, write an artifact after a failed check, alter attribution or cost-model calculations, or touch user-owned `.claude/` files.

</frozen-after-approval>

## Code Map

- `scripts/ingestion-cost-attribution.mjs` -- strict CLI parser and Contributor Insights request.
- `scripts/ingestion-cost-attribution.test.mjs` -- package-boundary, process-failure, and request-limit regressions.

## Tasks & Acceptance

- [x] Accept the package manager's single leading `--` without accepting misplaced or repeated delimiters.
- [x] Reject unknown, duplicate, missing-value, and option-looking values before evidence collection.
- [x] Request at most 25 Contributor Insights contributors per rule.
- [x] Exercise the real package-script boundary and prove malformed input exits nonzero without an artifact.
- [x] Rerun the live documented command and confirm it reaches the intended unsettled-billing gate.

Given the runbook command, when pnpm forwards its delimiter, then the collector parses all named arguments and begins AWS evidence collection. Given malformed arguments, when the executable runs, then it exits nonzero and leaves no artifact. Given a Contributor Insights report request, then the requested contributor count does not exceed 25.

## Verification

- `node --test scripts/ingestion-cost-attribution.test.mjs` -- 10/10 pass.
- Targeted Prettier check and `git diff --check` -- pass.
- `pnpm check` -- full format, lint, boundaries, types, tests, builds, and 34 browser checks pass.
- Live staging command for `[2026-08-13, 2026-08-14)` -- reaches `required-series-invalid:billing:not-settled` and writes no artifact.
- Blind Hunter re-review -- CLEAN.
- Edge Case Hunter re-review -- no findings.

## Suggested Review Order

**Runtime boundary**

- Strict parsing accepts one package delimiter while rejecting ambiguous inputs.
  [`ingestion-cost-attribution.mjs:666`](../../scripts/ingestion-cost-attribution.mjs#L666)

- CloudWatch requests use the service's current 25-contributor ceiling.
  [`ingestion-cost-attribution.mjs:553`](../../scripts/ingestion-cost-attribution.mjs#L553)

**Regression evidence**

- The actual package script executes the documented delimiter shape successfully.
  [`ingestion-cost-attribution.test.mjs:214`](../../scripts/ingestion-cost-attribution.test.mjs#L214)

- Process-level malformed input fails without creating a plausible artifact.
  [`ingestion-cost-attribution.test.mjs:245`](../../scripts/ingestion-cost-attribution.test.mjs#L245)

- The AWS contributor ceiling is pinned against accidental regression.
  [`ingestion-cost-attribution.test.mjs:301`](../../scripts/ingestion-cost-attribution.test.mjs#L301)
