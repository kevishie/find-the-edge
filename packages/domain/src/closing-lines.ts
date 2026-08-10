import type { GameOddsSelectionDto } from "./index.js";

export const CLOSING_LINES_SCHEMA_VERSION = "closing-lines-v1" as const;

/** How long after the claimed start a capture still counts as closing: the
 * provider drops started games from its odds feed, so served rows freeze at
 * their final pre-start values and remain the closing lines throughout. */
export const CLOSING_CAPTURE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Immutable record of the last served prices for a game at its start.
 * Written once per canonical event; never updated, never recomputed. */
export interface ClosingLinesRecord {
  readonly schemaVersion: typeof CLOSING_LINES_SCHEMA_VERSION;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly capturedAt: string;
  readonly selections: readonly GameOddsSelectionDto[];
}

const instant = (value: string, reason: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(reason);
  return value;
};

export function createClosingLinesRecord(input: {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly capturedAt: string;
  readonly selections: readonly GameOddsSelectionDto[];
}): ClosingLinesRecord {
  if (
    !input.canonicalEventId ||
    !input.sportKey ||
    !input.leagueKey ||
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1
  )
    throw new Error("closing-lines-identity-invalid");
  instant(input.startsAt, "closing-lines-starts-at-invalid");
  instant(input.capturedAt, "closing-lines-captured-at-invalid");
  const offset = Date.parse(input.capturedAt) - Date.parse(input.startsAt);
  if (offset < 0 || offset > CLOSING_CAPTURE_WINDOW_MS)
    throw new Error("closing-lines-capture-window-invalid");
  if (input.selections.length === 0 || input.selections.length > 64)
    throw new Error("closing-lines-selections-invalid");
  const selections = input.selections.map((selection) => {
    if (
      !selection.marketKey ||
      !selection.selectionKey ||
      !selection.sportsbookId ||
      !Number.isInteger(selection.americanOdds) ||
      Math.abs(selection.americanOdds) < 100 ||
      Math.abs(selection.americanOdds) > 100_000 ||
      (selection.point !== undefined && !Number.isFinite(selection.point)) ||
      (selection.sharpAmericanOdds !== undefined &&
        (!Number.isInteger(selection.sharpAmericanOdds) ||
          Math.abs(selection.sharpAmericanOdds) < 100 ||
          Math.abs(selection.sharpAmericanOdds) > 100_000))
    )
      throw new Error("closing-lines-selection-invalid");
    instant(selection.observedAt, "closing-lines-selection-invalid");
    instant(selection.retrievedAt, "closing-lines-selection-invalid");
    if (Date.parse(selection.observedAt) > Date.parse(input.capturedAt))
      throw new Error("closing-lines-selection-from-future");
    return Object.freeze({ ...selection });
  });
  return Object.freeze({
    schemaVersion: CLOSING_LINES_SCHEMA_VERSION,
    canonicalEventId: input.canonicalEventId,
    canonicalEventVersion: input.canonicalEventVersion,
    sportKey: input.sportKey,
    leagueKey: input.leagueKey,
    startsAt: input.startsAt,
    capturedAt: input.capturedAt,
    selections: Object.freeze(selections),
  });
}

/** Stored records are re-validated, never trusted. */
export function normalizeClosingLinesRecord(
  stored: ClosingLinesRecord,
): ClosingLinesRecord {
  if (stored.schemaVersion !== CLOSING_LINES_SCHEMA_VERSION)
    throw new Error("stored-closing-lines-invalid");
  return createClosingLinesRecord(stored);
}
