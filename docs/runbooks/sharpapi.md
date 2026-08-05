# SharpAPI provider runbook

## Current state

SharpAPI is the sole enabled production schedule, odds, and public-betting
provider. The Odds API is not called by production ingestion. The prior account was verified on
2026-08-03 as Pro: 300 requests/minute, 15 selected sportsbooks, odds, schedule,
+EV, arbitrage, middles, low hold, steam, closing line, and betting splits.
Streaming and Live Game State add-ons are intentionally disabled for MVP.

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
DraftKings, FanDuel, BetMGM, and Caesars as equal-weight comparison books. Live
account checks returned HTTP 200 with odds data for all five identifiers. The
production collector requests that roster for MLB and MLS and excludes Hard
Rock unconditionally from a Hard Rock consensus.

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

Stage entitlement rollout as canary, one enabled league, then remaining leagues.
Roll back by disabling new collection entries or restoring the prior catalog.
Never delete or rewrite immutable snapshots; removed-book history stays
auditable and receives no evaluation weight.

## Failure, health, and redrive matrix

HTTP 429 and an unambiguous connection failure are transient. Honor the
provider retry time when supplied, otherwise use bounded exponential delay with
jitter; never exceed five deliveries or a fifteen-minute delay. Authentication,
entitlement, configuration, malformed response, and coverage failures are
terminal and must be acknowledged without another paid call. A timeout or lost
connection after dispatch is ambiguous: inspect the durable attempt and sealed
page during its reconciliation lease before permitting a new call.

Transient unhealthy health records carry a retry time and bounded TTL. Success
heals current health but does not delete runs, attempts, gaps, or prior failure
evidence. Terminal health is durable until configuration or entitlement is
corrected. An exhausted FIFO command reaches the odds DLQ after five receives.
Before redrive, identify the bounded reason, verify the provider cooldown/window
has reset, and verify no ambiguous attempt or sealed page already owns the paid
request. Redrive the exact command once; never bulk-redrive unknown messages.

Newer suspended, closed, missing, malformed, incomplete, or unavailable market
evidence blocks the older current price from recommendation inputs while leaving
the immutable snapshot in history. Only newer valid active evidence restores
eligibility. A partial response retains valid siblings and persists exact gaps;
it never implies group completeness.
