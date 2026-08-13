# Leagues Cup odds: resolve onto existing events, never mint new ones

Status: IMPLEMENTED AND DEPLOYED (227f333), BUT NOT WORKING IN PRODUCTION.
Soccer is still 0 priced. Written 2026-08-12.

## Where it stands (2026-08-12, REVERTED)

The combined request is **reverted**. MLS is back to asking for its own
catalogue only. Soccer remains unpriced, which is where it started — but MLS
ingestion works again, and a working league is worth more than an unpriced
one.

The question the last session should have asked first was answered by
sampling the ingestion log across 20 hours:

| when | mls |
|---|---|
| T-20h | failed, provider-request-ambiguous (the latch, since fixed) |
| T-12h | completed, 20 pages |
| T-6h | completed, 19 pages |
| T-2h | completed, 19 pages |
| after the change | **skipped, provider-recovering, every pass** |

So MLS was healthy immediately before, and the combined request broke it.
The schedule-parser revert (02c1a67) was a genuine latent-bug fix but not the
cause; the odds-side change is.

What is still true and worth keeping:

- `league` IS comma-separated and the combined call works **by hand**:
  `league=MLS,leagues_cup` returns 166 Leagues Cup rows beside 34 MLS rows.
  The failure is in what the ingestion path does with them, not in the
  request.
- Both MLS health rows stayed **green** throughout the outage — schedule and
  odds — while the league reported skipped/provider-recovering. Whatever
  fails, it fails without marking health, which is itself worth fixing:
  a league that stops running while its health says healthy is invisible.
- The `secondaryOddsProviderLeagues` declaration, the per-row catalogue
  tagging, and the resolve-or-skip alias binding all remain in the tree and
  are inert while the request is narrow. They are tested and ready.

## ANSWERED 2026-08-12 22:00Z — all three suspects were wrong

The three suspects below were **quota**, **`expectedProviderEvents`**, and
**page-count explosion**. Staging data refutes each: no `quota-reserve` and
no `sharpapi-event-binding-unavailable` appears anywhere in the log window,
and the skip carries `pages: 0`, so nothing paginated at all.

The revert also did **not** fix MLS, which the section above assumed. MLS
odds last succeeded at **16:05:08.918Z** — minutes after the revert deployed
— and had not succeeded for the seven hours since.

The real chain, every link evidenced:

1. `sharp-api-ingestion.ts` **threw** `sharpapi-odds-mapping-start-mismatch`
   when one listing's odds-side start disagreed with the authoritative
   schedule by more than 15 minutes. A throw there aborts the whole page, so
   **one unpriceable fixture stopped the entire league**.
   Log: `{"leagueKey":"mls","status":"failed",`
   `"reason":"sharpapi-odds-mapping-start-mismatch","pages":23}`.
2. The failure is retryable and SharpAPI is the only odds provider, so the
   run **keeps its continuation** rather than moving on.
3. The run had committed evidence, and `odds-control-plane.ts:1074`'s
   staleness ceiling **exempts a run with `evidenceCommitted: true`** — added
   deliberately in 04f2008 so pages are never re-walked and committed twice.
   The exemption is unbounded, so the wedged run became immortal.
4. Every later pass resumed the same runId and failed identically. The
   continuation row had been rewritten **3,287 times**; the run row 160.
5. Passes arriving inside the 5-minute lease of whichever invocation held it
   reported `provider-recovering` with `pages: 0` — the observed symptom is
   `odds-control-plane.ts:1105`, and it is lease contention, not the cause.
   The cause is on the RUN row's `failureReason`, not in the skip summary.

Staging evidence, `ODDS_CONTROL#CONTINUATION#mls` (MLB and EPL have no row
at all, which is what a healthy league looks like — a completed run clears
its continuation):

```
runId: mls:sharpapi:2026-08-12T16:05:08.918Z   evidenceCommitted: true
version: 3287   quotaCost: 23   updatedAt: 22:55:09Z
RUN row → status: failed, failureReason: sharpapi-odds-mapping-start-mismatch
```

**Fixed:** a start-time disagreement now omits and counts that one listing
(`start-time-conflict`, which emits through the existing
`OddsNormalizationRejected` metric) instead of aborting the league. An exact
`source` binding is still trusted through a delay or postponement. Once MLS
stops failing, the run completes and clears its own continuation, so the
staging wedge self-heals.

**Still open — the immortal run.** Closing the throw removes *this* trigger,
not the class. Any run that commits evidence and then fails repeatably is
still exempt from the staleness ceiling forever. Recorded in
`deferred-work.md`.

## CORRECTION: the fix did not end the outage (2026-08-13 01:20Z)

An earlier revision of this section claimed the wedge "self-healed exactly
as predicted" after f28696d. **That attribution was wrong**, and the fix's
own instrumentation is what disproves it: `start-time-conflict` has never
been emitted in production, so the new omission branch has never executed.
`OddsNormalizationRejected` is definitely wired — mls reports
`incomplete-market: 268` over the same window — so the absence is real, not
a plumbing gap.

The pass timeline across the deploy (cold start with the new code at
23:15:00Z):

| time | code | outcome |
|---|---|---|
| 23:13:36Z | old | failed, start-mismatch, 23 pages |
| 23:15:00Z | — | INIT_START, new code |
| 23:15:39, 23:17:54 | new | skipped, provider-recovering (lease) |
| 23:21:07Z onward | new | **completed**, 23 pages |

So on new code the run completed while omitting nothing. The offending row
had stopped drifting between 23:13:36 and 23:21:07 — the data changed, not
the code. The likeliest mechanism is the pre-existing started-guard
(`pageRetrievedAt >= canonicalStartsAt`) skipping the fixture once its
canonical start passed, which sits ahead of the drift check.

**What this does and does not change.** The mechanism diagnosis stands —
throw, retryable, continuation kept, evidence-committed exemption, immortal
run — and is evidenced by the run/continuation rows and 3,287 writes. The
fix is still correct and would have prevented a seven-hour outage. But it is
unproven in production, resting on unit tests alone, and the outage would
have ended when it did regardless.

**Second throw site, now also fixed.** The first fix covered the two drift
throws and left a third: an unparseable `canonical.startsAt` still aborted
the league. That is the same defect class and is now an omit-and-count too.
An unparseable *page* timestamp still throws, because every event on that
page would be unjudgeable.

## Verified on staging after the fix (2026-08-12 23:20Z)

MLS ingestion did recover, and these observations are accurate — only the
causal attribution above was wrong:

- the wedged continuation (`…16:05:08.918Z`, version 3431) is **gone**,
  replaced by a fresh run `mls:sharpapi:2026-08-12T23:19:49.106Z` at
  version 18 that is progressing normally;
- `sharpapi:mls:odds` is **healthy**, last success 23:19:49Z (it had been
  frozen at 16:05:08.918Z for seven hours), `recommendationImpact` back to
  `none` from `suppressed`;
- the account summary went from 6 healthy / 9 stale / 10 impacted to
  **11 healthy / 5 stale / 5 impacted**.

**Soccer is still unpriced, and that is this spec's original problem.** The
outage was a separate defect layered on top of it. The board for
2026-08-12, fetched with the exact UI query, holds 13 fixtures and every one
is `odds.state: "unavailable"`:

- **7 are Leagues Cup** — Inter Miami v León, Orlando City v San Luis,
  Monterrey v Nashville, Toluca v FC Dallas, San Diego v Puebla, Seattle v
  Chivas, LAFC v Querétaro — all under provider ids prefixed
  `usa_-_major_league_soccer_`. These are precisely the fixtures "The
  problem" section describes: canonical from the `mls` listing whose only
  book is `fliff`, with the liquidity in the `leagues_cup` catalogue we do
  not fetch. The design below is still the fix and is still inert.
- **6 are `mls+` derivative listings** — `mls+_earthquakes_rapids_…`, with
  participants labelled "Rapids +" / "Earthquakes +". These are the
  catalogue-pollution class, not real games, and they should probably never
  reach a board. Not yet investigated; recorded here because it is a
  separate defect from either of the above.

**REFUTED 2026-08-13: start drift is not why the combined request broke
MLS.** The hypothesis was that the combined call's Leagues Cup rows carry
start times disagreeing with the canonical events they resolve onto, and
that one drifting past tolerance hit the throw. Measured directly by
capturing the live `leagues_cup` catalogue (390 rows, 2 pages) and comparing
each fixture against the canonical start our own board serves:

| fixture | canonical | leagues_cup | drift |
|---|---|---|---|
| intermiami_leon | 23:30:00Z | 23:30:00Z | 0 |
| orlandocity_sanluis | 23:30:00Z | 23:30:00Z | 0 |
| monterrey_nashville | 00:10:00Z | 00:00:00Z | 10 min |
| puebla_sandiego | 02:25:00Z | 02:15:00Z | 10 min |
| …8 more | | | 0 |

**12 of 12 matched, 0 beyond the 15-minute tolerance**, worst case 10
minutes.

**That refutation was too strong — see the census below.** It compared the
fixture pairs I could match by name between two catalogues. The real
resolution path matches differently, and it does find a drifting row.

## Census: replaying the combined request offline (2026-08-13 01:30Z)

`scripts/replay-odds-capture.mjs` replays a captured payload through the
real ingestion code against the real table, with `ingestEvent` and
`reconcileScheduledEvent` recorded and refused so nothing is written. Each
event replays on its own single-event page, so one failure cannot mask the
rest — a census of every row, not the first throw.

Captured `league=MLS,leagues_cup`, 6 pages, 1,200 price rows, 48 distinct
events (20 `leagues_cup`, 25 `usa_-_major_league_soccer`, 5 `mls`), replayed
with the real 24-book role map:

| outcome | n | reading |
|---|---|---|
| priced, clean | 9 | mostly `leagues_cup_*` — **this is the payoff** |
| priced, incomplete-market | 5 | also mostly `leagues_cup_*` |
| no observations | 31 | started fixtures and unapproved books |
| **WOULD MINT a canonical event** | **2** | the duplicate hazard, confirmed |
| **start-time-conflict** | **1** | real drift, `leagues_cup_necaxa_nycfc` |

Three things follow.

1. **The combined request does deliver the goal.** 14 fixtures would price,
   most of them Leagues Cup. This is no longer theoretical.
2. **The duplicate-minting hazard is real and small.** Exactly two rows
   reach `reconcileScheduledEvent`:
   `leagues_cup_atleticosanluis_orlandocity_2026-08-12_b3` and
   `leagues_cup_guadalajarachivas_seattlesounders_2026-08-13_b0`. This is
   precisely what step 5 of the design below exists to prevent — resolve or
   skip, never reconcile a tagged row.
3. **Start drift does occur**, on one row, and it is exactly the condition
   that aborted the league before 61dbdd0. That makes drift a live candidate
   for what broke MLS on 2026-08-12 after all, and it means the fix removes
   a real blocker rather than a hypothetical one.

**Harness caveat.** The `schedule-event-conflict` label on the two minting
rows is an artifact of the stub: `reconcileScheduledProviderEvent` throws
that whenever the store returns unresolved, which is what the refusing stub
returns. The real outcome for those rows is a *mint* — a second canonical
event for a fixture that already has one — not a throw. Do not read that
label as a production failure mode. The census is also a snapshot: at
01:30Z many of the day's fixtures had started, which is most of the 31.

**Where this leaves re-enabling.** The remaining blocker is the two minting
rows, and the design below already answers them. Re-enabling still needs an
assertion that MLS completes, but the path is now concrete rather than
speculative.

Do not re-enable the combined request without an assertion that MLS still
completes.

## Superseded suspects (kept for the record)

1. **Quota.** 34 MLS rows became 200 rows a page. `provider-recovering` is
   reported with `quotaCost: 22` and the quota-reserve branch is one of the
   few paths that returns it with health green. Compare `quotaRemaining`
   before and after; the reserve is 100 (`packages/config/src/feed-coverage.ts`).
2. **`expectedProviderEvents`.** `production-odds-control-plane.ts:2082`
   resolves every omitted expected event and throws
   `sharpapi-event-binding-unavailable`. 166 unexpected rows arriving in a
   run whose expectations came from an MLS-only schedule scan is exactly the
   shape that trips it.
3. **Page-count explosion.** 19-20 pages became however many 200-row pages
   166+34 rows require, against a 100-page guard and a per-pass cadence.

## The problem

Soccer fixtures render on the board with `odds.state: "unavailable"`. They
are Leagues Cup (MLS v Liga MX). Our canonical event is bootstrapped from
the `mls` schedule listing, whose only book is `fliff` — which we do not
approve — so nothing prices it. The liquidity is in a sibling listing under
the provider league `leagues_cup`, which we never fetch.

Charlotte v Pachuca, both listings, measured against the live feed:

| feed | provider id | uuid | markets | books |
|---|---|---|---|---|
| `mls` | `usa_-_major_league_soccer_charlotte_pachuca_2026-08-11_b3` | `8bfe74b8cef596c7` | 3 | fliff |
| `leagues_cup` | `leagues_cup_charlotte_pachuca_2026-08-11_b3` | `b4389ac7b0149f8c` | 31 | circa, draftkings, galera, goldrush, ladbrokes, prophetx, saba, sportzino |

uuid overlap between the two catalogues is **0 of 24**. The provider's own
stable identity does not link them.

## The hard constraint

Odds are resolved to a canonical event by **exact provider event id**,
namespaced `(providerId, sportKey, leagueKey, providerEventId)` —
`mappingId` at `packages/database/src/event-ingestion.ts:1203`. Not by uuid,
not by participants.

Cross-league binding is refused in two places:

- `packages/database/src/dynamodb-event-ingestion.ts:713` and `:749` throw
  `mapping-canonical-scope-mismatch` when the mapping's league differs from
  the canonical event's.
- The odds snapshot transaction, `packages/database/src/fixture-odds-adapter.ts:609`,
  conditions on a `MAPPING#` row pointing at the canonical id **and** on the
  `EVENT#` row carrying the same `leagueKey`.

⇒ Leagues Cup odds can only land on `event:soccer%3Amls:…` if they are
persisted under `leagueKey: "mls"`. Not negotiable without gutting the fence.

Helpfully the odds and schedule parsers already accept a row whose `league`
field equals either the leagueKey or the providerLeague
(`packages/providers/src/sharp-api.ts:1152` and `:1636`), so
`{ leagueKey: "mls", providerLeague: "leagues_cup" }` parses unchanged.
Splits do **not** — `apps/workers/src/sharp-api-ingestion.ts:1000` compares
strictly against `leagueKey` and would gap every Leagues Cup split.

## Why the obvious approach is wrong

Adding `leagues_cup` as a sixth entry in `sharpApiLeagues` mints a **second
canonical event per fixture**, and one per derivative listing (the catalogue
carries 31/4/3-market variants of the same game). Two independent paths reach
the single minting call at `packages/database/src/event-ingestion.ts:393`:

- schedule — `production-odds-control-plane.ts:1320` iterates `sharpApiLeagues`
  unconditionally, not gated on the collection policy, → `:1601` → `:994` →
  `schedule-reconciliation.ts:62`;
- odds — `sharp-api-ingestion.ts:533` reaches it directly.

It is guaranteed to fire: `findNearCanonicalCandidates` partitions by league
(`dynamodb-event-ingestion.ts:781`), and a fresh `leagues-cup` key has an
empty partition, so zero candidates, so bootstrap. Read-time dedupe cannot
save it — `withoutWithdrawnListings` sees one league's page at a time and
would never meet the mls sibling. This is the duplicate-game defect fixed on
2026-08-11.

## The design

A **secondary odds-only provider league on the existing `mls` entry**, with
resolve-or-skip binding.

1. `packages/providers/src/sharp-api.ts:42` — add
   `readonly secondaryOddsProviderLeagues?: readonly string[]` to
   `SharpApiLeague`; set `["leagues_cup"]` on the mls entry. No new array
   element, so no extra orchestration iteration, no new checkpoint
   (`schedule:sharpapi:<league>`), health (`sharpapi:<league>:schedule`) or
   splits-continuation key, and no union widening. Orchestration is 1:1 on
   leagueKey — `sharpApiLeagueByKey` and `sharpApiLeagues.find(...)` both
   return the first match — so a second entry with the same key would be
   silently ignored anyway.
2. `apps/workers/src/production-odds-control-plane.ts:2156` (`fetchPage`) —
   after the primary cursor is exhausted, continue the page sequence with a
   secondary token (`secondary:leagues_cup:start`) fetching via
   `fetchSharpApiFeaturedOdds({ ...sharpLeague, providerLeague: "leagues_cup" })`.
   Each secondary page seals as its own material. The sealed-page and
   evidence machinery is untouched: materials are opaque `unknown[]` and the
   page committer is already a validate-only no-op.
3. `apps/workers/src/sharp-api-ingestion.ts:497` — tag secondary rows, and
   for a tagged row resolve in this order:
   1. `getExactMapping` / `resolveExactCanonicalBinding` (a prior run's alias
      resolves instantly);
   2. lenient unique match against the in-run mls `canonicalOddsEvents`,
      reusing `splitIdentityMatchesCanonical` and
      `uniqueCanonicalSplitCandidate` (`sharp-api-ingestion.ts:135` and
      `:153`) — the same nickname-anchored matcher split attribution uses;
   3. `store.findNearCanonicalCandidates`;
   4. on a unique hit write **only an alias**, the call already at
      `event-ingestion.ts:380` with `mappingKind: "alias"`;
   5. on zero or more than one candidate, skip and record a gap.
      **Never** call `reconcileScheduledProviderEvent` for a tagged row.
4. Gate tagged rows on a primary-market check mirroring the MLB filter at
   `packages/providers/src/sharp-api.ts:1193`, or keep only the highest
   market-count listing per resolved event. Without this, three listings
   alias to one event and write three competing price streams —
   `deduplicateProviderBookEvidence` only dedupes within a single item list,
   and `loadOdds` merging keys on `providerEventId`.

Duplicate-canonical risk is **zero, structurally**: step 5 makes the only
minting call unreachable for these rows. Alias binding also preserves the
canonical start time, so the board keeps the mls kickoff.

## Hazards

- Quota: an extra paginated odds league per tick, outside
  `productionOddsCollectionPolicies`. Budget it explicitly.
- Label drift between the two feeds silently drops a fixture. Emit a gap
  metric on step 5 so this is visible rather than quiet — the whole class of
  bug this product keeps hitting is a feed change that fails silently.
- Do **not** add leagues_cup ids to `expectedProviderEvents`:
  `production-odds-control-plane.ts:2082` resolves every omitted entry and
  throws `sharpapi-event-binding-unavailable` if unmapped.
- `findNearCanonicalCandidates` matches on exact normalized labels and is
  order-sensitive (`event-ingestion.ts:54`), so step 3 alone would drop
  "Charlotte" vs "Charlotte FC". Step 2's lenient matcher is what makes this
  work; verify the labels agree before relying on either.
