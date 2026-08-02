---
title: 'Phase 1 Full-Market Odds Read'
type: 'bugfix'
created: '2026-08-02'
status: 'in-review'
baseline_revision: 'b55d9009de4e385315da9b73edc340245e23b262'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-mvp-001b-games-and-odds-read-api.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The live Phase 1 API and UI return only the away price even though fixture ingestion persists complete two-way MLB and three-way soccer moneyline markets. This makes the displayed market incomplete and causes the deployment smoke gate to fail.

**Approach:** Join every expected CURRENT selection for each supported sport using bounded exact reads, preserve deterministic market order, fail closed on partial markets, and validate the same complete contract at the web boundary.

## Boundaries & Constraints

**Always:** MLB moneyline contains ordered away/home selections; soccer three-way moneyline contains ordered away/draw/home selections. Build exact CURRENT keys only for the returned event page, validate every row through the existing storage validator and canonical event/version/sport binding, reconstruct output independently of DynamoDB response order, preserve event pagination metadata, and represent a wholly absent market as unavailable. Keep the existing 50-game maximum and gateway chunking, yielding at most 150 exact keys.

**Block If:** Supporting complete markets requires a table Scan, weakening CURRENT validation, changing the fixture seed contract, or inventing a selection not persisted by ingestion.

**Never:** Return a partial market as available; depend on BatchGet response order; add sports, markets, provider calls, calculations, recommendations, or alter authentication/cursor semantics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| MLB | Complete fixture CURRENT rows | Away then home prices | 200 available |
| Soccer | Complete fixture CURRENT rows in arbitrary storage order | Away, draw, then home prices | 200 available |
| Unpriced | No expected CURRENT rows | Explicit unavailable | 200 |
| Partial | Some but not all expected rows | No misleading market | Storage error / redacted 500 |
| Corrupt | Duplicate, unexpected, malformed, or mismatched row | No payload leak or false price | Storage error / redacted 500 |

</intent-contract>

## Code Map

- `packages/database/src/games-repository.ts` -- constructs exact selection keys, validates rows, and joins complete ordered markets.
- `packages/database/src/games-repository.test.ts` -- proves complete, bounded, order-independent reads and fail-closed behavior.
- `apps/web/src/api.ts` -- validates sport-specific complete market payloads at the browser boundary.
- `apps/web/src/api.test.ts` -- covers accepted MLB/soccer payloads and rejected incomplete or forged markets.
- `apps/web/src/App.test.tsx` -- proves every returned selection renders.
- `scripts/phase1-environment-smoke.mjs` -- live deployment acceptance already requires exact complete fixture markets.

## Tasks & Acceptance

**Execution:**
- [x] `packages/database/src/games-repository.ts` -- replace the single-away selection join with ordered sport market specifications and bounded exact reads; reject partial markets.
- [x] `packages/database/src/games-repository.test.ts` -- cover MLB two-way, soccer three-way, arbitrary response order, wholly missing, partial, corrupt, duplicate, unexpected, and 50-game bounded reads.
- [x] `apps/web/src/api.ts` -- accept only complete ordered sport-specific selections with participant/draw labels and existing timestamp/book validation.
- [x] `apps/web/src/api.test.ts`, `apps/web/src/App.test.tsx` -- prove boundary rejection cases and rendering of all market prices.
- [x] `scripts/phase1-environment-smoke.mjs` -- retain exact live fixture assertions as the launch gate.

**Acceptance Criteria:**
- Given seeded MLB data, when games are read and rendered, then both away and home fixture prices appear in deterministic order.
- Given seeded MLS data, when games are read and rendered, then away, draw, and home fixture prices appear in deterministic order.
- Given a maximum soccer page, when odds are joined, then no more than 150 exact keys are requested and no Scan occurs.
- Given wholly missing odds, when a game is read, then it remains visible with unavailable odds; given partial or corrupt odds, the read fails closed.
- Given the deployed Phase 1 environment, when the guarded launch runs, then API/CORS/auth and browser smoke pass with exact full-market fixture odds.

## Spec Change Log

## Review Triage Log

### 2026-08-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 2, medium 4, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Updated the fixture-seed integration assertion from obsolete single-away output to complete MLB and soccer markets, restoring the workspace gate.
  - `[medium]` `[patch]` Added explicit three-way soccer UI rendering coverage, including the draw selection.
  - `[high]` `[patch]` Made hosted Cognito input and submit selection target only visible controls so real login remains operable across Hosted UI variants.
  - `[medium]` `[patch]` Waited for callback token persistence instead of treating the earlier history URL replacement as completed authentication.
  - `[medium]` `[patch]` Verified logout at its stable return destination instead of racing a transient Cognito logout URL.
  - `[medium]` `[patch]` Accepted Cognito's resolved login URL as proof of required re-authentication after logout.

## Design Notes

Market shape is a closed fixture-MVP contract, not inferred from returned rows. The repository derives every expected key from canonical event identity and then rebuilds output in specification order. This prevents Dynamo response order or partial persistence from changing what users see.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test` -- complete-market join and corruption cases pass.
- `pnpm --filter @find-the-edge/web test` -- full payload validation and rendering pass.
- `pnpm check` -- all workspace gates pass.
- `pnpm phase1:launch` with guarded environment variables -- live auth, seed, API, CORS, and browser proof pass.

## Auto Run Result

**Summary:** Complete fixture markets now flow from persisted CURRENT rows through the authenticated games API into the hosted UI. MLB renders away/home; soccer renders away/draw/home; partial or corrupt markets fail closed.

**Files changed:**
- `packages/database/src/games-repository.ts` -- bounded exact full-market join and deterministic ordering.
- `packages/database/src/games-repository.test.ts` -- complete, missing, partial, corrupt, unordered, and 150-key boundary coverage.
- `apps/web/src/api.ts` -- strict sport-specific full-market browser validation.
- `apps/web/src/api.test.ts` -- valid and forged/incomplete payload coverage.
- `apps/web/src/App.test.tsx` -- MLB and soccer full-market rendering proof.
- `apps/workers/src/fixture-odds-seed.test.ts` -- end-to-end seed/read expectations for every fixture selection.
- `tests/phase1-e2e/environment.spec.ts` -- stable current Cognito controls and full hosted odds/session proof.

**Review findings:** Six patches applied; no deferred or rejected findings. The production behavior was unchanged by review fixes after the repository/browser contract implementation; review closed integration and live-test gaps.

**Follow-up review recommendation:** false. Independent blind and edge-case reviews completed, all concrete findings were verification-layer gaps, and the repaired full workspace plus live deployment gates pass.

**Verification:** Database 85/85, web 45/45, workers 37/37, Phase 1 tooling 35/35, full `pnpm check`, and guarded AWS `pnpm phase1:launch` all pass. Hosted Playwright is 2/2 and the launch completed at `https://d3p82iqawjc9pl.cloudfront.net`.

**Residual risks:** This Phase 1 release uses deterministic fixture ingestion, not a live sportsbook provider. Market shapes remain intentionally limited to MLB moneyline and MLS three-way moneyline.
