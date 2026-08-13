- source_spec: `_bmad-output/implementation-artifacts/spec-fte-028-two-way-and-three-way-no-vig-consensus.md`
  summary: Version and propagate the hardened weighted-consensus contract under FTE-031.
  evidence: `CONSENSUS_CALCULATION_VERSION` still identifies `weighted-consensus-v1` although FTE-028 hardened its transient input and result contract; the story explicitly leaves durable calculation versioning and replay propagation to FTE-031.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Make cross-version evidence deduplication stable across odds-history page boundaries.
  evidence: The repository's evidence-identity set is page-local, so equivalent canonical-version mirrors can survive when separated by a cursor.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Fence delayed history-mirror repair by mirror commit order.
  evidence: A repaired mirror retains its older retrieval timestamp, so the current retrieval-time fence cannot prove it existed when pagination began.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Preserve the newest corrected selection label when equivalent mirrors deduplicate.
  evidence: Deduplication currently occurs before label evidence is compared, allowing hash order to retain an older label.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Align raw cursor ordering and projected DTO ordering for tied provider timestamps.
  evidence: DynamoDB orders tied timestamps by snapshot ID while DTO series additionally order by retrieval time, which can reverse points across pages.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Prevent cross-page selection-label regression in the browser merge.
  evidence: Later pages overwrite selection labels without proving their label evidence is newer.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Enforce the aggregate server observation bound in the browser history parser.
  evidence: Per-series limits permit a malformed page to contain far more than the repository's 200-observation page contract.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Restore canonical series ordering after browser pagination merge.
  evidence: Map insertion order can differ from the repository's market, selection, and sportsbook ordering.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Anchor movement time presets to the response generation time.
  evidence: Presets currently anchor to the newest observation, which makes stale evidence appear to be a current relative window.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Bound chart sampling even when required gap-transition points exceed the nominal limit.
  evidence: Alternating active and unavailable evidence can bypass the 2,400-point rendering cap.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Re-land within-market timestamp tolerance without letting a board mix observation moments.
  evidence: Dropping the observedAt/retrievedAt grouping in `JoinedGamesRepository` let one board join a total observed at 20:39 with a moneyline observed at 22:25, which the browser client, `assertLiveGame`, and the product's meaning of a board all reject. Tolerating sub-second skew between two sides of one market needs a bound and agreement across all three consumers.

## Provider-id churn splits line history across canonical events (found 2026-08-08)

While verifying FTE-060 on staging: the odds-history mirror is healthy
(50 series / hundreds of points on stable events), but when the provider
rotates an event id (`_b0` → `_b2`, sometimes the base too), schedule
reconciliation bootstraps a NEW canonical event. Consequences observed live:

- Line history splits: the new canonical id starts empty while the old id
  keeps the accumulated history (a chart can show one thin series ending at
  the churn moment).
- Duplicate board rows: both suffix variants can sit on the same day's
  board (e.g. `mlb_athletics_redsox_2026-08-08_b0` and `_b2`), because the
  withdrawn-listing filter only fires with a splits witness.

Next story should make canonical identity survive provider-id churn —
participants + start instant already identify the real-world game (the
withdrawn-listing filter proves the technique) — so one canonical event
carries one continuous history and the board never shows the same game
twice. FTE-026's "continue history across canonical event versions"
contract covers versions of one id, not churned ids; extending identity
resolution to merge churned ids (or alias them) is the clean fix.

## Incident 2026-08-08: provider feed change froze ingestion (resolved)

SharpAPI onboarded prediction exchanges (Polymarket/Kalshi) on 08-07/08.
Futures listings (empty away team) and per-book participant naming began
sharing event identities with sportsbook rows. The cross-page merge
treated any participant mismatch as provider corruption
(`odds:cross-page-event-participants`), failing whole league runs,
tripping 15-minute cooldowns, and ratcheting the failed continuation's
quota cost toward the 100 reserve — while the account health probe
stayed green. Boards froze at 2026-08-08T16:16Z.

Fix (e764ac5): drifted candidates become `participant-conflict`
rejections; first-seen participants stand; runs complete. Recovery also
required deleting the poisoned `ODDS_CONTROL#CONTINUATION#<league>` and
`ODDS_CONTROL#HEALTH#sharpapi:<league>:odds` rows on staging.

Hardening candidates:
- A freshness alarm on board/event `retrievedAt` age (provider health
  alone proved blind to persistence stalls).
- Continuation quota should reset when a terminal-cursor run restarts
  from page one, so a poisoned run cannot permanently starve a league.
- The `_b0` ghost rows still on boards are the churn-identity story
  (see the churn-split entry above) — now the top follow-up.

## Closing lines + CLV shipped (2026-08-10) — approved queue complete

Closing-line capture: each just-started priced game's served board
selections are written once as an immutable CLOSING_LINES record (first
post-start snapshot wins forever; the provider drops started games, so
that snapshot IS the close). CLV: qualified opportunities leave compact
CLV_ENTRY breadcrumbs; at capture, each entry is scored against the
closing fair (Pinnacle-anchored no-vig when the market carries the
anchor, display-book otherwise; moved lines skip, never fabricate) into
a rolling per-sport CLV_BOARD served at /sports/{sportKey}/clv and the
dashboard's Recent CLV tile. First live numbers require qualified
entries meeting their closes — the tile states its empty case honestly.
This closes the 2026-08-09 approved queue: soccer self-healing, Pinnacle
fair lines, +EV scanner, arbitrage/low-hold, CLV, plus alarm routing and
the board-freshness alarm. Next: prod cutover (FTE-059, approval-gated),
bet tracker (makes CLV personal), persist-path version re-resolution,
middles, backlog FTE-044..058.

## Soccer had no prices for eleven hours — two causes (2026-08-11)

Soccer games rendered on the board with `odds.state: "unavailable"` and not
one price. Two independent faults, found by reading state rather than logs.

**1. A latched ambiguity marker froze MLS ingestion.** MLS returned
`provider-request-ambiguous`, 0 pages, on every pass from 11:20 to 22:18
while every other league completed normally. `runOddsLeague` gates on
`if (continuation?.ambiguousUntil)` — the field's PRESENCE, not whether its
window is still open. The window had expired at 11:25:40. Nothing clears it:
`putContinuationCas` deliberately carries `ambiguousUntil` forward on every
write, and the reconciliation probe sits *after* this gate, so it is
unreachable once the gate returns. Ambiguity had no path to resolution.

Cleared operationally by deleting `ODDS_CONTROL#CONTINUATION#mls` and
`ODDS_CONTROL#HEALTH#sharpapi:mls:odds` — the same remediation as
2026-08-10 — after which MLS went healthy within one pass.

FIXED 2026-08-12 with an absolute ceiling, and one earlier claim here was
wrong. I first said loosening the gate breaks "fences ambiguous transport
and blocks fallback or paid recall". Re-tracing showed that is not what
that test protects: the providers in it have no `probe`, so the
unhealthy-health branch independently blocks any recall. Only the failure
STRING would have changed. The paid-recall invariant was never at risk.

What ships: after 45 minutes of unresolved ambiguity the league row is
claimed (its lease provably lapsed — ambiguity and lease are both
five-minute windows and the lease was renewed first) and cleared, exactly
as the operator did by hand. The pass still returns skipped; the NEXT pass
starts a fresh run. A recall is then accounted rather than blind: the
reserved cost was never refunded and the next response's quotaRemaining
overwrites local with provider truth.

Evidence beyond recall is checked against the PAGE ledger, not the
continuation's own flag — the ambiguous write sets that flag from a local
variable, which is precisely what put MLS beyond the reach of the age
ceiling that already existed.

The probe row latched identically, and was left latched on 2026-08-11
because only the league and health rows were deleted. It now gets the same
ceiling; without that the fix would merely have relocated the wedge to the
path that resolves ambiguity.

Still open: the same presence-check gate exists on the schedule path
(`production-odds-control-plane.ts` ~1366), and `unhealthyOddsProviderState`
writes no `expiresAt` for `class: "ambiguous"`, which is why the health row
also had to be deleted by hand.

**2. Leagues Cup odds are published under a league we do not ingest.**
Even with MLS healthy, the seven soccer fixtures stayed priceless. They are
Leagues Cup (MLS v Liga MX): Charlotte/Pachuca, Columbus/Pumas,
Minnesota/Atlante, Tigres/Vancouver. Verified against the live provider:
`/odds?league=leagues_cup` returns them directly, while `/odds?league=mls`
carries only "US Major League Soccer" derivative rows for those clubs. Our
odds collection policy pulls `mls` and never `leagues_cup`, so those games
can never receive a price. Note the underscore — `leagues-cup` is rejected
as an invalid filter.

This is NOT the policy addition it first looks like. Measured against the
live feeds: the two listings for one fixture carry DIFFERENT uuids, and the
uuid overlap between the `mls` and `leagues_cup` catalogues is 0 of 24. So
the provider's stable identity does not link them.

Charlotte v Pachuca, both listings:
  mls          8bfe74b8cef596c7  3 markets  books: [fliff]
  leagues_cup  b4389ac7b0149f8c  31 markets books: [circa, draftkings,
                                  galera, goldrush, ladbrokes, prophetx,
                                  saba, sportzino]

Our canonical event was bootstrapped from the `mls` listing, whose only book
is one we do not approve — which is the whole reason the row renders
`unavailable`. The liquidity is in the sibling listing we never fetch.

Two options, and the obvious one is wrong:
  (a) Ingest `leagues_cup` as its own league. Rejected: with no shared uuid
      it mints a SECOND canonical event per fixture, which is precisely the
      duplicate-game defect reported and fixed on 2026-08-11.
  (b) Resolve `leagues_cup` odds onto the existing canonical event by
      participant pair plus start instant — the identity this codebase
      already uses for schedule matching and split attribution. Correct, and
      consistent with the architecture, but it is a change to the ingest
      path's event resolution, not a config line. Note the `leagues_cup`
      catalogue carries several listings per fixture at different market
      counts (31, 4, 3), so it needs the same primary-market discrimination
      the MLB schedule parser already applies.

Worth pairing with an alarm on any league whose games are all `unavailable`
for more than one cadence — the signal that would have caught both of
today's faults in minutes rather than eleven hours.

## The live-projection fallback serves unfiltered boards (found 2026-08-11)

`withoutWithdrawnListings` runs only during board materialization. The API
serves a stored board when the request key matches a materialized one
(route, sport, league, status, day, limit) and otherwise falls through to
the live projection — which applies no withdrawn-listing filter at all.

So the same question gets two different answers depending on a cache hit.
A request missing `league`, or carrying a non-materialized limit, day, or
cursor, is served ghost listings that the stored board correctly drops.
Verified live: `sport=mlb&status=all&day=2026-08-11&limit=50` returned 19
items including four bogus 06:50Z rows, while the full key returned 15 with
none. The web app happens to always send the full key, so the UI is correct
today — the gap is one query-string change away from being user-visible.

This also cost real diagnosis time: a malformed verification query looked
exactly like a broken filter, and sent me chasing a bug that was not there.

Fix direction: apply the filter on the live-projection path too, so the
answer does not depend on which path served it. The schedule sweep is a
provider call, which is why it lives in the worker; the serve path would
need a cached or persisted listing set rather than its own sweep.

## Write cost is control-plane run bookkeeping, not odds data (measured 2026-08-11)

Two wrong hypotheses, then a measurement. DynamoDB Contributor Insights on
the staging table names the culprit outright: the top partitions by access
are `ODDS_CONTROL#RUN#<league>:sharpapi:<runId>` at 10,000-13,500 accesses
per run per 20 minutes, five concurrent MLB runs plus soccer, 542,182
sampled accesses in 20 minutes (~1.6M/hour). `ODDS_SNAPSHOTS_BY_ID` is a
distant sixth at 5,368.

Odds data was never the driver. Measured directly: 14,657 CURRENT
advances and 87,393 retained across ALL leagues in two hours — ~51K
persist operations/hour against a table consuming ~800K write units/hour.

Cause: every fetched page walks a five-step transition (sealPage,
commitPage, markEvidenceIntent, commitEvidencePage,
markPageMetricDelivered), and several of those ALSO bump the single
`ODDS_CONTROL#RUN#<runId>` item (version, evidenceCommitted, updatedAt).
One item per run, rewritten several times per page, many pages per pass,
~5 passes per minute from the fast lane.

Not fixed tonight, deliberately: this is the idempotency, replay-safety
and quota-fencing machinery, and it deserves a designed change rather
than a late patch. Options to weigh: collapse the per-page transitions
into one conditional write; stop mutating the run row per page and derive
run state from its pages; or keep the ledger but drop `updatedAt`
churn. Whatever is chosen must preserve exactly-once evidence commitment.

Shipped in the meantime and worth keeping: unchanged prices no longer
write (86% of persists are unchanged), and the snapshot mirrors are no
longer re-attempted per poll — those were conditional puts that fail once
the row exists, still billed, and then pay a consistent read. The test
that claimed zero writes had been asserting against a harness with no
mirrors wired; it now wires them and fails without the fix.

## Snapshot identity excluded our fetch clock (2026-08-10)

Cost review of a $77.64 AWS bill traced $18.95 of DynamoDB writes to a
correctness defect: snapshotContent() hashed `retrievedAt` — OUR fetch
timestamp — into snapshotId and therefore the SNAPSHOT# sort key. Proven
locally: identical price, identical provider observedAt, fetch 12s apart
=> different snapshotId and sortKey. With the insert conditioned on
attribute_not_exists, every poll wrote a fresh immutable row for every
selection of all 24 books whether or not the price moved (measured
~257K write units per 15 minutes, ~1.03M/hour). Odds history was
likewise polluted: chart points were fetches, not price moves.

Fix: identity is the observed market state only; `retrievedAt` stays
stored but out of the hash. Re-observing an unchanged price re-derives
the same identity and short-circuits BEFORE the transaction (a losing
conditional write is still billed, and TransactWrite bills double).
Legacy rows keep authenticating through a frozen v1 hash used for
verification only. Cadence, book coverage, and polling untouched.

Consequences accepted: `retrievedAt` now means "first seen at this
price", so a stable line honestly shows a growing age instead of
resetting each minute; the board freshness alarm threshold moved
30min -> 2h because a quiet market is not an outage (both real
incidents ran 16h and 20h). Snapshot identity also feeds derived
calculation input hashes, so newly written evaluations get new ids —
existing rows remain valid under their own hash.

Also noted during the review: OpenSearch (~$26/mo, 33% of the bill) is
agon-serverless-*, a different project sharing the account. Out of
scope, untouched, flagged to the owner.

## Incident 2026-08-10: poisoned splits continuation blanked the splits board (resolved)

One splits run failed at 2026-08-09T18:25Z; its continuation survived with
its runId, and the runId encodes the 30-minute split-history window — so
every tick for ~20 hours resumed the dead window, failed
splits-history:event-timestamp validation, and ratcheted quotaCost to 201
while the splits board served zero observations. Same self-poisoning class
as the odds cursor incident. Provider data was healthy throughout.

Recovery: deleted ODDS_CONTROL#CONTINUATION#splits:mlb and
ODDS_CONTROL#HEALTH#sharpapi:mlb:splits; the next pass succeeded
immediately (10/10 games, 60 observations, verified on the rendered page).
Fix: splits runIds aged past 45 minutes are abandoned for a fresh run with
a reset quota (splits runs are offset-paginated and restartable);
regression test pins the poisoning scenario. Alarm email routing shipped
in the same change — twenty hours of OddsSplitFailure will page next time.

## SharpAPI Sharp-plan capability audit (2026-08-09, docs.sharpapi.io)

Paying for Sharp ($399/mo, 1000 rpm, all endpoints); currently consuming only
/odds (featured+standard), /events, /splits, /account. Entitled but unused:

1. `/opportunities/ev` — provider-computed +EV: Pinnacle-anchored no-vig fair
   (Power method), EV%, Kelly %, confidence, quality tiers A/B/C, prop
   support. Directly powers the dashboard "+EV Scanner" and opportunity
   cards that exist in the design prototype. Highest value-per-effort.
2. `/odds/best` — best price + consensus + per-book edge + market hold, with
   Pinnacle in all_books on Sharp. Replaces the client-side same-book fair
   line in the Event Explorer cells with a REAL fair reference, making the
   green edge highlighting meaningful (the known gap).
   DONE 2026-08-09 without the extra endpoint: we already collect Pinnacle
   rows, so the list join now attaches `sharpAmericanOdds` per selection
   (point-matched only) and FairCell/gameHasEdge de-vig the Pinnacle market
   when every side carries an anchor, falling back to same-book no-vig
   otherwise. /odds/best remains interesting only for best-price display.
3. `/opportunities/arbitrage` (+ optimal stakes), `/opportunities/low_hold`,
   `/opportunities/middles` — new alert surfaces.
   DONE 2026-08-10 without the provider endpoints, evidence-first: an
   ArbitrageScanService rides the 5-minute generation pass, reads all 24
   collected books through the torn-read-safe evidence repository, and
   persists self-verifying findings (best legs with full snapshot evidence,
   competing quotes slimmed to best-price proof, latest scan replaces each
   sport's board, findings expire with the price-age window). Served at
   /sports/{sportKey}/arbitrage, rendered as a dashboard section. First
   verified live scan: 20 arbitrage + 8 low-hold sets on the MLB slate,
   12 rendered cards (board caps at 12 by hold; totalCount records 28).
   Middles remain unbuilt — needs alternate-line enumeration.
4. `/historical/clv` and closing odds — CLV tracking for the bet-tracker
   designs; we already persist our own immutable history, CLV closes the loop.
5. `/odds-delta` — compact line-move deltas; could cut fast-lane transfer.
6. `/stream` SSE (odds/opportunities/gamestate channels, delta merge,
   Last-Event-ID resume) — TRUE sub-second push, but requires the $99/mo
   WebSocket add-on on any tier (10 concurrent streams). This flips the
   FTE-060 polling-vs-push analysis: continuous ingestion becomes possible
   if the add-on is purchased. Worker consumes SSE → persists → boards; the
   10s fast lane remains the fallback.
7. Reference endpoints /teams /markets /sportsbooks — real team abbreviations
   for the block crests instead of derived monograms.

## Soccer lines: serving-join gap after the featured fallback (2026-08-09 evening)

Ingestion is healthy post-fallback (1,500+ MLS snapshots persisted), but the
board still shows soccer as unavailable. Diagnosis so far:

- Detail cells for MLS events read 309 unavailable + 3 "partial"; partial ==
  availability evidence state "incomplete" written at persist time.
- FIXTURE_ODDS current keys embed canonicalEventVersion; soccer events churn
  versions (and even id BASES — "usa_-_major_league_soccer_*", now "mls+_*")
  faster than MLB, so odds persisted at version N orphan when reconciliation
  advances the event to N+1 before the next odds pass.
- Next fixes: (1) make the current-odds read tolerate the immediately prior
  version (or key current rows version-independently), (2) inspect why the
  standard-endpoint persist emits "incomplete" availability for markets the
  raw feed fully prices, (3) FTE-061 aliasing is holding starts steady but
  provider id-base churn keeps minting new canonical events mid-day — the
  identity claim may need base-insensitive treatment.

## Version-tolerant current-odds reads — implementation plan (approved)

Evidence: provider still prices mlb_astros_padres_2026-08-09_b3 (439 fresh
rows at 22:42Z) while the canonical event sits at v2 with odds frozen at the
v1→v2 advancement instant (16:40Z). Writes continue at the old version's
keys; reads use event.version only. Same class as the soccer board flicker.

Change (packages/database/src/games-repository.ts):
- List path (~637-720): for each selection build key pairs — currentKey at
  event.version AND event.version-1 (when >1). Batch both. In the join,
  select per selection the row with the newer retrievedAt, validating each
  row against ITS version's expected key (validateCurrent already takes the
  expected key). allowedKeys/duplicate checks extend to the fallback pks.
- Detail path (~332-380): same pairing for currentKey and the AVAILABILITY
  keys; read-twice stability check unchanged (it compares snapshots, not
  versions).
- Root-cause follow-up (separate): the odds persist path pins the canonical
  version from the exact-binding row at alias time; it should re-resolve the
  CURRENT version each pass so writes follow advancements. Reads tolerant of
  v-1 bridge the gap either way.
- Tests: games-repository list/detail fixtures gain a case where fresh rows
  live at v-1 and stale rows at v (newest retrievedAt wins), and one where
  only v rows exist (unchanged behavior).

## Cursor-expiry recovery — RESOLVED (2026-08-09/10)

Root cause of the soccer provider-recovering loop: /odds cursors die when the
feed refreshes (~15s); a continuation resuming a dead cursor got 4xx →
whole-run failure → cooldown → new run → new continuation → same death. Fix
(71c4206): a provider-rejected error on a CURSOR page (never the first page)
completes the run with what was committed and emits OddsCursorExpired. After
deploy + one-time deletion of the poisoned ODDS_CONTROL continuation/health
rows, all five leagues run healthy (verified 2026-08-10T01:10Z: consecutive
successes, no cooldowns, MLB boards fresh). Soccer 8/9 boards stayed empty
only because every game started during the outage window and the provider
drops started games from /odds — no closing lines existed to serve. Watch the
first new soccer slate populates end-to-end.

## Opportunity generation wired (2026-08-09/10)

The full opportunity pipeline (candidate service → lifecycle → rank rows →
/sports/{sportKey}/opportunities → dashboard) existed with NO producer: the
OpportunityCandidateService was never instantiated outside its test, so the
dashboard served empty pages by construction. Added
apps/workers/src/opportunities/opportunity-generation-lambda.ts (EventBridge
rate(5 minutes), same invocation contract as expiration): each pass lists the
served board for today+tomorrow ET per ingested league, converts priced
scheduled games into market vectors, and feeds OpportunityCandidateService —
every number remains reproducible from our own stored snapshot evidence
(policy: target hardrock, comparisons DK/FD/MGM/Caesars, min EV 2%).
Dashboard is now linked in both navs as "Scanner" (/dashboard). VERIFIED
LIVE 2026-08-10T03:0xZ: all five leagues pass on schedule (mlb: 10 events,
54 candidates created, 0 qualified at current prices — honest outcome),
opportunities API complete with zero join failures, page renders on
staging desktop+mobile. Shipping it surfaced and fixed three latent
platform bugs: EventBridge second-precision timestamps rejected by strict
ISO round-trip validators (both opportunity workers), missing per-item
transactional IAM actions (ConditionCheckItem/DeleteItem — DynamoDB never
checks a "TransactWriteItems" action), and /dashboard missing from the
CloudFront SPA whitelist. Follow-ups:
consider SharpAPI /opportunities/ev as a cross-reference lens (provider-
asserted EV cannot enter the candidate evidence contract by design), and add
Pinnacle to the comparison roster or as a dedicated anchor book in the
evaluation policy.

## Latent: every EventBridge-scheduled opportunity invocation failed (found 2026-08-10)

The expiration worker's invocation validator required millisecond-ISO
round-trip equality on the event `time`, but live EventBridge stamps
schedules at second precision ("2026-08-10T01:55:00Z"), so EVERY invocation
since the worker shipped threw opportunity-expiration-invocation-invalid.
The new generation worker inherited the same check and failed its first
runs, which is how it surfaced. OpportunityExpirationFailuresAlarm (on
Lambda Errors) has presumably sat in ALARM the whole time — no alarm has a
notification action, so nobody saw it. Fixed both validators (accept
second-precision, return normalized instant). Follow-ups: route alarm
states somewhere visible (FTE-055), and add a matching failures alarm for
the generation worker.

## Observed: "mls+_" simulated-soccer listings pollute the mls schedule (2026-08-10)

The provider's schedule feed lists eSoccer/simulated fixtures under league
mls with "mls+_" id bases (chivas_memphis, hartford_loudoun, ~10-minute
cadence, 09:40:01Z-style start instants). They ingest as unpriced scheduled
events; the lines-only rule hides them from every surface and the phantom
filter retires them two hours after their claimed start, so user impact is
nil. No heuristic filter added — the provider has renamed real league keys
before (mls → usa_-_major_league_soccer → mls+_ inputs), so name-based
rejection risks dropping real games. Revisit if they ever arrive priced.

## Pinnacle-anchored fair lines — shipped to the list path (2026-08-09)

`sharpAmericanOdds?` on GameOddsSelectionDto; JoinedGamesRepository.list
attaches Pinnacle's merged candidate price per selection (same market +
selection + exact point). FE FairCell and gameHasEdge de-vig the anchor when
every side of a market has one; otherwise the old same-book fallback (which
by construction can never show an edge). Follow-ups: detail path could badge
"vs sharp" per cell; consider surfacing anchor age.

## A run that commits evidence and then fails repeatably is immortal (found 2026-08-12)

`odds-control-plane.ts:1074` exempts a continuation with
`evidenceCommitted: true` from the 45-minute staleness ceiling. The
exemption is correct in intent — 04f2008 added it so a resumed run never
re-walks sealed pages and commits the same evidence twice — but it is
unbounded, so a run that commits evidence and then hits a *repeatable*
failure is replayed forever with nothing able to abandon it.

Observed: MLS odds froze for seven hours on 2026-08-12 behind a single
`sharpapi-odds-mapping-start-mismatch`. The continuation row had been
rewritten 3,287 times against one runId. Fixing the trigger (that throw now
omits one listing rather than aborting the league) removes this instance,
not the class — the next repeatable post-evidence failure wedges the same
way.

Also note the failure was invisible in the obvious place: passes landing
inside the lease reported `provider-recovering`, which is deliberately
exempt from marking health unhealthy, so both MLS health rows stayed green
throughout. `/providers/status` did derive `stale` from freshness, but the
stored health record said healthy. The real cause was only on the RUN row's
`failureReason`.

A fix needs to distinguish "resumable, mid-flight" from "wedged on a
repeatable failure" — a consecutive-identical-failure count on the run row
would do it — and abandon the latter without re-walking committed pages.

## Incident 2026-08-12: production is five days stale and MLB is dark (OPEN)

Reported symptom: "missing games and lines in MLB — 7 splits showing, 15
games today." Measured at 2026-08-12T22:04Z against both environments.

**Production is not running the code that fixes this.** `origin/production`
is at `c62fafa` (2026-08-07); `origin/main` is 153 commits ahead. Everything
merged since 08-07 — the splits poisoning fix, churn-identity aliasing, the
board freshness alarm, alarm email routing, closing lines — is on staging
and absent from prod.

Prod `GET /providers/status`, MLB scopes, all three in outage:

| scope | connection | last success | age vs expected |
| --- | --- | --- | --- |
| `sharpapi:mlb:splits`   | outage | 2026-08-12T06:28:11Z | 56,228s / 900s |
| `sharpapi:mlb:schedule` | outage | 2026-08-12T20:58:11Z | 4,027s / 3,600s |
| `sharpapi:mlb:odds`     | outage | 2026-08-12T21:58:11Z | 428s / 3,600s |

MLB is the only league in outage on all three capabilities; the soccer
leagues' schedule and splits are healthy.

The splits outage is the **2026-08-10 self-poisoning, recurring verbatim**.
Prod `ODDS_CONTROL#HEALTH#sharpapi:mlb:splits` carries
`failureStage: splits-history:event-timestamp`, `failureReason:
invalid-response`, `consecutiveSuccesses: 0`, `version: 782`. Prod
`ODDS_CONTROL#CONTINUATION#splits:mlb` still holds `runId:
splits:mlb:2026-08-12T06:33:11.269Z` — a dead 30-minute window replayed
every tick for 15.5 hours, with `startedAt` refreshed to 22:03:20Z on each
attempt. The abandon-aged-runs fix (3d8424e, 2026-08-10) computes staleness
from the timestamp encoded in the runId and would have minted a fresh run on
the first tick after 07:18Z. It is on main. It is not on production.

Environment comparison for the same slate, same minute:

| | production | staging |
| --- | --- | --- |
| MLB rows served | 16 | 15 |
| newest split observation | 2026-08-12T06:28Z | 2026-08-12T22:01Z |
| Reds/White Sox rows | 2 (23:40Z and 23:45Z) | 1 |

Fifteen is correct. Prod's sixteenth row is the provider-id churn orphan
described in the 2026-08-08 entry above, also fixed on main (6edff78,
0b68369) and also not in production.

Board `freshness` is `2026-08-10T00:53Z` on prod and `2026-08-10T00:47Z` on
staging — the *odds* evidence is two days old in both. That is a second,
independent problem and it is not explained by the promotion gap. Soccer
odds scopes are in outage on prod; MLB odds report healthy on staging with
an 11-second age, so staging's stale board freshness needs its own look.

Not established: why the reporter counted 7. At 22:04Z the prod API returns
16 rows for the day, so 7 is neither the row count nor the unstarted count
(10 at that moment). Candidates are a client-side filter, the five-minute
whole-response board cache serving a partially materialised page, or an
earlier observation. Worth pinning down, because a UI that shows 7 of 16
served rows is a third defect.

Actions, in order:
1. Promote main to production. This is the whole fix for items 1–3.
2. Prod recovery for the poisoned run is the documented one — delete
   `ODDS_CONTROL#CONTINUATION#splits:mlb` and
   `ODDS_CONTROL#HEALTH#sharpapi:mlb:splits` — but only if the promotion
   cannot happen promptly, since the deployed fix does this by itself.
3. Ask why 15.5 hours of `OddsSplitFailure` did not page. The 2026-08-10
   entry claims "twenty hours of OddsSplitFailure will page next time" —
   that routing also shipped in 3d8424e and is therefore also not in prod.
4. Reconcile the two boards' odds freshness independently of the promotion.

Structural follow-ups are FTE-087 (a slate short a game alarms without a
person counting rows), FTE-084 (a stale splits witness must not delete
started games), and FTE-090. A promotion gap this size is its own risk and
belongs in Epic 11 rather than here.

## Incident 2026-08-12: the late games vanish from the MLB board (OPEN)

Reported on staging: "12 games in the splits, missing the late games."
Reproduced at 2026-08-12T23:00Z. The count depends on the query key:

| query | rows |
| --- | --- |
| `/splits?sport=mlb&status=scheduled&day=…&limit=50` | 15 |
| `/splits?sport=mlb&league=mlb&status=scheduled&day=…&limit=50` | **13** |

Same for `/games`: 15 without `league`, 13 with. The web client sends the
full key, so the product sees 13. The two missing rows are both 22:10
Eastern — Rangers at Angels, Royals at Dodgers.

The two paths are not the same code. `loadStoredBoard` matches on
`leagueKey`, so the full key hits the **materialized** board and a partial
key falls through to the **live projection**. `withoutWithdrawnListings`
runs only during materialization. The stored board is therefore filtered and
the live one is not, and nothing reconciles them.

The filter is doing this, in `board-projection.ts`:

```ts
if (startsInFuture) continue; // a future listing the provider no longer has
```

For a past-start game the filter asks the splits witness first. For a game
starting more than `PRE_START_IN_PLAY_GRACE_MS` (15 min) ahead it consults
**nothing** — absence from the current schedule listing is treated as proof
of withdrawal. Both dropped games carried 16 current split observations and
available odds.

Why they left the listing, established by direct provider calls
(`/events?league=mlb&live=false&limit=200`, offsets 0/200/400):

- The MLB catalogue returned **416 rows** for the day, overwhelmingly
  derivatives: `MLB Player Awards`, `- Player Props`, `First 3 Innings`,
  `WSH3 Washington wins by…`, Kalshi `kalshi_fut_kxmlbspread_*` binaries,
  and empty-participant rows carrying `binary`/`outright` markets.
- Of the nine rows at `2026-08-13T02:10Z`, **not one is a clean full-game
  row**. Every one is a prop, a binary, or an empty-participant row, and our
  parser correctly refuses all of them.

So the listing did not disappear because the game did. The catalogue rotated
its full-game rows out while the pollution stayed, and a correct exclusion
left nothing behind for the board filter to match.

This is the third distinct way this filter loses real games, and the only
one that never looks at evidence:

1. Past-start game, splits witness down — FTE-084.
2. Slate short and nothing notices — FTE-087.
3. **Future game, no witness consulted at all — FTE-091 (this one).**

Not yet established: how long a full-game row stays out of the catalogue,
and whether the rotation correlates with first pitch approaching. Both
matter for choosing the bounded window in FTE-091 and are worth sampling
across a full day before that story is written into code.

## The derivative-label filter does not catch a "+" catalogue (found 2026-08-13)

`derivativeLabelKind` (`packages/providers/src/sharp-api.ts:279`) recognises
player props, period markets, team totals and awards, but not a trailing `+`
on both participants. On 2026-08-12 six `mls+_*` listings — "Rapids +",
"Earthquakes +" — passed the filter, were bootstrapped as canonical events,
and sat on the MLS board beside the real fixtures.

**Correction 2026-08-13 04:20Z: this recurs, it did not self-correct.** An
earlier revision of this note said the rows had aged out and the catalogue
had stopped appearing. `mls%2B_dynamo_inter_2026-08-13_b0` is on the board
now. The rows age past the withdrawn-listing cutoff individually, so any one
of them disappears and the class looks resolved; the schedule feed keeps
minting new ones.

The cheap fix is a `+`-suffix rule. The better one is to reject a schedule
row whose provider league is not the one we asked for, since `mls+` is a
catalogue name and not a team name — and that shape generalises to the next
pollution catalogue, which this provider will publish.

## Alarms latch and never clear, so the alarm panel does not mean anything (found 2026-08-13)

Thirteen alarms were in ALARM across dev, staging and prod at 02:40Z. Several
are genuine and were: FixtureOddsProjection errors and DLQ on both staging and
prod, and SportPricelessBoardAlarm[soccer], which had correctly caught the
unpriced board since 08-12 07:59.

But `OddsSplitFailureAlarm` sits in ALARM on all three environments off a
single datapoint at 2026-08-09 17:37 and has never returned to OK. A panel
where a four-day-old transient looks identical to a live outage is a panel
nobody reads, which is how a lambda failed 100% of its invocations for six
days with its own alarm already red. Worth an explicit look at
`treatMissingData` and the evaluation windows.

## The odds projection is a repair path, and its DLQ is unreplayable (measured 2026-08-13)

Asked whether the projection is still needed after it spent six days failing
every invocation, the measurements say: yes, but not for anything it is
currently doing.

- Ingestion writes the CURRENT row inline (`fixture-odds-adapter.ts:704`).
  The projector is a second writer of the same row, fed by the table stream.
- Since it was repaired it has processed 13 snapshots and **advanced CURRENT
  zero times** — every one retained, meaning CURRENT was already at or ahead
  of the snapshot. The inline write always got there first.
- Sampling 82 odds partitions across soccer and MLB: **82 in sync, 0 stale,
  0 missing CURRENT**. Six days without the projector left no observable
  damage.

So its value is the failure it guards, not the traffic it carries: a snapshot
that commits while the inline `putCurrent` does not would otherwise leave
CURRENT stale forever, with nothing to notice. That did not happen in this
window. It is a backstop and should be kept as one.

**The 1,195,083 DLQ messages cannot be re-driven.** They carry no records —
only `DDBStreamBatchInfo` naming a shard and a sequence range. DynamoDB
Streams retain 24 hours, and these point at 08-07. Their only remaining value
is forensic: they record that the failure happened and when. Purging is safe
for data integrity; it costs the audit trail, which is a judgement call and
not one to make silently.
## 2026-08-13 overnight: what shipped, what is held, what is proven

### Production unwedged by hand (splits dark 19.8h)

Prod MLB splits had been dead since 2026-08-12T06:28Z — the same
self-poisoning as 2026-08-10, recurring because its fix (3d8424e) is on main
and production is still on c62fafa (2026-08-07). Promotion is blocked (see
below), so the documented recovery was applied instead: deleted
`ODDS_CONTROL#CONTINUATION#splits:mlb` and
`ODDS_CONTROL#HEALTH#sharpapi:mlb:splits`. Both rows were captured first —
`backup-continuation.json` / `backup-health.json` in the session scratchpad.

Result: `sharpapi:mlb:splits` went healthy within ~5 minutes (lastOk
2026-08-13T02:18:11Z), and the **2026-08-13** board was serving observations
five minutes old shortly after, across 8 of its 14 games.

Read the right day when checking this. The 2026-08-12 board still showed
06:27Z evidence and looked unrecovered, but every game on it had finished
and the splits feed only publishes for upcoming games — those observations
are the closing splits and correctly never move again. Confirmed directly:
`BETTING_SPLIT#…orioles_twins…` holds 24 CURRENT rows, newest 06:31Z, for a
game that started at 17:40Z. A finished day is not a frozen feed.

**This is a hand recovery, not a fix.** Production still lacks the aged-run
abandonment, so it will re-poison. The permanent fix is the promotion.

### Promotion is still blocked, and CI would not have caught it

`find-the-edge/prod/identity` and `find-the-edge/prod/stripe` do not exist.
`docs/phase1-deployment.md:24` — "The identity routes return `500` until this
secret exists." Since main gates the whole app behind sign-in (03721b3),
promoting now makes kevishie.com unusable.

CDK uses `Secret.fromSecretNameV2`, a lazy name reference, so synth and
deploy both succeed against a secret that is not there. The hosted smoke's
sign-in test (`tests/phase1-e2e/environment.spec.ts:158`) only asserts a
signed-out visitor reaches our own `/login`; it never completes an OTP round
trip. **A green deploy would not have meant a working production.**

Also unset, contrary to `docs/environment-promotion.md`: neither `main` nor
`production` has branch protection, and both GitHub Environments have
`deployment_branch_policy: null`.

### Shipped to staging (main @ 201ac2b)

- FTE-090 — a non-upcoming schedule row is a counted `not-upcoming`
  exclusion instead of throwing away the whole page.
- FTE-091 — a future absentee is judged by the splits witness instead of
  dropped on lead time alone.

Verification status, stated honestly:

- **Safe: proven.** On the 2026-08-13 board the filter still drops all four
  `_b0` churn orphans at their placeholder `06:50Z` kickoff, two of which
  carry splits — so the vouched-sibling rule, not the witness, is what
  rejects that class. That was the premise of the change and it holds on
  live data.
- **Effective: NOT yet proven.** By deploy time the two 22:10 Eastern games
  had started, so they are judged by the past-start branch, which is
  unchanged. At the time of writing the catalogue carries every game on the
  board, so the new branch is inert. A sampler is recording catalogue
  membership against the served board every ten minutes
  (`rotation-sampler.py`, log `rotation-log.jsonl`) to catch the next
  pregame rotation.

  **No valid pregame observation exists yet, and the first three rounds of
  sampler output were all instrument error.** Recorded because the pattern
  matters more than the data: every one produced confident, wrong findings.

  1. Membership keyed on the start instant alone, so a single clean row at
     22:40Z marked both 22:40Z games present and they flapped in lockstep.
  2. The completeness check could not model club resolution, so the NFL row
     declaring `league: "mlb"` reported as a missing game every pass.
  3. Club matching by prefix-or-last-token missed the catalogue's
     abbreviations — "Chicago White Sox" against "Chicago WS", "Athletics"
     against "A's" — and reported two games as absent from the catalogue for
     four consecutive samples. They were present the whole time. That very
     nearly became a claim that FTE-091 was saving real games.

  Now joined on the provider event id with its `_bN` churn suffix stripped,
  which our canonical ids embed as their last colon-separated segment. Ids do
  not abbreviate. The earlier logs are archived under
  `rotation-log-startmatched.jsonl` and `rotation-log-labelmatched.jsonl` and
  should not be used for anything.

  Established independently and still good: the catalogue reaches 78 days
  ahead, so a game absent from it is genuinely absent rather than beyond the
  horizon; and three back-to-back offset walks returned identical 347-row
  sets, so neither the sampler nor `fetchSharpApiSchedulePage` loses rows to
  pagination.

### Held back deliberately (committed, not pushed)

Two changes are on the worktree branch only. Holding them keeps the board
rule stable overnight so the sampler measures FTE-091 alone.

- **FTE-084 partial — a quiet witness gets no vote.** The witness now
  returns the newest observation instant rather than a boolean, judges feed
  liveness across the whole board, and keeps every absentee when nothing on
  the board is fresh. It also no longer fails OPEN on a repository error.
  Needed because FTE-091 made the witness load-bearing for future games too,
  and splits are never expired or age-checked anywhere.
- **`targetQualified` no longer gates on `metadata.freshness`.** That field
  is `canonicalFreshness` = the event row's `updatedAt`, which advances only
  on a REVISED provider listing — so an uncorrected game goes stale two
  hours after ingestion and stays there. Measured on staging: every MLB game
  at ~189,000s against a 7,200s threshold while carrying minute-old prices,
  so every detail page said the target book's "coverage is incomplete". The
  server and browser rules had to move together, because
  `apps/web/src/api.ts` recomputes this and rejects the response on
  disagreement.

### Still open

- The "Metadata stale · Evidence <date>" badge still renders from
  `canonicalFreshness`, so a row can read "odds 1m old" beside "Evidence Aug
  10". Wider blast radius: the browser validator treats `metadata` as a pure
  function of that field, so server, browser, and
  `packages/domain/src/event-metadata.ts` must move together.
- `StaleEventMetadata` is emitted but has no alarm.
- The stored board and the live projection remain different code paths;
  `withoutWithdrawnListings` runs only during materialization. They agree on
  the 2026-08-12 case now, but nothing enforces that they agree in general.
- Why the original report counted 7 has never been established.

### Catalogue churn is real, and the offset walk is not the cause

The rotation sampler reported MLB rows leaving and returning the `/events`
catalogue between ten-minute samples. Two instrument faults had to be ruled
out first, and both were real:

1. Membership was keyed on the start instant alone, so both 22:40Z games
   flipped together whenever any clean row existed at that instant. Now
   matched on participants, tolerating the catalogue's truncated and
   abbreviated club labels ("Chicago C", "ARI Cardinals").
2. The completeness check reported foreign fixtures forever. The NFL row
   declares `league: "mlb"` and `sport: "baseball"`, so no league filter
   reaches it — the product rejects it on club resolution, which the sampler
   cannot replicate. It now requires both clubs to be ones the board
   resolves elsewhere, and ignores matchups already on the board at another
   time (the placeholder-kickoff orphans).

The third candidate was the walk itself: offset pagination over a mutating
collection can skip or duplicate rows, so a row could appear to vanish while
present throughout. **It does not.** Three back-to-back full walks returned
347 rows over 2 pages, 347 unique ids, zero duplicates, byte-identical id
sets, with the provider reporting `total: 347` each time.

That result matters beyond the sampler: `fetchSharpApiSchedulePage` walks
the same offsets the same way, so ingestion is not silently losing rows to
pagination either. Worth re-running if that assumption is ever load-bearing
again — `pagination-stability.py` in the session scratchpad.

So the churn is genuine provider behaviour. The catalogue also shrank from
416 rows to 347 within the hour as finished games and their derivatives were
culled. Every transition observed so far is on a STARTED game, where leaving
a `live=false` catalogue is ordinary; the discriminating case for FTE-091 is
a PREGAME row leaving, and none has been seen yet. The sampler tags phase
explicitly so those are not buried in post-start churn.

## The soccer explorer shows zero priced games while the API serves five (OPEN, 2026-08-13)

The staging deploy has failed twice on the same smoke assertion — the soccer
leg of `real hosted bundle loads provider MLB and MLS games by day`. Runs
31663922673 (69a77da) and 31668997041 (1a7f8ae), the first of them a
docs-only commit.

**Not caused by FTE-090/FTE-091.** Both are server-side, and bb81e53
deployed green after they were already live. The failing behaviour is in the
web client.

Reproduced locally against staging with the hosted smoke, then narrowed with
a browser probe. For `2026-08-13`:

- The page requests exactly the right URL —
  `/games?sport=soccer&league=mls&status=all&day=2026-08-13&limit=50` — and
  the browser receives **7 items, 5 of them `odds.state: "available"` with
  3–7 selections each** (Leagues Cup: Santos Laguna, Necaxa, Club América,
  Cruz Azul, Tijuana). The other two are the `mls+` pollution rows.
- The explorer renders **0 rows** and the Soccer pill reads **0**.
- Selecting MLB instead, the Soccer pill is **absent entirely**, which the
  rail does only when the other sport has zero priced items. Both the
  `baseItems` and `otherSportItems` paths therefore see zero.
- No console error, no page error, no error banner. MLB renders 9 on the
  same page load.

Eliminated:

- `collapseNearDuplicateGames` — run directly against the captured payload,
  it returns all 7 items with all 5 priced.
- A parse rejection — `parsePage` throws rather than dropping, and a throw
  would surface the error banner, which is absent.
- The query key — the browser's own request is the full materialized-board
  key, verified by interception.

So `hasLines` (`odds.state === "available" && selections.length > 0`) is
returning false for items that satisfy it in the response body. That is a
contradiction and it is not resolved.

**Tested and disproven:** the deployed bundle is not stale. The staging
stack's `ReleaseSha` output is
`1a7f8ae88090c404cf75b499d807b8a99cb9c7af`, exactly `origin/main`. The
failed deploys still shipped the release — the smoke verdict fails the job
after the deploy step — so the running client does correspond to the source
being read. The contradiction is real and remains open.

Next thing to try, cheapest first: put a breakpoint-equivalent in
`hasLines` by rendering the parsed `odds.state` for a soccer item, or run
`parsePage` directly against the captured `soc.json` fixture the way
`collapseNearDuplicateGames` was tested. If `parsePage` returns 5 priced
items in isolation, the loss is between the client and React state — the
`requestId.current` guard and the `otherSportItems` race are the only
candidates left in that stretch.

Worth noting for the product record: soccer has been written up repeatedly
as "unpriced". On this evidence the API is serving prices and the client is
discarding them, which is a different problem with a different fix.

## FTE-091 verified saving a real game (2026-08-13T11:36Z)

The discriminating case finally occurred: a PREGAME full-game row leaving the
provider catalogue. Verified independently of the sampler.

**Cincinnati Reds @ Chicago White Sox, 2026-08-13T18:10Z**

| check | result |
| --- | --- |
| on the stored (filtered) board | yes — `mlb_chicagows_reds_2026-08-13_b2` |
| clean full-game row in `/events` | **no** |
| lead time | **+394 min** (6.5 h before first pitch) |
| split witness | 2 stamps, newest **6 minutes old** |

Every condition of the fix holds at once: a real game, hours from first
pitch, whose catalogue row rotated out, with a live witness proving it
exists. The pre-FTE-091 rule was `if (startsInFuture) continue` — it
consulted nothing — so it would have deleted this row from the board along
with its lines. That is the reported symptom, reproduced in the wild and
prevented.

Note the lead time: 394 minutes. The fifteen-minute pre-start grace window
that 9b98b3f bought was never going to cover this, which is the point the
story made and this measures.

**Chicago White Sox @ Detroit Tigers, 2026-08-14T22:40Z — inconclusive, and
possibly a defect in the fix.** It is on the stored board, has no clean
catalogue row, and has **no split evidence at all**. Under FTE-091 an MLB
future absentee with no witness should be DROPPED, so its presence is not
explained by the change. The likely answer is materialisation lag — the row
left the catalogue minutes earlier and the board has not rebuilt — but if it
is still on the board after a materialisation cycle with no splits, then the
witness path is not being reached for far-future games and that needs
chasing. Re-check before treating FTE-091 as fully correct.

### Caveat on the FTE-091 verification (2026-08-13T13:15Z)

The White Sox @ Tigers case is **not** materialisation lag. It left the
catalogue at 11:35Z, was still absent at 12:56Z across three samples, is
still on the stored board at 13:14Z, and the Aug-14 splits board shows it
with **zero** split observations. Under FTE-091 an MLB future absentee with
no witness should be dropped. It is not.

The likely reason exposes a flaw in how BOTH cases were verified. The
sampler and the verification script decide "absent from the catalogue" by
**provider event id** (base, `_bN` stripped). `withoutWithdrawnListings`
decides it by **participants plus start instant within 15 minutes**
(`listingMatchesGame`). Those are not the same question. A row whose id base
churned — and the 2026-08-08 entry above records that the base wording does
churn, not just the suffix — is absent by id and present by participants. It
would be vouched by the schedule branch and never reach the witness at all.

That explains the Tigers row without any defect in the fix, and it means the
Reds @ White Sox conclusion is **weaker than stated**: it shows no row shared
that id base, not that no listing matched. The claim that the pre-FTE-091
rule would have deleted it needs the participant-and-start check to have
failed too, which was not tested.

To close it: re-run the comparison keyed on participants + start instant
with the 15-minute tolerance, mirroring `listingMatchesGame`, rather than on
ids. Blocked right now — the AWS session expired, so the provider key cannot
be read (the running sampler still works; it cached the key at startup).

FTE-091 remains deployed and safe — the ghost regressions still hold — but
"verified saving a real game" should be read as "consistent with saving a
real game, by an id-based test that does not match the rule under test".

## Four real games are missing from tomorrow's board (2026-08-13T13:25Z)

Chasing the unexplained retention resolved it and turned up something worse.

**The retention was not a defect.** On the 2026-08-14 board every one of the
13 games has ZERO split observations, yet 9 are kept and 4 dropped. The
witness cannot be the discriminator when nobody has one — the kept rows are
matched by a schedule LISTING (participants + start instant), which is
exactly the id-vs-listing distinction the previous entry predicted. White Sox
@ Tigers is vouched by a listing despite being absent by provider id.

**The dropped four are real MLB games**, all ~33 hours out:

| matchup | splits | lead |
| --- | --- | --- |
| Boston Red Sox @ Pittsburgh Pirates | 0 | 33.3 h |
| Washington Nationals @ New York Mets | 0 | 33.8 h |
| New York Yankees @ Toronto Blue Jays | 0 | 33.9 h |
| Arizona Diamondbacks @ Atlanta Braves | 0 | 33.9 h |

They are absent from the schedule listings and have no splits, so they fall
to `witness-silent` and are deleted from the board along with their lines.
Boston @ Pittsburgh was observed as a clean catalogue row at 04:40Z, so this
is a row that rotated out, not a game that never existed.

**FTE-091 does not cover this class.** The witness is betting splits, and
splits do not exist 33 hours before first pitch — the provider publishes them
much closer to the game. So the fix rescues a catalogue-absent game only
inside the splits window (the Reds case, 6.5 h out, worked). Beyond that
window the board still deletes real games on catalogue absence alone, which
is the original reported symptom surviving one day further out.

**The held FTE-084 commit already fixes this.** It judges witness liveness
across the whole board: if nothing on the board carries a fresh observation
the feed has no opinion and every absentee is kept. On this Aug-14 board no
game has any split at all, so `witnessUsable` is false and all 13 rows
survive. That change is committed on the worktree branch and unpushed — it
was held overnight to keep the board rule stable while FTE-091 was measured,
and this is the strongest argument yet for landing it.

Worth re-checking after it lands: whether keeping every absentee on a
splitless far-future board also readmits the `06:50Z` placeholder orphans.
The vouched-sibling rule runs before the witness and should still catch
them, but it has not been observed under these conditions.
