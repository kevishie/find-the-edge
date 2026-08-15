# SharpAPI provider runbook

## Current state

SharpAPI is the sole enabled production schedule, odds, and public-betting
provider. The Odds API is not called by production ingestion. The upgraded
account boundary was verified on 2026-08-05 with `maxBooks=25`; this is a
capacity fact, not a promise that every book appears on every event. Streaming
remains disabled. Live Game State is not connected to production ingestion or a
serving path. Epic 14 records a successful account-boundary response on
2026-08-12, but the bounded FTE-082 preflight below must revalidate current
entitlement before any research window; it never purchases or enables an
add-on.

The staging Game State preflight succeeded again on 2026-08-14: all four closed
routes returned within the exact request budget. The derived record contained
448 observations, including 23 baseball rows, 106 soccer rows, zero football
rows at that instant, and 190 aggregate rows from off-roster catalogues. This is
entitlement and shape evidence only, not coverage or correctness evidence.

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

## Universal provider acquisition

FTE-DQ-001 separates source acquisition from product normalization. SharpAPI's
live `/sports` and `/leagues` responses are the acquisition roster. The
provider-landing worker therefore requests provider-wide `/events` and
unfiltered `/odds`; it never accepts a configured sport, league, live-state, or
market filter. A new provider sport, league, market, or book must land without a
code or configuration change even when no sport module, strategy, API route, or
UI exists for it yet.

The worker stores bounded, two-slot source snapshots in the retained ingestion
table. Every non-quarantine sort key starts with `SLOT#0` or `SLOT#1`. A new
sweep builds only in the inactive slot, so it cannot overwrite the completed
slot that readers currently trust:

- `PROVIDER_LANDING#SHARPAPI#CATALOG#SPORT` and `#LEAGUE` retain provider catalog
  identity, display label, live/event counts, and sport-to-league membership.
- sport-scoped `PROVIDER_LANDING#SHARPAPI#EVENT#...` records retain provider event
  identity, external identifiers, participants when present, start/lifecycle,
  markets, books, and source retrieval time.
- sharded `PROVIDER_LANDING#SHARPAPI#ODDS#...` records retain provider event and
  price identity, sport/league/book, market/selection, line and price, lifecycle
  flags, and provider/retrieval timestamps.
- dated quarantine partitions retain only safe provider identity, a bounded field
  inventory, and a reason for any row that cannot satisfy the generic source
  contract. One invalid row never suppresses valid siblings.

Verbatim response bodies remain ephemeral and are not written to DynamoDB, S3,
logs, fixtures, or diagnostics. This preserves the existing licensing boundary
while preventing sport/module/UI maturity from dropping source data.
Catalog envelopes accept as many as 50,000 rows under the independently enforced
10 MB streamed-response limit. Generic values are walked under a bounded node
budget, and numeric source tokens must fit DynamoDB's exact 38-digit,
`1E-130` through `9.999E+125` range and round-trip exactly through the runtime
number representation. Provider timestamps are calendar-valid ISO instants
with millisecond precision or less. An unsafe number or timestamp quarantines
only its row; it never rejects a batch containing valid siblings.

Catalog refresh is due every six hours. Event offsets and odds cursors are
strongly read and conditionally advanced only after every current/quarantine
write for that page succeeds. Each fetched page is first sealed in the
checkpoint with a position and content hash. A crash can replay the same sealed
page. If the provider changed that page before replay, or if count, total,
cursor, or generation drift makes the walk incoherent, the worker abandons that
inactive sweep, keeps the last completed slot live, and restarts in the same
inactive slot under a new sweep ID. Old partial rows cannot join the replacement
sweep because readers require both the selected slot and exact sweep ID.
Provider identifiers repeated on another page in the same sweep become bounded
quarantine evidence and cannot overwrite the first row.
`updated_at` is retained as bounded observation evidence, not treated as an
immutable pagination generation. Offset-paginated events must expose and
reconcile a provider total on every page. Cursor-paginated odds may omit total;
their exact cursor progression, durable position claims, and terminal page are
the completion authority. Before each request, the worker conditionally claims the exact
`{stream, sweepId, slot, positionHash, pageNumber}` in DynamoDB. Reclaiming the
same position for the same page is a valid crash replay; seeing it under a later
page is a proven cursor cycle and restarts before another paid request. The
bounded position list in the checkpoint is diagnostic only, never probabilistic
authority. Catalog records write in checkpointed chunks and stop at the Lambda
safety deadline; replay validates the durable prefix count and cannot skip rows
or publish a partial catalog.

The isolated worker runs every fifteen minutes with reserved concurrency one.
Events and odds take one page each in a fair, serialized round robin. Before a
paid request, the landing worker atomically reserves against the same
account-level SharpAPI health row used by live odds. Landing is lower priority:
it refuses unknown or unhealthy windows and preserves at least fifty percent of
the authoritative limit (minimum 250 requests) for the live path. Response
headers are conservatively reconciled without refunding concurrent reservations;
an older delayed response cannot alter a newer account window, and the atomic
reservation itself requires the same present, healthy, nonterminal authoritative
window observed by the caller. At each minute reset, live odds and landing
compete for one durable account-probe lease on that shared row. The winner sends
one bounded `/account` recovery request and publishes the returned authoritative
window; the loser polls the same row and sends no duplicate probe. Landing then
recomputes its reserve against the exact version, limit, and reset identifier
before every page. It will not reserve or dispatch inside the ten-second reset
guard or the Lambda's sixty-second checkpoint safety budget. An observed 429
cannot downgrade terminal health
and blocks every account consumer until the bounded retry/reset time. Untrusted
rate/reset headers retain a five-minute past grace and may schedule at most 24
hours ahead; farther values are ignored rather than becoming a permanent pause. A
secondary local twenty-percent/minimum-twenty-five brake protects the current
invocation. DynamoDB unprocessed batches retry with capped jitter.
Terminal provider authorization/configuration failures stop all paid streams
for that invocation, while independent event or odds failures do not erase the
other stream's durable progress. A nonretryable endpoint rejection pauses only
that landing stream for 24 hours, emits one terminal outcome, and does not poison
the shared account health used by live odds.

A terminal page records exact page, source-row, landed-row, quarantined-row, and
warning-row counts. `sourceRows = landedRows + quarantinedRows` must hold, and a
provider total must equal terminal event `sourceRows`; odds without a provider
total must reach a valid terminal cursor page. A complete checkpoint selects
records whose `slot` and `sweepId` equal its own. While the next checkpoint is
`running`, readers remain bound to `lastCompletedSlot` plus
`lastCompletedSweepId`; the switch is one conditional checkpoint write, and
identities removed by the provider disappear from the logical view at that
boundary. Reusing a slot does not revive an older row because its sweep ID no
longer matches. Snapshot and identity rows expire after ninety days; quarantine
expires after thirty days, both measured from retrieval time rather than sweep
start. Health alarms fire long before a current snapshot can expire.

Low-cardinality EMF records exact persisted pages and landed, quarantined, and
warning rows. Durable cumulative quarantine/warning counts are replayed at the
next invocation, so a crash after checkpoint commit but before EMF publication
cannot permanently hide bad data. Completion-age alarms require two consecutive fifteen-minute
periods beyond eight hours for catalog or one hour for events/odds. Run-age
alarms require two periods beyond thirty minutes for catalog, two hours for
events, or twelve hours for odds. Recovery preserves the original run-age
boundary, and two consecutive recovery periods alert instead of presenting a
perpetually young run. Lambda errors require sustained failures; EventBridge
delivery failures and exhausted asynchronous Lambda-handler failures both reach
the retained DLQ, whose messages alert immediately. Quarantine rows alert immediately. Warning rows remain exact
metrics and alert only after two consecutive thirty-minute windows. Missing
completion metrics breach only where this worker is scheduled,
so inert development and production stacks do not page. Universal acquisition
is enabled in staging only until the data-quality promotion gate passes.
Configuration, entitlement, and authorization failures mark the shared account
health terminal and raise one immediate terminal alarm; the scheduled delivery
then completes without two identical blind retries. Unexpected Lambda/storage
failures retain bounded asynchronous retries and page only when sustained (or
immediately if they reach the DLQ). The schedule is enabled only when both the
scheduler flag is true and the stage is exactly `staging`; `dev`, test aliases,
and production remain inert.

Staging verification resolves `ProviderLandingFunctionName` from the exact stack,
invokes it only with the deployed SharpAPI secret binding, then strongly reads
the three `CHECKPOINT#catalog|events|odds` records. A healthy completed sweep has
`sourceRows = landedRows + quarantinedRows`; catalog source rows equal the live
`/sports` plus `/leagues` counts; and an odds/event checkpoint is never called
complete while it retains a cursor, offset, or pending page. Any `resumeAfter`
must match a bounded provider reset/retry time and prevent every paid stream
before that instant. Provider totals and generations remain coherent, and every
warning/quarantine count has a bounded reason that must be explained before the
data-quality release gate can pass. Production scheduling remains disabled
until repeated staging sweeps prove these invariants and the promotion story
records the decision.

## Live Game State research preflight

FTE-082 uses `scripts/game-state-spike.mjs`, a read-only research tool. It reads
the existing stage secret, performs fixed GET requests to `/gamestate` and the
closed baseball, football, and soccer routes, and writes only derived bounded
evidence. It has no table, worker, billing, provider-activation, or product
serving access.

Run the local contract suite before a paid request:

```sh
pnpm test:game-state-spike
```

Confirm the current AWS identity is account `228246988391` in `us-east-1`, then
run the staging preflight. The four-request cap is exact: aggregate plus one
request for each served sport route. Choose a new output path because the tool
uses exclusive creation and never overwrites evidence.

```sh
pnpm game-state:spike -- \
  --stage staging \
  --mode preflight \
  --region us-east-1 \
  --max-requests 4 \
  --output /tmp/fte-game-state-preflight-2026-08-14.json
```

Stop on `unauthorized`, `not-entitled`, `rate-limited`,
`provider-request-ambiguous`, `provider-unavailable`, or `invalid-response`.
There is no automatic retry. A failed required route produces no final evidence
file. Do not change route names, loosen response validation, upgrade the plan,
or substitute a key from an environment variable.

Before a whole-slate sample, freeze an independently sourced manifest using
schema `game-state-spike-manifest-v1`. It contains a bounded official reference
hash, freeze time, canonical event id, provider event id, sport, and scheduled
start for every event in the denominator. Provider-returned rows never define
the denominator. Then initialize the truth sidecar. The initializer validates
the manifest and binds the exact manifest-file bytes, source, tolerance, and
freeze time into one exclusive header line.

```sh
pnpm game-state:truth:init -- \
  --manifest /absolute/path/to/frozen-mlb-slate.json \
  --source-kind official-scoreboard \
  --source-reference-hash <64-lowercase-hex-digest> \
  --comparison-tolerance-seconds 60 \
  --frozen-at <ISO-8601-instant-before-collection> \
  --output /absolute/path/to/append-only-official-truth.jsonl
```

A 24-hour run plus a six-hour post-final retention window at five-minute cadence
has 361 ticks and exactly 1,444 requests. Post-final minutes extend the planned
window and request budget; they are not descriptive metadata. The sampler
requires the still-header-only sidecar and records its exact header hash plus
the exact manifest-file hash before the first provider request.

```sh
pnpm game-state:spike -- \
  --stage staging \
  --mode sample \
  --region us-east-1 \
  --interval-seconds 300 \
  --duration-minutes 1440 \
  --post-final-minutes 360 \
  --max-requests 1444 \
  --manifest /absolute/path/to/frozen-mlb-slate.json \
  --truth-sidecar /absolute/path/to/append-only-official-truth.jsonl \
  --output /absolute/path/to/new-derived-evidence.json
```

The output intentionally excludes raw provider ids, team/player labels,
primary-book identifiers, response bodies, headers containing credentials,
commercial terms, and user data. It retains per-run keyed event hashes,
normalized state fields, schema/state hashes, retrieval and consensus times,
rate-window metadata, mapping classes, aggregate-versus-sport reconciliation,
coverage denominators, and categorical lifecycle transitions. A hash is an
integrity marker, not permission to retain the paid response. Raw responses are
discarded after in-memory normalization unless written licensing terms later
authorize a separate encrypted evidence corpus.

### Independent truth sidecar

Do not place future scores or statuses in the frozen pregame manifest. The
manifest freezes identity, scheduled starts, the denominator, and the identity
source before collection. Before the provider window, create a separate JSON
Lines truth sidecar whose first line is a `game-state-spike-truth-v1` `header`
binding a protocol freeze time no later than provider collection, the exact
manifest input hash, the independent source, and the comparison tolerance.
The sampler refuses a missing, changed, already-populated, or unlike header.
During the window, append closed `checkpoint` lines with
canonical event id, observation time, nullable integer scores/clock/period,
phase, in-play, and final flags. After the provider artifact is complete, append
one terminal `seal` line containing its exact SHA-256 and the SHA-256 of every
preceding sidecar line including its newline. The analyzer requires that seal to
be last, verifies both hashes, and refuses edits, missing seals, or appended
records. Never include a provider id, team label, book name, URL, credential, or
raw response.

After the provider evidence and truth sidecar are immutable, run the offline
join. It performs no AWS or provider call, chooses only the latest checkpoint at
or before the provider consensus timestamp, refuses unlike hashes, and writes a
bounded aggregate analysis without copying event ids or checkpoint values.

```sh
pnpm game-state:truth -- \
  --evidence /absolute/path/to/new-derived-evidence.json \
  --truth /absolute/path/to/append-only-official-truth.jsonl \
  --output /absolute/path/to/new-truth-analysis.json
```

The truth analysis reports compared/unavailable denominators and bounded
wrong-score, status, clock/period, false-live, and false-final counts by served
sport. A checkpoint later than a provider observation is never used to judge
that observation. The sidecar and analysis are evidence for the research
report; neither is a settlement authority.

## Entitled evaluation roster and consensus policy

ADR 0003 defines Hard Rock (`hardrock`) as the offered sportsbook and
DraftKings, FanDuel, BetMGM, and Caesars as equal-weight comparison books. The
canonical pricing path accepts the closed, versioned sportsbook roster across
promoted leagues and excludes Hard Rock unconditionally from a Hard Rock
consensus. This roster does not limit universal provider acquisition. Collection
approval never grants an evaluation weight.

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
