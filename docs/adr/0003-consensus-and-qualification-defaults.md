# ADR 0003: Consensus and Qualification Defaults

- Status: Accepted
- Date: 2026-08-04
- Story: FTE-032
- Decision owner: Kevishie
- Policy version: `2.0.0-provisional`

## Context

The MVP needs one reproducible policy for evaluating a Hard Rock Bet offer against an independent market. Previous defaults conflicted: DraftKings was configured as the target in one place, production collected only Circa as a comparison, minimum-book requirements varied between two and three, and outlier thresholds varied between eight and twelve percentage points. Disagreement, informational Kelly, CLV, and immutable-snapshot retention had no accepted defaults.

The active SharpAPI account was verified as Pro with up to 15 selected books. Live requests returned HTTP 200 with odds data for Hard Rock, DraftKings, FanDuel, BetMGM, and Caesars. Circa and Pinnacle odds require the Sharp tier and therefore cannot be production dependencies. The separately entitled DraftKings/Circa splits feed does not change sportsbook-odds entitlement.

All numerical thresholds below are conservative initial hypotheses. They are not claimed to be optimal and must be evaluated through versioned walk-forward evidence. Changes create a new policy version and affect future evaluations only; historical records retain their original policy and calculation versions.

## Decision

| Field                    | Initial value                                                                                          | Configuration key                                                       | Rationale                                                                                                                         | Risk and revision trigger                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Offered sportsbook       | Hard Rock Bet (`hardrock`)                                                                             | `targetSportsbookId`                                                    | This is the MVP price being evaluated. It is excluded unconditionally from its own consensus.                                     | Provider identifiers or user target changes require a new policy version.                                                         |
| Comparison books         | DraftKings, FanDuel, BetMGM, Caesars                                                                   | `comparisonWeights` keys                                                | All four returned entitled odds data on Pro and provide one spare book above the three-book gate.                                 | Coverage can vary by event. Reassess after measured coverage or entitlement changes; never substitute a Sharp-only book silently. |
| Book weights             | `1.0` each                                                                                             | `comparisonWeights[book]`                                               | No project calibration evidence supports unequal weights among the Pro roster.                                                    | Walk-forward calibration may justify new versioned weights. Do not infer quality from brand labels.                               |
| Minimum EV               | MLB `0.02`; soccer `0.025`                                                                             | sport strategy `minimumEv`; policy fallback `minimumExpectedValue=0.02` | Preserves the existing sport-specific hypotheses and avoids a silent global override.                                             | Revisit only after sufficient out-of-sample evidence; price-dependent break-even remains authoritative.                           |
| Maximum odds age         | 15 minutes                                                                                             | `maximumPriceAgeMinutes`                                                | Matches existing collection and evaluation behavior while preventing old prices from qualifying.                                  | Shorten if line velocity produces stale decisions; lengthen only with measured provider cadence evidence.                         |
| Minimum comparison books | 3                                                                                                      | `minimumComparisonBooks`                                                | A market remains independently corroborated after one of four configured books is unavailable.                                    | Fewer than three must fail closed; do not weaken this gate to fit temporary coverage.                                             |
| Outlier policy           | Exclude an entire book when any no-vig outcome differs from the per-outcome median by more than `0.08` | `outlierPolicy`, `outlierThreshold`                                     | One coherent rule protects both two-way and three-way vectors and matches the stricter existing consensus implementation.         | Small rosters can make medians unstable. Preserve exclusion reasons and require three books after exclusion.                      |
| Market disagreement      | Warn at `0.05`; block at `0.10` maximum probability-point range                                        | `disagreementWarningThreshold`, `disagreementBlockThreshold`            | Separates caution from a fail-closed market-quality boundary without claiming a cause.                                            | Provisional until FTE-030 golden fixtures and walk-forward evidence validate calibration.                                         |
| Fractional Kelly         | `0.25`                                                                                                 | `fractionalKelly`                                                       | Quarter Kelly is a conservative informational display default.                                                                    | It is never autonomous sizing or bet-placement authority; revise only through a new policy version.                               |
| CLV benchmark            | Closing no-vig comparison consensus excluding Hard Rock                                                | `clvBenchmark=closing-comparison-consensus`                             | Measures the placed target price against an independent closing market.                                                           | If three eligible closing books are unavailable, CLV is unavailable with a reason; never substitute the Hard Rock close.          |
| Snapshot retention       | Indefinite MVP retention; no snapshot TTL                                                              | `snapshotRetention.mode=indefinite-no-ttl`, `ttlDays=null`              | Immutable evidence is required for audit, CLV, and algorithm reproduction, and current scale does not justify destructive expiry. | Revisit at a documented storage-cost threshold; archival/deletion requires a new ADR and verified recovery path.                  |

Additional qualification thresholds already carried by the policy—maximum uncertainty `0.10`, minimum model-versus-consensus edge `0.015`, and conservative probability `interval-low`—remain provisional and versioned. They do not replace the independent minimum-EV, freshness, book-count, outlier, or disagreement gates.

## Required behavior

- Normalize every complete comparison-book market to no-vig probabilities before weighting.
- Exclude Hard Rock even if it appears in supplied comparison inputs, and retain the `offered-sportsbook` reason.
- Exclude stale, suspended, invalid, incomplete, and outlier books with explicit reasons.
- Mark consensus and qualification unavailable when fewer than three eligible comparison books remain.
- Treat warning and block thresholds as observed disagreement only; do not label movement as sharp, public, or steam without verified evidence.
- Keep fractional Kelly informational and separate from wager placement or bankroll automation.
- Mark CLV unavailable when the independent closing consensus cannot be formed.
- Preserve immutable snapshots without a TTL. The table's generic TTL capability is not authority to expire snapshot records.

## Consequences

The Pro roster can satisfy the three-book gate without Circa or Pinnacle, but individual events may still fail closed when coverage is incomplete. Equal weights are deliberately modest until evidence supports differentiation. Existing records created under older policy versions remain unchanged. Future settings work may expose these values, but FTE-032 does not add a settings UI.

The collection roster must request Hard Rock plus the four configured comparisons for MLB and MLS. A provider or entitlement failure is visible as missing coverage; it cannot trigger threshold weakening or an unapproved book substitution.

## Risks

- Sportsbook markets are correlated, so four brands are not four independent predictive models.
- SharpAPI coverage is event-, sport-, market-, and time-dependent despite account entitlement.
- The provisional outlier and disagreement boundaries may be too strict or permissive.
- Indefinite hot retention increases storage cost over time.
- Sport-specific minimum EV thresholds can drift unless schema and contract tests keep strategy versions aligned.

These risks are accepted for the private MVP because every affected value is versioned, calculations retain provenance, insufficient evidence fails closed, and later promotion requires walk-forward evaluation.

## Evidence limitations

The account and live-request checks establish present entitlement and successful retrieval, not permanent market availability, liquidity, independence, or empirical superiority. No proprietary response payload, credential, or provider term is reproduced here. Threshold values are engineering hypotheses grounded in current project behavior, not claims of betting profitability.

## Revision triggers

- SharpAPI plan, selected-book entitlement, identifier, or provider contract changes.
- Fourteen days of coverage telemetry shows the three-book gate routinely cannot be met.
- Walk-forward evaluation shows calibration, CLV, or exclusion quality materially improves under a different value.
- FTE-030 fixtures demonstrate disagreement or outlier boundary defects.
- Snapshot storage cost crosses an explicitly reviewed operational budget.
- The target sportsbook changes from Hard Rock.

## Research review checklist

- [x] Active account tier and maximum selected-book count verified without recording credentials.
- [x] Hard Rock and all four comparison books returned HTTP 200 with live odds data.
- [x] Circa and Pinnacle excluded because their odds require Sharp tier.
- [x] DraftKings/Circa splits entitlement kept separate from odds-book entitlement.
- [x] Hard Rock exclusion from its own consensus is explicit.
- [x] Every requested default has a value, rationale, risk, configuration key, and revision trigger.
- [x] Thresholds are labeled provisional and versioned rather than empirically optimal.
- [x] Sparse, divergent, missing-close, and unavailable states fail closed.
- [x] Fractional Kelly is informational only.
- [x] No destructive snapshot TTL or deletion policy is introduced.
- [x] Decision owner approved unattended implementation under the standing MVP approval.

## Supersedes

This ADR resolves PRD decisions OD-003 through OD-010 for the initial MVP defaults, except that future policy revisions and the settings interface remain separate work. It replaces scattered placeholder values as decision authority; implementation functions remain responsible for enforcing the versioned contract.
