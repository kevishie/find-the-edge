# ADR 0002: Initial Soccer Competition Allowlist

- Status: Accepted
- Date: 2026-08-04
- Story: FTE-019
- Decision owner: Kevishie

## Decision

The private MVP soccer allowlist is:

| Priority | Competition            | Canonical key                  | The Odds API key            | SharpAPI league aliases                                   | Activation                                                        |
| -------- | ---------------------- | ------------------------------ | --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| 1        | Major League Soccer    | `soccer:mls`                   | `soccer_usa_mls`            | `usa_-_major_league_soccer`, `estados_unidos_-_mls`       | Always when in season                                             |
| 2        | English Premier League | `soccer:epl`                   | `soccer_epl`                | `england_-_premier_league`, `inglaterra_-_premier_league` | Always when in season                                             |
| 3        | Liga MX                | `soccer:liga-mx`               | `soccer_mexico_ligamx`      | `mexico_-_liga_mx`, `m_xico_-_liga_mx`                    | Always when in season                                             |
| 4        | UEFA Champions League  | `soccer:uefa-champions-league` | `soccer_uefa_champs_league` | `uefa_-_champions_league`                                 | Only while provider catalog says active or scheduled events exist |

SharpAPI is the sole production schedule and odds provider. The Odds API is not called by production ingestion. Provider-native aliases map to one canonical competition; virtual, esports, futures, qualification, reserve, youth, and friendly competitions do not enter the MVP catalog through fuzzy matching.

This ADR is the human approval required by FTE-019. Expanding the allowlist requires an explicit configuration change and evidence review; it must not happen automatically when a provider adds a league.

## Evidence

The decision was evaluated against the requirements in FTE-019 on 2026-08-04:

- SharpAPI Pro entitlement exposes schedule, odds, closing-line, split, and opportunity capabilities. Its live league catalog includes all four selected competitions. The catalog also contains duplicate language aliases and synthetic competitions, which makes an explicit canonical allowlist necessary.
- Hard Rock Bet is active in SharpAPI, supports live odds and player props, and had current pre-match main-market rows for MLS and EPL during the audit. Liga MX and Champions League returned no current Hard Rock row at that instant; absence is treated as current unavailability, not proof that the competition is unsupported.
- The Odds API lists MLS, EPL, Liga MX, and Champions League as supported soccer competitions. On the audit date MLS, EPL, and Liga MX were active; Champions League was out of season. Its event-list endpoint is quota-free, so it can be used to detect schedules before spending odds credits.
- The Odds API documents soccer player props for EPL and MLS, giving those competitions stronger near-term enrichment value. The selected set balances US relevance (MLS and Liga MX), globally relevant inventory (EPL and Champions League), domestic schedule density, and manageable normalization scope.
- Hard Rock market availability is time-, jurisdiction-, and event-dependent. It is recorded per event as available or unavailable and is not inferred from league membership.

Evidence sources:

- SharpAPI reference endpoints: `GET /api/v1/account`, `/api/v1/leagues`, `/api/v1/sportsbooks`, and `/api/v1/odds`, queried without persisting credentials or provider payloads.
- SharpAPI Odds Snapshot documentation: https://docs.sharpapi.io/en/api-reference/odds/
- The Odds API supported sports: https://the-odds-api.com/sports-odds-data/sports-apis.html
- The Odds API v4 guide and quota-free events endpoint: https://the-odds-api.com/liveapi/guides/v4/
- The Odds API soccer markets and player-prop coverage: https://the-odds-api.com/sports-odds-data/betting-markets.html

## Tradeoffs

### Included

- **MLS** is the first soccer path already represented in the product, has US user relevance, summer inventory, Hard Rock evidence, and player-prop enrichment potential.
- **EPL** has strong user relevance, broad bookmaker coverage, Hard Rock evidence, and player-prop enrichment potential.
- **Liga MX** adds high North American relevance and complementary calendar density. Current Hard Rock coverage may be intermittent, so the UI must show honest unavailable states.
- **Champions League** adds high-value global matches without year-round polling. Tournament and qualification feeds must remain distinct.

### Excluded from the initial MVP

- La Liga, Bundesliga, Serie A, Ligue 1, Brazil Serie A, and other top flights are supported candidates but deferred until the four-league pipeline meets identity, freshness, quota, and UI-quality targets.
- Domestic cups, Europa League, Conference League, second divisions, NWSL, and Copa Libertadores are deferred to a later evidence review.
- Friendlies are excluded because team identity, venue, and lineup quality are less stable.
- Qualifiers are excluded from the Champions League key because providers frequently expose them under separate or inconsistent aliases.
- Virtual soccer, esports simulations, reserves, youth leagues, awards, futures, and novelty markets are explicitly denied.

## Quota implications

SharpAPI is the only enabled production source and is read with cursor pagination and the existing adaptive collection policy. The Odds API cost analysis below is retained as historical rationale only; production must not call it.

For The Odds API, an odds request costs `markets × regions`. With the three MVP main markets (`h2h`, `spreads`, `totals`) and one US region, one competition scan costs 3 credits. A naive hourly scan of all four competitions would cost 12 credits/hour or 288 credits/day, so it is prohibited.

If the provider decision is revisited in a future ADR, any fallback collection must:

1. Check the free sports/events endpoints and skip inactive or empty competitions.
2. Request odds only after SharpAPI is stale/unavailable or during a bounded reconciliation run.
3. Poll by event proximity using the existing adaptive schedule, with a daily credit ceiling and a circuit breaker before exhaustion.
4. Record provider request counts, remaining credits, competition, markets, and reason without logging credentials.

## Success gates before expansion

- At least 14 consecutive days without unresolved duplicate-event or participant-identity incidents.
- At least 99% successful scheduled ingestion runs for active allowlisted competitions.
- Freshness and unavailable states are visible and accurate in the API and UI.
- Fallback usage remains inside its configured daily credit budget.
- A candidate league demonstrates user relevance, target-book or comparison-book coverage, schedule density, and a normalization/enrichment plan.

## Research review checklist

- [x] Candidate competitions and provider aliases listed.
- [x] Hard Rock availability assessed without treating a point-in-time absence as permanent.
- [x] SharpAPI and The Odds API coverage assessed.
- [x] User relevance, schedule density, enrichment potential, and scouting completeness considered.
- [x] Quota formula, naive upper bound, and safeguards documented.
- [x] Included and excluded competitions are explicit.
- [x] Credentials and paid-license payloads are not published.
- [x] Human approval recorded through the user's standing approval to continue and merge BMad stories.
