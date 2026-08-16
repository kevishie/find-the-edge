import type { GameOddsSelectionDto } from "./index.js";

export const CLOSING_LINES_SCHEMA_VERSION = "closing-lines-v1" as const;
export const CLOSING_BOOK_SCHEMA_VERSION = "closing-book-v1" as const;

/** How long after the claimed start a capture still counts as closing: the
 * provider drops started games from its odds feed, so served rows freeze at
 * their final pre-start values and remain the closing lines throughout. */
export const CLOSING_CAPTURE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** SharpAPI retains canonical closing snapshots for 48 hours after start. */
export const CLOSING_RETRIEVAL_WINDOW_MS = 48 * 60 * 60 * 1000;

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

export type ClosingCaptureTrigger =
  "transition" | "kickoff" | "disappearance" | "evict" | "backfill";

export interface ClosingBookSelection extends GameOddsSelectionDto {
  readonly providerMarketId?: string;
  readonly providerSelectionId?: string;
  readonly canonicalKey?: string;
  readonly decimalOdds?: number;
  readonly impliedProbability?: number;
  readonly noVigProbability?: number;
  readonly fairCloseDecimal?: number;
  readonly closingProbability?: number;
}

/** One provider-authored, independently finalized sportsbook close. Books
 * transition at different times, so this is the durable unit of immutability. */
export interface ClosingBookRecord {
  readonly schemaVersion: typeof CLOSING_BOOK_SCHEMA_VERSION;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly providerId: "sharpapi";
  readonly providerEventId: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly sportsbookId: string;
  readonly providerSportsbookId: string;
  readonly capturedAt: string;
  readonly secondsBeforeKickoff?: number;
  readonly retrievedAt: string;
  readonly captureTrigger: ClosingCaptureTrigger;
  readonly isFinal: true;
  readonly selections: readonly ClosingBookSelection[];
}

/** Exact provider binding retained while the schedule row is still available. */
export interface ClosingEventBinding {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly providerId: "sharpapi";
  readonly providerEventId: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly observedAt: string;
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
  if (
    offset < -CLOSING_CAPTURE_WINDOW_MS ||
    offset > CLOSING_RETRIEVAL_WINDOW_MS
  )
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

const boundedIdentity = (value: string, maximum = 512) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value;

export function normalizeClosingEventBinding(
  input: ClosingEventBinding,
): ClosingEventBinding {
  if (
    !boundedIdentity(input.canonicalEventId) ||
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1 ||
    input.providerId !== "sharpapi" ||
    !boundedIdentity(input.providerEventId, 256) ||
    !boundedIdentity(input.sportKey, 64) ||
    !boundedIdentity(input.leagueKey, 128)
  )
    throw new Error("closing-binding-identity-invalid");
  instant(input.startsAt, "closing-binding-time-invalid");
  instant(input.observedAt, "closing-binding-time-invalid");
  return Object.freeze({ ...input });
}

export function normalizeClosingBookRecord(
  input: ClosingBookRecord,
): ClosingBookRecord {
  if (
    input.schemaVersion !== CLOSING_BOOK_SCHEMA_VERSION ||
    !boundedIdentity(input.canonicalEventId) ||
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1 ||
    input.providerId !== "sharpapi" ||
    !boundedIdentity(input.providerEventId, 256) ||
    !boundedIdentity(input.sportKey, 64) ||
    !boundedIdentity(input.leagueKey, 128) ||
    !boundedIdentity(input.sportsbookId, 128) ||
    !boundedIdentity(input.providerSportsbookId, 128) ||
    (input.secondsBeforeKickoff !== undefined &&
      (!Number.isSafeInteger(input.secondsBeforeKickoff) ||
        Math.abs(input.secondsBeforeKickoff) > 7 * 24 * 60 * 60)) ||
    input.isFinal !== true ||
    !["transition", "kickoff", "disappearance", "evict", "backfill"].includes(
      input.captureTrigger,
    )
  )
    throw new Error("closing-book-identity-invalid");
  instant(input.startsAt, "closing-book-time-invalid");
  instant(input.capturedAt, "closing-book-time-invalid");
  instant(input.retrievedAt, "closing-book-time-invalid");
  if (
    Date.parse(input.capturedAt) > Date.parse(input.retrievedAt) ||
    Math.abs(Date.parse(input.capturedAt) - Date.parse(input.startsAt)) >
      CLOSING_RETRIEVAL_WINDOW_MS
  )
    throw new Error("closing-book-time-invalid");
  if (input.selections.length < 2 || input.selections.length > 64)
    throw new Error("closing-book-selections-invalid");
  const identities = new Set<string>();
  const selections = input.selections.map((selection) => {
    if (
      selection.sportsbookId !== input.sportsbookId ||
      !boundedIdentity(selection.marketKey, 64) ||
      !boundedIdentity(selection.selectionKey) ||
      (selection.selectionLabel !== undefined &&
        !boundedIdentity(selection.selectionLabel, 256)) ||
      !Number.isInteger(selection.americanOdds) ||
      Math.abs(selection.americanOdds) < 100 ||
      Math.abs(selection.americanOdds) > 100_000 ||
      (selection.point !== undefined && !Number.isFinite(selection.point))
    )
      throw new Error("closing-book-selection-invalid");
    if (
      (selection.providerMarketId !== undefined &&
        !boundedIdentity(selection.providerMarketId, 512)) ||
      (selection.providerSelectionId !== undefined &&
        !boundedIdentity(selection.providerSelectionId, 512)) ||
      (selection.canonicalKey !== undefined &&
        !boundedIdentity(selection.canonicalKey, 1_024)) ||
      [
        selection.decimalOdds,
        selection.impliedProbability,
        selection.noVigProbability,
        selection.fairCloseDecimal,
        selection.closingProbability,
      ].some((value) => value !== undefined && !Number.isFinite(value))
    )
      throw new Error("closing-book-source-selection-invalid");
    instant(selection.observedAt, "closing-book-selection-invalid");
    instant(selection.retrievedAt, "closing-book-selection-invalid");
    if (
      Date.parse(selection.observedAt) > Date.parse(input.capturedAt) ||
      Date.parse(selection.retrievedAt) !== Date.parse(input.retrievedAt)
    )
      throw new Error("closing-book-selection-time-invalid");
    const identity = `${selection.marketKey}\u0000${selection.selectionKey}`;
    if (identities.has(identity))
      throw new Error("closing-book-selection-duplicate");
    identities.add(identity);
    const { sharpAmericanOdds: ignoredAnchor, ...sourceSelection } = selection;
    void ignoredAnchor;
    return Object.freeze(sourceSelection);
  });
  const byMarket = new Map<string, typeof selections>();
  for (const selection of selections) {
    const rows = byMarket.get(selection.marketKey) ?? [];
    byMarket.set(selection.marketKey, [...rows, selection]);
  }
  const participantKey = (value: string) =>
    value.startsWith("participant:") && value.length > "participant:".length;
  for (const [marketKey, rows] of byMarket) {
    const keys = new Set(rows.map(({ selectionKey }) => selectionKey));
    const points = rows.map(({ point }) => point);
    const valid =
      marketKey === "moneyline"
        ? points.every((point) => point === undefined) &&
          (input.sportKey === "soccer"
            ? rows.length === 3 &&
              keys.has("draw") &&
              rows.filter(({ selectionKey }) => participantKey(selectionKey))
                .length === 2
            : rows.length === 2 &&
              rows.every(({ selectionKey }) => participantKey(selectionKey)))
        : marketKey === "spread"
          ? rows.length === 2 &&
            rows.every(
              ({ selectionKey, point }) =>
                participantKey(selectionKey) && point !== undefined,
            ) &&
            Math.abs((points[0] ?? Number.NaN) + (points[1] ?? Number.NaN)) <=
              1e-9
          : marketKey === "total"
            ? rows.length === 2 &&
              keys.has("over") &&
              keys.has("under") &&
              points[0] !== undefined &&
              points[0] === points[1]
            : false;
    if (!valid) throw new Error("closing-book-market-invalid");
  }
  return Object.freeze({ ...input, selections: Object.freeze(selections) });
}
