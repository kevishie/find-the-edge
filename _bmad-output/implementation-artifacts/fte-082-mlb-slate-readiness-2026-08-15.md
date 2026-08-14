# FTE-082 MLB Slate Readiness — 2026-08-15

Checked at `2026-08-14T13:41:10Z`. This is a pre-collection readiness record,
not game-state evidence and not an approval to begin FTE-083.

## Frozen external denominator candidate

- Source: MLB Stats API schedule for `sportId=1`, `date=2026-08-15`, hydrated
  with team identity.
- Source URL: `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-08-15&hydrate=team`
- Scheduled games: 15.
- Earliest scheduled start: `2026-08-15T17:10:00Z`.
- Latest scheduled start: `2026-08-16T01:40:00Z`.
- SHA-256 of the sorted, compact projection
  `{gamePk,gameDate,away,home,status}`:
  `e17f5c8102b7795c0faeb326af52ff6e6c32bebbe1dcf975df2a5ad27524bd24`.

This is the independent denominator candidate. It does not establish SharpAPI
identity, game-state correctness, or finality.

## Staging canonical coverage

The public staging board returned 13 scheduled MLB canonical events for the
same calendar day with a terminal cursor. The two official fixtures absent
from that canonical surface were:

- St. Louis Cardinals at Chicago Cubs (`2026-08-15T18:20:00Z`)
- Texas Rangers at Athletics (`2026-08-16T01:40:00Z`)

The final manifest is therefore not frozen. Guessing canonical ids, treating
provider-returned rows as the denominator, or silently shrinking the
denominator from 15 to 13 would invalidate the coverage experiment.

## Provider reconciliation state

The attempted staging secret read failed locally with `ExpiredToken` before a
provider request could be dispatched, so no SharpAPI quota was consumed. A
fresh AWS sign-in requires user-controlled credential entry and was not
automated. After credentials are refreshed, repeat the exact schedule read,
reconcile all 15 official fixtures to stored canonical ids and provider ids,
and only then initialize the truth header and start the bounded short probe.

## Gate

Collection may begin only when all of the following are true:

1. Staging contains an exact canonical mapping outcome for every one of the 15
   official fixtures, including an explicit unresolved outcome where a mapping
   genuinely does not exist.
2. The provider schedule comparison is complete without inferred ids.
3. The manifest records the exact official-source digest above (or a newer
   re-frozen digest if MLB changes the schedule).
4. The append-only truth header is initialized after the manifest freeze and
   before the first game-state request.
