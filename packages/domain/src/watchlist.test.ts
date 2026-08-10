import { describe, expect, it } from "vitest";
import {
  WATCHLIST_ENTRY_SCHEMA_VERSION,
  compareWatchlistEntries,
  createWatchlistEntry,
  normalizeWatchlistEntry,
  type WatchlistEntry,
  type WatchlistEntryInput,
} from "./watchlist.js";

const input = (
  overrides: Partial<WatchlistEntryInput> = {},
): WatchlistEntryInput => ({
  requesterId: "user-1",
  canonicalEventId: "event:mlb%3Amlb:game-1",
  canonicalEventVersion: 3,
  sportKey: "mlb",
  leagueKey: "mlb",
  startsAt: "2026-08-11T23:05:00.000Z",
  addedAt: "2026-08-10T12:00:00.000Z",
  ...overrides,
});

describe("watchlist entry", () => {
  it("creates a frozen entry that keeps the canonical identity verbatim", () => {
    const entry = createWatchlistEntry(input());
    expect(entry).toEqual({
      schemaVersion: WATCHLIST_ENTRY_SCHEMA_VERSION,
      requesterId: "user-1",
      canonicalEventId: "event:mlb%3Amlb:game-1",
      canonicalEventVersion: 3,
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: "2026-08-11T23:05:00.000Z",
      addedAt: "2026-08-10T12:00:00.000Z",
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("drops fields the contract does not define", () => {
    const entry = createWatchlistEntry({
      ...input(),
      note: "not part of the contract",
    } as WatchlistEntryInput);
    expect(Object.keys(entry).sort()).toEqual([
      "addedAt",
      "canonicalEventId",
      "canonicalEventVersion",
      "leagueKey",
      "requesterId",
      "schemaVersion",
      "sportKey",
      "startsAt",
    ]);
  });

  it("rejects every bounded field with a stable code", () => {
    const cases: readonly [Partial<WatchlistEntryInput>, string][] = [
      [{ requesterId: "" }, "watchlist-requester-invalid"],
      [{ requesterId: "a b" }, "watchlist-requester-invalid"],
      [{ requesterId: "x".repeat(257) }, "watchlist-requester-invalid"],
      [{ canonicalEventId: "" }, "watchlist-event-id-invalid"],
      [{ canonicalEventId: "event:MLB:game-1" }, "watchlist-event-id-invalid"],
      [{ canonicalEventId: "event:mlb:%zz" }, "watchlist-event-id-invalid"],
      [{ canonicalEventId: "x".repeat(513) }, "watchlist-event-id-invalid"],
      [{ canonicalEventVersion: 0 }, "watchlist-event-version-invalid"],
      [{ canonicalEventVersion: 1.5 }, "watchlist-event-version-invalid"],
      [{ sportKey: "" }, "watchlist-sport-invalid"],
      [{ sportKey: "MLB" }, "watchlist-sport-invalid"],
      [{ leagueKey: "-mls" }, "watchlist-league-invalid"],
      [{ startsAt: "2026-08-11" }, "watchlist-starts-at-invalid"],
      [{ startsAt: "not-a-time" }, "watchlist-starts-at-invalid"],
      [{ addedAt: "2026-08-10T12:00:00Z" }, "watchlist-added-at-invalid"],
    ];
    for (const [overrides, code] of cases)
      expect(() => createWatchlistEntry(input(overrides))).toThrow(code);
  });

  it("re-derives stored entries and rejects foreign or corrupt shapes", () => {
    const entry = createWatchlistEntry(input());
    expect(normalizeWatchlistEntry({ ...entry })).toEqual(entry);
    for (const corrupt of [
      { ...entry, schemaVersion: "watchlist-entry-v0" },
      null,
      [entry],
    ])
      expect(() =>
        normalizeWatchlistEntry(corrupt as unknown as WatchlistEntry),
      ).toThrow("stored-watchlist-entry-invalid");
    expect(() =>
      normalizeWatchlistEntry({
        ...entry,
        startsAt: "yesterday",
      }),
    ).toThrow("watchlist-starts-at-invalid");
  });

  it("orders by kickoff then canonical id", () => {
    const early = createWatchlistEntry(
      input({ startsAt: "2026-08-11T18:00:00.000Z" }),
    );
    const lateA = createWatchlistEntry(
      input({ canonicalEventId: "event:mlb%3Amlb:a" }),
    );
    const lateB = createWatchlistEntry(
      input({ canonicalEventId: "event:mlb%3Amlb:b" }),
    );
    expect([lateB, early, lateA].sort(compareWatchlistEntries)).toEqual([
      early,
      lateA,
      lateB,
    ]);
    expect(compareWatchlistEntries(lateA, lateA)).toBe(0);
  });
});
