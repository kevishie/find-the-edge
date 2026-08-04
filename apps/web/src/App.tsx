import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
  useSearch,
} from "@tanstack/react-router";

import {
  evaluateEdge,
  removeVig,
  type EdgeEvaluation,
} from "@find-the-edge/odds";
import { mlbFindTheEdgeStrategy, sportRegistry } from "@find-the-edge/sports";
import {
  eventFreshnessPresentation,
  eventLifecyclePresentation,
  eventMetadataReasonText,
} from "@find-the-edge/ui";
import {
  SportsbookLogo,
  sportsbookMetadata,
  sportsbookScopeKey,
} from "./sportsbooks";
import type { RetrospectiveDto } from "./api";

const SPLITS_REFRESH_INTERVAL_MS = 30_000;

function EventMetadataBadges({
  game,
}: {
  readonly game: {
    readonly metadata: import("@find-the-edge/domain").EventMetadataAssessment;
  };
}) {
  const lifecycle = eventLifecyclePresentation(game.metadata.lifecycle.state);
  const freshness = eventFreshnessPresentation(game.metadata.freshness.state);
  const reasons = eventMetadataReasonText(game.metadata);
  return (
    <div
      className="event-metadata-badges"
      aria-label="Event status and metadata freshness"
    >
      {[lifecycle, freshness].map((badge) => (
        <span
          key={badge.ariaLabel}
          className={`event-metadata-badge ${badge.tone}`}
          aria-label={badge.ariaLabel}
        >
          <span aria-hidden="true">{badge.icon}</span> {badge.label}
        </span>
      ))}
      {game.metadata.freshness.state !== "unavailable" &&
        game.metadata.freshness.evidenceAt && (
          <time dateTime={game.metadata.freshness.evidenceAt}>
            Evidence {easternDisplay(game.metadata.freshness.evidenceAt)}{" "}
            Eastern
          </time>
        )}
      {reasons.map((reason) => (
        <span className="event-metadata-reason" key={reason}>
          {reason}
        </span>
      ))}
    </div>
  );
}

const reasonLabels: Record<string, string> = {
  "positive-ev": "Qualified positive EV",
  "ev-below-threshold": "EV below 2% floor",
  "insufficient-books": "Fewer than 3 comparison books",
  "stale-price": "Price older than 15 minutes",
  "lineup-unconfirmed": "Official lineup required inside 60 minutes",
  "public-fade": "80%+ public tickets without overwhelming edge",
  "unsupported-market": "Market outside approved strategy",
};

interface FormState {
  offered: number;
  consensusSide: number;
  opponent: number;
  bookCount: number;
  priceAge: number;
  minutesToStart: number;
  publicTickets: number;
  lineupConfirmed: boolean;
}

const initialForm: FormState = {
  offered: 140,
  consensusSide: 120,
  opponent: -140,
  bookCount: 5,
  priceAge: 4,
  minutesToStart: 45,
  publicTickets: 54,
  lineupConfirmed: true,
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function american(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${String(rounded)}` : String(rounded);
}

function calculate(form: FormState): EdgeEvaluation {
  const [fairProbability] = removeVig([form.consensusSide, form.opponent]);
  if (fairProbability === undefined)
    throw new Error("Fair probability unavailable");
  return evaluateEdge({
    offeredAmerican: form.offered,
    fairProbability,
    marketKey: "moneyline",
    approvedMarketKeys: mlbFindTheEdgeStrategy.approvedMarketKeys,
    comparisonBooks: form.bookCount,
    priceAgeMinutes: form.priceAge,
    lineupConfirmed: form.lineupConfirmed,
    minutesToStart: form.minutesToStart,
    publicTicketPercent: form.publicTickets,
    minimumEv: mlbFindTheEdgeStrategy.minimumEv,
    minimumBooks: mlbFindTheEdgeStrategy.minimumComparisonBooks,
    maximumPriceAgeMinutes: mlbFindTheEdgeStrategy.maximumPriceAgeMinutes,
  });
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

type GamesSport = "mlb" | "soccer";
interface UiGamesPage {
  readonly projectionState: "ready" | "uninitialized";
  readonly unavailableReason: "projection-uninitialized" | null;
  readonly snapshotAt?: string | null;
  readonly freshness?: string | null;
  readonly items: readonly {
    readonly id: string;
    readonly sportKey: string;
    readonly startsAt: string;
    readonly participants: readonly { readonly label: string }[];
    readonly eastern: { readonly display: string };
    readonly metadata: import("@find-the-edge/domain").EventMetadataAssessment;
    readonly odds:
      | {
          readonly state: "available";
          readonly selections: readonly {
            readonly marketKey: string;
            readonly selectionKey: string;
            readonly selectionLabel?: string;
            readonly sportsbookId: string;
            readonly sportsbookLabel?: string;
            readonly point?: number;
            readonly americanOdds: number;
            readonly observedAt: string;
          }[];
        }
      | { readonly state: "unavailable" };
  }[];
}
interface UiGamesClient {
  list(
    filter: { readonly sport: GamesSport; readonly day: string },
    signal: AbortSignal,
  ): Promise<UiGamesPage>;
  listSplits?(
    filter: { readonly sport: GamesSport; readonly day: string },
    signal: AbortSignal,
  ): Promise<
    Omit<UiGamesPage, "items"> & {
      readonly items: readonly (UiGamesPage["items"][number] & {
        readonly splits: readonly {
          readonly id: string;
          readonly marketKey: string;
          readonly selectionKey: string;
          readonly betPercent?: number;
          readonly moneyPercent?: number;
          readonly point?: number;
          readonly providerTimestamp: string;
          readonly retrievedAt?: string;
          readonly scope?: string;
        }[];
      })[];
    }
  >;
  listPerformance?(signal: AbortSignal): Promise<{
    readonly reportId: string;
    readonly cohortId: string;
    readonly cutoff: string;
    readonly facets: {
      readonly sports: readonly string[];
      readonly leagues: readonly string[];
      readonly markets: readonly string[];
      readonly oddsBands: readonly string[];
      readonly strategyVersions: readonly string[];
      readonly modelVersions: readonly string[];
    };
    readonly metrics: {
      readonly counts: {
        readonly source: number;
        readonly won: number;
        readonly lost: number;
        readonly push: number;
        readonly void: number;
        readonly unresolved: number;
        readonly decisions: number;
        readonly resolvedExposure: number;
      };
      readonly units: number;
      readonly roi: number | null;
      readonly roiInterval95: {
        readonly low: number;
        readonly high: number;
      } | null;
      readonly roiUnavailableReason: string | null;
      readonly winRate: number | null;
      readonly winRateInterval95: {
        readonly low: number;
        readonly high: number;
      } | null;
      readonly averageDecimalOdds: number | null;
      readonly breakEvenProbability: number | null;
      readonly estimatedEv: number | null;
      readonly brierScore: number | null;
      readonly expectedCalibrationError: number | null;
      readonly maximumDrawdown: number;
      readonly sampleCaution: "insufficient" | "limited" | "established";
      readonly clv: {
        readonly eligible: number;
        readonly unavailable: number;
        readonly averagePrice: number | null;
        readonly averageImpliedProbability: number | null;
        readonly unavailableReasons: Readonly<Record<string, number>>;
      };
      readonly calibration: readonly {
        readonly lower: number;
        readonly upper: number;
        readonly count: number;
        readonly meanForecast: number | null;
        readonly observedRate: number | null;
      }[];
      readonly cumulativeUnits: readonly {
        readonly id: string;
        readonly value: number;
      }[];
    };
  } | null>;
  listRetrospectives?(
    signal: AbortSignal,
  ): Promise<readonly RetrospectiveDto[]>;
  getRetrospective?(
    versionId: string,
    signal: AbortSignal,
  ): Promise<RetrospectiveDto>;
  listRetrospectiveVersions?(
    retrospectiveId: string,
    signal: AbortSignal,
  ): Promise<readonly RetrospectiveDto[]>;
  canReviewRetrospectives?(): Promise<boolean>;
  reviewRetrospective?(
    version: RetrospectiveDto,
    input: {
      readonly reasonCode: "approve" | "reject" | "request-changes";
      readonly note: string;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<RetrospectiveDto>;
  listExperiments?(
    signal: AbortSignal,
  ): Promise<readonly StrategyExperimentDto[]>;
  getExperiment?(id: string, signal: AbortSignal): Promise<unknown>;
  canManageExperiments?(): Promise<boolean>;
  manageExperiment?(
    id: string,
    action: "approve" | "promote" | "rollback",
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
interface StrategyExperimentDto {
  readonly experimentId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly baseline: {
    readonly strategyId: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly challenger: {
    readonly strategyId: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly gates: readonly {
    readonly metric: string;
    readonly actual: number | null;
    readonly passed: boolean;
    readonly reason: string;
  }[];
  readonly failureReasons: readonly string[];
  readonly stateVersion: number;
}

type GamesClientResult =
  | { readonly ok: true; readonly value: UiGamesClient }
  | { readonly ok: false; readonly error: { readonly message: string } };

const defaultGamesClient: GamesClientResult = {
  ok: false,
  error: { message: "Runtime configuration has not been installed." },
};
const GamesClientContext = createContext<GamesClientResult>(defaultGamesClient);

function AppShell() {
  const modules = sportRegistry.list();

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="brand-mark">FTE</span>
          <div>
            <strong>FIND THE EDGE</strong>
            <small>BY @KEVISHIE</small>
          </div>
        </div>
        <nav aria-label="Primary navigation">
          <Link to="/" activeProps={{ className: "active" }}>
            Edge Lab
          </Link>
          <Link to="/games" activeProps={{ className: "active" }}>
            Games
          </Link>
          <Link to="/splits" activeProps={{ className: "active" }}>
            Betting Splits
          </Link>
          <span>Scout Reports</span>
          <Link to="/performance" activeProps={{ className: "active" }}>
            Performance
          </Link>
          <Link to="/retrospectives" activeProps={{ className: "active" }}>
            Retrospectives
          </Link>
          <Link to="/experiments" activeProps={{ className: "active" }}>
            Experiments
          </Link>
        </nav>
        <div className="model-card">
          <span>REGISTERED MODULES</span>
          <strong>{modules.length} sports</strong>
          <small>registry-driven shell</small>
        </div>
      </aside>
      <main>
        <Outlet />
        <footer>
          Informational decision support only. No bet placement, guarantees, or
          hidden model arithmetic.
        </footer>
      </main>
    </div>
  );
}

function AppError({ error }: { error: Error }) {
  return (
    <section className="empty-state" role="alert">
      <p className="eyebrow">APPLICATION ERROR</p>
      <h1>Unable to render this view</h1>
      <p>{error.message}</p>
    </section>
  );
}

function EdgeLab() {
  const [form, setForm] = useState(initialForm);
  const result = useMemo(() => {
    try {
      return { evaluation: calculate(form), error: null };
    } catch (error) {
      return {
        evaluation: null,
        error: error instanceof Error ? error.message : "Invalid market inputs",
      };
    }
  }, [form]);

  const update = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">LOCAL-FIRST MVP · FIXTURE MODE</p>
          <h1>PRICE THE BET. DON&apos;T PICK THE TEAM.</h1>
          <p className="lede">
            A deterministic moneyline evaluator proving the core loop without
            provider or AI keys.
          </p>
        </div>
        <div className="status">
          <i />
          No external spend
        </div>
      </header>

      <section className="principles" aria-label="Decision principles">
        <div>
          <span>APPROVED MARKET</span>
          <strong>MLB Moneyline</strong>
        </div>
        <div>
          <span>VALUE FLOOR</span>
          <strong>+2.0% EV</strong>
        </div>
        <div>
          <span>DISCIPLINE</span>
          <strong>No Bet is valid</strong>
        </div>
      </section>

      <section className="lab" id="edge-lab">
        <div className="panel inputs">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">MARKET INPUT</p>
              <h2>Two-way price check</h2>
            </div>
            <button type="button" onClick={() => setForm(initialForm)}>
              Reset
            </button>
          </div>

          <div className="form-grid">
            <NumberField
              label="Offered side (American)"
              value={form.offered}
              onChange={(value) => update("offered", value)}
            />
            <NumberField
              label="Consensus side price"
              value={form.consensusSide}
              onChange={(value) => update("consensusSide", value)}
            />
            <NumberField
              label="Consensus opponent price"
              value={form.opponent}
              onChange={(value) => update("opponent", value)}
            />
            <NumberField
              label="Comparison books"
              value={form.bookCount}
              onChange={(value) => update("bookCount", value)}
            />
            <NumberField
              label="Price age (minutes)"
              value={form.priceAge}
              onChange={(value) => update("priceAge", value)}
            />
            <NumberField
              label="Minutes to first pitch"
              value={form.minutesToStart}
              onChange={(value) => update("minutesToStart", value)}
            />
            <NumberField
              label="Public ticket %"
              value={form.publicTickets}
              onChange={(value) => update("publicTickets", value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.lineupConfirmed}
              onChange={(event) =>
                update("lineupConfirmed", event.currentTarget.checked)
              }
            />
            Official lineup confirmed
          </label>
          <p className="note">
            This working lab remains a local deterministic fixture. The shared
            weighted consensus engine excludes the offered sportsbook and audits
            market quality states.
          </p>
        </div>

        <div className="panel verdict" aria-live="polite">
          {result.error ? (
            <div className="error">
              <p className="eyebrow">INPUT ERROR</p>
              <h2>Check the market prices</h2>
              <p>{result.error}</p>
            </div>
          ) : (
            result.evaluation && (
              <>
                <p className="eyebrow">DETERMINISTIC VERDICT</p>
                <div className={`decision ${result.evaluation.decision}`}>
                  {result.evaluation.decision === "play"
                    ? "QUALIFIED PLAY"
                    : "NO BET"}
                </div>
                <div className="metrics">
                  <div>
                    <span>Market implied</span>
                    <strong>
                      {percent(result.evaluation.marketImpliedProbability)}
                    </strong>
                  </div>
                  <div>
                    <span>No-vig fair</span>
                    <strong>
                      {percent(result.evaluation.fairProbability)}
                    </strong>
                  </div>
                  <div>
                    <span>Fair price</span>
                    <strong>{american(result.evaluation.fairAmerican)}</strong>
                  </div>
                  <div className="ev">
                    <span>Estimated EV</span>
                    <strong>{percent(result.evaluation.expectedValue)}</strong>
                  </div>
                </div>
                <div className="reasons">
                  <span>DECISION REASONS</span>
                  <ul>
                    {result.evaluation.reasons.map((reason) => (
                      <li key={reason}>{reasonLabels[reason]}</li>
                    ))}
                  </ul>
                </div>
                <small className="version">
                  {result.evaluation.calculationVersion}
                </small>
              </>
            )
          )}
        </div>
      </section>
    </>
  );
}

const sportLabels: Record<GamesSport, string> = { mlb: "MLB", soccer: "MLS" };

const validDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const oddsPrice = (value: number) =>
  value > 0 ? `+${String(value)}` : String(value);

const linePoint = (value: number) =>
  value > 0 ? `+${String(value)}` : String(value);

const easternDisplay = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });

const currentEasternDay = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

function GamesExplorer() {
  const client = useContext(GamesClientContext);
  const [sport, setSport] = useState<GamesSport>("mlb");
  const [day, setDay] = useState(() => currentEasternDay());
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly page: UiGamesPage }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    const controller = new AbortController();
    const activeClient = client.ok ? client.value : undefined;
    const clientError = client.ok ? undefined : client.error.message;
    const load = async (): Promise<void> => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      if (!activeClient) {
        setState({
          kind: "error",
          message: clientError ?? "Runtime configuration is unavailable.",
        });
        return;
      }
      if (!validDay(day)) {
        setState({
          kind: "error",
          message: "Choose a valid Eastern calendar day.",
        });
        return;
      }
      try {
        const page = await activeClient.list({ sport, day }, controller.signal);
        if (id === requestId.current && !controller.signal.aborted)
          setState({ kind: "ready", page });
      } catch (error: unknown) {
        if (id !== requestId.current || controller.signal.aborted) return;
        setState({
          kind: "error",
          message:
            error instanceof Error && error.name === "GamesClientError"
              ? error.message
              : "Games are temporarily unavailable.",
        });
      }
    };
    void load();
    return () => controller.abort();
  }, [client, day, sport]);

  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">LIVE GAMES · EASTERN TIME</p>
          <h1>Games and current odds</h1>
          <p className="lede">
            Browse real MLB and MLS games with current spread, total, and
            moneyline markets.
          </p>
        </div>
        <span className="maturity beta">live odds</span>
      </header>

      <section className="game-filters" aria-label="Game filters">
        <fieldset>
          <legend>Sport</legend>
          {(Object.keys(sportLabels) as GamesSport[]).map((key) => (
            <button
              key={key}
              type="button"
              className={sport === key ? "selected" : ""}
              aria-pressed={sport === key}
              onClick={() => {
                if (key === sport) return;
                setState({ kind: "loading" });
                setSport(key);
              }}
            >
              {sportLabels[key]}
            </button>
          ))}
        </fieldset>
        <label>
          <span>Eastern calendar day</span>
          <input
            type="date"
            value={day}
            onChange={(event) => {
              if (event.currentTarget.value === day) return;
              setState({ kind: "loading" });
              setDay(event.currentTarget.value);
            }}
          />
        </label>
      </section>

      <div className="games-status" aria-live="polite" aria-atomic="true">
        {state.kind === "loading" && <p role="status">Loading games…</p>}
        {state.kind === "error" && <p role="alert">{state.message}</p>}
        {state.kind === "ready" && state.page.items.length === 0 && (
          <p role="status">
            {state.page.projectionState === "uninitialized"
              ? "Game metadata is unavailable while event data initializes."
              : `No ${sportLabels[sport]} games are scheduled for this day.`}
          </p>
        )}
      </div>

      {state.kind === "ready" && state.page.items.length > 0 && (
        <section
          className="event-grid"
          aria-label={`${sportLabels[sport]} games`}
        >
          {state.page.items.map((game) => {
            const selections =
              game.odds.state === "available" ? game.odds.selections : [];
            const find = (marketKey: string, selectionKey: string) =>
              selections.find(
                (selection) =>
                  selection.marketKey === marketKey &&
                  selection.selectionKey === selectionKey,
              );
            const moneylineMarket = "moneyline";
            const book = selections[0];
            const title = game.participants
              .map(({ label }) => label)
              .join(" vs ");
            return (
              <article
                className="event-card"
                data-event-id={game.id}
                key={game.id}
              >
                <div className="event-meta">
                  <span>{easternDisplay(game.startsAt)} Eastern</span>
                  <span>
                    {book?.sportsbookLabel ?? book?.sportsbookId ?? "scheduled"}
                  </span>
                </div>
                <EventMetadataBadges game={game} />
                <h2>{title}</h2>
                <div
                  className="market-scroll"
                  tabIndex={0}
                  aria-label={`${title} betting markets`}
                >
                  <table className="market-board">
                    <thead>
                      <tr>
                        <th scope="col">Team</th>
                        <th scope="col">Spread</th>
                        <th scope="col">Total</th>
                        <th scope="col">ML</th>
                      </tr>
                    </thead>
                    <tbody>
                      {game.participants
                        .slice(0, 2)
                        .map((participant, index) => {
                          const side = index === 0 ? "away" : "home";
                          const totalSide = index === 0 ? "over" : "under";
                          const spread = find("spread", side);
                          const total = find("total", totalSide);
                          const moneyline = find(moneylineMarket, side);
                          return (
                            <tr key={participant.label}>
                              <th scope="row">
                                <span className="team-position">
                                  {index === 0 ? "AWAY" : "HOME"}
                                </span>
                                {participant.label}
                              </th>
                              <td>
                                {spread?.point === undefined ? (
                                  <span className="market-missing">—</span>
                                ) : (
                                  <>
                                    <span>{linePoint(spread.point)}</span>
                                    <strong>
                                      {oddsPrice(spread.americanOdds)}
                                    </strong>
                                  </>
                                )}
                              </td>
                              <td>
                                {total?.point === undefined ? (
                                  <span className="market-missing">—</span>
                                ) : (
                                  <>
                                    <span>
                                      {index === 0 ? "O" : "U"}{" "}
                                      {String(total.point)}
                                    </span>
                                    <strong>
                                      {oddsPrice(total.americanOdds)}
                                    </strong>
                                  </>
                                )}
                              </td>
                              <td>
                                {moneyline ? (
                                  <strong>
                                    {oddsPrice(moneyline.americanOdds)}
                                  </strong>
                                ) : (
                                  <span className="market-missing">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                {game.sportKey === "soccer" &&
                  find(moneylineMarket, "draw") && (
                    <div className="draw-price">
                      Draw{" "}
                      <strong>
                        {oddsPrice(find(moneylineMarket, "draw")!.americanOdds)}
                      </strong>
                    </div>
                  )}
                <div className="market-source">
                  {book
                    ? `Observed ${easternDisplay(book.observedAt)} Eastern`
                    : "Odds unavailable"}
                </div>
                <Link
                  className="detail-link"
                  to="/games/$gameId"
                  params={{ gameId: game.id }}
                  search={{ sport, day }}
                >
                  View game details
                </Link>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}

function SplitsExplorer() {
  const client = useContext(GamesClientContext);
  const [sport, setSport] = useState<GamesSport>("mlb");
  const [day, setDay] = useState(() => currentEasternDay());
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | {
        readonly kind: "ready";
        readonly items: Awaited<
          ReturnType<NonNullable<UiGamesClient["listSplits"]>>
        >["items"];
        readonly freshness: string | null | undefined;
        readonly snapshotAt: string | null | undefined;
        readonly observedAt: number;
      }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });
  const validBoardKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let requestInFlight = false;
    const boardKey = `${sport}:${day}`;
    let hasValidBoard = validBoardKey.current === boardKey;
    const load = async () => {
      if (requestInFlight || controller.signal.aborted) return;
      if (!client.ok || !client.value.listSplits) {
        setState({
          kind: "error",
          message: "Betting splits are not configured yet.",
        });
        return;
      }
      requestInFlight = true;
      try {
        const page = await client.value.listSplits(
          { sport, day },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          hasValidBoard = true;
          validBoardKey.current = boardKey;
          setState({
            kind: "ready",
            items: page.items,
            freshness: page.freshness,
            snapshotAt: page.snapshotAt,
            observedAt: Date.now(),
          });
        }
      } catch {
        if (!controller.signal.aborted && !hasValidBoard)
          setState({
            kind: "error",
            message: "Betting splits are temporarily unavailable.",
          });
      } finally {
        requestInFlight = false;
      }
    };
    void load();
    const refreshInterval = window.setInterval(() => {
      void load();
    }, SPLITS_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(refreshInterval);
      controller.abort();
    };
  }, [client, day, sport]);

  const games = state.kind === "ready" ? state.items : [];
  const scopeLabel = (scope: string | undefined) =>
    scope?.trim() || "Scope unavailable";
  const scopes = [
    ...new Map(
      games
        .flatMap((game) => game.splits.map((split) => scopeLabel(split.scope)))
        .map((scope) => [sportsbookScopeKey(scope), scope]),
    ).values(),
  ].sort((left, right) =>
    sportsbookMetadata(left).name.localeCompare(sportsbookMetadata(right).name),
  );
  const boards = games.map((game) => {
    const gameScopes = [
      ...new Map(
        game.splits.map((split) => {
          const scope = scopeLabel(split.scope);
          return [sportsbookScopeKey(scope), scope];
        }),
      ).values(),
    ].sort((left, right) =>
      sportsbookMetadata(left).name.localeCompare(
        sportsbookMetadata(right).name,
      ),
    );
    const scope = selectedScope ?? gameScopes[0];
    return {
      game,
      scope,
      splits: scope
        ? game.splits.filter(
            (split) =>
              sportsbookScopeKey(scopeLabel(split.scope)) ===
              sportsbookScopeKey(scope),
          )
        : [],
    };
  });
  const coveredGames = boards.filter(({ splits }) => splits.length > 0).length;
  const observationCount = boards.reduce(
    (total, { splits }) => total + splits.length,
    0,
  );
  const timestampCandidates =
    state.kind === "ready"
      ? boards
          .flatMap(({ splits }) =>
            splits.flatMap((split) => [
              split.providerTimestamp,
              split.retrievedAt,
            ]),
          )
          .filter(
            (timestamp): timestamp is string =>
              typeof timestamp === "string" &&
              Number.isFinite(Date.parse(timestamp)),
          )
      : [];
  const newestObservation = timestampCandidates.sort(
    (left, right) => Date.parse(right) - Date.parse(left),
  )[0];
  const ageMinutes = newestObservation
    ? Math.max(
        0,
        ((state.kind === "ready" ? state.observedAt : 0) -
          Date.parse(newestObservation)) /
          60_000,
      )
    : undefined;
  const freshnessState =
    ageMinutes === undefined
      ? { label: "Freshness unknown", className: "freshness-unknown" }
      : ageMinutes <= 15
        ? { label: "Current", className: "freshness-current" }
        : ageMinutes <= 60
          ? { label: "Aging", className: "freshness-aging" }
          : { label: "Stale", className: "freshness-stale" };

  const selectSplit = (
    splits: (typeof boards)[number]["splits"],
    market: "spread" | "total" | "moneyline",
    selectionKey: "away" | "home" | "over" | "under" | "draw",
  ) => {
    return [...splits]
      .filter(
        (split) =>
          split.marketKey === market && split.selectionKey === selectionKey,
      )
      .sort(
        (left, right) =>
          Date.parse(right.providerTimestamp) -
            Date.parse(left.providerTimestamp) ||
          left.id.localeCompare(right.id),
      )[0];
  };

  const percentage = (value: number | undefined) =>
    value === undefined ? "—" : `${value.toFixed(0)}%`;

  const gapDetails = (
    moneyPercent: number | undefined,
    betPercent: number | undefined,
  ) => {
    if (moneyPercent === undefined || betPercent === undefined)
      return undefined;
    const gap = moneyPercent - betPercent;
    const magnitude = Math.abs(gap);
    const direction = gap > 0 ? "more money" : gap < 0 ? "more bets" : "even";
    return {
      className:
        magnitude >= 20
          ? "split-gap split-gap-strong"
          : magnitude >= 10
            ? "split-gap split-gap-notable"
            : "split-gap",
      label:
        direction === "even"
          ? "Even money and bets"
          : `${gap > 0 ? "+" : "−"}${magnitude.toFixed(0)} pts ${direction}`,
    };
  };

  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">PUBLIC MONEY · PROVIDER-TIMESTAMPED</p>
          <h1>Betting splits</h1>
          <p className="lede">
            Compare ticket percentage with money percentage from SharpAPI's
            sportsbook public-betting feeds.
          </p>
        </div>
        <span className="maturity beta">SharpAPI Pro</span>
      </header>
      <aside className="split-signal-context" aria-label="How to use splits">
        <strong>One signal, not the answer.</strong>
        <span>
          DraftKings reflects recreational betting; Circa is sharp-adjacent. No
          sharp sportsbook publishes splits, so compare this evidence with line
          movement and +EV analysis before acting.
        </span>
      </aside>
      <section className="game-filters" aria-label="Split filters">
        <fieldset>
          <legend>Sport</legend>
          {(Object.keys(sportLabels) as GamesSport[]).map((key) => (
            <button
              key={key}
              type="button"
              className={sport === key ? "selected" : ""}
              onClick={() => {
                setState({ kind: "loading" });
                setSelectedScope(null);
                setSport(key);
              }}
            >
              {sportLabels[key]}
            </button>
          ))}
        </fieldset>
        <label>
          <span>Eastern calendar day</span>
          <input
            type="date"
            value={day}
            onChange={(event) => {
              setState({ kind: "loading" });
              setSelectedScope(null);
              setDay(event.currentTarget.value);
            }}
          />
        </label>
      </section>
      {state.kind === "ready" && games.length > 0 && (
        <section className="sportsbook-filters" aria-label="Sportsbook scope">
          <button
            type="button"
            className={selectedScope === null ? "selected" : ""}
            aria-pressed={selectedScope === null}
            onClick={() => setSelectedScope(null)}
          >
            <span className="all-books-mark" aria-hidden="true">
              ALL
            </span>
            <span>All books</span>
          </button>
          {scopes.map((scope) => {
            const name = sportsbookMetadata(scope).name;
            return (
              <button
                key={scope}
                type="button"
                className={selectedScope === scope ? "selected" : ""}
                aria-label={`Show ${name} splits`}
                title={name}
                aria-pressed={selectedScope === scope}
                onClick={() => setSelectedScope(scope)}
              >
                <SportsbookLogo scope={scope} />
              </button>
            );
          })}
        </section>
      )}
      {state.kind === "ready" && games.length > 0 && (
        <section className="splits-toolbar" aria-label="Splits summary">
          <div>
            <span className={`terminal-kicker ${freshnessState.className}`}>
              {freshnessState.label} splits board
            </span>
            <strong>
              {games.length} games · {coveredGames} with data ·{" "}
              {observationCount} observations
            </strong>
          </div>
          <dl>
            <div>
              <dt>Selected book</dt>
              <dd>
                {selectedScope
                  ? sportsbookMetadata(selectedScope).name
                  : "All books"}
              </dd>
            </div>
            <div>
              <dt>Freshest evidence</dt>
              <dd>
                {newestObservation
                  ? `${easternDisplay(newestObservation)} Eastern`
                  : "Timestamp unavailable"}
              </dd>
            </div>
          </dl>
        </section>
      )}
      <section className="splits-terminal" aria-label="Betting splits">
        <div className="terminal-state" aria-live="polite">
          {state.kind === "loading" && <p>Loading current split evidence…</p>}
          {state.kind === "error" && <p role="alert">{state.message}</p>}
          {state.kind === "ready" && games.length === 0 && (
            <p>No scheduled games are available for this day.</p>
          )}
        </div>
        {state.kind === "ready" && games.length > 0 && (
          <div
            className="market-scroll splits-scroll"
            tabIndex={0}
            role="region"
            aria-label="Betting splits comparison table; scroll horizontally for all markets"
          >
            <table className="split-board">
              <caption className="sr-only">
                Betting splits by game and team. Handle means money percentage;
                bets means ticket percentage.
              </caption>
              <thead>
                <tr>
                  <th className="split-team-heading" rowSpan={2} scope="col">
                    Game / team
                  </th>
                  {(["Spread", "Total", "Moneyline"] as const).map((market) => (
                    <th key={market} colSpan={3} scope="colgroup">
                      {market}
                    </th>
                  ))}
                </tr>
                <tr>
                  {(["Spread", "Total", "Moneyline"] as const).flatMap(
                    (market) =>
                      (["Line", "Handle", "Bets"] as const).map((metric) => (
                        <th key={`${market}-${metric}`} scope="col">
                          {metric}
                        </th>
                      )),
                  )}
                </tr>
              </thead>
              {boards.map(({ game, scope, splits }) => {
                const hasDraw = game.sportKey === "soccer";
                const rows = [
                  {
                    key: "away" as const,
                    label: game.participants[0]?.label ?? "Unknown team",
                  },
                  {
                    key: "home" as const,
                    label: game.participants[1]?.label ?? "Unknown team",
                  },
                  ...(hasDraw ? [{ key: "draw" as const, label: "Draw" }] : []),
                ];
                return (
                  <tbody key={game.id} className="split-game-group">
                    {rows.map((row, rowIndex) => {
                      const spread =
                        row.key === "draw"
                          ? undefined
                          : selectSplit(splits, "spread", row.key);
                      const totalKey =
                        row.key === "away"
                          ? "over"
                          : row.key === "home"
                            ? "under"
                            : undefined;
                      const total = totalKey
                        ? selectSplit(splits, "total", totalKey)
                        : undefined;
                      const moneyline = selectSplit(
                        splits,
                        "moneyline",
                        row.key,
                      );
                      const cells = [spread, total, moneyline];
                      return (
                        <tr key={row.key}>
                          <th className="split-team" scope="row">
                            {rowIndex === 0 && (
                              <span className="split-start">
                                {easternDisplay(game.startsAt)} Eastern
                              </span>
                            )}
                            <span className="split-team-name">{row.label}</span>
                            {rowIndex === 0 && splits.length === 0 && (
                              <span className="split-scope split-no-data">
                                No split data
                              </span>
                            )}
                            {rowIndex === 0 && splits.length > 0 && scope && (
                              <span className="split-scope">
                                {sportsbookMetadata(scope).name}
                              </span>
                            )}
                            {rowIndex === rows.length - 1 && (
                              <Link
                                className="split-game-link"
                                to="/games/$gameId"
                                params={{ gameId: game.id }}
                                search={{ sport, day }}
                                aria-label={`View ${game.participants
                                  .map(({ label }) => label)
                                  .join(" versus ")} game details`}
                              >
                                Game details →
                              </Link>
                            )}
                          </th>
                          {cells.flatMap((split, marketIndex) => {
                            const gap = gapDetails(
                              split?.moneyPercent,
                              split?.betPercent,
                            );
                            return [
                              <td
                                key={`${marketIndex}-line`}
                                className="split-line"
                              >
                                {split?.point === undefined
                                  ? "—"
                                  : marketIndex === 1
                                    ? `${row.key === "away" ? "O" : "U"} ${String(split.point)}`
                                    : linePoint(split.point)}
                              </td>,
                              <td key={`${marketIndex}-handle`}>
                                <span className="split-percent">
                                  {percentage(split?.moneyPercent)}
                                </span>
                                {gap && (
                                  <span className={gap.className}>
                                    {gap.label}
                                  </span>
                                )}
                              </td>,
                              <td key={`${marketIndex}-bets`}>
                                <span className="split-percent">
                                  {percentage(split?.betPercent)}
                                </span>
                              </td>,
                            ];
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function GameDetail() {
  const client = useContext(GamesClientContext);
  const { gameId } = useParams({ from: "/games/$gameId" });
  const { sport, day } = useSearch({ from: "/games/$gameId" });
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | {
        readonly kind: "ready";
        readonly game: Awaited<
          ReturnType<NonNullable<UiGamesClient["listSplits"]>>
        >["items"][number];
      }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (!client.ok || !client.value.listSplits) {
        setState({ kind: "error", message: "Game details are unavailable." });
        return;
      }
      try {
        const page = await client.value.listSplits(
          { sport, day },
          controller.signal,
        );
        const game = page.items.find((item) => item.id === gameId);
        if (!controller.signal.aborted)
          setState(
            game
              ? { kind: "ready", game }
              : { kind: "error", message: "This game was not found." },
          );
      } catch {
        if (!controller.signal.aborted)
          setState({
            kind: "error",
            message: "Game details are temporarily unavailable.",
          });
      }
    };
    void load();
    return () => controller.abort();
  }, [client, day, gameId, sport]);

  if (state.kind === "loading") return <p>Loading game details…</p>;
  if (state.kind === "error") return <p role="alert">{state.message}</p>;
  const game = state.game;
  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">GAME DETAIL · SHARPAPI</p>
          <h1>{game.participants.map(({ label }) => label).join(" vs ")}</h1>
          <p className="lede">{easternDisplay(game.startsAt)} Eastern</p>
          <EventMetadataBadges game={game} />
        </div>
        <Link className="detail-link" to="/games">
          Back to games
        </Link>
      </header>
      <section className="detail-grid">
        <article className="split-card">
          <h2>Current odds</h2>
          {game.odds.state === "available" ? (
            <table className="split-board">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Line</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {game.odds.selections.map((price) => (
                  <tr key={`${price.marketKey}-${price.selectionKey}`}>
                    <td>{price.marketKey}</td>
                    <td>{price.selectionLabel ?? price.selectionKey}</td>
                    <td>
                      {price.point === undefined ? "—" : linePoint(price.point)}
                    </td>
                    <td>{oddsPrice(price.americanOdds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Odds unavailable.</p>
          )}
        </article>
        <article className="split-card">
          <h2>Current betting splits</h2>
          <p className="split-card-context">
            DraftKings is recreational and Circa is sharp-adjacent. Treat splits
            as one signal alongside line movement and +EV analysis.
          </p>
          {game.splits.length ? (
            <table className="split-board">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Bets</th>
                  <th>Money</th>
                </tr>
              </thead>
              <tbody>
                {game.splits.map((split) => (
                  <tr key={split.id}>
                    <td>{split.marketKey}</td>
                    <td>{split.selectionKey}</td>
                    <td>{split.betPercent?.toFixed(0) ?? "—"}%</td>
                    <td>{split.moneyPercent?.toFixed(0) ?? "—"}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Splits are not available for this game yet.</p>
          )}
        </article>
      </section>
    </>
  );
}

function PerformanceDashboard() {
  const client = useContext(GamesClientContext);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        report: NonNullable<
          Awaited<ReturnType<NonNullable<UiGamesClient["listPerformance"]>>>
        >;
      }
  >(() =>
    client.ok && client.value.listPerformance
      ? { kind: "loading" }
      : { kind: "empty" },
  );
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.listPerformance) {
      return () => controller.abort();
    }
    client.value
      .listPerformance(controller.signal)
      .then((report) =>
        setState(report ? { kind: "ready", report } : { kind: "empty" }),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Performance is temporarily unavailable.",
          });
      });
    return () => controller.abort();
  }, [client]);
  const pct = (value: number | null) =>
    value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">IMMUTABLE PAPER COHORTS · PRICE-AWARE</p>
          <h1>Performance</h1>
          <p className="lede">
            Profitability, calibration, closing-line value, uncertainty, and
            drawdown—kept separate so a good hit rate cannot hide bad prices.
          </p>
        </div>
        <span className="maturity beta">Paper only</span>
      </header>
      {state.kind === "loading" && (
        <section className="performance-state" aria-live="polite">
          Loading frozen performance evidence…
        </section>
      )}
      {state.kind === "error" && (
        <section className="performance-state" role="alert">
          {state.message}
        </section>
      )}
      {state.kind === "empty" && (
        <section className="performance-state">
          <strong>No frozen cohort report yet.</strong>
          <p>
            Reports appear here after settled paper picks are grouped and
            evaluated. Missing evidence is never shown as zero.
          </p>
        </section>
      )}
      {state.kind === "ready" && (
        <section className="performance-dashboard">
          <aside
            className={`sample-caution ${state.report.metrics.sampleCaution}`}
          >
            <strong>{state.report.metrics.sampleCaution} sample</strong>
            <span>
              {state.report.metrics.counts.decisions} decisions · cutoff{" "}
              {easternDisplay(state.report.cutoff)} Eastern
            </span>
          </aside>
          <nav
            className="performance-facets"
            aria-label="Frozen cohort dimensions"
          >
            {Object.entries(state.report.facets).flatMap(
              ([dimension, values]) =>
                values.map((value) => (
                  <span key={`${dimension}:${value}`} title={dimension}>
                    {value}
                  </span>
                )),
            )}
          </nav>
          <div className="performance-cards" aria-label="Performance summary">
            {[
              ["Units", state.report.metrics.units.toFixed(2)],
              ["ROI", pct(state.report.metrics.roi)],
              [
                "ROI 95% range",
                state.report.metrics.roiInterval95
                  ? `${pct(state.report.metrics.roiInterval95.low)}–${pct(state.report.metrics.roiInterval95.high)}`
                  : "Unavailable",
              ],
              ["Win rate", pct(state.report.metrics.winRate)],
              [
                "Win rate 95% range",
                state.report.metrics.winRateInterval95
                  ? `${pct(state.report.metrics.winRateInterval95.low)}–${pct(state.report.metrics.winRateInterval95.high)}`
                  : "Unavailable",
              ],
              [
                "Break-even probability",
                pct(state.report.metrics.breakEvenProbability),
              ],
              [
                "Average decimal odds",
                state.report.metrics.averageDecimalOdds?.toFixed(2) ??
                  "Unavailable",
              ],
              ["Estimated EV", pct(state.report.metrics.estimatedEv)],
              ["CLV", pct(state.report.metrics.clv.averagePrice)],
              [
                "CLV implied-probability move",
                pct(state.report.metrics.clv.averageImpliedProbability),
              ],
              [
                "Brier score",
                state.report.metrics.brierScore?.toFixed(3) ?? "Unavailable",
              ],
              [
                "Max drawdown",
                `${state.report.metrics.maximumDrawdown.toFixed(2)}u`,
              ],
            ].map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <div className="performance-panels">
            <article>
              <h2>Exact denominators</h2>
              <dl className="performance-counts">
                {Object.entries(state.report.metrics.counts).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ),
                )}
              </dl>
            </article>
            <article>
              <h2>Calibration</h2>
              <div
                className="calibration-bars"
                aria-label="Forecast calibration deciles"
              >
                {state.report.metrics.calibration.map((bucket) => (
                  <div key={bucket.lower}>
                    <span>
                      {Math.round(bucket.lower * 100)}–
                      {Math.round(bucket.upper * 100)}%
                    </span>
                    <i
                      style={{
                        height: `${Math.max(2, (bucket.observedRate ?? 0) * 100)}%`,
                      }}
                    />
                    <small>{bucket.count} picks</small>
                  </div>
                ))}
              </div>
              <p>ECE {pct(state.report.metrics.expectedCalibrationError)}</p>
            </article>
            <article>
              <h2>Cumulative units</h2>
              {state.report.metrics.cumulativeUnits.length ? (
                <ol className="performance-timeline">
                  {state.report.metrics.cumulativeUnits.map((point) => (
                    <li key={point.id}>
                      <span>{point.id}</span>
                      <strong>{point.value.toFixed(2)}u</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No resolved exposure in this cohort.</p>
              )}
            </article>
            <article>
              <h2>Missing closing evidence</h2>
              <dl className="performance-counts">
                {Object.entries(
                  state.report.metrics.clv.unavailableReasons,
                ).map(([reason, count]) => (
                  <div key={reason}>
                    <dt>{reason}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            </article>
          </div>
          <footer className="performance-provenance">
            Report {state.report.reportId} · Cohort {state.report.cohortId} ·{" "}
            {state.report.metrics.clv.unavailable} picks missing valid closing
            evidence
          </footer>
        </section>
      )}
    </>
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
  errorComponent: AppError,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: EdgeLab,
});
const gamesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/games",
  component: GamesExplorer,
});
const splitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/splits",
  component: SplitsExplorer,
});
const performanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/performance",
  component: PerformanceDashboard,
});
function RetrospectivesList() {
  const client = useContext(GamesClientContext),
    [state, setState] = useState<{
      loading: boolean;
      items: readonly RetrospectiveDto[];
      error: string | null;
    }>({ loading: true, items: [], error: null });
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.listRetrospectives) {
      void Promise.resolve().then(() =>
        setState({
          loading: false,
          items: [],
          error: "Retrospectives are unavailable in this environment.",
        }),
      );
      return () => controller.abort();
    }
    client.value
      .listRetrospectives(controller.signal)
      .then((items) => setState({ loading: false, items, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            items: [],
            error:
              error instanceof Error
                ? error.message
                : "Retrospectives are temporarily unavailable.",
          });
      });
    return () => controller.abort();
  }, [client]);
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">FROZEN LEARNING · REVIEWABLE HISTORY</p>
          <h1>Retrospectives</h1>
          <p>
            Structured lessons from exact performance evidence. Outcomes invite
            review; they do not prove cause.
          </p>
        </div>
      </header>
      {state.loading ? (
        <section className="performance-state">
          Loading frozen retrospectives…
        </section>
      ) : state.error ? (
        <section className="performance-state" role="alert">
          {state.error}
        </section>
      ) : state.items.length === 0 ? (
        <section className="performance-state">
          <h2>No retrospectives yet</h2>
          <p>A retrospective appears after a completed performance report.</p>
        </section>
      ) : (
        <section className="retrospective-grid">
          {state.items.map((item) => (
            <Link
              key={item.versionId}
              to="/retrospectives/$versionId"
              params={{ versionId: item.versionId }}
              className="retrospective-card"
            >
              <span className="eyebrow">
                VERSION {item.version} · {item.state.toUpperCase()}
              </span>
              <h2>
                {item.memberCount} reviewed decision
                {item.memberCount === 1 ? "" : "s"}
              </h2>
              <p>
                {item.caution === "standard"
                  ? "Established review sample"
                  : item.caution === "single-member"
                    ? "Single-member caution"
                    : "Small-sample caution"}
              </p>
              <small>
                Report revision {item.reportRevision} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </small>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}
function RetrospectiveDetail() {
  const { versionId } = useParams({ from: "/retrospectives/$versionId" }),
    client = useContext(GamesClientContext),
    [state, setState] = useState<{
      loading: boolean;
      item: RetrospectiveDto | null;
      versions: readonly RetrospectiveDto[];
      error: string | null;
    }>({ loading: true, item: null, versions: [], error: null }),
    [canReview, setCanReview] = useState(false),
    [reviewAction, setReviewAction] = useState<
      "approve" | "reject" | "request-changes"
    >("request-changes"),
    [reviewNote, setReviewNote] = useState(""),
    [reviewConfirmed, setReviewConfirmed] = useState(false),
    [reviewStatus, setReviewStatus] = useState<string | null>(null),
    [reviewBusy, setReviewBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.getRetrospective) {
      void Promise.resolve().then(() =>
        setState({
          loading: false,
          item: null,
          versions: [],
          error: "Retrospective detail is unavailable.",
        }),
      );
      return () => controller.abort();
    }
    client.value
      .getRetrospective(versionId, controller.signal)
      .then(async (item) => ({
        item,
        versions: client.value.listRetrospectiveVersions
          ? await client.value.listRetrospectiveVersions(
              item.retrospectiveId,
              controller.signal,
            )
          : [item],
      }))
      .then(({ item, versions }) =>
        setState({ loading: false, item, versions, error: null }),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            item: null,
            versions: [],
            error:
              error instanceof Error
                ? error.message
                : "This retrospective is temporarily unavailable.",
          });
      });
    void client.value.canReviewRetrospectives?.().then((allowed) => {
      if (!controller.signal.aborted) setCanReview(allowed);
    });
    return () => controller.abort();
  }, [client, versionId]);
  if (state.loading)
    return (
      <section className="performance-state">
        Loading exact review evidence…
      </section>
    );
  if (state.error || !state.item)
    return (
      <section className="performance-state" role="alert">
        {state.error ?? "Retrospective unavailable."}
      </section>
    );
  const item = state.item;
  const submitReview = async () => {
    if (
      !client.ok ||
      !client.value.reviewRetrospective ||
      !reviewConfirmed ||
      reviewBusy
    )
      return;
    const controller = new AbortController();
    setReviewBusy(true);
    setReviewStatus(null);
    try {
      const reviewed = await client.value.reviewRetrospective(
        item,
        {
          reasonCode: reviewAction,
          note: reviewNote,
          idempotencyKey: crypto.randomUUID(),
        },
        controller.signal,
      );
      const versions = client.value.listRetrospectiveVersions
        ? await client.value.listRetrospectiveVersions(
            reviewed.retrospectiveId,
            controller.signal,
          )
        : [reviewed];
      setState({ loading: false, item: reviewed, versions, error: null });
      setReviewConfirmed(false);
      setReviewStatus(
        "Review saved. The immutable audit history has been refreshed.",
      );
    } catch (error) {
      if (
        (error as { code?: string }).code === "conflict" &&
        client.value.getRetrospective
      ) {
        const refreshed = await client.value.getRetrospective(
          item.versionId,
          controller.signal,
        );
        const versions = client.value.listRetrospectiveVersions
          ? await client.value.listRetrospectiveVersions(
              refreshed.retrospectiveId,
              controller.signal,
            )
          : [refreshed];
        setState({ loading: false, item: refreshed, versions, error: null });
        setReviewStatus(
          "Another reviewer changed this version. The latest state is now shown; please review it again.",
        );
      } else
        setReviewStatus(
          error instanceof Error
            ? error.message
            : "The review could not be saved.",
        );
    } finally {
      setReviewBusy(false);
    }
  };
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">
            RETROSPECTIVE V{item.version} · {item.state.toUpperCase()}
          </p>
          <h1>Evidence review</h1>
          <p>
            {item.memberCount} frozen decisions ·{" "}
            {item.caution.replace("-", " ")} · no automatic strategy changes
          </p>
        </div>
        <span className="status">READ ONLY</span>
      </header>
      <section className="evidence-layers">
        <article>
          <span className="eyebrow">DECISION-TIME EVIDENCE</span>
          <h2>What was knowable then</h2>
          {item.evidence.decisionTime.map((ref) => (
            <div key={ref.id}>
              <strong>{ref.kind}</strong>
              <small>{ref.observedAt}</small>
            </div>
          ))}
          <code>{item.evidence.decisionTimeDigest}</code>
        </article>
        <article>
          <span className="eyebrow">POST-EVENT EVIDENCE</span>
          <h2>What became known later</h2>
          {item.evidence.postDecision.length ? (
            item.evidence.postDecision.map((ref) => (
              <div key={ref.id}>
                <strong>{ref.kind}</strong>
                <small>{ref.observedAt}</small>
              </div>
            ))
          ) : (
            <p>None available.</p>
          )}
          <code>{item.evidence.postDecisionDigest}</code>
        </article>
      </section>
      <section className="retrospective-panel">
        <div>
          <span className="eyebrow">ERROR TAXONOMY · V1</span>
          <h2>Review observations</h2>
        </div>
        {item.observations.map((observation) => (
          <article key={observation.id}>
            <span>{observation.taxonomyCode}</span>
            <strong>{observation.summary}</strong>
            <small>
              {observation.layer.replace("-", " ")} ·{" "}
              {observation.confidence.replace("-", " ")}
            </small>
          </article>
        ))}
      </section>
      <section className="retrospective-panel">
        <span className="eyebrow">OUTCOME & DIMENSION SLICES</span>
        <div className="slice-grid">
          {item.slices.map((slice) => (
            <article key={`${slice.dimension}-${slice.value}`}>
              <strong>
                {slice.dimension}: {slice.value}
              </strong>
              <span>{slice.memberCount} members</span>
              <small>
                {slice.wins}W · {slice.losses}L · {slice.pushes}P ·{" "}
                {slice.voids}V · {slice.unresolved} unresolved
              </small>
              <small>
                Units{" "}
                {slice.units === null ? "unavailable" : slice.units.toFixed(2)}{" "}
                · ROI{" "}
                {slice.roi === null
                  ? "unavailable"
                  : `${(slice.roi * 100).toFixed(1)}%`}
              </small>
            </article>
          ))}
        </div>
      </section>
      <section className="retrospective-panel">
        <span className="eyebrow">NON-EXECUTABLE CHANGE CANDIDATES</span>
        {item.candidates.length ? (
          item.candidates.map((candidate) => (
            <article key={candidate.candidateId}>
              <strong>
                {candidate.kind}: {candidate.summary}
              </strong>
              <small>Review only · cannot deploy or promote</small>
            </article>
          ))
        ) : (
          <p>
            No change candidates were proposed. A loss alone never creates one.
          </p>
        )}
        <p className="sample-caution">
          False-negative review: unavailable until a frozen non-play universe
          exists.
        </p>
      </section>
      <section className="retrospective-panel" aria-label="Version history">
        <span className="eyebrow">VERSION HISTORY</span>
        {state.versions.map((version) => (
          <article key={version.versionId}>
            <span>v{version.version}</span>
            <strong>
              {version.versionId === item.versionId
                ? "Current immutable version"
                : version.state.replace("-", " ")}
            </strong>
            <small>{version.versionId}</small>
            {version.versionId !== item.versionId ? (
              <Link
                to="/retrospectives/$versionId"
                params={{ versionId: version.versionId }}
              >
                Open immutable version
              </Link>
            ) : null}
          </article>
        ))}
        {state.versions.length === 1 && !item.predecessorVersionId ? (
          <p>Initial version; no predecessor.</p>
        ) : null}
      </section>
      <section
        className="retrospective-panel"
        aria-label="Review audit history"
      >
        <span className="eyebrow">REVIEW AUDIT</span>
        {item.audit?.items.length ? (
          item.audit.items.map((decision) => (
            <article key={decision.decisionId}>
              <strong>{decision.reasonCode.replace("-", " ")}</strong>
              <small>
                {decision.fromState} → {decision.toState} ·{" "}
                {new Date(decision.decidedAt).toLocaleString()}
              </small>
            </article>
          ))
        ) : (
          <p>No human review decisions yet.</p>
        )}
      </section>
      {canReview && item.state === "draft" ? (
        <section
          className="retrospective-panel"
          aria-label="Human review decision"
        >
          <span className="eyebrow">REVIEWER DECISION</span>
          <fieldset>
            <legend>Choose one explicit action</legend>
            {(["request-changes", "approve", "reject"] as const).map(
              (action) => (
                <label key={action}>
                  <input
                    type="radio"
                    name="review-action"
                    value={action}
                    checked={reviewAction === action}
                    onChange={() => {
                      setReviewAction(action);
                      setReviewConfirmed(false);
                    }}
                  />
                  {action.replace("-", " ")}
                </label>
              ),
            )}
          </fieldset>
          <label>
            <span>Reviewer note</span>
            <textarea
              value={reviewNote}
              maxLength={1000}
              onChange={(event) => {
                setReviewNote(event.currentTarget.value);
                setReviewConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={reviewConfirmed}
              onChange={(event) =>
                setReviewConfirmed(event.currentTarget.checked)
              }
            />
            I confirm this {reviewAction.replace("-", " ")} decision for version{" "}
            {item.version}.
          </label>
          <button
            type="button"
            disabled={!reviewConfirmed || reviewBusy}
            onClick={() => void submitReview()}
          >
            {reviewBusy ? "Saving review…" : "Save human review"}
          </button>
        </section>
      ) : null}
      {reviewStatus ? (
        <p role="status" aria-live="polite">
          {reviewStatus}
        </p>
      ) : null}
      <footer className="performance-provenance">
        Cohort {item.cohortId} · Report {item.reportId} · Manifest{" "}
        {item.evidence.manifestDigest}
        <br />
        Version lineage: {item.predecessorVersionId ?? "initial version"}
      </footer>
    </>
  );
}
const retrospectivesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retrospectives",
  component: RetrospectivesList,
});
function ExperimentsList() {
  const client = useContext(GamesClientContext);
  const [items, setItems] = useState<readonly StrategyExperimentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.listExperiments)
      void Promise.resolve().then(() =>
        setError("Strategy experiments are unavailable."),
      );
    else
      void client.value
        .listExperiments(controller.signal)
        .then(setItems)
        .catch(() =>
          setError("Strategy experiments are temporarily unavailable."),
        );
    return () => controller.abort();
  }, [client]);
  return (
    <>
      <header className="page-header">
        <p className="eyebrow">WALK-FORWARD · HUMAN-GOVERNED</p>
        <h1>Strategy experiments</h1>
        <p>
          Challengers use frozen shadow evidence. Passing gates never activates
          a strategy without human approval.
        </p>
      </header>
      {error ? (
        <section className="empty-state" role="alert">
          {error}
        </section>
      ) : (
        <section className="performance-cards">
          {items.map((item) => (
            <article className="metric-card" key={item.experimentId}>
              <span>{item.createdAt}</span>
              <h2>
                <Link
                  to="/experiments/$experimentId"
                  params={{ experimentId: item.experimentId }}
                >
                  {item.baseline.version} → {item.challenger.version}
                </Link>
              </h2>
              <strong>{item.state}</strong>
              <ul>
                {item.gates.map((gate) => (
                  <li key={gate.metric}>
                    {gate.metric}: {gate.actual ?? "Unavailable"} —{" "}
                    {gate.passed ? "Pass" : "Fail"}
                  </li>
                ))}
              </ul>
              {item.failureReasons.length ? (
                <p>Blocked: {item.failureReasons.join(", ")}</p>
              ) : null}
              <small>Future paper runs only. No real-money activation.</small>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
const experimentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments",
  component: ExperimentsList,
});
function ExperimentDetail() {
  const { experimentId } = useParams({ from: "/experiments/$experimentId" });
  const client = useContext(GamesClientContext);
  const [item, setItem] = useState<
    | (StrategyExperimentDto & {
        readonly train: { startsAt: string; endsAt: string; digest: string };
        readonly tune: { startsAt: string; endsAt: string; digest: string };
        readonly holdout: { startsAt: string; endsAt: string; digest: string };
        readonly contentDigest: string;
        readonly audit: readonly {
          readonly activationId?: string;
          readonly effectiveAt?: string;
        }[];
        readonly active: { readonly activationId: string } | null;
      })
    | null
  >(null);
  const [allowed, setAllowed] = useState(false);
  const [reason, setReason] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [actionState, setActionState] = useState<string | null>(null);
  const load = useCallback(
    (signal: AbortSignal) =>
      client.ok && client.value.getExperiment
        ? client.value
            .getExperiment(experimentId, signal)
            .then((value) => setItem(value as never))
        : Promise.resolve(),
    [client, experimentId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    if (client.ok) void client.value.canManageExperiments?.().then(setAllowed);
    return () => controller.abort();
  }, [client, load]);
  if (!item)
    return (
      <section className="empty-state">
        Loading immutable experiment evidence…
      </section>
    );
  return (
    <>
      <header className="page-header">
        <p className="eyebrow">EXACT EVIDENCE · {item.state}</p>
        <h1>
          {item.baseline.version} → {item.challenger.version}
        </h1>
        <p>Digest {item.contentDigest}</p>
      </header>
      <section className="metric-card">
        <h2>Walk-forward timeline</h2>
        <ol>
          <li>
            Train: {item.train.startsAt} – {item.train.endsAt}
            <br />
            {item.train.digest}
          </li>
          <li>
            Tune: {item.tune.startsAt} – {item.tune.endsAt}
            <br />
            {item.tune.digest}
          </li>
          <li>
            Holdout: {item.holdout.startsAt} – {item.holdout.endsAt}
            <br />
            {item.holdout.digest}
          </li>
        </ol>
      </section>
      <section className="performance-cards">
        {item.gates.map((gate) => (
          <article className="metric-card" key={gate.metric}>
            <span>{gate.metric}</span>
            <strong>{gate.actual ?? "Unavailable"}</strong>
            <p>{gate.passed ? "Passed" : `Failed: ${gate.reason}`}</p>
          </article>
        ))}
      </section>
      <section className="metric-card">
        <h2>Immutable approval and activation history</h2>
        <p>
          {item.audit.length
            ? `${item.audit.length} recorded actions`
            : "No human action recorded."}
        </p>
        <small>
          Promotion and rollback require the dedicated promoter identity, an
          exact digest, confirmation reason, and a future effective time.
          Historical paper runs never change.
        </small>
      </section>
      <section className="metric-card" aria-label="Strategy promotion controls">
        <h2>Human promotion control</h2>
        {!allowed ? (
          <p>
            Read-only. Sign in through the dedicated strategy promoter client to
            take action.
          </p>
        ) : (
          <>
            <label>
              Reason
              <input
                value={reason}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label>
              Future effective time
              <input
                type="datetime-local"
                value={effectiveAt}
                onChange={(event) => setEffectiveAt(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I confirm this only changes future paper runs, targets the
              displayed artifact/digest, and never changes historical runs or
              enables real-money betting.
            </label>
            <div className="review-actions">
              {(["approve", "promote", "rollback"] as const).map((action) => (
                <button
                  key={action}
                  disabled={
                    !confirmed ||
                    !reason.trim() ||
                    (action !== "approve" && !effectiveAt)
                  }
                  onClick={() => {
                    if (!client.ok || !client.value.manageExperiment) return;
                    const controller = new AbortController();
                    const idempotencyKey = crypto.randomUUID();
                    const body =
                      action === "approve"
                        ? {
                            reason: reason.trim(),
                            idempotencyKey,
                            expectedStateVersion: item.stateVersion,
                            expectedDigest: item.contentDigest,
                            artifactDigest: item.challenger.version.length
                              ? (
                                  item as unknown as {
                                    challenger: { digest: string };
                                  }
                                ).challenger.digest
                              : "",
                          }
                        : {
                            strategyId:
                              action === "rollback"
                                ? item.baseline.strategyId
                                : item.challenger.strategyId,
                            artifactVersion:
                              action === "rollback"
                                ? item.baseline.version
                                : item.challenger.version,
                            artifactDigest:
                              action === "rollback"
                                ? item.baseline.digest
                                : item.challenger.digest,
                            effectiveAt: new Date(effectiveAt).toISOString(),
                            expectedActivationId:
                              item.active?.activationId ?? null,
                            reason: reason.trim(),
                            idempotencyKey,
                          };
                    setActionState("Saving…");
                    void client.value
                      .manageExperiment(
                        experimentId,
                        action,
                        body,
                        controller.signal,
                      )
                      .then(() => {
                        setActionState("Saved. Reloaded immutable history.");
                        return load(controller.signal);
                      })
                      .catch(() => {
                        setActionState(
                          "Conflict or unavailable. Reloaded current evidence.",
                        );
                        return load(controller.signal);
                      });
                  }}
                >
                  {action}
                </button>
              ))}
            </div>
          </>
        )}
        <p role="status">{actionState}</p>
      </section>
    </>
  );
}
const experimentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments/$experimentId",
  component: ExperimentDetail,
});
const retrospectiveDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retrospectives/$versionId",
  component: RetrospectiveDetail,
});
const gameDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/games/$gameId",
  validateSearch: (search: Record<string, unknown>) => ({
    sport:
      search["sport"] === "soccer" ? ("soccer" as const) : ("mlb" as const),
    day:
      typeof search["day"] === "string" && validDay(search["day"])
        ? search["day"]
        : currentEasternDay(),
  }),
  component: GameDetail,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  gamesRoute,
  gameDetailRoute,
  splitsRoute,
  performanceRoute,
  retrospectivesRoute,
  retrospectiveDetailRoute,
  experimentsRoute,
  experimentDetailRoute,
]);
const registeredRouter = createRouter({ routeTree });
void registeredRouter;

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof registeredRouter;
  }
}

export function App({
  initialPath,
  gamesClient,
}: {
  initialPath?: string;
  gamesClient?: GamesClientResult;
}) {
  const [router] = useState(() =>
    createRouter({
      routeTree,
      ...(initialPath
        ? {
            history: createMemoryHistory({
              initialEntries: [initialPath],
            }),
          }
        : {}),
    }),
  );
  return (
    <GamesClientContext.Provider value={gamesClient ?? defaultGamesClient}>
      <RouterProvider router={router} />
    </GamesClientContext.Provider>
  );
}
