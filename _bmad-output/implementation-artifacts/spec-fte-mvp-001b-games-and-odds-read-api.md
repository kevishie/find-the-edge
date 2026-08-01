---
title: 'FTE-MVP-001B Games and Odds Read API'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '75ede86'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Canonical fixture events and current odds can now be seeded persistently, but consumers have no bounded authenticated read that joins FTE-016 event pages with A2 CURRENT projections.

**Approach:** Add a games read repository/DTO and authenticated `GET /games` route for supported MLB/MLS sport and Eastern day. Reuse the existing event page/cursor contract, then exact-read at most one CURRENT odds item per returned event without Scan.

## Boundaries & Constraints

**Always:** Preserve FTE-016 list semantics: required supported sport, `scheduled` status, valid Eastern `YYYY-MM-DD`, optional league/cursor, limit 1–50, chronological order, projection/freshness metadata, and encrypted partition-bound cursor. Join only the returned page (max 50) using bounded exact GetItem/BatchGet-compatible reads of A2 CURRENT items; validate every current row through A1 and require canonical event ID/version/sport match. Represent odds explicitly as `available` with observation/retrieval times and bounded selections, or `unavailable`; an absent current item is not an error. Keep route authenticated through the existing JWT subject plus `events:read` scope. Invalid sport/calendar/limit/cursor is 400, missing auth 401, missing scope 403, repository/storage corruption 500 with redacted body. CORS/cache headers remain explicit and logs contain no token or odds payload.

**Block If:** Current A2 storage keys cannot be read exactly by canonical event without a small read-only A2 key helper/export, or the existing event cursor cannot be reused without weakening partition binding.

**Never:** Add UI/browser auth, seed behavior, API cold-start data, table Scan, live provider calls, pagination beyond the existing event cursor/page, recommendations, betting, retries/recovery, or new sports. Never trust unvalidated Dynamo CURRENT content.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Games | Authenticated MLB/MLS Eastern day | Chronological page with current odds/unavailable | 200 |
| Empty/unpriced | Valid day empty or event lacks CURRENT | Empty page or explicit unavailable | 200 |
| Invalid | Unknown sport, impossible day, limit/cursor mismatch | No repository leak | 400 |
| Auth | Missing subject or scope | No read | 401/403 |
| Corrupt/stale current | Row malformed or binding/version mismatched | No partial false price | Redacted 500 |

</intent-contract>

## Code Map

- `packages/domain/src/` -- bounded game/current-odds display DTO if shared across API/UI.
- `packages/database/src/games-repository.ts` -- event page plus exact CURRENT join and validation.
- `packages/database/src/dynamodb-games-repository.ts`, `memory-games-repository.ts` -- concrete bounded read parity.
- `apps/api/src/handler.ts`, `lambda.ts` -- authenticated `/games` query mapping and Dynamo composition.
- `infra/cdk/src/foundation.ts` -- JWT `GET /games` route and read-only exact table IAM.

## Tasks & Acceptance

**Execution:**
- [x] domain/database -- add bounded DTO and memory+Dynamo joined repository with current-row validation and no Scan.
- [x] API -- add authenticated games route with strict query/error/header/logging tests.
- [x] CDK -- wire JWT `/games`, read-only exact IAM, and route assertions without changing seed behavior.

**Acceptance Criteria:**
- Given seeded MLB/MLS data, when authenticated games are queried by Eastern day, then chronological canonical games include validated current prices/timestamps or explicit unavailable.
- Given cursor/filters, when paging, then FTE-016 snapshot/partition binding and max-50 bounded reads remain intact.
- Given malformed/mismatched current data, when read, then API returns redacted 500 and never exposes a false price or payload.
- Given full gates/synth, then route/JWT/IAM are proven with no Scan, UI, seed-at-read, or external calls.

## Spec Change Log

## Review Triage Log

- 2026-08-01 review: intent_gap 0; bad_spec 0; patch 0; defer 0; reject 0. Blind and Edge reviews found no concrete issues; focused and full gates remain green.

## Design Notes

The join is read-side only: canonical events remain authoritative and immutable odds history remains separate. CURRENT is a cache-like projection accepted only after A1 identity/binding validation.

Implementation keeps the FTE-016 event page and cursor unchanged, adds canonical event version to its DTO, and exact-reads one fixture primary-selection CURRENT key per returned game (maximum 50). The exported A1 partition helper and A2 CURRENT validator are the only new read helpers. Missing CURRENT is explicit `unavailable`; malformed, forged, duplicate, or event/version/sport-mismatched rows are storage failures. The Lambda shares the existing JWT authorizer and cursor secret, while CDK grants only Get/BatchGet/Query/TransactGet plus secret read and configures explicit GET CORS.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test` -- memory/Dynamo join parity passes.
- `pnpm --filter @find-the-edge/api test` -- auth/query/error DTO tests pass.
- `pnpm --filter @find-the-edge/infra-cdk test` -- JWT route/IAM assertions pass.
- `pnpm check` -- workspace gates pass.
- `pnpm synth` -- configured dev stack synthesizes.

**Result:** Focused tests pass: database 82/82, API 6/6, infra 6/6. `pnpm check` passes all format/lint/boundary gates, 15/15 typechecks, tooling typecheck, 22/22 test tasks, and 15/15 builds. Configured fixture-enabled dev synth passes and contains JWT `GET /games`, exact `dynamodb:BatchGetItem` IAM, and CORS. Focused source no-Scan check and `git diff --check` pass. No UI, seed-read behavior, live provider, external call, recovery, recommendation, betting, or commit was added.
