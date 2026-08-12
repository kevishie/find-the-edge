# Leagues Cup odds: resolve onto existing events, never mint new ones

Status: IMPLEMENTED AND DEPLOYED (227f333), BUT NOT WORKING IN PRODUCTION.
Soccer is still 0 priced. Written 2026-08-12.

## Where it stands

The design below shipped: secondary catalogue on the MLS league, page chain
continues into it, resolve-or-skip alias binding, gap metric. All unit tests
pass, including one asserting the bootstrap path throws if ever reached.

But on staging **neither `OddsSecondaryObservation` nor
`OddsSecondaryUnresolved` has a single datapoint**, which means the secondary
pass never runs — the fetch never produces a secondary page at all. The
resolution logic is therefore untested against real data.

Next diagnostic, in order:
1. Confirm `sharpLeague.secondaryOddsProviderLeagues` is actually populated at
   the `fetchPage` closure in `production-odds-control-plane.ts` — the
   `sharpLeague` in that scope may be a different object than the one edited
   in `packages/providers/src/sharp-api.ts`.
2. Check whether the MLS primary chain ever reaches exhaustion. The hand-off
   to the secondary only fires when `page.hasMore` is false; if the run ends
   on a page limit, a cadence boundary, or an expired cursor (which returns
   `hasMore: false` with zero events — see the OddsCursorExpired branch), the
   chain may terminate before the hand-off or hand off from a synthesised
   empty page.
3. Verify the run's sealed page chain on staging: walk `ODDS_CONTROL#PAGE#`
   rows for the current MLS runId and look for a `secondary:leagues_cup:*`
   token. That answers 1 and 2 outright.

Do not assume the resolver works until a secondary page is observed. The
alias matcher is only covered by unit fixtures, and the live label pairing
between the two catalogues has never been exercised.

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
