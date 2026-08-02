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
      value: { schemaVersion: 1, apiBase, tokenProviderKey: "e2eSession" },
    });
    Object.defineProperty(window, "__FTE_TOKEN_PROVIDERS__", {
      value: { e2eSession: () => Promise.resolve("local-e2e-token") },
    });
  }, api.apiBase);
});

test("shows unchanged seeded MLB and MLS identifiers through the authenticated handler", async ({
  page,
}) => {
  await page.goto("/games");
  await expect(
    page.getByRole("heading", { name: "Boston vs New York" }),
  ).toBeVisible();
  await expect(
    page.locator("article", { hasText: "Boston vs New York" }),
  ).toHaveAttribute(
    "data-event-id",
    "event:mlb%3Amlb:2026-regular-boston-new-york-001",
  );
  await expect(page.getByText("+120")).toBeVisible();
  await expect(page.getByText("Aug 1, 2026, 7:05 PM Eastern")).toBeVisible();

  await page.getByRole("button", { name: "MLS" }).click();
  await expect(
    page.getByRole("heading", { name: "Miami vs Atlanta" }),
  ).toBeVisible();
  await expect(
    page.locator("article", { hasText: "Miami vs Atlanta" }),
  ).toHaveAttribute(
    "data-event-id",
    "event:soccer%3Amls:2026-regular-miami-atlanta-001",
  );
  await expect(page.getByText("+145")).toBeVisible();

  await page.getByLabel("Eastern calendar day").fill("2026-08-03");
  await expect(
    page.getByText("No MLS games are scheduled for this day."),
  ).toBeVisible();
});

test("uses an explicit second MLB Eastern day", async ({ page }) => {
  await page.goto("/games");
  await page.getByLabel("Eastern calendar day").fill("2026-08-02");
  await expect(
    page.getByRole("heading", { name: "Chicago vs Detroit" }),
  ).toBeVisible();
  await expect(page.getByText("-105")).toBeVisible();
});
