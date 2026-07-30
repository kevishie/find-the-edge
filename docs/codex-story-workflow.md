# Codex Story Workflow

This workflow is for implementing one FIND THE EDGE story at a time from `_bmad-output/planning-artifacts/epics-and-stories.md`.

## Story Selection

1. Read `_bmad-output/implementation-artifacts/sprint-status.yaml`.
2. Select the first story with `status: ready`.
3. Confirm all listed dependencies are `done`.
4. If `approvalRequiredBeforeMerge: true`, stop before merge until human approval is recorded.

Only `FTE-001` starts as ready. Move later stories to `ready` only when dependencies are complete and the story is still aligned with the Product Brief, PRD, Architecture, and UX specification.

## Branch Workflow

1. Create a feature branch named `story/<story-id>-short-title`.
2. Re-read the selected story before editing files.
3. Implement only the selected story.
4. Do not scaffold future stories opportunistically.
5. Preserve the agreed stack and architecture boundaries.

## Implementation Rules

- Keep deterministic betting calculations in `packages/odds`.
- Do not calculate authoritative betting math in React, workers, provider DTOs, or LLM prompts.
- Keep provider DTOs inside provider adapter packages.
- Keep AWS and DynamoDB code out of frontend packages.
- Treat the Claude prototype as visual reference only.
- Do not introduce non-MVP scope such as NFL, NBA, esports, live betting, public registration, sportsbook bet placement, or automatic scouting schedules.
- Represent missing, stale, partial, suspended, failed, inferred, and unavailable data explicitly.

## Test Loop

Run the tests required by the story. For most implementation stories, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run Playwright when the story touches user-facing routes, responsive behavior, navigation, forms, tables, charts, or state screens:

```sh
pnpm test:e2e
```

If tests fail, repair and retry. After three failed repair attempts for the same failure, mark the story `blocked` in sprint status and document the blocker in the pull request.

## Pull Request Checklist

Every story PR should include:

- Story ID and title.
- Scope completed.
- Acceptance criteria evidence.
- Tests run.
- Screenshots or traces for UI stories when useful.
- Security, observability, and data migration notes.
- Any deviations from the story and why.

## Status Updates

Use these status values only:

- `backlog`
- `ready`
- `in-progress`
- `review`
- `blocked`
- `done`

Recommended transitions:

```text
ready -> in-progress -> review -> done
ready -> in-progress -> blocked
blocked -> ready
backlog -> ready
```

When a story is merged:

1. Mark it `done`.
2. Move newly unblocked dependent stories to `ready` only if they are still safe to start.
3. Keep approval-gated stories in `backlog` until approval is obtained.

## Human Approval Gates

Human approval is required before merge for:

- `FTE-PICK-004` Scheduled Shadow and Paper-Pick Runs.
- `FTE-LEARN-003` Versioned Retrospective and Error Taxonomy.
- `FTE-LEARN-004` Walk-Forward Experiment and Strategy Promotion Gates.
- `FTE-LEARN-005` Real-Money Readiness Gate and Kill Switch.
- `FTE-008` Cognito Private Authentication Infrastructure.
- `FTE-019` Initial Soccer Competitions Allowlist spike.
- `FTE-032` Consensus and Qualification Defaults spike.
- `FTE-039` Soccer Enrichment Provider Evaluation spike.
- `FTE-053` User Settings for Sportsbook, Markets, Thresholds, Weights, and Timezone.
- `FTE-056` Secrets, IAM, Encryption, Throttling, and Audit Hardening.
- `FTE-058` Production Deployment, Rollback, Cost, and Release Checklist.
