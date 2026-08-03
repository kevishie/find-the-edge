# SharpAPI provider runbook

## Current state

SharpAPI is the primary production odds and public-betting provider. The Odds
API remains an independent failover. The subscribed account was verified on
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

## Expected degradation

An unverified contract reports `contract-unverified`. A split entitlement denial
reports `not-entitled` only for `public-betting`; it must not mark entitled odds
coverage unhealthy. Retain prior current odds or splits on an outage and report
them stale using their independent freshness thresholds.

For failover, configure provider priority, per-provider quota reserve, health
thresholds, cooldown, and required recovery successes. Do not blend the same
sportsbook from both aggregators. Fail back only after the configured consecutive
success threshold to prevent flapping.

## Rotation and canary

Rotate the Secrets Manager value, then run one explicitly approved manual canary
against an allowlisted league and market. Verify redacted telemetry for attempts,
latency, quota, normalized counts, mapping gaps, and entitlement. Disable the
SharpAPI immediately on malformed material or unexpected licensing constraints;
the worker will fail over to The Odds API.
