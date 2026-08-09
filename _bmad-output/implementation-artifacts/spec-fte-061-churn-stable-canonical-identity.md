---
title: 'Churn-Stable Canonical Event Identity'
type: 'feature'
created: '2026-08-08'
status: 'in-progress'
---

<intent-contract>

## Intent

**Problem:** SharpAPI rotates provider event ids (`_b0` → `_b3`, sometimes the
base too). Schedule reconciliation bootstraps each new id as a NEW canonical
event, so the old record is orphaned (stale metadata, stuck "Scheduled",
frozen odds) while the new record starts empty (no line history). Boards show
the same real-world game twice and charts lose their past on every rotation.

**Approach:** The real-world identity of a game is its participant pair plus
its start instant — the withdrawn-listing filter already proves this
technique. Before bootstrapping a canonical event for an unknown provider id,
reconciliation must look for an existing canonical event in the same league
with the same participants (club keys where available, nickname-anchored
labels otherwise) and a start within tolerance (±15 min). On a match, the new
provider id becomes a revision/alias of the existing canonical event — same
canonical id, version advanced — so odds, history, and boards continue on one
record. Only a genuine no-match bootstraps a new event.

## Boundaries & Constraints

**Always:** Keep canonical ids stable once assigned; alias churned provider
ids onto the existing canonical event; preserve immutable history; treat
same-day doubleheaders as distinct (start instants differ beyond tolerance);
respect the existing identity-claim machinery (aliases claim identities the
same way bootstraps do).

**Block If:** Two existing canonical events already match the same
participants+start (ambiguity — keep current behavior, log, do not merge).

**Never:** Merge distinct real-world games; mutate history rows; rewrite old
canonical ids retroactively (the staging feed reset owns cleanup of existing
orphans).

</intent-contract>

## Code Map (planned)

- `packages/database/src/dynamodb-event-ingestion.ts` — bootstrap path gains
  a participants+start lookup before inserting; on match, record the new
  provider revision on the existing event instead.
- `apps/workers/src/schedule-reconciliation.ts` — surface the alias decision.
- `packages/database/src/board-projection.ts` — duplicates disappear as a
  consequence; withdrawn-listing filter unchanged.
- Cleanup: after deploy, run the gated `reset-phase1-feed.yml` workflow so
  staging re-ingests cleanly (existing orphans are not retro-merged).

## Discovery (2026-08-08, pre-implementation)

Identity claims already key on participants+start via
`normalizedUpcomingEventIdentity` (packages/providers/src/upcoming-events.ts:65)
— NOT on the provider id. The churn leak is narrower than assumed:

1. `startsAt` enters the identity string at exact millisecond precision, so
   any provider start adjustment (rain delays, schedule corrections — both
   observed) mints a fresh identity → new canonical event.
2. Labels enter raw unless `participantIdentityKeys` (club keys) are passed;
   observed drift like `mlb_athletics_redsox` vs `mlb_as_redsox` splits
   identity for non-club-key paths.

Fix shape: when the exact identity claim is missing, before bootstrapping,
search same-league canonical events for the same participant keys with a
start within ±15 min (the day-indexed projections support this); on a unique
match, register the new identity string as an additional claim ALIASING the
existing canonical event and advance its revision instead of bootstrapping.
Ambiguity (two matches) keeps current behavior. Doubleheaders stay distinct
because their starts differ by hours.

Entry point: `resolveIdentity` / bootstrap call sites in
packages/database/src/dynamodb-event-ingestion.ts (~line 1430 bootstrap
transaction, ~595 resolveIdentity); reconciliation feeds it from
apps/workers/src/schedule-reconciliation.ts:70.
