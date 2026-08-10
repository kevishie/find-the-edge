import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessEventMetadata,
  type ProviderStatusPageDto,
  type RankedOpportunityDto,
} from "@find-the-edge/domain";

import { App } from "./App";
import { detailMatchesRoute } from "./route-state";
import { clearSplitsCache } from "./splits-cache";
import {
  GamesClientError,
  type GamesClient,
  type GamesPageDto,
  type RankedOpportunityPageDto,
  type SplitsPageDto,
  type RetrospectiveDto,
} from "./api";

// The splits board cache is process-wide so it survives navigation; tests must
// not inherit a board warmed by an earlier case.
beforeEach(() => {
  clearSplitsCache();
  window.localStorage.removeItem("fte.splitsView");
  window.localStorage.removeItem("fte.splits.viz");
});

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

const comparisonDetail = () => {
  const { odds: _odds, ...event } = game;
  void _odds;
  return {
    ...event,
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
  } as const;
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
  const { unmount } = render(
    <App initialPath="/events" gamesClient={client} />,
  );
  expect(
    await screen.findByLabelText("Lifecycle: scheduled"),
  ).toHaveTextContent("Scheduled");
  expect(screen.getByLabelText("Event metadata is current")).toHaveTextContent(
    "Metadata current",
  );
  expect(screen.getByText(/Evidence .* Eastern/)).toBeVisible();
  unmount();

  const detail = vi.fn(() => Promise.resolve(comparisonDetail()));
  const oddsHistory = vi.fn(() =>
    Promise.resolve({
      eventId: game.id,
      generatedAt: "2026-08-01T12:30:00.000Z",
      markerScope: "loaded" as const,
      coverage: [
        {
          sportsbookId: "pinnacle",
          sportsbookLabel: "Pinnacle",
          status: "available" as const,
        },
        {
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          status: "available" as const,
        },
      ],
      series: [
        {
          marketKey: "moneyline",
          selectionKey: "away",
          selectionLabel: "Boston",
          sportsbookId: "pinnacle",
          sportsbookLabel: "Pinnacle",
          points: [
            {
              observationId: "pinnacle-opening",
              state: "active" as const,
              americanOdds: -110,
              impliedProbability: 110 / 210,
              observedAt: "2026-08-01T11:00:00.000Z",
              retrievedAt: "2026-08-01T11:00:01.000Z",
              isOpening: true,
              isCurrent: false,
            },
            {
              observationId: "pinnacle-current",
              state: "active" as const,
              americanOdds: 110,
              impliedProbability: 100 / 210,
              observedAt: "2026-08-01T12:00:00.000Z",
              retrievedAt: "2026-08-01T12:00:01.000Z",
              isOpening: false,
              isCurrent: true,
            },
          ],
        },
        {
          marketKey: "moneyline",
          selectionKey: "away",
          selectionLabel: "Old Boston label",
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          points: [
            {
              observationId: "draftkings-only",
              state: "active" as const,
              americanOdds: 120,
              impliedProbability: 100 / 220,
              observedAt: "2026-08-01T10:00:00.000Z",
              retrievedAt: "2026-08-01T10:00:01.000Z",
              isOpening: true,
              isCurrent: true,
            },
          ],
        },
      ],
      nextCursor: "more-history",
    }),
  );
  render(
    <App
      initialPath={`/events/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
      gamesClient={{
        ok: true,
        value: { list: vi.fn(), detail, oddsHistory },
      }}
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
  expect(
    screen.getByText("Evidence Aug 1, 2026, 8:15 AM Eastern"),
  ).toBeVisible();
  expect(
    await screen.findByRole("group", {
      name: "Implied probability movement across 2 sportsbooks",
    }),
  ).toBeVisible();
  expect(
    screen.getByText("Pinnacle first-to-latest loaded probability move"),
  ).toBeVisible();
  expect(screen.getByText("-4.8 probability points")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Selection" })).toHaveValue(
    "away",
  );
  expect(screen.getByRole("option", { name: "Boston" })).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Old Boston label" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/Showing a bounded portion of retained history/),
  ).toBeVisible();
});

it("renders exact opening/current markers for isolated sportsbook points", async () => {
  const singleton = (sportsbookId: string, sportsbookLabel: string) => ({
    marketKey: "moneyline",
    selectionKey: "away",
    selectionLabel: "Boston",
    sportsbookId,
    sportsbookLabel,
    points: [
      {
        observationId: `${sportsbookId}-only`,
        state: "active" as const,
        americanOdds: -110,
        impliedProbability: 110 / 210,
        observedAt: "2026-08-01T11:00:00.000Z",
        retrievedAt: "2026-08-01T11:00:01.000Z",
        isOpening: true,
        isCurrent: true,
      },
    ],
  });
  const oddsHistory = vi.fn(() =>
    Promise.resolve({
      eventId: game.id,
      generatedAt: "2026-08-01T12:30:00.000Z",
      markerScope: "loaded" as const,
      coverage: [
        {
          sportsbookId: "pinnacle",
          sportsbookLabel: "Pinnacle",
          status: "available" as const,
        },
        {
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          status: "available" as const,
        },
      ],
      series: [
        singleton("pinnacle", "Pinnacle"),
        singleton("draftkings", "DraftKings"),
      ],
      nextCursor: null,
    }),
  );
  render(
    <App
      initialPath={`/events/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
      gamesClient={{
        ok: true,
        value: {
          list: vi.fn(),
          detail: vi.fn(() => Promise.resolve(comparisonDetail())),
          oddsHistory,
        },
      }}
    />,
  );
  expect(
    await screen.findByRole("group", {
      name: "Implied probability movement across 2 sportsbooks",
    }),
  ).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: /opening and current/i }),
  ).toHaveLength(2);
  expect(screen.getAllByText("1 active observation")).toHaveLength(2);
});

it("provides a selectable step-line history view with exact details and table parity", async () => {
  const history = {
    eventId: game.id,
    generatedAt: "2026-08-01T12:30:00.000Z",
    markerScope: "loaded" as const,
    coverage: [
      {
        sportsbookId: "draftkings",
        sportsbookLabel: "DraftKings",
        status: "available" as const,
      },
      {
        sportsbookId: "pinnacle",
        sportsbookLabel: "Pinnacle",
        status: "available" as const,
      },
      {
        sportsbookId: "caesars",
        sportsbookLabel: "Caesars Sportsbook",
        status: "unavailable" as const,
      },
    ],
    series: [
      {
        marketKey: "moneyline",
        selectionKey: "away",
        selectionLabel: "Boston",
        sportsbookId: "draftkings",
        sportsbookLabel: "DraftKings",
        points: [
          {
            observationId: "dk-open",
            state: "active" as const,
            americanOdds: 125,
            impliedProbability: 100 / 225,
            observedAt: "2026-07-30T10:00:00.000Z",
            retrievedAt: "2026-07-30T10:00:01.000Z",
            isOpening: true,
            isCurrent: false,
          },
          {
            observationId: "dk-suspended",
            state: "suspended" as const,
            americanOdds: 120,
            impliedProbability: 100 / 220,
            observedAt: "2026-08-01T11:00:00.000Z",
            retrievedAt: "2026-08-01T11:00:01.000Z",
            isOpening: false,
            isCurrent: false,
          },
          {
            observationId: "dk-current",
            state: "active" as const,
            americanOdds: 110,
            impliedProbability: 100 / 210,
            observedAt: "2026-08-01T12:00:00.000Z",
            retrievedAt: "2026-08-01T12:00:01.000Z",
            isOpening: false,
            isCurrent: true,
          },
        ],
      },
      {
        marketKey: "moneyline",
        selectionKey: "away",
        selectionLabel: "Boston",
        sportsbookId: "pinnacle",
        sportsbookLabel: "Pinnacle",
        points: [
          {
            observationId: "pin-open",
            state: "active" as const,
            americanOdds: 118,
            impliedProbability: 100 / 218,
            observedAt: "2026-08-01T10:00:00.000Z",
            retrievedAt: "2026-08-01T10:00:01.000Z",
            isOpening: true,
            isCurrent: false,
          },
          {
            observationId: "pin-current",
            state: "active" as const,
            americanOdds: 105,
            impliedProbability: 100 / 205,
            observedAt: "2026-08-01T12:00:00.000Z",
            retrievedAt: "2026-08-01T12:00:02.000Z",
            isOpening: false,
            isCurrent: true,
          },
        ],
      },
    ],
    nextCursor: null,
  };
  render(
    <App
      initialPath={`/events/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
      gamesClient={{
        ok: true,
        value: {
          list: vi.fn(),
          detail: vi.fn(() => Promise.resolve(comparisonDetail())),
          oddsHistory: vi.fn(() => Promise.resolve(history)),
        },
      }}
    />,
  );

  const filters = await screen.findByLabelText("Sportsbook line filters");
  const draftKings = within(filters).getByRole("button", {
    name: "Hide DraftKings line",
  });
  expect(draftKings).toHaveAttribute("aria-pressed", "true");
  expect(
    within(filters).getByRole("button", {
      name: "Caesars Sportsbook: No history",
    }),
  ).toBeDisabled();
  expect(document.querySelector('[data-series="pinnacle"]')).toHaveAttribute(
    "data-interpolation",
    "step-after",
  );
  expect(document.querySelector('[data-series="pinnacle"]')).toHaveAttribute(
    "stroke-dasharray",
  );
  expect(document.querySelector('[data-gap-state="suspended"]')).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "American odds" }));
  expect(
    screen.getByRole("group", {
      name: "American odds movement across 2 sportsbooks",
    }),
  ).toBeVisible();

  const exactPoint = screen.getByRole("button", {
    name: /DraftKings current.*\+110.*provider.*collected/i,
  });
  fireEvent.focus(exactPoint);
  expect(
    screen.getByLabelText("Focused observation details"),
  ).toHaveTextContent("DraftKings");
  expect(
    screen.getByLabelText("Focused observation details"),
  ).toHaveTextContent("Collected");

  fireEvent.click(screen.getByText("Accessible history table"));
  const table = screen.getByRole("table", { name: "Plotted line history" });
  expect(within(table).getByText("dk-suspended")).toBeVisible();
  expect(within(table).getByText("Suspended")).toBeVisible();
  expect(within(table).getAllByText("Current").length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "Last 6 hours" }));
  expect(within(table).queryByText("dk-open")).not.toBeInTheDocument();
  expect(
    screen.getByText(/earlier loaded observations are hidden/i),
  ).toBeVisible();
  expect(
    within(table).getAllByText("Opening and current").length,
  ).toBeGreaterThan(0);

  fireEvent.click(draftKings);
  expect(draftKings).toHaveAttribute("aria-pressed", "false");
  expect(document.querySelector('[data-series="draftkings"]')).toBeNull();
  expect(
    screen.getByRole("group", {
      name: "American odds movement across 1 sportsbook",
    }),
  ).toBeVisible();
});

it("keeps not-found detail distinct from retryable outages", async () => {
  render(
    <App
      initialPath={`/events/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
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

it("settles on a detail configuration error instead of reverting to loading", async () => {
  render(
    <App
      initialPath={`/events/${encodeURIComponent(game.id)}?sport=mlb&day=2026-08-01`}
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
    "Game details are unavailable.",
  );
  await act(async () => Promise.resolve());
  expect(screen.queryByText("Loading game details…")).not.toBeInTheDocument();
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
        initialPath="/events"
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
      initialPath="/events"
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
      initialPath="/events?status=all"
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

const dashboardOpportunity = (
  suffix: string,
  expectedValue: number,
  overrides: Partial<RankedOpportunityDto> = {},
): RankedOpportunityDto => ({
  schemaVersion: "ranked-opportunity-dto-v1",
  opportunityId: `opportunity:${suffix.repeat(64)}`,
  sportKey: "mlb",
  event: {
    id: `event-${suffix}`,
    version: 1,
    competitionKey: "mlb",
    participants: [
      { id: `team-${suffix}-away`, label: `Away ${suffix.toUpperCase()}` },
      { id: `team-${suffix}-home`, label: `Home ${suffix.toUpperCase()}` },
    ],
    startsAt: "2099-08-08T00:00:00.000Z",
    eastern: {
      timeZone: "America/New_York",
      calendarDay: "2099-08-07",
      display: "Aug 7, 2099, 8:00 PM",
    },
    status: "scheduled",
  },
  market: {
    key: "moneyline",
    selectionKey: `team-${suffix}-away`,
    point: null,
  },
  target: {
    sportsbookId: "hardrock",
    americanOdds: 130,
    impliedProbability: 1 / 2.3,
    observedAt: "2099-08-07T11:55:00.000Z",
    retrievedAt: "2099-08-07T11:56:00.000Z",
  },
  bestComparison: {
    sportsbookId: "draftkings",
    americanOdds: 110,
    observedAt: "2099-08-07T11:55:00.000Z",
    retrievedAt: "2099-08-07T11:56:00.000Z",
  },
  consensus: { probability: 0.48, fairAmericanOdds: 108 },
  expectedValue,
  confidence: {
    score: 82,
    bucket: "high",
    weakestComponent: "coverage",
    components: { freshness: 95, coverage: 82, agreement: 88 },
  },
  dataQuality: { score: 82, bucket: "high", weakestComponent: "coverage" },
  contributingBooks: ["draftkings", "fanduel", "betmgm"],
  warningCodes: [],
  liveFreshness: {
    scoredAt: "2099-08-07T12:00:00.000Z",
    oldestRequiredEvidenceAt: "2099-08-07T11:55:00.000Z",
    ageMinutes: 5,
    maximumAgeMinutes: 15,
    expiresAt: "2099-08-07T12:10:00.001Z",
  },
  versions: {
    ranking: { id: "find-the-edge-opportunity-ranking", version: "1.0.0" },
    evaluationPolicy: { id: "evaluation", version: "1.0.0" },
    strategy: { id: "strategy", version: "1.0.0" },
    sportModule: { id: "mlb", version: "1.0.0" },
    calculation: { id: "opportunity-qualification", version: "1.0.0" },
  },
  ...overrides,
});

const dashboardPage = (
  items: RankedOpportunityDto[],
  overrides: Partial<RankedOpportunityPageDto> = {},
): RankedOpportunityPageDto => ({
  schemaVersion: "ranked-opportunity-page-v1",
  rankingPolicy: {
    id: "find-the-edge-opportunity-ranking",
    version: "1.0.0",
  },
  items,
  nextCursor: null,
  snapshotAt: "2099-08-07T12:00:00.000Z",
  evaluationState: "complete",
  hasMoreUnknown: false,
  evaluatedCount: items.length,
  filteredCount: 0,
  staleCount: 0,
  joinFailureCount: 0,
  ...overrides,
});

const providerScope = (
  overrides: Partial<ProviderStatusPageDto["items"][number]> = {},
): ProviderStatusPageDto["items"][number] => ({
  scopeId: "sharpapi:mlb:odds",
  providerId: "sharpapi",
  providerName: "Odds Feed",
  sportKey: "mlb",
  leagueKey: "mlb",
  capability: "odds",
  purpose: "Sportsbook prices and market availability",
  supportedData: ["moneyline", "spread", "total"],
  connection: "healthy",
  safeReason: "none",
  lastCheckedAt: "2099-08-07T12:00:00.000Z",
  lastSuccessfulAt: "2099-08-07T12:00:00.000Z",
  retryAt: null,
  freshness: { ageSeconds: 0, expectedSeconds: 900 },
  capacity: {
    state: "available",
    limit: 1000,
    remaining: 800,
    reserve: 100,
    resetsAt: "2099-08-07T12:10:00.000Z",
  },
  recommendationImpact: "none",
  ...overrides,
});

const providerPage = (
  items: ProviderStatusPageDto["items"] = [providerScope()],
): ProviderStatusPageDto => ({
  schemaVersion: "provider-status-page-v1",
  snapshotAt: "2099-08-07T12:00:00.000Z",
  evaluationState: "complete",
  summary: {
    total: items.length,
    healthy: items.filter(({ connection }) => connection === "healthy").length,
    partial: items.filter(({ connection }) => connection === "partial").length,
    stale: items.filter(({ connection }) => connection === "stale").length,
    outage: items.filter(({ connection }) => connection === "outage").length,
    unknown: items.filter(({ connection }) => connection === "unknown").length,
    impacted: items.filter(
      ({ recommendationImpact }) => recommendationImpact !== "none",
    ).length,
  },
  items,
});

describe("Shell navigation", () => {
  it("renders the public landing page at the root without terminal chrome", async () => {
    render(<App initialPath="/" />);

    expect(
      await screen.findByRole("heading", { name: /stop shopping lines/i }),
    ).toBeVisible();
    expect(screen.getByText(/LIVE ODDS · 6 BOOKS/)).toBeVisible();
    expect(screen.getAllByText("+EV SCANNER")[0]).toBeVisible();
    expect(screen.getByText("One plan. Every tool.")).toBeVisible();
    expect(screen.getByText(/Call 1-800-GAMBLER/)).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Primary navigation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Betting splits")).not.toBeInTheDocument();
  });

  it("opens and closes the accessible mobile landing menu", async () => {
    render(<App initialPath="/" />);

    const trigger = await screen.findByRole("button", { name: "Open menu" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("navigation", {
        name: "Mobile landing page navigation",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const mobileNavigation = screen.getByRole("navigation", {
      name: "Mobile landing page navigation",
    });
    fireEvent.click(
      within(mobileNavigation).getByRole("link", { name: "Features" }),
    );

    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the terminal shell on a direct product route", async () => {
    render(
      <App
        initialPath="/splits"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(),
            listSplits: vi.fn(() => Promise.resolve(splitsPage())),
          },
        }}
      />,
    );

    expect(await screen.findByText("Betting splits")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    // Each item renders a decorative glyph plus its accessible label.
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent?.replace(/^[^A-Za-z]+/, "")),
    ).toEqual(["Events", "Splits"]);
    for (const removed of [
      "Dashboard",
      "Scout Reports",
      "Performance",
      "Data Sources",
      "Retrospectives",
      "Experiments",
    ])
      expect(within(nav).queryByText(removed)).not.toBeInTheDocument();
  });

  it.each([
    ["/terms", "Terms of Use"],
    ["/privacy", "Privacy Notice"],
  ])("renders %s as a public draft legal route", async (path, heading) => {
    render(<App initialPath={path} />);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "NOT APPROVED FOR LAUNCH",
    );
    expect(
      screen.queryByRole("navigation", { name: "Primary navigation" }),
    ).not.toBeInTheDocument();
  });
});

describe("Dashboard", () => {
  it("keeps ranked cards when the independent status request fails", async () => {
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(),
            listOpportunities: vi.fn(() =>
              Promise.resolve(dashboardPage([dashboardOpportunity("p", 0.09)])),
            ),
            providerStatus: vi.fn(() =>
              Promise.reject(new Error("raw secret")),
            ),
          },
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Away P vs Home P" }),
    ).toBeVisible();
    expect(await screen.findByText("Status unavailable")).toBeVisible();
    expect(
      screen.getByText(/remain governed by their own verified snapshot/),
    ).toBeVisible();
  });

  it("keeps a stable loading state while ranked evidence is pending", async () => {
    const listOpportunities = vi.fn(
      () => new Promise<RankedOpportunityPageDto>(() => undefined),
    );
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listOpportunities },
        }}
      />,
    );
    expect(
      await screen.findByRole("status", {
        name: "Loading ranked opportunities",
      }),
    ).toBeVisible();
  });

  it("preserves server order and renders evidence with honest actions", async () => {
    const items = [
      dashboardOpportunity("a", 0.14),
      dashboardOpportunity("b", 0.08),
    ];
    const listOpportunities = vi.fn(() =>
      Promise.resolve(dashboardPage(items)),
    );
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listOpportunities },
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Away A vs Home A" }),
    ).toBeVisible();
    const cards = document.querySelectorAll("[data-opportunity-id]");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute(
      "data-opportunity-id",
      items[0]!.opportunityId,
    );
    expect(cards[1]).toHaveAttribute(
      "data-opportunity-id",
      items[1]!.opportunityId,
    );
    expect(screen.getAllByText("14.00%")[0]).toBeVisible();
    expect(
      screen.getAllByText("Model estimate, not a guarantee")[0],
    ).toBeVisible();
    expect(screen.getAllByText(/Model and data confidence/)[0]).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Add Bet" })[0],
    ).toBeDisabled();
    expect(
      screen.getAllByRole("link", { name: /Open event/ })[0],
    ).toHaveAttribute("href", expect.stringContaining("/events/event-a"));
  });

  it("shows empty and explicit incomplete lower-bound states", async () => {
    const listOpportunities = vi
      .fn()
      .mockResolvedValueOnce(dashboardPage([]))
      .mockResolvedValueOnce(
        dashboardPage([dashboardOpportunity("s", 0.04)], {
          evaluationState: "partial",
          hasMoreUnknown: true,
          filteredCount: 2,
        }),
      );
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listOpportunities },
        }}
      />,
    );
    expect(await screen.findByText("No qualified edge")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "MLS" }));
    expect(
      await screen.findByText(
        "Verified opportunities from incomplete evaluation",
      ),
    ).toBeVisible();
    expect(screen.getByText("1+")).toBeVisible();
    expect(screen.getByText(/verified lower bound/i)).toBeVisible();
  });

  it("does not turn an empty partial evaluation into a no-edge claim", async () => {
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(),
            listOpportunities: vi.fn(() =>
              Promise.resolve(
                dashboardPage([], {
                  evaluationState: "partial",
                  hasMoreUnknown: true,
                  filteredCount: 3,
                }),
              ),
            ),
          },
        }}
      />,
    );
    expect(
      await screen.findByText(
        "Verified opportunities from incomplete evaluation",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("No verified opportunity in this partial result"),
    ).toBeVisible();
    expect(screen.queryByText("No qualified edge")).not.toBeInTheDocument();
  });

  it("distinguishes known exclusions from known continuation", async () => {
    const listOpportunities = vi
      .fn()
      .mockResolvedValueOnce(
        dashboardPage([dashboardOpportunity("k", 0.06)], {
          evaluatedCount: 3,
          filteredCount: 1,
          staleCount: 1,
        }),
      )
      .mockResolvedValueOnce(
        dashboardPage([dashboardOpportunity("m", 0.05)], {
          nextCursor: "known-more",
        }),
      );
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listOpportunities },
        }}
      />,
    );
    expect(
      await screen.findByText("Evaluation exclusions applied"),
    ).toBeVisible();
    expect(screen.getByText("Exact current page")).toBeVisible();
    expect(
      within(
        screen.getByText("Active +EV shown").closest("article")!,
      ).getByText("1"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "MLS" }));
    expect(
      await screen.findByText("More ranked opportunities are available"),
    ).toBeVisible();
    expect(
      screen.queryByText("Verified opportunities from incomplete evaluation"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1+")).toBeVisible();
  });

  it("renders a safe failure and retries on request", async () => {
    const listOpportunities = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider secret"))
      .mockResolvedValueOnce(dashboardPage([]));
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: { list: vi.fn(), listOpportunities },
        }}
      />,
    );
    expect(
      await screen.findByText("Opportunities are temporarily unavailable."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No qualified edge")).toBeVisible();
    expect(listOpportunities).toHaveBeenCalledTimes(2);
  });

  it("keeps sparse evidence explicit and removes expired cards", async () => {
    const sparse = dashboardOpportunity("x", 0.05, {
      bestComparison: null,
      warningCodes: [
        "comparison-outlier-excluded",
        "market-disagreement-warning",
      ],
    });
    const expired = dashboardOpportunity("z", 0.04, {
      liveFreshness: {
        scoredAt: "2000-01-01T00:05:00.000Z",
        oldestRequiredEvidenceAt: "2000-01-01T00:00:00.000Z",
        ageMinutes: 5,
        maximumAgeMinutes: 15,
        expiresAt: "2000-01-01T00:15:00.001Z",
      },
    });
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(),
            listOpportunities: vi.fn(() =>
              Promise.resolve(dashboardPage([sparse, expired])),
            ),
          },
        }}
      />,
    );
    expect(
      await screen.findByText("No included comparison price"),
    ).toBeVisible();
    expect(screen.getByText("Comparison outlier excluded")).toBeVisible();
    expect(screen.getByText("Market disagreement warning")).toBeVisible();
    expect(
      document.querySelector(
        `[data-opportunity-id="${expired.opportunityId}"]`,
      ),
    ).toBeNull();
  });

  it("does not claim no edge when every loaded opportunity has expired", async () => {
    const expired = dashboardOpportunity("q", 0.04, {
      liveFreshness: {
        scoredAt: "2000-01-01T00:05:00.000Z",
        oldestRequiredEvidenceAt: "2000-01-01T00:00:00.000Z",
        ageMinutes: 5,
        maximumAgeMinutes: 15,
        expiresAt: "2000-01-01T00:15:00.001Z",
      },
    });
    render(
      <App
        initialPath="/dashboard"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(),
            listOpportunities: vi.fn(() =>
              Promise.resolve(dashboardPage([expired])),
            ),
          },
        }}
      />,
    );
    expect(
      await screen.findByText("Previously loaded evidence has expired"),
    ).toBeVisible();
    expect(screen.getByText(/this is not a no-edge claim/i)).toBeVisible();
    expect(screen.queryByText("No qualified edge")).not.toBeInTheDocument();
  });
});

describe("Data Sources", () => {
  it("renders connection and capacity independently with safe impact copy", async () => {
    const outage = providerScope({
      connection: "outage",
      safeReason: "provider-unavailable",
      lastCheckedAt: "2099-08-07T11:59:00.000Z",
      lastSuccessfulAt: "2099-08-07T11:45:00.000Z",
      retryAt: "2099-08-07T12:05:00.000Z",
      freshness: { ageSeconds: 900, expectedSeconds: 900 },
      capacity: {
        state: "exhausted",
        limit: 1000,
        remaining: 0,
        reserve: 100,
        resetsAt: "2099-08-07T12:10:00.000Z",
      },
      recommendationImpact: "suppressed",
    });
    render(
      <App
        initialPath="/data-sources"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(),
            providerStatus: vi.fn(() =>
              Promise.resolve(providerPage([outage])),
            ),
          },
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Data Sources" }),
    ).toBeVisible();
    expect(await screen.findByText("Outage")).toBeVisible();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          element.textContent?.includes("0 of 1000 requests remain") === true,
      ),
    ).toBeVisible();
    expect(screen.getByText(/Aug 7, 2099, 8:05 AM Eastern/i)).toBeVisible();
    expect(screen.getByText(/not subscription quota/i)).toBeVisible();
    expect(screen.getByText(/suppressed server-side/)).toBeVisible();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("Games", () => {
  beforeEach(() => {
    // View preferences persist in localStorage; tests must not leak them.
    window.localStorage.removeItem("fte.eventView");
  });
  it("starts one scheduled-event scouting action and opens its authoritative route", async () => {
    // Inline Scout actions live on the cards layout since the table
    // rows became the navigation affordance.
    window.localStorage.setItem("fte.eventView", "cards");
    const scoutingJob = {
      schemaVersion: 1 as const,
      jobId: `scout-job:${"a".repeat(64)}`,
      eventId: game.id,
      eventVersion: 1,
      workflowIntent: "fixture-v1" as const,
      status: "queued" as const,
      stateVersion: 1,
      attemptNumber: 1,
      createdAt: "2026-08-07T13:00:00.000Z",
      updatedAt: "2026-08-07T13:00:00.000Z",
    };
    const createScoutingJob = vi.fn(() => Promise.resolve(scoutingJob));
    const getScoutingJob = vi.fn(() => Promise.resolve(scoutingJob));
    render(
      <App
        initialPath="/events?day=2026-08-01"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(() => Promise.resolve(page())),
            createScoutingJob,
            getScoutingJob,
          },
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Scout" }));
    expect(
      await screen.findByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    expect(createScoutingJob).toHaveBeenCalledWith(
      game.id,
      expect.stringMatching(/^[A-Za-z0-9._:-]+$/),
      expect.any(AbortSignal),
    );
    expect(getScoutingJob).toHaveBeenCalledWith(
      scoutingJob.jobId,
      expect.any(AbortSignal),
    );
  });

  it("resumes the initiating scouting action after the sign-in callback", async () => {
    // Inline Scout actions live on the cards layout since the table
    // rows became the navigation affordance.
    window.localStorage.setItem("fte.eventView", "cards");
    const scoutingJob = {
      schemaVersion: 1 as const,
      jobId: `scout-job:${"a".repeat(64)}`,
      eventId: game.id,
      eventVersion: 1,
      workflowIntent: "fixture-v1" as const,
      status: "queued" as const,
      stateVersion: 1,
      attemptNumber: 1,
      createdAt: "2026-08-07T13:00:00.000Z",
      updatedAt: "2026-08-07T13:00:00.000Z",
    };
    const createScoutingJob = vi.fn(() => Promise.resolve(scoutingJob));
    sessionStorage.setItem(
      `fte.scouting.resume.create.${encodeURIComponent(game.id)}`,
      "1",
    );
    render(
      <App
        initialPath="/events?day=2026-08-01"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(() => Promise.resolve(page())),
            createScoutingJob,
            getScoutingJob: vi.fn(() => Promise.resolve(scoutingJob)),
          },
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    expect(createScoutingJob).toHaveBeenCalledTimes(1);
    expect(
      sessionStorage.getItem(
        `fte.scouting.resume.create.${encodeURIComponent(game.id)}`,
      ),
    ).toBeNull();
  });

  it("disables scouting with explicit lifecycle guidance for nonscheduled events", async () => {
    // Inline Scout actions live on the cards layout since the table
    // rows became the navigation affordance.
    window.localStorage.setItem("fte.eventView", "cards");
    const completed = { ...game, status: "completed" as const };
    const createScoutingJob = vi.fn();
    const resumeKey = `fte.scouting.resume.create.${encodeURIComponent(game.id)}`;
    sessionStorage.setItem(resumeKey, "1");
    render(
      <App
        initialPath="/events?day=2026-08-01"
        gamesClient={{
          ok: true,
          value: {
            list: vi.fn(() => Promise.resolve(page([completed]))),
            createScoutingJob,
          },
        }}
      />,
    );
    expect(await screen.findByRole("button", { name: "Scout" })).toBeDisabled();
    expect(
      screen.getByText(/available only for scheduled events.*completed/i),
    ).toBeVisible();
    await waitFor(() => expect(sessionStorage.getItem(resumeKey)).toBeNull());
    expect(createScoutingJob).not.toHaveBeenCalled();
  });

  it("renders fixture odds and filters by sport and Eastern day", async () => {
    const list = vi
      .fn<GamesClient["list"]>()
      .mockImplementation(({ sport }) =>
        Promise.resolve(sport === "mlb" ? page() : page([])),
      );
    render(
      <App initialPath="/events" gamesClient={{ ok: true, value: { list } }} />,
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
    expect(screen.getByText("Aug 1 · 7:05 PM ET")).toBeInTheDocument();
    const price = screen.getByText("+120");
    // The game block footer carries odds freshness instead of a timestamp.
    expect(price.closest(".event-card")?.textContent).toMatch(/odds \d+m old/);
    fireEvent.click(screen.getByRole("button", { name: "MLB" }));
    // Both sports load per poll so the rail can size and hide its pills.
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Loading games…")).not.toBeInTheDocument();
    // A sport with no slate for the day earns no pill.
    expect(
      screen.queryByRole("button", { name: "Soccer" }),
    ).not.toBeInTheDocument();
    cleanup();
    render(
      <App
        initialPath="/events?sport=soccer"
        gamesClient={{ ok: true, value: { list } }}
      />,
    );
    expect(
      await screen.findByText(
        "No Soccer events exist for this day and lifecycle selection.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Boston vs New York" }),
    ).not.toBeInTheDocument();
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
      <App initialPath="/events" gamesClient={{ ok: true, value: { list } }} />,
    );
    expect(await screen.findByText("Aug 1 · 7:05 PM ET")).toBeInTheDocument();
    expect(screen.queryByText(/UNTRUSTED/)).not.toBeInTheDocument();
  });

  it("renders every three-way soccer selection", async () => {
    const list = vi
      .fn<GamesClient["list"]>()
      .mockResolvedValue(page([soccerGame]));
    render(
      <App
        initialPath="/events?sport=soccer"
        gamesClient={{ ok: true, value: { list } }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Miami vs Atlanta" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+145")).toBeInTheDocument();
    expect(screen.getByText("+220")).toBeInTheDocument();
    expect(screen.getByText("+175")).toBeInTheDocument();
    expect(screen.getByText("Tie")).toBeInTheDocument();
  });

  it("shows configuration failure without making a request", async () => {
    render(
      <App
        initialPath="/events"
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
    // The initial soccer slate hangs; MLB resolves so its pill renders.
    const list = vi
      .fn<GamesClient["list"]>()
      .mockImplementation(({ sport }) =>
        sport === "soccer" ? old : Promise.resolve(page()),
      );
    render(
      <App
        initialPath="/events?sport=soccer"
        gamesClient={{ ok: true, value: { list } }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "MLB" }));
    expect(
      await screen.findByRole("heading", { name: "Boston vs New York" }),
    ).toBeInTheDocument();
    // The abandoned soccer request resolves late and must not clobber MLB.
    resolveOld(page([]));
    await Promise.resolve();
    expect(
      screen.getByRole("heading", { name: "Boston vs New York" }),
    ).toBeInTheDocument();
  });
});

describe("Betting splits", () => {
  const boardStats = () =>
    (document.querySelector(".csx-stats")?.textContent ?? "")
      .replace(/\u00b7/g, " \u00b7 ")
      .replace(/\s+/g, " ")
      .trim();
  const expectStats = async (
    games: number,
    withData: number,
    count: number,
  ) => {
    await waitFor(() =>
      expect(boardStats()).toBe(
        `${games} games \u00b7 ${withData} with data \u00b7 ${count} observations \u00b7 tickets vs money across each market`,
      ),
    );
  };

  it("refreshes an empty board when newly ingested splits become available", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let mlbCalls = 0;
      const listSplits = vi
        .fn<NonNullable<GamesClient["listSplits"]>>()
        .mockImplementation((filter) => {
          if (filter.sport !== "mlb") return Promise.resolve(splitsPage([]));
          mlbCalls += 1;
          return Promise.resolve(
            mlbCalls === 1
              ? splitsPage([{ ...splitGame, splits: [] }])
              : splitsPage(),
          );
        });
      render(
        <App
          initialPath="/splits"
          gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
        />,
      );

      await expectStats(1, 0, 0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await expectStats(1, 1, 6);
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
      let mlbCalls = 0;
      const listSplits = vi
        .fn<NonNullable<GamesClient["listSplits"]>>()
        .mockImplementation((filter) => {
          if (filter.sport !== "mlb") return Promise.resolve(splitsPage([]));
          mlbCalls += 1;
          if (mlbCalls === 1) return Promise.resolve(splitsPage());
          if (mlbCalls === 2)
            return Promise.reject(new Error("temporary failure"));
          return Promise.resolve(splitsPage([refreshed]));
        });
      render(
        <App
          initialPath="/splits"
          gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
        />,
      );

      expect(
        await screen.findByRole("img", { name: /45% bets/ }),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByRole("img", { name: /45% bets/ })).toBeInTheDocument();
      expect(
        screen.queryByText("Betting splits are temporarily unavailable."),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Refresh delayed.")).toBeInTheDocument();
      expect(
        screen.getByText(/Showing the last valid board while we retry/),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(
        await screen.findByRole("img", { name: /47% bets/ }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Refresh delayed.")).not.toBeInTheDocument();
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

    expect(
      (await screen.findByText("Boston")).closest(".csx-row-team"),
    ).not.toBeNull();
    expect(
      screen.getByText("New York").closest(".csx-row-team"),
    ).not.toBeNull();
    for (const market of ["SPREAD", "TOTAL", "MONEYLINE"])
      expect(screen.getByText(market)).toBeInTheDocument();
    expect(screen.getByText("+1.5")).toBeInTheDocument();
    expect(screen.getByText("O 8.5")).toBeInTheDocument();
    expect(screen.getByText("U 8.5")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Spread for Boston: 64% handle, 38% bets, 26 percentage points money-heavy",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Spread for New York: 36% handle, 62% bets, 26 percentage points ticket-heavy",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("+26")).toBeInTheDocument();
    expect(screen.getByText("−26")).toBeInTheDocument();
    // The book renders once per game under the away team; the header status
    // chip repeats it beside the freshest time.
    expect(screen.getAllByText("Circa/DK")).toHaveLength(1);
    expect(screen.getByText(/Circa\/DK · /)).toBeInTheDocument();
    // The consensus explainer sits behind the info toggle now.
    expect(
      screen.queryByText("Consensus is context—not a pick."),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "What consensus means" }),
    );
    expect(
      screen.getByText("Consensus is context—not a pick."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText("Consensus is context—not a pick."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Game details →")).not.toBeInTheDocument();
  });

  it("renders signed American odds in populated moneyline line cells", async () => {
    const pricedGame = {
      ...splitGame,
      splits: splitGame.splits.map((split) =>
        split.marketKey !== "moneyline"
          ? split
          : {
              ...split,
              americanOdds: split.selectionKey === "away" ? 145 : -162,
            },
      ),
    };
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([pricedGame]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(await screen.findByText("+145")).toBeInTheDocument();
    expect(screen.getByText("-162")).toBeInTheDocument();
    expect(screen.queryByText("No line")).not.toBeInTheDocument();
  });

  it("preserves missing provider values without manufacturing a percentage", async () => {
    const { betPercent: removedBetPercent, ...handleOnlyBase } =
      splitGame.splits[0]!;
    void removedBetPercent;
    const handleOnly = {
      ...handleOnlyBase,
      id: "split-away-spread-handle-only",
    };
    const betsOnly = {
      ...splitGame.splits[3]!,
      id: "split-under-total-bets-only",
      scope: "consensus",
    };
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          {
            ...splitGame,
            splits: [handleOnly, betsOnly],
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
    // A missing side never manufactures a divergence: the delta shows a dash.
    const betsOnlyBar = screen.getByRole("img", {
      name: "Total for New York: handle unavailable, 49% bets",
    });
    expect(betsOnlyBar.querySelector(".csx-bar-fill")).toBeNull();
    expect(betsOnlyBar.querySelector(".csx-bar-notch")).not.toBeNull();
    expect(betsOnlyBar.querySelector(".csx-bar-delta")).toHaveTextContent("—");
    const handleOnlyBar = screen.getByRole("img", {
      name: "Spread for Boston: 64% handle, bets unavailable",
    });
    expect(handleOnlyBar.querySelector(".csx-bar-notch")).toBeNull();
    expect(handleOnlyBar.querySelector(".csx-bar-fill")).toHaveStyle({
      width: "74.24px",
    });
    expect(handleOnlyBar.querySelector(".csx-bar-delta")).toHaveTextContent(
      "—",
    );
  });

  it("keeps endpoint notches visible and labels even splits without relying on color", async () => {
    const endpointGame = {
      ...splitGame,
      splits: [
        {
          ...splitGame.splits[0]!,
          id: "endpoint-away",
          moneyPercent: 0,
          betPercent: 100,
          scope: "consensus",
        },
        {
          ...splitGame.splits[1]!,
          id: "endpoint-home",
          moneyPercent: 100,
          betPercent: 0,
          scope: "consensus",
        },
        {
          ...splitGame.splits[2]!,
          id: "endpoint-even",
          moneyPercent: 50,
          betPercent: 50,
          scope: "consensus",
        },
        {
          ...splitGame.splits[4]!,
          id: "endpoint-sub-hundredth",
          moneyPercent: 50.004,
          betPercent: 50.001,
          scope: "consensus",
        },
      ],
    } satisfies SplitsPageDto["items"][number];
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([endpointGame]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    const endpoint = await screen.findByRole("img", {
      name: "Spread for Boston: 0% handle, 100% bets, 100 percentage points ticket-heavy",
    });
    expect(endpoint.querySelector(".csx-bar-fill")).toHaveStyle({
      width: "0px",
    });
    // The notch never leaves the visible track, even at 100%.
    expect(endpoint.querySelector(".csx-bar-notch")).toHaveStyle({
      left: "114px",
    });
    const zeroNotch = screen.getByRole("img", {
      name: "Spread for New York: 100% handle, 0% bets, 100 percentage points money-heavy",
    });
    expect(zeroNotch.querySelector(".csx-bar-notch")).toHaveStyle({
      left: "0px",
    });
    expect(
      screen.getByRole("img", {
        name: "Total for Boston: 50% handle, 50% bets, 0 percentage points even",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Moneyline for Boston: 50.004% handle, 50.001% bets, 0.003 percentage points money-heavy",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("−100")).toBeInTheDocument();
    expect(screen.getByText("+100")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("+<0.01")).toBeInTheDocument();
  });

  it("does not count records without either split percentage as coverage", async () => {
    const {
      moneyPercent: removedMoneyPercent,
      betPercent: removedBetPercent,
      ...unusableBase
    } = splitGame.splits[0]!;
    void removedMoneyPercent;
    void removedBetPercent;
    const unusable = {
      ...unusableBase,
      id: "line-only-split",
      scope: "line-only-book",
    };
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage([{ ...splitGame, splits: [unusable] }]));
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    await expectStats(1, 0, 0);
    expect(screen.getByText("No split data")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show line-only-book splits" }),
    ).not.toBeInTheDocument();
  });

  it("keeps filters usable for empty results and reports failures", async () => {
    let calls = 0;
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockImplementation(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(splitsPage([]))
          : Promise.reject(new Error("redacted provider failure"));
      });
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(
      await screen.findByText("No scheduled games are available for this day."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Eastern calendar day"), {
      target: { value: "2026-08-02" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Betting splits are temporarily unavailable.",
    );
    expect(
      screen.queryByText("redacted provider failure"),
    ).not.toBeInTheDocument();
  });

  it("collapses source history into one canonical consensus row", async () => {
    const base = splitGame.splits[0]!;
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          {
            ...splitGame,
            splits: [
              {
                ...base,
                id: "circa-history",
                scope: "circa",
                moneyPercent: 29,
              },
              {
                ...base,
                id: "draftkings-history",
                scope: "draftkings",
                moneyPercent: 71,
              },
              {
                ...base,
                id: "provider-consensus",
                scope: "consensus",
                moneyPercent: 64,
              },
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

    expect(
      await screen.findByRole("img", { name: /64% handle/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /71% handle/ })).toBeNull();
    expect(screen.queryByRole("img", { name: /29% handle/ })).toBeNull();
    expect(screen.getAllByText("Boston")).toHaveLength(1);
    await expectStats(1, 1, 1);
    expect(screen.queryByText("All books")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Show .* splits/ }),
    ).not.toBeInTheDocument();
  });

  it("uses a deterministic fallback when only source history is available", async () => {
    const base = splitGame.splits[0]!;
    const circaGame = {
      ...splitGame,
      id: "event:mlb:circa-only",
      participants: [
        { id: "participant:mlb:chicago", label: "Chicago" },
        { id: "participant:mlb:detroit", label: "Detroit" },
      ],
      splits: [
        {
          ...base,
          id: "circa-away-spread",
          canonicalEventId: "event:mlb:circa-only",
          scope: "circa",
          moneyPercent: 43,
        },
      ],
    } satisfies SplitsPageDto["items"][number];
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          {
            ...splitGame,
            splits: [
              {
                ...base,
                id: "draftkings-away-spread",
                scope: "draftkings",
                moneyPercent: 71,
              },
              {
                ...base,
                id: "circa-boston-away-spread",
                scope: "circa",
                moneyPercent: 29,
              },
            ],
          },
          circaGame,
        ]),
      );
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    expect(
      await screen.findByRole("img", { name: /71% handle/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("29%")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /43% handle/ })).toBeInTheDocument();
    expect(screen.getAllByText("Boston")).toHaveLength(1);
    await expectStats(2, 2, 2);
    expect(screen.getByText("Chicago")).toBeInTheDocument();
    expect(screen.getByText("Detroit")).toBeInTheDocument();
    expect(screen.queryByText("All books")).not.toBeInTheDocument();
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
    await expectStats(2, 2, 12);
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
    // Freshness now renders as the status dot, never as a live claim.
    await waitFor(() =>
      expect(document.querySelector(".csx-dot.stale")).not.toBeNull(),
    );
    expect(screen.queryByText(/LIVE CONSENSUS/)).not.toBeInTheDocument();
    unmount();
    // A second app instance must not inherit the first instance's board.
    clearSplitsCache();

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
    // Without a single valid timestamp there is no freshness time to show.
    await waitFor(() =>
      expect(document.querySelector(".csx-dot.stale")).not.toBeNull(),
    );
    expect(screen.queryByText(/Circa\/DK · /)).not.toBeInTheDocument();
  });

  it("shows scheduled games without observations in the consensus board", async () => {
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
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("Local Book")).not.toBeInTheDocument();
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

    await expectStats(8, 1, covered.splits.length);
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

    await screen.findByText("Boston");
    // Page timestamps never masquerade as split freshness: without any split
    // observation the status chip shows no time and the dot reads stale.
    expect(document.querySelector(".csx-dot.stale")).not.toBeNull();
    expect(screen.queryByText(/Circa\/DK · /)).not.toBeInTheDocument();
  });

  it("toggles between the three visualizations and keeps the choice", async () => {
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(splitsPage());
    const { unmount } = render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );
    await screen.findByText("Boston");

    // Default is split bars.
    expect(document.querySelectorAll(".csx-bar-track").length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByRole("button", { name: "Heat Cells" }));
    expect(document.querySelectorAll(".csx-bar-track")).toHaveLength(0);
    expect(document.querySelectorAll(".csx-heat-cell").length).toBeGreaterThan(
      0,
    );
    // Both percentages stay visible as numbers.
    expect(screen.getAllByText("64%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("38%").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Divergence" }));
    expect(document.querySelectorAll(".csx-heat-cell")).toHaveLength(0);
    const divergence = document.querySelectorAll(".csx-divergence-big");
    expect(divergence.length).toBeGreaterThan(0);
    // handle 64 − bets 38 = +26 points on the away spread.
    expect(screen.getAllByText("+26").length).toBeGreaterThan(0);
    expect(window.localStorage.getItem("fte.splitsView")).toBe("divergence");
    expect(
      screen.queryByRole("button", { name: "Compare All" }),
    ).not.toBeInTheDocument();
    unmount();

    // A fresh mount keeps the stored choice as its default.
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );
    await screen.findByText("Boston");
    expect(
      document.querySelectorAll(".csx-divergence-big").length,
    ).toBeGreaterThan(0);
    expect(document.querySelectorAll(".csx-bar-track")).toHaveLength(0);
  });

  it("offers no book chip when only one book covers the day", async () => {
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

    await screen.findByText("Boston");
    expect(
      screen.queryByRole("button", { name: /Circa\/DK|BetMGM/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("BetMGM")).toHaveLength(1);
    expect(screen.getByText(/BetMGM · /)).toBeInTheDocument();
  });

  it("filters the board between the consensus and BetMGM without duplicating games", async () => {
    const consensusSplits = splitGame.splits.map((split) => ({
      ...split,
      scope: "consensus",
    }));
    const betmgmSplits = splitGame.splits.map((split) => ({
      ...split,
      id: `${split.id}-betmgm`,
      scope: "betmgm",
      betPercent: 11,
      moneyPercent: 89,
    }));
    const listSplits = vi
      .fn<NonNullable<GamesClient["listSplits"]>>()
      .mockResolvedValue(
        splitsPage([
          { ...splitGame, splits: [...consensusSplits, ...betmgmSplits] },
        ]),
      );
    render(
      <App
        initialPath="/splits"
        gamesClient={{ ok: true, value: { list: vi.fn(), listSplits } }}
      />,
    );

    // One book label per game proves the second book adds a chip, not a copy.
    await expectStats(1, 1, 6);
    expect(document.querySelectorAll(".csx-book")).toHaveLength(1);
    expect(document.querySelector(".csx-book")).toHaveTextContent("Circa/DK");
    expect(screen.queryByRole("img", { name: /89% handle/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "BetMGM" }));

    await expectStats(1, 1, 6);
    expect(document.querySelectorAll(".csx-book")).toHaveLength(1);
    expect(document.querySelector(".csx-book")).toHaveTextContent("BetMGM");
    expect(
      screen.getAllByRole("img", { name: /89% handle/ }).length,
    ).toBeGreaterThan(0);
  });
});
