import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  GamesClientError,
  type GamesClient,
  type GamesPageDto,
  type SplitsPageDto,
} from "./api";

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
      {
        marketKey: "spread",
        selectionKey: "away",
        selectionLabel: "Boston",
        sportsbookId: "fixture-book",
        sportsbookLabel: "Fixture Book",
        point: 1.5,
        americanOdds: -110,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        marketKey: "spread",
        selectionKey: "home",
        selectionLabel: "New York",
        sportsbookId: "fixture-book",
        sportsbookLabel: "Fixture Book",
        point: -1.5,
        americanOdds: -110,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        marketKey: "total",
        selectionKey: "over",
        selectionLabel: "Over",
        sportsbookId: "fixture-book",
        sportsbookLabel: "Fixture Book",
        point: 8.5,
        americanOdds: -105,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        marketKey: "total",
        selectionKey: "under",
        selectionLabel: "Under",
        sportsbookId: "fixture-book",
        sportsbookLabel: "Fixture Book",
        point: 8.5,
        americanOdds: -115,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        marketKey: "moneyline",
        selectionKey: "home",
        selectionLabel: "New York",
        sportsbookId: "fixture-book",
        sportsbookLabel: "Fixture Book",
        americanOdds: -135,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:00.000Z",
      },
    ],
  },
} as const;

const soccerGame: GamesPageDto["items"][number] = {
  ...game,
  id: "event:soccer%3Amls:fixture-1",
  sportKey: "soccer",
  leagueKey: "mls",
  competition: { key: "mls", state: "provisional" },
  participants: [
    { id: "participant:soccer:miami", label: "Miami" },
    { id: "participant:soccer:atlanta", label: "Atlanta" },
  ],
  odds: {
    state: "available",
    selections: [
      {
        ...game.odds.selections[0],
        marketKey: "three_way_moneyline",
        selectionLabel: "Miami",
        americanOdds: 145,
      },
      {
        ...game.odds.selections[0],
        marketKey: "three_way_moneyline",
        selectionKey: "draw",
        selectionLabel: "Draw",
        americanOdds: 220,
      },
      {
        ...game.odds.selections[5],
        marketKey: "three_way_moneyline",
        selectionLabel: "Atlanta",
        americanOdds: 175,
      },
    ],
  },
};

const page = (items: GamesPageDto["items"] = [game]): GamesPageDto => ({
  items,
  nextCursor: null,
  projectionState: "ready",
  evaluationState: "complete",
  hasMoreUnknown: false,
  snapshotAt: "2026-08-01T12:30:00.000Z",
  freshness: "2026-08-01T12:30:00.000Z",
});

const splitGame: SplitsPageDto["items"][number] = {
  ...game,
  splits: [
    {
      id: "split-away-spread",
      providerId: "sharpapi",
      providerEventId: "sharp-1",
      canonicalEventId: game.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "spread",
      selectionKey: "away",
      point: 1.5,
      betPercent: 38,
      moneyPercent: 64,
      providerTimestamp: "2026-08-01T12:25:00.000Z",
      retrievedAt: "2026-08-01T12:26:00.000Z",
      scope: "Consensus · 15 books",
    },
    {
      id: "split-home-spread",
      providerId: "sharpapi",
      providerEventId: "sharp-1",
      canonicalEventId: game.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "spread",
      selectionKey: "home",
      point: -1.5,
      betPercent: 62,
      moneyPercent: 36,
      providerTimestamp: "2026-08-01T12:25:00.000Z",
      retrievedAt: "2026-08-01T12:26:00.000Z",
      scope: "Consensus · 15 books",
    },
    {
      id: "split-over-total",
      providerId: "sharpapi",
      providerEventId: "sharp-1",
      canonicalEventId: game.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "total",
      selectionKey: "over",
      point: 8.5,
      betPercent: 51,
      moneyPercent: 55,
      providerTimestamp: "2026-08-01T12:25:00.000Z",
      retrievedAt: "2026-08-01T12:26:00.000Z",
    },
    {
      id: "split-under-total",
      providerId: "sharpapi",
      providerEventId: "sharp-1",
      canonicalEventId: game.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "total",
      selectionKey: "under",
      point: 8.5,
      betPercent: 49,
      providerTimestamp: "2026-08-01T12:25:00.000Z",
      retrievedAt: "2026-08-01T12:26:00.000Z",
    },
    {
      id: "split-away-moneyline",
      providerId: "sharpapi",
      providerEventId: "sharp-1",
      canonicalEventId: game.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "away",
      betPercent: 45,
      moneyPercent: 58,
      providerTimestamp: "2026-08-01T12:25:00.000Z",
      retrievedAt: "2026-08-01T12:26:00.000Z",
    },
    {
      id: "split-home-moneyline",
      providerId: "sharpapi",
      providerEventId: "sharp-1",
      canonicalEventId: game.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "home",
      betPercent: 55,
      moneyPercent: 42,
      providerTimestamp: "2026-08-01T12:25:00.000Z",
      retrievedAt: "2026-08-01T12:26:00.000Z",
    },
  ],
};

const splitsPage = (
  items: SplitsPageDto["items"] = [
    {
      ...splitGame,
      splits: splitGame.splits.map((split) => ({
        ...split,
        scope: "Consensus · 15 books",
      })),
    },
  ],
): SplitsPageDto => ({
  ...page([]),
  items,
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
    expect(screen.getByText("-135")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Spread" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Total" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+1.5")).toBeInTheDocument();
    expect(screen.getByText("O 8.5")).toBeInTheDocument();
    expect(
      screen.getByText("Aug 1, 2026, 7:05 PM Eastern"),
    ).toBeInTheDocument();
    const price = screen.getByText("+120");
    expect(price.closest(".event-card")).toHaveTextContent(
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
      {
        sport: "soccer",
        day: new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      },
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

  it("renders every three-way soccer selection", async () => {
    const list = vi
      .fn<GamesClient["list"]>()
      .mockResolvedValue(page([soccerGame]));
    render(
      <App
        initialPath="/games?sport=soccer"
        gamesClient={{ ok: true, value: { list } }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Miami vs Atlanta" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+145")).toBeInTheDocument();
    expect(screen.getByText("+220")).toBeInTheDocument();
    expect(screen.getByText("+175")).toBeInTheDocument();
    expect(screen.getByText("Draw")).toBeInTheDocument();
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

describe("Betting splits", () => {
  it("renders paired team rows across spread, total, and moneyline", async () => {
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage());
    render(
      <App
        initialPath="/splits"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listSplits },
        }}
      />,
    );

    expect((await screen.findByText("Boston")).closest("th")).toHaveAttribute(
      "scope",
      "row",
    );
    expect(screen.getByText("New York").closest("th")).toHaveAttribute(
      "scope",
      "row",
    );
    expect(
      screen.getByRole("columnheader", { name: "Spread" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Total" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Moneyline" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+1.5")).toBeInTheDocument();
    expect(screen.getByText("O 8.5")).toBeInTheDocument();
    expect(screen.getByText("U 8.5")).toBeInTheDocument();
    expect(screen.getByText("+26 pts more money")).toBeInTheDocument();
    expect(screen.getByText("−26 pts more bets")).toBeInTheDocument();
    expect(screen.getAllByText(/Consensus · 15 books/)).toHaveLength(2);
    expect(
      screen.getByRole("link", {
        name: /View Boston versus New York game details/,
      }),
    ).toHaveAttribute("href", expect.stringContaining("sport=mlb"));
  });

  it("preserves missing provider values without manufacturing a percentage", async () => {
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          {
            ...splitGame,
            splits: [splitGame.splits[3]!],
          },
        ]),
      );
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    await screen.findByText("Boston");
    expect(screen.queryByText("—%")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("49%")).toBeInTheDocument();
  });

  it("keeps filters usable for empty results and reports failures", async () => {
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValueOnce(splitsPage([]))
      .mockRejectedValueOnce(new Error("redacted provider failure"));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(
      await screen.findByText("No splits are available for these games yet."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MLS" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Betting splits are temporarily unavailable.",
    );
    expect(
      screen.queryByText("redacted provider failure"),
    ).not.toBeInTheDocument();
  });

  it("keeps provider scopes in separate game groups", async () => {
    const base = splitGame.splits[0]!;
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          {
            ...splitGame,
            splits: [
              { ...base, id: "scope-a", scope: "Book A", moneyPercent: 71 },
              { ...base, id: "scope-b", scope: "Book B", moneyPercent: 29 },
            ],
          },
        ]),
      );
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(await screen.findByText("Book A")).toBeInTheDocument();
    expect(screen.getByText("Book B")).toBeInTheDocument();
    expect(screen.getByText("71%")).toBeInTheDocument();
    expect(screen.getByText("29%")).toBeInTheDocument();
    expect(screen.getAllByText("Boston")).toHaveLength(2);
  });

  it("shows multiple games in the same comparison terminal", async () => {
    const secondGame = {
      ...splitGame,
      id: "event:mlb:fixture-2",
      participants: [
        { id: "participant:mlb:chicago", label: "Chicago" },
        { id: "participant:mlb:detroit", label: "Detroit" },
      ],
      splits: splitGame.splits.map((split) => ({
        ...split,
        id: `${split.id}-2`,
        canonicalEventId: "event:mlb:fixture-2",
        scope: "Consensus · 15 books",
      })),
    } satisfies SplitsPageDto["items"][number];
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([splitGame, secondGame]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(await screen.findByText("Chicago")).toBeInTheDocument();
    expect(screen.getByText("Detroit")).toBeInTheDocument();
    expect(screen.getByText(/2 games · 12 observations/)).toBeInTheDocument();
  });

  it("renders the draw row for a three-way soccer moneyline", async () => {
    const base = splitGame.splits[0]!;
    const { point: omittedPoint, ...baseWithoutPoint } = base;
    void omittedPoint;
    const drawGame: SplitsPageDto["items"][number] = {
      ...soccerGame,
      splits: [
        {
          ...baseWithoutPoint,
          id: "soccer-away",
          canonicalEventId: soccerGame.id,
          sportKey: "soccer",
          leagueKey: "mls",
          marketKey: "three_way_moneyline",
          selectionKey: "away",
          moneyPercent: 30,
          betPercent: 28,
          scope: "Soccer consensus",
        },
        {
          ...baseWithoutPoint,
          id: "soccer-draw",
          canonicalEventId: soccerGame.id,
          sportKey: "soccer",
          leagueKey: "mls",
          marketKey: "three_way_moneyline",
          selectionKey: "draw",
          moneyPercent: 41,
          betPercent: 36,
          scope: "Soccer consensus",
        },
      ],
    };
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([drawGame]));
    render(
      <App
        initialPath="/splits?sport=soccer"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(await screen.findByText("Draw")).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
    expect(screen.getByText("36%")).toBeInTheDocument();
  });

  it("labels stale and unknown freshness without claiming live data", async () => {
    const staleClient = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage());
    const { unmount } = render(
      <App
        initialPath="/splits"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listSplits: staleClient },
        }}
      />,
    );
    expect(
      await screen.findByText(/Stale consensus board/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/LIVE CONSENSUS/)).not.toBeInTheDocument();
    unmount();

    const { scope: omittedScope, ...splitWithoutScope } = splitGame.splits[0]!;
    void omittedScope;
    const unknownSplit = {
      ...splitWithoutScope,
      providerTimestamp: "",
      retrievedAt: "",
    };
    const unknownClient = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue({
        ...splitsPage([{ ...splitGame, splits: [unknownSplit] }]),
        freshness: null,
        snapshotAt: null,
      });
    render(
      <App
        initialPath="/splits"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listSplits: unknownClient },
        }}
      />,
    );
    expect(
      await screen.findByText(/Freshness unknown consensus board/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Scope unavailable")).toHaveLength(2);
  });
});
