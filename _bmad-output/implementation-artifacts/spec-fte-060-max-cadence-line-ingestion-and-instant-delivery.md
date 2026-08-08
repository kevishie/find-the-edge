---
title: 'Max-Cadence Line Ingestion and Instant Delivery'
type: 'feature'
created: '2026-08-08'
status: 'in-progress'
---

<intent-contract>

## Intent

**Problem:** Lines refresh once per one-minute scheduler tick, so users see
prices up to ~2 minutes stale (60s ingest + 60s board poll). The product
should ingest every event and its lines from all approved sportsbooks at the
fastest cadence the provider's request window sustains, and users viewing an
event should see new lines within seconds of the provider publishing them.

**Approach:** Keep the 1-minute EventBridge tick (the AWS floor) but let each
invocation run an intra-tick fast lane: after the first control-plane pass it
loops until ~50s of the tick is spent, re-running the pass so leagues whose
near-start cadence (10s) is due refresh multiple times per tick. Schedule
discovery (60s) and splits (300s) stay self-gated by their own checkpoints.
Boards re-materialize only when a pass commits new odds pages, and the
withdrawn-listing schedule fetch is cached per invocation. The event detail
screen polls its comparison and history every 10 seconds.

**Why polling, not WebSockets:** user-visible latency is bounded below by the
ingest cadence. With 10-second ingestion, a 10-second detail poll delivers the
same effective freshness as a push channel, without an API Gateway WebSocket
stack (connection registry, fan-out worker, reconnect handling). WebSockets
become worth building only if ingestion ever becomes continuous (true in-play
streaming) or the product becomes multi-user at scale. Documented as the
explicit trade; revisit trigger recorded in deferred-work.

## Budget Math

- Odds are fetched per league page (`/odds?league=…&limit=200`); a full
  refresh of the five active leagues costs ~5–10 requests.
- Provider window is RPM-based (observed 1000/min, reserve 100).
- Fast lane at 10s for all five leagues: ≤ 60 requests/min. Schedule
  discovery adds ≤ 1/min plus one cached withdrawn-listing sweep per tick.
  Total stays an order of magnitude inside the window.

## Boundaries & Constraints

**Always:** Respect per-league `nextDueAt` checkpoints (the loop never forces
a fetch); leave splits on their 5-minute checkpoint; keep the FIFO
message-group serialization (loop budget < tick interval); cache the
schedule-listing sweep within an invocation; re-materialize boards only after
a committing pass; keep `is_live=false` (pre-game collection is the product
scope today).

**Block If:** The loop would exceed the invocation budget or the provider
reports rate-limiting (existing cooldown machinery owns the response).

**Never:** Bypass quota reserves; mutate immutable snapshot history; poll the
provider per-event (league pages are the unit); sacrifice deploy independence.

</intent-contract>

## Code Map

- `packages/config/src/feed-coverage.ts` — near-start cadence 30s → 10s,
  window widened to 6h, policy version bump.
- `apps/workers/src/live-odds-lambda.ts` — intra-tick fast-lane loop,
  per-invocation schedule-listing cache, committed-pages gate for board
  re-materialization.
- `apps/web/src/game-detail.tsx` — 10-second auto-refresh for the odds
  comparison and line-movement history.
- Tests beside each file; preflight cadence assertions unchanged
  (`rate(1 minute)` remains the scheduler contract).

## Follow-ups

- WebSocket push: revisit when ingestion becomes continuous or multi-user.
- In-play (`is_live=true`) collection is a separate product decision.
