// The game detail screen — line-movement chart, history table, and decision
// workbench — loads on demand so the splits landing path never parses it.
import { useContext, useEffect, useState } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { impliedProbability } from "@find-the-edge/odds";
import { buildOddsComparisonViewModel } from "@find-the-edge/ui";
import {
  GamesClientError,
  type OddsHistoryDto,
  type OddsHistorySeriesDto,
} from "./api";
import { SportsbookLogo, sportsbookMetadata } from "./sportsbooks";
import { ScoutEventButton } from "./scouting";
import { detailMatchesRoute } from "./route-state";
import {
  EventMetadataBadges,
  GamesClientContext,
  easternDisplay,
  linePoint,
  oddsCellReason,
  oddsCellTimestamp,
  oddsPrice,
  type UiGamesClient,
} from "./App";

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

export default function GameDetail() {
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
