---
title: 'FTE-031 Calculation Versioning, Precision, and Display Rounding'
type: 'feature'
created: '2026-08-06'
status: 'done'
baseline_revision: '4a0e04ca6f78a8863004acc793790280c2946c0e'
final_revision: 'f0accb915d452a75a9a23df2f071b975acfb2388'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-030-movement-clv-outlier-and-market-disagreement-functions.md'
  - '{project-root}/_bmad-output/implementation-artifacts/deferred-work.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Betting calculations expose fragmented version strings, most aggregate results lack stable input hashes and display projections, and consumers round independently. Durable paper evaluations retain only the top qualification version, so the exact consensus and market-quality calculation graph cannot be audited later.

**Approach:** Introduce one browser-safe canonical calculation-hash contract, a typed algorithm registry and composite provenance envelope, and one versioned display precision policy. Apply them to Epic 5 aggregate results, persist the complete graph in a new paper-manifest schema, and make Edge Lab consume the shared display projection.

## Boundaries & Constraints

**Always:** Preserve every existing raw formula, status, reason, threshold, scalar helper signature, and full-precision value. Hash only normalized non-sensitive calculation inputs with domain separation, UTF-8 byte key ordering, preserved meaningful array order, finite numbers, and normalized negative zero; display values and labels never enter authoritative hashes or later math. Keep legacy paper-manifest hashes and IDs byte-for-byte readable. New records use an explicit schema and retain root plus component algorithm versions, input hashes, hash-strategy version, and precision-policy version. Resolve the deferred hardened consensus identity as `weighted-consensus-v2`. Display rounding is decimal half-away-from-zero, normalizes negative zero, and supports fixed-width strings where scale matters.

**Block If:** Implementation requires changing a betting formula or policy threshold, rewriting/backfilling an existing record, invalidating a legacy manifest hash, choosing a new business-facing display scale not derivable from the existing Fair Value/Edge Lab conventions, or changing the accepted CLV benchmark.

**Never:** Hash credentials, tokens, raw provider payloads, prompts, or PII. Never feed rounded values into consensus, EV, Kelly, qualification, movement, CLV, grading, or report math. Do not add provider, database, AWS, migration, recalculation-job, settlement, or closing-snapshot lookup behavior. Do not replace the legacy same-book performance CLV path; FTE-051 owns closing-consensus integration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Stable input identity | Equivalent objects with reordered keys or negative zero | Same domain-separated 64-hex hash | Non-finite, unsupported, oversized, or unsafe-key material is rejected |
| Meaningful change | Algorithm/component version, input value, or meaningful array order changes | Different hash/provenance | No collision-by-default fallback |
| Display boundary | Positive/negative halves, exponent notation, trailing-zero scale | Half-away result and fixed-width string; raw input unchanged | Non-finite values and invalid scale are rejected |
| Aggregate calculation | Consensus, fair value, qualification, movement, outlier, disagreement, or CLV result | Frozen raw values plus root/component provenance and display-only projection | Existing typed unavailable/invalid state remains authoritative |
| Durable evaluation | New worker evaluation | Manifest schema records complete calculation provenance and produces deterministic new IDs | Legacy schemas still normalize and verify unchanged |

</intent-contract>

## Code Map

- `packages/domain/src/calculation-provenance.ts` and tests -- canonical calculation JSON, domain-separated SHA-256 input hashing, bounded safe-value validation, and reusable provenance types.
- `packages/domain/src/paper-evaluation.ts` and tests -- legacy-safe manifest normalization plus the new calculation-provenance schema.
- `packages/odds/src/versions.ts`, `precision.ts`, and tests -- immutable algorithm registry, precision policy, numeric rounding, and fixed-scale formatting.
- `packages/odds/src/provenance.ts` and tests -- construct frozen root/component calculation evidence from normalized inputs.
- `packages/odds/src/index.ts`, `qualification.ts`, `movement.ts`, `market-quality.ts`, `clv.ts` and tests -- attach hashes, component versions, and display projections without changing raw results.
- `apps/workers/src/pick-evaluation.ts` and tests -- persist composite provenance, use the new manifest schema, and emit bounded version/hash telemetry.
- `apps/web/src/App.tsx` and tests -- replace Edge Lab's private rounding with shared display output.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/calculation-provenance.ts`, `calculation-provenance.test.ts`, and `index.ts` -- implement and export canonical safe hashing plus typed frozen provenance.
- [x] `packages/odds/src/versions.ts`, `precision.ts`, `provenance.ts`, their tests, and `package.json` -- centralize versions, expose versioned display helpers, and bind calculation hashes through the domain package.
- [x] `packages/odds/src/index.ts`, `qualification.ts`, `movement.ts`, `market-quality.ts`, `clv.ts`, and tests -- enrich every Epic 5 aggregate result while preserving raw v1 behavior and bumping hardened consensus identity to v2.
- [x] `packages/domain/src/paper-evaluation.ts` and tests -- add an exact new-schema provenance field while preserving all legacy canonical bytes, reads, hashes, and IDs.
- [x] `apps/workers/src/pick-evaluation.ts` and tests -- write full raw/provenance evidence, update intentional golden IDs, prove retry convergence, and add safe telemetry.
- [x] `apps/web/src/App.tsx` and tests -- consume shared fixed display values and show the authoritative algorithm version.

**Acceptance Criteria:**
- Given semantically identical normalized calculation inputs, when provenance is constructed in different object-key or set orders, then hashes and frozen evidence are identical; meaningful ordered input or version changes alter identity.
- Given any supported calculation, when display values are produced, then raw values remain bit-for-bit unchanged and no downstream calculation consumes the rounded projection.
- Given legacy and new paper evaluations, when normalized or replayed, then legacy hashes remain exact while new records bind root/component versions and input hashes to deterministic new IDs.
- Given production qualification fixtures, when versioning is enabled, then decisions, reasons, and raw scalar values remain unchanged while the hardened consensus is identified as v2.

## Spec Change Log

## Review Triage Log

### 2026-08-06 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 16: (high 9, medium 6, low 1)
- defer: 0
- reject: 5
- addressed_findings:
  - `[high]` `[patch]` Removed display-policy metadata from authoritative calculation input hashes while retaining it in the provenance envelope.
  - `[high]` `[patch]` Bound algorithm identifiers and versions as structured canonical input under an unambiguous fixed hash domain.
  - `[high]` `[patch]` Rejected unpaired Unicode surrogates so UTF-8 key ordering cannot produce canonicalization ties.
  - `[high]` `[patch]` Expanded unsafe-key and obvious credential-value rejection for token and provider-payload material.
  - `[high]` `[patch]` Corrected paper-manifest schema gating so exact v3 records require provenance, unrelated legacy v3 schemas remain readable, and unsupported future paper-evaluation schemas cannot bypass the contract.
  - `[medium]` `[patch]` Added deterministic full-record tiebreakers for equal canonical consensus book and selection identifiers.
  - `[medium]` `[patch]` Added deterministic contribution tiebreakers for duplicate canonical market-quality sportsbook identifiers.
  - `[medium]` `[patch]` Added deterministic observation tiebreakers for equal movement timestamps and identifiers.
  - `[high]` `[patch]` Guarded closing-consensus provenance construction so malformed consensus input cannot throw from the invalid placed-odds path.
  - `[medium]` `[patch]` Materialized Edge defaults and deduplicated the approved-market membership set before hashing.
  - `[high]` `[patch]` Restricted qualification provenance to policy and probability fields actually consumed by the algorithm.
  - `[high]` `[patch]` Removed unused model estimate and upper-bound values from the qualification root hash so durable worker evidence remains sufficient for audit.
  - `[medium]` `[patch]` Converted Fair Value display projections to shared fixed-width strings that preserve trailing-zero scale.
  - `[high]` `[patch]` Removed point-delta and gap-minute projections whose display scales were not authorized by the existing policy.
  - `[low]` `[patch]` Replaced hard-coded Fair Value and Edge Lab scales with the centralized display policy constants and helpers.
  - `[medium]` `[patch]` Added regression coverage for hash equivalence, permutation determinism, legacy schema compatibility, unsafe material, display scale, and malformed-input behavior.

### 2026-08-06 — Follow-up review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 4, medium 4, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Expanded key screening to reject password, private-key, token, raw payload, and ordinary personal-information fields before hashing.
  - `[high]` `[patch]` Expanded value screening for Basic/Bearer credentials, provider token prefixes, access keys, private-key material, assignments, and email addresses without echoing sensitive values.
  - `[high]` `[patch]` Added component-count and object-key bounds before mapping or copying so oversized requests fail before expensive allocation.
  - `[medium]` `[patch]` Projected consensus selections to only the fields consumed by the calculation, ignoring unused properties and getters.
  - `[medium]` `[patch]` Projected movement provenance to consumed root fields and replaced locale-sensitive timestamp ordering with ordinal ordering.
  - `[high]` `[patch]` Wrapped all closing-consensus calculation and policy-validation failures in the declared fail-closed typed invalid result.
  - `[medium]` `[patch]` Replaced locale-sensitive qualification weight ordering with ordinal ordering.
  - `[medium]` `[patch]` Added regression probes for secret/PII forms, bounded work, getter safety, locale independence, and malformed consensus policies.

### 2026-08-06 — Final review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 2, medium 0, low 0)
- defer: 0
- reject: 2
- addressed_findings:
  - `[high]` `[patch]` Rejected prefixed camel-case, snake-case, and kebab-case credential fields whose unsafe phrase appears at the end of the key.
  - `[high]` `[patch]` Rejected SSN- and phone-shaped personal-information values under neutral keys while retaining regression coverage for safe odds, timestamps, versions, and hashes.

## Design Notes

The calculation input hash is distinct from `manifest.inputHash`: the former identifies sanitized inputs to one algorithm, while the latter continues to identify the complete persisted evaluation record. Versioning result shape/display policy does not silently redefine formula semantics. Existing fair-value scales remain the baseline: decimal odds 3, American odds 0, percentages 2, and money 2; Edge Lab probability output uses its current one-decimal-percent convention through an explicit format request.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test` -- canonical hashes, legacy manifests, and new schema pass.
- `pnpm --filter @find-the-edge/odds test` -- version, precision, provenance, and raw-parity goldens pass.
- `pnpm --filter @find-the-edge/workers test` -- persisted evidence and retry identities pass.
- `pnpm --filter @find-the-edge/web test` -- shared display output passes.
- `pnpm check && git diff --check` -- repository checks and builds pass.
