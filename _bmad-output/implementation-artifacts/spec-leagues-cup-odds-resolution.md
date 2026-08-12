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
