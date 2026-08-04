---
title: 'FTE-032 Consensus and Qualification Defaults'
type: 'feature'
created: '2026-08-04'
status: 'done'
baseline_revision: 'cdd39c6cb998eb640f3fcccff047d0c6c2d5256a'
final_revision: 'bde385f'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Consensus and qualification defaults are contradictory, incomplete, and partly incompatible with the active SharpAPI Pro entitlement. The MVP cannot produce trustworthy qualification while its target book, comparison set, minimum book count, outlier rule, Kelly fraction, CLV benchmark, disagreement thresholds, and retention policy are unresolved or scattered.

**Approach:** Record one accepted, versioned ADR of conservative initial hypotheses, align the shared configuration contract and production collection roster with it, and make unsupported or insufficient markets fail closed with explicit reasons.

## Boundaries & Constraints

**Always:** Use Hard Rock Bet (`hardrock`) as the MVP offered sportsbook and exclude it from its own consensus. Use only active, entitled, independently configured comparison books; normalize each complete book market to no-vig probabilities before weighting. Keep every value configurable and versioned. Label numerical thresholds as provisional hypotheses for walk-forward evaluation. Preserve immutable odds snapshots without TTL until a later evidence-backed retention amendment. Keep Kelly informational and keep unavailable CLV/disagreement states explicit.

**Block If:** The SharpAPI account's selected Pro books cannot cover Hard Rock plus at least three approved comparison books, or a proposed change would delete historical snapshots, claim a threshold is empirically optimal without project evidence, or require a Sharp-tier-only odds book.

**Never:** Depend on Circa or Pinnacle odds under the Pro plan; confuse the separately entitled DraftKings/Circa splits feed with sportsbook odds entitlement; include Hard Rock in consensus for a Hard Rock offer; silently reduce minimum-book quality gates to fit missing data; implement a settings UI, wager placement, or autonomous bankroll sizing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Entitled consensus | Hard Rock offer plus three fresh configured Pro comparison books | Weighted no-vig consensus uses comparisons only | No error expected |
| Target appears in inputs | Hard Rock is also present among market books | Hard Rock is excluded unconditionally | Record offered-sportsbook exclusion |
| Sparse or unavailable roster | Fewer than three eligible comparison books remain | Qualification fails closed | Explicit insufficient-books reason |
| Divergent book | Any outcome differs from the per-outcome median beyond the configured outlier threshold | Exclude entire book and retain reason | Continue only if minimum books remain |
| Missing close | Closing comparison consensus cannot be formed | CLV is unavailable | Preserve a bounded reason, never substitute target close |

</intent-contract>

## Code Map

- `docs/adr/0003-consensus-and-qualification-defaults.md` -- accepted decision, rationale, risks, evidence, and review checklist.
- `packages/config/src/evaluation-policy.ts` -- authoritative versioned default contract and validation.
- `packages/config/src/evaluation-policy.test.ts` -- invalid policy and target-exclusion contract tests.
- `packages/config/src/feed-coverage.ts` -- SharpAPI Pro production collection roster.
- `packages/config/src/feed-coverage.test.ts` -- entitlement-safe roster and minimum coverage assertions.
- `_bmad-output/planning-artifacts/architecture.md` -- resolve the defaults and retention open decisions by ADR reference.
- `_bmad-output/planning-artifacts/prd.md` -- mark OD-003/007/008/009/010 resolved by ADR while retaining configurability.
- `docs/runbooks/sharpapi.md` -- SharpAPI-only production and Pro-versus-Sharp entitlement truth.

## Tasks & Acceptance

**Execution:**
- [x] `docs/adr/0003-consensus-and-qualification-defaults.md` -- define the complete default table, rationale, risks, evidence limitations, and approval checklist.
- [x] `packages/config/src/evaluation-policy.ts` -- encode one immutable v2 policy with Hard Rock target; three or more Pro-entitled comparison books; configurable weights, thresholds, Kelly fraction, CLV benchmark, disagreement boundaries, and retention values.
- [x] `packages/config/src/evaluation-policy.test.ts` -- verify the happy path and reject target inclusion, inadequate roster, invalid weights, and invalid threshold relationships.
- [x] `packages/config/src/feed-coverage.ts` -- collect Hard Rock as offered and the policy's entitled comparison roster for MLB and MLS without Circa/Pinnacle odds.
- [x] `packages/config/src/feed-coverage.test.ts` -- prove production coverage satisfies policy and remains SharpAPI-only.
- [x] Planning docs and `docs/runbooks/sharpapi.md` -- replace stale/open statements with the accepted SharpAPI Pro decision and ADR reference.

**Acceptance Criteria:**
- Given any Hard Rock candidate, when consensus is configured, then Hard Rock is explicit as offered and absent from comparison weights.
- Given the active Pro tier, when the production roster is inspected, then every odds book is Pro-entitled and at least three independent comparison books are collected.
- Given the ADR, when every FTE-032 field is reviewed, then each has a value, rationale, risk, configuration key, and revision trigger.
- Given missing or divergent inputs, when qualification runs later, then policy requires fail-closed outcomes rather than threshold weakening or fabricated consensus.
- Given current snapshot storage, when this story ships, then no destructive TTL or deletion policy is introduced.

## Spec Change Log

## Review Triage Log

### 2026-08-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 4, medium 2, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Qualification checked only the candidate outcome for outliers; it now excludes a book when any no-vig outcome exceeds the configured median-deviation boundary.
  - `[high]` `[patch]` Disagreement thresholds were declared but unenforced and absent from stored provenance; qualification now warns or blocks at the configured boundaries and persists thresholds plus observed disagreement.
  - `[high]` `[patch]` Related SharpAPI sub-league rows were excluded after schedule-shape validation; league filtering now happens immediately after bounded identity validation and covers heterogeneous catalogue rows.
  - `[high]` `[patch]` Case-variant sportsbook identifiers could bypass target exclusion; policy validation now requires canonical lowercase identifiers and rejects normalized duplicates.
  - `[medium]` `[patch]` Missing nested policy objects leaked raw type errors; validation now emits bounded roster or threshold errors with malformed-shape coverage.
  - `[medium]` `[patch]` The SharpAPI-only runbook still promised a retired Odds API failover; it now states ingestion is unavailable until recovery or an approved fallback deployment.

## Design Notes

Initial comparison weights are equal because the Pro roster contains no Sharp-tier odds book and the project has no calibration evidence supporting unequal weights. DraftKings, FanDuel, BetMGM, and Caesars provide breadth; Hard Rock is the offered book. Minimum books is three. Initial maximum age is 15 minutes; minimum EV remains sport-configured (MLB 2%, soccer 2.5%); outliers use an 8 percentage-point any-outcome deviation; disagreement warns at 5 points and blocks at 10; fractional Kelly is 0.25 informational; CLV uses closing no-vig comparison consensus excluding Hard Rock; snapshots have no TTL. Every threshold is provisional and versioned.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/config test` -- policy and roster contracts pass.
- `pnpm check` -- repository formatting, boundaries, types, tests, and builds pass.
- `pnpm phase1:preflight` -- SharpAPI-only infrastructure remains valid and non-destructive.
- `git diff --check` -- no whitespace defects.

**Implementation validation (2026-08-04):**

- `pnpm --filter @find-the-edge/config test` -- 8 files and 33 tests passed.
- Worker policy-fixture regression -- 21 files and 141 tests passed.
- `pnpm check` -- formatting, lint, boundaries, types, repository tests, and builds passed.
- `pnpm phase1:preflight` -- credential-free CDK synthesis and the non-destructive phase-one validator passed.
- `git diff --check` -- passed.

## Auto Run Result

Status: done

### Summary

Established one accepted, versioned MVP consensus and qualification policy for the active SharpAPI Pro account. Hard Rock is the offered sportsbook; DraftKings, FanDuel, BetMGM, and Caesars are equal-weight comparisons; sparse markets fail closed. The policy now carries and enforces freshness, minimum-book, any-outcome outlier, disagreement, informational Kelly, independent closing-consensus CLV, and non-destructive snapshot-retention defaults. The production collection roster derives from that policy. A deployment-discovered SharpAPI schedule defect was also corrected by excluding related sub-league catalogue rows before game-shape validation.

### Files changed

- `docs/adr/0003-consensus-and-qualification-defaults.md` -- accepted defaults, rationale, risks, evidence limits, and revision triggers.
- `packages/config/src/evaluation-policy.ts` and tests -- immutable v2 policy plus bounded, canonical validation.
- `packages/config/src/feed-coverage.ts` and tests -- SharpAPI-only Pro roster derived from policy.
- `packages/odds/src/qualification.ts` and tests -- any-outcome outlier filtering and disagreement warning/block enforcement.
- `packages/domain/src/paper-evaluation.ts` and `apps/workers/src/pick-evaluation.ts` -- persist thresholds and observed disagreement for auditability.
- `packages/providers/src/sharp-api.ts` and tests -- tolerate out-of-scope related catalogue rows returned by an exact schedule filter.
- Planning artifacts and `docs/runbooks/sharpapi.md` -- resolve open decisions and remove retired-provider guidance.
- Worker policy fixtures -- align deterministic examples with Hard Rock and the Pro comparison roster.

### Review findings

- Patches applied: 6 (4 high, 2 medium).
- Items deferred: 0.
- Items rejected: 0.
- Follow-up review recommended: true because review-driven changes affect qualification behavior, persisted audit provenance, provider parsing, and production recovery guidance.

### Verification

- Focused config, provider, odds, domain, and worker suites passed.
- `pnpm check` passed across formatting, lint, boundaries, types, tests, and builds.
- `pnpm phase1:preflight` passed credential-free infrastructure synthesis and launch validation.
- `git diff --check` passed.
- Live account canaries returned successful odds data for Hard Rock and all four comparison books without exposing credentials.

### Residual risks

- Numerical thresholds remain provisional until walk-forward evidence supports revision.
- Event-level sportsbook coverage can still be sparse; the three-book gate intentionally fails closed.
- The production deployment must be rerun to prove the heterogeneous schedule-page fix against the live SharpAPI catalogue.
