# FTE-076 Implementation Contract

## Audited inputs

- `_bmad-output/planning-artifacts/epics-and-stories.md`, FTE-076 and its FTE-075/FTE-078 dependency boundaries.
- `_bmad-output/implementation-artifacts/epic-13-context.md`.
- Current repository and worker implementations and their crash/replay tests named below.

## Preservation invariants

1. `PAGE.evidenceIntentAt` is written before any external odds evidence commit. A crash after intent must prevent provider fallback and must be recoverable by scanning the sealed ledger after ownership is acquired.
2. `PAGE.committedAt` elects the exactly-once page commit. Evidence-bearing commits also persist `PAGE.evidenceCommittedAt`, including when the committed payload is empty, so recovery can distinguish them from ordinary no-evidence commits. A conflicting timestamp fails; replay of the same committed boundary is idempotent.
3. Removing the RUN leg from an evidence transition must not remove either PAGE condition. RUN rows have no deletion path, so adding a per-page RUN existence check is prohibited because it restores page-proportional RUN capacity.
4. A continuation owner is established before active RUN or PAGE-ledger reads. Ownership and lease are rechecked immediately before schedule evidence commitment.
5. Paid-call safety is unchanged: `reserveQuotaAttempt`, ATTEMPT completion, lease heartbeat, `reconcileQuota`, ambiguous-call fencing, and provider-call reuse remain in their current order.
6. A terminal RUN write is a known-prior compare-and-swap. It cannot overwrite a concurrent winner, regress a version, change run lineage, or drop the durable fields already recorded for the run.
7. Sealed normalized pages remain immutable. Schedule bindings and gap writes remain idempotent. Metric delivery remains honestly at least once across an emit-before-marker crash.
8. Existing RUN records remain readable without a data rewrite.

## RUN access budgets

Count every Dynamo request or transaction item whose partition key has the bounded prefix `ODDS_CONTROL#RUN`.

| Pass shape | Required budget | Composition |
| --- | ---: | --- |
| Fresh successful 100-page odds pass | exactly 2 | conditional create, terminal CAS write |
| Resumed successful pass | at most 3 | post-claim read, running/resume CAS write when needed, terminal CAS write |
| Fresh failed pass after run creation | at most 2 | conditional create, terminal failure CAS write |
| Resumed failed pass | at most 3 | post-claim read, running/resume CAS write when needed, terminal failure CAS write |
| Live-owner loser | exactly 0 | continuation-only decision |
| Dependency, cadence, or quota early outcome | exactly 0 | bounded telemetry only |
| Any number of evidence-bearing PAGE transitions | exactly 0 incremental RUN accesses | PAGE-only intent/commit operations |

Conditional-conflict diagnosis may perform one bounded winner read on the exceptional race path. It does not relax any normal-path budget and must be tested separately.

## Required repository design

- Add an explicit known-prior RUN transition that accepts `previous: OddsRunRecord | null`, conditionally writes the next version, and returns the stored record including its version.
- A known-new run uses `null` and `attribute_not_exists(pk)` with no preceding RUN read.
- A resumed run is read once only after ownership succeeds; later terminal state uses the returned/local version rather than calling `getRun` again or allowing `putVersioned` to reread.
- Memory and Dynamo implementations enforce identical stale-prior, exact-replay, and version progression behavior.
- `markEvidenceIntent` updates only the PAGE intent marker.
- `commitEvidencePage` updates only PAGE state: the commit marker plus the explicit evidence-commit classification used by crash recovery.
- Add a bounded `commitEvidencePages` operation for one or two unique tokens. Dynamo uses one transaction of conditional PAGE updates; Memory validates every member before committing the set.

## Redundant access sites to remove

Line numbers describe the audited baseline and should be matched by symbol if nearby code moves.

### Shared odds pass

- `apps/workers/src/odds-control-plane.ts:603-621`: RUN read and ledger repair occur before the eventual ownership claim. Move them below a successful claim and use the known-prior transition.
- `apps/workers/src/odds-control-plane.ts:1118-1132`: start `getRun` plus `putRun`, followed by the repository reread.
- `apps/workers/src/odds-control-plane.ts:1444-1450`: completion `getRun` plus `putRun`.
- `apps/workers/src/odds-control-plane.ts:1507-1516`: failure `getRun` plus `putRun`.
- `apps/workers/src/odds-control-plane.ts:573`, `:758`, and `:1033`: never-read dependency, cadence, and quota RUN rows.

### Production schedule, account, and splits

- Schedule start `apps/workers/src/production-odds-control-plane.ts:1498-1509`, completion `:1920-1926`, and failure `:1994-2003`.
- Account start `apps/workers/src/production-odds-control-plane.ts:2509-2521`, completion `:3223-3230`, and failure `:3265-3278`.
- Splits start `apps/workers/src/production-odds-control-plane.ts:2738-2750`, completion `:3138-3145`, and failure `:3197-3208`.
- Each terminal path must carry a locally returned RUN version; catch blocks may not recover it with another `getRun`.

### Page-proportional RUN mutations

- `packages/database/src/odds-control-plane.ts:361-390`: Memory evidence intent and evidence commit mutate RUN.
- `packages/database/src/odds-control-plane.ts:897-1018`: Dynamo evidence intent and evidence commit include a RUN transaction leg.
- Remove those RUN mutations while preserving the PAGE conditions and the existing resume scan that promotes ledger intent into the bounded RUN audit state.

## Schedule compound commit

The audited schedule path commits the source page at `apps/workers/src/production-odds-control-plane.ts:1733-1737` and the conflict page at `:1768-1776`.

Required order:

1. Reuse or fetch the sealed source page without recalling the paid provider.
2. Reconcile schedule bindings and construct the deterministic conflict dispositions and gaps.
3. Seal the immutable conflict page.
4. Recheck exact continuation owner, run ID, and unexpired lease.
5. Commit all uncommitted source/conflict PAGE markers in one bounded transaction. If replay finds one marker already committed at an earlier timestamp, exclude it and commit only the missing marker.
6. Reread both pages and require committed markers before writing their idempotent gaps.
7. Deliver metrics from committed evidence and mark delivery on each relevant PAGE record.
8. Advance continuation/checkpoint/RUN terminal state only after the page boundary above succeeds.

## Crash and replay matrix

| Interruption | Required replay behavior |
| --- | --- |
| Odds crash after intent, before external commit | No fallback; reuse sealed page; retry idempotent external commit; terminal RUN reflects recovered ledger intent. |
| Schedule crash after binding, before conflict seal | No paid recall; repeat only idempotent binding/reconciliation; seal deterministic conflict evidence. |
| Crash after both schedule pages seal, before compound commit | No paid recall; atomically commit the sealed markers. |
| Crash after one legacy/partial marker committed | Preserve its timestamp; commit only the missing marker. |
| Crash after compound commit, before gaps | Replay idempotent gap writes from committed pages. |
| Crash after metric emit, before delivery marker | Permit one redelivery; never claim exactly-once telemetry. |
| Ownership loss before compound commit | Commit no PAGE marker and no terminal RUN state. |
| Concurrent PAGE commit | One conditional transaction wins; the loser observes committed evidence or fails with the bounded transition conflict. |
| Stale terminal RUN writer | Known-prior CAS fails and cannot regress the winner. |

## Audit telemetry replacing skip rows

Emit one bounded outcome record/counter for each removed dependency, cadence, or quota RUN row. It must contain only:

- status;
- bounded reason;
- league;
- provider or `none`;
- policy version;
- event time.

Retain the existing cadence and quota metrics and add the missing dependency outcome. Never include a full Dynamo key, provider payload, secret, or unbounded error text. Production must emit the audit even when a caller omits an optional test metrics sink; a bounded structured log is an acceptable fallback.

## Test plan

### `packages/database/src/odds-control-plane.test.ts`

- Extend the existing physical `CountingClient` to count `Get`, `Put`, `Update`, and every transaction item touching `ODDS_CONTROL#RUN`.
- Repeat evidence intent plus evidence commit for 100 pages and assert zero RUN accesses; then call `getRun` deliberately and assert the counter increases by one.
- Assert known-new RUN transition is one physical write with no read.
- Assert known-prior transition is one conditional write, returns the next version, rejects a stale prior, and preserves exact replay/winner behavior with at most the documented exceptional read.
- Assert one/two-page compound commits, duplicate-token rejection, missing-page rejection, all-or-nothing Memory behavior, conflicting timestamp rejection, and partial replay.

### `apps/workers/src/odds-control-plane.test.ts`

- Drive `runOddsLeague` with a provider that produces exactly 100 evidence-bearing pages and a counting store/decorator.
- Assert completed status, 100 external commits, unchanged quota reservation/reconciliation, and the exact fresh RUN budget of two.
- Add resumed success/failure upper-bound tests and an active-owner loser asserting zero RUN and zero PAGE-ledger access.
- Keep all existing commit-interruption, ambiguous-call, fallback-fence, sealed-page reuse, and missing-reconciliation tests green.
- Replace skip-row assertions with no-RUN plus bounded-audit assertions for dependency, cadence, and quota outcomes. Include a deliberate access proving the counter is wired.

### `apps/workers/src/production-odds-control-plane.test.ts`

- Assert a new source/conflict pair uses one compound evidence commit.
- Cover crash after conflict seal, partial legacy commit, ownership loss, and metric-marker replay; every replay must make no second paid schedule call.
- Assert schedule, account, and splits start/terminal paths meet the fresh/resumed RUN budgets and preserve existing health/checkpoint/continuation outcomes.

### Verification

- Run focused database and worker suites, then `pnpm check`.
- Run an adversarial review against the preservation invariants and every budget row before merge.
- Use FTE-075 telemetry only to verify operation movement after the baseline gate and deployment. Do not infer or publish savings from local access counts.

## File scope

- `packages/database/src/odds-control-plane.ts`
- `packages/database/src/odds-control-plane.test.ts`
- `apps/workers/src/odds-control-plane.ts`
- `apps/workers/src/odds-control-plane.test.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- This FTE-076 spec folder and, only after the execution gate is satisfied, the story status artifact.

No change is required in `apps/workers/src/live-odds-lambda.ts`, `packages/database/src/dynamo-capacity-attribution.ts`, or the FTE-075 collector.

## Execution and release gates

1. **Specification:** allowed now.
2. **Local implementation and automated verification:** allowed before FTE-075 closes, but must not claim measured improvement.
3. **Optimization deployment:** blocked until FTE-075 has a valid recorded baseline satisfying its top-five-prefix, rerunnable-procedure, and settled-bill criteria.
4. **FTE-076 completion:** blocked until the access budgets and preservation suite pass and deployment was permitted by gate 3.
5. **Savings publication:** reserved for FTE-078 after an identical post-change measurement window settles. FTE-076 may report only tested request counts and observed operation movement.
