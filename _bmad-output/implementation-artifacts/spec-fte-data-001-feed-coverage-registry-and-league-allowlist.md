---
title: 'FTE-DATA-001 Feed Coverage Registry and League Allowlist'
type: 'feature'
created: '2026-07-29T00:00:00-04:00'
status: 'done'
baseline_revision: '4b8682c'
final_revision: '54523c5'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-0A-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Feed support is currently a boolean descriptor check, so enabled leagues cannot resolve explicit schedule, odds, and results coverage or explain why coverage is unavailable. This prevents safe multi-sport ingestion planning and makes league additions depend on orchestration edits.

**Approach:** Introduce versioned, data-driven league feed policy and capability registries that resolve supported or unsupported coverage deterministically, emit safe operational context, and generate a secret-free coverage report without making paid API calls.

## Boundaries & Constraints

**Always:** Keep domain contracts dependency-free, preserve branded `SportKey` types, and preserve the existing dependency direction in which providers may consume config, so config must not import providers; distinguish feed maturity from sport-module maturity; model provider capabilities and markets per exact sport/league pair; allow registered leagues to have partial capability coverage and return `capability-unavailable` for a missing schedule, odds, or results capability; require every explicitly enabled capability to be active and provider-backed; return `league-unregistered` only when the league itself has no policies; keep ordering byte-stable across locales and input registration order, and expose readonly snapshots isolated from later source mutation; validate runtime enum/string/array request inputs as well as construction inputs, returning deterministic registry validation errors rather than raw exceptions; reject market filters on non-odds requests; retain all prior policy/provider validation, deterministic telemetry, safe metadata, fixture-backed MLB/MLS, and explicit planned states for tennis, NFL, NBA, and international soccer.

**Block If:** Working MLB/MLS coverage would require selecting or purchasing an unresolved commercial provider, changing secret-management policy, or claiming production approval for international soccer.

**Never:** Call paid APIs; expose credentials, commercial terms, or licensed payloads; treat empty coverage arrays as accidental universal support; put sport-key branches in shared orchestration; add prediction, polling, ingestion, or sportsbook behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Enabled coverage | MLB or MLS plus schedule, odds, or results | Resolves a fixture/development provider with cadence, maturity, markets, and quota estimate | No error expected |
| Planned league | Tennis, NFL, NBA, or international soccer capability | Returns unsupported with stable planned/unavailable reason | Does not throw |
| Missing capability | Registered league without requested provider capability | Returns unsupported with sport, league, capability, and reason | Does not throw |
| Invalid or contradictory registration | Duplicate/ambiguous key, empty odds markets, invalid numeric policy, blank identifier, or inconsistent active/allowlist/reason fields | Registration fails deterministically | Typed/descriptive validation error |
| Synthetic extension | Test sport, league, and fixture provider registration | Resolves all registered capabilities without resolver changes | No error expected |
| Telemetry failure | Injected logger throws during supported or unsupported resolution | Returns the deterministic coverage result | Logging failure is isolated |
| Provider mismatch | Active policy names a missing provider or unsupported capability/league/market | Registry construction fails | Typed/descriptive validation error |
| Partial league coverage | Registered league omits one or more schedule, odds, or results policies | Existing capabilities resolve normally; omitted capability returns `capability-unavailable` | Does not throw |
| Malformed query | Null/object-invalid request, blank/unknown identifiers, non-array market keys, or markets on non-odds capability | No resolution is attempted | Deterministic typed/descriptive validation error |

</intent-contract>

## Code Map

- `packages/domain/src/index.ts` -- dependency-free league identity, allowlist, maturity, cadence, quota, resolution, and report contracts.
- `packages/providers/src/index.ts` -- existing capability descriptors and boolean `supportsRequest` behavior to preserve or adapt.
- `packages/providers/src/coverage-registry.ts` -- provider/coverage registration, validation, deterministic resolution, reporting, and resolution telemetry.
- `packages/providers/src/coverage-registry.test.ts` -- registry, duplicate, unsupported, enabled-league, and synthetic extension contracts.
- `packages/config/src/feed-coverage.ts` -- versioned league catalog and safe fixture/development feed policy data; must not construct or import the provider registry.
- `packages/config/src/feed-coverage.test.ts` -- configured league states and secret-free deterministic report coverage.
- `packages/observability/src/index.ts` -- structured resolution context fields if the registry uses the shared logging contract.
- `packages/sports/src/registry.ts` -- analogous registration and duplicate-rejection pattern; not the feed allowlist.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/index.ts` -- add neutral feed coverage types with branded sport keys, discriminated cadence/policy states, and readonly supported/unsupported/report contracts -- keep invalid states harder to construct and outputs immutable without new domain dependencies.
- [x] `packages/providers/src/coverage-registry.ts`, `packages/providers/src/index.ts` -- scope provider capabilities and markets per exact sport/league pair, allow partial registered-league coverage, make omitted-league support checks evaluate all matching pairs deterministically, and retain every prior registry invariant -- implement the approved capability-aware policy.
- [x] `packages/config/src/feed-coverage.ts`, `packages/config/src/index.ts` -- export immutable fixture-backed MLB/MLS policy snapshots and explicit planned policy snapshots for every capability of tennis, NFL, NBA, and international soccer without importing providers -- provide a safe default catalog while preserving package dependency direction.
- [x] `packages/observability/src/index.ts` -- extend structured context only as needed for sport, league, capability, provider, and reason -- satisfy coverage-resolution observability without leaking payloads.
- [x] `packages/providers/src/coverage-registry.test.ts`, `packages/config/src/feed-coverage.test.ts` -- cover per-league capabilities/markets, partial enabled/planned/disabled coverage, deterministic omitted-league support, malformed/non-odds requests, serialized report stability, and all prior repair cases -- prove the approved policy and remaining fixes.
- [x] relevant `package.json` and boundary configuration files -- add only required workspace dependencies and exports -- preserve package-direction rules.

**Acceptance Criteria:**
- Given the default catalog, when every schedule, odds, and results capability is resolved for MLB and MLS, then each returns explicit fixture/development coverage with provider, maturity, cadence, markets, quota estimate, and structured resolution context.
- Given tennis, NFL, NBA, or international soccer, when a capability is queried, then the result represents its planned or disabled state explicitly with a stable unsupported reason.
- Given a new synthetic league registration, when its capabilities are queried, then resolution and reporting work without edits to resolver or orchestration logic.
- Given the configured registry, when a coverage report is generated twice, then both outputs are versioned, identically ordered, contain all configured league-capability states, and contain no credentials, commercial terms, or licensed payloads.
- Given incompatible markets, duplicate keys, or ambiguous active coverage, when registration occurs, then validation rejects the invalid configuration deterministically.
- Given blank identifiers or market keys, empty active odds markets, invalid cadence/quota numbers, or contradictory active/allowlist/reason metadata, when registration occurs, then validation rejects the invalid configuration before any query.
- Given no registration for a league versus a registered league with no requested capability, when each is resolved, then the results use `league-unregistered` and `capability-unavailable` respectively.
- Given an injected logger that throws, when supported or unsupported coverage is resolved, then the same deterministic result is returned and telemetry failure does not escape.
- Given workspace boundary validation, when package dependencies are checked, then config remains independent of providers and no config/providers cycle is introduced.
- Given policies for one league, when capabilities disagree on canonical league name or allowlist state, or active/inactive policies share a capability key, then construction rejects the contradictory catalog.
- Given an active policy, when its provider descriptor is absent or does not support the requested capability, league, or market, then construction rejects the false coverage claim.
- Given the default policy export or generated report, when a consumer attempts mutation or runs under a different locale, then future registry construction and report ordering remain unchanged.
- Given a provider descriptor covering multiple exact sport/league pairs, when a cross-paired policy is registered, then construction rejects the unsupported combination.
- Given a registered league with only some capabilities, when an omitted capability is queried, then resolution returns `capability-unavailable` while its registered capabilities continue to resolve according to policy.
- Given inactive coverage or non-odds coverage, when it declares market keys, then construction rejects the misleading market metadata.
- Given untyped policy/provider inputs with unknown capabilities, states, maturity, cadence modes, or quality tiers, when construction occurs, then deterministic registry validation errors identify the malformed field.
- Given an enabled league whose required capability policy is inactive, when construction occurs, then it is rejected rather than reported as complete.
- Given source policy/descriptor objects are mutated after registry construction, when resolution or reporting runs, then registry behavior and output remain unchanged.
- Given one provider supports different markets for different league pairs, when a cross-paired market policy is registered, then construction rejects it while each declared pair resolves only its own markets.
- Given a planned or disabled league with partial capability policies, when construction occurs, then the catalog remains valid and each omitted capability resolves as `capability-unavailable`.
- Given malformed runtime request data or market filters on schedule/results, when resolution is called, then a deterministic registry validation error is returned instead of a raw exception or misleading unsupported result.
- Given equivalent policies/descriptors in different input orders and runtime locales, when reports are serialized, then their bytes are identical.
- Given a provider supports different capabilities for different exact league pairs, when coverage is validated or queried, then no capability leaks across pairs; when `supportsRequest` omits the league, it evaluates all matching pairs without descriptor-order dependence.

## Spec Change Log

### 2026-07-29 — Review repair 1
- Trigger: adversarial review found universal empty odds coverage, unreachable unknown-league reasoning, contradictory policy states, invalid operational numbers/identifiers, logger-coupled resolution, incomplete planned-capability tests, and a config-to-providers dependency that inverted the established package direction.
- Amendment: strengthened invariants, edge cases, tasks, and acceptance criteria for strict construction validation, reason selection, telemetry isolation, complete planned-capability testing, and data-only config composition.
- Avoids: silently universal odds coverage, misleading reports/reasons, unusable scheduler metadata, telemetry-caused query failures, and a config/providers dependency cycle.
- KEEP: dependency-free domain contracts; deterministic total resolver/report design; fixture-backed MLB/MLS coverage; explicit planned leagues; safe structured context; versioned secret-free reports; synthetic extension coverage.

### 2026-07-29 — Review repair 2
- Trigger: the second review found contradictory policies could coexist across a league, delimiter-based keys could collide, manual cadence remained contradictory, default policy data was mutable, locale-sensitive sorting weakened determinism, and active coverage was not validated against a real provider descriptor.
- Amendment: required collision-safe keys, one consistent league policy across capabilities, provider descriptor compatibility, immutable snapshots, locale-independent ordering, canonical trimmed keys, and manual-cadence validation.
- Avoids: false or contradictory coverage reports, deployment-dependent ordering, process-wide policy mutation, ambiguous keys, and advertising a nonexistent provider capability.
- KEEP: all repair-1 invariants; total deterministic resolution; data-only config; failure-isolated logging; complete planned-league capability coverage; strict numeric and state validation.

### 2026-07-29 — Review repair 3
- Trigger: the third review found provider coverage arrays formed invalid sport/league cross-products, branded sport typing was weakened, enabled leagues could be incomplete, inactive odds policies could advertise markets, and provider/output contracts remained insufficiently validated or immutable.
- Amendment: required exact provider coverage pairs, restored branded sport keys, complete enabled capability sets, discriminated policy/cadence contracts, validated descriptors, market-branch and disabled-branch tests, and readonly cloned results.
- Avoids: false provider claims, incomplete “enabled” leagues, misleading unsupported markets, weakened compile-time identity, and mutable public snapshots.
- KEEP: every repair-1 and repair-2 invariant, especially data-only immutable config, package direction, deterministic reasons/reports, strict catalog consistency, and telemetry isolation.

### 2026-07-29 — Review repair 4
- Trigger: the fourth review found runtime enum/type values could bypass compile-time contracts, enabled completeness accepted inactive policies, unusable provider descriptors were not rejected eagerly, and source-mutation isolation was not directly proven.
- Amendment: required runtime enum/type validation, active required capabilities, structural descriptor validation, and post-construction source-mutation tests.
- Avoids: malformed untyped configuration entering reports, falsely complete enabled leagues, inert provider descriptors, and registry behavior changing after construction.
- KEEP: all earlier repair invariants and tests; exact provider pairs; branded types; immutable defaults/outputs; deterministic resolution/reporting; complete planned and disabled states.

### 2026-07-29 — Review repair 5
- Trigger: the fifth review found descriptor-wide markets recreated a cross-product across league pairs, planned/disabled completeness was not enforced, malformed runtime requests escaped deterministic validation, and byte stability was not tested across equivalent input permutations.
- Amendment: required per-league provider markets, completeness for every allowlist state, public request validation with non-odds market rejection, and serialized report equality across order/locale variations.
- Avoids: false market coverage, partial planned/disabled policy, raw request exceptions, misleading non-odds results, and input-order-dependent report bytes.
- KEEP: every invariant and regression test from repairs 1–4; no prior safeguard may be weakened or removed.

### 2026-07-30 — User resolution after non-convergence
- Trigger: the user approved capability-aware partial coverage after the completeness rule made `capability-unavailable` unreachable.
- Amendment: registered leagues may omit individual capabilities; missing policies resolve as `capability-unavailable`; provider capabilities and markets are both scoped per exact league pair; league-less support checks must evaluate every matching pair deterministically.
- Avoids: forcing fictional schedule/odds/results coverage and leaking one league’s provider capability into another league.
- KEEP: all validation, immutability, determinism, package-boundary, telemetry, secret-exclusion, and fixture/default-catalog safeguards from repairs 1–5.

## Review Triage Log

### 2026-07-29 — Review pass
- intent_gap: 0
- bad_spec: 13: (high 4, medium 8, low 1)
- patch: 0
- defer: 0
- reject: 4: (high 0, medium 1, low 3)
- addressed_findings:
  - `[high]` `[bad_spec]` Required nonempty active odds markets so empty arrays cannot become universal coverage.
  - `[high]` `[bad_spec]` Required distinct unregistered-league and missing-capability resolution paths.
  - `[high]` `[bad_spec]` Required observable resolution through injectable telemetry with logger-failure isolation.
  - `[high]` `[bad_spec]` Preserved package direction by forbidding config from importing providers.
  - `[medium]` `[bad_spec]` Required consistent active, allowlist, reason, provider, maturity, cadence, and quota metadata.
  - `[medium]` `[bad_spec]` Required safe-integer cadence/quota validation and nonblank identifiers.
  - `[medium]` `[bad_spec]` Required every planned league capability and telemetry failure path in tests.
  - `[low]` `[bad_spec]` Required canonical nonblank market-key validation.

### 2026-07-29 — Review pass
- intent_gap: 0
- bad_spec: 8: (high 3, medium 5, low 0)
- patch: 0
- defer: 0
- reject: 7: (high 0, medium 4, low 3)
- addressed_findings:
  - `[high]` `[bad_spec]` Required one noncontradictory policy per league capability and consistent league metadata across capabilities.
  - `[high]` `[bad_spec]` Required active coverage to reference a registered compatible provider descriptor.
  - `[high]` `[bad_spec]` Required immutable default policy snapshots so consumers cannot alter process-wide coverage.
  - `[medium]` `[bad_spec]` Required collision-safe composite keys and trimmed canonical identifiers.
  - `[medium]` `[bad_spec]` Required manual cadence to omit interval seconds.
  - `[medium]` `[bad_spec]` Required locale-independent report ordering and meaningful mutation/order regression tests.

### 2026-07-29 — Review pass
- intent_gap: 0
- bad_spec: 7: (high 3, medium 3, low 1)
- patch: 0
- defer: 0
- reject: 11: (high 0, medium 6, low 5)
- addressed_findings:
  - `[high]` `[bad_spec]` Required exact sport/league provider coverage pairs instead of independent-list cross-products.
  - `[high]` `[bad_spec]` Restored branded sport keys throughout provider coverage contracts.
  - `[high]` `[bad_spec]` Required enabled leagues to register all schedule, odds, and results policies.
  - `[medium]` `[bad_spec]` Required inactive policies to omit markets and provider descriptors to validate duplicate/numeric metadata.
  - `[medium]` `[bad_spec]` Required discriminated cadence/policy states and market/disabled branch tests.
  - `[low]` `[bad_spec]` Required readonly cloned resolution and report outputs.

### 2026-07-29 — Review pass
- intent_gap: 0
- bad_spec: 4: (high 1, medium 3, low 0)
- patch: 0
- defer: 0
- reject: 17: (high 0, medium 8, low 9)
- addressed_findings:
  - `[high]` `[bad_spec]` Required enabled leagues to resolve active schedule, odds, and results policies.
  - `[medium]` `[bad_spec]` Required deterministic runtime string and enum validation for untyped inputs.
  - `[medium]` `[bad_spec]` Required eager rejection of structurally unusable provider descriptors.
  - `[medium]` `[bad_spec]` Required direct proof that later source mutation cannot change registry behavior.

### 2026-07-29 — Review pass
- intent_gap: 0
- bad_spec: 4: (high 3, medium 1, low 0)
- patch: 0
- defer: 0
- reject: 17: (high 0, medium 9, low 8)
- addressed_findings:
  - `[high]` `[bad_spec]` Required provider market coverage per exact sport/league pair.
  - `[high]` `[bad_spec]` Required schedule, odds, and results completeness for planned and disabled leagues.
  - `[high]` `[bad_spec]` Required deterministic runtime request validation and rejection of non-odds market filters.
  - `[medium]` `[bad_spec]` Required byte-identical reports from equivalent differently ordered inputs.

### 2026-07-30 — Review pass
- intent_gap: 0
- bad_spec: 3: (high 3, medium 0, low 0)
- patch: 0
- defer: 0
- reject: 13: (high 0, medium 6, low 7)
- addressed_findings:
  - none

### 2026-07-30 — Review pass after user resolution
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 3, low 1)
- defer: 0
- reject: 17: (high 0, medium 8, low 9)
- addressed_findings:
  - `[medium]` `[patch]` Preserved the registered league allowlist state on omitted-capability results.
  - `[medium]` `[patch]` Made legacy `supportsRequest` reject malformed and non-odds market requests safely and consistently.
  - `[medium]` `[patch]` Required provider-level capabilities to equal the union of exact league-pair capabilities.
  - `[low]` `[patch]` Replaced stale all-capabilities-required wording in the story completion record.

## Design Notes

Treat unsupported coverage as ordinary domain output, not an exception. Reject invalid registry construction early; after construction, queries should be total and deterministic. Fixture/development descriptors establish contract readiness only and must not imply production provider approval.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test` -- expected: provider registry and coverage contracts pass.
- `pnpm --filter @find-the-edge/config test` -- expected: default catalog and report tests pass.
- `pnpm check` -- expected: lint, typecheck, unit tests, and build all succeed.

## Dev Agent Record

### Implementation Plan

- Define dependency-free feed policy, resolution, and reporting contracts in the domain package.
- Implement constructor-time validation and total deterministic resolution/reporting in providers.
- Compose the versioned fixture/development and planned league catalog from config.
- Verify the I/O matrix with focused tests, then run the complete repository quality gate.

### Debug Log

- Confirmed the provider test failed before implementation because the coverage registry module did not exist.
- Corrected strict optional-property test fixtures and lint-safe numeric assertions during validation.
- Review repair 1 rebuilt from the reverted baseline and confirmed the strengthened tests failed before implementation.
- Boundary validation identified the required narrow config-to-domain allowance; config remains independent of providers and providers consumes config only for default-catalog integration testing.
- Review repair 2 rebuilt from the reverted baseline and confirmed the new registry/config tests failed before implementation.
- Stale ignored build artifacts initially exercised the prior constructor signature; rebuilding focused packages refreshed them before verification.
- Review repair 3 rebuilt from the reverted baseline and confirmed the exact-pair, completeness, descriptor, disabled, market-filter, and readonly tests failed before implementation.
- A narrow type-only config-to-domain dependency preserves branded sport keys in data-only immutable config while retaining the prohibited config-to-providers boundary.
- Review repair 4 rebuilt from the reverted baseline and confirmed runtime malformed-input, inactive-completeness, unusable-descriptor, and source-mutation tests failed before implementation.
- Runtime guards now validate object/array/string/boolean/numeric shapes before reading discriminated policy or provider fields, preventing untyped values from escaping as incidental JavaScript errors.
- Review repair 5 modeled provider markets on each exact sport/league pair, added all-state three-capability completeness checks, and made public request failures deterministic typed validation errors.
- The report serializer uses code-unit ordering for entries and market keys, producing byte-identical JSON from equivalent policy/descriptor permutations without locale-sensitive comparison.
- User-resolution implementation replaced the superseded completeness rule with partial registered-league policies while preserving eager rejection of any explicitly inactive enabled policy.
- Provider descriptors now scope both capabilities and markets to each exact sport/league pair; league-less support checks examine all matching pairs with order-independent boolean semantics.
- Final review patch carries league allowlist metadata into omitted-capability results, makes legacy support checks safely reject malformed/non-odds requests, and reconciles provider-level capabilities with the exact union of pair declarations.

### Completion Notes

- Added explicit supported and unsupported feed resolution contracts with stable reason codes.
- Added deterministic duplicate/ambiguity/market validation, safe structured resolution logging, and versioned reporting.
- Added 18 default league-capability states: working fixture coverage for MLB/MLS and planned states for tennis, NFL, NBA, and international soccer.
- Focused provider/config tests and the full `pnpm check` quality gate pass.
- Review repair 1 added strict canonical identifier, market, cadence, quota, and metadata-consistency validation.
- Resolution now distinguishes unregistered leagues from missing capabilities and isolates supported and unsupported results from telemetry failures.
- The config catalog is data-only, every planned capability is exercised, and deterministic default reports are versioned and checked for sensitive/commercial fields.
- Review repair 2 validates a single policy per league capability, cross-capability league metadata, and active policies against registered compatible provider descriptors.
- Collision-safe nested indexes, trimmed canonical values, strict manual cadence semantics, immutable default snapshots, and locale-independent report comparison now preserve deterministic behavior.
- Mutation, ordering, descriptor mismatch, whitespace, collision, telemetry, and all retained repair-1 invariants are covered by focused tests.
- Review repair 3 restores branded `SportKey` end to end and models cadence and active/inactive policies as discriminated domain unions.
- Provider coverage now uses exact sport/league pairs, validates descriptor uniqueness and numeric metadata, and rejects cross-pair claims.
- Every explicitly registered enabled capability must be active and provider-backed; inactive and non-odds market metadata is rejected; disabled and market-filtered resolution branches are tested.
- Supported, unsupported, and report outputs are deeply frozen cloned snapshots, and all focused/full quality gates pass.
- Review repair 4 adds deterministic runtime enum and primitive-type validation for policies, cadence, and provider descriptors.
- Every explicitly registered enabled capability must be active; omitted capabilities remain valid and resolve as unavailable.
- Empty capabilities, coverage pairs, or odds markets and invalid descriptor metadata are rejected eagerly.
- Policies and descriptors are cloned before indexing, with tests proving later source mutation cannot alter resolution or reports.
- Review repair 5 completes schedule/odds/results enforcement for enabled, planned, and disabled leagues while requiring every enabled capability to be active.
- Provider market compatibility is now evaluated per exact sport/league pair; malformed requests and non-odds market filters fail with `CoverageRegistryValidationError`.
- Equivalent registries produce byte-identical reports regardless of policy, descriptor, pair, capability, or market input ordering; focused tests and the full `pnpm check` gate pass.
- The approved partial-coverage model now returns `capability-unavailable` for omitted enabled, planned, or disabled capabilities while retaining the configured reason for explicitly registered inactive policies.
- Pair-scoped provider capability validation prevents capabilities from leaking across leagues, and `supportsRequest` without a league succeeds when any matching exact pair supports the requested capability and markets regardless of descriptor pair order.
- Focused config/provider suites and the full workspace `pnpm check` quality gate pass after the user-resolution implementation.
- Omitted enabled, planned, and disabled capability results retain the registered league allowlist state; the legacy predicate safely returns false for malformed shapes and non-odds market filters.
- Provider top-level capabilities must exactly equal the union of pair-level declarations, rejecting both stale extras and missing declarations.

## File List

- packages/config/package.json
- packages/config/src/feed-coverage.ts
- packages/config/src/index.test.ts
- packages/config/src/index.ts
- packages/domain/src/index.ts
- packages/observability/src/index.ts
- packages/providers/package.json
- packages/providers/src/coverage-registry.test.ts
- packages/providers/src/coverage-registry.ts
- packages/providers/src/index.ts
- pnpm-lock.yaml
- scripts/check-boundaries.mjs

## Change Log

- 2026-07-29: Implemented FTE-DATA-001 feed coverage registry, default league allowlist catalog, reporting, observability context, validation, and tests.
- 2026-07-29: Review repair 1 preserved the KEEP decisions while adding strict validation, reason-path separation, telemetry isolation, complete planned-capability coverage, and config/provider boundary correction.
- 2026-07-29: Review repair 2 added provider-backed policy validation, cross-capability consistency, collision-safe indexing, canonicalization, manual cadence semantics, immutable defaults, and locale-independent reporting.
- 2026-07-30: Review repair 3 added branded/discriminated contracts, exact provider coverage pairs, enabled-league completeness, descriptor integrity, market/disabled branches, and readonly cloned outputs.
- 2026-07-30: Review repair 4 added runtime input validation, active completeness, unusable-descriptor rejection, and post-construction source-mutation isolation.
- 2026-07-30: Review repair 5 added per-pair market coverage, all-state capability completeness, deterministic public request validation, and byte-stable permutation-independent reports.
- 2026-07-30: Implemented the approved partial-capability policy, pair-scoped provider capabilities and markets, and deterministic league-less support checks.
- 2026-07-30: Final review patch added omitted-capability allowlist metadata, safe legacy request rejection, and exact provider capability-union validation.

## Status

done

## Auto Run Result

Status: done

Summary: Implemented a versioned feed coverage registry and league allowlist with partial capability coverage, exact provider league-pair capability and market scoping, deterministic unsupported reasons and reports, immutable safe outputs, runtime validation, and failure-isolated structured telemetry.

Files changed:

- `packages/domain/src/index.ts` — feed coverage, policy, cadence, resolution, and report contracts.
- `packages/providers/src/index.ts` — exact league-pair provider coverage and safe support checks.
- `packages/providers/src/coverage-registry.ts` — validation, deterministic resolution/reporting, and telemetry.
- `packages/providers/src/coverage-registry.test.ts` — registry, partial coverage, provider compatibility, immutability, and edge-case tests.
- `packages/config/src/feed-coverage.ts` — immutable MLB/MLS fixture coverage and planned league policies.
- `packages/config/src/index.ts`, `packages/config/src/index.test.ts` — catalog exports and configuration tests.
- `packages/observability/src/index.ts` — coverage resolution log context.
- `packages/config/package.json`, `packages/providers/package.json`, `pnpm-lock.yaml`, `scripts/check-boundaries.mjs` — dependency and boundary updates.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story lifecycle status.

Review findings: four final patches applied, no items deferred, and seventeen context-free suggestions rejected as superseded, intentional, speculative, or outside this story.

Follow-up review recommendation: true, because review-driven changes altered public provider capability scoping and partial-coverage behavior.

Verification: provider and config focused tests passed; full `pnpm check` passed; `git diff --check` passed.

Residual risks: fixture/development coverage proves contracts only and does not represent production provider approval or paid API activation.
