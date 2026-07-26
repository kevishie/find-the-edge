# Model Registry

| Model | Status | Purpose |
| --- | --- | --- |
| `mlb-v2.1` | active | MLB ML/K-prop scouting with fair-price and no-bet discipline |
| `mls-v1.0-draft` | draft | Soccer three-way market evaluation pending calibration |
| `edge-calculation-v1` | active | Deterministic odds, no-vig, fair-price, and EV calculations |

Each stored recommendation must record the sport model version, calculation version, source timestamps, and qualification reasons. Model versions change only through a documented decision and changelog entry.
