# FTE-082 Staging Game State Preflight — 2026-08-14

## Scope

This was the bounded entitlement and schema preflight for FTE-082. It made one
read-only request to each closed staging route: aggregate, baseball, football,
and soccer. It did not write production state, retry a provider call, retain a
raw response, or change provider billing or activation.

The successful derived evidence was written locally at
`/tmp/fte-game-state-preflight-2026-08-14T1300Z.json`. Its exact SHA-256 is
`e281b6ab284e1a89bd8f14ecb5549e7c81bea5ddd26d541b231430e0facfae76`.
The local file contains only the derived schema allowed by the story; this
summary is the committed evidence reference.

## Result

- Source: live provider, staging.
- Window: 2026-08-14T12:56:16.599Z through 2026-08-14T12:56:17.050Z.
- Requests: 4 planned, 4 dispatched, 4 completed.
- Derived observations: 448.
- Aggregate response: 319 rows and 138,363 bytes.
- Aggregate served-sport counts at that instant: baseball 23, soccer 106,
  football 0.
- Aggregate off-roster catalogue rows: 190. Pollution is therefore material,
  not an edge case.
- Sport-route agreement: baseball 23/23, football 0/0, soccer 106/106, with no
  missing, extra, semantic mismatch, temporal-movement, or indeterminate rows
  in this single sweep.
- Provider envelope timestamp: 2026-08-14T12:56:13.500Z on all four routes.
- Local latency: aggregate 284 ms; baseball 48 ms; football 43 ms; soccer 49 ms.
- Authoritative rate window: limit 1,000; remaining fell from 983 to 980; reset
  at 2026-08-14T12:57:00.000Z.

## Shape findings

The 2026-08-12 historical shape is still directionally correct but incomplete:

- The current response wraps the sport buckets under `data` and provides a
  separate envelope update time.
- `consensus_at` is numeric rather than an ISO string.
- `away_score` and `home_score` can be null.
- `game_clock` and `game_period` can be null.
- `in_play` is a constituent map, not a simple boolean, on every baseball row
  in this sweep. This means book disagreement is measurable as bounded
  true/false/null counts without retaining constituent book names.
- `is_live` remains a boolean consensus signal.
- The aggregate response carried 24 additional field names beyond the closed
  initial set. Their values were not retained.

The sampler was updated and regression-tested for the envelope, numeric
timestamps, nullable state, and redacted constituent disagreement counts.

## What this preflight proves

- The add-on is active for the staging credential.
- All required routes are accessible within the frozen four-request budget.
- Aggregate and sport-scoped rows can agree exactly in one near-simultaneous
  sweep.
- Catalogue pollution is large enough that served-sport filtering and frozen
  denominators are mandatory.
- Constituent disagreement can be investigated without persisting book names.

## What this preflight does not prove

- It does not prove MLB slate coverage; the 23 baseball rows include non-MLB
  catalogues and no canonical manifest was supplied.
- It does not prove correctness, cadence, lag distribution, lifecycle
  transitions, final retention, or revision behavior.
- A zero football row count at this instant is not evidence of missing NFL
  coverage; it is only the observed zero for this timestamp.
- It does not authorize FTE-083 through FTE-089, serving, settlement, or money
  movement.

FTE-082 therefore remains in progress pending the frozen full-slate window,
append-only independent truth checkpoints, offline truth analysis, dated trust
report, and approval.
