# ADR 0001: Multi-Sport Module Architecture

Status: accepted  
Date: 2026-07-26

## Context

The initial BMAD plan was soccer-first and the first local code slice was MLB-specific. Adding tennis, NFL, NCAAF, or later sports through shared-model conditionals would make events, APIs, persistence, UI, prompts, and evaluations brittle.

## Decision

Use a universal betting domain plus registered `SportModule` implementations. Modules declare mechanics and extension contracts. Separately versioned strategies declare which markets and thresholds FIND THE EDGE uses. Provider adapters are resolved by capability and declared coverage. Prompt bundles are composed from shared, sport, strategy, and analysis sections. Every derived decision stores all relevant versions.

## Consequences

- New sports are routine to add and honest about maturity.
- Shared code cannot directly reference a sport key to choose behavior.
- Module and strategy validation add upfront work.
- Cross-sport reporting becomes consistent.
- Sport-specific analytics stay typed without polluting universal records.
- Existing soccer and MLB material becomes module input rather than discarded work.
