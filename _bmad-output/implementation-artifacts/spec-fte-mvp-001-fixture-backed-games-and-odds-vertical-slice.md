---
title: 'FTE-MVP-001 Fixture-Backed Games and Odds Vertical Slice'
type: 'feature'
created: '2026-08-01'
status: 'blocked'
review_loop_iteration: 2
followup_review_recommended: false
baseline_revision: '986fdf6f76c'
context:
  - '_bmad-output/implementation-artifacts/spec-fte-data-002-checkpointed-upcoming-event-ingestion-orchestrator.md'
  - '_bmad-output/implementation-artifacts/spec-fte-016-event-repository-api-and-pagination.md'
  - '_bmad-output/implementation-artifacts/spec-fte-data-003-multi-sport-odds-collection-policy-and-snapshot-jobs.md'
  - '_bmad-output/implementation-artifacts/spec-fte-data-003a-durable-odds-provider-page-recovery.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The MVP has canonical event ingestion and a repository/API foundation, but users cannot yet see a coherent list of real application games with current prices. The previous production-grade odds recovery stories did not converge and are blocked.

**Approach:** Deliver one bounded, fixture-backed vertical slice for MLB and MLS: ingest canonical games and immutable odds snapshots, project the current odds, expose them through the read API, and render games filterable by sport and Eastern-calendar day. Make the same fixture mode deployable in the CDK development environment and prove it with a credential-free smoke path.

## Boundaries & Constraints

**Always:** Reuse the DATA002 DynamoDB canonical event/mapping records and FTE-016 read contracts; support exactly MLB and MLS fixture data; represent odds observations as content-addressed immutable DynamoDB snapshots tied to the exact canonical event ID/version; reject a same-ID/different-content replay; choose current odds deterministically from exact current-projection items; keep each event's ingestion transaction-bounded; deploy a separately invokable fixture seed Lambda/command that writes the shared table (never seed during API cold start); compose `/games` from the shared DynamoDB event/current-odds repositories with bounded Query/BatchGet and no Scan; authenticate the deployed API and explicitly configure browser API base, CORS, and an injected token provider boundary; show clear empty/error states and sort visible games chronologically; interpret game and observation times in `America/New_York`.

**Block If:** Canonical fixture identities cannot be reconciled without replacing DATA002 contracts, or deployable authentication requires a new product/security decision.

**Never:** Call or emulate a live odds provider; use a process-local repository in deployed API/seed paths; seed data at API module initialization; mock `/games` in the integration smoke; implement external pagination, quota budgeting, retry/recovery checkpoints, distributed workflows, bet placement, recommendations, additional sports, or multiple UI pages. Do not modify or revive the blocked DATA003/DATA003A specifications.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Fixture ingest | Same MLB/MLS fixture batch executed twice | Canonical games remain stable; duplicate snapshot identities are not created | Reject malformed or unknown-event odds atomically |
| Current projection | Multiple observations for an event/selection/book | Latest deterministic observation is returned with its timestamp | No odds returns an explicit unavailable/empty price state |
| Games query | Sport plus valid Eastern `YYYY-MM-DD` | Chronological games for that sport/day with current odds | Invalid sport/day is a client error; repository failure is an error state |
| UI filter | User changes sport or day | One-page list updates and preserves transparent fixture labeling | Valid empty result renders an empty state, not a crash |

</intent-contract>

## Code Map

- `packages/odds/src/` -- normalized fixture snapshot, current projection, and game-with-current-odds DTO contracts.
- `packages/providers/src/fixtures/` -- bounded MLB and MLS schedule/odds fixtures and adapter exports.
- `packages/database/src/` -- DynamoDB immutable snapshot persistence, idempotent transaction ingestion, exact bounded current-odds reads, in-memory contract parity, and repository composition.
- `apps/workers/src/` -- fixture seed/ingest orchestration and command entry point.
- `apps/api/src/handler.ts` -- authenticated games read route/query mapping and DTO response.
- `apps/web/src/App.tsx`, `apps/web/src/styles.css` -- single-page game list, sport/day controls, odds display, and states.
- `infra/cdk/src/foundation.ts` -- fixture-mode dev seed Lambda, shared-table IAM, API base/CORS outputs/configuration, and authenticated `/games` wiring.
- `tests/e2e/` -- real local integration harness that seeds the repository, serves the authenticated API adapter, and drives the UI without intercepting `/games`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/odds/src/` and `packages/providers/src/fixtures/` -- define the minimal cross-layer DTOs and deterministic MLB/MLS odds fixtures.
- [x] `packages/database/src/` -- implement and parity-test DynamoDB plus memory persistence: canonical condition check, content-addressed immutable insert, monotonic current item, and exact bounded joined read.
- [x] `apps/workers/src/` -- add an invokable, environment-gated seed Lambda/command that composes DATA002 event ingestion and odds ingestion against the shared repository and proves rerun safety.
- [x] `apps/api/src/` -- extend the authenticated shared-Dynamo read surface with sport/day games plus current odds; invalid calendar days are 400 and repository failures are redacted.
- [x] `apps/web/src/` -- implement one-page games filtering with configurable API base/injected token, abort plus stale-response guard, and Eastern-labeled game/observation times.
- [x] `infra/cdk/src/` -- deploy and assert the seed invocation path, least-privilege shared-table IAM, JWT `/games`, CORS, and explicit web API/auth configuration contract.
- [x] `tests/e2e/` -- run a real credential-free local seed→authenticated API→UI smoke; route interception or hand-authored `/games` responses are forbidden.

**Acceptance Criteria:**
- Given a clean local checkout, when the fixture seed runs twice, then the stored MLB/MLS games and snapshot counts are stable and every snapshot references a canonical DATA002 event.
- Given authenticated read access, when games are requested by supported sport and Eastern day, then the response is chronological and includes deterministic current odds plus observation timestamps.
- Given the MVP page, when a user selects MLB or MLS and changes the day, then only matching games appear with participant names, start time, and available prices; valid no-result days show an empty state.
- Given credential-free development configuration, when CDK synth and the smoke suite run, then the fixture-backed API/worker/UI wiring is proven without contacting an external provider.

## Spec Change Log

- 2026-08-01 loop 2: Review confirmed the vertical slice still bundled two unresolved contracts: production-grade concurrent/late-arrival snapshot semantics and a real browser identity integration. Per standing approval, the story is blocked for non-convergence and decomposed. KEEP for successor slices: shared canonical Dynamo state, separately invokable fixture seed, exact bounded reads, non-mocked integration, MLB/MLS scope, Eastern-day UI.

- 2026-08-01 loop 1: Blind and Edge reviews found that “deployable fixture mode” was interpreted as API cold-start memory seeding. Amended Always/Never, code map, tasks, and smoke requirements to require shared DynamoDB canonical persistence, a separately invokable seed, content-verified immutability, explicit browser API/CORS/token configuration, and a non-mocked local integration harness. KEEP: bounded MLB/MLS fixtures, single-page UI, Eastern-day filtering, no live provider workflow.

- 2026-08-01: Implemented the bounded fixture vertical slice from baseline `986fdf6`: three DATA002-derived canonical MLB/MLS events, six idempotent immutable observations, deterministic current projection, authenticated `/games`, Eastern-day UI filters, explicit fixture-mode CDK wiring, and credential-free browser smoke.

## Review Triage Log

- 2026-08-01 loop 2: intent_gap 0; bad_spec 5 (high 5); patch 10 (high 3, medium 7); defer 0; reject 0. Non-convergent contracts: late observations versus monotonic current transaction, concurrent replay, dynamic canonical versions/memory parity, missing production token provider, and e2e not exercising Dynamo semantics. Story blocked and decomposed into narrower corrective slices.

- 2026-08-01 loop 1: intent_gap 0; bad_spec 6 (high 6); patch 4 (high 2, medium 2); defer 0; reject 0. Loopback triggered by ephemeral deployed storage, absent seed deployment, absent Dynamo exact-read composition, mocked integration, missing browser deployment wiring, and trusted snapshot IDs. Patch requirements folded into re-derivation: invalid day→400, same-ID mutation rejection, stale-response guard, Eastern observation labels.

## Design Notes

Snapshot identity is derived from canonical event/version plus normalized observation content. Current odds are a read projection (latest timestamp with a stable tie-break), not mutable source records. At most 50 event-current keys are read exactly for one existing event page; no table scan is permitted. Browser authentication is an injected token boundary because login UI is out of scope. Local tests may compose in-memory repositories; the deployable dev stack uses the existing DynamoDB/event API foundation and a fixture-only worker mode.

## Verification

**Commands:**
- `pnpm check` -- all formatting, lint, boundaries, types, unit tests, and builds pass.
- `pnpm synth` -- fixture-mode development stack synthesizes without external credentials/provider calls.
- `pnpm test:e2e` -- seed/read/render/filter smoke path passes.

## Auto Run Result

Loop 1 implementation is review-ready without a commit. The fixture seed reuses DATA002 canonical bootstrap persistence and is stable on rerun (3 games, 6 snapshots); Dynamo writes condition on the exact canonical event/version, insert immutable content-addressed snapshots, and advance exact CURRENT items monotonically. `/games` is JWT-scoped and reads the shared table with one bounded event Query plus bounded per-event current-odds Queries and no Scan. The browser uses explicit API/token injection, abort and request fencing, Eastern-day controls and labels, and chronological rendering. CDK deploys an environment-gated, separately invokable fixture seed Lambda plus shared-Dynamo API/CORS/runtime outputs.

Verification: focused database 63/63, workers 29/29, API 5/5, web 3/3, and CDK 4/4 tests pass; `pnpm check` passes all 15 typecheck/build packages and all workspace tests; configured credential-free `pnpm synth` succeeds; the non-intercepted local seed→Bearer API→UI Playwright smoke passes 6/6 across desktop and mobile; `git diff --check` passes.

## File List

- `packages/odds/src/index.ts`
- `packages/providers/src/{index.ts,fixtures/mvp-odds.ts}`
- `packages/database/src/{index.ts,game-odds-repository.ts,game-odds-repository.test.ts,event-read-projection.ts,dynamodb-event-repository.ts}`
- `apps/workers/src/{index.ts,fixture-seed.ts,fixture-seed-lambda.ts,fixture-seed.test.ts}`
- `apps/api/src/{handler.ts,handler.test.ts,lambda.ts}`
- `apps/web/src/App.tsx`
- `infra/cdk/src/{app.ts,foundation.ts,foundation.test.ts}`
- `tests/e2e/{games.spec.ts,local-games-api.ts}` and `playwright.config.ts`
- workspace package manifests and `pnpm-lock.yaml`
