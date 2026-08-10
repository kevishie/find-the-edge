import {
  assertScoutingEventId,
  assertScoutingRequesterId,
} from "./scouting-job.js";

export const WATCHLIST_ENTRY_SCHEMA_VERSION = "watchlist-entry-v1" as const;

/**
 * One user's claim on one canonical event. The entry is a snapshot of the
 * event's identity at the moment it was watched: the version, sport, league,
 * and kickoff are captured so the watchlist can be listed, ordered, and
 * rendered without joining back to the event projection, and so a later
 * canonical rewrite is visible as a difference rather than silently applied.
 *
 * `addedAt` is first-write-wins: re-adding an already watched event never
 * moves it, so the list keeps a stable, honest "since when" for the user.
 */
export interface WatchlistEntry {
  readonly schemaVersion: typeof WATCHLIST_ENTRY_SCHEMA_VERSION;
  readonly requesterId: string;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly addedAt: string;
}

export interface WatchlistEntryInput {
  readonly requesterId: string;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly addedAt: string;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const instant = (value: unknown, code: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(code);
  return value;
};

const key = (value: unknown, code: string): string => {
  if (typeof value !== "string" || !KEY.test(value)) throw new Error(code);
  return value;
};

/** The requester is always the authenticated subject, never client input. */
export const assertWatchlistRequesterId = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("watchlist-requester-invalid");
  try {
    return assertScoutingRequesterId(value);
  } catch {
    throw new Error("watchlist-requester-invalid");
  }
};

/**
 * Canonical event ids embed percent sequences, so the watchlist reuses the
 * canonical grammar rather than a looser one: an id that survives a decode
 * round trip here is the same id the event projection stores.
 */
export const assertWatchlistEventId = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("watchlist-event-id-invalid");
  try {
    return assertScoutingEventId(value);
  } catch {
    throw new Error("watchlist-event-id-invalid");
  }
};

export function createWatchlistEntry(
  input: WatchlistEntryInput,
): WatchlistEntry {
  if (
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1
  )
    throw new Error("watchlist-event-version-invalid");
  return Object.freeze({
    schemaVersion: WATCHLIST_ENTRY_SCHEMA_VERSION,
    requesterId: assertWatchlistRequesterId(input.requesterId),
    canonicalEventId: assertWatchlistEventId(input.canonicalEventId),
    canonicalEventVersion: input.canonicalEventVersion,
    sportKey: key(input.sportKey, "watchlist-sport-invalid"),
    leagueKey: key(input.leagueKey, "watchlist-league-invalid"),
    startsAt: instant(input.startsAt, "watchlist-starts-at-invalid"),
    addedAt: instant(input.addedAt, "watchlist-added-at-invalid"),
  });
}

/** Stored entries are re-derived, never trusted. */
export function normalizeWatchlistEntry(
  stored: WatchlistEntry,
): WatchlistEntry {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    stored.schemaVersion !== WATCHLIST_ENTRY_SCHEMA_VERSION
  )
    throw new Error("stored-watchlist-entry-invalid");
  return createWatchlistEntry(stored);
}

/**
 * Deterministic list order: soonest kickoff first, ties broken by the
 * canonical id so two clients never disagree about the ordering.
 */
export const compareWatchlistEntries = (
  left: WatchlistEntry,
  right: WatchlistEntry,
): number =>
  left.startsAt.localeCompare(right.startsAt) ||
  left.canonicalEventId.localeCompare(right.canonicalEventId);
