# Paper grading operations

Paper grading runs only after an authoritative completed-result observation becomes the current result. Production result scheduling remains disabled until an approved authoritative results adapter and exact participant mappings are configured.

## Replay and repair

Replay the bounded completed-result command for the affected league/window. Exact result delivery is idempotent, but the orchestrator always invokes grading again when that observation is still current; this repairs a result-written/grade-missing crash. Paper bets are discovered through `PAPER_BETS_BY_EVENT#<eventId>` queries. Never use a table scan.

Completed results written before the exact-result index was introduced do not acquire that index merely by being read. Before enabling grading against preexisting history, replay each retained authoritative observation through normal result persistence (or run an equivalent bounded backfill). Replay creates or verifies `RESULT_EXACT#<eventId>` without mutating history; do not fall back to history traversal at grading time.

## Corrections

A higher-authority official correction appends a new grade linked by `supersedesGradeId` and increments `correctionOrdinal`. The prior grade and result stay immutable. A stale result cannot advance the grade projection.

## Unresolved and legacy records

Missing decision-time grading terms, unknown scope, participant mismatch, a two-way tie, postponement, or unsupported sport rules produce `unresolved`; they never default to a loss. Legacy paper bets require an explicit, bounded backfill from retained evidence. Do not infer missing terms.

## Monitoring and rollback

Monitor result-worker errors plus grading `failed`, `unresolved`, and `regraded` counters. Investigate failed evidence reads as corruption/provider incidents. Roll back the worker release or keep the result schedule disabled; immutable results and grades require no destructive rollback.
