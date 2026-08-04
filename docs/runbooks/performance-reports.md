# Performance reports

Performance reports are immutable, paper-only evidence products. A build uses a UTC half-open window, exact filters, a trusted cutoff, and exact grade/result/opening/closing identifiers. Re-running the same inputs must return the same cohort and report identity.

## Before enabling builds

1. Replay retained paper picks into the bounded UTC decision-day index. Verify each index row against the exact paper-bet record; stop on partial or conflicting state.
2. Confirm result corrections and grade history are retained. Builders must freeze exact grade IDs, never `CURRENT` pointers.
3. Confirm scheduled start, sportsbook, selection, market, and spread point are retained before enabling CLV. Legacy picks without scheduled start remain `legacy-scheduled-start-missing`.
4. Keep wager mode set to `paper`. Money mode has no trusted owner model and must fail closed.

## CLV trust rule

Use the latest active price from the same event version, sport, market, selection, sportsbook, and spread point observed between 15 minutes before scheduled start and scheduled start. Stale, post-start, suspended, changed-line, cross-book, or absent evidence is unavailable—not zero.

## Corrections and recovery

An official correction creates a new exact grade, evidence digest, and report revision. Never rewrite an old report. An interrupted cohort build can restart from the filter-bound cursor; finalization must match the exact member count and digest. Conflicting immutable identities require operator investigation.

Monitor build failures, member/source counts, missing grade and CLV reasons, query latency, and report latency. Logs may include canonical IDs and bounded reason codes, never provider payloads, prompts, credentials, or secrets.
