---
title: 'FTE-017 Event Status and Data Freshness Indicators'
type: 'feature'
created: '2026-08-04'
status: 'in-review'
baseline_revision: 'c362792f1d738ac410ecef06d1bb93c1464efa52'
review_loop_iteration: 1
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-016-event-repository-api-and-pagination.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Game responses expose a raw lifecycle state and timestamp, but users cannot tell whether metadata is current, stale, partial, or unavailable. Missing or old facts can therefore look trustworthy, especially on the dense games screen.

**Approach:** Derive a deterministic, versioned event-metadata assessment from canonical status and freshness at one fixed evaluation time, add it to API responses without rewriting stored projections, and render accessible lifecycle and freshness badges on game cards and detail views.

## Boundaries & Constraints

**Always:** Keep raw ISO timestamps and existing status fields for compatibility; derive lifecycle, availability, freshness, age, threshold, reason codes, and missing-data reasons in the domain; use a server-owned two-hour metadata threshold matching the hourly discovery cadence plus tolerance; treat exactly two hours as current and only greater age as stale; treat missing, malformed, or future timestamps as unavailable; treat unknown lifecycle as partial and never scheduled/verified; keep stale records visible with evidence time; keep postponed/cancelled independent of freshness; evaluate every paginated list against its fixed snapshot and detail against one captured instant; make uninitialized projections explicitly unavailable at envelope level; reject corrupt stored records rather than disguising them as unavailable; log only low-cardinality stale/partial/unavailable counts; use text/icon/ARIA semantics rather than color alone.

**Block If:** Correct classification would require inventing a provider lifecycle mapping, substituting a browser clock for server evaluation, changing the canonical projection schema, or accepting placeholder facts as verified.

**Never:** Infer postponement/cancellation from missing odds; persist derived freshness into DynamoDB; use odds/splits freshness rules for event metadata; hide stale games; label recent data verified merely because it is recent; expose provider payloads or timestamps as metric dimensions; reintroduce authentication; implement the full Events Explorer filtering story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Current scheduled event | Known status and age at or below two hours | Complete, scheduled, current with exact evidence time and age | No error expected |
| Stale event | Known status older than two hours | Visible event with stale warning and timestamp | Never silently remove or mark unavailable |
| Unknown lifecycle | `unknown` with valid timestamp | Partial availability and lifecycle-unavailable reason | Never relabel scheduled |
| Missing/invalid/future time | Null, malformed, or after evaluation time | Unavailable freshness and explicit missing reason | Corrupt persisted projection still fails closed |
| Postponed/cancelled | Lifecycle state with any freshness state | Distinct lifecycle badge plus independent freshness badge | Never infer from odds absence |
| Continued page | Opaque cursor with original snapshot | Same event gets same assessment across page traversal | Cursor/snapshot mismatch remains invalid |
| Uninitialized projection | No readable game projection | Empty envelope with unavailable reason | Never claim complete/current data |

</intent-contract>

## Code Map

- `packages/domain/src/event-metadata.ts` -- canonical policy, reason codes, derivation, validation, and deterministic boundaries.
- `packages/domain/src/index.ts` -- exports and additive `EventDisplayDto` metadata contract.
- `packages/database/src/event-read-projection.ts` -- derives assessments from trusted canonical status/freshness.
- `packages/database/src/{event,dynamodb-event}-repository.ts` -- fixes evaluation time to page snapshot/detail read and explains uninitialized envelopes.
- `apps/api/src/handler.ts` -- returns the additive contract and emits bounded freshness/availability counts.
- `packages/ui/src/event-metadata.ts` -- reusable accessible label/tone/icon mapping for lifecycle and freshness.
- `apps/web/src/{api,App,styles}.ts*` -- strict validation and visible badges on games and detail.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/event-metadata.ts`, `packages/domain/src/index.ts`, and tests -- define exact metadata policy, lifecycle/freshness/availability reasons, two-hour boundary, deterministic assessment, validation, and additive DTO fields.
- [x] `packages/database/src/event-read-projection.ts`, `packages/database/src/{event,dynamodb-event}-repository.ts`, and tests -- assess list rows at the cursor snapshot and detail at one trusted instant; surface uninitialized reasons without changing stored schema or masking corruption.
- [x] `apps/api/src/handler.ts` and tests -- serialize current/stale/partial/unavailable/postponed/cancelled states and emit low-cardinality stale, partial, and unavailable counts.
- [x] `packages/ui/src/event-metadata.ts`, exports, and tests -- map every lifecycle/freshness state to distinct accessible display text, tone, and non-color cue.
- [x] `apps/web/src/{api,api.test,App,App.test,styles}.ts*` and package dependency -- strictly validate the contract, reject contradictions, and render badges/timestamps on dense game cards and game detail with loading/error/legacy-unavailable coverage.
- [x] `_bmad-output/implementation-artifacts/sprint-status.yaml` and release checks -- record completion and verify all affected packages, browser smoke, and full repository quality gates.

**Acceptance Criteria:**
- Given any canonical event status and trusted evaluation instant, when metadata is derived, then lifecycle, availability, freshness, age, threshold, reason codes, and missing reasons are deterministic and no placeholder is represented as verified.
- Given metadata exactly two hours old, just over two hours old, absent, malformed, or future-dated, when returned, then it is respectively current, stale, unavailable, unavailable, or unavailable with the correct safe reason.
- Given an unknown, postponed, or cancelled event, when serialized and rendered, then the lifecycle label remains distinct from its independent freshness label and uses accessible text/non-color cues.
- Given a multi-page list, when an event is assessed on any page, then the original snapshot time is used and classification cannot drift during traversal.
- Given an uninitialized projection or stale/partial results, when the API responds, then it explains availability and logs bounded counts without exposing identifiers/provider data in dimensions.
- Given a malformed, missing, contradictory, or forged metadata object, when the web client parses it, then the response is rejected rather than displayed as trustworthy.

## Spec Change Log

- 2026-08-04: Implemented the versioned two-hour metadata policy, snapshot-stable repository assessment, explicit uninitialized envelopes, bounded API telemetry, reusable accessible badges, strict client validation, dense-card/detail presentation, and focused/full/e2e verification. Story marked done.

## Review Triage Log

### 2026-08-04 — Adversarial review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 7 (high 2, medium 5, low 0)
- defer: 0
- reject: 3
- rejected_findings:
  - Expanding the games and splits endpoints beyond scheduled events belongs to FTE-018 Events Explorer and would violate this story's explicit boundary.
  - Expanding game detail discovery beyond the scheduled list belongs to FTE-018 and is not required for metadata classification.
  - Replacing the scheduled-only splits navigation path is likewise deferred to the filterable lifecycle explorer rather than being smuggled into FTE-017.
- addressed_findings:
  - Added explicit user-facing reason text for current, stale, missing, malformed, future, and unknown-lifecycle evidence; future audit timestamps are retained in the response but never rendered as trustworthy evidence.
  - Replaced order-sensitive domain and web metadata comparison with exact structural/value validation.
  - Closed every contradictory uninitialized-envelope shape.
  - Bound each ready page's freshness to its minimum canonical item freshness and preserved that invariant across pagination.
  - Added pure-UI and component coverage across current, stale, unavailable, unknown, postponed, and cancelled states.
  - Added a reusable all-lifecycle status validator while preserving scheduled-only games list enforcement.

## Design Notes

Freshness describes how old event metadata evidence is; lifecycle describes what the event is doing. They are orthogonal. Derived assessment remains read-time metadata so existing rows gain safe semantics immediately without a table migration. The full postponed/cancelled filterable Events Explorer remains FTE-018; this story provides the trustworthy contract and reusable badges now.

## Verification

Completed successfully on 2026-08-04: every focused package test, `pnpm check`, `pnpm test:e2e`, and `git diff --check`.

**Commands:**
- `pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/database test`
- `pnpm --filter @find-the-edge/api test`
- `pnpm --filter @find-the-edge/ui test`
- `pnpm --filter @find-the-edge/web test`
- `pnpm check`
- `pnpm test:e2e`
- `git diff --check`
