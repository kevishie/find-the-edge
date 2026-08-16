---
title: 'Expire pregame boards at kickoff'
type: 'bugfix'
created: '2026-08-15'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'edb81cbc881ef3e87234efcf5ba5ee7497f70b04'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-sharpapi-closing-live-contract-repair.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A board generated before kickoff can remain valid for ten minutes, and its API response can remain cached for another fifteen seconds, allowing started games to display pregame odds even though the live repository fails closed. Users must never see pregame prices represented as current evidence after kickoff.

**Approach:** Derive the earliest kickoff of every item without canonical closing provenance and use it as a hard validity boundary for both persisted boards and the in-process response cache. At that boundary, fall through to the closing-aware live repository, which either serves a canonical close or reports closing data unavailable.

## Boundaries & Constraints

**Always:** Treat kickoff as an exclusive upper bound for pregame evidence; apply the same rule to games and splits; preserve cached canonical closing boards; fail closed on malformed stored response bodies.

**Ask First:** None; the user explicitly approved this production data-integrity hotfix, push, and staging deployment.

**Never:** Extend stale pregame odds past kickoff, infer a close from time alone, mutate historical odds, or weaken the canonical-closing identity checks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Pregame board crosses kickoff | Fresh stored games or splits board contains `pregame-snapshot` | Reject board at kickoff and use live closing-aware projection | No stale fallback |
| Response cache crosses kickoff | Cached response has a noncanonical event whose start arrives inside 15 seconds | Cache entry expires exactly at kickoff | Reload through stored/live guards |
| Canonical close | Started item has `canonical-closing` provenance | Board/cache may remain valid under normal TTL | Existing age bounds remain |
| Malformed board body | Stored body cannot prove item identity/provenance | Reject persisted board | Fall through to live projection |

</frozen-after-approval>

## Code Map

- `packages/database/src/board-projection.ts` -- stored-board validation and kickoff safety boundary.
- `packages/database/src/board-projection.test.ts` -- games/splits and canonical-close boundary regressions.
- `apps/api/src/splits-cache.ts` -- bounded cache with value-derived absolute expiry.
- `apps/api/src/handler.ts` -- board response cache configuration.
- `apps/api/src/handler.test.ts` -- response-cache kickoff regression.

## Tasks & Acceptance

**Execution:**
- [x] `packages/database/src/board-projection.ts` and tests -- reject fresh pregame boards once any noncanonical item reaches kickoff.
- [x] `apps/api/src/splits-cache.ts` and tests -- support an absolute, value-derived expiry without weakening ordinary TTL behavior.
- [x] `apps/api/src/handler.ts` and tests -- expire cached games/splits responses at their earliest unsafe kickoff.
- [x] Repository -- run the full validation gate and independent adversarial review before release.

**Acceptance Criteria:**
- Given a pre-kickoff materialized board, when its first noncanonical event reaches kickoff, then neither `/games` nor `/splits` serves that stored pregame evidence.
- Given a cached pregame response, when kickoff occurs during the cache TTL, then the next request reloads and cannot receive the prior pregame response.
- Given a canonical closing response for a started event, when the normal cache and board TTLs are valid, then it remains eligible to serve.

## Spec Change Log

## Design Notes

One shared body inspection helper computes the earliest unsafe kickoff. Persisted-board validation compares it with request time; the response cache uses the same instant as an absolute expiry. This prevents timing drift between storage and API layers.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/database test -- board-projection.test.ts` -- boundary tests pass.
- `pnpm --filter @find-the-edge/api test -- handler.test.ts splits-cache.test.ts` -- cache boundary tests pass.
- `pnpm check && git diff --check` -- repository gates pass.

**Manual checks:**
- Refresh the signed-in staging board after deployment and confirm no started game displays `pregame snapshot`; canonical books show closing lines and missing canonical evidence shows unavailable.

## Suggested Review Order

**Kickoff safety boundary**

- Inspect board provenance once and derive both reuse and priced-evidence boundaries.
  [`board-projection.ts:348`](../../packages/database/src/board-projection.ts#L348)

- Reject persisted noncanonical boards exactly when their earliest event starts.
  [`board-projection.ts:404`](../../packages/database/src/board-projection.ts#L404)

**In-process cache enforcement**

- Clamp ordinary TTLs, recheck delivery, and reload slow pregame responses once.
  [`splits-cache.ts:27`](../../apps/api/src/splits-cache.ts#L27)

- Apply strict kickoff inspection only to games and splits response caches.
  [`handler.ts:226`](../../apps/api/src/handler.ts#L226)

**Regression proof**

- Verify stored games, splits, legacy provenance, malformed bodies, and canonical closes.
  [`board-projection.test.ts:59`](../../packages/database/src/board-projection.test.ts#L59)

- Prove concurrent slow loads cannot release pregame evidence after kickoff.
  [`splits-cache.test.ts:130`](../../apps/api/src/splits-cache.test.ts#L130)

- Exercise exact-kickoff expiry and canonical caching through both public routes.
  [`handler.test.ts:1761`](../../apps/api/src/handler.test.ts#L1761)
