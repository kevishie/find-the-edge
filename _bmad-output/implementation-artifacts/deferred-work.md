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
