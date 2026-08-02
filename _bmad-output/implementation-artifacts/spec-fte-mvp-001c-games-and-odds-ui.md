---
title: 'FTE-MVP-001C Games and Odds UI'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 2
followup_review_recommended: false
baseline_revision: '3acfa34'
final_revision: 'ce35106'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The authenticated games API is ready, but the UI still renders local fixture cards and cannot show seeded games/odds filtered by sport and Eastern-calendar day.

**Approach:** Replace the event explorer's displayed data path with an API-backed one-page games view for MLB and MLS, using explicit runtime API-base and access-token-provider injection. Prove the browser path through a local authenticated API harness without intercepting `/games`.

## Boundaries & Constraints

**Always:** Consume the committed B2 bootstrap result without reconstructing runtime config in `main`; invalid/missing config/provider/token becomes a visible typed error, never a pre-React throw. Provide MLB/MLS sport controls and an accessible date input interpreted as `America/New_York` `YYYY-MM-DD`. Fetch `/games?sport=<key>&status=scheduled&day=<day>` from B2's API base and acquire its bounded/redacted Bearer token for every request. Strictly validate exact plain DTO shape and require every game to match requested sport, supported league, and Eastern calendar day recomputed from `startsAt`; require unique participants, chronological ordering, and valid odds state/binding. Render only the response matching current filters, with participant names, Eastern start time, explicit fixture label, and odds available/unavailable; available odds show bounded selection/book prices and Eastern-labeled observation time. On filter change clear prior games, abort old request, and guard commits with request ID so late resolution cannot overwrite state. Provide accessible loading, error, valid-empty states and avoid token/payload logging. Keep Edge Lab usable.

**Block If:** A deploy-time web runtime configuration mechanism cannot be added without choosing a hosting platform, or browser identity requires a product login decision rather than an injectable token-provider boundary.

**Never:** Add login UI/auth SDK, embed `VITE_*` tokens, use `local-e2e-token` in production entry, fall back to local fixture cards for games, intercept/mock `/games` in Playwright, add backend persistence/API/CDK resources, live providers, recommendations, betting, external pagination, retries/recovery, or new sports.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Loaded | Valid runtime config/token, matching games | Chronological game/odds cards | Ready |
| Empty/unpriced | Valid empty day or unavailable odds | Empty state or explicit unavailable | Not an error |
| Filter race | Rapid sport/day changes, late old response | Only newest filter renders | Abort + request ID |
| Runtime/auth | Missing base/provider/token or 401/403 | No stale games/token leak | Accessible error |
| API failure | Invalid payload/network/500 | No stale games | Accessible redacted error |

</intent-contract>

## Code Map

- `apps/web/src/api.ts` -- runtime config/token interfaces, strict DTO validation, authenticated client.
- `apps/web/src/App.tsx`, `styles.css`, `App.test.tsx` -- games view/filter/state/render behavior and component injection.
- `apps/web/src/main.tsx`, `index.html` -- safe runtime config boundary without embedded credentials.
- `tests/e2e/local-games-api.ts`, `games.spec.ts` -- real local seed→authenticated API handler→UI harness with no route interception.
- `playwright.config.ts`, root scripts if needed -- deterministic local web/API startup only.

## Tasks & Acceptance

**Execution:**
- [x] web client/runtime -- consume B2 bootstrap and add exact request-bound DTO validation with no fallback credential or synchronous startup throw.
- [x] web view -- implement sport/Eastern-day controls, loading/error/empty/odds cards, stale-request protection, and accessible tests.
- [x] e2e -- run unchanged A3 seed→Bearer-auth B handler→UI for explicit MLB/MLS fixture days and empty day without ID normalization or `/games` interception.

**Acceptance Criteria:**
- Given valid runtime injection and seeded data, when the games view loads, then matching MLB/MLS games and current odds render with Eastern times.
- Given rapid filter changes or an API error, when requests settle, then stale games never appear and the newest state is accurate/accessibly announced.
- Given no runtime token provider or token, when the page loads, then a clear error appears and no fallback secret/request is used.
- Given Playwright, when smoke runs, then the request traverses the real local authenticated handler/repository and route interception cannot make it pass.

## Spec Change Log

- 2026-08-01 loop 2: B1 and B2 prerequisites are now committed. Re-derived from baseline `3acfa34`: consume B2 nonthrowing bootstrap, enforce exact request-bound sport/league/Eastern-day DTO validation, and forbid all identifier normalization in a deterministic explicit-date e2e. KEEP prior UI/race/accessibility boundaries.

- 2026-08-01 loop 1: Review proved the requested production-faithful e2e is impossible inside UI-only scope because A3 semantic canonical IDs are rejected by the B/FTE016 read projection. Production runtime artifact ownership is also unresolved. C is blocked and decomposed into backend identifier compatibility and deployable runtime-config prerequisites before UI re-derivation. KEEP: injected async token provider, strict response/filter validation, Eastern-day UI, abort/request-ID guards, no interception.

- 2026-08-01: Implemented the strict API client/runtime boundary, games UI states and stale-response guard, and a local Vite harness that seeds the existing repositories and traverses the authenticated B handler. The local harness normalizes fixture-generated identifiers solely at its repository boundary because encoded fixture canonical identifiers are stricter than the read-projection identifier validator; production backend/CDK code is unchanged.

## Review Triage Log

### 2026-08-01 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 1, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Bound the only accepted current fixture selection to the requested sport's B-contract market, away selection, fixture sportsbook, and corresponding away-participant label; unrelated valid-looking odds are rejected.
  - `[medium]` `[patch]` Made already-selected sport and unchanged-day interactions no-ops so they cannot clear a ready result into permanent loading without a new request.
  - `[medium]` `[patch]` Stopped trusting the API's display string and derive the visible Eastern start from the validated `startsAt` timestamp in `America/New_York`.
  - `[medium]` `[patch]` Moved each selection's Eastern-labeled observation timestamp into that selection's price row instead of rendering one shared timestamp.

- 2026-08-01 loop 1: intent_gap 1 (high 1); bad_spec 3 (high 3); patch 4 (medium 4); defer 0; reject 0. Findings: harness ID rewriting masked seed/read incompatibility, invalid runtime config crashed before UI error, response filter/date binding was incomplete, production runtime artifact absent, token provider unbounded/unredacted, and e2e wall-clock dependence.

## Design Notes

`App` accepts a small client/token-provider boundary for tests and embedding. The production entry reads only a runtime object installed by the hosting shell; it contains an API base and token-provider function/reference, never a static bearer token.

## Verification

Implementation facts: `main.tsx` passes the nonthrowing B2 bootstrap result directly into the UI client; the client acquires a bounded token per request and validates the exact one-page DTO against the requested sport, supported league, chronological order, and recomputed Eastern day. Filter events clear old cards before abort/request-ID guarded loading. The e2e server calls unchanged `seedFixtureOdds` and `createEventHandler` over real HTTP; it neither rewrites identifiers nor intercepts `/games`. `local-e2e-token` exists only inside `tests/e2e`.

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- 36/36 UI/client/runtime/race/accessibility tests pass.
- `pnpm test:e2e` -- 6/6 desktop/mobile authenticated seed→API→UI tests pass without interception.
- `pnpm check` -- formatting, lint, boundaries, typechecks, workspace tests, and production builds pass.
