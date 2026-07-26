# Next-Run Prompt

Continue the multi-sport FIND THE EDGE MVP in `/Users/kevishie/Projects/find-the-edge`.

Read the binding multi-sport amendments at the top of the BMAD architecture, PRD, and epics; ADR 0001; `docs/autonomous-loop.md`; `docs/task-queue.md`; sprint status; and progress. Preserve untracked `design/claude/uploads/` and unrelated user work.

Execute the highest-priority unblocked work:

1. Finish `FTE-002` as a generic app-shell foundation without removing the working local Edge Lab.
2. Implement `FTE-SPORT-007`: weighted two-way and three-way no-vig consensus, exclusion of the offered sportsbook, and explicit stale/suspended/sparse/outlier results.
3. Implement `FTE-SPORT-005`: registry-driven sport selector and generic `/sports/:sportKey/events` explorer. Display module maturity and use module UI terminology without `if (sportKey === ...)` branching.
4. Add generic fixture events for registered modules, but publish no recommendations for planned modules.

Use universal domain types and registered module/strategy behavior. Do not add pitcher, quarterback, formation, surface, or other sport fields to shared events. Store/display sport module, strategy, model, calculation, and prompt versions where applicable.

Run `pnpm check` and browser smoke at desktop/mobile widths. Update BMAD status, backlog, changelog, decision log, and progress; make small commits. Stop for secrets, paid services, chargeable infrastructure, destructive migrations, product conflicts, unsupported live data, or tests requiring a scope change.
