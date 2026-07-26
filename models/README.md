# Model Registry

| Model                 | Status  | Purpose                                                      |
| --------------------- | ------- | ------------------------------------------------------------ |
| `mlb-v2.1`            | active  | MLB ML/K-prop scouting with fair-price and no-bet discipline |
| `mls-v1.0-draft`      | draft   | Soccer three-way market evaluation pending calibration       |
| `edge-calculation-v1` | active  | Deterministic odds, no-vig, fair-price, and EV calculations  |
| `tennis-v0.1-planned` | planned | Tennis contract; no recommendations                          |
| `nfl-v0.1-planned`    | planned | NFL contract; no recommendations                             |
| `ncaaf-v0.1-planned`  | planned | NCAAF contract; no recommendations                           |

Each stored recommendation must record the sport model version, calculation version, source timestamps, and qualification reasons. Model versions change only through a documented decision and changelog entry.
