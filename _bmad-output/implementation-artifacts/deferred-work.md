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
