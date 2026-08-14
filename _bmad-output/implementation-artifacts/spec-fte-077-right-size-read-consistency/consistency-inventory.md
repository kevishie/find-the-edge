# FTE-077 Consistency Inventory and Implementation Contract

## Audited inputs

- `_bmad-output/planning-artifacts/epics-and-stories.md`, FTE-075 through FTE-078.
- `_bmad-output/implementation-artifacts/epic-13-context.md`.
- `_bmad-output/implementation-artifacts/spec-fte-075-cost-attribution-baseline.md`.
- Current `packages/database`, `apps/api`, and `apps/workers` implementations and tests.

The audited baseline contains 76 explicit `ConsistentRead: true` sites and two default-strong options in `AwsDynamoGateway`. Line numbers describe the audited baseline; implementation must match symbols if nearby code moves.

## Conservative first wave

| Site | Decision | Stale-read safety argument |
| --- | --- | --- |
| `packages/database/src/watchlist-repository.ts:122`, `list` | Downgrade | Requester-partitioned UI data. Temporary omission or retention cannot cross an account boundary or mutate the list; mutation responses are authoritative and the web client already updates optimistically. |
| `packages/database/src/dynamodb-odds-history-repository.ts:33`, history query | Downgrade | Immutable, timestamped chart history. Staleness may omit a recent point but cannot invent a point, supersede evidence, or drive a write. |
| `packages/database/src/dynamodb-strategy-experiment-repository.ts:532`, `listAudit` | Downgrade | Immutable audit presentation. Promotion, activation, and evidence-consumption decisions use separate strong reads. |
| `packages/database/src/dynamodb-scouting-report-repository.ts:660`, `listVersions` | Downgrade | Immutable requester-scoped display history. Report completion, binding, replay, and head CAS use the strong `rawGet` path. |
| `packages/database/src/dynamodb-cohort-repository.ts:206`, `listCohorts` | Downgrade | Immutable API catalogue. Scheduled revision and duplicate decisions use strong `listReports`, `getCohort`, and `getReport` paths. |
| `packages/database/src/opportunities/dynamodb-opportunity-lifecycle-repository.ts:200`, `history` | Downgrade | Immutable transition history with no production decision caller. Lifecycle head, rank projection, and sweep checkpoint remain strong. |
| `EVENT_PROJECTIONS/READINESS` probes in `apps/api/src/lambda.ts` and `apps/workers/src/live-odds-lambda.ts` | Downgrade through explicit `gateway.get` option | A stale miss only delays retryable API/materializer projection work and fails closed as uninitialized; it cannot create durable terminal, generation, disqualification, or lifecycle state. |

Add an optional consistency option to `DynamoGateway.get` and `AwsDynamoGateway.get`, preserving strong as the default. Centralize exact `{ schemaVersion: 1, state: "initialized" }` validation: the API and live-odds materializer explicitly request eventual consistency, while paper-pick scheduling and opportunity generation use the strong gateway default.

## Full retained-strong inventory

Every site below remains strong in this story. A concise comment must sit beside each `ConsistentRead: true` or default-strong setting and name the protected invariant.

| File and lines | Protected invariant |
| --- | --- |
| `apps/workers/src/live-odds-lambda.ts:171` | Maintenance token ownership and lease expiry. |
| `apps/workers/src/walk-forward-runtime.ts:42` | Authoritative evidence selection for experiment decisions. |
| `packages/database/src/aws-dynamo-gateway.ts:32,87,145` | Default `get`, bounded query, and full-partition query serve event-ingestion identity ownership, reconciliation leases, checkpoints, replay evidence, outbox state, and canonical joins. Observational callers opt out explicitly. |
| `packages/database/src/aws-dynamo-gateway.ts:57,109` | `batchGet` and `queryPage` remain default-strong for fences and ingestion state. Event-list projections already opt out explicitly. |
| `packages/database/src/betting-split-repository.ts:313,381` | Immutable replay verification and exact current-evidence semantics. `listCurrent` is already intentionally eventual. |
| `packages/database/src/dynamodb-closing-candidate-source.ts:36` | Closing-line selection that becomes durable performance evidence. |
| `packages/database/src/dynamodb-cohort-repository.ts:55,80,129,159,281,321` | Immutable replay checks, membership finalization, cutoff uniqueness, cohort/report binding, and scheduled report revision or duplicate decisions. |
| `packages/database/src/dynamodb-evaluation-attempt-repository.ts:47,64` | Attempt replay and evaluation evidence. |
| `packages/database/src/dynamodb-evaluation-terminal-repository.ts:41` | Exactly-once semantic terminal claim. |
| `packages/database/src/dynamodb-opportunity-candidate-repository.ts:48,67` | Candidate replay and lifecycle or rank-projection input. |
| `packages/database/src/dynamodb-paper-evaluation-repository.ts:123,133,182,208,233,289` | Transaction replay plus complete grading and cohort source scans; a stale omission could permanently skip a paper bet. |
| `packages/database/src/dynamodb-paper-grade-repository.ts:130,147,174,192` | Correction lineage, current/history agreement, and performance evidence. |
| `packages/database/src/dynamodb-paper-pick-run-repository.ts:76,212,219,301,531,712,786` | Generation replay, event-admission limits, item leases, budget or concurrency classification, and run completion; a stale scan could mark a run complete early. |
| `packages/database/src/dynamodb-result-repository.ts:52,83,114,184,201,233,266,316` | Authority ordering, replay indexes, exact/current result evidence, grading history, unresolved replay, and ingestion checkpoint progression. |
| `packages/database/src/dynamodb-retrospective-repository.ts:195,206,219,266,284,385,465` | Version lineage, current/report replay, cursor validation, current-index agreement, and review idempotency. The shared list helper is not stale-safe in this story. |
| `packages/database/src/dynamodb-scouting-job-repository.ts:190` | Shared job/attempt ownership, leases, fencing, receipts, and outbox state. |
| `packages/database/src/dynamodb-scouting-report-repository.ts:127` | Shared report-head CAS, job/attempt fencing, event-version assertion, binding, and replay resolution. |
| `packages/database/src/dynamodb-strategy-experiment-repository.ts:39,516` | Approval and activation optimistic checks, idempotency, consumed-evidence decisions, and scheduled active-strategy resolution. |
| `packages/database/src/entitlement-repository.ts:101,116` | Product authorization, billing ownership, and Stripe-customer uniqueness. |
| `packages/database/src/exact-odds-snapshot-repository.ts:87,107` | Immutable snapshot-index replay and exact closing evidence. |
| `packages/database/src/fixture-odds-adapter.ts:120,184` | Exact/current odds and availability used in evidence selection, recovery, and transaction reconciliation. |
| `packages/database/src/identity-repository.ts:243,347` | OTP validation and account token-version authorization. |
| `packages/database/src/odds-control-plane.ts:561,1075` | Shared run optimistic versions, attempt leases, sealed-page and evidence transitions, checkpoints, quota health, continuation ownership, and batch provider status. A stale healthy row can conceal a durable outage or exhausted capacity. |
| `packages/database/src/opportunities/dynamodb-opportunity-lifecycle-repository.ts:43,329` | Lifecycle state-version transitions and sweep checkpoint continuity. |
| `packages/database/src/opportunities/ranked-opportunity-repository.ts:255,476` | Strong base-table rereads neutralize stale GSI rows and prevent obsolete lifecycle/rank projections from being served. |
| `packages/database/src/watchlist-repository.ts:91` and bounded `findFirst` batch | Conditional-add replay against a concurrent remove and DELETE decode-candidate resolution. A stale miss must not return 204 while leaving the watched row authoritative. |
| `apps/workers/src/paper-pick-scheduler-runtime.ts` and `apps/workers/src/opportunities/opportunity-generation-lambda.ts` readiness callbacks | A readiness miss can persist terminal skip/generation or disqualification/lifecycle state, so both use the strong gateway default. |

These grouped rows account for every retained explicit site after the six first-wave downgrades. Do not treat an unused public method as safe to downgrade when its contract still represents current evidence.

## Stale-read safety matrix

| Test file | Required stale simulation and assertion |
| --- | --- |
| `packages/database/src/aws-dynamo-gateway.test.ts` | Default `get` emits strong consistency; an explicit observational option emits `ConsistentRead: false`. Batch and query defaults remain strong. |
| `packages/database/src/event-projection-readiness.test.ts` | The eventual helper receives a stale miss or malformed old value and returns false; the durable-decision helper performs the same exact validation through the strong gateway default. |
| `apps/api/src/provider-status.test.ts` | A stale or missing batch health record is surfaced as stale or unknown, never as a fresh healthy signal merely because the read succeeded. |
| `packages/database/src/odds-control-plane.test.ts` | `getHealthMany` and single-health reads both request strong consistency so a durable outage or exhausted-capacity update cannot be hidden by replica lag. |
| `packages/database/src/watchlist-repository.test.ts` and `apps/api/src/handler.test.ts` | A stale UI list may omit a just-added item or retain a just-removed requester-scoped item and later converges; DELETE resolves at most four decode candidates through strong exact requester keys and never depends on the eventual list. |
| `packages/database/src/dynamodb-odds-history-repository.test.ts` | A stale page may omit the newest immutable point while retaining validation, timestamps, order, cursor scope, and no-write behavior. |
| `packages/database/src/dynamodb-strategy-experiment-repository.test.ts` | A stale audit omission cannot affect approve, activate, active-strategy resolution, or consumed-evidence checks. |
| `packages/database/src/scouting-report-repository.test.ts` | A stale version-list omission cannot affect head CAS, completion, binding, replay, or requester isolation. |
| `packages/database/src/dynamodb-cohort-repository.test.ts` | A stale cohort-list omission cannot affect report binding, `listReports`, duplicate detection, or revision selection. |
| `packages/database/src/opportunities/opportunity-lifecycle-repository.test.ts` | A stale history omission cannot alter the lifecycle head, rank projection, discovery, or sweep checkpoint. |
| Existing database, API, and worker suites | All lease, replay, evidence, authorization, entitlement, checkpoint, quota, result, grade, paper-pick, opportunity, and crash-interruption regressions remain green. |

Each downgraded path needs both a request-shape assertion and a behavioral stale case. A test that checks only `ConsistentRead: false` is insufficient.

## Minimal file plan

1. Extend the gateway `get` signature with an optional consistency choice in `packages/database/src/dynamodb-event-ingestion.ts` and `packages/database/src/aws-dynamo-gateway.ts`; keep the default strong and add the gateway tests above.
2. Add and export projection-readiness helpers in the database package; keep only the API and live-odds probes eventual, keep paper-pick and opportunity-generation probes strong, and preserve the API readiness cache.
3. Change only the six approved repository sites to eventual consistency; add bounded strong watchlist candidate resolution for DELETE.
4. Add an invariant comment at every retained strong site. Comments must name what stale data would break, not merely say that the read is important.
5. Add the complete stale-read matrix and run focused database, API, and worker tests followed by the full project check.
6. Run adversarial review over changed reads, unchanged strong reads, and every caller that consumes a downgraded result.

## Observability and measurement gate

- Before implementation, run the FTE-075 collector for a valid UTC window and record non-empty native capacity, attributed capacity, Contributor Insights evidence, and the settled billing window required by its runbook.
- Do not deploy any FTE-077 consistency change until that baseline artifact passes the FTE-075 guards. A local branch, tests, review, and merge preparation may proceed; optimization deployment may not.
- After deployment is permitted, use the identical environment, duration, metric period, prefix normalization, native table/GSI totals, and settled-bill method. Record deployment commit and UTC boundary.
- Compare read units for the named changed prefixes and operations. Keep residual and mixed capacity explicit. Do not use request counts or Contributor Insights percentages as read-capacity percentages.
- Monitor provider-status unknown/stale rates, projection-uninitialized outcomes, watchlist errors, audit/list error rates, Dynamo throttles, worker failures, lifecycle reconciliation failures, and all existing ownership/evidence conflict metrics.
- FTE-077 is not done and no savings claim is valid until both the baseline and settled post-change window exist. A below-expectation or unmeasurable delta is the finding, not permission to select a more favorable window.

## Rollout and rollback

1. Deploy only after the FTE-075 gate, using the normal reviewed pipeline and one environment at a time.
2. Verify projection readiness, provider-status safety states, watchlist behavior, odds history, audit/version lists, cohort lists, and lifecycle processing before widening rollout.
3. Roll back on any unsupported positive decision, requester-boundary issue, persistent uninitialized state after confirmed readiness, increased storage-corruption errors, lifecycle or report conflict increase, or regression in ownership/evidence tests.
4. Rollback restores the six `ConsistentRead` flags and the two eventual readiness probes to strong reads. It does not change schemas, data, FTE-075 instrumentation, or unrelated runtime work.
5. Repeat the same measurement method after rollback when needed to distinguish consistency effects from workload variance.

## Merge and claim gates

- **Merge gate:** full stale-read matrix, full project check, and adversarial acceptance review pass.
- **Deployment gate:** a valid recorded FTE-075 baseline exists before the first optimization deployment.
- **Completion gate:** valid settled before/after windows exist and all protected invariants remain green.
- **Claim gate:** publish only the measured delta with both UTC windows and named changes. Never publish forecast, request-count, or Contributor Insights access-share numbers as realized read-capacity or dollar savings.
