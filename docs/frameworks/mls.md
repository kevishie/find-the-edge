# MLS Betting Framework

Version: MLS v1.0-draft  
Status: draft pending evidence-based calibration

## Strategy-configurable decisions

- To Advance
- Both Teams to Score
- Goal totals
- Team totals
- Anytime scorer
- Shots on target where requested
- Three-way moneyline only when value is meaningful
- No Bet

No market is active merely because the sport module supports it. The versioned soccer strategy must approve it. Soccer qualification uses market-appropriate deterministic no-vig consensus, fair odds, EV, freshness, contributing-book, and data-quality gates.

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
