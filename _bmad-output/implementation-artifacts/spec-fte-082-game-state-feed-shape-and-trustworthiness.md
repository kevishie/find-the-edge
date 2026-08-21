---
title: "FTE-082: Game State Feed Shape and Trustworthiness"
type: "spike"
created: "2026-08-14"
status: "in-progress"
baseline_revision: "f4d87ec04914eccd22f818f80e6425893811b5d6"
baseline_commit: "f4d87ec04914eccd22f818f80e6425893811b5d6"
review_loop_iteration: 3
followup_review_recommended: true
context:
  - "_bmad-output/planning-artifacts/epics-and-stories.md"
  - "_bmad-output/planning-artifacts/architecture.md"
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/product-brief.md"
  - "docs/runbooks/sharpapi.md"
warnings:
  - "live-provider-observation-required"
  - "approval-required-before-merge"
---

<intent-contract>

## Intent

**Problem:** SharpAPI Game State is a derived multi-book claim whose identity, coverage, cadence, lag, disagreement, lifecycle transitions, and correction behavior have not been measured well enough to authorize ingestion or product use.

**Approach:** Build a bounded, read-only research sampler outside production serving code, then use it across an independently frozen full MLB slate and short probes of every served sport. Retain only sanitized derived observations and hashes. Publish a dated evidence report with explicit unknowns and Go / Conditional / No-Go recommendations for FTE-083 through FTE-089.

## Boundaries & Constraints

**Always:** Resolve the credential from `find-the-edge/<stage>/sharpapi` in Secrets Manager; derive the served roster from the existing SharpAPI league registry; make `/gamestate` and each sport route explicit; count every dispatched request; freeze a maximum request budget before the first call; keep provider observation time distinct from retrieval time; compare identity to existing canonical events without minting or mutating anything; preserve complete derived observation sequences; state denominators and independent truth sources; and label unobserved or unexposed behavior `unknown`.

**Block If:** The add-on is not currently entitled; the request budget or rate ceiling cannot be established; a safe independent truth source or full-slate denominator cannot be frozen; paid-response retention terms would be violated; the sampler would need a production write; or required observations cannot be distinguished from guesses.

**Never:** Commit or log credentials, raw paid payloads, request URLs containing secrets, full provider responses, confidential terms, user data, or arbitrary provider keys; infer that provider IDs equal canonical IDs; mint events; alter boards, bets, picks, results, settlement, or lifecycle state; call billing or upgrade endpoints; retry ambiguous or terminal failures; label consensus as official; treat absence of a revision as proof that finals are immutable; extrapolate MLB coverage to another sport; or authorize automatic settlement or money movement.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Failure handling |
| --- | --- | --- | --- |
| Entitled preflight | One aggregate request and one request for each observed served-sport route | Record bounded schema signature, bytes, row counts, timestamps, route agreement, rate metadata, and sanitized field presence | Stop before scheduled collection if entitlement, shape, or budget is unverified |
| Terminal provider denial | HTTP 401/403, including HTML or empty body | Bounded `unauthorized` or `not-entitled` result; no payload retained | No retry; no artifact claiming an observation window |
| Rate limit or exhausted budget | HTTP 429, authoritative remaining allowance below reserve, or local request cap reached | Record bounded stop reason and completed request count | Honor retry metadata only when the frozen protocol permits; never exceed the cap |
| Malformed or oversized success | Invalid JSON, provider-declared error, unexpected root, or body over the fixed bound | Reject the sample and record a bounded stage code | Do not loosen parsing or preserve the body |
| Unknown sport/league catalogue | Aggregate response includes a catalogue outside the served registry | Count and classify it as off-roster pollution | Never query an arbitrary route or treat it as served |
| Identity mapping | Row matches, ambiguously matches, or fails to match a canonical event | Emit only bounded mapping outcome, canonical ID when matched, and reason code | Never create or update an event |
| Duplicate or ID churn | Same fixture appears under multiple provider IDs or an ID changes | Preserve separate hashed observations and flag duplicate/churn evidence | Do not collapse without evidence |
| Consensus disagreement opaque | Only `book_count` / `primary_book` are exposed | State that constituent disagreement is not measurable | Do not estimate votes or variance |
| Delayed/revised final not observed | Bounded window ends without the occurrence | Report `unknown within <window>` | Do not report `never` |
| Late final crosses UTC/day boundary | Game finishes near the collection boundary | Continue through the predeclared post-final retention window | Denominator remains the frozen slate, not provider presence |
| Provider/API outage | Transport ambiguity, 5xx, or timeout after dispatch | Count the attempt and record a bounded unavailable/ambiguous outcome | No blind retry; raw errors and URLs stay out of output |

</intent-contract>

## Story

As the product and ingestion owner,
I want a reproducible, bounded assessment of SharpAPI Game State,
so that later lifecycle, display, completeness, and settlement work is authorized only by measured evidence.

## Acceptance Criteria

1. A dated research artifact answers identity mapping, schema/nullability, cadence, observed lag, transition behavior, final revision behavior, and consensus disagreement, with every conclusion linked to captured derived samples and a stated denominator.
2. `/gamestate` and the sport-specific route for every currently served sport are sampled. Aggregate-versus-sport row agreement, off-roster catalogue pollution, response size, schema signature, field presence, and provider/retrieval timestamps are recorded without raw paid payloads.
3. Identity results report matched, unmatched, ambiguous, duplicate, participant/start-time mismatch, and provider-ID-churn counts against existing canonical events. Unresolved rows never create or mutate an event.
4. Cadence and lag are reported as distributions/ranges across a fixed sampling protocol, including start, period break, resumption, delay/postponement when observed, final, stale, missing, regressing, and out-of-order transitions. The report proposes a game-state freshness bound rather than borrowing the odds-specific 15-minute threshold.
5. Coverage is reported against an independently frozen complete MLB slate as numerator/denominator for pregame, in-play, first final, and each predeclared post-final retention checkpoint, including missing, surplus, duplicate, and late-retained rows. If no historical 2026-08-12 corpus exists, use the next complete MLB slate and retain the 15-game 2026-08-12 incident only as a comparison case.
6. Wrong-score, status, clock/period, false-live, false-final, and coverage errors use a named independent truth source, a frozen comparison protocol, and explicit sample limits. Another SharpAPI endpoint is not independent truth.
7. Constituent-book disagreement is quantified only if constituent observations are exposed. Otherwise the report states that disagreement is opaque and identifies that as a blocker or contract change for FTE-083.
8. The sampler refuses unbounded or arbitrary endpoints, validates a maximum request count before dispatch, records authoritative rate metadata when present, stops on terminal entitlement/configuration failures, and produces no misleading success artifact after an incomplete required window.
9. The committed evidence contains only bounded derived observations, hashes, route/sport/league labels from closed sets, timestamps, counts, latency, mapping reason codes, and declared protocol metadata. It contains no credential, raw response, unbounded provider text, user data, commercial terms, or mutable production state.
10. The report contains explicit `Can trust for`, `Cannot trust for`, and `Unknown within observation window` sections plus Go / Conditional / No-Go recommendations for each of FTE-083 through FTE-089, by sport/use case where evidence differs.
11. The report calls out the stale Epic 14 running-order sentence: FTE-087 cannot precede FTE-082/FTE-083 under its own dependency and completeness-oracle contract. It also records that FTE-089 requires a much longer comparison period than this spike.
12. Automated sampler tests use sanitized fixtures only and cover endpoint allowlisting, request-budget exhaustion, terminal/ambiguous failures, oversized/malformed responses, schema hashing, derived redaction, aggregate/sport reconciliation, mapping outcomes, lifecycle diffs, and no-artifact-on-incomplete-required-data. `pnpm check` passes.
13. The spike remains non-serving and approval-gated. No provider activation, billing change, production ingestion, database write, route, UI, board rule, bet settlement, or automatic money movement is added.

## Code Map

- `scripts/game-state-spike.mjs` — new read-only CLI and pure normalization/analysis helpers; the only network surface is the fixed SharpAPI Game State route set and exact Secrets Manager lookup.
- `scripts/game-state-spike.test.mjs` — sanitized fixture and process-level contract tests; never calls AWS or SharpAPI.
- `scripts/game-state-truth.mjs` and `scripts/game-state-truth.test.mjs` — offline append-only truth-sidecar validation and hash-bound comparison; never calls AWS or the provider.
- `package.json` — add a focused `game-state:spike` command and test alias without adding dependencies.
- `_bmad-output/planning-artifacts/research/technical-game-state-feed-trustworthiness-research-<date>.md` — final evidence-backed judgement created only after the observation protocol completes.
- `_bmad-output/implementation-artifacts/game-state-samples/<window>.jsonl` — optional committed derived-only observation corpus; no raw body or full provider object.
- `_bmad-output/implementation-artifacts/fte-082-game-state-preflight-2026-08-14.md` — committed summary and integrity reference for the successful four-route staging preflight.
- `docs/runbooks/sharpapi.md` — reconcile the stale “disabled” statement only after the live entitlement preflight, and document the bounded research command and stop rules.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `ready` during implementation, `in-progress` during live observation, and `done` only after approval of the final evidence report.
- `packages/providers/src/sharp-api.ts` — reuse the base URL, served league registry, canonical validation limits, failure taxonomy, response-size discipline, and rate metadata semantics; do not add a production Game State adapter in this story.
- `apps/workers/src/schedule-reconciliation.ts` and existing database event lookup surfaces — reference the canonical mapping rules only; the spike must not write through them.

## Tasks / Subtasks

- [x] Build the bounded sampler (AC: 2, 8, 9, 12, 13)
  - [x] Parse a strict CLI contract with an explicit stage, mode, output, interval, duration, post-final window, and maximum request count; reject duplicate/unknown flags and invalid budgets before AWS/network access.
  - [x] Resolve only `find-the-edge/<stage>/sharpapi`, validate AWS identity/stage binding, request only aggregate plus the closed served-sport route set, and use the existing `X-API-Key`/timeout/response-bound conventions.
  - [x] Normalize each response immediately into bounded derived observations and discard the raw body; hash canonical schema/row state without persisting provider payloads.
  - [x] Make required-window output atomic: write a temporary derived artifact and publish it only after all required endpoints and samples complete.
- [x] Implement analysis and identity evidence (AC: 1–7, 9)
  - [x] Reconcile aggregate and sport-specific observations without assuming shared provider IDs.
  - [x] Compare rows to a frozen canonical-event manifest using league, participants, orientation, and start instant; report matched/unmatched/ambiguous/duplicate/churn reasons and never mint.
  - [x] Preserve append-only derived state transitions and calculate cadence, lag, lifecycle, regression, and retention summaries.
  - [x] Freeze the independent truth source, MLB slate denominator, phase definitions, tolerance rules, and maximum observation window before collection.
- [x] Validate without paid calls (AC: 8, 9, 12, 13)
  - [x] Add pure unit tests and child-process CLI tests using sanitized fixtures.
  - [x] Prove no AWS/provider access occurs after invalid input and no final artifact exists after required-series failure.
  - [x] Scan fixtures/output for credentials, raw-response fields, unbounded labels, and accidental user/commercial data.
- [ ] Execute the evidence protocol (AC: 1–10)
  - [x] Run a one-request-per-route entitlement/schema/rate-budget preflight; stop and record the external blocker if access is not active.
  - [x] Run a short low-cadence probe across every served sport before the full-slate window.
  - [ ] Freeze and observe the next complete MLB slate from pregame through the stated post-final retention window, with manual/official truth checkpoints.
  - [ ] If delay or final-revision events do not occur within the maximum window, record them as unknown rather than extending indefinitely.
- [ ] Publish and review the decision (AC: 10, 11, 13)
  - [ ] Produce the dated research report with evidence references, per-phase counts, accuracy/lag distributions, trust limits, and story-by-story recommendations.
  - [x] Correct the Epic 14 sequencing contradiction in planning text without changing downstream dependencies or acceptance contracts.
  - [ ] Run independent acceptance, blind, and edge-case reviews; retain approval-required state until the evidence judgement is accepted.

### Review Findings

- [x] [Review][Patch] Make fixtureless AWS identity and secret resolution runnable from the root package without undeclared modules. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Keep semantic game-state revisions separate from consensus timestamp and book-count metadata churn. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Retain bounded period and possession evidence and give final, delay, and break signals precedence over generic live flags. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Make schema hashes independent of response row order and catalogue size. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Parse rate resets with bounded epoch-seconds, epoch-milliseconds, relative-seconds, and HTTP-date semantics. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Schedule ticks against absolute monotonic deadlines and record dispatch drift/latency. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Require authoritative rate metadata or a frozen ceiling and enforce a reserve before every later request. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Bind post-final minutes to the planned request count and explicit retention window instead of metadata only. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Mark fixture output synthetic and prevent it from masquerading as live/sample evidence. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Stream response bodies through an incremental byte limit. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Reserve and spool bounded derived evidence to an exclusive sibling file and publish atomically. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Require a frozen identity manifest for sample mode, implement mismatch, ambiguity, duplicate and churn outcomes, and join later append-only truth through a hash-bound offline pass. [`scripts/game-state-spike.mjs`, `scripts/game-state-truth.mjs`]
- [x] [Review][Patch] Remove future-known truth from the pre-run manifest; predeclare an independent truth sidecar, append checkpoints during the window, seal it to the completed evidence, and reject edits or records after the seal. [`scripts/game-state-spike.mjs`, `scripts/game-state-truth.mjs`]
- [x] [Review][Patch] Initialize the truth header from the exact validated manifest file, commit both hashes into sampler evidence before the first provider request, and require exact equality during offline analysis. [`scripts/game-state-spike.mjs`, `scripts/game-state-truth.mjs`]
- [x] [Review][Patch] Preserve a competing sampler's output lock and reject undeclared nested identity-source fields. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Share and enforce a bounded evidence-size contract between collection and offline analysis so the measured full-slate corpus remains analyzable. [`scripts/game-state-spike.mjs`, `scripts/game-state-truth.mjs`]
- [x] [Review][Patch] Acquire the output lock before checking terminal artifacts, require exact canonical header bytes, reject a truth protocol frozen before its manifest, and reject incomplete route/tick evidence. [`scripts/game-state-spike.mjs`, `scripts/game-state-truth.mjs`]
- [x] [Review][Patch] Reject transcript newline normalization, derive expected tick count from the frozen duration contract, and atomically publish bounded failure diagnostics. [`scripts/game-state-spike.mjs`, `scripts/game-state-truth.mjs`]
- [x] [Review][Patch] Validate the closed sport-route mapping against the existing SharpAPI served registry. [`scripts/game-state-spike.test.mjs`]
- [x] [Review][Patch] Add sampler tests to the repository-wide `pnpm check` gate. [`package.json`]
- [x] [Review][Patch] Preserve terminal-clock signals without treating an unverified heuristic as an authoritative final. [`scripts/game-state-spike.mjs`]
- [x] [Review][Patch] Keep FTE-082 in progress until the dated live evidence report satisfies AC1, AC4–AC7, AC10, and approval. [`_bmad-output/implementation-artifacts/sprint-status.yaml`]

## Dev Notes

### Protocol decisions to freeze before the first paid request

- Exact served-sport roster and route-segment mapping, derived from `sharpApiLeagues` and confirmed against the aggregate response; unknown routes require a code change/review, not a CLI string.
- Request count formula: `required routes × required samples`, including any permitted retry. Every dispatched attempt consumes the budget. The CLI must reject a cap lower than the computed protocol or higher than its hard safety ceiling.
- Fixed cadence, short-probe duration, full-slate start/end, post-final checkpoints, maximum revision-observation window, rate reserve, response byte ceiling, and clock-skew tolerance.
- Frozen MLB slate manifest from an independent official source before first pitch: Eastern calendar date, participants, scheduled start, canonical event ID where present, and evidence reference.
- Independent truth checkpoints and error taxonomy. Official scoreboard/broadcast/manual timestamps may be used; SharpAPI schedule, odds, or splits may corroborate identity but are not independent correctness truth.
- Retention/licensing decision. Until written permission says otherwise, raw responses exist only in encrypted local scratch for the duration of immediate normalization and are then destroyed; git receives derived rows/hashes only.

### Architecture and implementation constraints

- Provider DTOs remain at the boundary. A future FTE-083 model must not be smuggled into this script.
- Canonical event IDs are primary; provider IDs are aliases/evidence. Start instant is required to distinguish doubleheaders and same-participant repeats.
- Reuse existing SharpAPI semantics: `X-API-Key`, 10-second timeout, 10 MB response ceiling or a stricter spike ceiling, terminal 401/403, explicit 429 metadata, bounded stage codes, and no raw exception/body/URL output.
- Do not reuse `scripts/replay-odds-capture.mjs` raw-capture behavior for committed evidence. Its write-refusal proxy is useful precedent, but this spike should not need a Dynamo write-capable object at all.
- Tests must inject the fetcher, clock, sleeper, secret resolver, canonical manifest, and output writer. The default command may use AWS CLI or existing workspace AWS SDK packages; add no dependency solely for the spike.
- Output labels are closed/bounded. Provider event identifiers in committed derived evidence should be one-way keyed hashes unless a bounded ID is essential to a reproducible canonical mapping and retention terms permit it.
- Required absence is explicit. A zero-row route is a measured zero only when the response is valid and the protocol expected that route; a missing request/datapoint is failure, never zero-filled.

### Resolved and unresolved planning conflicts

- The 2026-08-12 15-game MLB slate is a measured incident denominator, but no whole-day Game State corpus exists in the repository. The prospective protocol must use the next complete slate unless an authorized historical endpoint/corpus is discovered.
- “Sports we serve” means the distinct sports represented by currently enabled SharpAPI league/coverage configuration, not every sport named in the long-term PRD.
- A short spike cannot prove that a revision never happens or support FTE-089 witness retirement. It can report observed revisions and define the longer counterfactual study FTE-089 requires.
- Known fields expose `book_count` and `primary_book`, not constituent votes. If that remains true, FTE-083’s disagreement-preservation acceptance criterion cannot be met without a provider contract/API change.
- Current official public documentation for the Game State contract was not discoverable during story creation. Live preflight evidence and any account documentation must therefore be cited directly in the report; marketing prose is not an API contract.

### References

- [Epic 14 and FTE-082 contract] `_bmad-output/planning-artifacts/epics-and-stories.md` — “Epic 14: Live Game State” and “FTE-082: Spike - Game State Feed Shape and Trustworthiness”.
- [Provider isolation, canonical identity, immutable evidence, secret handling] `_bmad-output/planning-artifacts/architecture.md` — provider, event identity, evidence, and security sections.
- [Fail-closed evidence, provider coverage, privacy, quota/cost constraints] `_bmad-output/planning-artifacts/prd.md` — binding amendments and non-functional requirements.
- [Current SharpAPI credential, failure, quota, and redaction contract] `docs/runbooks/sharpapi.md`.
- [Served league roster and provider request conventions] `packages/providers/src/sharp-api.ts`.
- [2026-08-12 full-slate/identity incident evidence] `_bmad-output/deferred-work.md` — 2026-08-12 incident entry.

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Debug Log References

### Completion Notes List

- Built and adversarially reviewed the bounded sampler, atomic failure/success evidence paths, schema/identity/lifecycle analyzers, disagreement counters, and offline independent-truth join.
- Split the frozen identity denominator from later independent truth observations and added transcript/evidence hash sealing so prospective truth cannot be backfilled into the pre-run contract.
- Added an exclusive pre-run truth initializer and sampler-bound header/manifest hashes so the comparison protocol is reproducible and hindsight-created headers are rejected.
- Identified the 2026-08-15 official 15-game MLB slate as the next denominator candidate. Staging and the provider schedule now reconcile all 15 fixtures, but the Game State catalogue exposed only 9 uniquely participant-mappable fixtures during the short-probe window and its event ids did not equal schedule ids. The full-slate manifest therefore remains deliberately unfrozen until a near-first-pitch identity recheck. See `fte-082-mlb-slate-readiness-2026-08-15.md`.
- Completed the 2026-08-14 staging preflight: 4/4 requests, 448 derived observations, exact aggregate/sport agreement for baseball, football, and soccer, and material off-roster pollution.
- Completed the 2026-08-14 short fixed-cadence probe: 4 ticks, 16/16 requests, 1,633 derived observations, exact aggregate/sport agreement across every served sport, and bounded authoritative rate metadata throughout. See `fte-082-game-state-short-probe-2026-08-14.md`.
- Kept the story in progress because a full MLB slate, post-final window, final report, and approval are still outstanding.

### File List

- `scripts/game-state-spike.mjs`
- `scripts/game-state-spike.test.mjs`
- `scripts/game-state-truth.mjs`
- `scripts/game-state-truth.test.mjs`
- `package.json`
- `docs/runbooks/sharpapi.md`
- `_bmad-output/implementation-artifacts/fte-082-game-state-preflight-2026-08-14.md`
- `_bmad-output/implementation-artifacts/fte-082-mlb-slate-readiness-2026-08-15.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/planning-artifacts/epics-and-stories.md`

## Spec Change Log

- 2026-08-14: Created the implementation-ready research story, corrected the historical-slate and dependency-order contradictions, and froze security, request-budget, evidence, and truth-source gates before any paid observation.
- 2026-08-14: Completed the bounded live preflight, repaired the observed provider envelope/timestamp/disagreement contract, added the two-phase truth workflow, and retained `in-progress` pending the full observation window and decision report.
- 2026-08-14: Closed three adversarial review iterations, passed 46 focused tests and the full repository gate, and recorded the 15-game 2026-08-15 slate candidate plus its two unresolved staging mappings.
- 2026-08-14: Completed and recorded the four-tick short probe; retained `in-progress` because the full MLB lifecycle/retention window, independent truth comparison, final report, and approval remain outstanding.
