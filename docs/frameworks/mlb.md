# MLB Betting Framework

Version: MLB v2.1  
Status: canonical

## Approved decisions

- Moneyline (ML)
- Starting-pitcher strikeout props
- No Bet

Do not recommend run lines, alternate run lines, game or team totals, parlays unless requested, or batter props unless requested. Never replace an overpriced moneyline with a run line. Avoid ML prices worse than -250 unless every category is overwhelmingly favorable.

## Required game audit

Every game must evaluate all of the following:

1. Starting pitching: ERA, xERA, FIP, WHIP, K%, BB%, hard-hit%, barrel%, last five starts, and home/away splits.
2. Pitch arsenal matchup: primary pitches, usage, velocity, and opponent performance against those pitch types.
3. Offense versus the starter's handedness: OPS, wRC+, OBP, ISO, K%, BB%, last 15, and last 30.
4. Projected or confirmed lineup: hot/cold hitters, injuries, rest, platoon advantages, and missing impact bats.
5. Bullpen: last 14 days, season ERA/FIP, workload, availability, and closer status.
6. Defense and baserunning: DRS, errors, catcher framing, stolen-base ability, and double-play efficiency.
7. Park and weather: park factors, wind, temperature, humidity, and roof.
8. Travel and rest.
9. Market: opening/current line, ticket%, handle%, reverse movement, sharp consensus, and public consensus.

Never recommend a bet from starting pitching alone.

## Price and public discipline

Estimate model win probability, market implied probability, fair ML, and EV. Rank value rather than raw win probability.

Flag:

- `fade-public-candidate`: at least 80% of tickets on one side without an overwhelming analytical edge.
- `sharp-money-candidate`: majority of handle is opposite the majority of tickets.

When public tickets exceed 80% and the analytical edge is not overwhelming, reduce confidence by 1–2 points or issue No Bet. Market signals inform an opinion; they never create one by themselves.

## Required output per game

- Best ML or No Bet
- Best starter K prop, only when value exists
- Model probability, market probability, fair price, and EV
- Confidence from 1–10
- Projected score
- Biggest edge and biggest risk
- Evidence completeness and lineup status

Rank the daily Top 5. Identify a Favorite Play and a Best Underdog. A Nuke Play requires confidence of at least 9.5 and exceptional value; it is optional, never forced.
