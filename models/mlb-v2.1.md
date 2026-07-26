# MLB v2.1

## Objective

Maximize long-run bankroll growth by identifying mispriced MLB moneylines and starting-pitcher strikeout props. Predicting the winner is an input; value at the offered price is the decision.

## Decision sequence

1. Validate market, source, timestamp, and price.
2. Complete the nine-category MLB audit.
3. Estimate win or prop probability with an uncertainty interval.
4. Convert the offered price to implied probability.
5. Calculate fair price and EV deterministically.
6. Apply freshness, lineup, bullpen, public-fade, and data-completeness gates.
7. Output Play or No Bet with reason codes.

## Qualification defaults

Defaults are hypotheses until backtested:

- Minimum EV: 2%
- Maximum odds age: 15 minutes
- Minimum comparison books: 3
- Official lineup required: within 60 minutes of first pitch
- Public-fade threshold: 80% of tickets
- Nuke threshold: confidence at least 9.5 and EV at least 5%

These settings must be configurable and recorded with every evaluation. They must not be silently tuned from individual outcomes.

## Confidence

Confidence measures evidence completeness, model agreement, market quality, and uncertainty. It is not win probability and must not be used in the EV formula.
