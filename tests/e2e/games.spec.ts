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
