import { expect, test } from "@playwright/test";

import { startLocalGamesApi, type LocalGamesApi } from "./local-games-api";

let api: LocalGamesApi;

test.beforeAll(async () => {
  api = await startLocalGamesApi();
});

test.afterAll(async () => {
  await api.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((apiBase) => {
    Object.defineProperty(window, "__FTE_RUNTIME_CONFIG__", {
      value: { schemaVersion: 1, apiBase },
    });
  }, api.apiBase);
});

test("shows unchanged seeded MLB and MLS identifiers without authentication", async ({
  page,
}) => {
  await page.goto("/games");
  await page.getByLabel("Eastern calendar day").fill("2026-08-01");
  await expect(
    page.getByRole("heading", { name: "Boston Red Sox vs New York Yankees" }),
  ).toBeVisible();
  const boston = page.locator(
    '[data-event-id="event:mlb%3Amlb:2026-regular-boston-new-york-001"]',
  );
  await expect(boston).toHaveAttribute(
    "data-event-id",
    "event:mlb%3Amlb:2026-regular-boston-new-york-001",
  );
  await expect(page.getByText("+120")).toBeVisible();
  await expect(page.getByText("-135")).toBeVisible();
  if ((await page.locator(".mobile-market-prices:visible").count()) > 0) {
    await expect(page.locator(".mobile-market-prices")).toContainText(
      "moneyline Boston Red Sox +120",
    );
  }
  await expect(page.getByText("Aug 1, 2026, 7:05 PM Eastern")).toBeVisible();
  await expect(boston.getByLabel("Lifecycle: scheduled")).toBeVisible();
  await expect(boston.getByLabel("Event metadata is current")).toBeVisible();
  await expect(boston.getByText(/Evidence .* Eastern/)).toBeVisible();

  await page.getByRole("button", { name: "MLS" }).click();
  await expect(
    page.getByRole("heading", { name: "Miami vs Atlanta" }),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-event-id="event:soccer%3Amls:2026-regular-miami-atlanta-001"]',
    ),
  ).toHaveAttribute(
    "data-event-id",
    "event:soccer%3Amls:2026-regular-miami-atlanta-001",
  );
  await expect(page.getByText("+145")).toBeVisible();
  await expect(page.getByText("+220")).toBeVisible();
  await expect(page.getByText("+175")).toBeVisible();

  await page.getByLabel("Eastern calendar day").fill("2026-08-03");
  await expect(
    page.getByText("No MLS events exist for this day and lifecycle selection."),
  ).toBeVisible();
});

test("combines lifecycle and participant filters and opens canonical detail", async ({
  page,
}) => {
  await page.goto("/games?day=2026-08-01&sport=mlb&status=all");
  await page.getByLabel("Sort events").selectOption("matchup");
  await expect
    .poll(async () =>
      page
        .locator(".event-explorer-table h2, .event-explorer-cards h2")
        .allTextContents(),
    )
    .toEqual([
      "Baltimore Orioles vs Toronto Blue Jays",
      "Boston Red Sox vs New York Yankees",
    ]);
  await page
    .getByRole("combobox", { name: "Competition" })
    .selectOption("mlb-cup");
  await page.getByLabel("Participant search").fill("Toronto");
  await expect(
    page.getByRole("heading", {
      name: "Baltimore Orioles vs Toronto Blue Jays",
    }),
  ).toBeVisible();
  await page.getByLabel("Participant search").fill("Nobody");
  await expect(
    page.getByText("No events match the active filters."),
  ).toBeVisible();
  await page.getByLabel("Participant search").fill("Toronto");
  await expect(page.getByLabel("Lifecycle: postponed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scout" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Watchlist" })).toBeDisabled();
  await expect(
    page.getByText("Unavailable: Scout API is not built yet."),
  ).toBeVisible();
  await expect(
    page.getByText("Unavailable: Watchlist API is not built yet."),
  ).toBeVisible();
  await page.getByRole("link", { name: "View Details" }).click();
  await expect(page).toHaveURL(/status=all/);
  await expect(page).toHaveURL(/competition=mlb-cup/);
  await expect(page).toHaveURL(/query=Toronto/);
  await expect(page).toHaveURL(/sort=matchup/);
  await expect(
    page.getByRole("heading", {
      name: "Baltimore Orioles vs Toronto Blue Jays",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Lifecycle: postponed")).toBeVisible();
  await page.getByRole("link", { name: "Back to games" }).click();
  await expect(page.getByLabel("Participant search")).toHaveValue("Toronto");
  await expect(page.getByLabel("Sort events")).toHaveValue("matchup");
  await expect(
    page.getByRole("combobox", { name: "Competition", exact: true }),
  ).toHaveValue("mlb-cup");
});

test("uses an explicit second MLB Eastern day", async ({ page }) => {
  await page.goto("/games");
  await page.getByLabel("Eastern calendar day").fill("2026-08-02");
  await expect(
    page.getByRole("heading", { name: "Chicago Cubs vs Detroit Tigers" }),
  ).toBeVisible();
  await expect(page.getByText("-105").first()).toBeVisible();
});

test("renders compact accessible split bars on desktop and mobile", async ({
  page,
}) => {
  await page.goto("/splits");
  await page.getByLabel("Eastern calendar day").fill("2026-08-01");

  await expect(page.getByText("Boston Red Sox").first()).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Spread" }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Handle vs bets" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Spread for Boston Red Sox: 64% handle, 38% bets, 26 percentage points money-heavy",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: "Spread for New York Yankees: 36% handle, 62% bets, 26 percentage points ticket-heavy",
    }),
  ).toBeVisible();
  await expect(page.getByText("No line")).toHaveCount(2);
  await page.getByRole("button", { name: "MLS" }).click();
  await expect(
    page.getByRole("img", {
      name: "Moneyline for Draw: 33% handle, 31% bets, 2 percentage points money-heavy",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "MLB" }).click();
  await expect(page.getByText("Boston Red Sox").first()).toBeVisible();

  const board = page.getByRole("region", {
    name: /Betting splits comparison table/,
  });
  await expect(board).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(board).toBeVisible();
  expect(
    await board.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  const stickyTeam = page.locator(".split-team").first();
  await expect(stickyTeam).toHaveCSS("position", "sticky");
  const beforeScroll = await stickyTeam.boundingBox();
  expect(beforeScroll).not.toBeNull();
  await board.evaluate((element) => {
    element.scrollLeft = 420;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () => (await stickyTeam.boundingBox())?.x)
    .toBeCloseTo(beforeScroll!.x, 0);
});

test("opens multi-book comparison directly and keeps Hard Rock first", async ({
  page,
}) => {
  await page.goto(
    "/games/event%3Amlb%253Amlb%3A2026-regular-boston-new-york-001?sport=mlb&day=2026-08-01",
  );
  await expect(
    page.getByRole("heading", { name: "Boston Red Sox vs New York Yankees" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sportsbook comparison" }),
  ).toBeVisible();
  const headings = page.locator(".comparison-board thead th");
  await expect(headings.nth(1)).toContainText("Hard Rock Bet");
  await expect(headings.nth(2)).toContainText("DraftKings");
  await expect(headings.nth(3)).toContainText("Pinnacle");
  await expect(
    page.getByRole("heading", { name: "Line movement & public money" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: /Implied probability movement across 3 sportsbooks/,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Sportsbook movement legend")).toContainText(
    "Pinnacle",
  );
  await expect(
    page.getByText("Sharp reference", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Public reference", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Target unavailable")).toBeVisible();
  await page.getByRole("tab", { name: "Moneyline" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Spread" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "Moneyline" })).toBeVisible();
});

test("shows target-missing and suspended evidence without treating it as active", async ({
  page,
}) => {
  const id = "event:mlb%3Amlb:2026-regular-boston-new-york-001";
  const source = (await (
    await page.request.get(`${api.apiBase}/events/${encodeURIComponent(id)}`)
  ).json()) as {
    item: {
      oddsComparison: {
        targetQualified: boolean;
        markets: { selections: { cells: Record<string, unknown> }[] }[];
      };
    };
  };
  const serveState = async (state: "unavailable" | "suspended") => {
    const body = structuredClone(source);
    body.item.oddsComparison.targetQualified = false;
    for (const selection of body.item.oddsComparison.markets[0]!.selections)
      selection.cells["hardrock"] =
        state === "unavailable"
          ? {
              state,
              eligible: false,
              reason: "price-unavailable",
              evidenceAt: null,
            }
          : {
              state,
              eligible: false,
              reason: "market-suspended",
              evidenceAt: "2026-08-01T12:15:00.000Z",
              americanOdds: 120,
              observedAt: "2026-08-01T12:00:00.000Z",
              retrievedAt: "2026-08-01T12:00:00.000Z",
            };
    await page.route("**/events/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      }),
    );
  };
  await serveState("unavailable");
  await page.goto(`/games/${encodeURIComponent(id)}?sport=mlb&day=2026-08-01`);
  await expect(page.getByText("Target unavailable")).toBeVisible();
  await expect(
    page.locator(".target-book.state-unavailable").first(),
  ).toContainText("Unavailable");
  await page.unroute("**/events/**");
  await serveState("suspended");
  await page.reload();
  await expect(
    page.locator(".target-book.state-suspended").first(),
  ).toContainText("Suspended");
  await expect(
    page.locator(".target-book.state-suspended").first(),
  ).not.toContainText("Best eligible");
});
