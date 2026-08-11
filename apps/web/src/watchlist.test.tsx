import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { assessEventMetadata } from "@find-the-edge/domain";

import { Watchlist, type WatchlistClientResult } from "./watchlist";
import type { UiGamesClient, UiGamesPage } from "./App";
import {
  GamesClientError,
  parseWatchlistPage,
  type WatchlistEntryDto,
  type WatchlistPageDto,
} from "./api";

afterEach(cleanup);

const entry: WatchlistEntryDto = {
  schemaVersion: "watchlist-entry-v1",
  eventId: "event:mlb%3Amlb:fixture-1",
  eventVersion: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  startsAt: "2026-08-01T23:05:00.000Z",
  addedAt: "2026-07-30T12:00:00.000Z",
};

const watchlistPage: WatchlistPageDto = {
  schemaVersion: "watchlist-page-v1",
  items: [entry],
};

const board: UiGamesPage = {
  projectionState: "ready",
  unavailableReason: null,
  snapshotAt: "2026-08-01T12:30:00.000Z",
  freshness: "2026-08-01T12:30:00.000Z",
  items: [
    {
      id: entry.eventId,
      version: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      competition: { key: "mlb", state: "provisional" },
      startsAt: entry.startsAt,
      participants: [
        { id: "participant:mlb:boston", label: "Boston" },
        { id: "participant:mlb:new-york", label: "New York" },
      ],
      eastern: {
        timeZone: "America/New_York",
        calendarDay: "2026-08-01",
        display: "Aug 1, 2026, 7:05 PM",
      },
      status: "scheduled",
      freshness: "2026-08-01T12:30:00.000Z",
      metadata: assessEventMetadata(
        "scheduled",
        "2026-08-01T12:30:00.000Z",
        "2026-08-01T12:30:00.000Z",
      ),
      odds: {
        state: "available",
        selections: [
          {
            marketKey: "moneyline",
            selectionKey: "away",
            selectionLabel: "Boston",
            sportsbookId: "fixture-book",
            americanOdds: 120,
            observedAt: "2026-08-01T12:00:00.000Z",
            retrievedAt: "2026-08-01T12:25:00.000Z",
          },
        ],
      },
    },
  ],
};

type ClientOverrides = Partial<
  Pick<
    UiGamesClient,
    "list" | "listWatchlist" | "addToWatchlist" | "removeFromWatchlist"
  >
>;

const client = (overrides: ClientOverrides = {}): WatchlistClientResult => ({
  ok: true,
  value: {
    list: vi.fn(() => Promise.resolve(board)),
    listWatchlist: vi.fn(() => Promise.resolve(watchlistPage)),
    addToWatchlist: vi.fn(() => Promise.resolve(entry)),
    removeFromWatchlist: vi.fn(() => Promise.resolve()),
    ...overrides,
  },
});

const unavailable = () =>
  new GamesClientError(
    "request-failed",
    "The watchlist is temporarily unavailable.",
  );

it("guides an empty watchlist to the events explorer with a real link", async () => {
  render(
    <Watchlist
      client={client({
        listWatchlist: () =>
          Promise.resolve({ schemaVersion: "watchlist-page-v1", items: [] }),
      })}
    />,
  );

  expect(
    await screen.findByRole("heading", {
      name: "Nothing is on your watchlist yet",
    }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Browse events" })).toHaveAttribute(
    "href",
    "/events",
  );
});

it("shows kickoff and real odds evidence and never invents report or lineup state", async () => {
  render(<Watchlist client={client()} />);

  const row = await screen.findByRole("listitem");
  // The label appears only once the board for the watched day has resolved.
  expect(
    await within(row).findByRole("heading", { name: "Boston vs New York" }),
  ).toBeVisible();
  // Kickoff is Eastern, from the same helper the explorer uses.
  expect(within(row).getByText("Aug 1 · 7:05 PM ET")).toBeVisible();
  // Freshness is measured against the board snapshot, not the wall clock.
  expect(within(row).getByText("Odds 5 min old")).toBeVisible();
  expect(within(row).getByText(/^Odds collected Aug 1/)).toBeVisible();

  expect(within(row).getAllByText("Not connected")).toHaveLength(2);
  expect(
    within(row).getByText(
      "Reports are addressed by scouting job; there is no per-event lookup yet.",
    ),
  ).toBeVisible();
  expect(
    within(row).getByText("No lineup provider is connected."),
  ).toBeVisible();
});

it("labels odds columns as unavailable when the board cannot be loaded", async () => {
  render(
    <Watchlist
      client={client({ list: () => Promise.reject(new Error("boom")) })}
    />,
  );

  const row = await screen.findByRole("listitem");
  expect(
    await within(row).findByText("The board for this day could not be loaded."),
  ).toBeVisible();
  // With no board the matchup is the canonical id, never a guessed label.
  expect(
    within(row).getByRole("heading", { name: entry.eventId }),
  ).toBeVisible();
});

it("removes optimistically and restores the row through undo", async () => {
  const removeFromWatchlist = vi.fn(() => Promise.resolve());
  const addToWatchlist = vi.fn(() => Promise.resolve(entry));
  render(
    <Watchlist client={client({ removeFromWatchlist, addToWatchlist })} />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

  expect(await screen.findByText("Removed from your watchlist.")).toBeVisible();
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  expect(removeFromWatchlist).toHaveBeenCalledWith(
    entry.eventId,
    expect.anything(),
  );

  fireEvent.click(screen.getByRole("button", { name: "Undo" }));

  expect(await screen.findByRole("listitem")).toBeVisible();
  expect(addToWatchlist).toHaveBeenCalledWith(entry.eventId, expect.anything());
  expect(
    screen.queryByText("Removed from your watchlist."),
  ).not.toBeInTheDocument();
});

it("puts the row back and says so when the removal fails", async () => {
  render(
    <Watchlist
      client={client({
        removeFromWatchlist: () => Promise.reject(unavailable()),
      })}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

  expect(
    await screen.findByText(
      "That event could not be removed from the watchlist.",
    ),
  ).toBeVisible();
  // The row is restored in a later render than the failure message, so this
  // must wait for it rather than assume the two land in the same tick.
  expect(await screen.findByRole("listitem")).toBeVisible();
  expect(
    screen.queryByText("Removed from your watchlist."),
  ).not.toBeInTheDocument();
});

it("reports an undo that fails without pretending the event is watched", async () => {
  render(
    <Watchlist
      client={client({ addToWatchlist: () => Promise.reject(unavailable()) })}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

  expect(
    await screen.findByText(
      "That event could not be restored to your watchlist.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("asks an unauthenticated reader to sign in instead of failing", async () => {
  render(
    <Watchlist
      client={client({
        listWatchlist: () =>
          Promise.reject(
            new GamesClientError(
              "authentication",
              "Sign in is required to use the watchlist.",
            ),
          ),
      })}
    />,
  );

  expect(
    await screen.findByRole("heading", { name: "Sign in required" }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Browse events" })).toHaveAttribute(
    "href",
    "/events",
  );
});

it("fails closed on a corrupt watchlist response and shows nothing from it", async () => {
  render(
    <Watchlist
      client={client({
        // The real parser runs here: an entry whose schema version does not
        // match the published contract rejects the whole page.
        listWatchlist: () =>
          Promise.resolve().then(() =>
            parseWatchlistPage({
              schemaVersion: "watchlist-page-v1",
              items: [{ ...entry, schemaVersion: "watchlist-entry-v2" }],
            }),
          ),
      })}
    />,
  );

  expect(
    await screen.findByRole("heading", { name: "Watchlist unavailable" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "The watchlist did not match its published contract, so none of it is shown.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
});

it("recovers from a transient failure when the reader retries", async () => {
  let attempt = 0;
  const listWatchlist = vi.fn(() => {
    attempt += 1;
    return attempt === 1
      ? Promise.reject(unavailable())
      : Promise.resolve(watchlistPage);
  });
  render(<Watchlist client={client({ listWatchlist })} />);

  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

  expect(await screen.findByRole("listitem")).toBeVisible();
  expect(listWatchlist).toHaveBeenCalledTimes(2);
});
