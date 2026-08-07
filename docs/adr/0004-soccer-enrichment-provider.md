# ADR 0004: Soccer Enrichment Provider

- Status: Accepted
- Date: 2026-08-07
- Story: FTE-039
- Decision owner: Kevishie
- Decision class: Provisional architecture approval; not procurement or production approval

## Context

FIND THE EDGE needs soccer fixtures, venues, rosters, confirmed and predicted lineup states, injuries, suspensions, and team/player/match statistics for MLS, EPL, Liga MX, and UCL. SharpAPI already supplies the canonical production schedule and odds context. The enrichment choice must improve scouting without allowing a vendor DTO, vendor identity, uncertain field, or unclear license to become domain truth.

Current public evidence supports a staged choice rather than unconditional activation. Sportmonks ranks highest for a bounded self-service field trial under the fixed decision policy in the supporting research. Sportradar exposes stronger premium update, identity, and advanced-data machinery but requires coverage, package, and use rights to be negotiated. Stats Perform/Opta is compelling for analytics depth, but public evidence does not establish the complete pre-match availability feed or the archive and AI rights required here. API-Football's public terms do not grant the publication license required for production use.

The supporting research is [_bmad-output/planning-artifacts/research/technical-soccer-enrichment-provider-evaluation-research-2026-08-07.md](../../_bmad-output/planning-artifacts/research/technical-soccer-enrichment-provider-evaluation-research-2026-08-07.md).

## Decision

1. **Sportmonks is the provisional technical primary.** It may be used only for an expressly authorized, non-production field trial. This ADR does not buy a plan, accept non-public terms, add credentials, enable a feature flag, or approve production data use.
2. **Sportradar is the premium fallback evaluation path.** It is not an automatic runtime failover. Evaluate it if Sportmonks fails a rights gate, misses a field-trial threshold, or cannot provide acceptable support or commercial terms.
3. **Stats Perform/Opta remains an analytics-depth option.** Reconsider it when the project needs deeper advanced data and a dated entitlement schedule proves all four competitions, the required pre-match availability fields, and acceptable audit/AI rights.
4. **API-Football is rejected for production.** Its public terms state that it does not supply a license to use or publish the data. Low public price and broad endpoint coverage do not offset that rights gap.
5. **SportsDataIO may be included as an RFP challenger, not the selected fallback.** Public product claims are promising, but the exact field depth, service levels, and project rights remain unproven.
6. **Production soccer enrichment remains disabled.** Promotion requires every procurement gate and every relevant field-trial threshold below. Architecture approval does not authorize a subscription, non-public contract, restricted data publication, or production adapter.

## Authority boundaries

- SharpAPI is the sole production authority for canonical fixtures, kickoff/status changes, and odds. Enrichment schedules are identity evidence and discrepancy signals only.
- An enrichment provider cannot create an allowlisted canonical event solely because it returns a fixture, and it cannot overwrite SharpAPI participants, kickoff, status, bookmaker, market, selection, or price.
- Every disagreement is stored as a typed conflict in `pending`, `confirmed`, or `dismissed` state and routed for reconciliation. Only a later SharpAPI observation or an audited manual mapping decision may resolve it; enrichment never updates canonical schedule truth. Unresolved conflicts remain visible and become stale rather than disappearing. Missing enrichment does not make a SharpAPI event disappear.
- Deterministic odds, probability, EV, qualification, CLV, and grading remain outside provider and AI code.
- AI may synthesize only verified, permitted normalized facts and deterministic outputs. It cannot infer unavailable injuries, lineups, statistics, or schedule changes.

## Provider-neutral integration invariants

Future FTE-040 implementation must preserve these rules:

- Implement capability-specific ports for schedule lookup, team/roster profile, lineup, injury/suspension, and statistics. Do not expose a Sportmonks-shaped aggregate interface to the domain.
- Keep provider DTOs, pagination, include syntax, response envelopes, and integer/string IDs inside the adapter package.
- Use internal canonical IDs. Persist forward and reverse provider mappings with entity type, provider ID, internal ID, normalized label, match method, confidence, first/last observed time, and manual-override status.
- Require competition allowlist equality plus participant and kickoff evidence before automatic event mapping. Ambiguous, duplicate, cross-competition, or low-confidence matches fail closed.
- Preserve separate field states for predicted, probable, and confirmed lineups. No timing heuristic may promote a prediction to confirmed.
- Represent missing fields as `unavailable`, `stale`, `conflicting`, or `unverified`; never as an empty verified fact.
- Each normalized fact carries `sourceProvider`, provider entity ID when supplied, provider timestamp when supplied, `collectedAt`, verification status, freshness, confidence, and a contract-permitted evidence reference.
- Treat provider changes as versioned observations. Order by a provider revision token when supplied and otherwise by the collector's monotonic ingestion sequence; provider timestamps are evidence, not the sole ordering key. Retroactive corrections create new observations, same-revision contradictions are quarantined, and replays are idempotent.
- Raw soccer-enrichment payload archival is disabled by default. A `rawRef` may point only to content the executed license permits FIND THE EDGE to retain under an approved security and deletion policy. A hash proves integrity but cannot reconstruct a source. Production requires contract-permitted normalized decision inputs and source references sufficient to reproduce each calculation; otherwise the field or report must be labeled non-reproducible and cannot claim verified evidence.
- Logos, badges, player photos, and headshots are excluded unless separately licensed and approved.
- Provider selection and production enablement use typed configuration/feature flags. No silent fallback or provider substitution is allowed.

## Procurement gates

Before any production credential or activation, the decision owner must approve written terms that answer all of the following:

- The four named competitions and required fields are included for the relevant seasons and coverage tiers.
- Private use supporting betting or wagering decisions is expressly permitted.
- Persistent normalized facts, IDs, timestamps, hashes/diffs, report inputs, and immutable audit evidence may be stored for the required retention period.
- Transformations, derived metrics, rankings, confidence labels, and generated reports are permitted.
- Verified facts may be sent to the approved AI provider solely for synthesis, with prompt/output retention rules stated and model training excluded unless separately approved.
- Required attribution, upstream rights chain, geographic/property restrictions, and media exclusions are explicit.
- Privacy classification, lawful basis, data-processing terms, access controls, and deletion duties for injury or health-adjacent player data are explicit.
- For identifiable injury/health-adjacent data, controller/processor roles, applicable Article 6 and Article 9 basis where relevant, notices and data-subject rights, retention, international transfers, AI-processor terms, and the DPIA determination are approved independently of vendor terms.
- Named users, developers, service accounts, applications, domains, environments, customer tenants, credential-sharing rules, and property-specific pricing/licensing are expressly granted before trial or production credentials are issued.
- Post-termination rules preserve the minimum audit trail for historical decisions or supply an acceptable deletion-and-unavailability process.
- Trial fixtures, an immutable reproducible sample corpus or equivalent provider-verifiable source evidence, caching, encryption, region, subprocessors, support, SLA, correction process, rate/concurrency limits, overages, history, and export rights are explicit. Hashes and normalized observations alone are insufficient to promote production.

Any unresolved gate is a production blocker. A vendor assertion or email summary does not supersede the executed license/order form.

## Field-trial promotion gates

Before the first provider lookup, freeze a SharpAPI source snapshot, versioned trial window, the four competition/season mappings, the eligible-event list, the mandatory-capability and required-field manifests, the observation schedule, and the allowed exclusion taxonomy. Fixtures, venues, rosters, predicted and confirmed lineups, injuries/suspensions, and named statistics are mandatory; failure blocks all production enrichment. An eligible event is every SharpAPI canonical event in an allowlisted competition whose scheduled start falls in the fixed window; provider availability cannot change the denominator.

Event identity includes every frozen event. Fixture/venue gates include events not canceled by SharpAPI; roster gates include participating teams; lineup, injury, statistics, and freshness gates include events that reach kickoff. SharpAPI cancellations are excluded only from inapplicable pre-match gates with the transition/timestamp recorded. Postponed/rescheduled events keep their canonical ID; if they move outside 90 days and reduce a competition below 10 applicable matches, the trial fails as insufficient evidence. Every network attempt after local validation counts toward reliability, including retries, timeouts, malformed bodies, 5xx responses, and throttles. Only frozen caller errors and maintenance with a dated provider notice may be excluded, and exclusions may not exceed 5%.

An authorized non-production trial must run for at least 14 consecutive days and at most 90 calendar days, include at least 10 applicable matches and two observed provider corrections per target competition, 10 corrections overall, at least 1,000 included request attempts, and at least 20 measurable changes per competition. Freshness uses an authoritative provider publication/change-appearance timestamp under a frozen maximum 60-second poll interval; missing origin time or unresolved clock skew over 60 seconds is unmeasurable. If a sample is unavailable or any threshold is unmeasurable by day 90, the trial fails and requires a new decision; friendlies, qualifiers, or provider-returned events cannot replace the sample. Promotion also requires the authorized immutable source sample described above. Promotion requires:

| Gate                           | Threshold                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Competition mapping            | All four competitions map explicitly; zero excluded competitions activate through fuzzy matching.                                                                                                                                                                                                                                                                                           |
| Event identity                 | At least 99% automatic mapping of eligible SharpAPI events; 100% of ambiguous/conflicting cases fail closed; zero duplicate canonical events.                                                                                                                                                                                                                                               |
| Participant identity           | At least 99% automatic team mapping and 98% sampled lineup-player mapping; all overrides audited.                                                                                                                                                                                                                                                                                           |
| Fixtures and venues            | At least 99% eligible fixture presence and 98% venue presence, with every SharpAPI disagreement quarantined.                                                                                                                                                                                                                                                                                |
| Rosters                        | At least 95% of eligible teams expose the frozen required roster fields, every membership has effective-from or observed-at time, and every observed roster correction converges within 30 minutes without rewriting history.                                                                                                                                                               |
| Predicted lineups              | At least 80% of applicable matches expose a prediction by 24 hours before kickoff; zero predictions are promoted to confirmed. Missing entitlement or a failed threshold blocks all production enrichment.                                                                                                                                                                                  |
| Confirmed lineups              | At least 95% of sampled matches have an explicitly confirmed XI by kickoff; zero predicted-as-confirmed promotions.                                                                                                                                                                                                                                                                         |
| Injury/suspension truthfulness | At least 90% of applicable matches expose covered data or verified covered-empty state; unavailable is at most 10%. Before collection, freeze an ordered selection rule and official sources; the first 10 events per competition that reach kickoff are checked at T-24h, T-1h, and +24h by two reviewers. Unexplained discrepancies are at most 10%; inaccessible sources are unscorable. |
| Advertised statistics          | At least 95% completeness against the frozen required-field manifest where the competition/season is advertised as covered; other fields explicitly unavailable.                                                                                                                                                                                                                            |
| Freshness and corrections      | For at least 20 changes per competition, 95% are collected within five minutes; across at least two corrections per competition and 10 overall, every correction converges within two successful polls and 30 elapsed minutes and remains versioned.                                                                                                                                        |
| Reliability and quota          | At least 99.5% of at least 1,000 included attempts succeed; exclusions are at most 5%; no undetected throttling; ordinary use remains below 50% of the authorized request budget.                                                                                                                                                                                                           |
| Provenance                     | 100% of persisted normalized facts have source, collection time, verification, freshness, and confidence; provider ID/timestamp retained whenever supplied.                                                                                                                                                                                                                                 |

These are engineering promotion thresholds, not claims about current vendor performance. A rights failure blocks production regardless of scores. A technical failure triggers review and, if warranted, a separately authorized Sportradar trial; it does not activate Sportradar automatically.

## Backfill, replacement, and exit consequences

- Backfill is a separate approved operation. It uses the same adapter, mapping, provenance, allowlist, and contract gates as live collection.
- Canonical IDs and SharpAPI schedule/odds history do not change when the enrichment provider changes. Old provider mappings remain versioned for audit unless the contract requires deletion.
- A replacement provider creates new mappings and normalized observations. It never rewrites an old fact to make it appear as if the replacement supplied it.
- Existing report versions identify the provider/input versions used. Contract-permitted derived outputs may remain append-only. If restricted source facts or outputs must be deleted, physically delete or redact them wherever stored and retain only a permitted compliance tombstone, access overlay, and deletion evidence; immutability never overrides deletion duties. The system must not silently regenerate historical evidence from a new provider.
- For orderly termination, stop new collection/outputs, quarantine dependent facts, complete only contract-permitted final export while access and rights remain, then revoke credentials, execute deletion, preserve deletion evidence, and mark dependent coverage unavailable. For emergency termination or lost rights, revoke immediately and fail closed even if export is lost, then execute the approved deletion plan with locally available data.
- A contract that forbids the minimum normalized audit record needed to reproduce a betting-support decision is incompatible with production activation.

## Consequences

### Positive

- The project can validate the provider-neutral contract with a relatively accessible technical candidate while reserving a stronger enterprise path.
- SharpAPI schedule/odds truth and deterministic betting calculations remain isolated from enrichment uncertainty.
- Rights and field quality fail closed before money, credentials, or production behavior are committed.
- Provider replacement does not force canonical-ID or report-history migration.

### Costs and risks

- Two-stage approval delays production enrichment and may require two vendor evaluations.
- Sportmonks may fail on exact league/season depth, injury completeness, lineup timing, provenance, support, or contract rights.
- Sportradar may satisfy technical requirements but exceed the approved budget or impose incompatible restrictions.
- Field-level provenance is partly an internal responsibility because no candidate's public docs establish a complete per-field authority and revision model.
- Conditional raw-payload retention makes test-fixture and debugging workflows more complex.

## Rejected alternatives

- **Select API-Football on price:** rejected because public terms disclaim the needed publication license and public freshness intervals are not guarantees.
- **Select Sportradar immediately:** rejected as premature because exact Liga MX depth, licensed properties, history, rate limits, rights, support, and price are order-form questions.
- **Select Stats Perform/Opta immediately:** rejected because public evidence does not prove the complete required pre-match absence/lineup semantics or acceptable archival, derivative, and AI rights.
- **Use enrichment as a second schedule authority:** rejected because silent source merging can bind scouting facts to the wrong canonical match and conflicts with the existing SharpAPI decision.
- **Implement a multi-provider production failover now:** rejected because each provider requires independent rights, mapping, coverage, and quality validation; an unlicensed fallback is not resilience.

## Revision triggers

Create a new ADR or amendment if:

- Sportmonks fails a procurement or trial gate.
- Sportradar or another candidate demonstrates materially better rights, target-competition coverage, provenance, reliability, support, or total cost.
- The approved competition allowlist or SharpAPI authority changes.
- The scouting workflow begins publishing externally, supports multiple users, trains models, or sends provider facts to a different AI service.
- Required retention, audit, attribution, media, privacy, or geographic use changes.
- A provider changes terms, coverage, identifiers, products, limits, or correction behavior.

Record the executed contract/order-form version and hash, authorized property list, and vendor notice channel. The decision owner reviews entitlements quarterly and on every vendor notice; public terms are checked monthly where they control use. Any detected change or missed review deadline while enabled immediately disables new ingestion and dependent report generation until separately reapproved.

## Acceptance record

Standing human approval plus three completed review passes accepts this staged architecture decision and authorizes continued story work. Acceptance explicitly does not authorize a subscription purchase, production credential, production adapter, restricted-data publication, or acceptance of non-public commercial terms; those remain separate decisions after the gates above are evidenced.

## Evidence review checklist

- [x] Sportmonks is provisional technical primary, not an active production provider.
- [x] Sportradar is the premium fallback evaluation path, not silent runtime failover.
- [x] Stats Perform/Opta is retained as an analytics-depth option.
- [x] API-Football is rejected for production based on its public rights statement.
- [x] SharpAPI remains schedule and odds authority.
- [x] Provider DTO/ID isolation, provenance, unavailable states, and correction versioning are binding.
- [x] Betting support, persistent audit, derivatives, AI, attribution, media, and termination are procurement gates.
- [x] Trial thresholds, backfill rules, replacement behavior, and exit consequences are explicit.
- [x] No credential, paid payload, confidential quote, restricted contract text, logo, headshot, or adapter implementation is included.
