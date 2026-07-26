# MLS Betting Framework

Version: MLS v1.0-draft  
Status: draft pending evidence-based calibration

## Approved MVP decisions

- Three-way moneyline
- Draw-no-bet only after an explicit product decision
- No Bet

No totals, handicaps, props, or parlays unless the user expands scope. Soccer qualification uses deterministic no-vig consensus, fair odds, EV, freshness, contributing-book, and data-quality gates defined by the model contract.

## Required audit

- Team strength and recent form, separated by home/away
- Expected goals for and against
- Shot quality and creation
- Projected/confirmed XI, injuries, suspensions, rotation, and international absences
- Rest, travel, congestion, and timezone
- Tactical matchup, set pieces, keeper quality, and defensive errors
- Venue, surface, weather, and altitude
- Opening/current line, ticket/handle data when verified, movement, consensus, and book disagreement

The system must distinguish three-way markets from two-way markets and never remove vig with the wrong outcome count. Missing lineup or market evidence lowers confidence and may force No Bet.
