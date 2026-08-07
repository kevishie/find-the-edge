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
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  evaluateEdge,
  impliedProbability,
  removeVig,
  type EdgeEvaluation,
} from "@find-the-edge/odds";
import { mlbFindTheEdgeStrategy, sportRegistry } from "@find-the-edge/sports";
import {
  eventFreshnessPresentation,
  eventCompetitionOptions,
  eventMatchupLabel,
  filterAndSortEvents,
  eventLifecyclePresentation,
  eventMetadataReasonText,
  buildOddsComparisonViewModel,
} from "@find-the-edge/ui";
import type {
  EventExplorerSortDirection,
  EventExplorerSortField,
  EventExplorerStatus,
} from "@find-the-edge/ui";
import {
  SportsbookLogo,
  sportsbookMetadata,
  sportsbookScopeKey,
} from "./sportsbooks";
import {
  GamesClientError,
  type OddsHistoryDto,
  type OddsHistorySeriesDto,
  type RetrospectiveDto,
} from "./api";
import { detailMatchesRoute } from "./route-state";
import { Dashboard } from "./dashboard";
import { DataSources } from "./provider-status";
import { ScoutEventButton, ScoutingProgress } from "./scouting";

const SPLITS_REFRESH_INTERVAL_MS = 30_000;
const oddsCellTimestamp = (
  cell: import("@find-the-edge/domain").GameOddsCellDto,
) =>
  cell.state === "active" || cell.state === "stale"
    ? cell.observedAt
    : (cell.evidenceAt ?? cell.observedAt);
const oddsCellReason = (reason: string) =>
  reason
    .slice(0, 120)
    .replace(/[-_]+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
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
  readonly lifecycleCoverage?: {
    readonly requested: readonly import("@find-the-edge/domain").EventStatus[];
    readonly loaded: readonly import("@find-the-edge/domain").EventStatus[];
    readonly unavailable: readonly import("@find-the-edge/domain").EventStatus[];
  };
  readonly items: readonly {
    readonly id: string;
    readonly version: number;
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly competition: {
      readonly key: string;
      readonly state: "provisional";
    };
    readonly startsAt: string;
    readonly participants: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly eastern: {
      readonly timeZone: "America/New_York";
      readonly calendarDay: string;
      readonly display: string;
    };
    readonly status: import("@find-the-edge/domain").EventStatus;
    readonly freshness: string | null;
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
            readonly retrievedAt: string;
          }[];
        }
      | { readonly state: "unavailable" };
  }[];
}
interface UiGamesClient {
  providerStatus?: NonNullable<import("./api").GamesClient["providerStatus"]>;
  listOpportunities?: NonNullable<
    import("./api").GamesClient["listOpportunities"]
  >;
  list(
    filter: {
      readonly sport: GamesSport;
      readonly day: string;
      readonly status?: import("@find-the-edge/domain").EventStatus | "all";
    },
    signal: AbortSignal,
  ): Promise<UiGamesPage>;
  detail?(
    eventId: string,
    signal: AbortSignal,
  ): Promise<import("@find-the-edge/domain").GameOddsComparisonDto>;
  oddsHistory?(eventId: string, signal: AbortSignal): Promise<OddsHistoryDto>;
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
  createScoutingJob?: NonNullable<
    import("./api").GamesClient["createScoutingJob"]
  >;
  getScoutingJob?: NonNullable<import("./api").GamesClient["getScoutingJob"]>;
  retryScoutingJob?: NonNullable<
    import("./api").GamesClient["retryScoutingJob"]
  >;
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
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: "active" }}
          >
            Dashboard
          </Link>
          <Link
            to="/games"
            search={{
              sport: "mlb",
              day: currentEasternDay(),
              status: "all",
              competition: "",
              query: "",
              sort: "kickoff",
              direction: "asc",
            }}
            activeProps={{ className: "active" }}
          >
            Games
          </Link>
          <Link to="/splits" activeProps={{ className: "active" }}>
            Betting Splits
          </Link>
          <span>Scout Reports</span>
          <Link to="/performance" activeProps={{ className: "active" }}>
            Performance
          </Link>
          <Link to="/data-sources" activeProps={{ className: "active" }}>
            Data Sources
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
        <nav
          className="mobile-product-nav"
          aria-label="Compact product navigation"
        >
          <Link
            to="/"
            activeOptions={{ exact: true }}
            activeProps={{ className: "active" }}
          >
            Dashboard
          </Link>
          <Link
            to="/games"
            search={{
              sport: "mlb",
              day: currentEasternDay(),
              status: "all",
              competition: "",
              query: "",
              sort: "kickoff",
              direction: "asc",
            }}
            activeProps={{ className: "active" }}
          >
            Games
          </Link>
          <Link to="/splits" activeProps={{ className: "active" }}>
            Splits
          </Link>
          <Link to="/performance" activeProps={{ className: "active" }}>
            Performance
          </Link>
          <Link to="/data-sources" activeProps={{ className: "active" }}>
            Sources
          </Link>
          <Link to="/retrospectives" activeProps={{ className: "active" }}>
            Reviews
          </Link>
          <Link to="/experiments" activeProps={{ className: "active" }}>
            Experiments
          </Link>
        </nav>
      </main>
    </div>
  );
}

function DashboardRoute() {
  return <Dashboard client={useContext(GamesClientContext)} />;
}

function DataSourcesRoute() {
  return <DataSources client={useContext(GamesClientContext)} />;
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

export function EdgeLab() {
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
                      {result.evaluation.display.marketImpliedProbability}
                    </strong>
                  </div>
                  <div>
                    <span>No-vig fair</span>
                    <strong>{result.evaluation.display.fairProbability}</strong>
                  </div>
                  <div>
                    <span>Fair price</span>
                    <strong>{result.evaluation.display.fairAmerican}</strong>
                  </div>
                  <div className="ev">
                    <span>Estimated EV</span>
                    <strong>{result.evaluation.display.expectedValue}</strong>
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
                  {result.evaluation.provenance.root.algorithm.version}
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

const splitAmericanOdds = (split: unknown) => {
  if (
    typeof split !== "object" ||
    split === null ||
    !("americanOdds" in split) ||
    typeof split.americanOdds !== "number"
  )
    return undefined;
  return split.americanOdds;
};

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

interface ExplorerSearch {
  readonly sport: GamesSport;
  readonly day: string;
  readonly status: EventExplorerStatus;
  readonly competition: string;
  readonly query: string;
  readonly sort: EventExplorerSortField;
  readonly direction: EventExplorerSortDirection;
}

function GamesExplorer() {
  const client = useContext(GamesClientContext);
  const search = useSearch({ from: "/games" });
  const navigate = useNavigate({ from: "/games" });
  const { sport, day, status, competition, query, sort, direction } = search;
  const [retry, setRetry] = useState(0);
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false,
  );
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly page: UiGamesPage }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });
  const requestId = useRef(0);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
        const page = await activeClient.list(
          { sport, day, status },
          controller.signal,
        );
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
  }, [client, day, retry, sport, status]);

  const updateSearch = (patch: Partial<typeof search>) =>
    void navigate({
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    });
  const baseItems = state.kind === "ready" ? state.page.items : [];
  const competitions = eventCompetitionOptions(baseItems);
  const visibleItems = filterAndSortEvents(baseItems, {
    competition,
    query,
    sort,
    direction,
  });
  const partial =
    state.kind === "ready" &&
    (state.page.lifecycleCoverage?.unavailable.length ?? 0) > 0;

  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">EVENT CATALOG · EASTERN TIME</p>
          <h1>Events Explorer</h1>
          <p className="lede">
            Browse the complete MLB and MLS event catalog by lifecycle,
            competition, participant, and kickoff.
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
                updateSearch({ sport: key, competition: "", query: "" });
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
              updateSearch({ day: event.currentTarget.value });
            }}
          />
        </label>
        <label>
          <span>Lifecycle</span>
          <select
            value={status}
            onChange={(event) =>
              updateSearch({
                status: event.currentTarget.value as EventExplorerStatus,
              })
            }
          >
            {(
              [
                "all",
                "scheduled",
                "started",
                "postponed",
                "completed",
                "cancelled",
                "unknown",
              ] as const
            ).map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All lifecycles" : value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Competition</span>
          <select
            value={competition}
            onChange={(event) =>
              updateSearch({ competition: event.currentTarget.value })
            }
          >
            <option value="">All competitions</option>
            {competitions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="event-search">
          <span>Participant search</span>
          <input
            type="search"
            value={query}
            placeholder="Team or participant"
            onChange={(event) =>
              updateSearch({ query: event.currentTarget.value })
            }
          />
        </label>
        <label>
          <span>Sort events</span>
          <select
            value={sort}
            onChange={(event) =>
              updateSearch({
                sort: event.currentTarget.value as EventExplorerSortField,
              })
            }
          >
            <option value="kickoff">Kickoff</option>
            <option value="matchup">Matchup</option>
            <option value="competition">Competition</option>
            <option value="lifecycle">Lifecycle</option>
            <option value="freshness">Freshness</option>
          </select>
        </label>
        <label>
          <span>Sort direction</span>
          <select
            value={direction}
            onChange={(event) =>
              updateSearch({
                direction: event.currentTarget
                  .value as EventExplorerSortDirection,
              })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </section>

      <div className="games-status" aria-live="polite" aria-atomic="true">
        {state.kind === "loading" && (
          <div className="explorer-skeleton" role="status">
            Loading events…
          </div>
        )}
        {state.kind === "error" && (
          <div className="explorer-state" role="alert">
            <p>{state.message}</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        )}
        {partial && state.kind === "ready" && (
          <p className="partial-state" role="status">
            Partial lifecycle coverage. Unavailable:{" "}
            {state.page.lifecycleCoverage!.unavailable.join(", ")}.
          </p>
        )}
        {state.kind === "ready" && baseItems.length === 0 && (
          <p role="status">
            {state.page.projectionState === "uninitialized"
              ? "Event projection is unavailable while event data initializes."
              : partial
                ? "No events were returned by the lifecycle groups that loaded. Retry to check the unavailable groups."
                : status === "scheduled"
                  ? `No ${sportLabels[sport]} games are scheduled for this day.`
                  : `No ${sportLabels[sport]} events exist for this day and lifecycle selection.`}
          </p>
        )}
        {state.kind === "ready" &&
          baseItems.length > 0 &&
          visibleItems.length === 0 && (
            <div className="explorer-state" role="status">
              <p>No events match the active filters.</p>
              <button
                type="button"
                onClick={() => updateSearch({ competition: "", query: "" })}
              >
                Clear filters
              </button>
            </div>
          )}
      </div>

      {state.kind === "ready" && visibleItems.length > 0 && (
        <>
          <p className="result-count" role="status">
            {visibleItems.length} events
          </p>
          {!compact && (
            <div
              className="event-table-wrap"
              tabIndex={0}
              aria-label="Events explorer results; scroll horizontally for all columns"
            >
              <table className="event-explorer-table">
                <caption>Events matching the active explorer filters</caption>
                <thead>
                  <tr>
                    {(
                      [
                        ["matchup", "Matchup"],
                        ["kickoff", "Kickoff"],
                        ["competition", "Competition"],
                        ["lifecycle", "Lifecycle"],
                        ["freshness", "Freshness"],
                      ] as const
                    ).map(([field, label]) => (
                      <th scope="col" key={field}>
                        <button
                          type="button"
                          aria-label={`Sort by ${label}`}
                          aria-pressed={sort === field}
                          onClick={() =>
                            updateSearch({
                              sort: field,
                              direction:
                                sort === field && direction === "asc"
                                  ? "desc"
                                  : "asc",
                            })
                          }
                        >
                          {label}
                          {sort === field
                            ? direction === "asc"
                              ? " ↑"
                              : " ↓"
                            : ""}
                        </button>
                      </th>
                    ))}
                    <th scope="col">Spread</th>
                    <th scope="col">Total</th>
                    <th scope="col">ML</th>
                    <th scope="col">Hard Rock</th>
                    <th scope="col">Comparison</th>
                    <th scope="col">Report</th>
                    <th scope="col">Lineup</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((game) => (
                    <EventExplorerRow
                      key={game.id}
                      game={game}
                      explorerSearch={search}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {compact && (
            <section
              className="event-explorer-cards"
              aria-label="Events explorer mobile results"
            >
              {visibleItems.map((game) => (
                <EventExplorerCard
                  key={game.id}
                  game={game}
                  explorerSearch={search}
                />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

function EventExplorerRow({
  game,
  explorerSearch,
}: {
  readonly game: UiGamesPage["items"][number];
  readonly explorerSearch: ExplorerSearch;
}) {
  const client = useContext(GamesClientContext);
  const prices = game.odds.state === "available" ? game.odds.selections : [];
  const market = (key: string) =>
    prices.filter(({ marketKey }) => marketKey === key);
  const marketValues = (key: string) =>
    market(key).length === 0 ? (
      <span>—</span>
    ) : (
      market(key).map((selection) => (
        <span key={selection.selectionKey} className="explorer-market-value">
          {selection.selectionLabel && <span>{selection.selectionLabel}</span>}
          {selection.point !== undefined && (
            <span>
              {key === "total"
                ? `${selection.selectionKey === "over" ? "O" : "U"} ${selection.point}`
                : linePoint(selection.point)}
            </span>
          )}
          <strong>{oddsPrice(selection.americanOdds)}</strong>
        </span>
      ))
    );
  return (
    <tr className="event-card" data-event-id={game.id}>
      <th scope="row">
        <h2>{eventMatchupLabel(game)}</h2>
        {prices[0] && (
          <small>Observed {easternDisplay(prices[0].observedAt)} Eastern</small>
        )}
      </th>
      <td>{easternDisplay(game.startsAt)} Eastern</td>
      <td>{game.competition.key}</td>
      <td>
        <EventMetadataBadges game={game} />
      </td>
      <td>{eventFreshnessPresentation(game.metadata.freshness.state).label}</td>
      <td>{marketValues("spread")}</td>
      <td>{marketValues("total")}</td>
      <td>{marketValues("moneyline")}</td>
      {[
        "Hard Rock not connected yet",
        "Comparison coverage unavailable",
        "Report unavailable",
        "Lineup unavailable",
      ].map((label) => (
        <td key={label}>
          <span className="readiness-unavailable">
            Unavailable<span className="sr-only">: {label}</span>
          </span>
        </td>
      ))}
      <td className="event-actions">
        <Link
          className="detail-link"
          to="/games/$gameId"
          params={{ gameId: game.id }}
          search={explorerSearch}
        >
          View Details
        </Link>
        <ScoutEventButton
          eventId={game.id}
          eligible={game.status === "scheduled"}
          disabledReason={`Scouting is available only for scheduled events. This event is ${game.status}.`}
          client={client}
        />
        <span className="disabled-action">
          <button type="button" disabled aria-describedby={`watch-${game.id}`}>
            Watchlist
          </button>
          <small id={`watch-${game.id}`}>
            Unavailable: Watchlist API is not built yet.
          </small>
        </span>
      </td>
    </tr>
  );
}

function EventExplorerCard({
  game,
  explorerSearch,
}: {
  readonly game: UiGamesPage["items"][number];
  readonly explorerSearch: ExplorerSearch;
}) {
  const client = useContext(GamesClientContext);
  const prices = game.odds.state === "available" ? game.odds.selections : [];
  return (
    <article className="event-explorer-card" data-event-id={game.id}>
      <p className="eyebrow">
        {game.competition.key} · {easternDisplay(game.startsAt)} Eastern
      </p>
      <h2>{eventMatchupLabel(game)}</h2>
      <EventMetadataBadges game={game} />
      {prices.length > 0 && (
        <ul className="mobile-market-prices" aria-label="Current odds">
          {prices.map((price) => (
            <li key={`${price.marketKey}-${price.selectionKey}`}>
              <span>{price.marketKey}</span>{" "}
              <span>{price.selectionLabel ?? price.selectionKey}</span>{" "}
              {price.point !== undefined && (
                <span>{linePoint(price.point)} </span>
              )}
              <strong>{oddsPrice(price.americanOdds)}</strong>
            </li>
          ))}
        </ul>
      )}
      <p>
        Hard Rock, comparison, report, and lineup: <strong>Unavailable</strong>
      </p>
      <Link
        className="detail-link"
        to="/games/$gameId"
        params={{ gameId: game.id }}
        search={explorerSearch}
      >
        View Details
      </Link>
      <div className="disabled-actions">
        <ScoutEventButton
          eventId={game.id}
          eligible={game.status === "scheduled"}
          disabledReason={`Scouting is available only for scheduled events. This event is ${game.status}.`}
          client={client}
        />
        <span className="disabled-action">
          <button disabled aria-describedby={`card-watch-${game.id}`}>
            Watchlist
          </button>
          <small id={`card-watch-${game.id}`}>
            Unavailable: Watchlist API is not built yet.
          </small>
        </span>
      </div>
    </article>
  );
}

const splitDisplayFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const splitAccessibleFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 20,
  useGrouping: false,
});
const splitSignedFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

const splitNumber = (value: number) => splitDisplayFormatter.format(value);

const splitAccessibleNumber = (value: number) =>
  splitAccessibleFormatter.format(Object.is(value, -0) ? 0 : value);

const splitPercent = (value: number) => `${splitNumber(value)}%`;

const splitPointGap = (value: number) => {
  if (value !== 0 && Math.abs(value) < 0.01)
    return `${value > 0 ? "+" : "−"}<0.01`;
  return splitSignedFormatter.format(value).replace("-", "−");
};

const hasSplitPercent = (split: {
  readonly moneyPercent?: number;
  readonly betPercent?: number;
}) => split.moneyPercent !== undefined || split.betPercent !== undefined;

function SplitBar({
  moneyPercent,
  betPercent,
  market,
  selection,
}: {
  readonly moneyPercent: number | undefined;
  readonly betPercent: number | undefined;
  readonly market: string;
  readonly selection: string;
}) {
  const hasMoney = moneyPercent !== undefined && Number.isFinite(moneyPercent);
  const hasBets = betPercent !== undefined && Number.isFinite(betPercent);
  const handle = hasMoney ? Math.max(0, Math.min(100, moneyPercent)) : null;
  const bets = hasBets ? Math.max(0, Math.min(100, betPercent)) : null;

  if (handle === null && bets === null)
    return (
      <span
        className="split-bar-unavailable"
        role="img"
        aria-label={`${market} for ${selection}: split data unavailable`}
      >
        Unavailable
      </span>
    );

  const gap =
    handle !== null && bets !== null
      ? Number((handle - bets).toPrecision(12))
      : null;
  const direction =
    gap === null
      ? null
      : gap > 0
        ? "money-heavy"
        : gap < 0
          ? "ticket-heavy"
          : "even";
  const magnitude = gap === null ? 0 : Math.abs(gap);
  const strength = Math.pow(Math.min(magnitude / 62, 1), 0.75);
  const accent = direction === "ticket-heavy" ? "251, 191, 36" : "168, 85, 247";
  const low =
    handle !== null && bets !== null ? Math.min(handle, bets) : undefined;
  const notchLeft =
    bets === null
      ? undefined
      : bets <= 0
        ? "0"
        : bets >= 100
          ? "calc(100% - 2px)"
          : `calc(${bets}% - 1px)`;
  const handleLabel =
    handle === null
      ? "handle unavailable"
      : `${splitAccessibleNumber(handle)}% handle`;
  const betsLabel =
    bets === null ? "bets unavailable" : `${splitAccessibleNumber(bets)}% bets`;
  const gapLabel =
    gap === null || direction === null
      ? ""
      : `, ${splitAccessibleNumber(magnitude)} percentage points ${direction}`;

  return (
    <span
      className="split-bar-visual"
      role="img"
      aria-label={`${market} for ${selection}: ${handleLabel}, ${betsLabel}${gapLabel}`}
      data-direction={direction ?? "partial"}
    >
      <span className="split-bar-reading">
        <span className="split-bar-track" aria-hidden="true">
          {handle !== null && (
            <span
              className="split-bar-handle"
              style={{ width: `${handle}%` }}
            />
          )}
          {gap !== null && gap !== 0 && low !== undefined && (
            <span
              className={`split-bar-divergence split-bar-divergence-${direction}`}
              style={{
                left: `${low}%`,
                width: `${magnitude}%`,
                backgroundColor: `rgba(${accent}, ${(0.25 + strength * 0.5).toFixed(3)})`,
              }}
            />
          )}
          {bets !== null && (
            <span className="split-bar-bets" style={{ left: notchLeft }} />
          )}
        </span>
        <span className="split-bar-values" aria-hidden="true">
          <span>
            H{" "}
            {handle === null ? (
              "unavailable"
            ) : (
              <strong>{splitPercent(handle)}</strong>
            )}
          </span>
          <span>
            B{" "}
            {bets === null ? (
              "unavailable"
            ) : (
              <strong>{splitPercent(bets)}</strong>
            )}
          </span>
        </span>
      </span>
      {gap !== null && direction && (
        <span
          className={`split-bar-delta split-bar-delta-${direction}`}
          aria-hidden="true"
          title={`${splitNumber(magnitude)} percentage points ${direction}`}
        >
          {splitPointGap(gap)}
        </span>
      )}
    </span>
  );
}

// SharpAPI reports DraftKings and Circa only as one combined consensus scope,
// so they share a single chip. Books it does not aggregate filter on their own.
const splitBookGroups = [
  {
    id: "consensus",
    label: "Circa/DK",
    logoScope: "consensus",
    scopes: ["consensus", "draftkings", "circa"],
  },
  {
    id: "betmgm",
    label: "BetMGM",
    logoScope: "betmgm",
    scopes: ["betmgm"],
  },
] as const;

type SplitBookGroup = (typeof splitBookGroups)[number];

// Anything the provider does not scope to its own book belongs to the default
// consensus board, so unscoped evidence is never silently dropped.
const splitBookGroupFor = (scope: string | undefined): SplitBookGroup => {
  const key = sportsbookScopeKey(scope ?? "");
  return (
    splitBookGroups.find((group) =>
      (group.scopes as readonly string[]).includes(key),
    ) ?? splitBookGroups[0]
  );
};

function SplitsExplorer() {
  const client = useContext(GamesClientContext);
  const [sport, setSport] = useState<GamesSport>("mlb");
  const [day, setDay] = useState(() => currentEasternDay());
  const [book, setBook] = useState<SplitBookGroup["id"]>("consensus");
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
        readonly refreshFailed: boolean;
      }
    | { readonly kind: "not-found"; readonly message: string }
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
            refreshFailed: false,
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          if (!hasValidBoard) {
            setState({
              kind: "error",
              message: "Betting splits are temporarily unavailable.",
            });
          } else {
            setState((current) =>
              current.kind === "ready"
                ? {
                    ...current,
                    observedAt: Date.now(),
                    refreshFailed: true,
                  }
                : current,
            );
          }
        }
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
  const splitScopePriority = (scope: string | undefined) => {
    const key = sportsbookScopeKey(scope ?? "");
    if (key === "consensus") return 0;
    if (key === "draftkings") return 1;
    if (key === "circa") return 2;
    return 3;
  };
  // Only offer a book the board can actually fill, and fall back to whatever
  // this day does carry so a stale selection never blanks the whole table.
  const availableBooks = splitBookGroups.filter((group) =>
    games.some((game) =>
      game.splits.some(
        (split) =>
          hasSplitPercent(split) && splitBookGroupFor(split.scope) === group,
      ),
    ),
  );
  const selectedBook =
    availableBooks.find(({ id }) => id === book) ?? availableBooks[0];
  const boards = games.map((game) => {
    const usableSplits = game.splits.filter(
      (split) =>
        hasSplitPercent(split) &&
        (!selectedBook || splitBookGroupFor(split.scope) === selectedBook),
    );
    const splitByMarketSelection = new Map<
      string,
      (typeof usableSplits)[number]
    >();
    for (const split of [...usableSplits].sort(
      (left, right) =>
        splitScopePriority(left.scope) - splitScopePriority(right.scope) ||
        Date.parse(right.providerTimestamp) -
          Date.parse(left.providerTimestamp) ||
        left.id.localeCompare(right.id),
    )) {
      const key = `${split.marketKey}:${split.selectionKey}`;
      if (!splitByMarketSelection.has(key))
        splitByMarketSelection.set(key, split);
    }
    const splits = [...splitByMarketSelection.values()];
    return {
      game,
      splits,
      // Naming the book only helps once the reader has a book to switch to.
      emptyLabel:
        selectedBook && availableBooks.length > 1
          ? `No ${selectedBook.label} data`
          : "No split data",
    };
  });
  const coveredGames = new Set(
    boards.filter(({ splits }) => splits.length > 0).map(({ game }) => game.id),
  ).size;
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

  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">PUBLIC BETTING · SHARPAPI CONSENSUS</p>
          <h1>Betting splits</h1>
          <p className="lede">
            See how betting tickets and money are distributed across each
            market.
          </p>
        </div>
        <span className="maturity beta">SharpAPI Consensus</span>
      </header>
      <aside className="split-signal-context" aria-label="How to use splits">
        <strong>Consensus is context—not a pick.</strong>
        <span>
          SharpAPI combines its public-betting data into one consensus view.
          Compare bet percentage with handle percentage to spot imbalances, then
          confirm the signal with line movement and price value.
        </span>
      </aside>
      <section
        className="game-filters splits-primary-filters"
        aria-label="Split filters"
      >
        <fieldset>
          <legend className="sr-only">Sport</legend>
          {(Object.keys(sportLabels) as GamesSport[]).map((key) => (
            <button
              key={key}
              type="button"
              className={sport === key ? "selected" : ""}
              onClick={() => {
                setState({ kind: "loading" });
                setSport(key);
              }}
            >
              {sportLabels[key]}
            </button>
          ))}
        </fieldset>
        <label>
          <span className="sr-only">Eastern calendar day</span>
          <input
            type="date"
            value={day}
            onChange={(event) => {
              setState({ kind: "loading" });
              setDay(event.currentTarget.value);
            }}
          />
        </label>
      </section>
      {availableBooks.length > 1 && (
        <section
          className="sportsbook-filters splits-scope-filters"
          aria-label="Sportsbook"
        >
          {availableBooks.map((group) => (
            <button
              key={group.id}
              type="button"
              className={selectedBook === group ? "selected" : ""}
              // The logo art names the provider's book, not this group, so the
              // group label is the authoritative accessible name.
              aria-label={group.label}
              aria-pressed={selectedBook === group}
              onClick={() => setBook(group.id)}
            >
              <SportsbookLogo scope={group.logoScope} />
            </button>
          ))}
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
              <dt>Source</dt>
              <dd>
                {selectedBook ? selectedBook.label : "SharpAPI consensus"}
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
      {state.kind === "ready" && state.refreshFailed && (
        <p className="splits-refresh-warning" role="status">
          <strong>Refresh delayed.</strong> Showing the last valid board while
          we retry.
        </p>
      )}
      {state.kind === "ready" && games.length > 0 && coveredGames === 0 && (
        <p className="splits-no-data-notice" role="status">
          No split percentages are available from{" "}
          {selectedBook ? selectedBook.label : "SharpAPI consensus"}. The
          complete schedule remains below.
        </p>
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
          <>
            <div
              className="split-reading-guide"
              role="note"
              aria-label="How to read split bars"
            >
              <div>
                <strong>How to read this</strong>
                <span>
                  Fill is handle (money). The white notch is bets (tickets). The
                  gap shows which one is leading.
                </span>
              </div>
              <div className="split-bar-legend">
                <span>
                  <i className="split-legend-handle" aria-hidden="true" />
                  Handle % fill
                </span>
                <span>
                  <i className="split-legend-bets" aria-hidden="true" />
                  Bets % notch
                </span>
                <span>
                  <i className="split-legend-money" aria-hidden="true" />+
                  Money-heavy
                </span>
                <span>
                  <i className="split-legend-ticket" aria-hidden="true" />−
                  Ticket-heavy
                </span>
              </div>
            </div>
            <div
              className="market-scroll splits-scroll"
              tabIndex={0}
              role="region"
              aria-label="Betting splits comparison table; scroll horizontally for all markets"
            >
              <table className="split-board">
                <caption className="sr-only">
                  Betting splits by game and team. Handle means money
                  percentage; bets means ticket percentage. Each market shows
                  its line and a split bar comparing handle with bets.
                </caption>
                <colgroup>
                  <col className="split-team-col" />
                  {(["spread", "total", "moneyline"] as const).flatMap(
                    (market) => [
                      <col key={`${market}-line`} className="split-line-col" />,
                      <col key={`${market}-bar`} className="split-bar-col" />,
                    ],
                  )}
                </colgroup>
                <thead>
                  <tr>
                    <th className="split-team-heading" rowSpan={2} scope="col">
                      Game / team
                    </th>
                    {(["Spread", "Total", "Moneyline"] as const).map(
                      (market) => (
                        <th key={market} colSpan={2} scope="colgroup">
                          {market}
                        </th>
                      ),
                    )}
                  </tr>
                  <tr>
                    {(["Spread", "Total", "Moneyline"] as const).flatMap(
                      (market) =>
                        (["Line", "Handle vs bets"] as const).map((metric) => (
                          <th key={`${market}-${metric}`} scope="col">
                            {metric}
                          </th>
                        )),
                    )}
                  </tr>
                </thead>
                {boards.map(({ game, splits, emptyLabel }) => {
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
                    ...(hasDraw
                      ? [{ key: "draw" as const, label: "Draw" }]
                      : []),
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
                              <span className="split-team-name">
                                {row.label}
                              </span>
                              {rowIndex === 0 && splits.length === 0 && (
                                <span className="split-scope split-no-data">
                                  {emptyLabel}
                                </span>
                              )}
                              {rowIndex === 0 && splits.length > 0 && (
                                <span className="split-scope">
                                  {selectedBook
                                    ? selectedBook.label
                                    : "SharpAPI consensus"}
                                </span>
                              )}
                            </th>
                            {cells.flatMap((split, marketIndex) => {
                              const market = ["Spread", "Total", "Moneyline"][
                                marketIndex
                              ]!;
                              const americanOdds = splitAmericanOdds(split);
                              return [
                                <td
                                  key={`${marketIndex}-line`}
                                  className="split-line"
                                >
                                  {!split
                                    ? "—"
                                    : marketIndex === 2
                                      ? americanOdds === undefined
                                        ? "No line"
                                        : oddsPrice(americanOdds)
                                      : split.point === undefined
                                        ? "—"
                                        : marketIndex === 1
                                          ? `${row.key === "away" ? "O" : "U"} ${String(split.point)}`
                                          : linePoint(split.point)}
                                </td>,
                                <td
                                  key={`${marketIndex}-split`}
                                  className="split-bar-cell"
                                >
                                  <SplitBar
                                    moneyPercent={split?.moneyPercent}
                                    betPercent={split?.betPercent}
                                    market={market}
                                    selection={row.label}
                                  />
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
          </>
        )}
      </section>
    </>
  );
}

type MovementMetric = "line" | "american" | "probability";
type MovementWindow = "all" | "6h" | "24h" | "7d";

const historyPointState = (point: OddsHistorySeriesDto["points"][number]) =>
  point.state ?? "active";

const historyImpliedProbability = (
  point: OddsHistorySeriesDto["points"][number],
) => point.impliedProbability ?? impliedProbability(point.americanOdds);

const movementValue = (
  series: OddsHistorySeriesDto,
  point: OddsHistorySeriesDto["points"][number],
  metric: MovementMetric,
) =>
  metric === "line" && series.marketKey !== "moneyline"
    ? point.point
    : metric === "american"
      ? point.americanOdds
      : historyImpliedProbability(point) * 100;

const seriesColor = (sportsbookId: string) => {
  let hash = 0;
  for (const character of sportsbookId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 78% 64%)`;
};

const seriesDash = (sportsbookId: string) => {
  let hash = 0;
  for (const character of sportsbookId)
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return ["none", "12 5", "4 4", "14 4 3 4", "2 4", "9 3 2 3"][hash % 6]!;
};

const metricLabel = (metric: MovementMetric) =>
  metric === "line"
    ? "Line"
    : metric === "american"
      ? "American odds"
      : "Implied probability";

const formatMovementValue = (metric: MovementMetric, value: number) =>
  metric === "probability"
    ? `${value.toFixed(2)}%`
    : metric === "american"
      ? oddsPrice(value)
      : linePoint(value);

const markerLabel = (point: OddsHistorySeriesDto["points"][number]) =>
  point.isOpening && point.isCurrent
    ? "Opening and current"
    : point.isOpening
      ? "Opening"
      : point.isCurrent
        ? "Current"
        : "Observation";

const normalizeHistoryMarkers = (
  series: OddsHistorySeriesDto,
): OddsHistorySeriesDto => {
  const activeIndexes = series.points.flatMap((point, index) =>
    historyPointState(point) === "active" ? [index] : [],
  );
  const openingIndex = activeIndexes[0];
  const currentIndex = activeIndexes.at(-1);
  return {
    ...series,
    points: series.points.map((point, index) => ({
      ...point,
      isOpening: index === openingIndex,
      isCurrent: index === currentIndex,
    })),
  };
};

const MAX_CHART_OBSERVATIONS = 2_400;
const sampledHistoryPoints = (
  points: OddsHistorySeriesDto["points"],
  limit: number,
) => {
  if (points.length <= limit) return points;
  const required = new Set<number>([0, points.length - 1]);
  for (let index = 0; index < points.length; index += 1)
    if (
      historyPointState(points[index]!) !== "active" &&
      (index === 0 || historyPointState(points[index - 1]!) === "active")
    )
      required.add(index);
  if (required.size > limit) {
    return [...required]
      .sort((left, right) => left - right)
      .map((index) => points[index]!);
  }
  const remaining = Math.max(0, limit - required.size);
  if (remaining > 0) {
    const candidates = Array.from(
      { length: points.length },
      (_, index) => index,
    ).filter((index) => !required.has(index));
    for (let index = 0; index < remaining; index += 1)
      required.add(
        candidates[
          Math.min(
            candidates.length - 1,
            Math.floor((index / remaining) * candidates.length),
          )
        ]!,
      );
  }
  return [...required]
    .sort((left, right) => left - right)
    .slice(0, limit)
    .map((index) => points[index]!);
};

const movementDelta = (
  series: OddsHistorySeriesDto,
  metric: MovementMetric,
) => {
  const values = series.points
    .filter((point) => historyPointState(point) === "active")
    .map((point) => movementValue(series, point, metric))
    .filter((value): value is number => value !== undefined);
  return values.length > 1 ? values.at(-1)! - values[0]! : null;
};

const observationAccessibleLabel = (
  series: OddsHistorySeriesDto,
  point: OddsHistorySeriesDto["points"][number],
  metric: MovementMetric,
) => {
  const value = movementValue(series, point, metric);
  return `${series.sportsbookLabel} ${markerLabel(point).toLowerCase()}: ${value === undefined ? "value unavailable" : formatMovementValue(metric, value)}; American odds ${oddsPrice(point.americanOdds)}; state ${historyPointState(point)}; provider ${new Date(point.observedAt).toLocaleString()}; collected ${new Date(point.retrievedAt).toLocaleString()}`;
};

interface FocusedHistoryObservation {
  readonly series: OddsHistorySeriesDto;
  readonly point: OddsHistorySeriesDto["points"][number];
  readonly metric: MovementMetric;
}

function LineMovementChart({
  series,
  metric,
  onObservationFocus,
}: {
  readonly series: readonly OddsHistorySeriesDto[];
  readonly metric: MovementMetric;
  readonly onObservationFocus: (value: FocusedHistoryObservation) => void;
}) {
  const width = 960;
  const height = 320;
  const inset = { top: 20, right: 24, bottom: 42, left: 62 };
  const renderSeries = series.filter((item) => item.points.length > 0);
  const samples = renderSeries.flatMap((item) =>
    item.points.flatMap((point) => {
      const value = movementValue(item, point, metric);
      return value === undefined
        ? []
        : [{ at: Date.parse(point.observedAt), value }];
    }),
  );
  if (!samples.length)
    return (
      <div className="movement-empty" role="status">
        No plotted values are available for this selection and time window.
      </div>
    );
  const bounds = samples.reduce(
    (current, sample) => ({
      minTime: Math.min(current.minTime, sample.at),
      maxTime: Math.max(current.maxTime, sample.at),
      minValue: Math.min(current.minValue, sample.value),
      maxValue: Math.max(current.maxValue, sample.value),
    }),
    {
      minTime: Number.POSITIVE_INFINITY,
      maxTime: Number.NEGATIVE_INFINITY,
      minValue: Number.POSITIVE_INFINITY,
      maxValue: Number.NEGATIVE_INFINITY,
    },
  );
  const { minTime, maxTime } = bounds;
  let { minValue, maxValue } = bounds;
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  const x = (at: number) =>
    inset.left +
    ((at - minTime) / Math.max(1, maxTime - minTime)) *
      (width - inset.left - inset.right);
  const y = (value: number) =>
    inset.top +
    ((maxValue - value) / (maxValue - minValue)) *
      (height - inset.top - inset.bottom);
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return maxValue - ratio * (maxValue - minValue);
  });
  return (
    <div
      className="movement-chart-scroll"
      role="region"
      tabIndex={0}
      aria-label="Scrollable movement chart"
    >
      <svg
        className="movement-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={`${metricLabel(metric)} movement across ${renderSeries.length} sportsbook${renderSeries.length === 1 ? "" : "s"}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={inset.left}
              x2={width - inset.right}
              y1={y(tick)}
              y2={y(tick)}
              className="movement-grid-line"
            />
            <text
              x={inset.left - 10}
              y={y(tick) + 4}
              textAnchor="end"
              className="movement-axis-label"
            >
              {metric === "probability"
                ? `${tick.toFixed(1)}%`
                : metric === "american"
                  ? oddsPrice(Math.round(tick))
                  : Number.isInteger(tick)
                    ? tick
                    : tick.toFixed(1)}
            </text>
          </g>
        ))}
        <text x={inset.left} y={height - 12} className="movement-axis-label">
          {new Date(minTime).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </text>
        <text
          x={width - inset.right}
          y={height - 12}
          textAnchor="end"
          className="movement-axis-label"
        >
          {new Date(maxTime).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </text>
        {renderSeries.map((item) => {
          const segments: {
            x: number;
            y: number;
            point: OddsHistorySeriesDto["points"][number];
          }[][] = [];
          let segment: (typeof segments)[number] = [];
          for (const point of item.points) {
            const value = movementValue(item, point, metric);
            if (value === undefined || historyPointState(point) !== "active") {
              if (segment.length) segments.push(segment);
              segment = [];
            } else
              segment.push({
                x: x(Date.parse(point.observedAt)),
                y: y(value),
                point,
              });
          }
          if (segment.length) segments.push(segment);
          const observations = item.points.map((point) => {
            const value = movementValue(item, point, metric);
            return {
              point,
              x: x(Date.parse(point.observedAt)),
              y: value === undefined ? height - inset.bottom : y(value),
              value,
            };
          });
          const activeCoordinates = segments.flat();
          const color = seriesColor(item.sportsbookId);
          const dash = seriesDash(item.sportsbookId);
          const lastActive = activeCoordinates.at(-1);
          return (
            <g key={item.sportsbookId}>
              {segments
                .filter((coordinates) => coordinates.length > 1)
                .map((coordinates, segmentIndex) => (
                  <path
                    key={segmentIndex}
                    data-series={item.sportsbookId}
                    data-interpolation="step-after"
                    d={coordinates.reduce(
                      (path, coordinate, index) =>
                        index === 0
                          ? `M ${coordinate.x} ${coordinate.y}`
                          : `${path} H ${coordinate.x} V ${coordinate.y}`,
                      "",
                    )}
                    fill="none"
                    stroke={color}
                    strokeDasharray={dash}
                    strokeWidth="3"
                    strokeLinejoin="miter"
                    strokeLinecap="square"
                  />
                ))}
              {lastActive && (
                <text
                  x={Math.min(lastActive.x + 7, width - inset.right - 70)}
                  y={lastActive.y - 8}
                  className="movement-series-label"
                  fill={color}
                >
                  {item.sportsbookLabel}
                </text>
              )}
              {observations.map(
                ({ x: xPoint, y: yPoint, point, value }, index) => {
                  const state = historyPointState(point);
                  const label = observationAccessibleLabel(item, point, metric);
                  const marker = (
                    <circle
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      cx={xPoint}
                      cy={yPoint}
                      r={point.isOpening || point.isCurrent ? 6 : 4}
                      fill={state === "active" ? color : "#09080d"}
                      stroke={color}
                      strokeWidth={state === "active" ? 2 : 3}
                      onFocus={() =>
                        onObservationFocus({ series: item, point, metric })
                      }
                      onMouseEnter={() =>
                        onObservationFocus({ series: item, point, metric })
                      }
                    >
                      <title>{label}</title>
                    </circle>
                  );
                  return (
                    <g
                      key={
                        point.observationId ??
                        `${point.observedAt}-${point.retrievedAt}-${index}`
                      }
                      {...(state === "active"
                        ? {}
                        : { "data-gap-state": state })}
                    >
                      {marker}
                      {state !== "active" && (
                        <>
                          <line
                            x1={xPoint - 4}
                            x2={xPoint + 4}
                            y1={yPoint - 4}
                            y2={yPoint + 4}
                            className="movement-gap-cross"
                          />
                          <line
                            x1={xPoint - 4}
                            x2={xPoint + 4}
                            y1={yPoint + 4}
                            y2={yPoint - 4}
                            className="movement-gap-cross"
                          />
                        </>
                      )}
                      {(point.isOpening || point.isCurrent) &&
                        value !== undefined && (
                          <text
                            x={xPoint}
                            y={yPoint + (point.isOpening ? 18 : -11)}
                            textAnchor="middle"
                            className="movement-marker-label"
                          >
                            {point.isOpening && point.isCurrent
                              ? "Open / Current"
                              : point.isOpening
                                ? "Open"
                                : "Current"}
                          </text>
                        )}
                    </g>
                  );
                },
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MovementHistoryTable({
  series,
  metric,
}: {
  readonly series: readonly OddsHistorySeriesDto[];
  readonly metric: MovementMetric;
}) {
  const [open, setOpen] = useState(false);
  const rows = series
    .flatMap((item) => item.points.map((point) => ({ item, point })))
    .sort(
      (left, right) =>
        left.point.observedAt.localeCompare(right.point.observedAt) ||
        left.item.sportsbookId.localeCompare(right.item.sportsbookId),
    );
  return (
    <details className="movement-table-details" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        Accessible history table
      </summary>
      {open && (
        <div className="movement-table-scroll">
          <table aria-label="Plotted line history">
            <caption>
              Values plotted for the selected market, selection, sportsbooks,
              view, and loaded time window.
            </caption>
            <thead>
              <tr>
                <th>Sportsbook</th>
                <th>Observation</th>
                <th>State</th>
                <th>Marker</th>
                <th>{metricLabel(metric)}</th>
                <th>Line</th>
                <th>American odds</th>
                <th>Implied probability</th>
                <th>Provider time</th>
                <th>Collected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, point }, index) => {
                const value = movementValue(item, point, metric);
                return (
                  <tr
                    key={
                      point.observationId ??
                      `${item.sportsbookId}-${point.observedAt}-${point.retrievedAt}-${index}`
                    }
                  >
                    <th scope="row">{item.sportsbookLabel}</th>
                    <td>{point.observationId ?? "Legacy observation"}</td>
                    <td>
                      {historyPointState(point).replace(/^./, (letter) =>
                        letter.toUpperCase(),
                      )}
                    </td>
                    <td>{markerLabel(point)}</td>
                    <td>
                      {value === undefined
                        ? "Unavailable"
                        : formatMovementValue(metric, value)}
                    </td>
                    <td>
                      {point.point === undefined ? "—" : linePoint(point.point)}
                    </td>
                    <td>{oddsPrice(point.americanOdds)}</td>
                    <td>
                      {(historyImpliedProbability(point) * 100).toFixed(2)}%
                    </td>
                    <td>
                      <time dateTime={point.observedAt}>
                        {new Date(point.observedAt).toLocaleString()}
                      </time>
                    </td>
                    <td>
                      <time dateTime={point.retrievedAt}>
                        {new Date(point.retrievedAt).toLocaleString()}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function DecisionWorkbench({
  game,
  client,
}: {
  readonly game: import("@find-the-edge/domain").GameOddsComparisonDto;
  readonly client: UiGamesClient;
}) {
  type Split = NonNullable<
    Awaited<ReturnType<NonNullable<UiGamesClient["listSplits"]>>>
  >["items"][number]["splits"][number];
  const [historyState, setHistoryState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly value: OddsHistoryDto }
    | { readonly kind: "unavailable" }
  >({ kind: "loading" });
  const [splits, setSplits] = useState<readonly Split[]>([]);
  const [marketKey, setMarketKey] = useState("moneyline");
  const [selectionKey, setSelectionKey] = useState("");
  const [metric, setMetric] = useState<MovementMetric>("probability");
  const [hiddenBooks, setHiddenBooks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [timeWindow, setTimeWindow] = useState<MovementWindow>("all");
  const [focusedObservation, setFocusedObservation] =
    useState<FocusedHistoryObservation | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      if (!client.oddsHistory) setHistoryState({ kind: "unavailable" });
      else
        client
          .oddsHistory(game.id, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted)
              setHistoryState({ kind: "ready", value });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setHistoryState({ kind: "unavailable" });
          });
      if (client.listSplits)
        client
          .listSplits(
            {
              sport: game.sportKey === "mlb" ? "mlb" : "soccer",
              day: game.eastern.calendarDay,
            },
            controller.signal,
          )
          .then((page) => {
            if (!controller.signal.aborted)
              setSplits(
                page.items.find(({ id }) => id === game.id)?.splits ?? [],
              );
          })
          .catch(() => undefined);
    };
    load();
    return () => controller.abort();
  }, [client, game.eastern.calendarDay, game.id, game.sportKey]);

  const history = historyState.kind === "ready" ? historyState.value : null;
  const marketSeries =
    history?.series
      .filter((item) => item.marketKey === marketKey)
      .map(normalizeHistoryMarkers) ?? [];
  const selectionsByKey = new Map<
    string,
    {
      readonly key: string;
      readonly label: string;
      readonly observedAt: string;
    }
  >();
  for (const item of marketSeries) {
    const observedAt = item.points.at(-1)?.observedAt ?? "";
    const current = selectionsByKey.get(item.selectionKey);
    if (!current || observedAt >= current.observedAt)
      selectionsByKey.set(item.selectionKey, {
        key: item.selectionKey,
        label: item.selectionLabel,
        observedAt,
      });
  }
  const selections = [...selectionsByKey.values()];
  const activeSelection = selections.some(({ key }) => key === selectionKey)
    ? selectionKey
    : (selections[0]?.key ?? "");
  const selectedSeries = marketSeries.filter(
    (item) => item.selectionKey === activeSelection,
  );
  const effectiveMetric: MovementMetric =
    marketKey === "moneyline"
      ? metric === "american"
        ? "american"
        : "probability"
      : metric === "american"
        ? "american"
        : "line";
  const seriesBooks = new Map(
    selectedSeries.map((item) => [
      item.sportsbookId,
      { id: item.sportsbookId, label: item.sportsbookLabel },
    ]),
  );
  const bookOptions = [
    ...new Map([
      ...(history?.coverage ?? []).map(
        (book) =>
          [
            book.sportsbookId,
            {
              id: book.sportsbookId,
              label: book.sportsbookLabel,
              status:
                book.status === "available" &&
                seriesBooks.has(book.sportsbookId)
                  ? ("available" as const)
                  : ("unavailable" as const),
            },
          ] as const,
      ),
      ...[...seriesBooks.values()].map(
        (book) => [book.id, { ...book, status: "available" as const }] as const,
      ),
    ]).values(),
  ].sort((left, right) => left.label.localeCompare(right.label));
  const allAvailableBooksEnabled = bookOptions
    .filter(({ status }) => status === "available")
    .every(({ id }) => !hiddenBooks.has(id));
  const latestLoadedTime = selectedSeries.reduce(
    (latest, item) =>
      item.points.reduce(
        (seriesLatest, point) =>
          Math.max(seriesLatest, Date.parse(point.observedAt)),
        latest,
      ),
    0,
  );
  const windowDuration =
    timeWindow === "6h"
      ? 6 * 60 * 60 * 1_000
      : timeWindow === "24h"
        ? 24 * 60 * 60 * 1_000
        : timeWindow === "7d"
          ? 7 * 24 * 60 * 60 * 1_000
          : null;
  const windowStart =
    windowDuration === null ? null : latestLoadedTime - windowDuration;
  const plottedSeries = selectedSeries
    .filter(({ sportsbookId }) => !hiddenBooks.has(sportsbookId))
    .map((item) =>
      normalizeHistoryMarkers({
        ...item,
        points: item.points.filter(
          (point) =>
            windowStart === null || Date.parse(point.observedAt) >= windowStart,
        ),
      }),
    )
    .filter((item) => item.points.length > 0);
  const chartObservationLimit = Math.max(
    50,
    Math.floor(MAX_CHART_OBSERVATIONS / Math.max(1, plottedSeries.length)),
  );
  const chartSeries = plottedSeries.map((item) => ({
    ...item,
    points: sampledHistoryPoints(item.points, chartObservationLimit),
  }));
  const plottedObservationCount = plottedSeries.reduce(
    (count, item) => count + item.points.length,
    0,
  );
  const chartObservationCount = chartSeries.reduce(
    (count, item) => count + item.points.length,
    0,
  );
  const marketReferenceSeries = plottedSeries.filter(
    ({ sportsbookId }) => sportsbookId === "pinnacle",
  );
  const publicSeries = plottedSeries.filter(
    ({ sportsbookId }) => sportsbookId === "draftkings",
  );
  const averageDelta = (items: readonly OddsHistorySeriesDto[]) => {
    const values = items
      .map((item) => movementDelta(item, "probability"))
      .filter((value): value is number => value !== null);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  };
  const selectedSplits = splits.filter(
    (split) =>
      split.marketKey === marketKey && split.selectionKey === activeSelection,
  );
  return (
    <section className="decision-workbench" aria-labelledby="movement-title">
      <div className="decision-heading">
        <div>
          <p className="eyebrow">DECISION WORKBENCH</p>
          <h2 id="movement-title">Line movement &amp; public money</h2>
          <p>
            Compare immutable first-to-latest movement in the loaded retained
            history across every observed book, then contrast Pinnacle line
            movement with DraftKings and Circa betting splits.
          </p>
        </div>
        <span className="provider-chip">SharpAPI evidence</span>
      </div>
      <div className="movement-controls">
        <div role="group" aria-label="Movement market" className="market-tabs">
          {["moneyline", "spread", "total"].map((candidate) => (
            <button
              key={candidate}
              aria-pressed={marketKey === candidate}
              onClick={() => {
                setMarketKey(candidate);
                setSelectionKey("");
                setMetric(candidate === "moneyline" ? "probability" : "line");
                setFocusedObservation(null);
              }}
            >
              {candidate === "moneyline"
                ? "Moneyline"
                : candidate[0]!.toUpperCase() + candidate.slice(1)}
            </button>
          ))}
        </div>
        <label>
          Selection
          <select
            value={activeSelection}
            onChange={(event) => {
              setSelectionKey(event.target.value);
              setFocusedObservation(null);
            }}
          >
            {selections.map((selection) => (
              <option key={selection.key} value={selection.key}>
                {selection.label}
              </option>
            ))}
          </select>
        </label>
        <div className="metric-toggle" role="group" aria-label="Chart view">
          {marketKey !== "moneyline" && (
            <button
              className={metric === "line" ? "active" : ""}
              aria-pressed={metric === "line"}
              onClick={() => setMetric("line")}
            >
              Line
            </button>
          )}
          {marketKey === "moneyline" && (
            <button
              className={metric === "probability" ? "active" : ""}
              aria-pressed={metric === "probability"}
              onClick={() => setMetric("probability")}
            >
              Implied probability
            </button>
          )}
          <button
            className={metric === "american" ? "active" : ""}
            aria-pressed={metric === "american"}
            onClick={() => setMetric("american")}
          >
            {marketKey === "moneyline" ? "American odds" : "Associated price"}
          </button>
        </div>
        <div
          className="time-window-toggle"
          role="group"
          aria-label="History time window"
        >
          {(
            [
              ["all", "All loaded"],
              ["6h", "Last 6 hours"],
              ["24h", "Last 24 hours"],
              ["7d", "Last 7 days"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={timeWindow === value}
              onClick={() => {
                setTimeWindow(value);
                setFocusedObservation(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {historyState.kind === "loading" ? (
        <p role="status">Loading immutable line history…</p>
      ) : historyState.kind === "unavailable" ? (
        <p role="status">Line movement is temporarily unavailable.</p>
      ) : (
        <>
          {historyState.value.nextCursor !== null && (
            <p className="movement-history-notice" role="status">
              Showing a bounded portion of retained history. More observations
              exist; movement below uses only the loaded evidence.
            </p>
          )}
          <p className="movement-history-notice" role="status">
            {timeWindow === "all"
              ? "Showing the API's loaded request window (up to 31 days). Earlier retained evidence, if any, is outside this request."
              : selectedSeries.some((item) =>
                    item.points.some(
                      (point) =>
                        windowStart !== null &&
                        Date.parse(point.observedAt) < windowStart,
                    ),
                  )
                ? `Showing ${timeWindow} of loaded evidence; earlier loaded observations are hidden.`
                : `Showing ${timeWindow}; no earlier observations exist in the loaded request.`}
          </p>
          <section
            className="sportsbook-filters movement-book-filters"
            aria-label="Sportsbook line filters"
          >
            <button
              type="button"
              className={allAvailableBooksEnabled ? "selected" : ""}
              aria-pressed={allAvailableBooksEnabled}
              aria-label="Show all sportsbook lines"
              onClick={() => setHiddenBooks(new Set())}
            >
              <span className="all-books-mark" aria-hidden="true">
                ALL
              </span>
              <span>All books</span>
            </button>
            {bookOptions.map((book) => {
              if (book.status === "unavailable")
                return (
                  <button
                    key={book.id}
                    type="button"
                    className="unavailable"
                    aria-label={`${book.label}: No history`}
                    disabled
                    title={`${book.label}: No history for this loaded request`}
                  >
                    <SportsbookLogo scope={book.id} />
                    <span>No history</span>
                  </button>
                );
              const enabled = !hiddenBooks.has(book.id);
              return (
                <button
                  key={book.id}
                  type="button"
                  className={enabled ? "selected" : ""}
                  aria-pressed={enabled}
                  aria-label={`${enabled ? "Hide" : "Show"} ${book.label} line`}
                  title={book.label}
                  onClick={() => {
                    setHiddenBooks((current) => {
                      const next = new Set(current);
                      if (next.has(book.id)) next.delete(book.id);
                      else next.add(book.id);
                      return next;
                    });
                    setFocusedObservation(null);
                  }}
                >
                  <SportsbookLogo scope={book.id} />
                </button>
              );
            })}
          </section>
          {chartSeries.length ? (
            <LineMovementChart
              series={chartSeries}
              metric={effectiveMetric}
              onObservationFocus={setFocusedObservation}
            />
          ) : (
            <div className="movement-empty" role="status">
              No sportsbook lines are enabled with observations in this time
              window.
            </div>
          )}
          {chartObservationCount < plottedObservationCount && (
            <p className="movement-history-notice" role="status">
              Chart density is bounded to{" "}
              {chartObservationCount.toLocaleString()} exact observations for
              responsiveness. The accessible table retains all{" "}
              {plottedObservationCount.toLocaleString()} loaded observations.
            </p>
          )}
          <div
            className="movement-observation-detail"
            aria-label="Focused observation details"
            aria-live="polite"
          >
            {focusedObservation ? (
              <>
                <strong>
                  {focusedObservation.series.sportsbookLabel} ·{" "}
                  {markerLabel(focusedObservation.point)}
                </strong>
                <span>
                  {historyPointState(focusedObservation.point)} · Line{" "}
                  {focusedObservation.point.point === undefined
                    ? "—"
                    : linePoint(focusedObservation.point.point)}{" "}
                  · {oddsPrice(focusedObservation.point.americanOdds)} ·{" "}
                  {(
                    historyImpliedProbability(focusedObservation.point) * 100
                  ).toFixed(2)}
                  % implied
                </span>
                <span>
                  Provider{" "}
                  <time dateTime={focusedObservation.point.observedAt}>
                    {new Date(
                      focusedObservation.point.observedAt,
                    ).toLocaleString()}
                  </time>{" "}
                  · Collected{" "}
                  <time dateTime={focusedObservation.point.retrievedAt}>
                    {new Date(
                      focusedObservation.point.retrievedAt,
                    ).toLocaleString()}
                  </time>
                </span>
              </>
            ) : (
              <span>
                Focus or hover an observation marker for exact provider and
                collection details.
              </span>
            )}
          </div>
          <div
            className="movement-legend"
            aria-label="Sportsbook movement legend"
          >
            {plottedSeries.map((item) => {
              const delta = movementDelta(item, effectiveMetric);
              const active = item.points.filter(
                (point) =>
                  historyPointState(point) === "active" &&
                  movementValue(item, point, effectiveMetric) !== undefined,
              );
              const opening = active[0];
              const current = active.at(-1);
              const latestObservation = item.points.at(-1);
              const valueLabel = (
                point: OddsHistorySeriesDto["points"][number],
              ) =>
                effectiveMetric === "line"
                  ? linePoint(point.point!)
                  : effectiveMetric === "american"
                    ? oddsPrice(point.americanOdds)
                    : `${(historyImpliedProbability(point) * 100).toFixed(2)}%`;
              return (
                <article key={item.sportsbookId}>
                  <svg className="series-swatch" aria-hidden="true">
                    <line
                      x1="1"
                      x2="31"
                      y1="8"
                      y2="8"
                      stroke={seriesColor(item.sportsbookId)}
                      strokeDasharray={seriesDash(item.sportsbookId)}
                      strokeWidth="3"
                    />
                  </svg>
                  <SportsbookLogo scope={item.sportsbookId} />
                  <strong>{item.sportsbookLabel}</strong>
                  <span>
                    {opening && current
                      ? `Open ${valueLabel(opening)} → Current ${valueLabel(current)}`
                      : "No active observations"}
                  </span>
                  <small>
                    {latestObservation &&
                    historyPointState(latestObservation) !== "active"
                      ? `Currently ${historyPointState(latestObservation)}`
                      : delta === null
                        ? "1 active observation"
                        : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} ${effectiveMetric === "probability" ? "probability points" : effectiveMetric === "american" ? "odds points" : "line move"}`}
                  </small>
                </article>
              );
            })}
          </div>
          <MovementHistoryTable
            series={plottedSeries}
            metric={effectiveMetric}
          />
        </>
      )}
      <div className="signal-grid">
        <article>
          <span>Market-making reference</span>
          <strong>
            {averageDelta(marketReferenceSeries) === null
              ? "Not enough history"
              : `${averageDelta(marketReferenceSeries)! > 0 ? "+" : ""}${averageDelta(marketReferenceSeries)!.toFixed(1)} pp`}
          </strong>
          <small>Pinnacle first-to-latest loaded probability move</small>
        </article>
        <article>
          <span>Public reference</span>
          <strong>
            {averageDelta(publicSeries) === null
              ? "Not enough history"
              : `${averageDelta(publicSeries)! > 0 ? "+" : ""}${averageDelta(publicSeries)!.toFixed(1)} pp`}
          </strong>
          <small>DraftKings first-to-latest loaded probability move</small>
        </article>
        {selectedSplits.length ? (
          selectedSplits.map((split) => (
            <article key={split.id}>
              <span>
                {sportsbookMetadata(split.scope ?? "consensus").name} splits
              </span>
              <strong>
                {split.betPercent === undefined ? "—" : `${split.betPercent}%`}{" "}
                bets ·{" "}
                {split.moneyPercent === undefined
                  ? "—"
                  : `${split.moneyPercent}%`}{" "}
                money
              </strong>
              <small>
                {split.betPercent !== undefined &&
                split.moneyPercent !== undefined
                  ? `${Math.abs(split.moneyPercent - split.betPercent)} point handle/ticket gap`
                  : "Partial split evidence"}
              </small>
            </article>
          ))
        ) : (
          <article>
            <span>Public splits</span>
            <strong>No current evidence</strong>
            <small>DraftKings/Circa only; never fabricated</small>
          </article>
        )}
      </div>
      <p className="decision-caution">
        Splits and movement are evidence, not a recommendation. Confirm price,
        limits, availability, and model edge before acting.
      </p>
    </section>
  );
}

function GameDetail() {
  const client = useContext(GamesClientContext);
  const { gameId } = useParams({ from: "/games/$gameId" });
  const detailSearch = useSearch({ from: "/games/$gameId" });
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | {
        readonly kind: "ready";
        readonly game: import("@find-the-edge/domain").GameOddsComparisonDto;
      }
    | { readonly kind: "not-found"; readonly message: string }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [activeMarket, setActiveMarket] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const detailClient = client.ok && client.value.detail ? client.value : null;
    if (!detailClient) {
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: "Game details are unavailable." });
        setActiveMarket("");
      });
      return () => controller.abort();
    }
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setState({ kind: "loading" });
      setActiveMarket("");
    });
    const load = async () => {
      try {
        const game = await detailClient.detail!(gameId, controller.signal);
        if (!controller.signal.aborted)
          setState(
            game
              ? { kind: "ready", game }
              : { kind: "error", message: "This game was not found." },
          );
      } catch (error) {
        if (!controller.signal.aborted)
          setState(
            error instanceof GamesClientError && error.code === "not-found"
              ? { kind: "not-found", message: "This game was not found." }
              : {
                  kind: "error",
                  message: "Game details are temporarily unavailable.",
                },
          );
      }
    };
    void load();
    return () => controller.abort();
  }, [client, detailSearch, gameId, reload]);

  if (state.kind === "loading") return <p>Loading game details…</p>;
  if (state.kind === "not-found") return <p role="status">{state.message}</p>;
  if (state.kind === "error")
    return (
      <div role="alert">
        <p>{state.message}</p>
        <button
          type="button"
          onClick={() => {
            setState({ kind: "loading" });
            setReload((value) => value + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  if (!detailMatchesRoute(state.game.id, gameId))
    return <p>Loading game details…</p>;
  if (!client.ok)
    return <p role="alert">Game details are temporarily unavailable.</p>;
  const game = state.game;
  const comparison = buildOddsComparisonViewModel(game);
  const targetBook = comparison.books.find(({ target }) => target)!;
  const market =
    comparison.markets.find(({ key }) => key === activeMarket) ??
    comparison.markets[0];
  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">GAME DETAIL · SHARPAPI</p>
          <h1>{game.participants.map(({ label }) => label).join(" vs ")}</h1>
          <p className="lede">{easternDisplay(game.startsAt)} Eastern</p>
          <EventMetadataBadges game={game} />
        </div>
        <div className="event-detail-actions">
          <ScoutEventButton
            eventId={game.id}
            eligible={game.status === "scheduled"}
            disabledReason={`Scouting is available only for scheduled events. This event is ${game.status}.`}
            client={client}
          />
          <Link className="detail-link" to="/games" search={detailSearch}>
            Back to games
          </Link>
        </div>
      </header>
      <section
        className="odds-comparison"
        aria-labelledby="odds-comparison-title"
      >
        <div className="odds-comparison-heading">
          <div>
            <h2 id="odds-comparison-title">Sportsbook comparison</h2>
            <p>
              {comparison.targetQualified
                ? `${targetBook.label} prices are currently eligible.`
                : `${targetBook.label} coverage is incomplete — comparison is not qualified.`}
            </p>
          </div>
          <span
            className={
              comparison.targetQualified
                ? "qualification qualified"
                : "qualification blocked"
            }
          >
            {comparison.targetQualified
              ? "Target qualified"
              : "Target unavailable"}
          </span>
        </div>
        <div role="tablist" aria-label="Odds markets" className="market-tabs">
          {comparison.markets.map((item, index) => (
            <button
              key={item.key}
              id={`market-tab-${item.key}`}
              role="tab"
              aria-controls={`market-panel-${item.key}`}
              aria-selected={item.key === market?.key}
              tabIndex={item.key === market?.key ? 0 : -1}
              onClick={() => setActiveMarket(item.key)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? comparison.markets.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          comparison.markets.length) %
                        comparison.markets.length;
                const next = comparison.markets[nextIndex];
                if (!next) return;
                setActiveMarket(next.key);
                const buttons =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                buttons?.[nextIndex]?.focus();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {market ? (
          <div
            className="comparison-scroll"
            role="tabpanel"
            id={`market-panel-${market.key}`}
            aria-labelledby={`market-tab-${market.key}`}
            tabIndex={0}
          >
            <table className="comparison-board">
              <thead>
                <tr>
                  <th>Selection</th>
                  {comparison.books.map((book) => (
                    <th
                      key={book.id}
                      className={book.target ? "target-book" : ""}
                    >
                      <SportsbookLogo scope={book.id} />
                      <span>{book.label}</span>
                      {book.target && <small>Target book</small>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {market.selections.map((selection) => (
                  <tr key={selection.key}>
                    <th scope="row">{selection.label}</th>
                    {selection.cells.map(
                      ({ bookId, cell, stateLabel, best }) => {
                        const timestamp = oddsCellTimestamp(cell);
                        return (
                          <td
                            key={bookId}
                            className={`${bookId === game.oddsComparison.targetSportsbookId ? "target-book" : ""} odds-cell state-${cell.state}`}
                          >
                            <strong>
                              {cell.americanOdds === undefined
                                ? "—"
                                : `${cell.point === undefined ? "" : `${linePoint(cell.point)} · `}${oddsPrice(cell.americanOdds)}`}
                            </strong>
                            <span>
                              {best ? "Best eligible · " : ""}
                              {stateLabel}
                            </span>
                            {!cell.eligible && (
                              <small className="odds-cell-reason">
                                {oddsCellReason(cell.reason)}
                              </small>
                            )}
                            <time dateTime={timestamp ?? undefined}>
                              {timestamp
                                ? `Evidence ${easternDisplay(timestamp)} Eastern`
                                : "No evidence timestamp"}
                            </time>
                          </td>
                        );
                      },
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No supported markets are available.</p>
        )}
      </section>
      <DecisionWorkbench game={game} client={client.value} />
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
  component: DashboardRoute,
});
const gamesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/games",
  validateSearch: (search: Record<string, unknown>) => ({
    sport:
      search["sport"] === "soccer" ? ("soccer" as const) : ("mlb" as const),
    day:
      typeof search["day"] === "string" && validDay(search["day"])
        ? search["day"]
        : currentEasternDay(),
    status: (
      [
        "all",
        "scheduled",
        "postponed",
        "cancelled",
        "started",
        "completed",
        "unknown",
      ] as const
    ).includes(search["status"] as EventExplorerStatus)
      ? (search["status"] as EventExplorerStatus)
      : ("all" as const),
    competition:
      typeof search["competition"] === "string" &&
      search["competition"].length <= 128
        ? search["competition"]
        : "",
    query:
      typeof search["query"] === "string" && search["query"].length <= 160
        ? search["query"]
        : "",
    sort: (
      ["kickoff", "matchup", "competition", "lifecycle", "freshness"] as const
    ).includes(search["sort"] as EventExplorerSortField)
      ? (search["sort"] as EventExplorerSortField)
      : ("kickoff" as const),
    direction:
      search["direction"] === "desc"
        ? ("desc" as EventExplorerSortDirection)
        : ("asc" as EventExplorerSortDirection),
  }),
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
const dataSourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-sources",
  component: DataSourcesRoute,
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
    status: (
      [
        "all",
        "scheduled",
        "postponed",
        "cancelled",
        "started",
        "completed",
        "unknown",
      ] as const
    ).includes(search["status"] as EventExplorerStatus)
      ? (search["status"] as EventExplorerStatus)
      : ("all" as const),
    competition:
      typeof search["competition"] === "string" &&
      search["competition"].length <= 128
        ? search["competition"]
        : "",
    query:
      typeof search["query"] === "string" && search["query"].length <= 160
        ? search["query"]
        : "",
    sort: (
      ["kickoff", "matchup", "competition", "lifecycle", "freshness"] as const
    ).includes(search["sort"] as EventExplorerSortField)
      ? (search["sort"] as EventExplorerSortField)
      : ("kickoff" as const),
    direction:
      search["direction"] === "desc"
        ? ("desc" as EventExplorerSortDirection)
        : ("asc" as EventExplorerSortDirection),
  }),
  component: GameDetail,
});
function ScoutingProgressRoute() {
  const { jobId } = useParams({ from: "/scout-jobs/$jobId" });
  return (
    <ScoutingProgress
      key={jobId}
      jobId={jobId}
      client={useContext(GamesClientContext)}
    />
  );
}
const scoutingProgressRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scout-jobs/$jobId",
  component: ScoutingProgressRoute,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  gamesRoute,
  gameDetailRoute,
  scoutingProgressRoute,
  splitsRoute,
  performanceRoute,
  dataSourcesRoute,
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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <GamesClientContext.Provider value={gamesClient ?? defaultGamesClient}>
        <RouterProvider router={router} />
      </GamesClientContext.Provider>
    </QueryClientProvider>
  );
}
