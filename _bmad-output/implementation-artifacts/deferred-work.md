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
