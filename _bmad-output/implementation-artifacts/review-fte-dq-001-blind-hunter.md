# FTE-DQ-001 Blind Hunter Review Prompt

## Final outcome

**CLEAN** after review iteration 1. The final pass verified the scoped diff after repairs for sub-millisecond provider timestamps, bounded rate metadata, exact durable position claims, account/stream pause isolation, catalog evidence and chunking, shared quota fencing, replay recovery, terminal Lambda handling, and staging alarms/scheduling. Focused verification passed 302 tests across seven files; provider, database, and worker typechecks plus the scoped diff check passed.

Invoke the `bmad-review-adversarial-general` skill on the complete FTE-DQ-001 diff in the current shared worktree.

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

Construct the diff with `git diff 269478994a644b7245484fc23f643dd45777de56 -- <tracked paths>` and read every listed untracked file directly. Review the actual code, tests, spec, and deployment shape—not only the stat.

## Main consumer consequence

The collector must continuously land every sport, league, event, and unfiltered odds row SharpAPI makes available, without a product allowlist. Large walks must resume durably; every source row must be landed or quarantined; existing canonical serving must remain unchanged. Focus on any silent data loss, starvation, false completion/freshness, pagination/replay defect, privacy leak, Dynamo hot-key/item-limit failure, provider quota/timeout flaw, or deployment alarm blind spot.

Return only concrete findings with file/line, trigger, consequence, and smallest safe remedy. Do not edit files.
