---
title: 'Live The Odds API Games and Odds'
type: 'feature'
created: '2026-08-02'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0459f279787b67670929a146b646d534798caf5f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-002-checkpointed-upcoming-event-ingestion-orchestrator.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003-multi-sport-odds-collection-policy-and-snapshot-jobs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The deployed games UI is populated by three fixed development fixtures, so its schedules and prices are not useful. The production worker, deployment smoke, read path, and UI copy remain fixture-specific even though The Odds API key is available locally.

**Approach:** Use The Odds API as the MVP source for upcoming MLB/MLS events and sportsbook moneylines, persist normalized live observations through the existing canonical event and immutable-current odds contracts, store the key in AWS Secrets Manager, adapt refresh cadence by league and time-to-start under a hard quota governor, and replace the fixture-oriented UI with a compact live-games board.

## Boundaries & Constraints

**Always:** Fetch `baseball_mlb` and `soccer_usa_mls` through official V4 HTTPS endpoints; map provider event IDs, away/home participants, start times, bookmaker identity, American prices, provider timestamps, and retrieval timestamps exactly; validate and bound every response before writes; ingest schedules before their odds; retain idempotent canonical mappings and immutable snapshots; redact keys and credential-bearing URLs; track quota headers; default the UI to today in Eastern Time; prove real anonymous data after deployment. Discover events hourly without quota cost; make odds cadence configurable per league and proximity bucket, prioritizing MLB/MLS hourly and the final 90-minute lineup window while a hard monthly reserve prevents exhaustion.

**Ask First:** Expanding beyond MLB/MLS or moneylines, purchasing/changing a provider plan, adding a statistics/enrichment provider, or deleting anything beyond the exact known development fixture records.

**Never:** Commit or print the key; place it in Lambda environment variables, CloudFormation values, browser assets, or GitHub logs; fabricate odds or event states; infer selections from array order; expose partial markets as complete; exceed the quota governor to satisfy nominal cadence; broadly scan/delete retained data; claim The Odds API supplies injuries, lineups, rosters, venues, or deep statistics.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Live refresh | Valid MLB/MLS response with bookmakers | Canonical games and complete book-specific h2h prices become readable | Replay deduplicates snapshots and advances only newer current prices |
| Empty slate | Valid response with no events/odds | Existing data is not deleted; UI shows an honest empty day | Record successful zero-result run and quota values |
| Partial/malformed | Missing team, duplicate market/outcome, invalid price/time, oversized payload | No misleading partial market is published | Reject bounded unit, redact diagnostics, preserve last good current data |
| Provider failure | Timeout, 401, 429, or 5xx | No state corruption; scheduled retry remains bounded | Stable retryable/nonretryable codes; key and response body stay private |
| Secret failure | Missing/malformed AWS secret | Worker fails before provider request | Redacted configuration error and alarm signal |

</frozen-after-approval>

## Code Map

- `packages/providers/src/upcoming-events.ts`, `coverage-registry.ts`, new The Odds API adapter -- provider-neutral event/market validation and MLB/MLS mappings.
- `apps/workers/src/lambda.ts`, new live ingestion service -- secret-backed fetch, schedule-first canonical persistence, then odds snapshots.
- `packages/database/src/{fixture-odds-adapter,games-repository}.ts` -- generalize fixture naming and select a complete real sportsbook market without hard-coded `fixture-book`.
- `infra/cdk/src/{foundation,app}.ts` -- import the fixed-name secret, least-privilege grant, frequent scheduler tick, and safe manual output.
- `scripts/phase1-{launch,support,environment-smoke}.mjs` -- replace fixture seeding/proofs with bounded live ingestion and real-data assertions.
- `apps/web/src/App.tsx`, API/tests -- current Eastern day and dense responsive multi-game presentation.

## Tasks & Acceptance

**Execution:**
- [x] `packages/providers`, `packages/config` -- implement strict The Odds API client/descriptor for live MLB/MLS h2h discovery, quota metadata, error taxonomy, and credential redaction.
- [x] `apps/workers`, `packages/database`, `packages/config` -- add replay-safe combined live ingestion, provider-neutral complete-market reads, and league/proximity cadence decisions with durable quota reserve; test schedule-before-odds, participant mapping, multi-book selection, due/skip decisions, malformed inputs, and replay.
- [x] `infra/cdk`, deployment workflow/scripts -- read the retained AWS secret only from the worker, expose a safe manual trigger, enable a frequent scheduler tick governed by durable cadence/quota state, stop fixture seeding, and assert no plaintext secret reaches synthesized/deployed artifacts.
- [x] `apps/web`, environment smoke, docs -- default to the current Eastern day, render compact responsive rows/cards for many simultaneous games, remove fixture claims, verify actual provider-backed MLB/MLS games and bookmaker odds, and document quota/cadence operations.
- [x] AWS operations -- create/update `find-the-edge/dev/the-odds-api` from local `.env`, deploy, run initial ingest, back up and delete only exact fixture-development rows, and validate the anonymous live UI.

**Acceptance Criteria:**
- Given the retained secret and a supported live slate, when manual or scheduled ingestion runs, then `/games` and the UI show real provider event identities, start times, bookmaker names, and complete MLB/MLS moneylines without mock records.
- Given league cadence profiles, event proximity, and the 500-credit account, when automation ticks, then due windows are prioritized without crossing the monthly reserve and used/remaining/skipped credits are observable; a larger plan activates the same policy without code changes.
- Given a bad provider response or outage, when refresh executes, then the last valid immutable/current data remains intact and no credential or raw sensitive response is logged.

## Spec Change Log

## Design Notes

The free `/events` response drives hourly discovery; paid-credit `/odds` calls are admitted by a provider-neutral league/proximity policy. The `/odds` response contains event identity, participants, commence time, bookmakers, and markets. A separate stats provider is intentionally deferred: The Odds API supports events, odds, and limited scores, not the enrichment needed for serious statistical modeling.

## Verification

**Commands:**
- `pnpm check && pnpm phase1:test && pnpm test:e2e` -- all quality, contract, and anonymous browser checks pass without provider secrets.
- `pnpm phase1:preflight` -- synthesized resources include secret-read least privilege, live scheduling, and no fixture seeder/plaintext key.
- GitHub quality/deploy workflows plus live smoke -- initial ingestion completes and the deployed UI returns current real bookmaker data.

## Suggested Review Order

**Live ingestion and quota safety**

- Start with schedule-first discovery, adaptive cadence, and fail-closed credit reservation.
  [`live-odds-ingestion.ts:110`](../../../apps/workers/src/live-odds-ingestion.ts#L110)

- Strict provider parsing bounds responses and maps participant-named moneylines.
  [`the-odds-api.ts:105`](../../../packages/providers/src/the-odds-api.ts#L105)

- Secrets stay runtime-only while malformed structured values fail before network access.
  [`live-odds-lambda.ts:21`](../../../apps/workers/src/live-odds-lambda.ts#L21)

**Storage and read integrity**

- Preferred-book fallback returns only complete, timestamp-coherent markets.
  [`games-repository.ts:116`](../../../packages/database/src/games-repository.ts#L116)

**Deployment boundary**

- Single concurrency, bounded scheduling, least-privilege secret access, and alarms protect credits.
  [`foundation.ts:288`](../../../infra/cdk/src/foundation.ts#L288)

- Launch disables fixture seeding and hands live ingestion to environment verification.
  [`phase1-launch.mjs:822`](../../../scripts/phase1-launch.mjs#L822)

**User experience and proof**

- Current Eastern-day filters drive a compact, responsive real-games board.
  [`App.tsx:461`](../../../apps/web/src/App.tsx#L461)

- Live smoke proves anonymous provider-backed games without depending on fixture identities.
  [`phase1-environment-smoke.mjs:352`](../../../scripts/phase1-environment-smoke.mjs#L352)

**Supporting tests and operations**

- Worker tests lock cadence and reserve behavior at lineup-window boundaries.
  [`live-odds-ingestion.test.ts:8`](../../../apps/workers/src/live-odds-ingestion.test.ts#L8)

- Deployment documentation explains cadence, quota reserve, secret rotation, and manual ingestion.
  [`phase1-deployment.md:1`](../../../docs/phase1-deployment.md#L1)
