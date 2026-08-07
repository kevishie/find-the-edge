---
title: 'FTE-040: Provider-Backed Scouting Input Contract and Development Stub'
type: 'feature'
created: '2026-08-07'
status: 'in-review'
baseline_revision: 'c6505781d085662a21ff7f945f083f60118ccd00'
review_loop_iteration: 1
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-7-context.md'
  - 'docs/adr/0004-soccer-enrichment-provider.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** The scouting workflow has no strict provider-neutral input document, so later report generation cannot distinguish verified, inferred, stale, conflicting, unavailable, or malformed evidence with reproducible provenance. Development also needs a safe fixture source while production soccer enrichment remains unauthorized.

**Approach:** Add a consumer-owned, versioned scouting-input validator and an explicitly non-production provider fixture stub. Keep provider payloads untrusted until validation, preserve canonical SharpAPI event identity, and prove the stub conforms through a cross-package contract test without connecting a live vendor.

## Boundaries & Constraints

**Always:** Validate exact versioned envelopes; bind inputs to canonical event ID/version, sport, league, start time, and participants; recompute freshness and the deterministic input hash; preserve source provider/entity/timestamps, collection time, verification, confidence, and contract-permitted evidence references; model unavailable data explicitly; return immutable canonical output. Keep fixture mode, synthetic provenance, and `productionEligible: false` inseparable.

**Block If:** Implementation would require a live credential, non-public vendor terms, a production provider choice, an event-authority change, or a new lifecycle/report-completion decision owned by FTE-041/FTE-042.

**Never:** Add a Sportmonks or other network adapter, secret/IAM/CDK access, paid/raw payload, real injury detail, logo/media asset, production fixture flag, provider-to-scouting package dependency, or silently reinterpret existing scouting jobs. Never accept unknown keys, mutable/cyclic/accessor-rich input, dangling references, future/noncanonical timestamps, non-finite values, secret-like content, or unavailable data as verified-empty.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Valid provider-neutral input | Canonical event plus bounded sources/facts | Sorted, deep-frozen contract with recomputed freshness and hash | No error |
| Five evidence states | Verified, inferred, stale, conflicting, unavailable facts | Enforce state-specific value, basis/source, freshness, conflict, reason, and confidence invariants | Stable safe contract error on mismatch |
| Development fixture | Explicit fixture mode in development/test | Synthetic all-state document with `productionEligible: false`; log metadata only | Reject production before reading/logging fixture |
| Canonical mismatch | Fixture/input event differs from request | No normalized result and no authority mutation | Stable event-identity error |
| Hostile or malformed input | Unknown/unsafe/oversized/cyclic data, duplicates, bad refs/times/hash fields | No partial normalized object | Stable safe contract error; no payload echo |

</intent-contract>

## Code Map

- `packages/sports/src/shared/contracts.ts` -- sport-module-owned scouting capability, fact-schema, participant-binding, and required-coverage contracts; shared vocabulary stays generic.
- `packages/sports/src/shared/create-module.ts` plus registered module definitions -- require each module to publish its versioned scouting schema and explicit required/optional capability manifest.
- `packages/sports/src/soccer/scouting-input.ts` and tests -- soccer-only fact value schemas, subject rules, lineup states, and required capability instances for the four trial competitions.
- `packages/scouting/src/scouting-input.ts` and tests -- consumer-owned v1 envelope validator, trusted validation context, canonical event fence, provenance/reference rules, deterministic freshness/hash/order, and deep freeze.
- `packages/providers/src/scouting-input-ports.ts` and tests -- provider-neutral capability-specific ports returning `unknown`, plus strict coverage descriptors; no aggregate scouting DTO and no dependency on scouting or sports.
- `packages/providers/src/scouting-input-development-stub.ts`, `packages/providers/src/fixtures/scouting-input.ts`, and tests -- trusted-runtime-gated synthetic implementations of the capability ports, never production eligible.
- `packages/test-utils/src/scouting-input-contract.test.ts` and package manifest -- actual provider-port-to-module-schema-to-consumer conformance across package boundaries.
- Package manifests, lockfile, public exports, Epic 7 context, and sprint status -- additive dependency/export/tracking changes only.
- `_bmad-output/implementation-artifacts/epic-7-context.md` -- refreshed Epic 7 constraints including the accepted provider evaluation.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` -- story state and next-ready routing.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sports` -- add an executable, versioned scouting-input schema contract to every registered sport module. The shared type must support one or more ordered participants and generic capability/fact identifiers; only the soccer module may define soccer categories, predicted/probable/confirmed lineup states, soccer value shapes, and participant/entity binding rules. Planned modules publish honest unavailable-only manifests rather than borrowing soccer schemas.
- [x] `packages/scouting/src/scouting-input.ts`, public export, dependency manifest, and tests -- validate a bounded v1 envelope against a trusted registered module and trusted source authorization. Require every module-declared capability instance to be present, including explicit unavailable observations; reject caller assertions of mode or production eligibility; bind event, participant, subject, schema, and source identities; and return canonical immutable data with a recomputed hash.
- [x] `packages/scouting` provenance and freshness tests -- require retained evidence references to be immutable and content-addressed, enforce synthetic-reference semantics, preserve provider revision tokens and/or monotonic collector sequences, quarantine same-revision contradictions, keep audit provenance on unavailable facts, and derive freshness from the oldest applicable origin timestamp with millisecond-accurate boundaries.
- [x] `packages/providers/src/scouting-input-ports.ts`, public export, and tests -- define separate fixture, team/roster, lineup, injury/suspension, and statistics collection ports whose untrusted results are independently replaceable. Validate canonical coverage identifiers and enforce `maturity === production` iff a trusted descriptor is production eligible; do not expose a provider-shaped aggregate interface.
- [x] `packages/providers/src/scouting-input-development-stub.ts`, synthetic fixture, public export, and tests -- implement the capability ports behind a constructor/factory that receives the trusted runtime environment outside the request payload. Reject production before fixture access or logging, keep every development descriptor ineligible, use stable safe errors for proxies/accessors/date limits, and emit metadata-only telemetry.
- [x] `packages/test-utils/src/scouting-input-contract.test.ts`, package manifests, and lockfile -- exercise the real stub through the real soccer module and consumer validator without a provider-to-scouting/sports dependency. Prove declared coverage equals emitted capability instances and prove an unrelated test module with a different participant/value schema works without shared-core edits.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- retain FTE-040 in progress through review; completion routes FTE-041.

**Acceptance Criteria:**
- Given any supported evidence state, when an input is validated, then the canonical result preserves auditable provenance and enforces that state's value, freshness, confidence, basis, conflict, and unavailability rules.
- Given any registered sport module, when its scouting input is validated, then shared scouting code accepts the module's participant cardinality, fact identifiers, value schemas, subject rules, and required capability manifest without a sport-name branch; soccer-only semantics never appear in the shared contract.
- Given malformed, hostile, mismatched, or noncanonical provider data, when validation runs, then it fails atomically with a stable safe error and never changes canonical schedule/odds truth.
- Given omitted coverage, malformed category values, dangling subjects, stale provider origins, relabeled fixture references, caller-asserted eligibility, or replay/correction conflicts, when validation runs, then the input fails closed or remains explicitly unavailable/quarantined according to the versioned contract.
- Given the development stub in a trusted development/test runtime, when its independent port outputs are assembled and validated, then all required soccer capability instances and evidence states round-trip deterministically as immutable non-production evidence without secrets or raw vendor payloads.
- Given the same stub in a trusted production runtime, when any capability is collected, then it fails before request inspection, fixture access, or logging and no request field can downgrade the runtime or register production coverage.
- Given repository boundary checks and workspace verification, when FTE-040 completes, then no provider DTO, live credential, production adapter, workflow-completion claim, or forbidden package dependency was introduced.

## Spec Change Log

- 2026-08-07, review loop 1: Replaced the rejected soccer-shaped shared contract with a sport-module-owned schema architecture. Added trusted runtime/source authorization, capability-specific ports, manifest completeness, immutable retained evidence, correction ordering, unavailable provenance, and adversarial boundary requirements. The intent contract was preserved unchanged.

## Review Triage Log

- Review pass 1 (2026-08-07): 18 blind-review findings plus 10 edge-case findings were deduplicated into 21 concerns. Classified 10 as `bad_spec` (9 high, 1 medium), making lower-level patch findings moot for this implementation. `intent_gap: 0`, `defer: 0`, `reject: 0`. The rejected implementation was removed before commit. KEEP: exact hostile-input validation, deterministic sorting/hash/freeze, five evidence states, explicit development fixture ineligibility, cross-package conformance, and the locally green verification baseline.

### 2026-08-07 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 25 (high 19, medium 6, low 0)
- defer: 0
- reject: 1 (medium 1)
- addressed_findings:
  - `[high]` `[patch]` Replaced array method/property reads and revision-key rewriting with descriptor-safe indexed cloning, exact array keys, and direct secret screening so accessors cannot execute and distinct inputs cannot collide in the hash.
  - `[high]` `[patch]` Rejected unknown runtime environments and tightened trusted source/reference authorization, including matching `sha256://` references to their content hashes.
  - `[high]` `[patch]` Replaced lexicographic opaque revision ordering with preserved provider revision evidence plus a numeric provider ordinal, or the collector's monotonic sequence.
  - `[high]` `[patch]` Enforced `providerTimestamp <= collectedAt <= evaluatedAt` so impossible provider chronology cannot make evidence appear fresher.
  - `[high]` `[patch]` Prevented inferred facts from using unavailable, conflicting, or transitively quarantined basis evidence.
  - `[high]` `[patch]` Bound entity facts to participant-scoped capability instances and rejected duplicate entity facts for the same schema/variant/instance.
  - `[high]` `[patch]` Preserved inferred/conflicting state independently from derived stale freshness instead of forcing one axis to erase the other.
  - `[medium]` `[patch]` Replaced locale-sensitive ordering and normalized all set-like nested references and conflict alternatives before canonical hashing.
  - `[medium]` `[patch]` Wrapped module-owned subject/value validators so hostile data cannot leak arbitrary module exceptions.
  - `[high]` `[patch]` Made provider coverage capabilities canonical generic identifiers so adding a registered sport does not require provider-core vocabulary edits.
  - `[high]` `[patch]` Validated every module-contract enum, boolean, array, cardinality, and validator, and required entity schemas to declare a binding validator.
  - `[high]` `[patch]` Tightened soccer schemas: competition facts match the canonical league, roster/lineup member lists are nonempty and participant-bound, and resolved injury feeds must be covered and internally coherent.
  - `[medium]` `[patch]` Bounded development-stub sequence offsets and composite identifiers so valid requests cannot generate consumer-invalid fixture evidence.
  - `[high]` `[patch]` Required every normalized observation to belong to coverage and every fact observation to appear in its capability-instance coverage.
  - `[high]` `[patch]` Added regression coverage for secret-like content, provenance completeness, canonical equivalence, malformed module validators, and the corrected sport/provider boundaries.
  - `[medium]` `[reject]` Kept identical same-ID observation replays idempotent; rejecting them would contradict the accepted ADR's explicit replay requirement.

### 2026-08-07 — Review pass 3
- intent_gap: 0
- bad_spec: 0
- patch: 15 (high 11, medium 4, low 0)
- defer: 0
- reject: 1 (low 1)
- addressed_findings:
  - `[high]` `[patch]` Added source-specific retained-reference prefixes and required every retained locator to terminate in its verified content hash; empty and unauthorized locators now fail closed.
  - `[high]` `[patch]` Preserved bounded opaque provider revision and entity IDs, required provider entity type/ID pairs, and kept numeric provider ordinals as the ordering authority.
  - `[high]` `[patch]` Required resolved facts to cite terminal correction evidence and rejected one provider revision mapped to conflicting ordinals in the same stream.
  - `[high]` `[patch]` Rejected unsatisfiable module capability/fact scope combinations and bounded worst-case capability/fact expansion to the envelope limits.
  - `[high]` `[patch]` Replaced ambiguous soccer member-prefix ownership, required eleven unique participant-bound members for every lineup state, and bounded form points to legal integer totals.
  - `[high]` `[patch]` Made coverage consistency include optional facts when present so available, partial, and unavailable cannot contradict their evidence.
  - `[medium]` `[patch]` Made sport-contract validation/freezing descriptor-safe and cycle-safe without executing accessors.
  - `[medium]` `[patch]` Required every conflict alternative to have a unique canonical value and added exact locator/contract-expansion regression coverage.
  - `[high]` `[patch]` Added terminal-correction, opaque-provenance, source-rights, participant-collision, XI, statistics, and optional-coverage regression tests across all four packages.
  - `[low]` `[reject]` Left `review_loop_iteration` at 1 because BMad increments it only for a `bad_spec` re-derivation; patch review passes do not change it.

### 2026-08-07 — Review pass 4
- intent_gap: 0
- bad_spec: 0
- patch: 13 (high 13, medium 0, low 0)
- defer: 1 (high 1)
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Made semantically identical provider-revision re-polls idempotent while continuing to quarantine genuine same-revision contradictions and duplicate immutable evidence used to fabricate conflicts.
  - `[high]` `[patch]` Required resolved evidence to cite the latest usable revision even when a provider omits an explicit correction link, and permitted a collector-ordered stream to transition to provider ordering when revision metadata first becomes available.
  - `[high]` `[patch]` Aligned module expansion limits with canonical calculation limits and wrapped normalization/hash size failures in stable scouting validation errors.
  - `[high]` `[patch]` Canonicalized and deterministically ordered soccer member identifiers, made development rosters coherent with their lineups, and rejected participant namespaces that would generate ambiguous fixture members.
  - `[high]` `[patch]` Removed untrusted schema identifiers from stable errors and required unavailable coverage reasons to agree with their corresponding facts.
  - `[high]` `[patch]` Modeled tennis participant cardinality as exactly two or four rather than the invalid continuous range of two through four.
  - `[high]` `[defer]` Deferred trusted provider-event/entity mapping to the first live provider adapter: FTE-040 intentionally has no network adapter or provider identity mapping, and its trusted composition root supplies the canonical event.

### 2026-08-07 — Review pass 5
- intent_gap: 0
- bad_spec: 0
- patch: 2 (high 2, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Applied sport-specific normalization before conflict-value uniqueness and canonical ordering so equivalent alternatives cannot survive under different raw spellings or orderings.
  - `[high]` `[patch]` Required every conflict alternative to cite terminal/latest evidence for its revision stream, rejecting linked and unlinked obsolete revisions while preserving genuine quarantined same-revision contradictions.

### 2026-08-07 — Review pass 6
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 0
- addressed_findings: none; the narrow fresh release review found no remaining blocker in conflict normalization or terminal/latest revision handling.

## Design Notes

Provider capability ports return untrusted `unknown` values. The scouting package owns envelope/provenance validation and invokes executable schemas supplied by the trusted registered sport module. The sports package owns sport-specific capability manifests and fact semantics, so adding a sport never requires a shared scouting switch. Trusted runtime and approved source descriptors are application configuration, never fields an untrusted provider payload may authorize.

An unavailable capability is still an observation: it identifies the requested capability instance, module schema, collection attempt/source coverage, reason, collection time, and ordering token. A retained evidence reference is valid only with a cryptographic content hash and approved immutable reference scheme. Provider timestamps contribute to freshness but do not order corrections; provider revision tokens or the collector's monotonic sequence do.

The provider package remains independent of sports and scouting. It defines capability-shaped ports and coverage metadata only. Test utilities are the composition root that proves provider output, module schema, and consumer validation agree.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/sports test && pnpm --filter @find-the-edge/sports typecheck && pnpm --filter @find-the-edge/sports lint` -- module-owned manifests and soccer schemas pass.
- `pnpm --filter @find-the-edge/scouting test && pnpm --filter @find-the-edge/scouting typecheck && pnpm --filter @find-the-edge/scouting lint` -- generic contract, provenance, authorization, and hostile-input matrix pass.
- `pnpm --filter @find-the-edge/providers test && pnpm --filter @find-the-edge/providers typecheck && pnpm --filter @find-the-edge/providers lint` -- capability ports, coverage validation, trusted runtime, and fixture safety pass.
- `pnpm --filter @find-the-edge/test-utils test && pnpm boundaries && pnpm check` -- real cross-package conformance and full workspace gates pass.
- `git diff --check && git diff --cached --check` -- tracked and staged patch hygiene pass.
