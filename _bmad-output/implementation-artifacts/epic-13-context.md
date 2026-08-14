# Epic 13 Context: Ingestion Cost, Measurement, and Streaming

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make ingestion cost explainable before changing it, reduce the measured control-plane waste without weakening replay or evidence guarantees, prove the savings with the same methodology, and then evaluate and adopt provider streaming only when recorded evidence shows it can preserve the product's trust contract. Streaming is an accelerator over a permanent polling system of record: disabling or losing the stream must leave a working product whose served numbers remain reproducible.

## Stories

- Story FTE-075: Cost Attribution Baseline for the Ingestion Table
- Story FTE-076: Collapse Per-Run Control-Plane Bookkeeping
- Story FTE-077: Right-Size Read Consistency in the Control Plane
- Story FTE-078: Verified Cost Reduction Re-Measurement
- Story FTE-079: Spike - SharpAPI Streaming Against the Evidence Contract
- Story FTE-080: Streaming Ingestion Behind a Flag, Polling as Reconciliation
- Story FTE-081: Streaming Cutover and Polling Cadence Reduction

## Requirements & Constraints

- Work in the order measure, reduce, re-measure, evaluate, adopt. Cost claims require a stated measurement window and comparable evidence; an unfavorable result is recorded rather than optimized away.
- Establish a rerunnable ingestion-table baseline using partition-prefix attribution, table/index consumed capacity, and per-operation metrics. It must identify the five largest prefixes with percentages and include a unit-to-dollar model that matches a settled billing period within 15%.
- Attribution exports and telemetry may contain bounded partition prefixes and operation names, never table contents or full keys. Missing metrics must fail the procedure loudly rather than appearing as zero.
- Cost reduction must preserve the exactly-once evidence contract, quota fencing, replay safety, immutable odds history, and all incident-relevant audit information. Existing records remain readable; the epic requires no migration or backfill.
- Strongly consistent reads remain wherever ownership, leases, optimistic version checks, fencing, or evidence decisions require them. Every retained strong read states the correctness property it protects; every downgrade is tested against stale-read behavior.
- Polling is permanent as the durable system of record, fallback, and reconciliation path. Later stories may lower its cadence and remove machinery unique to high-frequency pagination, but may not delete polling or discard its evidence.
- The streaming account is active as a paid add-on and allows one connection. Local development and automated tests use recorded fixtures, never the live connection. Production streaming must have hard concurrency of one, and connection behavior must be proven before architecture depends on it.
- Streaming adoption must answer ordering, delivery, identity, disconnect/resume, and freshness questions against real captured evidence. Streamed observations must produce the same durable snapshot contract as polling, tolerate duplicate/out-of-order/dropped messages, expose divergence by league and book, and fall back without losing committed evidence.
- Provider failures, quota pressure, stale data, partial responses, divergence, and stream connection state must be observable and must not create misleading active recommendations. Credentials stay in Secrets Manager; provider payloads and secrets are not logged.
- Relevant automated coverage includes unit tests for new metrics, repository/integration tests for control-plane changes, recorded-fixture consumer tests, crash/replay tests, divergence tests, and a proven one-configuration rollback to polling-primary.

## Technical Decisions

- DynamoDB remains the persistence substrate. Immutable odds snapshots preserve historical truth; mutable current-price projections are idempotent, timestamp-aware derivatives. A streamed price writes the same snapshot shape and provenance as an equivalent polled price.
- Keep provider-specific message formats behind capability adapters and normalized domain inputs. Shared ingestion remains sport-agnostic and keyed by stable sport, league, event, participant, market, strategy, and model identifiers.
- Emit privacy-safe structured metrics and logs through the observability layer. CloudWatch tracks DynamoDB consumed capacity and throttles alongside provider latency, errors, quota usage, freshness, worker failures, and queues.
- Prefer SSE during the protocol spike; accept WebSocket connection-state complexity only if SSE cannot meet ordering or resume needs. A production consumer is one long-lived task, such as a single-task Fargate service or an equivalent runtime with enforced concurrency of one—not horizontally scaled Lambda invocations competing for the connection.
- Streaming is off by default until approved evidence supports it. While enabled, reconciliation polling continuously compares stream delivery with provider truth. Cutover requires a stated divergence-free observation window that includes a provider incident, deployment, and disconnect; rollback remains a tested configuration change.
- Infrastructure and runtime changes stay environment-scoped, least-privilege, encrypted at rest, TLS-protected, and represented through typed configuration and CDK. Tests use fakes or recorded fixtures by default; live paid-provider access is deliberate and isolated.

## Cross-Story Dependencies

FTE-075 supplies the baseline and counters used by FTE-076 and FTE-077. FTE-078 reruns that exact procedure after both changes settle and becomes the cost comparison for later cutover. FTE-079 depends on the baseline and gates FTE-080 with a written streaming recommendation and recorded fixture. FTE-080 must prove continuous zero divergence and safe fallback before FTE-081 can promote streaming, reduce polling cadence, retire high-cadence-only bookkeeping, and re-measure cost and board freshness.
