---
title: 'Recover Phase 1 Transient SharpAPI Contract Failures'
type: 'bugfix'
created: '2026-08-07T10:25:00-04:00'
status: 'done'
baseline_commit: 'e80ed6c7c09ccd30a07866f73bdab6056983f3fc'
final_revision: '33106f5'
review_loop_iteration: 3
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003c-production-odds-collection-control-plane.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-mvp-001d-phase1-deployment-and-environment-smoke.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Phase 1 release verification fails immediately when SharpAPI returns a transient structurally invalid odds page, even though the provider adapter retries the page, the durable control plane preserves recovery state, and a subsequent local replay can succeed. This turns provider recovery into a failed deployment while later leagues report only `provider-recovering`.

**Approach:** Keep the strict SharpAPI parser and immediate identical-page retry, but let the already bounded release smoke retry a closed set of recoverable provider outcomes until every league reaches the existing strict success contract or the recovery deadline expires.

## Boundaries & Constraints

**Always:** Reproduce locally; preserve exact result-shape validation; retry only recognized provider availability, throttling, recovery, and contract-shape outcomes; retain the 17-minute deadline and bounded attempt count; require eventual `completed`/valid `skipped` results before API/browser verification; redact provider payloads and secrets.

**Ask First:** Any parser relaxation that accepts semantically ambiguous odds, any longer release deadline, or any provider-plan/configuration change.

**Never:** Treat authorization, entitlement, provider rejection, mapping, persistence, pagination, or internal failures as transient; accept partial ingestion as release success; deploy to test; log licensed response fields; clear provider health or durable continuations.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Transient contract page | One league fails `invalid-response`; others complete/recover | Smoke waits and invokes again; durable run resumes | Deadline exhaustion preserves the original bounded failure |
| Provider throttle/outage | League reports rate limit, cooldown, unavailable, or recovering | Smoke retries within the existing budget | Provider rejection/auth/entitlement fails immediately |
| Persistent malformed response | Every retry remains invalid | Release fails; hosted rollback remains active | Never reinterpret malformed odds as valid |
| Healthy retry | All leagues complete or validly skip | Continue strict API and browser checks | N/A |

</frozen-after-approval>

## Code Map

- `scripts/phase1-environment-smoke.mjs` -- classifies bounded live-ingestion summaries and controls retry/deadline behavior.
- `scripts/phase1-environment-smoke.test.mjs` -- proves exact transient and terminal classifications without AWS or provider calls.
- `packages/providers/src/sharp-api.ts` -- strict parser retained unchanged; used for local read-only Liga MX replay evidence.
- `apps/workers/src/production-odds-control-plane.ts` -- durable page reconstruction retained unchanged; used for local replay evidence.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/phase1-environment-smoke.mjs` -- classify only closed, recoverable provider results for bounded retry while keeping final summary assertion strict.
- [x] `scripts/phase1-environment-smoke.test.mjs` -- add mixed Liga MX invalid/recovering regression plus rate-limit/outage and terminal counterexamples.

**Acceptance Criteria:**
- Given a safe five-league summary containing completed leagues, one failed `invalid-response`, and recovering leagues, when release recovery evaluates it, then it retries rather than failing immediately.
- Given the same recoverable summary persists through the deadline, when recovery is exhausted, then release verification fails and does not continue to API/browser success checks.
- Given unauthorized, not-entitled, provider-rejected, mapping, storage, pagination, or internal failure, when the summary is evaluated, then it is not transient and fails immediately.
- Given current Liga MX odds pages, when fetched and reconstructed locally, then strict parsing succeeds without parser relaxation or external persistence.

## Spec Change Log

- 2026-08-07: Confirmed current Liga MX odds locally without persistence: three strict adapter pages (200/200/124 rows) reconstructed into 19 normalized events with no parser or cross-page conflict. Kept parser semantics unchanged and added bounded release recovery for transient provider contract/availability outcomes; terminal product, access, mapping, pagination, storage, and internal failures remain immediate failures.

## Review Triage Log

### 2026-08-07 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 1 (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Compact all-league `schedule-provider-recovering` summaries accepted by the final assertion omitted page/quota fields and were misclassified as complete; the final assertion and recovery classifier now share one validator for the two exact compact shapes, retry within the existing ceiling, and reject added fields or non-Sharp provider identities.

### 2026-08-07 — Review pass 2

- intent_gap: 0
- bad_spec: 0
- patch: 1 (high 1, medium 0, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` A structurally safe `skipped` result could previously carry a terminal or retry-only failure reason and fall through the recovery action as complete. Skipped outcomes now use the control plane's exact closed reason set: cadence and quota remain legitimate completion skips, cooldown and recovery remain bounded retry skips, and access, provider rejection, mapping, pagination, internal, or invalid-response reasons fail the assertion and classify as terminal.

### 2026-08-07 — Review pass 3

- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 0
- result: Clean focused sign-off. Cadence and quota skips complete, cooldown and recovery skips retry within the existing ceiling, and every other skipped failure remains terminal.

## Design Notes

`isTransientLiveIngestionSummary` authorizes another bounded attempt; it does not authorize success. `assertLiveIngestionSummary` remains the sole success gate and continues rejecting failed league results.

## Verification

**Commands:**
- `node --test scripts/phase1-environment-smoke.test.mjs` -- all smoke contract tests pass locally.
- `pnpm phase1:test` -- all Phase 1 tests pass locally.
- `pnpm check` -- run the repository quality gate; distinguish failures outside this spec's files.
- `git diff --check` -- no whitespace errors.

**Local evidence (2026-08-07):**

- `node --test scripts/phase1-environment-smoke.test.mjs` -- 15/15 passed.
- `pnpm phase1:test` -- 73/73 passed.
- `pnpm check` -- formatting, lint, boundaries, type checks, all workspace tests, and all builds passed on the final combined tree.
- `git diff --check` -- passed.
