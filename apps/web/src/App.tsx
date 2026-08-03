import {
  createContext,
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
  readonly items: readonly {
    readonly id: string;
    readonly sportKey: string;
    readonly startsAt: string;
    readonly participants: readonly { readonly label: string }[];
    readonly eastern: { readonly display: string };
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
          readonly scope?: string;
        }[];
      })[];
    }
  >;
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
          <span>Performance</span>
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
            No {sportLabels[sport]} games are scheduled for this day.
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
            const moneylineMarket =
              game.sportKey === "soccer" ? "three_way_moneyline" : "moneyline";
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
                {moneylineMarket === "three_way_moneyline" &&
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
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | {
        readonly kind: "ready";
        readonly items: Awaited<
          ReturnType<NonNullable<UiGamesClient["listSplits"]>>
        >["items"];
      }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (!client.ok || !client.value.listSplits) {
        setState({
          kind: "error",
          message: "Betting splits are not configured yet.",
        });
        return;
      }
      try {
        const page = await client.value.listSplits(
          { sport, day },
          controller.signal,
        );
        if (!controller.signal.aborted)
          setState({ kind: "ready", items: page.items });
      } catch {
        if (!controller.signal.aborted)
          setState({
            kind: "error",
            message: "Betting splits are temporarily unavailable.",
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
          <p className="eyebrow">PUBLIC MONEY · FIVE-MINUTE UPDATES</p>
          <h1>Betting splits</h1>
          <p className="lede">
            Compare ticket percentage with money percentage from SharpAPI's
            consensus public-betting feed.
          </p>
        </div>
        <span className="maturity beta">SharpAPI Pro</span>
      </header>
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
              setDay(event.currentTarget.value);
            }}
          />
        </label>
      </section>
      <div className="games-status" aria-live="polite">
        {state.kind === "loading" && <p>Loading splits…</p>}
        {state.kind === "error" && <p role="alert">{state.message}</p>}
        {state.kind === "ready" &&
          !state.items.some((item) => item.splits.length) && (
            <p>No splits are available for these games yet.</p>
          )}
      </div>
      {state.kind === "ready" && (
        <section className="splits-list" aria-label="Betting splits">
          {state.items
            .filter((game) => game.splits.length > 0)
            .map((game) => (
              <article className="split-card" key={game.id}>
                <div className="event-meta">
                  <span>{easternDisplay(game.startsAt)} Eastern</span>
                  <span>{game.splits[0]?.scope ?? "SharpAPI"}</span>
                </div>
                <h2>
                  {game.participants.map(({ label }) => label).join(" vs ")}
                </h2>
                <Link
                  className="detail-link"
                  to="/games/$gameId"
                  params={{ gameId: game.id }}
                  search={{ sport, day }}
                >
                  View game details
                </Link>
                <div className="market-scroll" tabIndex={0}>
                  <table className="split-board">
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th>Side</th>
                        <th>Bets</th>
                        <th>Money</th>
                        <th>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {game.splits.map((split) => {
                        const gap =
                          split.moneyPercent === undefined ||
                          split.betPercent === undefined
                            ? undefined
                            : split.moneyPercent - split.betPercent;
                        return (
                          <tr key={split.id}>
                            <td>{split.marketKey}</td>
                            <td>
                              {split.selectionKey}
                              {split.point === undefined
                                ? ""
                                : ` ${linePoint(split.point)}`}
                            </td>
                            <td>{split.betPercent?.toFixed(0) ?? "—"}%</td>
                            <td>{split.moneyPercent?.toFixed(0) ?? "—"}%</td>
                            <td className={(gap ?? 0) >= 10 ? "sharp-gap" : ""}>
                              {gap === undefined
                                ? "—"
                                : `${gap > 0 ? "+" : ""}${gap.toFixed(0)} pts`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
        </section>
      )}
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
