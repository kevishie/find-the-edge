---
title: 'FTE-028 Two-Way and Three-Way No-Vig Consensus'
type: 'feature'
created: '2026-08-06'
status: 'done'
baseline_revision: '838414279b5e199a9c639d36667be6bc2a3b37cf'
final_revision: 'b311e543eb5b59f136dcfafc1755fef052e9673b'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-032-consensus-and-qualification-defaults.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The existing consensus helper is not safe enough to drive betting decisions: ordinary bad sportsbook data can throw, malformed or duplicate books can contribute, and an unavailable result can still expose partial probabilities. Production qualification also duplicates the math with different median and failure behavior.

**Approach:** Establish one deterministic, sport-agnostic consensus kernel for complete two- and three-outcome markets, then make qualification delegate to it without changing persisted manifest contracts or worker decisions.

## Boundaries & Constraints

**Always:** Preserve `removeVig` as the strict low-level API used by Edge Lab. Identify selections explicitly and normalize every book to the requested market order. Take weights and thresholds from a passed policy projection; never trust provider-supplied weights or invent new defaults. Exclude the target sportsbook, unconfigured/zero-weight, stale, inactive, incomplete, invalid, and outlier books. A result is available only when the configured minimum number of positive-weight books remains; unavailable results expose `probabilities: null`. Canonically order auditable output so input permutation cannot change the result. Keep transient calculation types in `packages/odds` and preserve `QualificationResult`, `QUALIFICATION_VERSION`, worker manifest shape, and SharpAPI split semantics.

**Block If:** Correct implementation requires changing persisted evaluation-manifest schemas, accepted FTE-032 policy defaults, or the meaning of an already-stored qualification version.

**Never:** Add UI, provider, repository, migration, backfill, EV/Kelly, disagreement scoring, input hashing, or durable calculation-provenance work owned by later Epic 5 stories. Never include Hard Rock in a Hard Rock opportunity's consensus, return actionable partial consensus below the book gate, or use exceptions for ordinary bad market observations.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Two-way / three-way | Complete active configured books | Weighted no-vig probabilities in requested selection order, finite and summing to one | Available typed result |
| Bad book observation | Missing/duplicate selection, invalid odds/age, suspended/closed, stale, unknown, zero weight | Book does not contribute and has one explicit exclusion reason | Continue if the minimum remains |
| Target sportsbook | Target appears among comparisons, including case variants | Target never contributes | Explicit target exclusion |
| Outlier | Any outcome differs from its eligible-book median by more than the threshold | Entire book is excluded; equality remains included | Explicit outlier exclusion |
| Sparse market | Fewer than the configured minimum books remain after all exclusions | No consensus probability is exposed | Typed unavailable result with exact counts |
| Malformed market | Unsupported outcome count or duplicate market keys/books | No calculation is exposed | Consensus returns a typed invalid result; the qualification adapter preserves its existing duplicate/vector exceptions |
| Malformed policy | Non-finite/impossible thresholds, minimums, or configured weights | Calculation does not start | Deterministic programmer-error exception |

</intent-contract>

## Code Map

- `packages/odds/src/index.ts` -- current no-vig and dormant weighted-consensus implementation; owns the authoritative kernel and transient result types.
- `packages/odds/src/index.test.ts` -- direct formula, validation, exclusion, ordering, and fail-closed coverage.
- `packages/odds/src/qualification.ts` -- production calculation path whose duplicated normalization, median, filtering, and weighting must delegate to the kernel.
- `packages/odds/src/qualification.test.ts` -- qualification compatibility and parity coverage.
- `apps/workers/src/pick-evaluation.ts` -- sole production qualification consumer; must retain its public result and manifest mapping.
- `apps/workers/src/pick-evaluation.test.ts` -- regression coverage for unchanged decision evidence and persisted provenance.

## Tasks & Acceptance

**Execution:**
- [x] `packages/odds/src/index.ts` -- harden the consensus contract and pure kernel for explicit two-/three-selection markets, policy-driven weights, deterministic exclusions, and fail-closed typed results.
- [x] `packages/odds/src/index.test.ts` -- add golden formulas and independent edge-case tests for the full matrix, exact boundaries, deterministic ordering, and immutability.
- [x] `packages/odds/src/qualification.ts` -- adapt qualification to the authoritative kernel while preserving its exported contract, version, reasons, and sorted IDs.
- [x] `packages/odds/src/qualification.test.ts` -- prove median/weighting parity, sparse behavior, and compatibility.
- [x] `apps/workers/src/pick-evaluation.test.ts` -- prove the production adapter still emits the same decision, no-vig probability, included book IDs, and manifest evidence for a valid fixture.

**Acceptance Criteria:**
- Given complete two-way or three-way prices, when consensus is calculated, then the exact weighted no-vig result is deterministic, finite, selection-aligned, and sums to one.
- Given Hard Rock as the target, when Hard Rock is present in comparison input, then it is auditably excluded and cannot affect the result.
- Given stale, suspended, incomplete, invalid, unconfigured, zero-weight, duplicate, or outlier data, when eligibility is evaluated, then every non-contributor has a stable explicit state and never changes the weighted result.
- Given exclusions leave too few books, when the result is returned, then it is unavailable with `probabilities: null` and exact required/eligible counts.
- Given the production qualification path, when the same valid evidence is processed after the refactor, then its decision contract and stored manifest mapping remain compatible.

## Spec Change Log

## Review Triage Log

### 2026-08-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 13: (high 5, medium 8, low 0)
- defer: 1: (high 0, medium 1, low 0)
- reject: 1: (high 0, medium 0, low 1)
- addressed_findings:
  - `[high]` `[patch]` The shared kernel's averaged even-book median changed persisted qualification-v1 replay semantics; qualification now preserves its established upper-median behavior through the single kernel.
  - `[high]` `[patch]` Qualification used a synthetic target identifier; its contract now requires the actual target and the worker passes the versioned policy target, with malformed target observations ignored before validation.
  - `[high]` `[patch]` Qualification rebuilt policy weights from observation rows; comparison weights now come exclusively from the policy projection and observation rows no longer carry weights.
  - `[high]` `[patch]` Sparse contributions could still drive disagreement warnings or blocks; unavailable consensus now exposes no actionable disagreement calculation.
  - `[high]` `[patch]` A blank target disabled self-exclusion; the kernel now rejects an empty canonical target deterministically.
  - `[medium]` `[patch]` Case-variant duplicate comparison books bypassed the compatibility exception; qualification now detects duplicates canonically.
  - `[medium]` `[patch]` Impossible policies could configure fewer positive non-target books than their minimum gate; policy validation now rejects them before calculation.
  - `[medium]` `[patch]` Non-record comparison-weight values could pass runtime validation; arrays and malformed containers are now rejected explicitly.
  - `[medium]` `[patch]` Whitespace-only selection keys could form an available market; they now produce the typed invalid-market result.
  - `[medium]` `[patch]` Duplicate sportsbook rows produced only one audit exclusion; each rejected duplicate observation now retains an exclusion entry.
  - `[medium]` `[patch]` Unknown runtime statuses escaped the declared reason vocabulary; they now map to bounded `invalid-status` evidence.
  - `[medium]` `[patch]` Locale-dependent ordering weakened deterministic output and reduction order; canonical identifiers now use code-point comparison.
  - `[medium]` `[patch]` Extreme finite weights could overflow aggregation; weights are now scaled before the weighted average and covered by a maximum-finite fixture.

## Design Notes

The consensus kernel is calculation infrastructure, not a persisted domain entity. Qualification translates its existing inputs into the kernel and translates the result back, so later versioning and replay stories can evolve durable provenance deliberately instead of receiving an accidental schema change here. Outlier medians are computed per outcome from otherwise eligible books; a book is removed when any outcome exceeds the configured threshold. The existing qualification-v1 upper-median rule remains intact so stored evaluations retain their meaning.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/odds test` -- all direct consensus and qualification tests pass.
- `pnpm --filter @find-the-edge/workers test` -- worker decision and manifest regressions pass.
- `pnpm check` -- repository formatting, types, boundaries, and tests pass.

## Auto Run Result

Status: done

### Summary

Established one deterministic consensus kernel for complete two-way and three-way markets. It normalizes every eligible sportsbook to no-vig probabilities, applies policy-owned weights, excludes the target and unsafe observations, and returns no actionable probability when the configured book gate is not met. Production qualification now delegates to that kernel while preserving its stored v1 behavior and manifest contract.

### Files changed

- `packages/odds/src/index.ts` and tests -- typed, selection-aligned, policy-driven consensus with deterministic audit output, bounded validation, extreme-weight safety, and fail-closed sparse results.
- `packages/odds/src/qualification.ts` and tests -- removed duplicated weighting/filtering logic, retained qualification-v1 median behavior, and enforced the actual target plus policy-owned comparison weights.
- `apps/workers/src/pick-evaluation.ts` and tests -- pass the policy target into qualification and prove decision/probability/manifest compatibility.
- `epic-5-context.md` -- refreshed the deterministic-engine contract from current planning artifacts.
- `deferred-work.md` -- assigned durable weighted-consensus version propagation to FTE-031.

### Review findings

- Patches applied: 13 (5 high, 8 medium).
- Items deferred: 1 medium item already owned by FTE-031.
- Items rejected: 1 low-consequence request for redundant production-layer test coverage after the affected paths received direct tests.
- Follow-up review recommended: true because review fixes affected calculation compatibility, target isolation, policy authority, sparse-signal behavior, and numeric stability.

### Verification

- Odds package: 64 tests passed.
- Workers package: 191 passed, 4 skipped live-contract tests.
- `pnpm check` passed repository formatting, lint, boundaries, type checks, all test suites, and builds.
- `git diff --check` passed.

### Residual risks

- The transient consensus calculation identifier remains `weighted-consensus-v1`; FTE-031 must version and propagate the hardened contract before it becomes durable replay provenance.
- Consensus quality still depends on at least three fresh entitled comparison books; sparse markets intentionally remain unavailable.
