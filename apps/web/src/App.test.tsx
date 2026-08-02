import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { GamesClientError, type GamesClient, type GamesPageDto } from "./api";

const game = {
  id: "event:mlb%3Amlb:fixture-1",
  version: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  competition: { key: "mlb", state: "provisional" },
  participants: [
    { id: "participant:mlb:boston", label: "Boston" },
    { id: "participant:mlb:new-york", label: "New York" },
  ],
  startsAt: "2026-08-01T23:05:00.000Z",
  eastern: {
    timeZone: "America/New_York",
    calendarDay: "2026-08-01",
    display: "Aug 1, 2026, 7:05 PM",
  },
  status: "scheduled",
  freshness: "2026-08-01T12:30:00.000Z",
  odds: {
    state: "available",
    selections: [
      {
        marketKey: "moneyline",
        selectionKey: "away",
        selectionLabel: "Boston",
        sportsbookId: "fixture-book",
        sportsbookLabel: "Fixture Book",
        americanOdds: 120,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:00.000Z",
      },
    ],
  },
} as const;

const page = (items: GamesPageDto["items"] = [game]): GamesPageDto => ({
  items,
  nextCursor: null,
  projectionState: "ready",
  evaluationState: "complete",
  hasMoreUnknown: false,
  snapshotAt: "2026-08-01T12:30:00.000Z",
  freshness: "2026-08-01T12:30:00.000Z",
});

describe("Edge Lab", () => {
  it("shows a qualified value decision for the default fixture", async () => {
    render(<App initialPath="/" />);
    expect(await screen.findByText("QUALIFIED PLAY")).toBeInTheDocument();
    expect(screen.getByText("Qualified positive EV")).toBeInTheDocument();
  });

  it("turns public concentration into an auditable no-bet", async () => {
    render(<App initialPath="/" />);
    await screen.findByText("QUALIFIED PLAY");
    fireEvent.change(screen.getByLabelText("Public ticket %"), {
      target: { value: "84" },
    });
    expect(screen.getByText("NO BET")).toBeInTheDocument();
    expect(
      screen.getByText("80%+ public tickets without overwhelming edge"),
    ).toBeInTheDocument();
  });
});

describe("Games", () => {
  it("renders fixture odds and filters by sport and Eastern day", async () => {
    const list = vi
      .fn<GamesClient["list"]>()
      .mockImplementation(({ sport }) =>
        Promise.resolve(sport === "mlb" ? page() : page([])),
      );
    render(
      <App initialPath="/games" gamesClient={{ ok: true, value: { list } }} />,
    );

    expect(
      await screen.findByRole("heading", { name: "Boston vs New York" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+120")).toBeInTheDocument();
    expect(
      screen.getByText("Aug 1, 2026, 7:05 PM Eastern"),
    ).toBeInTheDocument();
    const price = screen.getByText("+120");
    expect(price.closest(".odds-selection")).toHaveTextContent(
      "Observed Aug 1, 2026, 8:00 AM Eastern",
    );
    fireEvent.click(screen.getByRole("button", { name: "MLB" }));
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading games…")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "MLS" }));
    expect(
      screen.queryByRole("heading", { name: "Boston vs New York" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText("No MLS games are scheduled for this day."),
    ).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(
      { sport: "soccer", day: "2026-08-01" },
      expect.any(AbortSignal),
    );
  });

  it("derives the displayed Eastern start instead of trusting API display text", async () => {
    const list = vi.fn<GamesClient["list"]>().mockResolvedValue(
      page([
        {
          ...game,
          eastern: { ...game.eastern, display: "UNTRUSTED DISPLAY" },
        },
      ]),
    );
    render(
      <App initialPath="/games" gamesClient={{ ok: true, value: { list } }} />,
    );
    expect(
      await screen.findByText("Aug 1, 2026, 7:05 PM Eastern"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/UNTRUSTED/)).not.toBeInTheDocument();
  });

  it("shows configuration failure without making a request", async () => {
    render(
      <App
        initialPath="/games"
        gamesClient={{
          ok: false,
          error: new GamesClientError(
            "configuration",
            "The API address is not configured.",
          ),
        }}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The API address is not configured.",
    );
  });

  it("ignores a late response after a filter change", async () => {
    let resolveOld!: (value: GamesPageDto) => void;
    const old = new Promise<GamesPageDto>((resolve) => {
      resolveOld = resolve;
    });
    const list = vi
      .fn<GamesClient["list"]>()
      .mockImplementationOnce(() => old)
      .mockResolvedValueOnce(page([]));
    render(
      <App initialPath="/games" gamesClient={{ ok: true, value: { list } }} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "MLS" }));
    expect(
      await screen.findByText("No MLS games are scheduled for this day."),
    ).toBeInTheDocument();
    resolveOld(page());
    await Promise.resolve();
    expect(
      screen.queryByRole("heading", { name: "Boston vs New York" }),
    ).not.toBeInTheDocument();
  });
});
