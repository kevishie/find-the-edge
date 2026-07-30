# Progress Log

## 2026-07-29 — FTE-003 complete

- Outcome: added all architecture-aligned package skeletons and documented each package responsibility.
- Outcome: added a manifest-based dependency allowlist plus negative tests proving UI-to-database and domain-to-provider edges fail.
- Files: `packages/{auth,config,database,observability,ui,test-utils}`, all package READMEs, `scripts/check-boundaries*`, root scripts, lint config, lockfile, and status docs.
- Gates: `pnpm check` passed across 12 workspace packages, including the boundary gate, strict typecheck, tests, and builds.
- Decisions: keep universal domain dependency-free and enforce frontend/infrastructure separation at the manifest graph.
- Blockers: none.
- Next: `FTE-004`, unit, integration, and E2E test harness.

## 2026-07-29 — FTE-002, FTE-SPORT-005, FTE-SPORT-006, FTE-SPORT-007 complete

- Outcome: completed the generic TanStack Router app shell without removing the working local Edge Lab.
- Outcome: added weighted two-way and three-way no-vig consensus, offered-sportsbook exclusion, and explicit stale, suspended, sparse, and outlier results.
- Outcome: added the registry-driven `/sports/:sportKey/events` explorer using module maturity and UI terminology without sport-key branching.
- Outcome: added universal fixture events for MLB, soccer, tennis, NFL, and NCAAF. MLB and soccer expose versioned fixture No Bet decisions; planned modules publish neither strategies nor recommendations.
- Files: `apps/web`, `packages/odds`, `packages/sports`, workspace lockfile, BMAD status/backlog, changelog, decision log, and progress.
- Versions: fixture decisions display sport module, strategy, model, and calculation versions. No prompt version is stored because AI is not used.
- Gates: full `pnpm check` passed (format, lint, strict typecheck, 24 tests, and all builds); browser smoke passed at 1440x900 and 390x844 with no console warnings/errors or horizontal overflow.
- Commits: `3a83cd6`, `b7cb21b`, plus the final status/check commit.
- Decisions: normalize no-vig per book before weighting, exclude low-quality inputs explicitly, and withhold recommendations for planned modules.
- Blockers: none. No secrets, providers, paid services, live data, infrastructure, or migrations were used.
- Next: `FTE-003`, shared package structure and dependency boundaries.

## 2026-07-26 — Multi-sport architecture foundation

- Audited all BMAD artifacts and current code for soccer, MLB, and fixed-sportsbook coupling.
- Added binding multi-sport amendments to architecture, PRD, and epics; preserved original planning detail.
- Added ADR 0001 and the architecture coupling report.
- Implemented universal domain contracts, `SportModule`, registry, maturity states, and strategy validation.
- Registered MLB beta, soccer experimental, and planned tennis/NFL/NCAAF modules.
- Added capability-specific provider ports and deterministic prompt composition/versioning.
- Genericized core odds qualification so approved markets come from strategy.
- Gates passed: formatting, lint, strict typecheck, 19 tests, and all package/application builds.
- No external services, secrets, infrastructure, paid APIs, or live betting data were used.
- Next: complete the generic app shell/story, then implement weighted consensus states and a registry-driven sport explorer.

## 2026-07-26 — Assessment and execution reset

- Confirmed the authoritative GitHub repository and preserved the untracked design uploads.
- Identified implementation epics/stories as the last completed artifact; no code story had started.
- Established versioned product, sport, model, prompt, evaluation, decision, autonomous-loop, and task-queue documentation.
- Completed `FTE-001` and unlocked `FTE-002`, `FTE-003`, and `FTE-006`.
- Implemented the first vertical slice: deterministic odds math and a responsive local fixture-backed Edge Lab.
- Gates passed: formatting, lint, strict typecheck, 13 tests, and production build.
- No provider keys, cloud resources, or paid LLM calls were introduced.
- Next: formalize domain/evidence schemas, then implement weighted multi-book consensus and MLB board fixtures.
