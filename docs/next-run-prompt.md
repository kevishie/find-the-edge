# Next-Run Prompt

Continue the FIND THE EDGE MVP in `/Users/kevishie/Projects/find-the-edge`.

Read `docs/autonomous-loop.md`, `docs/task-queue.md`, `docs/progress.md`, the BMAD sprint status, architecture, and relevant stories before editing. Preserve untracked `design/claude/uploads/` and unrelated user work.

Start with the highest-priority unblocked slice:

1. Complete `FTE-003` boundaries by adding canonical domain/evidence contracts for MLB games, starters, lineups, bullpens, market snapshots, timestamps, and verification states.
2. Extend `packages/odds` with weighted two-way and three-way no-vig consensus. Exclude the offered sportsbook from its own consensus and return explicit insufficient/stale/suspended/outlier states.
3. Add fixture-backed MLB board cards that show favorite/underdog, offered price, fair price, EV, confidence separately, lineup/freshness state, public/sharp flags, and No Bet reasons.
4. Add tests for every calculation and qualification state plus the user-visible board behavior.

Run `pnpm check`. Repair in-scope failures, update sprint/task/progress documentation, and make small commits. Stop for provider selection, paid API keys, secrets, production deployment, destructive actions, conflicts with user work, or betting-policy ambiguity. Do not browse for or fabricate live games; use clearly labeled fixtures until a data provider and cost ceiling are approved.
