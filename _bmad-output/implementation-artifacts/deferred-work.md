- source_spec: `_bmad-output/implementation-artifacts/spec-fte-028-two-way-and-three-way-no-vig-consensus.md`
  summary: Version and propagate the hardened weighted-consensus contract under FTE-031.
  evidence: `CONSENSUS_CALCULATION_VERSION` still identifies `weighted-consensus-v1` although FTE-028 hardened its transient input and result contract; the story explicitly leaves durable calculation versioning and replay propagation to FTE-031.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Make cross-version evidence deduplication stable across odds-history page boundaries.
  evidence: The repository's evidence-identity set is page-local, so equivalent canonical-version mirrors can survive when separated by a cursor.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Fence delayed history-mirror repair by mirror commit order.
  evidence: A repaired mirror retains its older retrieval timestamp, so the current retrieval-time fence cannot prove it existed when pagination began.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Preserve the newest corrected selection label when equivalent mirrors deduplicate.
  evidence: Deduplication currently occurs before label evidence is compared, allowing hash order to retain an older label.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Align raw cursor ordering and projected DTO ordering for tied provider timestamps.
  evidence: DynamoDB orders tied timestamps by snapshot ID while DTO series additionally order by retrieval time, which can reverse points across pages.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Prevent cross-page selection-label regression in the browser merge.
  evidence: Later pages overwrite selection labels without proving their label evidence is newer.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Enforce the aggregate server observation bound in the browser history parser.
  evidence: Per-series limits permit a malformed page to contain far more than the repository's 200-observation page contract.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Restore canonical series ordering after browser pagination merge.
  evidence: Map insertion order can differ from the repository's market, selection, and sportsbook ordering.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Anchor movement time presets to the response generation time.
  evidence: Presets currently anchor to the newest observation, which makes stale evidence appear to be a current relative window.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Bound chart sampling even when required gap-transition points exceed the nominal limit.
  evidence: Alternating active and unavailable evidence can bypass the 2,400-point rendering cap.
- source_spec: `_bmad-output/implementation-artifacts/spec-fte-026-odds-history-api-and-chart-series-projection.md`
  summary: Re-land within-market timestamp tolerance without letting a board mix observation moments.
  evidence: Dropping the observedAt/retrievedAt grouping in `JoinedGamesRepository` let one board join a total observed at 20:39 with a moneyline observed at 22:25, which the browser client, `assertLiveGame`, and the product's meaning of a board all reject. Tolerating sub-second skew between two sides of one market needs a bound and agreement across all three consumers.

## Provider-id churn splits line history across canonical events (found 2026-08-08)

While verifying FTE-060 on staging: the odds-history mirror is healthy
(50 series / hundreds of points on stable events), but when the provider
rotates an event id (`_b0` → `_b2`, sometimes the base too), schedule
reconciliation bootstraps a NEW canonical event. Consequences observed live:

- Line history splits: the new canonical id starts empty while the old id
  keeps the accumulated history (a chart can show one thin series ending at
  the churn moment).
- Duplicate board rows: both suffix variants can sit on the same day's
  board (e.g. `mlb_athletics_redsox_2026-08-08_b0` and `_b2`), because the
  withdrawn-listing filter only fires with a splits witness.

Next story should make canonical identity survive provider-id churn —
participants + start instant already identify the real-world game (the
withdrawn-listing filter proves the technique) — so one canonical event
carries one continuous history and the board never shows the same game
twice. FTE-026's "continue history across canonical event versions"
contract covers versions of one id, not churned ids; extending identity
resolution to merge churned ids (or alias them) is the clean fix.
