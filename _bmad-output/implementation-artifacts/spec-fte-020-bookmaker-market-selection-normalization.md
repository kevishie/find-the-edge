---
title: 'Bookmaker, Market, and Selection Normalization'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'c3d0ce9347e5c493464e73733ddb4eef4303c751'
final_revision: '73931ba'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-4-context.md'
  - 'docs/adr/0003-consensus-and-qualification-defaults.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** SharpAPI sportsbook, market, and selection labels currently flow through loosely typed strings, unknown rows can be silently dropped, and equivalent aliases can create unstable identities or duplicate evidence. The current main-market parser also lacks canonical BTTS and team-total outcomes.

**Approach:** Establish one deterministic normalization boundary and authoritative registry for the approved sportsbooks and MVP markets, then make the SharpAPI adapter return either canonical evidence or a bounded, observable reason-coded rejection. SharpAPI is the sole production schedule and odds provider.

## Boundaries & Constraints

**Always:** Normalize before roster filtering or persistence; bind team selections to canonical participant identity rather than array position; preserve raw provider identifiers only as bounded audit metadata; distinguish two-way and three-way moneyline completeness; represent unknown bookmaker, unsupported market, unsupported selection, and incomplete market as explicit reason codes; emit bounded counts by provider and reason; keep Hard Rock as the target book and DraftKings, FanDuel, BetMGM, and Caesars as comparison books.

**Block If:** SharpAPI's documented or fixture-observed payload cannot uniquely identify a team-total participant or distinguish BTTS from another yes/no market; a proposed mapping would merge two distinct provider markets or bookmakers; entitled SharpAPI scopes required for a mapping cannot be verified without changing the paid subscription.

**Never:** Call, ingest from, or fall back to The Odds API in production; infer unsupported mappings from labels alone; allow unknown books into consensus; fabricate missing outcomes or percentages; persist credentials or raw paid payloads; implement snapshot history, consensus math, or UI presentation in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Approved book alias | SharpAPI book ID is a registered Hard Rock or comparison alias | Canonical sportsbook ID and role | No error expected |
| Unknown book | Unregistered SharpAPI book ID | No consensus evidence; provider-scoped unknown-bookmaker result | Count and bounded audit ID |
| Main markets | Two/three-way ML, spread, or event total with complete selections | Canonical market and stable participant/outcome selection keys | Reject incomplete groups explicitly |
| Extended markets | Verified BTTS or team-total rows | Canonical yes/no or participant over/under selections | Reject ambiguous participant binding |
| Unsupported row | Unknown market or selection type | Explicit unsupported-market or unsupported-selection result | Never silently continue |
| Participant reorder | Same event arrives with teams reversed or renamed | Stable canonical participant-bound selections | Reject if canonical binding is unavailable |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- canonical market, selection, sportsbook, and reason-code contracts.
- `packages/domain/src/fixture-odds.ts` -- normalized observation identities and explicit unsupported evidence states.
- `packages/config/src/feed-coverage.ts` -- approved target/comparison roster and collected market policy.
- `packages/config/src/sportsbooks.ts` -- authoritative sportsbook registry, aliases, roles, and display metadata.
- `packages/providers/src/sharp-api.ts` -- SharpAPI DTO isolation and discriminated normalization results.
- `apps/workers/src/sharp-api-ingestion.ts` -- completeness checks, canonical persistence inputs, and rejection aggregation.
- `apps/workers/src/production-odds-control-plane.ts` -- bounded normalization metrics and reason-coded evidence gaps.
- `apps/web/src/sportsbooks.tsx` -- consumes canonical display metadata rather than maintaining a second registry.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts`, `packages/domain/src/fixture-odds.ts` -- define canonical MVP market/selection identities and bounded normalization reason codes.
- [x] `packages/config/src/sportsbooks.ts`, `packages/config/src/feed-coverage.ts`, `apps/web/src/sportsbooks.tsx` -- create one alias-aware registry containing Hard Rock and every approved comparison book, and derive production/UI policy from it.
- [x] `packages/providers/src/sharp-api.ts` -- replace silent row drops with discriminated normalized or reason-coded results; cover two/three-way ML, spread, total, and only fixture/documentation-verified BTTS/team totals.
- [x] `apps/workers/src/sharp-api-ingestion.ts` -- normalize before filtering, bind selections to canonical participants, enforce market-specific completeness, and surface rejected rows without persisting them as prices.
- [x] `apps/workers/src/production-odds-control-plane.ts` -- persist explicit unsupported gaps where applicable and emit bounded provider/reason counts without raw payloads.
- [x] Provider/config/domain/worker fixture tests -- cover every matrix row, all aliases, incomplete markets, unknown books, unsupported rows, and participant reorder stability.

**Acceptance Criteria:**
- Given any approved SharpAPI bookmaker alias, when odds are normalized, then exactly one canonical book identity and configured target/comparison role are produced.
- Given moneyline, three-way moneyline, spread, total, BTTS, or team-total fixture evidence, when its provider identity is unambiguous, then deterministic canonical market and selection keys are produced.
- Given an unknown or unsupported row, when ingestion evaluates it, then it is never silently discarded or admitted to consensus and its bounded provider/reason count is observable.
- Given production ingestion configuration, when provider selection is inspected or executed, then SharpAPI is the only callable schedule and odds source and no The Odds API credential is required.

## Spec Change Log

## Review Triage Log

### 2026-08-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 11, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Updated database and web read contracts to consume participant-bound selections and canonical Hard Rock/Caesars book IDs.
  - `[high]` `[patch]` Preserved provider two-way versus three-way moneyline structure and enforced the matching completeness rule.
  - `[high]` `[patch]` Grouped team totals by participant and line, required their threshold, and attributed rejected rows to known books.
  - `[high]` `[patch]` Bound provider sides by canonical participant labels and converted reversed or ambiguous orientation into deterministic mapping or a reason-coded rejection.
  - `[high]` `[patch]` Enforced selection compatibility for every canonical market instead of misclassifying invalid combinations as incomplete.
  - `[high]` `[patch]` Persisted durable partial `incomplete-market` gaps for active one-sided markets.
  - `[high]` `[patch]` Aggregated page rejections through standalone ingestion and exposed bounded rejection counts.
  - `[high]` `[patch]` Prevented omitted or partial rosters from admitting unconfigured books, including Circa and consensus.
  - `[medium]` `[patch]` Canonically deduplicated UI sportsbook aliases.
  - `[medium]` `[patch]` Restored the typed SharpAPI provider configuration contract.

## Design Notes

Canonical selection identity combines the market outcome with canonical participant identity where a side belongs to a team. Display labels remain presentation metadata. Provider aliases are inputs to the registry, never stored as the canonical ID. Historical The Odds API implementation artifacts may remain for audit until separately deleted, but no runtime composition, deployment configuration, or operational instruction may invoke them.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- canonical contracts and participant identity pass.
- `pnpm --filter @find-the-edge/config test` -- aliases, roles, and coverage policy pass.
- `pnpm --filter @find-the-edge/providers test` -- SharpAPI mappings and explicit rejection fixtures pass.
- `pnpm --filter @find-the-edge/workers test` -- completeness, metrics, and persistence boundary pass.
- `pnpm check` -- full repository validation passes.
- `rg -n 'fetchTheOddsApi|ODDS_API_KEY' apps packages/infrastructure docs/phase1-deployment.md` -- no callable production path, deployed requirement, or current runbook dependency remains.

## Auto Run Result

Implemented deterministic SharpAPI bookmaker, market, and participant-bound selection normalization for the MVP market set. Added an authoritative sportsbook registry shared by policy and UI, explicit reason-coded rejections and durable gaps, normalization metrics, and complete fixture coverage. Removed The Odds API from production worker composition, runtime configuration, deployment configuration, and current operational documentation; SharpAPI is the sole callable production schedule and odds source.

Key files changed: domain normalization contracts; config sportsbook registry and coverage policy; SharpAPI provider parsing; worker ingestion/control-plane logic; database and web read compatibility; deployment/local-development documentation; focused tests across domain, config, provider, worker, database, and web packages.

Review findings: 14 patches applied, 0 deferred, 0 rejected. Follow-up review is recommended because the fixes crossed provider parsing, persistence identity, read compatibility, and durable evidence behavior.

Verification: `pnpm check` passed after all review fixes; workers passed 139 tests; `git diff --check` passed; production references to `fetchTheOddsApi` and `ODDS_API_KEY` were removed from active paths.

Residual risk: BTTS and team-total ingestion remains limited to SharpAPI payload shapes that can be identified unambiguously from entitled, documented fields. Unknown or ambiguous shapes are deliberately rejected and measured rather than guessed.
