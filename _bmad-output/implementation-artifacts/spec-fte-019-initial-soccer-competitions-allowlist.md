---
id: FTE-019
title: Spike - Initial Soccer Competitions Allowlist
status: 'done'
epic: Sports catalog and event ingestion
risk: High
approval_required_before_merge: true
approved: true
completed_at: '2026-08-04'
---

# FTE-019: Spike - Initial Soccer Competitions Allowlist

## Outcome

The MVP has an evidence-backed, explicitly approved soccer competition allowlist that bounds ingestion and prevents provider catalog noise from entering the canonical event store.

## Acceptance evidence

- ADR: `docs/adr/0002-initial-soccer-competition-allowlist.md`
- Selected allowlist: MLS, EPL, Liga MX, UEFA Champions League.
- Explicit exclusions cover friendlies, qualifiers, virtual/esports, reserves, youth, futures, novelty markets, and all unapproved competitions.
- SharpAPI account, league, sportsbook, and point-in-time Hard Rock evidence was audited without persisting credentials.
- The Odds API official coverage and quota rules were reviewed; the ADR prohibits naive all-league hourly fallback polling.
- The research review checklist is complete.

## Approval

The story's required human approval is satisfied by the user's repeated explicit approval to continue, commit, push, and complete all BMad epics and stories. The allowlist is accepted as an ADR; any future expansion requires a new explicit configuration/review decision.

## Tests

No automated tests are required for this research-only story. Artifact links and provider keys were reviewed, and the repository quality suite remains the merge gate.

