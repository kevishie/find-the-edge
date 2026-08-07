---
title: 'FTE-039: Soccer Enrichment Provider Evaluation'
type: 'chore'
created: '2026-08-07'
status: 'done'
baseline_revision: 'd24f7f962c319dcf1860abd761a03bafa5767928'
final_revision: '332c0b3aa3d56a2220b727e8bd5723990970ed65'
review_loop_iteration: 3
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/epic-7-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-019-initial-soccer-competitions-allowlist.md'
  - '_bmad-output/planning-artifacts/architecture.md'
warnings:
  - multiple-goals
---

<intent-contract>

## Intent

**Problem:** Production scouting cannot consume fixtures, venues, lineups, injuries, suspensions, or soccer statistics until a provider is chosen with evidence about coverage, freshness, cost, rights, provenance, and integration risk.

**Approach:** Compare viable providers using current first-party documentation and public terms, select a staged primary/fallback strategy for the four approved MVP competitions, and record explicit procurement and live-validation gates in a proposed ADR that becomes accepted only after formal review, without implementing or purchasing an adapter.

## Boundaries & Constraints

**Always:** Evaluate at least Sportmonks, Sportradar Soccer, Stats Perform/Opta, and API-Football against MLS, EPL, Liga MX, and UEFA Champions League. Separate proven public facts, vendor claims, and unverified contractual requirements. Cover fixtures, venues, rosters, confirmed-versus-predicted lineups, injuries, suspensions, team/player/match statistics, correction semantics, freshness, history, stable IDs, quotas, pricing, support, licensing, data storage, derived outputs, AI-assisted synthesis, attribution, and termination. Preserve SharpAPI as the independent schedule/odds source and require an auditable cross-provider identity mapping. Treat the recommendation as architecture approval, not authority to purchase, publish restricted data, or enable production enrichment.

**Block If:** No candidate can support all four approved competitions through a provider-neutral adapter; public evidence cannot distinguish a safe staged recommendation from a prohibited use; or accepting the ADR would require agreeing to non-public commercial terms.

**Never:** Commit credentials, paid response payloads, confidential quotes, restricted contract text, provider DTOs, or logos/headshots; claim coverage, freshness, accuracy, official status, rights, SLA, profitability, or AI permission without direct evidence; select on price alone; use API-Football as a production default while its terms disclaim publication rights; or implement a production adapter in this spike.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Complete candidate | Public docs and terms prove core capability and viable use | Score evidence and retain candidate | Mark contract-only fields as procurement gates |
| Marketing-only claim | Product page lacks endpoint, terms, or coverage detail | Keep claim visibly unverified | Do not convert it into an ADR invariant |
| Variable league depth | Provider covers a league but individual fields vary | Require per-league/season capability discovery and unavailable states | Trial must measure completeness; adapter fails closed |
| Rights ambiguity | Storage, betting support, or AI use is unclear | Permit only fixture-backed development and procurement review | Production flag remains off |
| Provider replacement | Primary misses quality or rights gates | Preserve canonical IDs and activate documented fallback evaluation | No raw DTO or provider ID becomes domain authority |

</intent-contract>

## Code Map

- `_bmad-output/planning-artifacts/research/technical-soccer-enrichment-provider-evaluation-research-2026-08-07.md` -- primary-source comparison, evidence table, limitations, trial plan, and review checklist.
- `docs/adr/0004-soccer-enrichment-provider.md` -- proposed staged provider decision during review; acceptance is recorded only in the completion pass.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` -- story state and next-ready-story routing.
- `packages/providers/src/index.ts` -- existing capability-port boundary the ADR must preserve; no implementation change in this spike.
- `_bmad-output/planning-artifacts/architecture.md` -- authoritative normalized provenance and provider-mapping constraints.

## Tasks & Acceptance

**Execution:**
- [x] `_bmad-output/planning-artifacts/research/technical-soccer-enrichment-provider-evaluation-research-2026-08-07.md` -- replace the starter with a dated, source-linked comparison covering the complete story scorecard and explicit unknowns.
- [x] `docs/adr/0004-soccer-enrichment-provider.md` -- recommend a primary, premium fallback, rejected alternatives, trial thresholds, procurement gates, provider-neutral integration rules, and backfill/exit consequences.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- keep FTE-039 in progress through review; the completion pass will mark it done and route FTE-040 only after standing human approval is recorded.
- [x] Review every cited claim, checklist item, and ADR invariant for evidence strength, licensing overstatement, secret leakage, and compatibility with SharpAPI/canonical identity.

**Acceptance Criteria:**
- Given the provider candidates and four approved competitions, when the research is reviewed, then each required capability, freshness mode, limit, public price or quote-only state, history, provenance feature, integration cost, and material rights constraint is evidenced or explicitly unknown.
- Given the evidence matrix, when the ADR is accepted, then it names Sportmonks as a provisional technical primary, Sportradar as the premium fallback, and keeps production disabled until betting-support, persistent-audit, derived-output, and AI-synthesis rights plus field-level trial evidence are confirmed.
- Given future FTE-040 work, when it consumes this decision, then provider DTOs and IDs remain isolated, every normalized fact can carry source/timestamps/verification/freshness/confidence, missing data stays unavailable, and SharpAPI remains authoritative for odds rather than silently merging schedules.
- Given standing approval to continue and merge BMad stories, when FTE-039 completes, then the ADR records that architecture approval while explicitly reserving subscription purchase and non-public contract acceptance for a separate decision.

## Spec Change Log

- 2026-08-07: Created provider-evaluation spike, completed three formal review passes, and accepted the staged Sportmonks-trial/Sportradar-fallback architecture with production disabled.

## Review Triage Log

### Review pass 1

- Raw findings: 33 across independent blind and edge-case reviews; 27 unique after deduplication (10 high, 14 medium, 3 low).
- Patched: 25. Added a reproducible weighted decision policy, evidence labels and retrieval limits, integration-cost basis, target-entitlement cautions, premium/support unknowns, frozen denominators/manifests, minimum samples, a 90-day cap, lineup/roster/injury/reliability/correction gates, revision-aware ordering, conflict resolution, reproducible evidence rules, privacy and terms-change gates, and fail-closed termination/deletion behavior.
- Rejected: 2. The block condition does not require every field to exist in every competition because the provider-neutral contract explicitly models unavailable capabilities and the trial proves field depth; the checked evidence-review task records the author's evidence pass and does not claim that formal adversarial review was already complete.
- Deferred: 0.
- Follow-up review: required after material architecture and trial-contract patches.

### Review pass 2

- Raw and unique findings: 13 (5 high, 8 medium).
- Patched: 13. Separated public-discovery, authorized-trial, and production gates; anchored the score; froze mandatory capabilities and event-state applicability; required reproducible source evidence; defined freshness timing and injury adjudication; expanded privacy, account/property, contract-monitoring, termination-order, physical-deletion, and artifact-lifecycle rules.
- Rejected or deferred: 0.
- Follow-up review: required for convergence after the second material patch set.

### Review pass 3

- Raw and unique findings: 4 (1 high, 3 medium).
- Patched: 4. Made predicted-lineup failure globally blocking, aligned the per-competition sample on applicable matches, made prospective injury selection deterministic, and added minimum correction samples.
- Rejected or deferred: 0.
- Follow-up review: not recommended; no unresolved high or medium finding remains.

## Design Notes

The staged decision prevents a false binary between a cheap self-service API and an enterprise contract. Sportmonks can validate the normalized contract quickly across the four-league MVP, while explicit quality and rights gates preserve a clean move to Sportradar if coverage, latency, provenance, or commercial terms fail. Stats Perform remains an analytics-depth option rather than the default because public materials do not prove the complete pre-match availability feed or required archival/AI rights.

## Verification

**Commands:**
- `pnpm exec prettier --check _bmad-output/planning-artifacts/research/technical-soccer-enrichment-provider-evaluation-research-2026-08-07.md docs/adr/0004-soccer-enrichment-provider.md _bmad-output/implementation-artifacts/spec-fte-039-soccer-enrichment-provider-evaluation.md _bmad-output/implementation-artifacts/sprint-status.yaml` -- all artifacts follow repository formatting.
- `git diff --check` followed by `git diff --cached --check` after staging -- tracked and newly added artifacts have clean patch hygiene.

**Manual checks:**
- Every scorecard row and decisive claim links to a current official provider page or is labeled unknown; all research checklist items are answered.
- The ADR contains no credentials, provider payloads, confidential commercial terms, unsupported legal conclusions, or production-adapter implementation.

## Auto Run Result

### Summary

Completed the four-provider soccer-enrichment evaluation and accepted a staged architecture: Sportmonks is the provisional non-production trial candidate, Sportradar is the premium fallback evaluation path, Stats Perform/Opta remains an analytics-depth option, and API-Football is rejected for production. SharpAPI remains the sole schedule and odds authority, and production enrichment remains disabled.

### Review Findings

- Three review passes processed 44 unique findings: 42 patched, 2 rejected, 0 deferred.
- The final pass found no unresolved high or medium issue after aligning mandatory capabilities, reproducible samples, correction counts, privacy/licensing controls, and provider-exit behavior.
- Follow-up review recommendation: false.

### Verification

Prettier, tracked and staged patch hygiene, evidence/secret scans, source-link review, and accepted-ADR consistency checks passed. No runtime code or production infrastructure changed in this spike.

### Residual Risk

No subscription, credential, adapter, trial, or production activation has been authorized. Exact four-competition entitlements, premium expected-lineup access, reproducible source retention, betting-support rights, privacy basis, support/SLA, price, and field-level quality must still be proven through written terms and the bounded field trial before production.
