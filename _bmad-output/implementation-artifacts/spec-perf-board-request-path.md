---
title: 'Board request-path performance'
type: 'improvement'
created: '2026-08-08'
status: 'done'
baseline_commit: 'cd8e138'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fix-splits-club-label-drift.md'
---

## Intent

**Problem:** The splits screen waited about five seconds on one API request.
Measured causes, in order: the request-path Lambda ran at 256 MB (about a
seventh of a vCPU for a CPU-bound handler), every request re-ran the full
projection for a board that changes only on the five-minute ingest cadence,
the odds join issued its BatchGet chunks sequentially, every read demanded
strong consistency, responses shipped uncompressed, and the games page fanned
out six lifecycle requests from the browser.

**Approach:** Make the common request a single stored read. The ingest worker
materializes the exact response body for the default boards after each run;
the API serves it in one read and falls back to the live projection for
anything the store cannot answer. Around that: 1024 MB for the request path,
parallel BatchGet chunks, eventually consistent reads on list projections
only, Lambda-side gzip, an in-memory response cache, and a server-merged
status=all with a composite per-status cursor.

## Measured Outcome

| Metric | Before | After |
|---|---|---|
| Splits TTFB | 4.97 s | 135–166 ms |
| Splits wire size | 130 kB | 12.6 kB (gzip) |
| Live-path day (no stored board) | ~4 s | ~280 ms |
| Games page requests | 6 | 1 |

Worker logs `board-materialization stored:8 skipped:0` each run.

## Boundaries kept

- The detail path keeps strongly consistent reads: its read-twice snapshot
  stability check depends on them.
- A board whose page would overflow into a cursor is never stored; its cursor
  could not be resumed outside the API.
- Materialization failures log and never fail ingestion.
- A cursor minted for one status can never resume the merged all view.

## Code Map

- `packages/database/src/board-projection.ts` — shared board assembly,
  storage schema, staleness validation, materialization targets.
- `packages/database/src/dynamodb-event-repository.ts` — merged all-status
  list with composite cursor.
- `packages/database/src/aws-dynamo-gateway.ts` — parallel BatchGet chunks,
  per-call consistency options.
- `apps/api/src/http-compression.ts` — gzip encoding.
- `apps/api/src/handler.ts` — stored-board consult, response cache.
- `apps/workers/src/live-odds-lambda.ts` — post-ingest materialization.
- `infra/cdk/src/foundation.ts` — EventApi at 1024 MB, asserted.

## Remaining levers

- The splits screen is now dominated by the 525 kB single-chunk bundle parse;
  code-splitting is the next meaningful win.
- Games boards for non-scheduled lifecycles and the merged all view could be
  materialized too if their live-path latency ever matters.
