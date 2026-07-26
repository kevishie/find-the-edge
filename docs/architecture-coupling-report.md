# Architecture Coupling Report

Assessed: 2026-07-26

## Findings

| Area                   | Coupling                                                                           | Disposition                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Product Brief and PRD  | Soccer-first discovery, Hard Rock as fixed target, soccer-specific scout           | Retained as historical/detailed soccer input; overridden by binding multi-sport amendments |
| Architecture           | Soccer provider, soccer event assumptions, future sports framed as later extension | Rebased around universal domain, modules, strategy, registry, and provider capabilities    |
| Epics and sprint queue | Soccer catalog and provider spikes precede generic sport foundations               | Added P0 `FTE-SPORT-*` dependency chain                                                    |
| UX                     | Sport selector locked to soccer and Hard Rock labels                               | Future generic UI resolves labels and target book from module/strategy                     |
| Odds package           | Formula code reusable; market union hard-coded to MLB                              | Market approval moved to strategy input                                                    |
| Web app                | Labels and default evaluator fixed to MLB                                          | Retained as current beta slice; next slice consumes registry and generic strategy          |
| Prompts                | Individual MLB/report prompts without shared composition                           | Reorganized into shared, sports, and strategy sections with bundle versioning              |
| Models                 | MLB and soccer documents mix mechanics and product policy                          | Sport definitions and strategy configurations separated                                    |

## Prohibited shared fields

The universal event/participant contracts must not add `homePitcher`, `battingHand`, `quarterback`, `formation`, `surface`, or analogous sport attributes. Modules own versioned detail payloads.

## Migration policy

No destructive data migration is required because production persistence does not exist. Current local fixture behavior remains supported while consumers migrate to generic `sportKey`, `marketKey`, and `strategyVersion` contracts.
