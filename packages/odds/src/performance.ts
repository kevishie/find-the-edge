type OddsBand =
  "heavy-favorite" | "favorite" | "near-even" | "underdog" | "longshot";
type PaperGradeOutcome = "won" | "lost" | "push" | "void" | "unresolved";

export interface PerformanceDecision {
  readonly id: string;
  readonly createdAt: string;
  readonly outcome: PaperGradeOutcome;
  readonly profit: number;
  readonly americanOdds: number;
  readonly estimatedProbability: number;
  readonly closingAmericanOdds?: number;
  readonly clvUnavailableReason?: string;
}
export interface Interval {
  readonly low: number;
  readonly high: number;
}
export interface CalibrationBucket {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly meanForecast: number | null;
  readonly observedRate: number | null;
}
export interface PerformanceReportMetrics {
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
  readonly roiInterval95: Interval | null;
  readonly roiUnavailableReason: string | null;
  readonly winRate: number | null;
  readonly winRateInterval95: Interval | null;
  readonly averageDecimalOdds: number | null;
  readonly breakEvenProbability: number | null;
  readonly estimatedEv: number | null;
  readonly brierScore: number | null;
  readonly expectedCalibrationError: number | null;
  readonly calibration: readonly CalibrationBucket[];
  readonly clv: {
    readonly eligible: number;
    readonly unavailable: number;
    readonly averagePrice: number | null;
    readonly averageImpliedProbability: number | null;
    readonly unavailableReasons: Readonly<Record<string, number>>;
  };
  readonly maximumDrawdown: number;
  readonly cumulativeUnits: readonly {
    readonly id: string;
    readonly value: number;
  }[];
  readonly sampleCaution: "insufficient" | "limited" | "established";
}
export const americanToPerformanceDecimal = (odds: number) => {
  if (!Number.isFinite(odds) || Math.abs(odds) < 100)
    throw new Error("american-odds-invalid");
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
};
export const performanceImpliedProbability = (odds: number) =>
  1 / americanToPerformanceDecimal(odds);
export const oddsBand = (odds: number): OddsBand => {
  if (!Number.isInteger(odds) || Math.abs(odds) < 100)
    throw new Error("american-odds-invalid");
  if (odds <= -200) return "heavy-favorite";
  if (odds <= -110) return "favorite";
  if (odds <= 109) return "near-even";
  if (odds <= 199) return "underdog";
  return "longshot";
};
const mean = (values: readonly number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const round = (value: number) => Number(value.toFixed(12));
const meanInterval95 = (values: readonly number[]): Interval | null => {
  if (values.length < 2) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  const margin = 1.959963984540054 * Math.sqrt(variance / values.length);
  return { low: round(average - margin), high: round(average + margin) };
};
export function wilsonInterval(wins: number, total: number): Interval | null {
  if (
    !Number.isSafeInteger(wins) ||
    !Number.isSafeInteger(total) ||
    wins < 0 ||
    total < wins
  )
    throw new Error("wilson-input-invalid");
  if (!total) return null;
  const z = 1.959963984540054,
    p = wins / total,
    z2 = z * z,
    center = (p + z2 / (2 * total)) / (1 + z2 / total),
    margin =
      (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) /
      (1 + z2 / total);
  return {
    low: round(Math.max(0, center - margin)),
    high: round(Math.min(1, center + margin)),
  };
}
export function computePerformance(
  decisions: readonly PerformanceDecision[],
): PerformanceReportMetrics {
  const seen = new Set<string>();
  for (const d of decisions) {
    if (
      seen.has(d.id) ||
      !Number.isFinite(Date.parse(d.createdAt)) ||
      !Number.isFinite(d.profit) ||
      !["won", "lost", "push", "void", "unresolved"].includes(d.outcome) ||
      !(d.estimatedProbability > 0 && d.estimatedProbability < 1)
    )
      throw new Error("performance-decision-invalid");
    americanToPerformanceDecimal(d.americanOdds);
    seen.add(d.id);
  }
  const count = (outcome: PaperGradeOutcome) =>
    decisions.filter((d) => d.outcome === outcome).length;
  const won = count("won"),
    lost = count("lost"),
    push = count("push"),
    voided = count("void"),
    unresolved = count("unresolved"),
    decisionCount = won + lost,
    exposure = decisionCount + push;
  const resolved = decisions.filter((d) =>
      ["won", "lost", "push"].includes(d.outcome),
    ),
    units = round(resolved.reduce((sum, d) => sum + d.profit, 0)),
    eligible = decisions.filter(
      (d) => d.outcome === "won" || d.outcome === "lost",
    );
  const buckets = Array.from({ length: 10 }, (_, i): CalibrationBucket => {
    const values = eligible.filter(
      (d) => Math.min(9, Math.floor(d.estimatedProbability * 10)) === i,
    );
    return {
      lower: i / 10,
      upper: (i + 1) / 10,
      count: values.length,
      meanForecast: mean(values.map((d) => d.estimatedProbability)),
      observedRate: mean(values.map((d) => (d.outcome === "won" ? 1 : 0))),
    };
  });
  const brier = mean(
      eligible.map(
        (d) => (d.estimatedProbability - (d.outcome === "won" ? 1 : 0)) ** 2,
      ),
    ),
    ece = decisionCount
      ? buckets.reduce(
          (sum, b) =>
            sum +
            (b.count / decisionCount) *
              Math.abs((b.observedRate ?? 0) - (b.meanForecast ?? 0)),
          0,
        )
      : null;
  const clv = decisions.flatMap((d) =>
    d.closingAmericanOdds === undefined
      ? []
      : [
          {
            price:
              americanToPerformanceDecimal(d.americanOdds) /
                americanToPerformanceDecimal(d.closingAmericanOdds) -
              1,
            probability:
              performanceImpliedProbability(d.closingAmericanOdds) -
              performanceImpliedProbability(d.americanOdds),
          },
        ],
  );
  const unavailableReasons = Object.fromEntries(
    [
      ...new Set(
        decisions.flatMap((decision) =>
          decision.closingAmericanOdds === undefined
            ? [decision.clvUnavailableReason ?? "closing-price-missing"]
            : [],
        ),
      ),
    ]
      .sort()
      .map((reason) => [
        reason,
        decisions.filter(
          (decision) =>
            decision.closingAmericanOdds === undefined &&
            (decision.clvUnavailableReason ?? "closing-price-missing") ===
              reason,
        ).length,
      ]),
  );
  let running = 0,
    peak = 0,
    maximumDrawdown = 0;
  const cumulativeUnits = [...resolved]
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    .map((d) => {
      running += d.profit;
      peak = Math.max(peak, running);
      maximumDrawdown = Math.max(maximumDrawdown, peak - running);
      return { id: d.id, value: round(running) };
    });
  return {
    counts: {
      source: decisions.length,
      won,
      lost,
      push,
      void: voided,
      unresolved,
      decisions: decisionCount,
      resolvedExposure: exposure,
    },
    units,
    roi: exposure ? round(units / exposure) : null,
    roiInterval95: meanInterval95(resolved.map((decision) => decision.profit)),
    roiUnavailableReason: exposure ? null : "no-resolved-exposure",
    winRate: decisionCount ? round(won / decisionCount) : null,
    winRateInterval95: wilsonInterval(won, decisionCount),
    averageDecimalOdds: mean(
      decisions.map((d) => americanToPerformanceDecimal(d.americanOdds)),
    ),
    breakEvenProbability: mean(
      decisions.map((d) => performanceImpliedProbability(d.americanOdds)),
    ),
    estimatedEv: mean(
      decisions.map((d) =>
        round(
          d.estimatedProbability *
            americanToPerformanceDecimal(d.americanOdds) -
            1,
        ),
      ),
    ),
    brierScore: brier === null ? null : round(brier),
    expectedCalibrationError: ece === null ? null : round(ece),
    calibration: buckets,
    clv: {
      eligible: clv.length,
      unavailable: decisions.length - clv.length,
      averagePrice: mean(clv.map((v) => v.price)),
      averageImpliedProbability: mean(clv.map((v) => v.probability)),
      unavailableReasons,
    },
    maximumDrawdown: round(maximumDrawdown),
    cumulativeUnits,
    sampleCaution:
      decisionCount < 30
        ? "insufficient"
        : decisionCount < 100
          ? "limited"
          : "established",
  };
}
