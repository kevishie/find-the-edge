# Prioritized Multi-Sport Task Queue

This is the human-readable execution backlog. BMAD story details remain in the planning artifact and machine-oriented status remains in sprint status.

```yaml
- id: FTE-SPORT-001
  sport: core
  league: all
  module: sport-registry
  priority: P0
  dependencies: [FTE-001]
  status: done
  blockerReason: null
  acceptance:
    - Universal domain contains no sport-specific fields
    - SportModule contract and registry exist
    - MLB and soccer register successfully
    - Adding a test sport requires no core-domain edits
  validation:
    - pnpm check

- id: FTE-SPORT-002
  sport: core
  league: all
  module: strategy-configuration
  priority: P0
  dependencies: [FTE-SPORT-001]
  status: done
  blockerReason: null
  acceptance:
    - Versioned schema separates strategy from mechanics
    - MLB and soccer strategies validate against their modules
    - Planned strategies are explicit
  validation:
    - pnpm check

- id: FTE-SPORT-003
  sport: core
  league: all
  module: provider-ports
  priority: P0
  dependencies: [FTE-SPORT-001]
  status: done
  blockerReason: null
  acceptance:
    - Eight capability-specific provider ports exist
    - Coverage declares sports, leagues, markets, rate limit, freshness, and quality
  validation:
    - pnpm check

- id: FTE-SPORT-004
  sport: core
  league: all
  module: prompt-composition
  priority: P0
  dependencies: [FTE-SPORT-001, FTE-SPORT-002]
  status: done
  blockerReason: null
  acceptance:
    - Prompt order is shared, sport, strategy, analysis
    - Exact bundle and model versions are required
    - Missing sections fail validation
  validation:
    - pnpm check

- id: FTE-SPORT-005
  sport: core
  league: all
  module: generic-event-explorer
  priority: P1
  dependencies: [FTE-002, FTE-SPORT-001]
  status: backlog
  blockerReason: null
  acceptance:
    - Sport selector is registry-driven
    - Module maturity is visible
    - Generic route includes sport key
    - Shared UI contains no sport-key branching
  validation:
    - pnpm check
    - browser smoke at desktop and mobile widths

- id: FTE-SPORT-006
  sport: mlb,soccer
  league: mlb,mls
  module: fixture-vertical-slice
  priority: P2
  dependencies: [FTE-SPORT-005]
  status: backlog
  blockerReason: null
  acceptance:
    - Fixture events use generic domain records
    - Both modules produce auditable Play or No Bet output
    - Sport, module, strategy, model, and calculation versions display
  validation:
    - pnpm check
    - browser smoke

- id: FTE-SPORT-007
  sport: core
  league: all
  module: weighted-consensus
  priority: P1
  dependencies: [FTE-SPORT-002]
  status: ready
  blockerReason: null
  acceptance:
    - Weighted two-way and three-way no-vig consensus
    - Offered sportsbook excluded
    - Stale, suspended, sparse, and outlier states are explicit
  validation:
    - pnpm check
```

Provider selection, paid API activation, cloud deployment, production data migrations, and live recommendations remain approval-gated.
