import type { ClosingLinesRecord } from "./closing-lines.js";

export const CLV_RESULT_SCHEMA_VERSION = "clv-result-v1" as const;

/** A qualified opportunity's entry, recorded at evaluation time so closing
 * line value can be measured when the game's closing record lands. */
export interface ClvEntry {
  readonly logicalOpportunityId: string;
  readonly canonicalEventId: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly point: number | null;
  readonly entryAmericanOdds: number;
  /** Consensus fair probability at entry, for context alongside the close. */
  readonly entryFairProbability: number | null;
  readonly evaluatedAt: string;
}

export interface ClvResult extends ClvEntry {
  readonly schemaVersion: typeof CLV_RESULT_SCHEMA_VERSION;
  readonly closingFairProbability: number;
  /** Whether the closing fair de-vigs the sharp anchor or the display book. */
  readonly closingSource: "sharp-anchor" | "display-book";
  /** EV of the entry price against the closing fair probability — positive
   * means the entry beat the close. */
  readonly clvPercent: number;
  readonly closingCapturedAt: string;
}

const americanToDecimal = (odds: number): number => {
  if (
    !Number.isInteger(odds) ||
    Math.abs(odds) < 100 ||
    Math.abs(odds) > 100_000
  )
    throw new Error("clv-american-odds-invalid");
  return odds > 0 ? odds / 100 + 1 : 100 / -odds + 1;
};
const americanToProbability = (odds: number): number =>
  odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);

const instantValid = (value: string): boolean =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Scores an entry against the game's closing record. Returns null when the
 * closing market no longer matches the entry's proposition (line moved,
 * market absent) — a skipped measurement, never a fabricated one. */
export function computeClvResult(
  entry: ClvEntry,
  closing: ClosingLinesRecord,
): ClvResult | null {
  if (
    !entry.logicalOpportunityId ||
    entry.canonicalEventId !== closing.canonicalEventId ||
    entry.sportKey !== closing.sportKey ||
    !entry.marketKey ||
    !entry.selectionKey ||
    !instantValid(entry.evaluatedAt) ||
    Date.parse(entry.evaluatedAt) > Date.parse(closing.capturedAt) ||
    (entry.entryFairProbability !== null &&
      (!Number.isFinite(entry.entryFairProbability) ||
        entry.entryFairProbability <= 0 ||
        entry.entryFairProbability >= 1))
  )
    throw new Error("clv-entry-invalid");
  americanToDecimal(entry.entryAmericanOdds);
  const market = closing.selections.filter(
    (selection) => selection.marketKey === entry.marketKey,
  );
  const self = market.find(
    (selection) =>
      selection.selectionKey === entry.selectionKey &&
      (selection.point ?? null) === entry.point,
  );
  if (!self || market.length < 2) return null;
  if (market.length > 3) return null;
  const anchored = market.every(
    (selection) => selection.sharpAmericanOdds !== undefined,
  );
  const price = (selection: (typeof market)[number]) =>
    anchored ? selection.sharpAmericanOdds! : selection.americanOdds;
  const total = market.reduce(
    (sum, selection) => sum + americanToProbability(price(selection)),
    0,
  );
  if (!(total > 0)) return null;
  const closingFairProbability = americanToProbability(price(self)) / total;
  const clvPercent =
    (closingFairProbability * americanToDecimal(entry.entryAmericanOdds) - 1) *
    100;
  return Object.freeze({
    ...entry,
    schemaVersion: CLV_RESULT_SCHEMA_VERSION,
    closingFairProbability,
    closingSource: anchored ? "sharp-anchor" : "display-book",
    clvPercent,
    closingCapturedAt: closing.capturedAt,
  });
}

/** Stored results are re-derived from their own embedded inputs; drifted
 * math fails closed. The closing record itself is separately immutable. */
export function normalizeClvResult(stored: ClvResult): ClvResult {
  if (
    stored.schemaVersion !== CLV_RESULT_SCHEMA_VERSION ||
    !instantValid(stored.closingCapturedAt) ||
    !Number.isFinite(stored.closingFairProbability) ||
    stored.closingFairProbability <= 0 ||
    stored.closingFairProbability >= 1 ||
    (stored.closingSource !== "sharp-anchor" &&
      stored.closingSource !== "display-book") ||
    !Number.isFinite(stored.clvPercent)
  )
    throw new Error("stored-clv-result-invalid");
  const expected =
    (stored.closingFairProbability *
      americanToDecimal(stored.entryAmericanOdds) -
      1) *
    100;
  if (Math.abs(expected - stored.clvPercent) > 1e-9)
    throw new Error("stored-clv-result-invalid");
  return stored;
}
