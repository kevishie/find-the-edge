/* eslint-disable react-refresh/only-export-components -- the shell
   shares its context and formatting helpers with lazily loaded routes. */
import {
  Suspense,
  createContext,
  lazy,
  type ReactElement,
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
  redirect,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  evaluateEdge,
  removeVig,
  type EdgeEvaluation,
} from "@find-the-edge/odds";
import { mlbFindTheEdgeStrategy } from "@find-the-edge/sports";
import {
  eventFreshnessPresentation,
  eventCompetitionOptions,
  eventMatchupLabel,
  filterAndSortEvents,
  eventLifecyclePresentation,
  eventMetadataReasonText,
} from "@find-the-edge/ui";
import type {
  EventExplorerSortDirection,
  EventExplorerSortField,
  EventExplorerStatus,
} from "@find-the-edge/ui";
import { sportsbookScopeKey } from "./sportsbooks";
import { type OddsHistoryDto, type RetrospectiveDto } from "./api";
// Off-nav screens load on demand so the landing path never parses them.
const Dashboard = lazy(() =>
  import("./dashboard").then((module) => ({ default: module.Dashboard })),
);
const DataSources = lazy(() =>
  import("./provider-status").then((module) => ({
    default: module.DataSources,
  })),
);
import { ScoutEventButton, ScoutingProgress } from "./scouting";
const GameDetail = lazy(() => import("./game-detail"));
const PerformanceDashboard = lazy(() => import("./performance"));
const RetrospectivesList = lazy(() =>
  import("./retrospectives").then((module) => ({
    default: module.RetrospectivesList,
  })),
);
const RetrospectiveDetail = lazy(() =>
  import("./retrospectives").then((module) => ({
    default: module.RetrospectiveDetail,
  })),
);
const ExperimentsList = lazy(() =>
  import("./experiments").then((module) => ({
    default: module.ExperimentsList,
  })),
);
const ExperimentDetail = lazy(() =>
  import("./experiments").then((module) => ({
    default: module.ExperimentDetail,
  })),
);

// Route components render inside the shell, so one small fallback fits all.
const suspended = (Component: ReturnType<typeof lazy<() => ReactElement>>) => {
  const Suspended = () => (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <Component />
    </Suspense>
  );
  return Suspended;
};
import {
  asSplitsSource,
  loadSplits,
  prefetchSplits,
  readCachedSplits,
  splitsCacheKey,
} from "./splits-cache";

// Ingestion refreshes the provider board every five minutes, so polling faster
// than this only repeats work behind the splits route.
const SPLITS_REFRESH_INTERVAL_MS = 60_000;
// Games ingest on a one-minute cadence, so the explorer revalidates on the
// same clock; a failed background refresh keeps the last good page.
const GAMES_REFRESH_INTERVAL_MS = 60_000;
export const oddsCellTimestamp = (
  cell: import("@find-the-edge/domain").GameOddsCellDto,
) =>
  cell.state === "active" || cell.state === "stale"
    ? cell.observedAt
    : (cell.evidenceAt ?? cell.observedAt);
export const oddsCellReason = (reason: string) =>
  reason
    .slice(0, 120)
    .replace(/[-_]+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
export function EventMetadataBadges({
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
export interface UiGamesClient {
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
export interface StrategyExperimentDto {
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
export const GamesClientContext =
  createContext<GamesClientResult>(defaultGamesClient);

function AppShell() {
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
        {/* Only screens that are built out are advertised. The remaining
            routes still resolve for anyone holding a direct link. */}
        <nav aria-label="Primary navigation">
          <Link to="/splits" activeProps={{ className: "active" }}>
            Betting Splits
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
        </nav>
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
          <Link to="/splits" activeProps={{ className: "active" }}>
            Splits
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
        </nav>
      </main>
    </div>
  );
}

function DashboardRoute() {
  return (
    <Suspense fallback={<p role="status">Loading dashboard…</p>}>
      <Dashboard client={useContext(GamesClientContext)} />
    </Suspense>
  );
}

function DataSourcesRoute() {
  return (
    <Suspense fallback={<p role="status">Loading data sources…</p>}>
      <DataSources client={useContext(GamesClientContext)} />
    </Suspense>
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

export const oddsPrice = (value: number) =>
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

export const linePoint = (value: number) =>
  value > 0 ? `+${String(value)}` : String(value);

export const easternDisplay = (value: string) =>
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
    let hasPage = false;
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
        if (id === requestId.current && !controller.signal.aborted) {
          hasPage = true;
          setState({ kind: "ready", page });
        }
      } catch (error: unknown) {
        if (id !== requestId.current || controller.signal.aborted) return;
        // A background refresh failure must not blank an already-loaded page.
        if (hasPage) return;
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
    const refreshInterval = window.setInterval(() => {
      void load();
    }, GAMES_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(refreshInterval);
      controller.abort();
    };
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

// Shared divergence encoding for the three splits visualizations, from the
// density study: a gentle power ramp keeps the mid-range separable and the
// extremes saturate instead of clipping. Money lean is purple, ticket lean
// is amber, matching the split-bar legend.
const SPLIT_DIVERGENCE_CAP = 62;
const splitStrength = (divergence: number) =>
  Math.pow(Math.min(Math.abs(divergence) / SPLIT_DIVERGENCE_CAP, 1), 0.75);
const splitTintBg = (divergence: number, maxAlpha: number) => {
  const alpha = splitStrength(divergence) * maxAlpha;
  if (alpha < 0.012) return "transparent";
  const rgb = divergence >= 0 ? "168,85,247" : "251,191,36";
  return `rgba(${rgb},${alpha.toFixed(3)})`;
};
const splitTintFg = (divergence: number) => {
  const s = splitStrength(divergence);
  const base = [243, 241, 248];
  const accent = divergence >= 0 ? [201, 164, 251] : [251, 208, 118];
  const mix = base.map((c, i) => Math.round(c + (accent[i]! - c) * s));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
};

type SplitsVizMode = "bars" | "heat" | "divergence";
const SPLITS_VIZ_STORAGE_KEY = "fte.splitsView";
const LEGACY_SPLITS_VIZ_STORAGE_KEY = "fte.splits.viz";
const splitsVizModes: readonly {
  readonly id: SplitsVizMode;
  readonly label: string;
  readonly mark: string;
  readonly hint: string;
}[] = [
  {
    id: "bars",
    label: "Split Bars",
    mark: "▮",
    hint: "Handle as fill, bets as notch — divergence is the tinted gap between them. Fastest to scan.",
  },
  {
    id: "heat",
    label: "Heat Cells",
    mark: "▦",
    hint: "Raw handle and bets kept side by side; the handle cell is tinted by direction and magnitude.",
  },
  {
    id: "divergence",
    label: "Divergence",
    mark: "±",
    hint: "Signed gap promoted to the primary number. Most compact, and the honest basis for sorting.",
  },
];
const isSplitsVizMode = (value: unknown): value is SplitsVizMode =>
  value === "bars" || value === "heat" || value === "divergence";
const readStoredVizMode = (): SplitsVizMode => {
  try {
    const stored =
      window.localStorage.getItem(SPLITS_VIZ_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_SPLITS_VIZ_STORAGE_KEY);
    return isSplitsVizMode(stored) ? stored : "bars";
  } catch {
    return "bars";
  }
};
const storeVizMode = (mode: SplitsVizMode) => {
  try {
    window.localStorage.setItem(SPLITS_VIZ_STORAGE_KEY, mode);
  } catch {
    // Preference persistence is best-effort.
  }
};

const splitCellNumbers = (
  moneyPercent: number | undefined,
  betPercent: number | undefined,
) => {
  const handle =
    moneyPercent !== undefined && Number.isFinite(moneyPercent)
      ? Math.max(0, Math.min(100, moneyPercent))
      : null;
  const bets =
    betPercent !== undefined && Number.isFinite(betPercent)
      ? Math.max(0, Math.min(100, betPercent))
      : null;
  const divergence =
    handle !== null && bets !== null
      ? Number((handle - bets).toPrecision(12))
      : null;
  return { handle, bets, divergence };
};

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

type UiSplitsPage = Awaited<
  ReturnType<NonNullable<UiGamesClient["listSplits"]>>
>;

type SplitsBoardEntry = {
  readonly game: UiSplitsPage["items"][number];
  readonly splits: readonly UiSplitsPage["items"][number]["splits"][number][];
  readonly emptyLabel: string;
};

const selectSplit = (
  splits: SplitsBoardEntry["splits"],
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
          Date.parse(left.providerTimestamp) || left.id.localeCompare(right.id),
    )[0];
};

function SplitsBoardTable({
  boards,
  mode,
  bookLabel,
}: {
  readonly boards: readonly SplitsBoardEntry[];
  readonly mode: SplitsVizMode;
  readonly bookLabel: string;
}) {
  const heat = mode === "heat";
  const grid = heat ? "csx-grid heat" : "csx-grid wide";
  const subLabels = heat
    ? (["LINE", "HANDLE", "BETS"] as const)
    : (["LINE", mode === "bars" ? "HANDLE vs BETS" : "DIVERGENCE"] as const);
  const markets = ["Spread", "Total", "Moneyline"] as const;
  return (
    <div
      className="csx-board"
      tabIndex={0}
      role="region"
      aria-label="Betting splits comparison table; scroll horizontally for all markets"
    >
      <div className={`${grid} csx-head`}>
        <div className="csx-corner">GAME / TEAM</div>
        {markets.map((market) => (
          <div
            key={market}
            className="csx-market"
            style={{ gridColumn: `span ${heat ? 3 : 2}` }}
          >
            {market.toUpperCase()}
          </div>
        ))}
        {markets.flatMap((market) =>
          subLabels.map((label, index) => (
            <div
              key={`${market}-${label}`}
              className={`csx-subhead${index === 0 ? " first" : ""}`}
            >
              {label}
            </div>
          )),
        )}
      </div>
      {boards.map(({ game, splits, emptyLabel }, gameIndex) => {
        const rows = [
          {
            key: "away" as const,
            label: game.participants[0]?.label ?? "Unknown team",
          },
          {
            key: "home" as const,
            label: game.participants[1]?.label ?? "Unknown team",
          },
        ];
        return rows.map((row, rowIndex) => {
          const spread = selectSplit(splits, "spread", row.key);
          const total = selectSplit(
            splits,
            "total",
            row.key === "away" ? "over" : "under",
          );
          const moneyline = selectSplit(splits, "moneyline", row.key);
          const cells = [spread, total, moneyline];
          const rowClass =
            rowIndex === 0
              ? gameIndex === 0
                ? "csx-row game-first"
                : "csx-row game-start"
              : "csx-row game-second";
          return (
            <div
              key={`${game.id}-${row.key}`}
              className={`${grid} ${rowClass}`}
            >
              <div className="csx-row-team">
                {rowIndex === 0 && (
                  <div className="csx-time">
                    {easternDisplay(game.startsAt)} Eastern
                  </div>
                )}
                <div className="csx-team">{row.label}</div>
                {rowIndex === 0 && (
                  <div className="csx-book">
                    {splits.length > 0 ? bookLabel : emptyLabel}
                  </div>
                )}
              </div>
              {cells.flatMap((split, marketIndex) => {
                const market = markets[marketIndex]!;
                const americanOdds = splitAmericanOdds(split);
                const line = !split
                  ? "—"
                  : marketIndex === 2
                    ? americanOdds === undefined
                      ? "—"
                      : oddsPrice(americanOdds)
                    : split.point === undefined
                      ? "—"
                      : marketIndex === 1
                        ? `${row.key === "away" ? "O" : "U"} ${String(split.point)}`
                        : linePoint(split.point);
                const rendered = [
                  <div key={`${marketIndex}-line`} className="csx-line">
                    {line}
                  </div>,
                ];
                const { handle, bets, divergence } = splitCellNumbers(
                  split?.moneyPercent,
                  split?.betPercent,
                );
                const label = `${market} for ${row.label}: ${
                  handle === null
                    ? "handle unavailable"
                    : `${splitAccessibleNumber(handle)}% handle`
                }, ${
                  bets === null
                    ? "bets unavailable"
                    : `${splitAccessibleNumber(bets)}% bets`
                }${
                  divergence === null
                    ? ""
                    : `, ${splitAccessibleNumber(Math.abs(divergence))} percentage points ${
                        divergence === 0
                          ? "even"
                          : divergence > 0
                            ? "money-heavy"
                            : "ticket-heavy"
                      }`
                }`;
                if (handle === null && bets === null) {
                  rendered.push(
                    <div
                      key={`${marketIndex}-unavailable`}
                      className="csx-unavailable"
                      role="img"
                      aria-label={`${market} for ${row.label}: split data unavailable`}
                      style={heat ? { gridColumn: "span 2" } : undefined}
                    >
                      Unavailable
                    </div>,
                  );
                } else if (heat) {
                  rendered.push(
                    <div
                      key={`${marketIndex}-handle`}
                      className="csx-heat-cell"
                      role="img"
                      aria-label={label}
                      style={
                        divergence === null
                          ? undefined
                          : {
                              color: splitTintFg(divergence),
                              background: splitTintBg(divergence, 0.3),
                            }
                      }
                    >
                      {handle === null ? "—" : splitPercent(handle)}
                    </div>,
                    <div
                      key={`${marketIndex}-bets`}
                      className="csx-heat-cell bets"
                      aria-hidden="true"
                    >
                      {bets === null ? "—" : splitPercent(bets)}
                    </div>,
                  );
                } else if (mode === "divergence") {
                  rendered.push(
                    <div
                      key={`${marketIndex}-divergence`}
                      className="csx-divergence-cell"
                      role="img"
                      aria-label={label}
                      style={
                        divergence === null
                          ? undefined
                          : { background: splitTintBg(divergence, 0.16) }
                      }
                    >
                      <span
                        className="csx-divergence-big"
                        style={
                          divergence === null
                            ? undefined
                            : { color: splitTintFg(divergence) }
                        }
                      >
                        {divergence === null ? "—" : splitPointGap(divergence)}
                      </span>
                      <span className="csx-divergence-pair">
                        {handle === null ? "—" : splitNumber(handle)} /{" "}
                        {bets === null ? "—" : splitNumber(bets)}
                      </span>
                    </div>,
                  );
                } else {
                  const width = 116;
                  const lo =
                    handle !== null && bets !== null
                      ? Math.min(handle, bets)
                      : null;
                  const hi =
                    handle !== null && bets !== null
                      ? Math.max(handle, bets)
                      : null;
                  rendered.push(
                    <div
                      key={`${marketIndex}-bar`}
                      className="csx-bar-cell"
                      role="img"
                      aria-label={label}
                    >
                      <span className="csx-bar-track" aria-hidden="true">
                        {handle !== null && (
                          <span
                            className="csx-bar-fill"
                            style={{ width: (handle / 100) * width }}
                          />
                        )}
                        {divergence !== null && lo !== null && hi !== null && (
                          <span
                            className="csx-bar-span"
                            style={{
                              left: (lo / 100) * width,
                              width: ((hi - lo) / 100) * width,
                              background: `rgba(${
                                divergence >= 0 ? "168,85,247" : "251,191,36"
                              },${(0.25 + splitStrength(divergence) * 0.5).toFixed(2)})`,
                            }}
                          />
                        )}
                        {bets !== null && (
                          <span
                            className="csx-bar-notch"
                            style={{
                              left: Math.min((bets / 100) * width, width - 2),
                            }}
                          />
                        )}
                      </span>
                      <span
                        className="csx-bar-delta"
                        aria-hidden="true"
                        style={
                          divergence === null
                            ? undefined
                            : { color: splitTintFg(divergence) }
                        }
                      >
                        {divergence === null
                          ? "—"
                          : divergence !== 0 && Math.abs(divergence) < 0.01
                            ? `${divergence > 0 ? "+" : "−"}<0.01`
                            : splitPointGap(divergence)}
                      </span>
                    </div>,
                  );
                }
                return rendered;
              })}
            </div>
          );
        });
      })}
    </div>
  );
}

function SplitsExplorer() {
  const client = useContext(GamesClientContext);
  // The provider publishes splits only for MLB among the sports we serve, so
  // the splits screen is MLB-only; the games screen keeps every sport.
  const sport: GamesSport = "mlb";
  const [day, setDay] = useState(() => currentEasternDay());
  const [book, setBook] = useState<SplitBookGroup["id"]>("consensus");
  // The chosen visualization persists as the default until changed again.
  const [vizMode, setVizMode] = useState<SplitsVizMode>(readStoredVizMode);
  const [infoOpen, setInfoOpen] = useState(false);
  const chooseVizMode = (mode: SplitsVizMode) => {
    storeVizMode(mode);
    setVizMode(mode);
  };
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
    // Open on a board warmed before this screen was reached, so arriving from
    // a prefetch paints evidence instead of a loading state.
  >(() => {
    const warmed = readCachedSplits<UiSplitsPage>(sport, day);
    return warmed
      ? {
          kind: "ready",
          items: warmed.page.items,
          freshness: warmed.page.freshness,
          snapshotAt: warmed.page.snapshotAt,
          observedAt: warmed.fetchedAt,
          refreshFailed: false,
        }
      : { kind: "loading" };
  });
  const validBoardKey = useRef<string | null>(
    readCachedSplits(sport, day) ? splitsCacheKey(sport, day) : null,
  );

  useEffect(() => {
    const controller = new AbortController();
    let requestInFlight = false;
    const boardKey = splitsCacheKey(sport, day);
    let hasValidBoard = validBoardKey.current === boardKey;
    // Paint any warmed board immediately. One that is still within a refresh
    // window is left to the interval, so arriving from a prefetch costs no
    // extra request; an older one is revalidated at once.
    const cached = readCachedSplits<UiSplitsPage>(sport, day);
    const cachedIsFresh =
      cached !== undefined &&
      hasValidBoard &&
      Date.now() - cached.fetchedAt < SPLITS_REFRESH_INTERVAL_MS;
    const load = async () => {
      if (requestInFlight || controller.signal.aborted) return;
      const source = client.ok ? asSplitsSource(client.value) : undefined;
      if (!source) {
        setState({
          kind: "error",
          message: "Betting splits are not configured yet.",
        });
        return;
      }
      requestInFlight = true;
      try {
        const page = await loadSplits(source, sport, day);
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
    if (!cachedIsFresh) void load();
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
  // A book earns its chip only with complete evidence: handle and bets
  // together. Tickets-only feeds (BetMGM publishes handle_pct as null) cannot
  // express the board's divergence signal, and we do not surface splits with
  // missing data.
  const hasCompleteSplit = (split: {
    readonly moneyPercent?: number;
    readonly betPercent?: number;
  }) => split.moneyPercent !== undefined && split.betPercent !== undefined;
  const availableBooks = splitBookGroups.filter((group) =>
    games.some((game) =>
      game.splits.some(
        (split) =>
          hasCompleteSplit(split) && splitBookGroupFor(split.scope) === group,
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

  const freshDotClass =
    ageMinutes === undefined
      ? "stale"
      : ageMinutes <= 15
        ? ""
        : ageMinutes <= 60
          ? "aging"
          : "stale";
  const shortTime = newestObservation
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(newestObservation))
    : null;
  const shortDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00-05:00`));
  const sourceLabel = selectedBook ? selectedBook.label : "Circa/DK";
  const activeMode = splitsVizModes.find(({ id }) => id === vizMode)!;

  return (
    <div className="csx-card">
      <span className="csx-accent" aria-hidden="true" style={{ height: 96 }} />
      <div className="csx-header">
        <div className="csx-header-row">
          <h1 className="csx-title">Betting splits</h1>
          <span className="csx-badge">SHARPAPI CONSENSUS</span>
          <button
            type="button"
            className={`csx-info-button${infoOpen ? " open" : ""}`}
            title="What consensus means"
            aria-label="What consensus means"
            aria-expanded={infoOpen}
            onClick={() => setInfoOpen((open) => !open)}
          >
            ⓘ
          </button>
          <div className="csx-controls">
            <label className="csx-chip csx-date-chip" title="Slate date">
              <span className="csx-chip-glyph" aria-hidden="true">
                ▤
              </span>
              {shortDay}
              <input
                type="date"
                aria-label="Eastern calendar day"
                value={day}
                onChange={(event) => {
                  setState({ kind: "loading" });
                  setDay(event.currentTarget.value);
                }}
              />
            </label>
            {availableBooks.length > 1 && (
              <div className="csx-views" role="group" aria-label="Sportsbook">
                {availableBooks.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={selectedBook === group ? "selected" : ""}
                    aria-pressed={selectedBook === group}
                    onClick={() => setBook(group.id)}
                  >
                    <span>{group.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="csx-views" role="group" aria-label="Splits view">
              {splitsVizModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={vizMode === mode.id ? "selected" : ""}
                  aria-pressed={vizMode === mode.id}
                  title={mode.hint}
                  onClick={() => chooseVizMode(mode.id)}
                >
                  <span aria-hidden="true">{mode.mark}</span>
                  <span className="csx-view-label">{mode.label}</span>
                </button>
              ))}
            </div>
            <div
              className="csx-chip csx-status-chip"
              title={`Consensus source: ${sourceLabel}${
                newestObservation
                  ? ` · freshest evidence ${easternDisplay(newestObservation)} Eastern`
                  : ""
              }`}
            >
              <span className={`csx-dot ${freshDotClass}`} aria-hidden="true" />
              {sourceLabel}
              {shortTime ? ` · ${shortTime}` : ""}
            </div>
          </div>
        </div>
        <div className="csx-stats" aria-label="Splits summary">
          <span>
            <strong>{games.length}</strong> games
          </span>
          <span className="csx-sep">·</span>
          <span>
            <strong>{coveredGames}</strong> with data
          </span>
          <span className="csx-sep">·</span>
          <span>
            <strong>{observationCount}</strong> observations
          </span>
          <span className="csx-sep">·</span>
          <span>tickets vs money across each market</span>
        </div>
        {infoOpen && (
          <div className="csx-info-banner" role="note">
            <h3>Consensus is context—not a pick.</h3>
            <p>
              SharpAPI combines its public-betting data into one consensus view.
              Compare bet percentage with handle percentage to spot imbalances,
              then confirm the signal with line movement and price value.
            </p>
            <button
              type="button"
              className="csx-info-close"
              aria-label="Dismiss"
              onClick={() => setInfoOpen(false)}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {state.kind === "ready" && state.refreshFailed && (
        <p className="csx-state" role="status">
          <strong>Refresh delayed.</strong> Showing the last valid board while
          we retry.
        </p>
      )}
      {state.kind === "ready" && games.length > 0 && coveredGames === 0 && (
        <p className="csx-state" role="status">
          No split percentages are available from {sourceLabel} yet. The
          complete schedule remains below.
        </p>
      )}
      <div aria-live="polite">
        {state.kind === "loading" && (
          <p className="csx-state">Loading current split evidence…</p>
        )}
        {state.kind === "error" && (
          <p className="csx-state" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === "ready" && games.length === 0 && (
          <p className="csx-state">
            No scheduled games are available for this day.
          </p>
        )}
      </div>
      {state.kind === "ready" && games.length > 0 && (
        <SplitsBoardTable
          boards={boards}
          mode={vizMode}
          bookLabel={sourceLabel}
        />
      )}
      <span className="sr-only">{activeMode.hint}</span>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
  errorComponent: AppError,
});
// Splits is the product's landing screen. The dashboard is not built out, so
// it keeps a route for direct links but is no longer what the root resolves to.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    // Throwing a redirect is how the router signals navigation from a loader.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/splits" });
  },
});
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
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
  component: suspended(PerformanceDashboard),
});
const dataSourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-sources",
  component: DataSourcesRoute,
});
const retrospectivesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retrospectives",
  component: suspended(RetrospectivesList),
});
const experimentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments",
  component: suspended(ExperimentsList),
});
const experimentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments/$experimentId",
  component: suspended(ExperimentDetail),
});
const retrospectiveDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retrospectives/$versionId",
  component: suspended(RetrospectiveDetail),
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
  component: () => (
    <Suspense fallback={<p role="status">Loading game detail…</p>}>
      <GameDetail />
    </Suspense>
  ),
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
  dashboardRoute,
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
  const client = gamesClient ?? defaultGamesClient;
  useEffect(() => {
    // Warm today's board while the reader is elsewhere so opening splits is a
    // cache read rather than a cold round trip.
    if (client.ok) prefetchSplits(client.value, "mlb", currentEasternDay());
  }, [client]);
  return (
    <QueryClientProvider client={queryClient}>
      <GamesClientContext.Provider value={gamesClient ?? defaultGamesClient}>
        <RouterProvider router={router} />
      </GamesClientContext.Provider>
    </QueryClientProvider>
  );
}
