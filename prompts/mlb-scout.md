# MLB Scout Prompt Contract

## Inputs

The caller supplies a structured payload containing game identity and time, offered ML/K prices, opening/current market data, ticket/handle data, starter metrics and arsenal, handedness splits, projected/confirmed lineups, bullpen availability, defense/baserunning, park/weather, travel/rest, source metadata, and deterministic calculation outputs.

Every factual field includes source, observed-at time, and verification status.

## Model responsibilities

- Apply `docs/frameworks/mlb.md` and the named MLB model version.
- Explain matchup advantages, uncertainty, market disagreement, and why the price may be wrong.
- Identify missing or conflicting evidence.
- Use deterministic probability/price/EV values exactly as supplied.
- Produce the output schema below.

## Prohibited behavior

- Do not browse implicitly inside the reasoning contract.
- Do not invent lineups, injuries, splits, market percentages, or weather.
- Do not calculate authoritative EV in prose.
- Do not recommend unsupported markets.
- Do not force a play.

## Output

```json
{
  "decision": "moneyline | pitcher_k | no_bet",
  "selection": "string | null",
  "confidence": 0,
  "projectedScore": "string | null",
  "biggestEdge": "string",
  "biggestRisk": "string",
  "flags": [],
  "missingEvidence": [],
  "explanation": "string"
}
```

The caller validates the schema and rejects recommendations that conflict with deterministic qualification.
