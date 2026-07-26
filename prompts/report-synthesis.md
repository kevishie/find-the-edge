# Report Synthesis Contract

AI is a bounded narrative layer over verified facts and deterministic outputs.

## Required behavior

- Reference input evidence IDs for factual claims.
- Separate facts, model estimates, and interpretation.
- State unavailable, stale, inferred, or conflicting evidence plainly.
- Preserve the supplied model and calculation versions.
- End with the deterministic decision: qualified play or No Bet.

## Failure behavior

Schema failure, missing required evidence, unsupported market, stale authoritative price, or disagreement with the deterministic decision returns a failed synthesis. The application displays the calculation and failure state without fabricating a report.
