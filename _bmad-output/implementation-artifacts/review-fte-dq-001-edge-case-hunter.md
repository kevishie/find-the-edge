# FTE-DQ-001 Edge Case Hunter Review Prompt

## Final outcome

**CLEAN (`[]`)** after review iteration 2. The last findings were encoded DynamoDB sort-key boundaries that omitted the two-slot snapshot prefix. The parser now includes the exact slot prefix when bounding event, odds, sport, and league keys; boundary Unicode rows quarantine individually while valid siblings land. Provider verification passed 121 tests with one skipped, plus typecheck, lint, build, and diff checks.

Invoke the `bmad-review-edge-case-hunter` skill on the complete FTE-DQ-001 diff in the current shared worktree.

## Review target

- Spec: `_bmad-output/implementation-artifacts/spec-fte-dq-001-universal-sharpapi-catalog-and-landing.md`
- Baseline: `269478994a644b7245484fc23f643dd45777de56`
- Inspect all tracked and untracked changes in:
  - `_bmad-output/implementation-artifacts/sprint-status.yaml`
  - `_bmad-output/planning-artifacts/{architecture.md,epics-and-stories.md,prd.md,sprint-change-proposal-2026-08-14.md}`
  - `docs/runbooks/sharpapi.md`
  - `packages/providers/src/sharp-api{,.test}.ts`
  - `packages/database/src/{index.ts,provider-landing-repository.ts,provider-landing-repository.test.ts}`
  - `apps/workers/src/provider-landing{,.test}.ts`
  - `apps/workers/src/provider-landing-lambda{,.test}.ts`
  - `infra/cdk/src/foundation{,.test}.ts`
- Exclude `.claude/` and `apps/web/index.html`; those are unrelated user/committed work outside FTE-DQ-001.

Construct the diff with `git diff 269478994a644b7245484fc23f643dd45777de56 -- <tracked paths>` and read every listed untracked file directly. Walk every branch and boundary in the actual code and deployment contract.

## Required path inventory

Exercise catalog empty/duplicate/malformed/drift; event offset missing/repeated/backward; odds cursor missing/repeated; cross-page duplicates; partial writes; checkpoint conflicts; crash after records/before cursor; deadline before/after a page; simultaneous event/odds streams; slow/429/timeout/malformed provider responses; more rows than one invocation; new sport/market/book strings; optional-field drift; record/key/item size boundaries; stale records after terminal sweep; quarantine growth/hot partitions; alarm missing-data behavior; and replay after Lambda/DLQ retries.

Return only unhandled edge cases with file/line, exact trigger, consequence, and guard/test. Do not edit files.
