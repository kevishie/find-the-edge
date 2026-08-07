---
title: 'FTE-037: Provider Health and Quota Dashboard States'
type: 'feature'
created: '2026-08-07'
status: 'done'
baseline_revision: '94de6f5822afd7dd1f3ae423d45e2c259c2dece1'
final_revision: '14279239f70ab25c5d43725c30ad33ddbfd2b9d5'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-6-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-024-provider-quota-retry-dlq-and-suspended-partial-states.md'
  - '_bmad-output/implementation-artifacts/spec-fte-036-dashboard-layout-and-ev-opportunity-cards.md'
warnings:
  - oversized
---

<intent-contract>

## Intent

**Problem:** SharpAPI health and rate-window evidence is persisted and already gates opportunity qualification, but the public product cannot explain an outage, stale feed, partial coverage, or capacity pause. Missing evidence therefore looks like an unexplained blank screen and there is no Data Sources view for operational trust.

**Approach:** Publish one sanitized, server-authored provider-status contract over exact configured health keys; show its compact impact summary on Dashboard and its full capability/league detail on a new public Data Sources page. Preserve the provider control plane as authority and present request-window capacity independently from connection health and subscription quota.

## Boundaries & Constraints

**Always:** Use the production SharpAPI coverage/cadence catalog rather than the fixture registry or a DynamoDB scan. Preserve a durable last-success timestamp across later failure records and derive stale status on the server from configured cadence. Model connection (`healthy`, `partial`, `stale`, `outage`, `unknown`) independently from request-window capacity (`available`, `low`, `reserve-protected`, `exhausted`, `unknown`). Treat absent headers and expired windows as unknown; identify them as provider request-window capacity, never monthly/plan quota. Return stable, versioned, deterministically ordered public DTOs with a bounded safe-reason allowlist and server-authored recommendation impact. Keep valid ranked cards governed solely by the opportunity API; a status request failure or newer health snapshot may warn but must not make React qualify, rank, suppress, or revive an opportunity. Use text plus color, semantic lists/definitions, labelled meters, Eastern timestamps, accessible retry/loading states, and responsive navigation.

**Block If:** A requested status requires raw provider/account payloads, API keys, plan identifiers, internal health keys, failure stages, or high-cardinality diagnostics; the status catalog cannot identify an exact provider/league/capability key; or the work would require client-side opportunity qualification.

**Never:** Expose secrets, raw error messages, account tier/features, sportsbook entitlement internals, internal Dynamo keys, or ambiguous legacy `quotaRemaining` as authoritative capacity; infer health from missing opportunities; scan the table; call a low request window an outage; call missing telemetry healthy; erase historical odds or active cards from the status UI; restore authentication; deploy merely to test; or fabricate provider support, quota, timestamps, or recovery estimates.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Healthy known window | Fresh healthy record with bounded limit/remaining/reset | Healthy connection, exact request capacity and reset, no recommendation warning | No error expected |
| Unknown capacity | Healthy record with absent/expired/malformed window evidence | Healthy connection with “capacity unknown” | Never substitute zero or legacy plan quota |
| Reserve/exhausted | Authoritative remaining at/below configured reserve or zero before reset | Distinct reserve-protected/exhausted capacity state and reset time | Do not label as provider outage |
| Partial or stale | Degraded record or last update beyond capability cadence | Exact affected scope, safe reason, last success, and limited/suppressed server impact | Unaffected scopes remain visible |
| Outage/recovery | Unhealthy record then later success | Outage shows safe category/retry time; recovery becomes healthy and retains correct latest success | Never surface raw provider failure text |
| Missing/partial read | Expected key absent or one exact read fails | Unknown row or page `partial` state; verified siblings remain visible | Do not imply every provider is unhealthy |
| Status endpoint failure | Provider-status request fails while opportunities are valid | Dashboard cards remain; status module is unavailable with retry | No client-side requalification |

</intent-contract>

## Code Map

- `packages/domain/src/provider-status.ts`, `packages/domain/src/index.ts` -- shared immutable public status DTO vocabulary and bounded enums.
- `packages/config/src/feed-coverage.ts` -- canonical production provider-status catalog, expected health keys, cadences, reserves, and supported data.
- `packages/database/src/odds-control-plane.ts` -- optional durable last-success evidence and exact-key batch health reads with memory/Dynamo parity.
- `apps/workers/src/odds-control-plane.ts`, `apps/workers/src/production-odds-control-plane.ts` -- preserve success/failure chronology and partial/degraded evidence through health transitions.
- `apps/api/src/provider-status.ts` -- pure sanitization, freshness/capacity/impact derivation, deterministic aggregation, and partial-read behavior.
- `apps/api/src/handler.ts`, `apps/api/src/lambda.ts` -- public provider-status route, dependency wiring, safe errors, and low-cardinality request metrics.
- `infra/cdk/src/foundation.ts`, `infra/cdk/src/foundation.test.ts` -- public API route, exact-read IAM, SPA rewrite for `/data-sources`, and API observability.
- `apps/web/src/api.ts` -- strict no-credential provider-status transport and hostile-response validation.
- `apps/web/src/provider-status.tsx` -- shared compact Dashboard summary and full Data Sources presentation.
- `apps/web/src/dashboard.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css` -- query integration, route/navigation, responsive accessible visual states.
- API, worker/database, web, and `tests/e2e/app-shell.spec.ts` tests -- state matrix, security, recovery, navigation, and overflow coverage.

## Tasks & Acceptance

**Execution:**
- [x] `packages/domain/src/provider-status.ts`, `packages/config/src/feed-coverage.ts`, and tests -- define/freeze the versioned public DTO and exact production SharpAPI status catalog for account, schedule, odds, and splits without fixture or inferred coverage.
- [x] `packages/database/src/odds-control-plane.ts`, `apps/workers/src/odds-control-plane.ts`, `apps/workers/src/production-odds-control-plane.ts`, and tests -- preserve `lastSuccessfulAt` across failure/degraded transitions, retain exact partial evidence, and support bounded exact-key reads without scanning or weakening FTE-024 behavior.
- [x] `apps/api/src/provider-status.ts` and tests -- sanitize known records into independent connection/capacity states, server-derived staleness and recommendation impact, deterministic summaries, safe reasons, and explicit missing/partial coverage.
- [x] `apps/api/src/handler.ts`, `apps/api/src/lambda.ts`, `infra/cdk/src/foundation.ts`, and tests -- expose public `GET /providers/status`, wire the production store/catalog, add safe route metrics and SPA rewriting, and reveal no credentials or account/plan internals.
- [x] `apps/web/src/api.ts` and tests -- add a bounded public client method that sends no credentials, times out safely, and rejects extra keys, duplicate scopes, invalid timestamps/counts/enums, impossible window chronology, and contradictory summary counts.
- [x] `apps/web/src/provider-status.tsx`, `apps/web/src/dashboard.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`, and component tests -- replace the placeholder with an independently retryable summary, add `/data-sources`, preserve valid opportunities when status fails, and render all healthy/partial/stale/outage/unknown/capacity states accessibly at desktop and mobile sizes.
- [x] `tests/e2e/app-shell.spec.ts` -- mock both public endpoints and prove Dashboard status, Data Sources navigation/detail, representative outage/exhausted states, keyboard-visible actions, and zero document overflow locally.
- [x] Full local verification -- run focused package/API/web tests, Playwright desktop/mobile smoke, repository checks, and diff hygiene without deploying.

**Acceptance Criteria:**
- Given configured SharpAPI capability keys and any mix of fresh, missing, partial, stale, outage, or recovery records, when provider status is requested, then the server returns a stable sanitized snapshot whose totals, order, safe reasons, freshness, request-window state, and recommendation impact exactly match the persisted evidence and catalog.
- Given absent or expired rate headers, legacy quota fields, reserve-protected capacity, or zero remaining capacity, when status is displayed, then connection and capacity remain independent and the UI never presents request-window values as subscription quota.
- Given ranked opportunities and a loading, newer, or failed provider-status query, when Dashboard renders, then valid cards remain controlled by their opportunity snapshot while the status module communicates only server-authored warnings and offers independent retry/navigation.
- Given `/data-sources` on desktop or mobile, when a user scans provider capabilities, then every expected scope has a textual state, safe impact, last-check/last-success evidence, supported-data description, and an accessible request-capacity meter only when authoritative bounds exist.
- Given a public browser client or hostile provider-status response, when the endpoint is called, then no credentials or sensitive provider material is exposed, malformed data fails closed with a safe message, and all local tests/builds pass without deployment.

## Spec Change Log

- 2026-08-07: Implemented the complete provider-status contract, production catalog, health chronology, public API and infrastructure, Dashboard summary, Data Sources view, and local verification coverage.

## Review Triage Log

### 2026-08-07 — Blind Hunter and Edge Case Hunter

- **Reviewed:** the complete FTE-037 working-tree diff using two fresh, independent review agents.
- **Patched (16):** protected durable success evidence from transient TTL deletion; made last-success chronology authoritative for freshness; enforced stale precedence and bounded ancient ages; failed closed on legacy rows without success evidence; validated exact catalog identity and cross-field DTO semantics; persisted authoritative rate windows across every successful capability and replay path; corrected account/splits cadence; constrained recommendation impact by capability and state; added sanitized retry timing; enforced evaluation completeness; added trailing-slash SPA rewriting; and made the public browser request explicitly credential-free.
- **Deferred:** 0.
- **Rejected:** 0.
- **Classification:** 11 high and 5 medium implementation findings; no intent gaps or specification defects.
- **Follow-up review:** recommended because the review produced substantial persistence, public-contract, and status-semantics hardening.

## Design Notes

The API snapshot is deliberately separate from ranked-opportunity snapshots. It may explain why new evidence is limited, but it cannot retroactively change a card: only the opportunity endpoint’s lifecycle/expiry contract can do that. The Dashboard status query therefore fails independently and never gates the opportunities query.

The capacity meter represents only a provider-enforced request window when both limit and remaining are authoritative and the reset is still future-dated. `low` is informational above reserve, `reserve-protected` means automation intentionally preserves capacity, and `exhausted` requires authoritative zero. Unknown stays unknown.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/domain test && pnpm --filter @find-the-edge/config test && pnpm --filter @find-the-edge/database test && pnpm --filter @find-the-edge/workers test` -- status vocabulary, chronology, persistence, and transition matrix pass.
- `pnpm --filter @find-the-edge/api test && pnpm --filter @find-the-edge/web test` -- public contract, security boundary, and UI state coverage pass.
- `pnpm exec playwright test tests/e2e/app-shell.spec.ts` -- local desktop/mobile Dashboard and Data Sources smoke passes.
- `pnpm check && git diff --check` -- repository lint, typecheck, tests, build, and diff hygiene pass.

## Dev Agent Record

### Implementation Plan

Extend the existing provider control plane with durable last-success and partial evidence, derive a sanitized independent health/capacity snapshot over exact production keys, and consume it through an isolated public UI query that never participates in opportunity qualification.

### Completion Notes

- Added a frozen, versioned provider-status DTO and the exact 16-scope production SharpAPI catalog for account, schedule, odds, and splits.
- Preserved last-success and partial evidence across worker transitions, added bounded exact-key memory/Dynamo reads, and corrected transient health TTL projection without scanning.
- Added public `GET /providers/status` with server-derived connection, request-window capacity, freshness, safe reason, impact, deterministic aggregation, partial-read handling, and safe route observability.
- Replaced the Dashboard placeholder with an independently retryable status summary and added a responsive, accessible `/data-sources` view with authoritative meters only for known active windows.
- Proved malformed public data fails closed, no browser credentials are sent, valid opportunities survive status failure, and representative outage/exhausted states render without desktop or mobile overflow.
- Local verification passed: focused domain/config/database/workers/API/web/infra suites, desktop/mobile Playwright smoke, full `pnpm check`, and `git diff --check`; no deployment was performed.
- Resolved the deduplicated review findings: protected durable success evidence from TTL deletion, made success chronology authoritative for freshness, enforced stale/identity/cross-field validation, persisted all successful capability rate windows including replay, exposed sanitized retry timing, and closed the SPA/credential edge cases.

## File List

- `_bmad-output/implementation-artifacts/spec-fte-037-provider-health-and-quota-dashboard-states.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/api/src/handler.test.ts`
- `apps/api/src/handler.ts`
- `apps/api/src/lambda.ts`
- `apps/api/src/provider-status.test.ts`
- `apps/api/src/provider-status.ts`
- `apps/web/src/App.test.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/api.test.ts`
- `apps/web/src/api.ts`
- `apps/web/src/dashboard.tsx`
- `apps/web/src/provider-status.tsx`
- `apps/web/src/styles.css`
- `apps/workers/src/odds-control-plane.test.ts`
- `apps/workers/src/odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `infra/cdk/src/foundation.test.ts`
- `infra/cdk/src/foundation.ts`
- `packages/config/src/feed-coverage.test.ts`
- `packages/config/src/feed-coverage.ts`
- `packages/database/src/odds-control-plane.test.ts`
- `packages/database/src/odds-control-plane.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/provider-status.test.ts`
- `packages/domain/src/provider-status.ts`
- `tests/e2e/app-shell.spec.ts`

## Change Log

- 2026-08-07: Completed FTE-037 implementation and local verification; advanced the story to in-review and sprint status to review.
- 2026-08-07: Addressed all 16 deduplicated code-review findings with focused regressions and repeated local verification.
- 2026-08-07: Closed FTE-037 at implementation revision `14279239f70ab25c5d43725c30ad33ddbfd2b9d5` and advanced the sprint queue to FTE-038.

## Auto Run Result

- **Summary:** Delivered a sanitized provider-health and request-capacity control surface with an independent Dashboard summary, a full Data Sources page, exact production scope coverage, and durable recovery chronology.
- **Review outcome:** 16 findings patched; 0 deferred; 0 rejected. Follow-up review is recommended.
- **Verification:** 181 domain tests, 74 config tests, 290 database tests, 220 worker tests plus 4 opt-in live tests skipped, 45 API tests, 147 web tests, 8 infrastructure tests, two local Playwright viewport checks, the complete repository `pnpm check`, and diff hygiene all pass without deploying.
- **Residual risk:** live usefulness depends on the production ingestion loop continuing to write current health and rate-window records; no environment deployment or live-provider validation was performed in this story, and the public contract intentionally exposes only sanitized operational summaries.
