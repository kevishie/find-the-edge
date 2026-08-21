---
title: 'SharpAPI Canonical Closing Lines'
type: 'bugfix'
created: '2026-08-15'
status: 'done'
baseline_commit: '90c316428a4abaf0501aaa50e794fee5bb84b996'
review_loop_iteration: 2
context:
  - '{project-root}/docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Started games are labeled “closing lines” while the board actually reuses the last accepted pregame odds. Moneyline can remain visible even when spread or total was never captured, so users see blank cells despite SharpAPI exposing a canonical closing snapshot.

**Approach:** Integrate SharpAPI's documented `GET /api/v1/odds/closing` endpoint, bind provider event IDs to canonical events before schedule churn removes them, persist independently finalized per-book closing evidence, and make started-game reads prefer a coherent canonical close. Keep scheduled-game current odds unchanged.

## Boundaries & Constraints

**Always:** Treat HTTP status as authority; require the exact SharpAPI event ID; honor the `closing_line` feature and shared account quota; retain only bounded normalized evidence; validate event identity, participants, start, sportsbook, capture timestamp/trigger/finality, and market pairs; accept moneyline, `run_line`, and `total_runs` only when their selections are unambiguous and coherent; merge books idempotently because books finalize independently; preserve immutable source observations; expose closing provenance honestly; fail gracefully when a close is empty, partial, unavailable, rate-limited, or not ready.

**Ask First:** Changing provider entitlement, purchasing historical access, retaining raw provider responses, or using a noncanonical price fallback.

**Never:** Send a canonical FTE ID to SharpAPI; infer provider IDs from labels; overwrite a finalized book capture; choose arbitrary alternate lines; mark a pregame snapshot as provider closing evidence; let one malformed book or unavailable close fail ordinary live ingestion; expose raw error bodies, credentials, or paid payloads.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Canonical close | Recent started event with exact provider binding and finalized book captures | Normalized per-book moneyline/spread/total evidence lands and started board uses it | Idempotent replay |
| Partial transition | Some books absent or `is_final=false` | Finalized books merge; incomplete books remain pending | No event-level freeze |
| Ambiguous market | Multiple complete spread/total pairs with no main-line discriminator | Market remains unavailable | Bounded ambiguity evidence |
| Empty/not ready | `200 books={}` or retryable `503` | Existing evidence remains; later cadence retries | No fabricated close |
| Invalid authority | Missing binding, identity mismatch, 400, 401, 403 | No serving mutation | Bounded metric/reason; terminal auth/entitlement follows existing health policy |

</frozen-after-approval>

## Code Map

- `packages/providers/src/sharp-api.ts` -- documented closing endpoint client and strict per-book/selection parser.
- `packages/database/src/closing-lines-repository.ts` -- durable event/book closing evidence and idempotent finalization.
- `apps/workers/src/production-odds-control-plane.ts` -- recent schedule-binding handoff and shared feature/quota context.
- `apps/workers/src/closing-lines-capture.ts` -- bounded close acquisition, canonical binding, normalization, scoring, and failure isolation.
- `apps/workers/src/live-odds-lambda.ts` -- invoke closing reconciliation before board materialization.
- `packages/database/src/games-repository.ts` -- started-game preference for coherent finalized closing evidence.
- `apps/web/src/App.tsx` -- source-accurate closing/pregame label if DTO provenance must be surfaced.

## Tasks & Acceptance

**Execution:**
- [x] `packages/providers/src/sharp-api.ts` and tests -- implement the official closing request/response contract, bounded errors, empty response, partial books, and coherent market normalization.
- [x] `packages/database/src/closing-lines-repository.ts` and tests -- persist per-book immutable/finalized captures and derive a validated event projection without freezing partial responses.
- [x] `apps/workers/src/{production-odds-control-plane,closing-lines-capture,live-odds-lambda}.ts` and tests -- preserve recent exact provider bindings, reserve quota, reconcile eligible closes, and isolate failures.
- [x] `packages/database/src/games-repository.ts` and API/web tests -- use canonical closing evidence only for started games and keep scheduled reads unchanged.
- [x] `docs/runbooks/sharpapi.md` -- document endpoint semantics, 48-hour retention, recovery, metrics, and live verification.

**Acceptance Criteria:**
- Given a started event with a valid SharpAPI binding and finalized moneyline, run line, and total captures, when the board is read, then all three markets come from the canonical close and carry no fabricated selections.
- Given books finalize at different times, when later captures arrive, then new books merge without rewriting prior finalized evidence or freezing an incomplete event response.
- Given missing, ambiguous, malformed, empty, unauthorized, rate-limited, or not-ready closing data, when reconciliation runs, then ingestion and existing served data remain available and the condition is represented by bounded actionable evidence.
- Given a scheduled event, when the board is read, then current pregame odds behavior is byte-compatible.

## Spec Change Log

- 2026-08-15: Implemented the documented SharpAPI canonical closing endpoint, durable bounded source bindings, independently immutable book captures, account-wide quota and entitlement fencing, coherent started-game projection, honest provenance labels, and CLV retry/reconciliation.
- 2026-08-15: Closed adversarial review findings for fair acquisition rotation, exact Dynamo replay, bounded legacy-compatible binding history, source-group isolation, participant/version identity, per-book failure isolation, and fail-closed capability health.

## Design Notes

SharpAPI captures each sportsbook independently and retains snapshots for 48 hours. Storage therefore keys final evidence by canonical event plus provider book, while the serving projection is derived only from validated finalized books. A market with no documented main-line flag is accepted only when exactly one coherent selection pair exists for that book and market.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test` -- 146 passed, 1 skipped.
- `pnpm --filter @find-the-edge/database test` -- 580 passed.
- `pnpm --filter @find-the-edge/workers test` -- 413 passed, 4 skipped.
- `pnpm check && git diff --check` -- formatting, lint, boundaries, typechecks, unit/integration tests, builds, and 34/34 Playwright tests pass.
- Independent Blind review: CLEAN. Independent Edge review: CLEAN.
