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

## Canonical closing lines

Started-game closing evidence comes only from SharpAPI's documented
`GET /api/v1/odds/closing?event_id=...` endpoint. The worker sends the exact
SharpAPI event ID retained when schedule reconciliation binds the provider row
to a canonical event; it never sends an FTE canonical ID or reconstructs an ID
from participants. The account must expose the `closing_line` feature. A 403
`tier_restricted` response is an entitlement failure and is never bypassed with
the last pregame snapshot.

SharpAPI captures each sportsbook independently and retains those captures for
48 hours after event start. The worker checks the current and preceding two
Eastern calendar days, reserves each request against the same authoritative
account rate window used by live odds, and caps work per invocation. A `200`
response with `books: {}`, a non-final book, 429, or retryable 503 leaves prior
evidence unchanged and is retried on a later scheduling opportunity. Production
has one-minute opportunities; staging has its next three-daily window or a
deliberate manual canary. A trigger is an opportunity, not a completion guarantee.

Each finalized book is stored once under the canonical event. Later responses
may add newly finalized books but cannot rewrite a prior source capture. A
malformed or ambiguous book is isolated from valid siblings. Serving switches a
started game to canonical closing prices only when one configured display book
has a coherent moneyline; spread and total appear only as complete unambiguous
pairs, and Pinnacle annotates only an exact matching proposition. Scheduled
games continue to use current pregame odds byte-for-byte.

Operational verification should confirm bounded `closing-lines-capture`
records report request, captured-book, pending, and failed counts; inspect the
shared SharpAPI health window before redrive. For empty/not-ready responses,
wait for the next cadence. For missing bindings, verify schedule reconciliation.
For 401 or `tier_restricted`, correct credentials or entitlement manually. Do
not replay raw payloads, loosen identity checks, or substitute pregame prices.

## Universal provider acquisition

FTE-DQ-001 separates source acquisition from product normalization. SharpAPI's
live `/sports?include_empty=true` and `/leagues?include_empty=true` responses are
the acquisition roster. `include_empty=true` keeps off-season entries
discoverable before their first event returns. The worker uses deterministic
`/events?sport=...&league=...` partitions only when every catalog membership
row is representable and the league event/live counters exactly reconcile to
the sport counters. Missing, quarantined, or mismatched league coverage uses a
sport-only request so a partial plan can never publish as complete. A catalog
sport requires no Events request only when both the sport and all of its valid
league rows report zero event and live counters; any positive counter remains
active. Odds use the provider-wide `/odds`
cursor chain. Reserved concurrency remains one, completed streams return without
paid calls, and incomplete opaque cursors resume from durable checkpoints.
Staging automatically supplies three opportunities per UTC day at 05:15, 13:15,
and 21:15, with direct invocation retained for release canaries. Cursor age must
still be verified from checkpoint timestamps during staging reconciliation. The
worker never accepts a configured
sport or league allowlist, live-state filter, or market filter. A new provider
sport, league, market, or book must land without a code or configuration change
even when no sport module, strategy, API route, or UI exists for it yet.

SharpAPI documents `/events` at a maximum 200 rows per page and offset 5,000.
An unfiltered result larger than 5,200 rows is therefore not a complete walk:
the provider may return `has_more=false` and `next_offset=null` at the ceiling
while `total` remains larger. The catalog-derived event plan groups every valid
league slug under conservative row, count, and encoded-query bounds, freezes
the exact sport/league filters in both the catalog and event checkpoints, and
reconciles `total` separately inside each partition. A live multi-league
partition above the reachable bound splits deterministically inside the inactive
sweep. If the denominator grows only after later offset pages, the worker
abandons that inactive generation, preserves the last complete slot, and
restarts from a refined plan without publishing rows it can no longer reconcile.
An indivisible oversized sport or league becomes a durable deferred coverage
gap: later catalog partitions continue, but the event sweep cannot publish until
the leaf becomes reachable or a fresh catalog removes it. If the complete
catalog would require an event plan beyond the checkpoint's bounded capacity,
the catalog snapshot still lands while event acquisition stays inactive and an
immediate capacity diagnostic alerts; no truncated plan is treated as complete.
SharpAPI documents `league` as a comma-separated filter and its catalog IDs as
filter inputs. A catalog ID containing a comma cannot be represented atomically
under that contract. Such a provider inconsistency is retained as
`unrepresentable-filter-id` quarantine evidence and forces that sport through
the fail-closed sport-only request. The invalid ID is never silently discarded,
misinterpreted as two leagues, or excluded while representable siblings make a
partial generation appear complete.

SharpAPI's Events reference documents `400 invalid_filter` only for malformed
numeric `limit` or `offset` values; a filter that matches nothing is documented
to return `200` with `data: null`, `count: 0`, and `total: 0`. On 2026-08-15, a
staging sweep whose frozen catalog plan still contained `futsal` received
`400 invalid_filter` for the valid request
`/events?sport=futsal&limit=200&offset=0`. A bounded one-row follow-up reproduced
the same status and code, while the next include-empty catalog no longer
contained `futsal` or any futsal league. This is treated as a provider catalog /
filter inconsistency, not as an empty successful page and not as an account
failure. The worker retains the stable error code, HTTP status, bounded
`X-Request-Id`, and exact request-position hash in one diagnostic quarantine
record. That diagnostic is a paid-request outcome, not a provider source row:
it increments the exact page-attempt count but never the source, landed, or
quarantined-row reconciliation counts. A rejected multi-league partition is
bisected deterministically inside the same inactive sweep and invocation until
the bad catalog member is isolated, so valid siblings continue without replaying
earlier pages. Every refinement has a revisioned durable position claim and
retains the original completed-catalog plan identity.

A rejected singleton is moved to a bounded deferred queue while every later
catalog partition continues. The inactive sweep remains `running` and cannot
publish a partial generation; readers stay bound to the last completed slot.
After the primary pass, each deferred leaf is retried no faster than every
fifteen minutes. A successful documented `200` page reconciles the leaf and may
complete the sweep. A fresh completed catalog that removes or changes the leaf
migrates the inactive plan and resolves the stale filter without inventing an
empty result. It never stores the error body or prose message. Any different
status/code, any non-initial offset, or an Odds rejection remains on the normal
fail-closed recovery path. The request ID is the evidence supplied to SharpAPI
support, as required by its response conventions.

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
number representation. Provider timestamps are calendar-valid RFC 3339/ISO
8601 instants with at most millisecond precision, preventing distinct source
generations from collapsing through the runtime `Date` representation. An unsafe number or timestamp quarantines
only its row; it never rejects a batch containing valid siblings.

The staging worker is invoked three times per UTC day, while catalog refresh
remains internally due every fifteen minutes once an invocation begins.
Completed streams make no paid call. If a stream-local
filter rejection is paused and the newly completed catalog changes its frozen
event plan, the inactive event sweep restarts immediately with that plan;
unchanged bad filters remain paused and alert instead of hot-looping. Event offsets and odds cursors are
strongly read and conditionally advanced only after every current/quarantine
write for that page succeeds. Each fetched page is first sealed in the
checkpoint with a position and content hash. A crash can replay the same sealed
page. If the provider changed that page before replay, or if count, total, or
cursor drift makes the walk incoherent, the worker abandons that
inactive sweep, keeps the last completed slot live, and restarts in the same
inactive slot under a new sweep ID. Old partial rows cannot join the replacement
sweep because readers require both the selected slot and exact sweep ID.
Provider identifiers repeated on another page in the same sweep become bounded
quarantine evidence and cannot overwrite the first row.
`updated_at` is retained as bounded observation evidence, not treated as an
immutable pagination generation. `/sports` and `/leagues` are sequential
responses, so their valid emission timestamps are not required to be equal.
They are not a cross-endpoint transaction: a league may briefly appear in one
membership list before the other. The frozen plan uses the bounded union keyed
by `(sport, league)` rather than failing or omitting the new league during that
normal propagation window.
Offset-paginated event partitions must expose and reconcile a provider total on
every page. Cursor-paginated odds may omit total;
their exact cursor progression, durable position claims, and terminal page are
the completion authority. Before each request, the worker conditionally claims the exact
`{stream, sweepId, slot, positionHash, pageNumber}` in DynamoDB. Reclaiming the
same position for the same page is a valid crash replay; seeing it under a later
page is a proven cursor cycle and restarts before another paid request. The
bounded position list in the checkpoint is diagnostic only, never probabilistic
authority. Catalog records write in checkpointed chunks and stop at the Lambda
safety deadline; replay validates the durable prefix count and cannot skip rows
or publish a partial catalog.

The isolated staging worker is triggered at 05:15, 13:15, and 21:15 UTC with
reserved concurrency one; the Lambda retains its fourteen-minute execution
budget and sixty-second checkpoint/write safety reserve. A trigger is an
operational continuation opportunity, not proof of a provider cursor lifetime:
responders must compare actual invocation starts and checkpoint updates for backlog.
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
other stream's durable progress. Clients branch on the stable SharpAPI
`error.code`, never its prose `message`. A nonretryable endpoint rejection pauses
only that landing stream for 24 hours, persists a bounded support tuple, and does
not poison the shared account health used by live odds. The one narrow exception
is the documented contradiction above: exact first-page Events
`400 invalid_filter` for a catalog-derived filter becomes diagnostic evidence,
deterministic refinement or a deferred unresolved gap, and later catalog
partitions continue. The incomplete sweep cannot publish until every deferred
leaf returns a reconcilable `200` response or a new catalog removes it. A
rejected non-initial `/odds` cursor is different: the cursor is opaque and tied
to the exact filter set, so the inactive odds sweep restarts from a new
provider-issued cursor chain without a 24-hour pause.

A terminal page records exact page, source-row, landed-row, quarantined-row, and
warning-row counts. `sourceRows = landedRows + quarantinedRows` must hold, and a
provider total must equal the terminal source rows for its event partition;
global event counts accumulate only after each partition reconciles. Odds without a provider
total must reach a valid terminal cursor page. A complete checkpoint selects
records whose `slot` and `sweepId` equal its own. While the next checkpoint is
`running`, readers remain bound to `lastCompletedSlot` plus
`lastCompletedSweepId`; the switch is one conditional checkpoint write, and
identities removed by the provider disappear from the logical view at that
boundary. Reusing a slot does not revive an older row because its sweep ID no
longer matches. Snapshot and identity rows expire after ninety days; quarantine
expires after thirty days, both measured from retrieval time rather than sweep
start.

CloudWatch Logs, embedded metrics, and custom metrics are intentionally
disabled. Four standard staging alarms cover sustained Live Odds and Provider
Landing Lambda errors or DLQ depth; operational detail remains durable in
DynamoDB checkpoints, account health records, quarantine rows, and DLQs.
Universal acquisition runs three times daily in staging. The Provider Landing
function, queues, checkpoints, quarantine evidence, DLQ, secret binding, and
stack outputs remain deployed so an operator can also run a bounded validation
after an ingest change without paying for continuous staging collection.
Scheduled and direct staging invocations continue through the normal quota,
checkpoint, idempotency, retry, and terminal-failure controls.
Configuration, entitlement, and authorization failures mark the shared account
health terminal; the scheduled delivery then completes without two identical
blind retries. Unexpected Lambda/storage failures retain bounded asynchronous
retries and page only after two of three five-minute periods breach. The
recurring Provider Landing schedule remains disabled in production until a
separate promotion decision. Staging uses the staggered three-daily provider
cadence while keeping opportunity maintenance disabled; production retains the
aggressive Live Odds and opportunity cadence. Stage-aware synth and preflight
checks reject any expression, state, or target that contradicts this contract.

Staging verification resolves `ProviderLandingFunctionName` from the exact stack,
invokes it only with the deployed SharpAPI secret binding, then strongly reads
the three `CHECKPOINT#catalog|events|odds` records. A healthy completed sweep has
`sourceRows = landedRows + quarantinedRows`; catalog source rows equal the live
include-empty `/sports` plus `/leagues` counts; the event plan covers every
catalog sport exactly once, either sport-wide or through fully reconciled,
non-overlapping sport-scoped league groups; unfiltered Odds uses 25-row opaque-cursor pages
because live staging proved the documented 200-row maximum exceeds the bounded
response timeout while 25-row pages complete reliably; and an odds/event checkpoint is never called
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

Standard Lambda error and SQS DLQ metrics are signals, not row counts. DynamoDB
snapshots, availability evidence, attempts, sealed pages, and DLQ messages are
the source of operational truth.

Newer suspended, closed, missing, malformed, incomplete, or unavailable market
evidence blocks the older current price from recommendation inputs while leaving
the immutable snapshot in history. Only newer valid active evidence restores
eligibility. A partial response retains valid siblings and persists exact gaps;
it never implies group completeness.
