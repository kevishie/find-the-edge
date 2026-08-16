/* eslint-disable react-refresh/only-export-components -- the shell
   shares its context and formatting helpers with lazily loaded routes. */
import {
  Suspense,
  createContext,
  lazy,
  type ReactElement,
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
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
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
import { LandingPage } from "./landing-page";
import { PublicLegalPage } from "./public-legal";
import {
  GamesClientError,
  isRequestCancellation,
  type OddsHistoryDto,
  type RetrospectiveDto,
  type WatchlistEntryDto,
} from "./api";
import {
  accountHint,
  defaultSessionStore,
  LOGIN_PATH,
  PUBLIC_ROUTES,
  requiresSession,
  SUBSCRIBE_PATH,
  DEFAULT_RETURN_PATH,
  safeReturnPath,
  SessionContext,
  SIGNED_IN_HOME,
  useSession,
  type SessionStore,
} from "./session";
import { SubscribeScreen } from "./subscribe";

/**
 * Whether a usable session exists right now, read straight from the store
 * rather than from React state: route guards run before any component does.
 * An expired token counts as no session — the guard's job is to keep a reader
 * off a screen that would only fail its first request.
 */
const hasLiveSession = (store: SessionStore): boolean => {
  const session = store.getSnapshot();
  return session !== null && Date.parse(session.expiresAt) > Date.now();
};

/**
 * The guard on every product route. A signed-out reader is sent to the form
 * carrying where they meant to go, so signing in resumes the journey instead
 * of dumping them on a default screen. The destination is re-validated on the
 * way back in, so this never becomes a redirect gadget.
 */
const requireSession = (
  store: SessionStore,
  pathname: string,
  search: string,
) => {
  if (!requiresSession(pathname) || hasLiveSession(store)) return;
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({
    to: LOGIN_PATH,
    search: { returnUrl: safeReturnPath(`${pathname}${search}`) },
    replace: true,
  });
};

export const ROUTE_AUTHORIZATION_ABORTED = Symbol(
  "route-authorization-aborted",
);

/** Stop an abandoned navigation without canceling a shared session refresh. */
export const authorizeRouteSession = (
  store: SessionStore,
  signal: AbortSignal,
): Promise<string | null | typeof ROUTE_AUTHORIZATION_ABORTED> => {
  if (signal.aborted) return Promise.resolve(ROUTE_AUTHORIZATION_ABORTED);
  return new Promise((resolve, reject) => {
    const aborted = () => resolve(ROUTE_AUTHORIZATION_ABORTED);
    signal.addEventListener("abort", aborted, { once: true });
    void store
      .authorize()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", aborted);
      });
  });
};

const requireEntitledSession = async (
  store: SessionStore,
  resolveEntitlement: UiGamesClient["entitlement"],
  pathname: string,
  search: string,
  signal: AbortSignal,
) => {
  if (!requiresSession(pathname)) return;
  const login = (invalidate = false): never => {
    if (invalidate) store.signOut();
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({
      to: LOGIN_PATH,
      search: { returnUrl: safeReturnPath(`${pathname}${search}`) },
      replace: true,
    });
  };
  // A refresh or account switch can land while entitlement is in flight.
  // Retry once for the replacement token; repeated churn is uncertainty and
  // therefore a closed route, never implicit access.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let token: string | null | typeof ROUTE_AUTHORIZATION_ABORTED;
    try {
      token = await authorizeRouteSession(store, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof GamesClientError &&
        (error.code === "authentication" || error.code === "unauthorized")
      )
        login(true);
      // A transport/storage failure proves neither identity nor entitlement.
      // Let the route error boundary fail closed instead of guessing either.
      throw error;
    }
    if (token === ROUTE_AUTHORIZATION_ABORTED || signal.aborted) return;
    if (token === null) {
      if (store.getSnapshot() !== null) continue;
      return login();
    }
    if (store.getSnapshot()?.token !== token) continue;
    if (!resolveEntitlement)
      throw new GamesClientError(
        "configuration",
        "Product access could not be verified.",
      );
    let entitlement: Awaited<ReturnType<typeof resolveEntitlement>>;
    try {
      entitlement = await resolveEntitlement(token, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (store.getSnapshot()?.token !== token) continue;
      if (
        error instanceof GamesClientError &&
        (error.code === "authentication" || error.code === "unauthorized")
      )
        login(true);
      if (
        error instanceof GamesClientError &&
        error.code === "payment-required"
      ) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({ to: SUBSCRIBE_PATH, replace: true });
      }
      throw error;
    }
    if (store.getSnapshot()?.token !== token) continue;
    if (!entitlement.hasAccess) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: SUBSCRIBE_PATH, replace: true });
    }
    return;
  }
  throw new GamesClientError(
    "configuration",
    "Product access changed while it was being verified.",
  );
};
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
import { ScoutReport } from "./scout-report";
const GameDetail = lazy(() => import("./game-detail"));
const Watchlist = lazy(() =>
  import("./watchlist").then((module) => ({ default: module.Watchlist })),
);
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
const SignInScreen = lazy(() =>
  import("./sign-in").then((module) => ({ default: module.SignIn })),
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
            Listing {easternDisplay(game.metadata.freshness.evidenceAt)} Eastern
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

type GamesSport = "mlb" | "football" | "soccer";
export interface UiGamesPage {
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
          readonly source?: "canonical-closing" | "pregame-snapshot";
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
  canReviewRetrospectives?(signal: AbortSignal): Promise<boolean>;
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
  canManageExperiments?(signal: AbortSignal): Promise<boolean>;
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
  getScoutReportByJob?: NonNullable<
    import("./api").GamesClient["getScoutReportByJob"]
  >;
  getScoutReportVersion?: NonNullable<
    import("./api").GamesClient["getScoutReportVersion"]
  >;
  listScoutReportVersions?: NonNullable<
    import("./api").GamesClient["listScoutReportVersions"]
  >;
  listWatchlist?: NonNullable<import("./api").GamesClient["listWatchlist"]>;
  addToWatchlist?: NonNullable<import("./api").GamesClient["addToWatchlist"]>;
  removeFromWatchlist?: NonNullable<
    import("./api").GamesClient["removeFromWatchlist"]
  >;
  requestOtp?: NonNullable<import("./api").GamesClient["requestOtp"]>;
  verifyOtp?: NonNullable<import("./api").GamesClient["verifyOtp"]>;
  refreshSession?: NonNullable<import("./api").GamesClient["refreshSession"]>;
  revokeSession?: NonNullable<import("./api").GamesClient["revokeSession"]>;
  startCheckout?: NonNullable<import("./api").GamesClient["startCheckout"]>;
  entitlement?: NonNullable<import("./api").GamesClient["entitlement"]>;
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

/**
 * Availability of the watchlist in the current session. The explorer is a
 * public screen, so "signed-out" is an ordinary state that offers sign-in
 * rather than an error, and "unavailable" means the deployment has no
 * watchlist API at all.
 */
export type WatchlistAvailability =
  "loading" | "ready" | "signed-out" | "unavailable";

export interface WatchlistControl {
  readonly availability: WatchlistAvailability;
  /** Ordered soonest kickoff first, exactly as the API published it. */
  readonly entries: readonly WatchlistEntryDto[];
  readonly unavailableReason: string | null;
  readonly pending: ReadonlySet<string>;
  readonly mutationError: string | null;
  readonly isWatched: (eventId: string) => boolean;
  readonly add: (eventId: string) => Promise<boolean>;
  readonly remove: (eventId: string) => Promise<boolean>;
  readonly retry: () => void;
}

type WatchlistState =
  | { readonly kind: "loading"; readonly ownerKey: string }
  | {
      readonly kind: "ready";
      readonly ownerKey: string;
      readonly entries: readonly WatchlistEntryDto[];
      readonly loadedAt: string;
    }
  | { readonly kind: "signed-out"; readonly ownerKey: string }
  | {
      readonly kind: "unavailable";
      readonly ownerKey: string;
      readonly reason: string;
    };

const byKickoff = (
  entries: readonly WatchlistEntryDto[],
): readonly WatchlistEntryDto[] =>
  [...entries].sort((left, right) =>
    left.startsAt === right.startsAt
      ? left.eventId.localeCompare(right.eventId)
      : left.startsAt < right.startsAt
        ? -1
        : 1,
  );

const withoutEntry = (
  entries: readonly WatchlistEntryDto[],
  eventId: string,
): readonly WatchlistEntryDto[] =>
  entries.filter((entry) => entry.eventId !== eventId);

/**
 * Single source of watched state for every screen in a session: the list is
 * fetched once and mutations are applied optimistically, so a row never claims
 * a state the API has not been asked for. A failed mutation restores exactly
 * what was there before and says so.
 */
export function useWatchlistControl(
  client: GamesClientResult,
): WatchlistControl {
  const sessionStore = useContext(SessionContext);
  const session = useSession(sessionStore);
  const sessionKey = session
    ? `${session.accountId}\u0000${session.token}`
    : "signed-out";
  const listWatchlist = client.ok ? client.value.listWatchlist : undefined;
  const addToWatchlist = client.ok ? client.value.addToWatchlist : undefined;
  const removeFromWatchlist = client.ok
    ? client.value.removeFromWatchlist
    : undefined;
  const [state, setState] = useState<WatchlistState>(() =>
    listWatchlist
      ? { kind: "loading", ownerKey: sessionKey }
      : {
          kind: "unavailable",
          ownerKey: sessionKey,
          reason: "The watchlist is unavailable in this environment.",
        },
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // Mutations outlive the effect that started them, so they share one
  // controller that is aborted when the screen goes away.
  const mutations = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    mutations.current = controller;
    return () => {
      controller.abort();
      mutations.current = null;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!listWatchlist) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setState({ kind: "loading", ownerKey: sessionKey });
      setPending(new Set<string>());
      setMutationError(null);
    });
    listWatchlist(controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "ready",
          ownerKey: sessionKey,
          entries: page.items,
          loadedAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isRequestCancellation(error)) return;
        const code = error instanceof GamesClientError ? error.code : null;
        if (code === "authentication" || code === "forbidden") {
          setState({ kind: "signed-out", ownerKey: sessionKey });
          return;
        }
        setState({
          kind: "unavailable",
          ownerKey: sessionKey,
          reason:
            code === "invalid-response"
              ? "The watchlist did not match its published contract, so none of it is shown."
              : "The watchlist is temporarily unavailable.",
        });
      });
    return () => controller.abort();
  }, [generation, listWatchlist, sessionKey]);

  const markPending = useCallback((eventId: string, active: boolean) => {
    setPending((current) => {
      const next = new Set(current);
      if (active) next.add(eventId);
      else next.delete(eventId);
      return next;
    });
  }, []);

  const visibleState: WatchlistState = useMemo(
    () =>
      !listWatchlist || state.ownerKey === sessionKey
        ? state
        : { kind: "loading", ownerKey: sessionKey },
    [listWatchlist, sessionKey, state],
  );

  const add = useCallback(
    async (eventId: string): Promise<boolean> => {
      const signal = mutations.current?.signal;
      if (!addToWatchlist || !signal || visibleState.kind !== "ready")
        return false;
      markPending(eventId, true);
      setMutationError(null);
      try {
        const entry = await addToWatchlist(eventId, signal);
        setState((current) =>
          current.kind === "ready" && current.ownerKey === sessionKey
            ? {
                ...current,
                entries: byKickoff([
                  ...withoutEntry(current.entries, entry.eventId),
                  entry,
                ]),
              }
            : current,
        );
        return true;
      } catch (error: unknown) {
        if (signal.aborted || isRequestCancellation(error)) return false;
        const code = error instanceof GamesClientError ? error.code : null;
        setMutationError(
          code === "authentication" || code === "forbidden"
            ? "Sign in is required to use the watchlist."
            : code === "not-found"
              ? "That event is no longer available, so it was not watched."
              : "That event could not be added to the watchlist.",
        );
        return false;
      } finally {
        markPending(eventId, false);
      }
    },
    [addToWatchlist, markPending, sessionKey, visibleState.kind],
  );

  const remove = useCallback(
    async (eventId: string): Promise<boolean> => {
      const signal = mutations.current?.signal;
      if (!removeFromWatchlist || !signal || visibleState.kind !== "ready")
        return false;
      // Capture rollback data from the exact render that exposed the Remove
      // button. Mirroring entries through an effect leaves a brief window in
      // which the row is visible but its rollback snapshot is still stale.
      const removed =
        visibleState.kind === "ready"
          ? visibleState.entries.find((entry) => entry.eventId === eventId)
          : undefined;
      markPending(eventId, true);
      setMutationError(null);
      setState((current) =>
        current.kind === "ready" && current.ownerKey === sessionKey
          ? { ...current, entries: withoutEntry(current.entries, eventId) }
          : current,
      );
      try {
        await removeFromWatchlist(eventId, signal);
        return true;
      } catch (error: unknown) {
        if (signal.aborted || isRequestCancellation(error)) return false;
        // The row goes back exactly where it was; nothing was removed.
        if (removed)
          setState((current) =>
            current.kind === "ready" && current.ownerKey === sessionKey
              ? {
                  ...current,
                  entries: byKickoff([
                    ...withoutEntry(current.entries, eventId),
                    removed,
                  ]),
                }
              : current,
          );
        const code = error instanceof GamesClientError ? error.code : null;
        setMutationError(
          code === "authentication" || code === "forbidden"
            ? "Sign in is required to use the watchlist."
            : "That event could not be removed from the watchlist.",
        );
        return false;
      } finally {
        markPending(eventId, false);
      }
    },
    [markPending, removeFromWatchlist, sessionKey, visibleState],
  );

  const watched = useMemo(
    () =>
      new Set(
        visibleState.kind === "ready"
          ? visibleState.entries.map((entry) => entry.eventId)
          : [],
      ),
    [visibleState],
  );

  const retry = useCallback(() => {
    setState({ kind: "loading", ownerKey: sessionKey });
    setGeneration((value) => value + 1);
  }, [sessionKey]);

  return {
    availability:
      visibleState.kind === "ready"
        ? "ready"
        : visibleState.kind === "loading"
          ? "loading"
          : visibleState.kind,
    entries: visibleState.kind === "ready" ? visibleState.entries : [],
    unavailableReason:
      visibleState.kind === "unavailable" ? visibleState.reason : null,
    pending: state.ownerKey === sessionKey ? pending : new Set<string>(),
    mutationError: state.ownerKey === sessionKey ? mutationError : null,
    isWatched: (eventId: string) => watched.has(eventId),
    add,
    remove,
    retry,
  };
}

function GlassNav({
  eventsSearch,
}: {
  readonly eventsSearch: Record<string, unknown>;
}) {
  // Apple-glass behavior: the bar condenses while the page scrolls and
  // springs back to full size the moment scrolling rests.
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onScroll = () => {
      setCondensed(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCondensed(false), 240);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <nav
      className={`glass-nav${condensed ? " condensed" : ""}`}
      aria-label="Glass tab bar"
    >
      <Link
        to="/events"
        search={eventsSearch as never}
        className="glass-tab"
        activeProps={{ className: "glass-tab active" }}
        activeOptions={{ includeSearch: false }}
      >
        <span className="glass-icon" aria-hidden="true">
          ⊙
        </span>
        <span className="glass-label">Events</span>
      </Link>
      <Link
        to="/splits"
        className="glass-tab"
        activeProps={{ className: "glass-tab active" }}
        activeOptions={{ includeSearch: false }}
      >
        <span className="glass-icon" aria-hidden="true">
          ▦
        </span>
        <span className="glass-label">Splits</span>
      </Link>
      <Link
        to="/watchlist"
        className="glass-tab"
        activeProps={{ className: "glass-tab active" }}
        activeOptions={{ includeSearch: false }}
      >
        <span className="glass-icon" aria-hidden="true">
          ★
        </span>
        <span className="glass-label">Watchlist</span>
      </Link>
      <Link
        to="/dashboard"
        className="glass-tab"
        activeProps={{ className: "glass-tab active" }}
        activeOptions={{ includeSearch: false }}
      >
        <span className="glass-icon" aria-hidden="true">
          ⚡
        </span>
        <span className="glass-label">Scanner</span>
      </Link>
    </nav>
  );
}

/**
 * Who is signed in, and the way out. It sits outside the primary nav so it
 * survives the small-screen layout that hides the sidebar links, and it is the
 * only sign-in affordance the shell offers: our own route, never a provider.
 */
function SessionBadge({ collapsed }: { readonly collapsed: boolean }) {
  const store = useContext(SessionContext);
  const session = useSession(store);
  const client = useContext(GamesClientContext);
  const router = useRouter();
  const here = useRouterState({ select: (state) => state.location.href });
  const signOut = useCallback(() => {
    const token = session?.token;
    // Retire the token server-side first, so every other copy of it dies too.
    // Best effort on purpose: a reader who presses sign out on a flaky
    // connection must still end up signed out locally rather than stuck on a
    // screen they asked to leave. The local session is dropped either way,
    // and the token expires on its own within the hour.
    if (token && client.ok && client.value.revokeSession)
      void client.value
        .revokeSession(token, new AbortController().signal)
        .catch(() => undefined);
    store.signOut();
    // Leaving is the point. Staying on a product screen after signing out
    // shows a shell whose every request is about to fail.
    void router.navigate({ to: "/", replace: true });
  }, [client, router, session, store]);
  if (session === null)
    return (
      <div className="shell-session">
        <Link
          to={LOGIN_PATH}
          search={{ returnUrl: safeReturnPath(here) }}
          className="shell-session-link"
          title="Sign in"
        >
          <span aria-hidden="true">⇥</span>
          <span className={collapsed ? "sr-only" : undefined}>Sign in</span>
        </Link>
      </div>
    );
  return (
    <div className="shell-session">
      <span className="shell-session-state">
        <span aria-hidden="true">●</span>
        <span className={collapsed ? "sr-only" : undefined}>
          Signed in {accountHint(session.accountId)}
        </span>
      </span>
      <button type="button" className="shell-session-out" onClick={signOut}>
        <span aria-hidden="true">⇥</span>
        <span className={collapsed ? "sr-only" : undefined}>Sign out</span>
      </button>
    </div>
  );
}

function AppShell() {
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("fte.navCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleNav = () =>
    setNavCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem("fte.navCollapsed", next ? "1" : "0");
      } catch {
        // Preference persistence is best-effort.
      }
      return next;
    });
  const eventsSearch = {
    sport: "mlb" as const,
    day: currentEasternDay(),
    status: "all" as const,
    competition: "",
    query: "",
    sort: "kickoff" as const,
    direction: "asc" as const,
  };
  return (
    <div className={`shell${navCollapsed ? " nav-collapsed" : ""}`}>
      <aside>
        <div className="brand">
          <svg
            className="brand-logo"
            width="30"
            height="24"
            viewBox="0 0 30 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 20 L5 7 L11 14 L15 4 L19 14 L25 7 L28 20 Z"
              fill="#8b5cf6"
              stroke="#c084fc"
              strokeWidth="1"
              strokeLinejoin="round"
            />
            <rect x="3" y="20" width="24" height="3" rx="1" fill="#c084fc" />
          </svg>
          {!navCollapsed && (
            <div className="brand-word">
              <strong>
                FIND THE <span className="brand-edge">EDGE</span>
              </strong>
              <small>BY @KEVISHIE</small>
            </div>
          )}
        </div>
        {/* Only screens that are built out are advertised. The remaining
            routes still resolve for anyone holding a direct link. */}
        <nav id="primary-navigation" aria-label="Primary navigation">
          {navCollapsed ? (
            <div className="nav-divider" aria-hidden="true" />
          ) : (
            <div className="nav-section">TERMINAL</div>
          )}
          <Link
            to="/events"
            search={eventsSearch}
            activeProps={{ className: "active" }}
            activeOptions={{ includeSearch: false }}
            title="Events"
          >
            <span className="nav-icon" aria-hidden="true">
              ⊙
            </span>
            <span className={navCollapsed ? "sr-only" : "nav-label"}>
              Events
            </span>
          </Link>
          <Link
            to="/splits"
            activeProps={{ className: "active" }}
            activeOptions={{ includeSearch: false }}
            title="Splits"
          >
            <span className="nav-icon" aria-hidden="true">
              ▦
            </span>
            <span className={navCollapsed ? "sr-only" : "nav-label"}>
              Splits
            </span>
          </Link>
          <Link
            to="/watchlist"
            activeProps={{ className: "active" }}
            activeOptions={{ includeSearch: false }}
            title="Watchlist"
          >
            <span className="nav-icon" aria-hidden="true">
              ★
            </span>
            <span className={navCollapsed ? "sr-only" : "nav-label"}>
              Watchlist
            </span>
          </Link>
          <Link
            to="/dashboard"
            activeProps={{ className: "active" }}
            activeOptions={{ includeSearch: false }}
            title="Scanner"
          >
            <span className="nav-icon" aria-hidden="true">
              ✦
            </span>
            <span className={navCollapsed ? "sr-only" : "nav-label"}>
              Scanner
            </span>
          </Link>
        </nav>
        <SessionBadge collapsed={navCollapsed} />
      </aside>
      <button
        type="button"
        className="nav-toggle"
        onClick={toggleNav}
        aria-controls="primary-navigation"
        aria-pressed={navCollapsed}
        title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
        aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
      >
        <svg
          className="nav-toggle-glyph"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          {navCollapsed ? (
            <path d="M2 2L6 6L2 10M5 2L9 6L5 10" />
          ) : (
            <path d="M10 2L6 6L10 10M7 2L3 6L7 10" />
          )}
        </svg>
      </button>
      <GlassNav eventsSearch={eventsSearch} />
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

const sportLabels: Record<GamesSport, string> = {
  mlb: "MLB",
  football: "NFL",
  soccer: "Soccer",
};
// A game qualifies when any cell is priced better than its no-vig fair line.
// Fair probabilities come from the sharp anchor when the whole market carries
// one; a market priced only by the displayed book de-vigs against itself and
// can never beat its own fair line.
const gameHasEdge = (game: UiGamesPage["items"][number]) => {
  if (game.odds.state !== "available") return false;
  const byMarket = new Map<
    string,
    { readonly americanOdds: number; readonly sharpAmericanOdds?: number }[]
  >();
  for (const price of game.odds.selections)
    byMarket.set(price.marketKey, [
      ...(byMarket.get(price.marketKey) ?? []),
      price,
    ]);
  for (const sides of byMarket.values()) {
    if (sides.length < 2) continue;
    const anchored = sides.every(
      (side) => side.sharpAmericanOdds !== undefined,
    );
    const baseline = (side: (typeof sides)[number]) =>
      anchored ? side.sharpAmericanOdds! : side.americanOdds;
    const total = sides.reduce(
      (sum, side) => sum + americanToProbability(baseline(side)),
      0,
    );
    for (const side of sides) {
      const fairProbability = americanToProbability(baseline(side)) / total;
      const ev =
        (fairProbability * americanToDecimal(side.americanOdds) - 1) * 100;
      if (ev > 0.05) return true;
    }
  }
  return false;
};

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

export const currentEasternDay = (now = new Date()) =>
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

const gamesShortDay = (day: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00-05:00`));
export const kickoffDisplay = (instant: string) => {
  const at = new Date(instant);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `${day} · ${time} ET`;
};

function GamesExplorer() {
  const client = useContext(GamesClientContext);
  // One watchlist query serves every row on the board.
  const watchlist = useWatchlistControl(client);
  const search = useSearch({ from: "/events" });
  const navigate = useNavigate({ from: "/events" });
  const { sport, day, status, competition, query, sort, direction } = search;
  const [retry, setRetry] = useState(0);
  const [mediaCompact, setMediaCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false,
  );
  const [viewPref, setViewPref] = useState<"table" | "cards" | null>(() => {
    try {
      const stored = window.localStorage.getItem("fte.eventView");
      return stored === "table" || stored === "cards" ? stored : null;
    } catch {
      return null;
    }
  });
  // An explicit Table/Cards choice wins; otherwise the viewport decides.
  const compact = viewPref ? viewPref === "cards" : mediaCompact;
  const chooseView = (view: "table" | "cards") => {
    setViewPref(view);
    try {
      window.localStorage.setItem("fte.eventView", view);
    } catch {
      // Preference persistence is best-effort.
    }
  };
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly page: UiGamesPage }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });
  // Keyed by sport rather than a single "other": the rail has to count every
  // sport it might offer, and with three of them a lone slot silently hid
  // whichever one was not fetched.
  const [otherSportItems, setOtherSportItems] = useState<
    Partial<Record<GamesSport, UiGamesPage["items"]>>
  >({});
  const requestId = useRef(0);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMediaCompact(media.matches);
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
        // The sport rail needs every other slate's count for the day; none of
        // them may block the selected slate, and a failure leaves that one
        // pill hidden until the next poll rather than failing the page.
        for (const otherSport of (
          Object.keys(sportLabels) as GamesSport[]
        ).filter((candidate) => candidate !== sport))
          void activeClient
            .list({ sport: otherSport, day, status }, controller.signal)
            .then((otherPage) => {
              if (id === requestId.current && !controller.signal.aborted)
                setOtherSportItems((current) => ({
                  ...current,
                  [otherSport]: otherPage.items,
                }));
            })
            .catch(() => undefined);
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
  // If we show a game it is because we have lines: unpriced events never
  // render, on any surface.
  const hasLines = (game: UiGamesPage["items"][number]) =>
    game.odds.state === "available" && game.odds.selections.length > 0;
  const pageSnapshotAt =
    state.kind === "ready" ? state.page.snapshotAt : undefined;
  const notStarted = (game: UiGamesPage["items"][number]) =>
    status !== "scheduled" ||
    !pageSnapshotAt ||
    Date.parse(game.startsAt) > Date.parse(pageSnapshotAt);
  const visibleItems = filterAndSortEvents(
    baseItems.filter(hasLines).filter(notStarted),
    {
      competition,
      query,
      sort,
      direction,
    },
  );
  const partial =
    state.kind === "ready" &&
    (state.page.lifecycleCoverage?.unavailable.length ?? 0) > 0;

  return (
    <>
      <header className="explorer-header">
        <div>
          <p className="eyebrow">EVENT CATALOG · EASTERN TIME</p>
          <h1>Event Explorer</h1>
          <p className="lede">
            Browse the complete MLB and MLS event catalog by lifecycle,
            competition, participant, and kickoff.
          </p>
        </div>
        <span className="maturity beta">live odds</span>
      </header>

      <nav className="sport-rail" aria-label="Sport rail">
        {(Object.keys(sportLabels) as GamesSport[]).map((key) => {
          const items = (
            key === sport ? baseItems : (otherSportItems[key] ?? [])
          ).filter(hasLines);
          // A sport with no priced slate for the day does not earn a pill.
          if (items.length === 0 && key !== sport) return null;
          const qualified = items.filter(gameHasEdge).length;
          return (
            <button
              key={key}
              type="button"
              className={`sport-pill${sport === key ? " selected" : ""}`}
              aria-label={sportLabels[key]}
              aria-pressed={sport === key}
              onClick={() => {
                if (key === sport) return;
                setState({ kind: "loading" });
                updateSearch({ sport: key, competition: "", query: "" });
              }}
            >
              <span className="sport-pill-icon" aria-hidden="true">
                {key === "mlb" ? "◍" : key === "football" ? "◈" : "⊛"}
              </span>
              {sportLabels[key]}
              <span
                className={`sport-pill-count${qualified > 0 ? " qualified" : ""}`}
              >
                {items.length}
              </span>
            </button>
          );
        })}
      </nav>
      <section className="game-filters" aria-label="Event filters">
        <label className="csx-chip csx-date-chip" title="Slate date">
          <span className="csx-chip-glyph" aria-hidden="true">
            ▤
          </span>
          {gamesShortDay(day)}
          <input
            type="date"
            aria-label="Eastern calendar day"
            value={day}
            onClick={(event) => {
              const input = event.currentTarget;
              if (typeof input.showPicker === "function") {
                try {
                  input.showPicker();
                } catch {
                  input.focus();
                }
              }
            }}
            onChange={(event) => {
              setState({ kind: "loading" });
              updateSearch({ day: event.currentTarget.value });
            }}
          />
        </label>
        {/* Kickoff decides "started": provider id churn leaves in-progress
            games' lifecycle stuck at scheduled, so a lifecycle filter cannot
            tell them apart — the clock can. */}
        <button
          type="button"
          className={`csx-chip evx-toggle${status === "scheduled" ? " selected" : ""}`}
          aria-pressed={status === "scheduled"}
          onClick={() =>
            updateSearch({
              status: status === "scheduled" ? "all" : "scheduled",
            })
          }
        >
          Hide started
        </button>
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
        <div
          className="event-view-toggle"
          role="group"
          aria-label="Results layout"
        >
          <button
            type="button"
            className={compact ? "" : "selected"}
            aria-pressed={!compact}
            onClick={() => chooseView("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={compact ? "selected" : ""}
            aria-pressed={compact}
            onClick={() => chooseView("cards")}
          >
            Cards
          </button>
        </div>
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
            {visibleItems.length} events · {sportLabels[sport]} ·{" "}
            {visibleItems.filter(gameHasEdge).length} qualified
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
                    <th scope="col">Matchup</th>
                    {sport === "soccer" ? (
                      <>
                        <th scope="col">Home</th>
                        <th scope="col">Tie</th>
                        <th scope="col">Away</th>
                      </>
                    ) : (
                      <>
                        <th scope="col">Spread</th>
                        <th scope="col">Total</th>
                        <th scope="col">Moneyline</th>
                      </>
                    )}
                  </tr>
                </thead>
                {visibleItems.map((game) => (
                  <EventGameBlock
                    key={game.id}
                    game={game}
                    explorerSearch={search}
                    snapshotAt={state.page.snapshotAt}
                    watchlist={watchlist}
                  />
                ))}
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
                  watchlist={watchlist}
                />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

const teamNickname = (label: string, sportKey: string) => {
  if (sportKey !== "mlb") return label;
  for (const nickname of ["Red Sox", "White Sox", "Blue Jays"])
    if (label.endsWith(nickname)) return nickname;
  const words = label.split(" ");
  return words[words.length - 1] ?? label;
};
const teamMonogram = (label: string, sportKey: string) =>
  teamNickname(label, sportKey)
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 3)
    .toUpperCase();
const americanToDecimal = (odds: number) =>
  odds >= 0 ? odds / 100 + 1 : 100 / -odds + 1;
const probabilityToAmerican = (p: number) => {
  const decimal = 1 / p;
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : Math.round(-100 / (decimal - 1));
};
const americanToProbability = (odds: number) =>
  odds >= 0 ? 100 / (odds + 100) : -odds / (-odds + 100);

function FairCell({
  selection,
  counterparts,
  marketKey,
}: {
  readonly selection?:
    | {
        readonly point?: number;
        readonly americanOdds: number;
        readonly sharpAmericanOdds?: number;
        readonly selectionKey: string;
      }
    | undefined;
  readonly counterparts?: readonly {
    readonly americanOdds: number;
    readonly sharpAmericanOdds?: number;
  }[];
  readonly marketKey: string;
}) {
  if (!selection)
    return (
      <td className="evb-cell-wrap">
        <div className="evb-cell evb-cell-empty">—</div>
      </td>
    );
  const pointText =
    selection.point === undefined
      ? ""
      : marketKey === "total"
        ? `${selection.selectionKey === "over" ? "O" : "U"} ${selection.point}`
        : linePoint(selection.point);
  let fair: number | null = null;
  let ev: number | null = null;
  if (counterparts && counterparts.length > 0) {
    // De-vig the sharp anchor when the whole market carries one; a book's
    // own prices can never beat the fair line derived from themselves.
    const anchored =
      selection.sharpAmericanOdds !== undefined &&
      counterparts.every((other) => other.sharpAmericanOdds !== undefined);
    const pSelf = americanToProbability(
      anchored ? selection.sharpAmericanOdds : selection.americanOdds,
    );
    const pOthers = counterparts.reduce(
      (total, other) =>
        total +
        americanToProbability(
          anchored ? other.sharpAmericanOdds! : other.americanOdds,
        ),
      0,
    );
    const fairProbability = pSelf / (pSelf + pOthers);
    fair = probabilityToAmerican(fairProbability);
    ev =
      (fairProbability * americanToDecimal(selection.americanOdds) - 1) * 100;
  }
  const edge = ev !== null && ev > 0.05;
  return (
    <td className="evb-cell-wrap">
      <div className={`evb-cell${edge ? " evb-edge" : ""}`}>
        <span className="evb-price-line">
          {pointText && <span className="evb-point">{pointText}</span>}
          <strong className="evb-price">
            {oddsPrice(selection.americanOdds)}
          </strong>
        </span>
        {fair !== null && (
          <span className="evb-fair">
            fair {oddsPrice(fair)}
            {edge && ` · +${ev!.toFixed(1)}% EV`}
          </span>
        )}
      </div>
    </td>
  );
}

/**
 * Watch toggle for a board row. The explorer is public, so a session that has
 * no watchlist offers sign-in instead of failing, and a deployment without the
 * watchlist API shows no control at all. The row itself is clickable, so every
 * interaction here stops before the row's own handlers see it.
 */
function WatchToggle({
  eventId,
  matchup,
  watchlist,
}: {
  readonly eventId: string;
  readonly matchup: string;
  readonly watchlist: WatchlistControl;
}) {
  if (watchlist.availability === "unavailable") return null;
  if (watchlist.availability === "signed-out")
    return (
      <Link
        to="/watchlist"
        className="evb-watch"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        Sign in to watch
      </Link>
    );
  const watched = watchlist.isWatched(eventId);
  const busy = watchlist.pending.has(eventId);
  return (
    <button
      type="button"
      className={`evb-watch${watched ? " watching" : ""}`}
      aria-pressed={watched}
      disabled={busy || watchlist.availability === "loading"}
      aria-label={`${watched ? "Remove" : "Add"} ${matchup} ${
        watched ? "from" : "to"
      } watchlist`}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void (watched ? watchlist.remove(eventId) : watchlist.add(eventId));
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true">{watched ? "★" : "☆"}</span>{" "}
      {watched ? "Watching" : "Watch"}
    </button>
  );
}

function EventGameBlock({
  game,
  explorerSearch,
  snapshotAt,
  watchlist,
}: {
  readonly game: UiGamesPage["items"][number];
  readonly explorerSearch: ExplorerSearch;
  readonly snapshotAt: string | null | undefined;
  readonly watchlist: WatchlistControl;
}) {
  const navigate = useNavigate();
  const prices = game.odds.state === "available" ? game.odds.selections : [];
  const away = game.participants[0]?.label ?? "Unknown";
  const home = game.participants[1]?.label ?? "Unknown";
  const bySide = (marketKey: string, side: "away" | "home") => {
    const rows = prices.filter((price) => price.marketKey === marketKey);
    if (marketKey === "total")
      return rows.find(
        ({ selectionKey }) =>
          selectionKey === (side === "away" ? "over" : "under"),
      );
    return rows.find(
      ({ selectionLabel }) =>
        selectionLabel === (side === "away" ? away : home),
    );
  };
  const drawSelection = prices.find(
    ({ marketKey, selectionKey, selectionLabel }) =>
      marketKey === "moneyline" &&
      (selectionKey === "draw" || selectionLabel === "Draw"),
  );
  const openDetail = () =>
    void navigate({
      to: "/events/$gameId",
      params: { gameId: game.id },
      search: explorerSearch,
    });
  const newestRetrievedAt = prices
    .map(({ retrievedAt }) => retrievedAt)
    .sort()
    .at(-1);
  // Age is measured against the page snapshot, not the wall clock: render
  // stays pure and the number refreshes with every poll.
  const oddsAgeMinutes =
    newestRetrievedAt && snapshotAt
      ? Math.max(
          0,
          Math.round(
            (Date.parse(snapshotAt) - Date.parse(newestRetrievedAt)) / 60_000,
          ),
        )
      : null;
  const today = game.eastern.calendarDay === currentEasternDay();
  const kickoffTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(game.startsAt));
  const teamRow = (side: "away" | "home") => {
    const label = side === "away" ? away : home;
    return (
      <tr className="evb-team-row">
        <th scope="row" title={label}>
          <span className="evb-crest" aria-hidden="true">
            {teamMonogram(label, game.sportKey)}
          </span>
          <span className="evb-name">{teamNickname(label, game.sportKey)}</span>
          {side === "home" && <span className="evb-home">HOME</span>}
          {side === "away" && (
            <span className="sr-only">
              <h2>{eventMatchupLabel(game)}</h2>
              <EventMetadataBadges game={game} />
            </span>
          )}
        </th>
        {(["spread", "total", "moneyline"] as const).map((marketKey) => (
          <FairCell
            key={marketKey}
            marketKey={marketKey}
            selection={bySide(marketKey, side)}
            counterparts={[
              bySide(marketKey, side === "away" ? "home" : "away"),
              ...(marketKey === "moneyline" && drawSelection
                ? [drawSelection]
                : []),
            ].filter((value) => value !== undefined)}
          />
        ))}
      </tr>
    );
  };
  return (
    <tbody
      className="event-card evb-block"
      data-event-id={game.id}
      role="link"
      tabIndex={0}
      aria-label={`Open ${eventMatchupLabel(game)}`}
      onClick={openDetail}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetail();
        }
      }}
    >
      {game.sportKey === "soccer" ? (
        <tr className="evb-team-row">
          <th scope="row">
            <span className="evb-name evb-stacked">
              <span>{home}</span>
              <span>{away}</span>
            </span>
            <span className="sr-only">
              <h2>{eventMatchupLabel(game)}</h2>
              <EventMetadataBadges game={game} />
            </span>
          </th>
          {(
            [
              ["home", bySide("moneyline", "home")],
              ["draw", drawSelection],
              ["away", bySide("moneyline", "away")],
            ] as const
          ).map(([key, selection]) => (
            <FairCell
              key={key}
              marketKey="moneyline"
              selection={selection}
              counterparts={[
                bySide("moneyline", "home"),
                drawSelection,
                bySide("moneyline", "away"),
              ].filter(
                (value): value is NonNullable<typeof value> =>
                  value !== undefined && value !== selection,
              )}
            />
          ))}
        </tr>
      ) : (
        <>
          {teamRow("away")}
          {teamRow("home")}
        </>
      )}
      <tr className="evb-footer-row">
        <td colSpan={4}>
          <div className="evb-footer">
            <span className="evb-when">
              {today ? "Today" : gamesShortDay(game.eastern.calendarDay)} ·{" "}
              {kickoffTime} ET
            </span>
            {game.status !== "scheduled" && (
              <span className="evb-flag">· {game.status}</span>
            )}
            {(() => {
              // Pre-game collection freezes at first pitch: past kickoff the
              // numbers are closing lines, not stale quotes. Age (and the
              // stale alarm) only mean something before the start.
              const started =
                snapshotAt !== null &&
                snapshotAt !== undefined &&
                Date.parse(game.startsAt) <= Date.parse(snapshotAt);
              if (
                started &&
                game.odds.state === "available" &&
                game.odds.source === "canonical-closing"
              )
                return <span className="evb-age">· closing lines</span>;
              if (started)
                return <span className="evb-age">· pregame snapshot</span>;
              // Staleness follows the same evidence the label shows: the
              // odds rows themselves. The metadata freshness flag tracks
              // schedule evidence, which legitimately idles for hours on an
              // unchanged listing while prices refresh every minute — it
              // must never contradict a fresh odds age here.
              // Age is the time since this price last MOVED, not since we
              // last polled, so a quiet market is not a broken one. The
              // threshold matches the served freshness window used by the
              // detail cells and the board alarm.
              const oddsStale = oddsAgeMinutes !== null && oddsAgeMinutes > 120;
              return oddsAgeMinutes !== null ? (
                <span className={`evb-age${oddsStale ? " stale" : ""}`}>
                  · odds {oddsAgeMinutes}m old
                  {oddsStale && " — stale"}
                </span>
              ) : null;
            })()}
            <WatchToggle
              eventId={game.id}
              matchup={eventMatchupLabel(game)}
              watchlist={watchlist}
            />
          </div>
        </td>
      </tr>
    </tbody>
  );
}

function EventExplorerCard({
  game,
  explorerSearch,
  watchlist,
}: {
  readonly game: UiGamesPage["items"][number];
  readonly explorerSearch: ExplorerSearch;
  readonly watchlist: WatchlistControl;
}) {
  const client = useContext(GamesClientContext);
  const prices = game.odds.state === "available" ? game.odds.selections : [];
  return (
    <article className="event-explorer-card" data-event-id={game.id}>
      <p className="eyebrow">
        {game.competition.key.toUpperCase()} · {kickoffDisplay(game.startsAt)}
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
      <Link
        className="detail-link"
        to="/events/$gameId"
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
        <WatchToggle
          eventId={game.id}
          matchup={eventMatchupLabel(game)}
          watchlist={watchlist}
        />
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

  const cardRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const card = cardRef.current;
    const header = headerRef.current;
    if (!card || !header) return;
    // Fractional height: integer offsetHeight rounds under browser zoom
    // and the rounding error becomes a visible seam between sticky bars.
    const sync = () =>
      card.style.setProperty(
        "--csx-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="csx-card" ref={cardRef}>
      <span className="csx-accent" aria-hidden="true" style={{ height: 96 }} />
      <div className="csx-header" ref={headerRef}>
        <div className="csx-header-row">
          <h1 className="csx-title">Betting splits</h1>
          <span className="csx-badge">CONSENSUS</span>
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
                onClick={(event) => {
                  // The input is invisible, so a click anywhere in the chip
                  // must open the native picker rather than silently focus a
                  // date segment.
                  const input = event.currentTarget;
                  if (typeof input.showPicker === "function") {
                    try {
                      input.showPicker();
                    } catch {
                      input.focus();
                    }
                  }
                }}
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
                  aria-label={mode.label}
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
              DraftKings and Circa public-betting data combine into one
              consensus view. Compare bet percentage with handle percentage to
              spot imbalances, then confirm the signal with line movement and
              price value.
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

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return PUBLIC_ROUTES.includes(pathname) ? <Outlet /> : <AppShell />;
}

const rootRoute = createRootRouteWithContext<{
  readonly session: SessionStore;
  readonly resolveEntitlement?: UiGamesClient["entitlement"];
}>()({
  beforeLoad: ({ context, location, abortController }) =>
    requireEntitledSession(
      context.session,
      context.resolveEntitlement,
      location.pathname,
      location.searchStr,
      abortController.signal,
    ),
  component: RootLayout,
  errorComponent: AppError,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // A reader who already holds a live session has no use for the pitch.
  beforeLoad: ({ context }) => {
    if (hasLiveSession(context.session))
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: SIGNED_IN_HOME, replace: true });
  },
  component: LandingPage,
});
function SubscribeRoute() {
  const store = useContext(SessionContext);
  const session = useSession(store);
  const client = useContext(GamesClientContext);
  const router = useRouter();
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <SubscribeScreen
        client={client}
        token={session?.token ?? null}
        onSignOut={() => {
          store.signOut();
          void router.navigate({ to: "/", replace: true });
        }}
      />
    </Suspense>
  );
}
const subscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SUBSCRIBE_PATH,
  // A reader with no session at all belongs on the form, not on a paywall
  // that cannot tell them anything useful.
  beforeLoad: ({ context, location }) => {
    if (!hasLiveSession(context.session))
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({
        to: LOGIN_PATH,
        search: { returnUrl: safeReturnPath(location.pathname) },
        replace: true,
      });
  },
  component: SubscribeRoute,
});
const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: () => <PublicLegalPage kind="terms" />,
});
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: () => <PublicLegalPage kind="privacy" />,
});
function SignInRoute() {
  const { returnUrl } = useSearch({ from: "/login" });
  const router = useRouter();
  return (
    <Suspense fallback={<p role="status">Loading sign-in…</p>}>
      <SignInScreen
        client={useContext(GamesClientContext)}
        store={useContext(SessionContext)}
        from={returnUrl}
        // The form is replaced rather than pushed: going back from where the
        // reader landed must not return them to a spent code.
        onSignedIn={(path) => router.history.replace(path)}
      />
    </Suspense>
  );
}
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: LOGIN_PATH,
  // The return address is validated where it enters the app, so no component
  // ever holds a destination that is off-origin or not a route we serve.
  validateSearch: (search: Record<string, unknown>) => ({
    returnUrl: safeReturnPath(search["returnUrl"]),
  }),
  component: SignInRoute,
});
// The old address, kept so a bookmarked or emailed link still lands somewhere
// useful rather than on a 404.
const legacySignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  beforeLoad: () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({
      to: LOGIN_PATH,
      search: { returnUrl: DEFAULT_RETURN_PATH },
      replace: true,
    });
  },
  component: () => null,
});
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: DashboardRoute,
});
const gamesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/events",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  validateSearch: (search: Record<string, unknown>) => ({
    sport:
      search["sport"] === "soccer"
        ? ("soccer" as const)
        : search["sport"] === "football"
          ? ("football" as const)
          : ("mlb" as const),
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
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: SplitsExplorer,
});
function WatchlistRoute() {
  return (
    <Suspense fallback={<p role="status">Loading watchlist…</p>}>
      <Watchlist client={useContext(GamesClientContext)} />
    </Suspense>
  );
}
const watchlistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/watchlist",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: WatchlistRoute,
});
const performanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/performance",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: suspended(PerformanceDashboard),
});
const dataSourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-sources",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: DataSourcesRoute,
});
const retrospectivesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retrospectives",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: suspended(RetrospectivesList),
});
const experimentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: suspended(ExperimentsList),
});
const experimentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/experiments/$experimentId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: suspended(ExperimentDetail),
});
const retrospectiveDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/retrospectives/$versionId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: suspended(RetrospectiveDetail),
});
const gameDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/events/$gameId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  validateSearch: (search: Record<string, unknown>) => ({
    sport:
      search["sport"] === "soccer"
        ? ("soccer" as const)
        : search["sport"] === "football"
          ? ("football" as const)
          : ("mlb" as const),
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
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  component: ScoutingProgressRoute,
});
function ScoutReportRoute() {
  const { jobId } = useParams({ from: "/scout-jobs/$jobId/report" });
  const { version } = useSearch({ from: "/scout-jobs/$jobId/report" });
  const navigate = useNavigate();
  return (
    <ScoutReport
      key={jobId}
      jobId={jobId}
      versionNumber={version}
      client={useContext(GamesClientContext)}
      onSelectVersion={(versionNumber) =>
        void navigate({
          to: "/scout-jobs/$jobId/report",
          params: { jobId },
          search: { version: versionNumber },
        })
      }
    />
  );
}
const scoutReportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scout-jobs/$jobId/report",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location.pathname, location.searchStr),
  validateSearch: (search: Record<string, unknown>) => ({
    version:
      Number.isSafeInteger(Number(search["version"])) &&
      Number(search["version"]) >= 1
        ? Number(search["version"])
        : undefined,
  }),
  component: ScoutReportRoute,
});
// The catalog moved from /games to /events; old links keep resolving.
const legacyGamesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/games",
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/events", search: search as never, replace: true });
  },
});
const legacyGameDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/games/$gameId",
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ params, search }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({
      to: "/events/$gameId",
      params: { gameId: params.gameId },
      search: search as never,
      replace: true,
    });
  },
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  legacySignInRoute,
  subscribeRoute,
  termsRoute,
  privacyRoute,
  signInRoute,
  dashboardRoute,
  gamesRoute,
  gameDetailRoute,
  legacyGamesRoute,
  legacyGameDetailRoute,
  scoutingProgressRoute,
  scoutReportRoute,
  splitsRoute,
  watchlistRoute,
  performanceRoute,
  dataSourcesRoute,
  retrospectivesRoute,
  retrospectiveDetailRoute,
  experimentsRoute,
  experimentDetailRoute,
]);
const registeredRouter = createRouter({
  routeTree,
  context: { session: defaultSessionStore },
});
void registeredRouter;

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof registeredRouter;
  }
}

export function App({
  initialPath,
  gamesClient,
  sessionStore = defaultSessionStore,
  routeEntitlement,
  sessionRefresherInstalled = false,
}: {
  initialPath?: string;
  gamesClient?: GamesClientResult;
  sessionStore?: SessionStore;
  routeEntitlement?: UiGamesClient["entitlement"];
  sessionRefresherInstalled?: boolean;
}) {
  const client = gamesClient ?? defaultGamesClient;
  const resolveEntitlement =
    routeEntitlement ?? (client.ok ? client.value.entitlement : undefined);
  const [router] = useState(() =>
    createRouter({
      routeTree,
      context: { session: sessionStore, resolveEntitlement },
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
  useEffect(() => {
    // Warm today's board while the reader is elsewhere so opening splits is a
    // cache read rather than a cold round trip.
    if (client.ok && requiresSession(router.state.location.pathname))
      prefetchSplits(client.value, "mlb", currentEasternDay());
  }, [client, router]);
  const refreshSession = client.ok ? client.value.refreshSession : undefined;
  useEffect(() => {
    if (sessionRefresherInstalled) return;
    // The store renews through whatever client this deployment has; without
    // one it simply lets the token run out and signs the reader out.
    sessionStore.setRefresher(refreshSession ?? null);
    return () => sessionStore.setRefresher(null);
  }, [refreshSession, sessionRefresherInstalled, sessionStore]);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={sessionStore}>
        <GamesClientContext.Provider value={gamesClient ?? defaultGamesClient}>
          <RouterProvider router={router} />
        </GamesClientContext.Provider>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}
