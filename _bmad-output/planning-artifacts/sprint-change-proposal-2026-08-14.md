---
title: "Sprint Change Proposal: Universal SharpAPI Ingestion and Data-Quality Gate"
created: "2026-08-14"
status: approved
approvedBy: Kevishie
supersedes: "all roadmap sequencing until the data-quality exit gate passes"
---

# Sprint Change Proposal: Universal SharpAPI Ingestion and Data-Quality Gate

## Decision

Pause feature delivery and make provider coverage, freshness, and market completeness the release gate. SharpAPI's current catalog—not a repository allowlist or UI module—is the collection boundary. Every sport, league, event, and unfiltered odds row exposed by the entitled account must enter a durable generic landing layer. Product normalization and UI support may follow independently; unsupported shapes are classified and retained, never silently discarded.

## Evidence

- The entitled SharpAPI catalog currently reports 31 sports and 1,692 leagues; production collection is hardcoded to six leagues and the public API accepts only MLB and soccer sport keys.
- Staging MLB data is roughly 34 hours stale, two games from the official 2026-08-14 slate are absent, and spread/total cells are empty even though SharpAPI currently returns run-line and total-run rows.
- NFL ingestion repeatedly fails on participant mapping, MLS frequently enters provider recovery, and the scheduled-board freshness alarm has remained in ALARM since 2026-08-13.
- Existing coverage alarms accept severe partial coverage because they alarm only when priced coverage reaches zero.
- A provider-wide unfiltered odds sweep is materially larger than the existing six-league loop and must be resumable rather than restarted from page one.

## Root Cause

Collection eligibility, sport-module maturity, normalization, and serving were collapsed into one allowlist. This makes a parser or UI gap equivalent to not collecting the source data at all. The worker also performs league-specific recovery, so one malformed row or stale continuation can strand an entire league while coarse health metrics still report partial success.

## Approved Recovery Epic

1. **FTE-DQ-001 — Universal SharpAPI Catalog and Landing:** discover `/sports` and `/leagues`; continuously checkpoint provider-wide `/events` and unfiltered `/odds` with no sport, league, market, or live-state restriction; retain generic current records and bounded quarantine evidence for every row.
2. **FTE-DQ-002 — Restore Served-Sport Completeness:** repair MLB/NFL/MLS identity and market normalization, eliminate stale continuations, and populate moneyline/spread/total from the universal landing records.
3. **FTE-DQ-003 — Generic Normalization and Quarantine:** promote supported event/market shapes without capture allowlists; surface unsupported sport/market reasons and counts.
4. **FTE-DQ-004 — Reconciliation and Release Gate:** compare provider catalog/schedule/odds denominators with landed and served records; alarm on any unexplained loss, stale sweep, or core-market regression.
5. **FTE-DQ-005 — Staging Soak and Production Cutover:** prove complete repeated sweeps, exact flagship slate coverage, fresh core markets, and zero unexplained quarantines before resuming roadmap work.

## Non-Negotiable Invariants

- No hand-maintained sport or league allowlist at the provider collection boundary.
- New provider catalog entries are ingested automatically; they do not wait for a deploy.
- A sport module, strategy, or UI route may govern promotion and display only, never source capture.
- Provider pages use durable cursor/offset checkpoints, bounded work per invocation, idempotent writes, and explicit sweep completion.
- Raw paid responses and credentials are not logged or archived without written licensing approval. The landing schema retains bounded source fields required to reconstruct identity, lifecycle, market, selection, price, and provenance; unknown shapes receive hashes, safe identifiers, field inventories, and reason codes.
- No feature story resumes while the release gate is red.

## Exit Gate

The recovery epic remains open until staging proves all of the following over a continuous 24-hour window:

- 100% of SharpAPI sports and leagues appear in the catalog landing snapshot.
- Every provider-wide event and unfiltered odds sweep reaches a terminal checkpoint with no lost or cyclic page.
- Landed row counts reconcile exactly to provider page totals, with every rejected row represented by a bounded quarantine record.
- MLB, NFL, and MLS scheduled-event denominators reconcile with their independent reference schedules; no unexplained missing game remains.
- Moneyline, spread/run-line, and total coverage is fresh wherever SharpAPI offers those markets; missing markets carry an explicit provider-absence or normalization reason.
- Freshness, completeness, quarantine, and sweep-failure alarms are all OK, and the hosted smoke asserts usable data rather than HTTP success alone.

Only after this gate passes may FTE-074, FTE-075, FTE-082, or later feature work resume.
