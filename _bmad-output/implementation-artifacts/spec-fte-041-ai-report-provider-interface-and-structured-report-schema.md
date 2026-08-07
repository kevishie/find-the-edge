---
title: 'FTE-041: AI Report Provider Interface and Structured Report Schema'
type: 'feature'
created: '2026-08-07'
status: 'in-review'
baseline_revision: 'af4213a4ca98cda85dbbc0995bbc988b8ff9d3ec'
review_loop_iteration: 7
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-7-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-040-provider-backed-scouting-input-contract-and-development-stub.md'
  - '_bmad-output/implementation-artifacts/spec-fte-031-calculation-versioning-precision-and-display-rounding.md'
warnings: [oversized]
---

<intent-contract>

## Intent

**Problem:** Scouting has validated provider evidence and deterministic betting calculations, but no strict report-generation boundary. An AI draft could omit required sections, promote unsupported claims, spoof provenance, or recalculate authoritative betting values before persistence.

**Approach:** Add a provider-neutral structured-report model port plus a consumer-owned validator driven by a sport-module-owned report contract. AI output is limited to bounded cited narrative and interpretations; the validator binds it to trusted scouting facts, deterministic calculation references, prompt/model metadata, and the fixed soccer section sequence.

## Boundaries & Constraints

**Always:** Consume a validated FTE-040 input and treat model output as hostile `unknown`; validate exact versioned objects without invoking accessors; return every module-declared section in order, inserting honest unavailable placeholders for omitted sections; bind event/version, sport/module, strategy, scouting-input hash, prompt bundle, expected/actual model identity, evidence citations, and deterministic references from trusted context; return immutable canonical output with a draft hash for FTE-042. Facts inherit state/provenance from FTE-040 and calculation values inherit immutable snapshots plus version/hash/reference metadata from FTE-031. Log only bounded codes, versions, hashes, usage, latency, counts, and validation outcome.

**Block If:** Implementation needs a production model/vendor choice, credential, prompt optimization decision, report persistence/version numbering, workflow lifecycle change, UI decision, or a new betting formula/threshold.

**Never:** Let model output author provider provenance, factual verification/freshness/confidence, numeric odds/probability/fair-price/EV/Kelly/CLV/qualification/line-movement results, Final Plays, or Nuke/PASS eligibility. Never add report IDs/versions, generation timestamps, prior-version changes, or storage validation fields owned by FTE-042; log prompts, narrative, event/participant IDs, raw inputs/model responses, credentials, or restricted payloads; change the existing PICK analysis adapter. Do not add network adapters, AWS/IAM, database records, migrations, worker orchestration, or report UI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Valid draft | Ordered supplied sections with authorized fact/calculation citations | Frozen canonical report content, trusted metadata, and stable draft hash | No error |
| Missing evidence | Required section lacks usable facts/calculations | Section remains present as unavailable or partial with bounded reason | Reject fabricated narrative or upgraded state |
| Deterministic analysis | AI references an authorized calculation | Final document exposes the trusted reference/metadata, never model-authored math | Reject unknown refs and numeric authority fields |
| Hostile output | Extra keys, duplicate/misordered supplied sections, dangling citations, forged math/decisions, cycles/accessors, oversize/control/secret-like content | No partial report | Stable safe validation error without payload echo |
| Provider failure | Disabled/throwing/aborted model port | No validated report | Typed bounded provider failure; metadata-only telemetry |

</intent-contract>

## Code Map

- `packages/sports/src/shared/scouting-report.ts`, `shared/contracts.ts`, and registered module definitions -- generic executable report contract owned by each sport module; soccer alone owns its fourteen section keys/titles and section evidence allowances.
- `packages/sports/src/soccer/scouting-report.ts` and tests -- exact Match Snapshot through Nuke or Pass contract, stable order, and unavailable behavior.
- `packages/scouting/src/report-model-port.ts` and tests -- provider-neutral request/result/error contract, disabled adapter, and fake adapter; untrusted output remains `unknown` and trusted model/deployment/usage metadata stays separate.
- `packages/scouting/src/report-prompt.ts` and tests -- deterministic length-framed separation of trusted instructions, request identities, untrusted facts, and deterministic reference manifests without prompt logging.
- `packages/scouting/src/scouting-report.ts` and tests -- trusted validation context, exact hostile-output validation, citation/reference binding, deterministic boundary enforcement, immutable canonical result, and safe telemetry events.
- `packages/odds/src/report-reference.ts` and tests -- construct immutable report references from existing calculation results/provenance and snapshot identities without recomputing any betting value.
- `packages/test-utils/src/scouting-report-contract.test.ts` and manifests -- real cross-package conformance proving soccer and a non-soccer test contract work without shared sport branches.
- Public exports, package manifests, lockfile, Epic 7 context, and sprint status -- additive wiring and story routing only.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sports/src/shared/scouting-report.ts`, `shared/contracts.ts`, module definitions, and tests -- define and validate a versioned sport-owned ordered-section contract with canonical unique keys/titles, bounded section count, allowed fact/calculation categories, and honest unavailable-only planned-module contracts.
- [x] `packages/sports/src/soccer/scouting-report.ts` and tests -- publish the exact fourteen required soccer sections in product order and declare which scouting capabilities and deterministic calculation kinds each section may cite; keep all soccer vocabulary out of shared scouting code.
- [x] `packages/scouting/src/report-model-port.ts`, tests, and export -- add a capability-neutral async port whose request binds schema/prompt/input/calculation identities and whose result separates hostile output from trusted model/deployment/usage metadata; provide disabled and deterministic fake adapters with abort-safe typed errors.
- [x] `packages/odds/src/report-reference.ts`, tests, and export -- project existing consensus, fair-value, qualification, movement, disagreement, and CLV results into event/version/market/selection/snapshot-bound immutable references carrying raw/display output and exact FTE-031 provenance; reject mismatches and never recalculate values.
- [x] `packages/scouting/src/report-prompt.ts`, tests, and export -- build deterministic length-framed model requests with trusted instructions separated from untrusted normalized facts/calculation references; make equivalent set order stable and material version/input changes alter the request hash.
- [x] `packages/scouting/src/scouting-report.ts`, tests, and export -- validate a bounded draft against trusted event/module/strategy, validated scouting input, prompt metadata, expected/actual model result, and deterministic reference manifest; inject inherited fact/provenance/calculation metadata and deterministic Final Plays/PASS state; insert omitted sections as unavailable; reject unsupported citations, state upgrades, forged math/decisions, secret-like content, unknown keys, unsafe objects, and reordered supplied sections; deep-freeze the canonical result and hash.
- [x] `packages/scouting` telemetry tests -- emit metadata-only started/succeeded/failed events with stable reason codes and no prompt, narrative, evidence values, raw output, deployment secrets, or error echo.
- [x] `packages/test-utils/src/scouting-report-contract.test.ts`, manifests, and lockfile -- prove the real port/validator/module boundary accepts a complete soccer fixture, keeps missing sections explicitly unavailable, rejects hallucinated facts/math, and supports an unrelated sport contract without core edits.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` -- keep FTE-041 in progress through review; completion routes FTE-042.

**Acceptance Criteria:**
- Given any registered module report contract, when a complete or partial model draft validates, then every declared section appears exactly once in module order, omitted content becomes unavailable, reordered/extra/duplicate sections fail, and shared code contains no sport-name branch.
- Given verified, inferred, stale, conflicting, or unavailable scouting evidence, when cited by narrative, then the final report inherits the trusted state and provenance without model-controlled promotion; absent support stays visible as partial/unavailable.
- Given deterministic market inputs, when the report references analysis, then authoritative values, snapshots, versions, Final Plays, and PASS/qualification state come only from trusted calculation references and cannot be supplied or changed by the model; absent deterministic qualification produces PASS/No Bet or unavailable, never an invented Nuke.
- Given malformed, hostile, oversized, secret-like, mismatched, or dangling model output, when validation runs, then it fails atomically with a stable safe error and metadata-only telemetry.
- Given disabled, failed, or aborted generation, when the port resolves, then no report is accepted and no paid/network implementation or sensitive payload logging is introduced.
- Given the full workspace verification, when FTE-041 completes, then persistence, report versions, worker completion, UI rendering, production model credentials, and betting formulas remain unchanged.

## Spec Change Log

## Review Triage Log

- **Pass 1 — Blind Hunter + Edge Hunter:** 26 raw findings, deduplicated to 16 actionable issues (9 high, 7 medium). Addressed all: exact hostile schemas, request/frame/sport binding, authenticated snapshot/reference material, bounded provider errors, abort-safe adapters, pre-provider context validation, deterministic citation rejection, recursive immutability, usable-evidence enforcement, and metadata-only telemetry validation. No findings were deferred or rejected.
- **Pass 2 — fresh Blind Hunter + Edge Hunter:** 18 raw findings, deduplicated to 13 actionable issues (8 high, 5 medium). Addressed all: deep per-kind calculation-result validation, exact CLV/status constraints, trusted prompt-instruction binding, outer snapshot identity checks, canonical reference ordering, non-available evidence handling, broader authority rejection, orchestration-level abort racing, deterministic classification and play-only Final Plays policy, retry-stable draft hashing, and bounded serialization failure. No findings were deferred or rejected.
- **Pass 3 — fresh Blind Hunter + Edge Hunter:** 21 raw findings, deduplicated to 12 actionable issues (9 high, 3 medium). Addressed all: odds-owned hydrated-reference validation, calculation/evidence binding, full consensus/qualification/movement/disagreement/CLV invariants, canonical citation ordering, recommendation-language rejection, unavailable-only exactness, prompt-reference runtime validation, and pre-provider size proof. No findings were deferred or rejected.
- **Pass 4 — fresh Blind Hunter + Edge Hunter:** 18 raw findings, deduplicated to 13 actionable issues. Addressed all: exact production-calculator replay, provenance input-hash binding, authentic invalid-consensus semantics, move-and-return history, snapshot-value binding, disagreement and closing-consensus invariants, natural recommendation rejection, UTF-8 capacity proof, and pre-provider expected-model validation. No findings were deferred or rejected.
- **Pass 5 — final Blind + Edge sign-off:** 7 actionable issues. Addressed all: same-sportsbook movement, snapshot-derived disagreement vectors, duplicate qualification-book rejection, trusted-instruction bounds, Unicode-format normalization, and additional recommendation forms. No findings were deferred or rejected.
- **Pass 6 — focused re-review:** 2 actionable issues. Addressed both: shared prompt/consumer instruction validation and mixed-script plus natural-language recommendation defenses with benign multilingual counterexamples. No findings were deferred or rejected.
- **Pass 7 — final focused sign-off:** Clean. The reviewer verified recommendation bypasses, benign multilingual evidence, and exact prompt-builder/consumer parity; 158 scouting tests, typecheck, and lint passed.

## Design Notes

The AI draft contains only supplied section keys plus bounded classified narrative and citation/reference IDs; it cannot author titles, states, calculations, recommendations, or disposition. The canonical document is assembled from trusted context. A calculation ID resolves to an immutable event/version/market/selection/snapshot-bound descriptor carrying authoritative raw/display output and FTE-031 provenance. The architecture sketch's report ID, version, generation time, validation state, and previous-version changes are deliberately deferred to FTE-042.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/sports test && pnpm --filter @find-the-edge/sports typecheck && pnpm --filter @find-the-edge/sports lint`
- `pnpm --filter @find-the-edge/scouting test && pnpm --filter @find-the-edge/scouting typecheck && pnpm --filter @find-the-edge/scouting lint`
- `pnpm --filter @find-the-edge/test-utils test && pnpm boundaries`
- `pnpm check && git diff --check && git diff --cached --check`
