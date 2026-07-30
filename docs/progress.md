# Progress Log

## 2026-07-29 — FTE-006 complete

- Outcome: added typed local, provider, and AWS environment profiles with structured missing/malformed errors.
- Outcome: added a secret-free `.env.example` and a complete local fixture-mode setup/troubleshooting guide.
- Security: local mode requires no values; provider and AWS values become required only when those adapters are selected; real env files remain ignored.
- Gates: four config schema tests and full `pnpm check` passed.
- Blockers: none.
- Next: `FTE-007`, synth-only base AWS CDK skeleton; no deployment or chargeable resources.

## 2026-07-29 — FTE-005 complete

- Outcome: added GitHub Actions jobs for frozen installation, formatting, lint, dependency boundaries, typechecks, unit tests, coverage, builds, and desktop/mobile E2E smoke.
- Reliability: CI cancels stale runs, has bounded timeouts, grants read-only repository permissions, and uploads Playwright diagnostics only on failure.
- Gates: workflow YAML parsed successfully; the full CI command sequence passed locally, including four E2E scenarios.
- Blockers: none; the workflow requires no secrets or external providers.
- Next: `FTE-006`, environment validation and local development documentation.

## 2026-07-29 — FTE-004 complete

- Outcome: added a typed Playwright harness with desktop and mobile Chromium projects plus a deterministic test utility sample.
- Outcome: added web coverage configuration with 50% statement/function/line and 40% branch starter thresholds.
- Outcome: retained screenshots, video, traces, and an HTML report for failed E2E runs.
- Gates: `pnpm check` passed; web coverage passed at 81.53% statements and 63.15% branches; four desktop/mobile E2E tests passed.
- Blockers: none; tests use local fixtures and no secrets or provider access.
- Next: `FTE-005`, GitHub Actions CI quality gates.

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
