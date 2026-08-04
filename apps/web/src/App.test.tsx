import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { assessEventMetadata } from "@find-the-edge/domain";

import { App } from "./App";
import { detailMatchesRoute } from "./route-state";
import {
  GamesClientError,
  type GamesClient,
  type GamesPageDto,
  type SplitsPageDto,
  type RetrospectiveDto,
} from "./api";

const hex = (value: string) => value.repeat(64);
const retrospective: RetrospectiveDto = {
  retrospectiveId: `retrospective:${hex("a")}`,
  versionId: `retrospective-version:${hex("b")}`,
  version: 1,
  predecessorVersionId: null,
  cohortId: `cohort:${hex("c")}`,
  reportId: `performance-report:${hex("d")}`,
  reportRevision: 1,
  createdAt: "2026-08-04T00:00:00.000Z",
  state: "draft",
  stateVersion: 1,
  memberCount: 1,
  caution: "single-member",
  falseNegativeEvaluation: "not-evaluable",
  taxonomyVersion: "retrospective-taxonomy-v1",
  evidence: {
    evaluationCutoff: "2026-08-03T00:00:00.000Z",
    decisionTime: [
      {
        id: "evaluation",
        kind: "evaluation",
        layer: "decision-time",
        decisionCutoff: "2026-08-02T12:00:00.000Z",
        observedAt: "2026-08-02T00:00:00.000Z",
        digest: hex("2"),
      },
    ],
    postDecision: [
      {
        id: "grade",
        kind: "grade",
        layer: "post-decision",
        decisionCutoff: "2026-08-02T12:00:00.000Z",
        observedAt: "2026-08-03T00:00:00.000Z",
        digest: hex("3"),
      },
    ],
    decisionTimeDigest: hex("e"),
    postDecisionDigest: hex("f"),
    manifestDigest: hex("1"),
  },
  slices: [
    {
      dimension: "outcome",
      value: "all",
      memberCount: 1,
      wins: 0,
      losses: 1,
      pushes: 0,
      voids: 0,
      unresolved: 0,
      units: -1,
      roi: -1,
    },
  ],
  observations: [
    {
      id: "review",
      taxonomyCode: "false-positive",
      layer: "post-decision",
      summary:
        "One qualified loss merits review; outcome alone does not establish error.",
      evidenceRefIds: ["grade"],
      memberIds: ["member"],
      confidence: "review-only",
    },
  ],
  candidates: [],
  contentDigest: hex("4"),
};

it("renders retrospective evidence layers and honest read-only controls", async () => {
  const client = {
    ok: true as const,
    value: {
      list: vi.fn(),
      listRetrospectives: vi.fn(() => Promise.resolve([retrospective])),
      getRetrospective: vi.fn(() => Promise.resolve(retrospective)),
    },
  };
  render(<App initialPath="/retrospectives" gamesClient={client} />);
  expect(await screen.findByText("1 reviewed decision")).toBeVisible();
  fireEvent.click(screen.getByText("1 reviewed decision"));
  expect(await screen.findByText("What was knowable then")).toBeVisible();
  expect(screen.getByText("What became known later")).toBeVisible();
  expect(screen.getByText("READ ONLY")).toBeVisible();
  expect(screen.getByText(/False-negative review: unavailable/)).toBeVisible();
});

it("requires an explicit confirmed reviewer action and refreshes the audit state", async () => {
  const reviewed = {
    ...retrospective,
    state: "approved" as const,
    stateVersion: 2,
  };
  const historical = {
    ...retrospective,
    versionId: `retrospective-version:${hex("9")}`,
    version: 2,
    predecessorVersionId: retrospective.versionId,
  };
  const reviewRetrospective = vi.fn(() => Promise.resolve(reviewed));
  const client = {
    ok: true as const,
    value: {
      list: vi.fn(),
      getRetrospective: vi.fn(() => Promise.resolve(retrospective)),
      listRetrospectiveVersions: vi.fn(() =>
        Promise.resolve([historical, retrospective]),
      ),
      canReviewRetrospectives: vi.fn(() => Promise.resolve(true)),
      reviewRetrospective,
    },
  };
  render(
    <App
      initialPath={`/retrospectives/${retrospective.versionId}`}
      gamesClient={client}
    />,
  );
  const save = await screen.findByRole("button", { name: "Save human review" });
  expect(
    screen.getByRole("link", { name: "Open immutable version" }),
  ).toHaveAttribute(
    "href",
    `/retrospectives/${encodeURIComponent(historical.versionId)}`,
  );
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: "approve" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Reviewer note" }), {
    target: { value: "Evidence checked." },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(save).toBeEnabled();
  fireEvent.click(save);
  expect(await screen.findByText(/Review saved/)).toBeVisible();
  expect(reviewRetrospective).toHaveBeenCalledWith(
    retrospective,
    expect.objectContaining({
      reasonCode: "approve",
      note: "Evidence checked.",
    }),
    expect.any(AbortSignal),
  );
});

it("shows an honest empty performance state before a frozen report exists", async () => {
  render(<App initialPath="/performance" />);
  expect(await screen.findByText("No frozen cohort report yet.")).toBeVisible();
  expect(
    screen.getByText(/Missing evidence is never shown as zero/),
  ).toBeVisible();
});

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
        marketKey: "moneyline",
        selectionLabel: "Miami",
        americanOdds: 145,
      },
      {
        ...game.odds.selections[0],
        marketKey: "moneyline",
        selectionKey: "draw",
        selectionLabel: "Draw",
        americanOdds: 220,
      },
      {
        ...game.odds.selections[5],
        marketKey: "moneyline",
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
  unavailableReason: null,
});

it("renders independent accessible lifecycle and freshness badges on games and detail", async () => {
  const client = {
    ok: true as const,
    value: { list: vi.fn(() => Promise.resolve(page())) },
  };
  const { unmount } = render(<App initialPath="/games" gamesClient={client} />);
  expect(
    await screen.findByLabelText("Lifecycle: scheduled"),
  ).toHaveTextContent("Scheduled");
  expect(screen.getByLabelText("Event metadata is current")).toHaveTextContent(
    "Metadata current",
  );
  expect(screen.getByText(/Evidence .* Eastern/)).toBeVisible();
  unmount();

  const eventDetail = (({ odds, ...rest }) => {
    void odds;
    return rest;
  })(game);
  const detail = vi.fn(() =>
    Promise.resolve({
      ...eventDetail,
      oddsComparison: {
        targetSportsbookId: "hardrock",
        targetQualified: false,
        generatedAt: "2026-08-01T12:30:00.000Z",
        sportsbooks: [{ id: "hardrock", label: "Hard Rock Bet", target: true }],
        markets: [
          {
            marketKey: "moneyline",
            selections: [
              {
                selectionKey: "away",
                selectionLabel: "Boston",
                cells: {
                  hardrock: {
                    state: "suspended",
                    eligible: false,
                    reason: "market-suspended",
                    evidenceAt: "2026-08-01T12:15:00.000Z",
                    americanOdds: 120,
                    observedAt: "2026-08-01T12:00:00.000Z",
                    retrievedAt: "2026-08-01T12:00:01.000Z",
                  },
                },
              },
            ],
          },
        ],
      },
    } as const),
  );
  render(
    <App
      initialPath={`/games/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
      gamesClient={{ ok: true, value: { list: vi.fn(), detail } }}
    />,
  );
  expect(await screen.findByLabelText("Lifecycle: scheduled")).toBeVisible();
  expect(screen.getByLabelText("Event metadata is current")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Sportsbook comparison" }),
  ).toBeVisible();
  expect(screen.getByText("Target unavailable")).toBeVisible();
  const tab = screen.getByRole("tab", { name: "Moneyline" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(tab).toHaveAttribute("aria-controls", "market-panel-moneyline");
  expect(screen.getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    "market-tab-moneyline",
  );
  expect(screen.getByText("Market suspended")).toBeVisible();
  expect(
    screen.getByText("Market suspended").closest("td")?.querySelector("time"),
  ).toHaveAttribute("datetime", "2026-08-01T12:15:00.000Z");
});

it("keeps not-found detail distinct from retryable outages", async () => {
  render(
    <App
      initialPath={`/games/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
      gamesClient={{
        ok: true,
        value: {
          list: vi.fn(),
          detail: vi.fn(() =>
            Promise.reject(
              new GamesClientError("not-found", "This game was not found."),
            ),
          ),
        },
      }}
    />,
  );
  expect(await screen.findByText("This game was not found.")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

it("never considers a prior deferred detail result visible after route identity changes", () => {
  expect(detailMatchesRoute("event:first", "event:second")).toBe(false);
  expect(detailMatchesRoute("event:second", "event:second")).toBe(true);
});

it.each([
  [
    "scheduled",
    "2026-08-01T12:30:00.000Z",
    "Lifecycle: scheduled",
    "Event metadata is current",
    "within the two-hour",
  ],
  [
    "scheduled",
    "2026-08-01T09:00:00.000Z",
    "Lifecycle: scheduled",
    "Event metadata is stale",
    "older than the two-hour",
  ],
  [
    "scheduled",
    "2026-08-01T13:00:00.000Z",
    "Lifecycle: scheduled",
    "Event metadata freshness is unavailable",
    "in the future",
  ],
  [
    "unknown",
    "2026-08-01T12:30:00.000Z",
    "Lifecycle status unavailable",
    "Event metadata is current",
    "lifecycle status is unavailable",
  ],
  [
    "postponed",
    "2026-08-01T12:30:00.000Z",
    "Lifecycle: postponed",
    "Event metadata is current",
    "within the two-hour",
  ],
  [
    "cancelled",
    "2026-08-01T09:00:00.000Z",
    "Lifecycle: cancelled",
    "Event metadata is stale",
    "older than the two-hour",
  ],
] as const)(
  "renders %s lifecycle and reasoned freshness accessibly",
  async (status, evidenceAt, lifecycleLabel, freshnessLabel, reason) => {
    const evaluatedAt = "2026-08-01T12:30:00.000Z";
    const item = {
      ...game,
      status,
      freshness: evidenceAt,
      metadata: assessEventMetadata(status, evidenceAt, evaluatedAt),
    };
    const { unmount } = render(
      <App
        initialPath="/games"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(() => Promise.resolve(page([item]))) },
        }}
      />,
    );
    expect(await screen.findByLabelText(lifecycleLabel)).toBeVisible();
    expect(screen.getByLabelText(freshnessLabel)).toBeVisible();
    expect(screen.getByText(new RegExp(reason, "i"))).toBeVisible();
    if (status === "scheduled" && evidenceAt > evaluatedAt) {
      expect(
        screen.queryByText(/Evidence Aug 1, 2026, 9:00 AM Eastern/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(new RegExp(`Evidence .*${evidenceAt}`)),
      ).not.toBeInTheDocument();
    }
    unmount();
  },
);

it("explains an uninitialized game projection instead of claiming an empty schedule", async () => {
  const unavailable = {
    ...page([]),
    projectionState: "uninitialized" as const,
    unavailableReason: "projection-uninitialized" as const,
    snapshotAt: null,
    freshness: null,
  };
  render(
    <App
      initialPath="/games"
      gamesClient={{
        ok: true,
        value: { list: vi.fn(() => Promise.resolve(unavailable)) },
      }}
    />,
  );
  expect(await screen.findByText(/event data initializes/)).toBeVisible();
  expect(
    screen.queryByText(/No MLB games are scheduled/),
  ).not.toBeInTheDocument();
});

it("does not claim an empty schedule when the scheduled lifecycle failed", async () => {
  const partial = {
    ...page([]),
    lifecycleCoverage: {
      requested: ["scheduled", "completed"],
      loaded: ["completed"],
      unavailable: ["scheduled"],
    },
  } as const;
  render(
    <App
      initialPath="/games?status=all"
      gamesClient={{
        ok: true,
        value: { list: vi.fn(() => Promise.resolve(partial)) },
      }}
    />,
  );
  expect(await screen.findByText(/lifecycle groups that loaded/)).toBeVisible();
  expect(screen.queryByText(/games are scheduled/)).not.toBeInTheDocument();
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
      scope: "consensus",
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
      scope: "consensus",
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
        scope: "consensus",
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
      await screen.findByText(
        "No MLS events exist for this day and lifecycle selection.",
      ),
    ).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(
      {
        sport: "soccer",
        status: "all",
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
      await screen.findByText(
        "No MLS events exist for this day and lifecycle selection.",
      ),
    ).toBeInTheDocument();
    resolveOld(page());
    await Promise.resolve();
    expect(
      screen.queryByRole("heading", { name: "Boston vs New York" }),
    ).not.toBeInTheDocument();
  });
});

describe("Betting splits", () => {
  it("refreshes an empty board when newly ingested splits become available", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listSplits = vi
        .fn<NonNullable<GamesClient["listSplits"]>>()
        .mockResolvedValueOnce(splitsPage([{ ...splitGame, splits: [] }]))
        .mockResolvedValueOnce(splitsPage());
      render(
        <App
          initialPath="/splits"
          gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
        />,
      );

      expect(
        await screen.findByText("1 games · 0 with data · 0 observations"),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(
        await screen.findByText("1 games · 1 with data · 6 observations"),
      ).toBeInTheDocument();
      expect(listSplits).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the last valid board through a failed refresh and retries", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const refreshed = {
        ...splitGame,
        splits: splitGame.splits.map((split) =>
          split.id === "split-away-moneyline"
            ? { ...split, scope: "consensus", betPercent: 47 }
            : { ...split, scope: "consensus" },
        ),
      };
      const listSplits = vi
        .fn<NonNullable<GamesClient["listSplits"]>>()
        .mockResolvedValueOnce(splitsPage())
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce(splitsPage([refreshed]));
      render(
        <App
          initialPath="/splits"
          gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
        />,
      );

      expect(await screen.findByText("45%")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByText("45%")).toBeInTheDocument();
      expect(
        screen.queryByText("Betting splits are temporarily unavailable."),
      ).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(await screen.findByText("47%")).toBeInTheDocument();
      expect(listSplits).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

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
    expect(screen.getByText("DK + Circa Consensus")).toBeInTheDocument();
    expect(screen.getByText("One signal, not the answer.")).toBeInTheDocument();
    expect(
      screen.getByText(/No sharp sportsbook publishes splits/),
    ).toBeInTheDocument();
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
      await screen.findByText("No scheduled games are available for this day."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MLS" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Betting splits are temporarily unavailable.",
    );
    expect(
      screen.queryByText("redacted provider failure"),
    ).not.toBeInTheDocument();
  });

  it("switches scopes without duplicating or hiding the complete schedule", async () => {
    const base = splitGame.splits[0]!;
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          {
            ...splitGame,
            splits: [
              { ...base, id: "scope-b", scope: "Book B", moneyPercent: 29 },
              { ...base, id: "scope-a", scope: "Book A", moneyPercent: 71 },
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

    const bookButtons = await screen.findAllByRole("button", {
      name: /Show Book [AB] splits/,
    });
    expect(
      bookButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Show Book A splits", "Show Book B splits"]);
    expect(screen.getByText("71%")).toBeInTheDocument();
    expect(screen.queryByText("29%")).not.toBeInTheDocument();
    expect(screen.getAllByText("Boston")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show Book B splits" }));
    expect(screen.getByText("29%")).toBeInTheDocument();
    expect(screen.queryByText("71%")).not.toBeInTheDocument();
    expect(screen.getAllByText("Boston")).toHaveLength(1);
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
        scope: "consensus",
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
    expect(
      screen.getByText(/2 games · 2 with data · 8 observations/),
    ).toBeInTheDocument();
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
          marketKey: "moneyline",
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
          marketKey: "moneyline",
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
    expect(await screen.findByText(/Stale splits board/)).toBeInTheDocument();
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
      await screen.findByText(/Freshness unknown splits board/),
    ).toBeInTheDocument();
    expect(screen.getByText("Scope unavailable")).toBeInTheDocument();
  });

  it("shows scheduled games without observations and uses accessible logo fallbacks", async () => {
    const uncovered = {
      ...splitGame,
      id: "event:mlb:uncovered",
      participants: [
        { id: "participant:mlb:chicago", label: "Chicago" },
        { id: "participant:mlb:detroit", label: "Detroit" },
      ],
      splits: [],
    } satisfies SplitsPageDto["items"][number];
    const unknownScope = splitGame.splits.map((split) => ({
      ...split,
      scope: "Local Book",
    }));
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([{ ...splitGame, splits: unknownScope }, uncovered]),
      );
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(await screen.findByText("Chicago")).toBeInTheDocument();
    expect(screen.getByText("Detroit")).toBeInTheDocument();
    expect(screen.getByText("No split data")).toBeInTheDocument();
    expect(screen.getAllByText("Boston")).toHaveLength(1);
    const fallback = screen.getByRole("button", {
      name: "Show Local Book splits",
    });
    expect(fallback).toHaveAttribute("title", "Local Book");
    fireEvent.click(fallback);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows all eight scheduled games when only one has split coverage", async () => {
    const covered = {
      ...splitGame,
      splits: splitGame.splits.map((split) => ({
        ...split,
        scope: "consensus",
      })),
    };
    const uncovered = Array.from({ length: 7 }, (_, index) => ({
      ...splitGame,
      id: `event:mlb:uncovered:${index}`,
      participants: [
        { id: `away:${index}`, label: `Away ${index + 1}` },
        { id: `home:${index}`, label: `Home ${index + 1}` },
      ],
      splits: [],
    }));
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([covered, ...uncovered]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(
      await screen.findByText(
        `8 games · 1 with data · ${covered.splits.length} observations`,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("No split data")).toHaveLength(7);
    expect(screen.getAllByText(/Away [1-7]/)).toHaveLength(7);
  });

  it("does not report page timestamps as split freshness without observations", async () => {
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([{ ...splitGame, splits: [] }]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(
      await screen.findByText("Freshness unknown splits board"),
    ).toBeInTheDocument();
    expect(screen.getByText("Timestamp unavailable")).toBeInTheDocument();
  });

  it("shows only returned sportsbook controls and falls back when a known logo fails", async () => {
    const betmgmSplits = splitGame.splits.map((split, index) => ({
      ...split,
      scope: index % 2 === 0 ? " betmgm " : "BETMGM",
    }));
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([{ ...splitGame, splits: betmgmSplits }]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    const betmgm = await screen.findByRole("button", {
      name: "Show BetMGM splits",
    });
    expect(
      screen.queryByRole("button", { name: /DraftKings|Circa|FanDuel/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Show BetMGM splits" }),
    ).toHaveLength(1);
    fireEvent.error(screen.getByAltText("BetMGM"));
    expect(betmgm).toHaveTextContent("B");
  });
});
