---
title: 'FTE-DQ-001 Universal SharpAPI Catalog and Landing'
type: 'feature'
created: '2026-08-14'
status: 'in-review'
baseline_commit: '269478994a644b7245484fc23f643dd45777de56'
review_loop_iteration: 3
context:
  - '{project-root}/_bmad-output/planning-artifacts/sprint-change-proposal-2026-08-14.md'
  - '{project-root}/docs/runbooks/sharpapi.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Production collection is gated by six hardcoded leagues even though the entitled SharpAPI account exposes a dynamic catalog of sports, leagues, events, and odds. Parser or UI limitations currently cause source data to be skipped, leaving missing sports, games, and lines.

**Approach:** Add a separate universal acquisition path that discovers the live provider catalog and continuously lands provider-wide event and unfiltered odds records through resumable checkpoints. Preserve supported source fields in a generic schema and quarantine individual malformed rows without failing or discarding valid siblings; existing sport-specific serving remains downstream.

## Boundaries & Constraints

**Always:** Treat `/sports` and `/leagues` as the collection roster; automatically include newly discovered entries; fetch provider-wide `/events` and unfiltered `/odds`; use bounded cursor/offset work, idempotent current records, exact attempt/landed/quarantined counts, and terminal sweep checkpoints; store sport, league, event identity, participants, lifecycle, market, selection, sportsbook, line, price, timestamps, and provider provenance when present; keep unsupported records visible through bounded quarantine evidence.

**Ask First:** Purchasing/changing provider entitlement, storing verbatim paid response bodies, or enabling production before the staging reconciliation gate passes.

**Never:** Require a sport module, strategy, league allowlist, or UI route before capture; silently skip a provider row; treat a partial page walk as complete; restart every invocation from page one; log credentials, raw response bodies, or commercial terms; mutate existing canonical events/odds from the landing worker.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Dynamic catalog | Current or newly added SharpAPI sport/league | Canonical bounded catalog record lands without code change | Invalid row quarantined; valid siblings land |
| Large sweep | More pages than one Lambda budget | Cursor/offset and counts persist; next invocation resumes exactly | No completion marker until terminal page |
| Unsupported shape | Valid page containing a row the product cannot normalize | Safe source identity/field inventory and quarantine reason land | Row is counted once; page continues |
| Replay | Same page or record is delivered twice | Current record is overwritten idempotently and counts remain deterministic | Cursor only advances after all writes succeed |
| Provider failure | 429, timeout, 5xx, malformed envelope, or cursor cycle | Prior checkpoint remains resumable and health reports bounded reason | No fabricated terminal sweep |

</frozen-after-approval>

## Code Map

- `packages/providers/src/sharp-api.ts` -- strict catalog and provider-wide event/odds page clients with per-row normalization outcomes.
- `packages/database/src/provider-landing-repository.ts` -- generic landing records, Dynamo keys, batch writes, and sweep checkpoints.
- `apps/workers/src/provider-landing.ts` -- catalog and independent event/odds sweep orchestration with durable page budgets.
- `apps/workers/src/provider-landing-lambda.ts` -- catalog refresh and time/page-budgeted event/odds sweep orchestration.
- `infra/cdk/src/foundation.ts` -- isolated scheduled worker, least-privilege table/secret access, alarms, and outputs.
- `docs/runbooks/sharpapi.md` -- universal collection contract, cadence, privacy, recovery, and reconciliation procedure.

## Tasks & Acceptance

**Execution:**
- [x] `packages/providers/src/sharp-api.ts` and tests -- add `/sports`, `/leagues`, provider-wide `/events`, and provider-wide `/odds` contracts; isolate row failures and preserve exact pagination metadata.
- [x] `packages/database/src/provider-landing-repository.ts` and tests -- add bounded schemas, deterministic keys, idempotent batch writes, quarantine storage, and strongly read/versioned checkpoints.
- [x] `apps/workers/src/provider-landing.ts`, `provider-landing-lambda.ts`, and tests -- refresh catalog, resume both sweeps within fixed request/time budgets, advance only after durable writes, and emit low-cardinality reconciliation metrics.
- [x] `infra/cdk/src/foundation.ts` and tests -- schedule the isolated worker every 15 minutes with reserved concurrency one, secret read, scoped Dynamo actions, DLQ/error/staleness/quarantine alarms, and no serving dependency.
- [x] `docs/runbooks/sharpapi.md` -- document no-allowlist collection, source-field retention, recovery, live verification, and the staging exit gate.

**Acceptance Criteria:**
- Given any sport or league returned by SharpAPI, when catalog acquisition runs, then it lands without a repository configuration change.
- Given a provider-wide page with supported and unsupported rows, when it is processed, then every row is represented exactly once as landed or quarantined and valid siblings survive.
- Given an invocation ends before the terminal page, when the next invocation starts, then it resumes the stored cursor/offset and cannot publish a completed sweep.
- Given all terminal pages commit, when reconciliation runs, then page, source-row, landed-row, and quarantined-row totals agree and a completed timestamp is recorded.
- Given the existing live odds worker and product APIs, when universal landing is deployed, then their data and behavior remain unchanged until a later promotion story.

## Spec Change Log

- 2026-08-14: The human clarified that acquisition must never restrict SharpAPI sports or available data. Removed the earlier main-market/pregame odds restriction after a live read-only request proved unfiltered `/odds` is supported. KEEP: dynamic catalog discovery, resumable bounded sweeps, per-row landing/quarantine accounting, isolation from canonical serving, and the staging reconciliation gate.
- 2026-08-15: The adversarial review loop hardened two-slot publication, exact durable cursor claims, account-wide quota coordination, stream-local rejection pauses, catalog chunk reconciliation, strict provider number/string/time boundaries, terminal health persistence, async failure DLQ delivery, and sustained recovery/freshness alarms. No review repair added an acquisition allowlist or changed canonical serving.
- 2026-08-15: The final edge pass included the two-slot prefix in encoded DynamoDB key bounds so oversized Unicode provider IDs quarantine per row instead of failing a page batch. Blind Hunter concluded CLEAN and Edge Case Hunter returned `[]`.
- 2026-08-15: Live staging proved provider-wide `/events` `updated_at` is mutable observation evidence rather than an immutable pagination snapshot, while provider-wide cursor `/odds` legitimately omits `total`. Removed generation equality and the odds total as sweep liveness prerequisites; offset-paginated events still require and reconcile their denominator. Offset/cursor advancement, durable position claims, sealed page hashes, terminal pagination, per-page reconciliation, cycle detection, and provider totals when present remain fail-closed. KEEP: no partial completion, atomic two-slot publication, exact landed/quarantine accounting, and bounded source evidence.
- 2026-08-15: Live staging exposed the minute-window liveness failure: landing could process two page pairs, then pause because live odds does not continuously refresh the shared account window. Live odds and landing now elect exactly one `/account` recovery probe per expired window through the existing durable probe lease; the loser only observes the winner. Every page recomputes the fifty-percent/minimum-250 reserve and atomically fences the exact health version, provider limit, and reset identifier. Ten-second reset and sixty-second checkpoint-safety guards prevent stale or late dispatch. KEEP: one account-wide probe, no duplicate recovery request, terminal health fail-closed, and live quota protected.
- 2026-08-15: Final recovery review now binds completion to the exact post-election health version. A later live request, reconciliation, 429, terminal transition, or competing write invalidates the older `/account` response; stale recovery can neither refund quota nor clear a provider block. The lease remains durable after missing metadata, ambiguous failure, or a post-claim deadline, and nonretryable account rejection terminalizes once. Blind Hunter concluded CLEAN and Edge Case Hunter returned `[]`.
- 2026-08-15: A documentation-led live audit found the remaining acquisition blocker. SharpAPI documents `/events` with `limit <= 200`, `offset <= 5000`, and comma-separated sport/league filters; the staging account currently exposes more than 18,000 events, so the unfiltered offset walk cannot complete. The include-empty `/sports` and `/leagues` catalogs remain the dynamic source of truth and no sport or league allowlist is introduced. The event sweep freezes deterministic sport-scoped partitions, adding exact league groups only for large sports, while `/odds` keeps the documented opaque cursor flow with identical filters. A league slug that cannot be represented in the documented comma-separated grammar is quarantined as provider inconsistency while its sport falls back to sport-wide acquisition. Stable non-2xx `error.code` values, nanosecond provider timestamps, and catalog/filter inconsistencies remain bounded evidence rather than prose-matched or silently discarded data.
- 2026-08-15: The first deployed docs-led sweep completed the 1,762-row catalog and advanced Events, but the unfiltered Odds request at the documented 200-row maximum exceeded the bounded 25-second request timeout. The opaque cursor filter is now fixed at a provider-supported 25 rows, which live staging had already proven completes reliably and with better observed throughput. KEEP: same unfiltered Odds dataset, same cursor on every continuation, no timeout increase, no blind retry of an ambiguous request, and no fabricated completion.
- 2026-08-15: The next live invocation exposed a persistence-only resume defect: DynamoDB returned the event-partition map as `{offset, partition}` after the worker hashed `{partition, offset}`, so a valid checkpoint failed closed before any provider call. Position hashes now canonicalize each position variant by named fields in one shared database/worker function. The exact deployed checkpoint validates without mutation, and a regression reorders the DynamoDB map keys. KEEP: the existing hash values, crash replay and cycle claims, strong checkpoint validation, and no destructive checkpoint reset.
- 2026-08-15: SharpAPI's official Events reference says `400 invalid_filter` is limited to malformed numeric pagination and that unmatched filters return `200` with an empty page. Live staging instead returned `400 invalid_filter` for the valid catalog-derived first-page filter `sport=futsal`, including a reproducible bounded request ID; a subsequent include-empty catalog no longer listed that sport or any futsal league. The worker now retains code/status/request ID and the revisioned request position as `provider-filter-rejected` diagnostic evidence, but never counts the rejected request as a provider source row. Multi-league filters bisect deterministically inside the same inactive sweep so valid siblings continue. A rejected singleton enters a bounded deferred queue; later sports continue, the sweep remains running and unpublished, the last completed slot stays current, and retry or a refreshed catalog must close the gap before publication. Other nonretryable rejections remain stream-local pauses, account health is not poisoned, and error prose/body is never retained. KEEP: HTTP status plus stable `error.code` as authority, dynamic catalog planning without allowlists, exact page-attempt and source-row accounting, and fail-closed handling for every non-matching rejection shape.

## Design Notes

Collection coverage and product support are separate state machines. The landing layer stores source observations in two alternating bounded slots rather than verbatim responses; a conditional checkpoint selects the complete `{slot, sweepId}` logical view while a running sweep leaves the prior completed slot and sweep intact. A changed crash replay or pagination cycle abandons only the inactive sweep and restarts it under a new ID, so partial rows cannot mix with the last good dataset or the replacement sweep. Provider `updated_at` remains bounded evidence rather than a snapshot fence. Event acquisition freezes deterministic sport-scoped partitions from the complete include-empty catalog, reconciles the sequential `/sports` and `/leagues` membership union by `(sport, league)`, narrows large sports by exact league groups, walks each partition only within SharpAPI's documented offset ceiling, and reconciles the exact provider denominator per partition before advancing. Cursor odds use the provider's opaque continuation with unchanged filters and require exact cursor progression plus a valid terminal page. Values are idempotent within a sweep, removed identities disappear only at the atomic checkpoint boundary, and existing canonical odds history remains immutable. Quarantine is a first-class capture outcome, not permission to drop data.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/providers test && pnpm --filter @find-the-edge/database test && pnpm --filter @find-the-edge/workers test` -- provider, persistence, and orchestration contracts pass.
- `pnpm --filter @find-the-edge/infra-cdk test && pnpm phase1:preflight` -- worker resources, permissions, schedules, alarms, and retained-table safety synthesize.
- `pnpm check && git diff --check` -- repository quality gate passes without unrelated changes.

**Completed after review repairs:** provider 133 passed / 1 skipped; database 568 passed; workers 400 passed / 4 skipped; infrastructure 28 passed. The current root `pnpm check` passed end to end: formatting, lint, boundaries, all typechecks, 46 game-state tool tests, all 26 monorepo test tasks, all 15 build tasks, and 34 Playwright desktop/mobile journeys. Protected credential-free staging Phase 1 preflight with product-access enforcement explicitly `false` and `git diff --check` passed. Blind Hunter concluded CLEAN and Edge Case Hunter returned `[]` on the final code. Live read-only documentation probes proved the catalogs are dynamic (separate captures ranged from 29–31 sports and 1,594–1,731 leagues), `include_empty=true` is accepted, ten current league IDs contain the provider's comma delimiter, and one sequential sports/leagues capture briefly disagreed before the next capture converged. The unfiltered Events response reported more than 18,000 rows—beyond SharpAPI's documented 5,000 offset ceiling—while a fresh unfiltered Odds cursor advanced successfully for three pages. These observations are now explicit parser, planner, and recovery contracts rather than operational assumptions. The first protected deployment completed a 1,762-row catalog sweep and persisted a 30-sport event plan; the subsequent live resume found and reproduced a DynamoDB map-order checkpoint defect before provider dispatch, and the canonical hash repair validates that exact stored checkpoint locally without altering it. After that repair, staging completed a 1,685-row catalog refresh and advanced Events through 6,095 source rows and Odds through 700 source rows before two additional provider-boundary findings: an ambiguous Odds timeout incorrectly paused both streams, and a now-stale `futsal` catalog partition returned the docs-contradicting `400 invalid_filter`. Stream-scoped pause isolation, deterministic filter refinement, exact request evidence, and unpublished deferred gaps are implemented locally. Redeployed successful Event/Odds resume, completed-sweep reconciliation, and repeated live freshness remain required before FTE-DQ-001 may move from `in-review` to `done` or FTE-DQ-002 may begin.

## Suggested Review Order

**Acquisition and recovery control plane**

- Start with the bounded orchestrator that keeps partial generations unpublished and independently resumable.
  [`provider-landing.ts:2399`](../../../apps/workers/src/provider-landing.ts#L2399)

- Invalid filters and oversized partitions refine or defer without dropping valid sibling leagues.
  [`provider-landing.ts:1099`](../../../apps/workers/src/provider-landing.ts#L1099)

- The Lambda entry point coordinates account quota recovery before any paid catalog or page request.
  [`provider-landing-lambda.ts:159`](../../../apps/workers/src/provider-landing-lambda.ts#L159)

**Provider boundary**

- Strict Events normalization preserves safe rows and quarantines malformed siblings under documented pagination.
  [`sharp-api.ts:1423`](../../../packages/providers/src/sharp-api.ts#L1423)

- Strict Odds normalization follows opaque cursors and treats absent documented `is_active` as active.
  [`sharp-api.ts:1537`](../../../packages/providers/src/sharp-api.ts#L1537)

- Catalog discovery remains dynamic while enforcing exact sports/leagues generation and membership evidence.
  [`sharp-api.ts:2827`](../../../packages/providers/src/sharp-api.ts#L2827)

**Durable publication**

- Checkpoint validation couples plan, cursor history, pause, lineage, and item-size safety invariants.
  [`provider-landing-repository.ts:553`](../../../packages/database/src/provider-landing-repository.ts#L553)

- Two-slot current-view binding keeps the last completed generation readable during recovery.
  [`provider-landing-repository.ts:130`](../../../packages/database/src/provider-landing-repository.ts#L130)

- Durable position claims distinguish replay from confirmed cycles before a paid continuation advances.
  [`provider-landing-repository.ts:1195`](../../../packages/database/src/provider-landing-repository.ts#L1195)

**Operations and proof**

- Staging-only scheduling, async failure delivery, and targeted freshness/diagnostic alarms close the loop.
  [`foundation.ts:685`](../../../infra/cdk/src/foundation.ts#L685)

- Operator guidance defines dynamic capture, safe evidence, recovery, and the staging reconciliation gate.
  [`sharpapi.md:1`](../../../docs/runbooks/sharpapi.md#L1)

- The frozen acceptance contract keeps capture separate from serving and forbids partial completion.
  [`spec-fte-dq-001-universal-sharpapi-catalog-and-landing.md:11`](#L11)
