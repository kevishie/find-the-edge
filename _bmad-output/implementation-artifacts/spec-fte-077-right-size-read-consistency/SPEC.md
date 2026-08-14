---
id: SPEC-fte-077-right-size-read-consistency
status: in-review
companions:
  - consistency-inventory.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only.

# FTE-077: Right-Size Read Consistency in the Control Plane

## Why

The shared DynamoDB table pays the double-capacity cost of strongly consistent reads even on observational paths, while the same setting is indispensable for ownership, fencing, replay, evidence, and authorization. Operators need consistency to be an explicit call-site decision so safe reads cost less without creating intermittent correctness failures.

## Capabilities

- **CAP-1**
  - **intent:** Every strongly consistent read has a recorded correctness reason, and no read is downgraded merely because it appears read-only.
  - **success:** The complete inventory accounts for all 76 explicit strong-read sites and both default-strong gateway options; every retained strong site carries a nearby comment naming the invariant stale data would break.
- **CAP-2**
  - **intent:** Observational reads use eventual consistency when stale data can only delay work or temporarily omit timestamped or immutable display data.
  - **success:** The six approved repository reads and two delay-only projection-readiness probes explicitly opt out of strong consistency while all gateway defaults, provider-health reads, and two durable-decision readiness probes remain strong.
- **CAP-3**
  - **intent:** Each downgraded path proves that a stale replica cannot mutate authority, bypass a fence, cross a requester boundary, or turn missing evidence into a positive decision.
  - **success:** The stale-read matrix passes for the two delay-only readiness callers, watchlist UI lists, odds history, strategy audit, scouting versions, cohort lists, and lifecycle history; watchlist DELETE resolution, two durable-decision readiness callers, and provider-health reads remain strong alongside all existing replay, lease, evidence, authorization, and checkpoint tests.
- **CAP-4**
  - **intent:** Operators can measure and safely reverse the consistency change without overstating its value.
  - **success:** A valid FTE-075 baseline precedes deployment; an identical settled post-change window reports read units by bounded prefix and operation; rollback restores only the audited consistency flags and readiness helper behavior.

## Constraints

- A valid, recorded FTE-075 baseline is a hard prerequisite for deploying this optimization, marking FTE-077 done, or publishing any read-capacity, percentage, or dollar savings claim. Local implementation and verification may proceed before that gate; optimization deployment may not.
- Retain strong consistency for every read participating in ownership, leases, fencing, optimistic version checks, replay or idempotency, evidence decisions, checkpoints, authorization, entitlements, quota enforcement, terminal-state selection, or stale-GSI neutralization.
- Gateway defaults remain strongly consistent. Eventual consistency is an explicit opt-out at an audited observational call site, never a new default.
- Readiness is eventual only when a miss delays retryable projection work. Any caller that can persist a terminal skip, generation, disqualification, or lifecycle mutation uses the strong gateway default.
- A stale read must fail closed, return timestamped observational data, or temporarily omit immutable history. It may not report a positive readiness, ownership, authorization, evidence, or completion decision unsupported by durable state.
- FTE-075 capacity attribution and its valid-window rules remain unchanged. FTE-077 must not manufacture a baseline, reinterpret Contributor Insights access counts as capacity, or forecast savings as measured fact.
- No data migration, backfill, table or index change, polling or provider-cadence change, request-count optimization, or evidence-contract change is permitted.
- Treat this as high-risk consistency work: adversarial review must trace every changed read through stale, concurrent-write, retry, and replay behavior before merge.

## Non-goals

- Removing redundant reads or writes, collapsing RUN bookkeeping, changing evidence transactions, or implementing FTE-076.
- Downgrading retrospective list queries while their shared helper treats stale indexes or cursor misses as storage corruption.
- Weakening read-after-write guarantees for OTPs, account token versions, entitlements, quotas, leases, checkpoints, results, grades, paper picks, opportunities, or control-plane evidence.
- Claiming that observational read savings will be large before identical FTE-075 measurement windows demonstrate the actual change.

## Success signal

The full regression suite and stale-read matrix pass with no ownership, replay, evidence, authorization, or checkpoint regression. After the valid FTE-075 gate permits deployment, the identical settled measurement procedure shows the actual read-unit delta for named changed paths, or records honestly that the reduction is below expectation.
