# SharpAPI provider runbook

## Current state

SharpAPI is the sole enabled production schedule, odds, and public-betting
provider. The Odds API is not called by production ingestion. The upgraded
account boundary was verified on 2026-08-05 with `maxBooks=25`; this is a
capacity fact, not a promise that every book appears on every event. Streaming
and Live Game State add-ons are intentionally disabled for MVP.

The runtime references `find-the-edge/<stage>/sharpapi` in AWS Secrets Manager.
The secret must contain only the server-side API key. Never place the value in
Lambda environment variables, browser code, logs, fixtures, or deployment
output.

## Verified contract

REST uses `X-API-Key` and cursor pagination for `/odds`; requests use
`market=main` so period and prop markets cannot be mislabeled as full-game
markets. `/splits` uses offset pagination. SharpAPI documents DraftKings and
Circa Sports as its public-betting sources and identifies their aggregate feed as
`consensus`; this is not an aggregate of all account-selected odds books. The feed
updates about every five minutes and returns fractions that the adapter converts
to display percentages. The provider's `timestamp` is feed
freshness, not the exact time a line moved. Split `fetched_at` remains separate.

The operator approved Pro activation. A plan upgrade or add-on remains a manual
decision and is never performed by deployment automation.

## Entitled collection roster and consensus policy

ADR 0003 defines Hard Rock (`hardrock`) as the offered sportsbook and
DraftKings, FanDuel, BetMGM, and Caesars as equal-weight comparison books. The
production collector accepts the closed, versioned collection allowlist across
enabled leagues and excludes Hard Rock unconditionally from a Hard Rock
consensus. Collection approval never grants an evaluation weight.

The upgraded entitlement is modeled separately from evaluation. Approved
Pinnacle, Circa, Bally Bet, Betano, Fanatics, Fanatics Markets, BetRivers,
BetOnline, Bovada, Fliff, Kalshi, Novig, 1xBet, Polymarket, ProphetX, SBOBET,
Stake, and theScore Bet rows may be retained with the existing five books, but only
DraftKings, FanDuel, BetMGM, and Caesars retain evaluation weights. The
DraftKings/Circa splits feed remains separate. If fewer than three configured
comparison books remain eligible for a market, consensus and qualification are
unavailable; operators must not weaken the gate or substitute an unapproved
book.

Before rollout, use the existing server-side account boundary and record only
whether `maxBooks >= 25`; never record the key, response body, price, or contract
terms. An explicitly authorized canary across each enabled league retains only
bounded canonical IDs and counts. Pinnacle is `observed` or
`coverage-unverified`; absence is never success. Unknown identifiers stay
rejected until reviewed in the versioned alias map. Collection approval does not
make a book expected everywhere: policy scopes absence by league and market.

## Expected degradation

An unverified contract reports `contract-unverified`. A split entitlement denial
reports `not-entitled` only for `public-betting`; it must not mark entitled odds
coverage unhealthy. Retain prior current odds or splits on an outage and report
them stale using their independent freshness thresholds.

Provider priority, rate-window reserve, health thresholds, and cooldown remain
explicit even with one enabled production provider. Requests per minute is a
rate ceiling, not subscription quota remaining. Only authoritative response
headers may populate the current window; missing limit, remaining, or reset
values remain explicitly unknown. A future fallback requires
an approved policy change and must not blend the same sportsbook from multiple
aggregators.

## Rotation and canary

Rotate the Secrets Manager value, then run one explicitly approved manual canary
against an allowlisted league and market. Verify redacted telemetry for attempts,
latency, quota, normalized counts, mapping gaps, and entitlement. Disable the
SharpAPI immediately on malformed material or unexpected licensing constraints;
production ingestion then remains unavailable until SharpAPI is re-enabled or a
separately approved fallback policy is deployed.

Stage entitlement rollout as an operator-run deployment sequence: bounded
canary, a versioned policy deployment with one enabled league, then a reviewed
policy deployment for the remaining leagues. There is no hidden runtime toggle
that changes the catalog silently. Roll back by deploying the prior versioned
collection entries or catalog. Never delete or rewrite immutable snapshots;
removed-book history stays auditable and receives no evaluation weight.

## Failure, health, and redrive matrix

HTTP 429 and an unambiguous connection failure are transient. Honor the
provider retry time when supplied, otherwise use bounded exponential delay with
jitter; never exceed five deliveries or a fifteen-minute delay. A featured odds
request may make one identical, quota-accounted refetch after a structurally
invalid response; the second failure is terminal and validation is never
relaxed. Authentication, entitlement, configuration, and coverage failures are
terminal. A timeout or lost connection after dispatch is ambiguous: inspect the
durable attempt and sealed page during its reconciliation lease before
permitting a new call. Invalid-response diagnostics contain only a fixed stage
such as `account:json`, `odds:page-envelope`, `schedule:event-shape`,
`splits:pagination-envelope`, or `focused-odds:identity`; they never contain the
response body or request URL. HTTP 401/403 remains terminal even when the
provider returns HTML or an empty body. Other HTTP 4xx responses are terminal
provider rejections and are not eligible for the one structural-response
refetch.

Transient unhealthy health records carry a retry time and bounded TTL. Success
heals current health but does not delete runs, attempts, gaps, or prior failure
evidence. Terminal health is durable until configuration or entitlement is
corrected. An exhausted FIFO command reaches the odds DLQ after five receives.
Before redrive, identify the bounded reason, verify the provider cooldown/window
has reset, and verify no ambiguous attempt or sealed page already owns the paid
request. Redrive the exact command once; never bulk-redrive unknown messages.

Operational metrics are intentionally at-least-once. They are emitted only
after the corresponding durable evidence write, but a worker replay can emit
the same bounded metric again. Dashboards and alarms must aggregate by their
time window and must not treat metric totals as an exact row count; DynamoDB
snapshots, availability evidence, attempts, and sealed pages are the source of
truth.

Newer suspended, closed, missing, malformed, incomplete, or unavailable market
evidence blocks the older current price from recommendation inputs while leaving
the immutable snapshot in history. Only newer valid active evidence restores
eligibility. A partial response retains valid siblings and persists exact gaps;
it never implies group completeness.
