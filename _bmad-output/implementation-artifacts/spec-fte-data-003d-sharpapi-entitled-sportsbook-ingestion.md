---
title: 'FTE-DATA-003D SharpAPI Entitled Sportsbook Ingestion'
type: 'feature'
created: '2026-08-04T00:00:00-04:00'
status: 'in-review'
baseline_revision: 'acf67c5'
approval_required_before_merge: true
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fte-data-003c-production-odds-collection-control-plane.md'
  - '{project-root}/docs/phase1-deployment.md'
---

# Story FTE-DATA-003D: SharpAPI Entitled Sportsbook Ingestion

Status: in-review

## Story

As the operator of FIND THE EDGE,
I want the production SharpAPI pipeline to recognize and persist the sportsbooks included in the upgraded 25-book entitlement, including Pinnacle and other sharp books,
so that the platform retains the full licensed pricing evidence for explicitly versioned current or future evaluation policies instead of silently rejecting newly entitled books.

## Acceptance Criteria

1. **Verified entitlement and bookmaker catalog**
   - Given the upgraded SharpAPI credential, when the account contract is checked through the existing account boundary, then `maxBooks >= 25` is recorded as a bounded entitlement fact without logging the key, raw licensed response, plan price, or commercial terms.
   - A redacted canary across every enabled league captures the distinct sportsbook identifiers and labels actually returned by SharpAPI. The implementation adds an explicit, reviewed alias-to-canonical mapping for each approved book; it does not assume that the entitlement count is a stable catalog, that every book appears on every event, or that marketing names equal wire identifiers.
   - Pinnacle is mandatory for completion: at least one synthetic contract fixture and one explicitly authorized production canary must prove its exact provider identifier, canonical mapping, and persisted normalized observation. If Pinnacle is not returned for a sampled league/event, the canary reports `coverage-unverified` rather than fabricating success.

2. **Canonical sportsbook expansion**
   - `CanonicalSportsbookId`, `sportsbookRegistry`, aliases, display names, and production roles are extended in `packages/config/src/sportsbooks.ts`; the existing `normalizeSportsbook` boundary remains the only SharpAPI bookmaker-normalization path.
   - Hard Rock remains the sole `offered` sportsbook. The model explicitly separates `approved for collection` from `active in evaluation consensus`: Pinnacle and other approved entitled books may be persisted without receiving an evaluation weight. `circa`, `consensus`, and the current weighted comparison roster keep their behavior unless a separate versioned product decision changes it.
   - Unknown, empty, malformed, duplicate-alias, or conflicting bookmaker identities still fail closed with bounded `unknown-bookmaker` evidence. Runtime discovery must never auto-promote an arbitrary provider string into a canonical sportsbook or production comparison role.

3. **Full entitled-book ingestion through the existing pipeline**
   - Given valid SharpAPI rows for an approved entitled book, when featured or focused odds ingestion runs, then supported pregame main-market prices pass through the existing strict parser, exact canonical event binding, immutable snapshot persistence, exact-snapshot mirror, and monotonic `CURRENT` projection with `providerId = sharpapi` and the canonical sportsbook ID.
   - The existing supported market, selection, activity, suspension, alternate-line, stale-price, player-prop, participant, timestamp, and completeness fences apply identically to Pinnacle and every newly registered book. Expanding sportsbook coverage must not expand sports, leagues, markets, live betting, props, or derivatives.
   - Replaying the same normalized observations is idempotent; older observations cannot regress current state; same-ID/different-content conflicts fail closed; evidence from separate sportsbooks never shares snapshot identity.

4. **Collection and availability policy**
   - `productionOddsCollectionPolicies` include the approved collection books without adding a second provider or bypassing the existing SharpAPI-only production control plane. Refactor the current derivation from `productionSportsbookRoles` as needed so collection eligibility is not inferred from evaluation participation.
   - A book absent from a provider response is represented by the existing missing/partial availability evidence only when that book is expected for the league/market under a versioned policy. The system must not emit 25 × every-market false gaps merely because the account is entitled to 25 books globally.
   - The policy distinguishes `entitled`, `approved`, and `expected for league/market`. Book coverage changes are versioned configuration changes, not silent runtime mutations. Book-level absence must not mark SharpAPI globally unhealthy or trigger another paid provider call.

5. **Sharp-reference semantics remain local and auditable**
   - Pinnacle raw prices are persisted as ordinary provider observations under `sportsbookId = pinnacle`; they are not replaced by SharpAPI's derived `fair_odds`, `fair_probability`, `ev_percent`, or other vendor analytics.
   - Downstream no-vig, consensus, EV, qualification, and Play/No Bet calculations remain deterministic and locally versioned. This story does not change consensus weights or make Pinnacle authoritative by itself.
   - The expanded book set is not automatically double-counted. Any later consensus policy must select and weight canonical sportsbook IDs explicitly; provider provenance and bookmaker identity remain separate dimensions.

6. **Observability, rollout, and rollback**
   - Bounded telemetry exposes account book capacity, distinct approved books observed, normalized observation counts by canonical book, unknown-book rejection counts, expected-book gaps, and explicit Pinnacle coverage status without raw payloads, secrets, commercial terms, or unbounded provider labels.
   - Rollout uses an explicitly authorized canary first, then one enabled league, then the remaining enabled leagues. Existing immutable snapshots and current projections are retained throughout.
   - Rollback disables the newly approved collection entries or reverts the versioned catalog/policy; it never deletes or rewrites historical snapshots. Previously stored observations from a removed book remain auditable but are excluded from new active collection and evaluation policy.

7. **Automated verification and completion proof**
   - Synthetic/redacted fixtures cover Pinnacle plus representative additional books, alias/case/punctuation variants, all currently supported market structures, duplicate aliases, unknown books, missing books, suspended/closed rows, incomplete markets, pagination, replay, out-of-order observations, and snapshot identity separation by sportsbook.
   - Tests prove all approved canonical IDs are unique, all normalized aliases are collision-free, exactly one book has the `offered` role, Pinnacle is approved for collection but is not silently added to evaluation weights, expected-book availability is league/market scoped, and no unapproved provider string becomes ingestible.
   - `pnpm check`, focused provider/config/worker tests, `pnpm synth`, and `pnpm phase1:preflight` pass. A live canary is a separate, explicitly authorized verification because it consumes the paid external service; its bounded result records account capacity, Pinnacle observed/not-observed, and approved/unknown book counts only.

## Tasks / Subtasks

- [x] Freeze the upgraded account contract and returned bookmaker catalog (AC: 1, 6, 7)
  - [x] Use the existing server-side SharpAPI secret and `fetchSharpApiAccount` boundary to verify `maxBooks >= 25`; do not introduce browser credentials, plaintext environment values, or raw-response logging.
  - [x] Run an explicitly authorized, bounded canary across enabled leagues and capture only redacted distinct bookmaker identifiers/labels and coverage counts.
  - [x] Produce synthetic fixtures and a reviewed mapping table for the exact returned identifiers, including Pinnacle. Record regional/exchange/sharp-book distinctions rather than merging names speculatively.

- [x] Expand the canonical sportsbook registry and policy model (AC: 2, 4, 5)
  - [x] Add approved canonical IDs, display names, aliases, and logos only when assets exist in `packages/config/src/sportsbooks.ts`.
  - [x] Add an explicit collection-eligibility catalog/policy distinct from `defaultEvaluationPolicy.comparisonWeights`; change existing equality assertions to prove the weighted roster is a valid subset of collected comparison candidates.
  - [x] Add validation/tests for canonical-ID uniqueness, alias collision, exactly one `offered` book, and Pinnacle collection without implicit consensus promotion.
  - [x] Extend the versioned collection policy so entitlement, approved ingestion, evaluation participation, and league/market expectations are explicit and do not generate global false-missing evidence.

- [x] Reuse and harden SharpAPI normalization (AC: 2, 3)
  - [x] Extend synthetic SharpAPI fixtures/tests; do not add a Pinnacle-specific HTTP adapter, scraper, storage path, or direct Pinnacle credential.
  - [x] Preserve strict row bounds, typed/redacted errors, participant reconciliation, supported-market gates, and rejected-row accounting in `parseSharpApiOddsPage`.
  - [x] Prove featured and focused pages preserve all approved books returned for the same event and keep observation identities book-specific.

- [x] Persist expanded book evidence through the production control plane (AC: 3, 4)
  - [x] Reuse `persistSharpApiOddsPage`, `DynamoFixtureOddsAdapter`, exact snapshot indexes, and current projection ordering without a migration or history rewrite.
  - [x] Scope expected-book availability by league/market and keep missing coverage distinct from provider health, rate limit, quota, and entitlement state.
  - [x] Verify sealed-page recovery and replay remain deterministic when a page contains many books.

- [x] Add bounded operations and rollout evidence (AC: 1, 6)
  - [x] Update `docs/phase1-deployment.md` and/or `docs/runbooks/sharpapi.md` with catalog verification, canary, staged rollout, unknown-book alerting, and non-destructive rollback.
  - [x] Add bounded metrics/log dimensions from canonical allowlisted IDs only; never emit arbitrary provider labels as metric dimensions.
  - [x] Confirm the existing SharpAPI secret and IAM grant are reused; no new secret or direct Pinnacle network access is introduced.

- [ ] Complete verification (AC: 1-7)
  - [x] Run focused config/provider/worker/control-plane tests, `pnpm check`, `pnpm synth`, `pnpm phase1:preflight`, and `git diff --check`.
  - [ ] With explicit operator authorization, run one paid canary and save only its bounded verification summary. Do not make the default test suite network-dependent.

## Dev Notes

### Current State and Required Preservation

- `packages/providers/src/sharp-api.ts` already parses the account `max_books` field and rejects a wire row before grouping when `normalizeSportsbook` does not recognize its sportsbook. This is why newly entitled books are currently dropped. Extend the canonical registry rather than weakening parser validation.
- `packages/config/src/sportsbooks.ts` currently defines seven canonical IDs; Hard Rock is `offered`, four US books are `comparison`, and Circa/consensus have no production role. `packages/config/src/feed-coverage.ts` derives every production provider's `books` policy from `productionSportsbookRoles`; `feed-coverage.test.ts` currently equates collected comparison books with `defaultEvaluationPolicy.comparisonWeights` and explicitly excludes Pinnacle. This coupling must be replaced with collection eligibility plus a weighted-roster subset invariant.
- `apps/workers/src/sharp-api-ingestion.ts` normalizes each grouped bookmaker again, resolves an exact canonical event binding, creates sportsbook-specific immutable snapshot identities, persists availability states, and emits expected-market gaps from the configured `bookRoles`. Preserve those fences and ordering rules.
- `apps/workers/src/production-odds-control-plane.ts` and `live-odds-lambda.ts` are the sole production orchestration path. SharpAPI remains the sole live provider; this story expands bookmaker coverage inside its responses.
- `infra/cdk/src/foundation.ts` already injects `FTE_SHARP_API_SECRET_ID` and enables the production worker. Reuse that secret boundary and least-privilege IAM.
- Immutable snapshot rows intentionally have no TTL. No schema migration or historical rewrite is needed for new canonical sportsbook IDs.

### Architecture and Implementation Guardrails

- The plan upgrade authorizes this story's design, not a paid network call. The implementation may proceed with synthetic fixtures, but merge completion requires separate operator authorization for the bounded production canary in AC 1 and AC 7.
- Treat `25` as account capacity, not a hard-coded response-size assertion. SharpAPI coverage varies by event, league, market, region, and time.
- Treat provider marketing material as discovery context only. The authenticated account response and redacted wire fixtures define the executable contract.
- Keep a closed canonical allowlist. Dynamic discovery may report unknown identifiers for operator review, but cannot persist or activate them automatically.
- Do not add the vendor SDK solely for this story. The existing bounded `fetch`/parser implementation already owns authentication, pagination, retry metadata, and error classification.
- Do not consume SharpAPI-derived fair odds or EV fields as authoritative. Pinnacle observations feed existing local deterministic calculations only when a later versioned evaluation policy selects them.
- Do not add direct Pinnacle API access or website scraping. The licensed SharpAPI feed is the integration boundary.
- Do not add UI work, historical backfill, new sports/leagues/markets, SSE streaming, live betting, player props, consensus reweighting, or recommendation changes.

### Expected File Map

- UPDATE: `packages/config/src/sportsbooks.ts`, `sportsbooks.test.ts`, `feed-coverage.ts`, and `feed-coverage.test.ts`.
- UPDATE: `packages/providers/src/sharp-api.test.ts` and synthetic fixtures; update `sharp-api.ts` only if the verified wire identifiers expose a parser defect not solvable in canonical configuration.
- UPDATE: `apps/workers/src/sharp-api-ingestion.test.ts` and `production-odds-control-plane.test.ts`; update runtime code only for league/market-scoped expected-book policy or bounded telemetry.
- UPDATE: `docs/phase1-deployment.md` and/or `docs/runbooks/sharpapi.md`.
- CONDITIONAL UPDATE: `infra/cdk/src/foundation.ts` and synth tests only if new bounded configuration/metrics require deployment wiring. Do not add a new provider secret.
- NO CHANGE EXPECTED: database snapshot schema, API/UI surfaces, deterministic odds math, direct Pinnacle integration.

### Testing Requirements

- Use synthetic/redacted provider fixtures only in Git. Do not commit account payloads or licensed raw odds.
- Include at least one event containing Hard Rock, Pinnacle, and multiple comparison books so grouping and snapshot identity separation are tested together.
- Include a provider page with more than the current five production-role books and pagination across pages; prove merge/replay does not drop or duplicate books.
- Prove unknown books remain bounded rejections and cannot expand metric cardinality.
- Prove book absence affects only scoped availability evidence, not provider health or unrelated books/events.
- Preserve existing SharpAPI parsing, schedule reconciliation, sealed-page recovery, snapshot/current, Phase1 smoke, and boundary tests.

### Latest External Information

- SharpAPI's current product material says its feed includes Pinnacle among 45+ available sportsbooks and supports filtering by canonical `pinnacle`; actual account entitlement and returned wire identifiers remain the implementation contract.
- SharpAPI markets built-in fair odds and EV derived from Pinnacle. FIND THE EDGE must continue to ignore those derived values for authoritative calculations and persist raw Pinnacle prices as ordinary evidence.

### References

- [Source: `_bmad-output/implementation-artifacts/spec-fte-data-003b-sharpapi-redundant-odds-and-betting-splits.md`]
- [Source: `_bmad-output/implementation-artifacts/spec-fte-data-003c-production-odds-collection-control-plane.md`]
- [Source: `_bmad-output/planning-artifacts/epics-and-stories.md` — FTE-DATA-003B and Epic 4]
- [Source: `packages/config/src/sportsbooks.ts`]
- [Source: `packages/config/src/feed-coverage.ts`]
- [Source: `packages/providers/src/sharp-api.ts` — account and odds-page parsing]
- [Source: `apps/workers/src/sharp-api-ingestion.ts` — normalization, persistence, and availability evidence]
- [Source: `apps/workers/src/production-odds-control-plane.ts`]
- [Source: `apps/workers/src/live-odds-lambda.ts`]
- [Source: `docs/phase1-deployment.md`]
- [SharpAPI betting odds overview](https://sharpapi.io/features/betting-odds-api)
- [SharpAPI Pinnacle feed](https://sharpapi.io/sportsbooks/pinnacle-odds-api)

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Authorized bounded canary verified Sharp tier capacity `maxBooks=25` and
  Pinnacle coverage without retaining credentials, commercial terms, or raw
  licensed responses. A ten-page MLB scan remained paginated, so capacity is
  explicitly not treated as a complete stable catalog.
- One-page samples across all enabled leagues observed 23 exact wire IDs:
  `ballybet`, `betano`, `betmgm`, `betonline`, `betrivers`, `bovada`, `caesars`,
  `circa`, `draftkings`, `fanatics`, `fanatics_markets`, `fanduel`, `fliff`,
  `hardrock`, `kalshi`, `novig`, `onexbet`, `pinnacle`, `polymarket`,
  `prophetx`, `sbobet`, `stake`, and `thescorebet`.
- The closed canonical registry and collection policy use only those observed
  identities. Collection approval is separate from evaluation weights, and
  expected absence is league/market scoped.
- Production odds parsing accepts a bounded terminal `data=null` initial page
  only with explicit zero count and total evidence. A cursor page may omit its
  per-page count while retaining a nonnegative global total. Provider error
  envelopes, contradictory counts, stale terminal cursors, malformed JSON, and
  malformed rows remain fail-closed. Fixed endpoint/inner-stage diagnostics do
  not retain response bodies or request URLs.
- HTTP 401/403 failures are terminal even when the response body is HTML, empty,
  or malformed. Other HTTP 4xx responses are terminal provider rejections and
  cannot consume the one structural-response retry.
- Expected-book coverage reconstructs and merges the authoritative normalized
  SharpAPI event material from every durable sealed page in cursor order before
  final persistence and missing-evidence reconciliation. Cross-page provider
  UUID, participant, orientation, and price-identity conflicts fail closed;
  sportsbook-row start times are non-authoritative because the reconciled
  schedule owns canonical event time. Selection siblings split across pages
  complete as one market, while suspended, stale, and incomplete evidence
  cannot be downgraded to missing.
- Schedule-expected events omitted from all odds pages bind through the exact
  provider-event mapping and receive deterministic group-level missing
  evidence without fabricating provider events or UUIDs. Distinct approved-book
  and Pinnacle coverage is derived from observed merged provider evidence;
  usable persisted-book counts are reported separately. Operational metrics are
  documented as at-least-once.
- Featured odds collection reserves the two-request retry ceiling before the
  first paid call and refunds the unused unit after a one-call success. A double
  structural failure retains cost two. Provider-rejected schedule, account, and
  splits diagnostics retain their bounded error code and validation stage in
  attempts, runs, health, and metrics.
- The authorized paid local SharpAPI contract traversed all enabled leagues and
  entitled splits in under ten seconds. The current first MLB page did not include a
  persistable Pinnacle market, so that sample correctly remains
  `coverage-unverified`; the broader authorized catalog scan remains the bounded
  evidence that the entitlement returns Pinnacle. No deployment was used for
  validation.
- A second authorized local contract traversed every production league through
  its terminal odds page and persisted real aggregate observations. The rollout
  failure was isolated to expired durable cursors from earlier terminal runs and
  a valid stable-price repricing repeated across EPL pages, not to the credential
  or the current SharpAPI endpoint contract.
- Terminal SharpAPI cursor runs now restart at page one only after the owner lease
  expires, only for the explicitly opted-in final-persistence provider, and only
  when a sealed first page proves that an opaque cursor existed. The failed run
  remains immutable audit evidence, while a claim-and-clear handoff prevents a
  concurrent restart.
- Cross-page stable price IDs select the newest `observedAt` evidence (later page
  wins timestamp ties) while any changed provider UUID, participant, sportsbook,
  market, or selection identity remains a bounded contract failure. Delayed or
  postponed sportsbook rows for that exact event retain the schedule-authoritative
  start time instead of splitting one game into duplicates.
- The exact production control-plane path now passes locally against live
  SharpAPI for all five enabled leagues, including cursor pagination,
  reconstruction, normalization, and persistence, without deploying to test.
- `pnpm check`, credential-safe `pnpm synth`, `pnpm phase1:preflight`, and
  `git diff --check` passed after the terminal-page and sealed-replay changes.
- Remaining live proof before story completion: execute one explicitly authorized
  ingestion canary that persists and reads back a normalized Pinnacle snapshot;
  record only bounded counts and observed/coverage-unverified status.

### File List

- `_bmad-output/implementation-artifacts/spec-fte-data-003d-sharpapi-entitled-sportsbook-ingestion.md`
- `apps/workers/src/odds-control-plane.test.ts`
- `apps/workers/src/odds-control-plane.ts`
- `apps/workers/src/production-odds-control-plane.test.ts`
- `apps/workers/src/production-odds-control-plane.ts`
- `apps/workers/src/sharp-api-ingestion.test.ts`
- `apps/workers/src/sharp-api-ingestion.ts`
- `apps/workers/src/live-odds-lambda.ts`
- `apps/workers/src/sharp-api-live-contract.test.ts`
- `scripts/phase1-environment-smoke.mjs`
- `scripts/phase1-environment-smoke.test.mjs`
- `docs/runbooks/sharpapi.md`
- `packages/database/src/odds-control-plane.ts`
- `packages/domain/src/fixture-odds.ts`
- `packages/providers/src/sharp-api.test.ts`
- `packages/providers/src/sharp-api.ts`

### Review Triage Log

#### 2026-08-05 — Adversarial review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 8 (high: 5, medium: 3, low: 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Distinguished initial and cursor terminal null pages and
    required request-appropriate zero evidence.
  - `[high]` `[patch]` Failed closed on malformed success discriminants,
    meaningful provider error envelopes, contradictory pagination, and stale
    terminal cursors.
  - `[high]` `[patch]` Restricted retries to one structurally invalid successful
    response while making authentication and ordinary client errors terminal.
  - `[high]` `[patch]` Reconstructed the authoritative run from durable sealed
    pages and merged cross-page bookmaker and price evidence before final
    persistence.
  - `[high]` `[patch]` Prevented expected-book reconciliation from downgrading
    suspended, stale, or incomplete evidence to missing.
  - `[medium]` `[patch]` Preserved bounded endpoint and validation-stage
    diagnostics across account, odds, focused odds, schedule, and splits.
  - `[medium]` `[patch]` Added deterministic missing evidence for scheduled
    events omitted from all odds pages through exact provider-event bindings.
  - `[medium]` `[patch]` Derived approved-book and Pinnacle telemetry only from
    successfully persisted merged evidence.

#### 2026-08-05 — Adversarial review pass 2

- intent_gap: 0
- bad_spec: 0
- patch: 5 (high: 3, medium: 2, low: 0)
- defer: 1
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Merged selection siblings split across provider pages and
    rejected cross-page event identity, orientation, and price conflicts.
  - `[high]` `[patch]` Reserved the paid two-call retry ceiling before the first
    request and reconciled the unused unit after a one-call success.
  - `[high]` `[patch]` Propagated provider-rejection codes and validation stages
    into attempts, runs, health state, and bounded metrics.
  - `[medium]` `[patch]` Added local contract coverage for legacy sealed-page
    recovery, omitted scheduled events, and availability-state preservation.
  - `[medium]` `[patch]` Cleared stale failure-stage diagnostics after a healthy
    provider result and documented operational metrics as at-least-once.
- deferred_findings:
  - `[high]` `[defer]` The explicitly authorized production canary must still
    persist and read back one Pinnacle snapshot before this story can be marked
    done. The implementation remains `in-review` and the final verification
    task is intentionally unchecked until deployment.

#### 2026-08-05 — Adversarial review pass 3

- intent_gap: 0
- bad_spec: 0
- patch: 9 (high: 1, medium: 8, low: 0)
- defer: 0
- reject: 0
- addressed_findings:
  - `[high]` `[patch]` Deferred persistence until the complete sealed run is
    reconstructed, eliminating page-by-page plus final replay duplicates.
  - `[medium]` `[patch]` Preserved each price's original retrieval boundary so
    legacy recovery remains immutable and idempotent.
  - `[medium]` `[patch]` Reconciled terminal and ambiguous one-call failures
    against the reserved two-call ceiling without permitting paid recall.
  - `[medium]` `[patch]` Reserved and reconciled recovery probes at their actual
    one-account-call cost.
  - `[medium]` `[patch]` Retained featured and focused failure stages in attempts,
    runs, health state, and bounded metrics while clearing stale stages.
  - `[medium]` `[patch]` Validated focused and terminal array pagination without
    replacing contradictory provider metadata.
  - `[medium]` `[patch]` Accepted a coherent focused terminal null page as valid
    no-coverage evidence.
  - `[medium]` `[patch]` Allowed bounded cross-page start drift and remapped
    reversed participant orientation before merging selections.
  - `[medium]` `[patch]` Separated observed sportsbook coverage from usable
    persisted sportsbook counts.

#### 2026-08-05 — Adversarial repair audit

- intent_gap: 0
- bad_spec: 0
- patch: 4 (high: 0, medium: 4, low: 0)
- defer: 1
- reject: 0
- addressed_findings:
  - `[medium]` `[patch]` Reconciled known dispatch count even when transport
    outcome remains ambiguous and replay is fenced.
  - `[medium]` `[patch]` Required terminal initial/focused totals to agree with
    returned array rows.
  - `[medium]` `[patch]` Preserved per-event and per-price retrieval boundaries
    when later unrelated pages cross an event's start time.
  - `[medium]` `[patch]` Removed stale failure-stage carryover and propagated
    focused endpoint stages.
- deferred_findings:
  - `[high]` `[defer]` Production Pinnacle persist/readback remains the sole live
    acceptance item and will be completed only after this reviewed commit is
    deployed.

#### 2026-08-06 — Post-deployment cursor and repricing review

- intent_gap: 0
- bad_spec: 0
- patch: 8 (high: 3, medium: 5, low: 0)
- defer: 1
- reject: 3
- addressed_findings:
  - `[high]` `[patch]` Replaced unconditional terminal-run continuation deletion
    with an explicit provider opt-in, sealed-cursor proof, expired-lease boundary,
    exclusive ownership claim, and audited fresh run from page one.
  - `[high]` `[patch]` Accepted stable price IDs repriced across provider pages by
    monotonic observation time while retaining strict event/book/market/selection
    identity conflicts.
  - `[high]` `[patch]` Required live all-league pagination to reach a terminal page
    and increased the explicitly paid test timeout without weakening its page cap.
  - `[medium]` `[patch]` Preserved an evidence-intent recovery update in the local
    durable run before evaluating cursor restart eligibility.
  - `[medium]` `[patch]` Covered both provider rejection and invalid-response cursor
    recovery while proving the old failed run is retained.
  - `[medium]` `[patch]` Added deterministic later-repricing and changed-identity
    cross-page reconstruction tests.
  - `[medium]` `[patch]` Enforced completed/result-reason coherence in release
    diagnostics and retained failed provider outcomes as smoke failures rather than
    successes.
  - `[medium]` `[patch]` Added the bounded schedule provider-rejection reason to the
    closed diagnostic vocabulary.
  - `[high]` `[patch]` Made the reconciled schedule authoritative for start time
    after a live local production-path test proved the same exact provider event
    UUID can retain different pre-delay times on sportsbook pages. Provider UUID
    and participant identity remain strict.
  - `[high]` `[patch]` Prohibited terminal cursor abandonment whenever the durable
    run already records committed evidence, including evidence intent recovered
    from a sealed page.
  - `[high]` `[patch]` Removed mutable provider presentation labels from stable
    price identity so valid line, price, and rendered-label movement selects the
    newest observation without weakening provider/market/selection ID checks.
- rejected_findings:
  - `[high]` `[reject]` Unbounded odds-row start drift does not control persistence:
    the exact schedule binding supplies canonical start time, post-start pages are
    discarded against that time, and large drift requires an exact source mapping
    plus both participants. Existing tests prove delayed rows cannot rewrite the
    schedule and retrieval at the canonical start persists zero observations.
- deferred_findings:
  - `[medium]` `[defer]` An expired running cursor or older policy revision may
    incur one bounded failed attempt before entering the audited terminal restart
    path. This delays recovery but does not duplicate or corrupt evidence; policy-
    version cursor invalidation belongs in the next control-plane hardening story.
  - `[high]` `[defer]` The production canary must still persist and read back one
    Pinnacle snapshot before this story can be marked done.
