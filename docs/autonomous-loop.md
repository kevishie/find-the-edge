# Autonomous Codex Loop

## Operating loop

1. Read `AGENTS.md` if present, `docs/task-queue.md`, sprint status, decision log, architecture, and the selected story.
2. Confirm the working tree and preserve unrelated/user-owned changes.
3. Select the highest-priority unblocked task whose dependencies are done.
4. Move it to in progress and append a progress entry.
5. Implement the smallest complete vertical slice.
6. Run acceptance tests, lint, typecheck, unit tests, and build. Run E2E for user-facing behavior.
7. Repair failures, with a maximum of three attempts for the same root failure.
8. Update docs/status/progress and commit only the task's files with a small, descriptive commit.
9. Repeat while time and unblocked tasks remain.

## Stop conditions

Stop and request direction when:

- Product ambiguity changes market scope, calculation policy, provider, data licensing, user-visible claims, or architecture.
- A real secret, paid account, external approval, production deployment, or destructive action is required.
- Existing user work would be overwritten or ownership is unclear.
- An external dependency is unavailable after safe retries.
- The same test/root failure survives three repair attempts.
- A human approval gate in sprint status is reached.

Never fabricate provider data, silently weaken tests, commit secrets, deploy, place bets, rewrite Git history, or delete useful work.

## Progress record format

Append to `docs/progress.md`: timestamp, task/story, outcome, files, gates, commit, decisions, blockers, and next task.
