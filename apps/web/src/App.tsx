import { useMemo, useState } from "react";

import {
  evaluateEdge,
  removeVig,
  type EdgeEvaluation,
} from "@find-the-edge/odds";

const reasonLabels: Record<string, string> = {
  "positive-ev": "Qualified positive EV",
  "ev-below-threshold": "EV below 2% floor",
  "insufficient-books": "Fewer than 3 comparison books",
  "stale-price": "Price older than 15 minutes",
  "lineup-unconfirmed": "Official lineup required inside 60 minutes",
  "public-fade": "80%+ public tickets without overwhelming edge",
  "unsupported-market": "Market outside MLB ML / starter K rules",
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
    market: "mlb-moneyline",
    comparisonBooks: form.bookCount,
    priceAgeMinutes: form.priceAge,
    lineupConfirmed: form.lineupConfirmed,
    minutesToStart: form.minutesToStart,
    publicTicketPercent: form.publicTickets,
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

export function App() {
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
          <a className="active" href="#edge-lab">
            Edge Lab
          </a>
          <span>Today&apos;s Board</span>
          <span>Scout Reports</span>
          <span>Performance</span>
        </nav>
        <div className="model-card">
          <span>ACTIVE MODEL</span>
          <strong>MLB v2.1</strong>
          <small>edge-calculation-v1</small>
        </div>
      </aside>

      <main>
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
              Demo fair probability removes vig from this two-way pair.
              Production consensus will use independent, weighted comparison
              books and exclude the offered book.
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
                      <strong>
                        {american(result.evaluation.fairAmerican)}
                      </strong>
                    </div>
                    <div className="ev">
                      <span>Estimated EV</span>
                      <strong>
                        {percent(result.evaluation.expectedValue)}
                      </strong>
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

        <footer>
          Informational decision support only. No bet placement, guarantees, or
          hidden model arithmetic.
        </footer>
      </main>
    </div>
  );
}
