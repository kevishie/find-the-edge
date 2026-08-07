---
title: 'FTE-035: Ranked Opportunity API and Explanation'
type: 'feature'
created: '2026-08-06'
status: 'done'
baseline_revision: 'a3dcf898627d6ee3c09445a0dc865ece658070b4'
final_revision: 'a798c79ab3cf61b26c44b3768978a7f429e39b25'
review_loop_iteration: 1
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/epic-6-context.md'
  - '_bmad-output/implementation-artifacts/spec-fte-034-opportunity-lifecycle-states-and-expiration.md'
warnings:
  - oversized
---

<intent-contract>

## Intent

**Problem:** Qualified opportunity evidence and lifecycle heads exist, but the product has no globally ranked, public read model or safe explanation contract. Sorting an expiration-index page in memory would miss better opportunities and could expose stale state.

**Approach:** Materialize an atomic, versioned rank projection beside each active lifecycle transition, query it through a sparse rank GSI, strongly revalidate every result, and expose public sport-scoped list/detail endpoints with transparent confidence components and encrypted filter-bound cursors.

## Boundaries & Constraints

**Always:** Rank lexicographically by full-precision EV descending, confidence descending, freshness descending, sportsbook coverage descending, then logical opportunity ID ascending. Confidence is a conservative integer 0–100 equal to the minimum of three integer data-quality components: freshness `floor(100 * clamp(1 - oldestRequiredEvidenceAge / maximumPriceAge, 0, 1))`, coverage `floor(100 * includedComparisonBooks / uniqueNonTargetComparisonBooksWithEvidence)`, and agreement `floor(100 * clamp(1 - marketDisagreement / disagreementBlockThreshold, 0, 1))`. Expose all components and the weakest component as data quality; High is 80–100, Medium 60–79, Low 0–59. Persist the component inputs, ranking policy ID/version, candidate occurrence, lifecycle state version, score time, exact expiry, and canonical sortable rank key. Treat confidence as model/data confidence, never win probability. Return only qualified, active, unexpired, scheduled, identity-fenced opportunities after strong projection/head/candidate/event reads. Derive target price, best included comparison price, book count, warnings, and timestamps from exact candidate evidence. Keep target book configurable. Accept only canonical sport/market/target/competition/warning values, ISO kickoff bounds spanning at most 31 days, finite nonnegative minimum EV, minimum books 1–100, maximum age from 0 through the policy maximum, limit 1–50 (default 20), and cursor length 1–4096; reject unknown parameters. Use a short-lived encrypted cursor bound to sport, policy, normalized filters, and physical key. Bound physical evaluation to 200 rows and disclose partial/unknown continuation honestly.

**Block If:** Atomic rank projection cannot fit DynamoDB transaction limits; exact current event identity cannot be joined; or implementation would need a different business formula, threshold, or target/comparison roster.

**Never:** Scan the table; rank a bounded expiration-index prefix; use display-rounded values; return an eventual GSI row without strong rereads; fabricate labels, confidence, freshness, or missing evidence; expose Dynamo keys, health/evidence IDs, raw provider data, secrets, or account details; return inactive/history states; build Dashboard UI; mutate FTE-033 candidate occurrences.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Ranked list | Public sport request with active projections | Stable EV-first page with scores, explanations, safe event summary, and next cursor | 200; empty is valid |
| Lagging GSI | Projection moved/deleted or head/candidate/event fence differs | Exclude row, continue bounded physical reads, count filtered evidence | Never return stale row |
| Exact expiry | Request time reaches `expiresAt` during continuation | Exclude even if cursor snapshot predates expiry | Safety overrides snapshot membership |
| Filters | Valid market/target/competition/kickoff/min-EV/min-books/max-age/warning filters | Return matching rows in global rank order | Reject unknown, malformed, or cursor-mismatched filters |
| Evaluation cap | Filters/corruption exhaust bounded physical reads before certainty | Return verified items with partial evaluation metadata | Do not claim a complete terminal page |
| Detail | Matching active sport/opportunity ID | Full safe explanation and component provenance | 404 for absent, inactive, expired, or sport mismatch |

</intent-contract>

## Code Map

- `packages/config/src/opportunity-ranking-policy.ts` -- approved formula, buckets, order, policy identity, and validation.
- `packages/domain/src/opportunities/ranked-opportunity.ts` -- pure confidence/rank kernel, sortable encoding, projection/DTO invariants, and safe explanation types.
- `packages/database/src/opportunities/` -- atomic projection persistence, rank-index query, strong joins, bounded reconciliation, and opportunity cursor codec.
- `apps/workers/src/opportunities/` -- lifecycle projection/reconciliation integration.
- `apps/api/src/handler.ts` and `apps/api/src/lambda.ts` -- public list/detail routes, filters, envelopes, and telemetry.
- `infra/cdk/src/foundation.ts` -- rank GSI, public read routes, permissions, and alarms.

## Tasks & Acceptance

**Execution:**
- [x] `packages/config/src/opportunity-ranking-policy.ts`, test, and export -- encode and validate the approved v1 formula, 0–100 scale, buckets, and exact tie-break order.
- [x] `packages/domain/src/opportunities/ranked-opportunity.ts`, test, and export -- derive canonical scores/projection keys and strictly normalize list/detail explanation DTOs with permutation, boundary, nonfinite, and leakage regressions.
- [x] `packages/database/src/opportunities/ranked-opportunity-repository.ts`, Dynamo/memory adapters, cursor codec, lifecycle transaction integration, tests, and exports -- atomically put/delete rank projections; query `opportunity-rank-v1`; strongly reread projection/head/candidate/current event; bind cursors to policy/filters; cap evaluated rows; and reconcile pre-existing active heads in bounded pages.
- [x] `apps/workers/src/opportunities/opportunity-lifecycle-service.ts` and tests -- supply the versioned ranking policy on candidate/sweep transitions and expose idempotent bounded projection reconciliation without weakening lifecycle correctness.
- [x] `apps/api/src/handler.ts`, `apps/api/src/lambda.ts`, and tests -- add public `GET /sports/{sportKey}/opportunities` and `GET /sports/{sportKey}/opportunities/{opportunityId}` routes consistent with the removed login wall; validate the matrix filters; return versioned no-store envelopes; emit low-cardinality latency/discovered/returned/filtered/stale/join/cursor metrics.
- [x] `infra/cdk/src/foundation.ts` and tests -- provision the KEYS_ONLY rank GSI, exact index IAM, both scoped routes, request-ID plumbing, and failure/stale-read alarms.
- [x] Focused fixtures and full repository verification -- prove ranking precedence, ties, atomic active/inactive changes, lagging-index isolation, reconciliation, encrypted cursor tamper/expiry/filter rejection, public access, safe 404/503/500 behavior, and absence of internal fields.

**Acceptance Criteria:**
- Given qualified active opportunities across a sport, when the list endpoint is called, then results follow the approved total order across the full rank partition and every item explains EV, confidence score/bucket/components, live freshness, coverage, agreement, contributing books, warnings, and timestamps.
- Given any lagging, expired, inactive, mismatched, corrupt, or unscheduled source, when list or detail reads it, then it is excluded or safely failed without exposing internals, and no stale opportunity is presented as active.
- Given identical source evidence and policy, when projection or reconciliation retries, then bytes, rank key, and identity converge; a newer candidate/lifecycle version atomically replaces or removes the prior projection.
- Given a public filtered request and cursor, when pagination continues, then filters/policy/sport cannot change, verified order is preserved, and bounded partial evaluation is explicitly reported rather than hidden.

## Spec Change Log

### 2026-08-06 — Preserve the public product surface

- Trigger: review exposed that the story had reintroduced authentication after the user explicitly removed the login wall.
- Amendment: opportunity list/detail routes are public reads; mutation and administrative routes remain independently protected.
- Known-bad state avoided: a new dashboard that silently redirects users back to Cognito or returns 401/403.
- KEEP: atomic rank projections, strict strong-read validation, safe DTOs, encrypted filter-bound cursors, and all existing authorization on unrelated privileged routes.

## Review Triage Log

### 2026-08-06 — Review pass 1

- intent_gap: 0
- bad_spec: 1: (high 1, medium 0, low 0)
- patch: 9: (high 7, medium 2, low 0)
- defer: 0
- reject: 1
- addressed_findings:
  - `[high]` `[bad_spec]` The story contradicted the already-approved removal of authentication; amended the contract and route task to keep ranked opportunity reads public while preserving protection for privileged mutations.

### 2026-08-06 — Review pass 2

- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 7, medium 3, low 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Counted only excluded sportsbooks with retained snapshot evidence in the coverage denominator, preventing false confidence suppression and rank drift.
  - `[high]` `[patch]` Parallelized each bounded rank-index page's authoritative projection and join reads, eliminating the prior hundreds-of-round-trips timeout path.
  - `[high]` `[patch]` Enforced sport isolation in the memory repository so tests and local consumers cannot return another sport's opportunities.
  - `[high]` `[patch]` Made DTO normalization verify the confidence minimum, bucket, and weakest component rather than accepting contradictory explanations.
  - `[medium]` `[patch]` Enforced freshness chronology and the minimum possible age at scoring time.
  - `[high]` `[patch]` Deep-froze validated policy components and exported order arrays so policy behavior cannot change under an unchanged version.
  - `[high]` `[patch]` Bound detail projections to the requested logical opportunity ID, preventing a corrupt row from returning another opportunity.
  - `[high]` `[patch]` Excluded post-snapshot projections from continuation pages to preserve stable cursor membership and freshness.
  - `[medium]` `[patch]` Reported an exact 200-row terminal memory page as complete instead of falsely partial.
  - `[medium]` `[patch]` Replaced lexicographic kickoff comparisons with epoch comparisons in request validation and filtering so canonical extended-year timestamps cannot invert a range.

## Design Notes

The rank key uses canonical descending sortable numeric encodings, not a weighted mystery score. Scores are frozen at candidate evaluation time and labeled with `scoredAt`; the response separately recomputes live age at the cursor snapshot and still enforces expiry against current server time. Projection rows are separate from lifecycle heads but are written/deleted in the same event-fenced CAS transaction. The API index is discovery-only: authoritative table rereads decide visibility.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/config test && pnpm --filter @find-the-edge/domain test`
- `pnpm --filter @find-the-edge/database test && pnpm --filter @find-the-edge/workers test`
- `pnpm --filter @find-the-edge/api test && pnpm --filter @find-the-edge/infra-cdk test`
- `FTE_EVENT_CURSOR_SECRET_ARN=arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-local-cursor pnpm --filter @find-the-edge/infra-cdk synth`
- `pnpm check && git diff --check`
