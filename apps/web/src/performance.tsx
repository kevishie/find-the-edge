// The performance report screen loads on demand.
import { useContext, useEffect, useState } from "react";
import { GamesClientContext, easternDisplay, type UiGamesClient } from "./App";
export default function PerformanceDashboard() {
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
