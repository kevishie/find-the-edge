---
status: blocked
story: FTE-035
created: '2026-08-06'
---

# BMad Dev Auto Result

Status: blocked

Blocking condition: The planning artifacts require configured ranking, confidence, freshness, and data-quality signals, but define no approved ranking formula, component weights, confidence scale/buckets, data-quality score, or deterministic tie-break precedence. The UX specification explicitly leaves numeric versus bucketed confidence unresolved. Implementing FTE-035 without that product decision would invent authoritative betting logic.

Evidence:

- PRD FR-037 requires configured ranking using EV, confidence, freshness, and other MVP signals.
- FTE-035 requires ranking logic and an explanation containing confidence and data-quality fields.
- The current versioned evaluation policy defines qualification thresholds, not ranking or confidence policy.
- Sport-module confidence methodology is descriptive rather than executable.
- UX open questions leave confidence representation unresolved.

Resolved technical direction pending that decision:

- Strongly join sparse active lifecycle discovery to the immutable candidate and revalidate the lifecycle head before return.
- Materialize a versioned rank projection rather than sorting an expiry-ordered prefix.
- Expose authenticated sport-scoped list/detail routes with encrypted filter-bound cursors, safe explanation DTOs, and no raw provider data.
- Keep FTE-036 dashboard layout and cards out of scope.
