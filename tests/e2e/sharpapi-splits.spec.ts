import { expect, test } from "@playwright/test";
import {
  startLocalSharpApiSplitsApi,
  type LocalSharpApiSplitsApi,
} from "./local-sharpapi-splits-api";

let api: LocalSharpApiSplitsApi;

test.beforeAll(async () => {
  api = await startLocalSharpApiSplitsApi();
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

test("projects one SharpAPI consensus board across every scheduled MLB game", async ({
  page,
}) => {
  await page.goto("/splits");
  const apiResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/splits" && url.searchParams.get("day") === api.day
    );
  });
  await page.getByLabel("Eastern calendar day").fill(api.day);
  const payload = (await (await apiResponse).json()) as {
    readonly items: readonly {
      readonly id: string;
      readonly splits: readonly {
        readonly id: string;
        readonly scope?: string;
      }[];
    }[];
  };
  expect(payload.items).toHaveLength(api.expectedGameCount);
  expect(new Set(payload.items.map(({ id }) => id)).size).toBe(
    api.expectedGameCount,
  );
  const observations = payload.items.flatMap(({ splits }) => splits);
  expect(new Set(observations.map(({ id }) => id)).size).toBe(
    observations.length,
  );
  expect(new Set(observations.map(({ scope }) => scope))).toEqual(
    new Set(["draftkings", "circa"]),
  );

  await expect(page.locator(".csx-stats")).toContainText(
    `${api.expectedGameCount} games`,
  );
  await expect(page.locator(".csx-stats")).toContainText("1 with data");
  await expect(page.locator(".csx-stats")).toContainText("2 observations");
  await expect(page.getByText("No split data")).toHaveCount(
    api.expectedGameCount - 1,
  );

  await expect(page.getByText("All books")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Show (DraftKings|Circa Sports) splits/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", {
      name: /Moneyline for Chicago White Sox: 65% handle, 55% bets, 10 percentage points money-heavy/,
    }),
  ).toBeVisible();
  // Two grid rows per game in the compact board.
  await expect(page.locator(".csx-row")).toHaveCount(api.expectedGameCount * 2);
  await expect(
    page.locator(".csx-book").filter({ hasText: "Circa/DK" }),
  ).toHaveCount(1);
  await expect(page.getByText("Game details →")).toHaveCount(0);

  const uncoveredRow = page
    .locator(".csx-row")
    .filter({ hasText: "No split data" })
    .first();
  // Uncovered games render dash lines and unavailable split cells.
  await expect(uncoveredRow.getByText("—", { exact: true })).toHaveCount(3);
  await expect(
    uncoveredRow.getByRole("img", { name: /split data unavailable/ }),
  ).toHaveCount(3);
});

test("opens the date picker from anywhere in the date chip", async ({
  page,
}) => {
  await page.goto("/splits");
  await expect(page.locator(".csx-date-chip")).toBeVisible();
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      '.csx-date-chip input[type="date"]',
    )!;
    (window as { __pickerOpened?: boolean }).__pickerOpened = false;
    input.showPicker = () => {
      (window as { __pickerOpened?: boolean }).__pickerOpened = true;
    };
  });
  // Click the far-left glyph edge of the chip, away from the native
  // calendar-indicator hotspot.
  const chip = await page.locator(".csx-date-chip").boundingBox();
  await page.mouse.click(chip!.x + 8, chip!.y + chip!.height / 2);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as { __pickerOpened?: boolean }).__pickerOpened,
      ),
    )
    .toBe(true);
});

test("pins the column headers below the card header while scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 540 });
  await page.goto("/splits");
  await page.getByLabel("Eastern calendar day").fill(api.day);
  await expect(page.locator(".csx-row")).toHaveCount(api.expectedGameCount * 2);

  await page.evaluate(() => window.scrollBy(0, 1000));
  await page.waitForFunction(() => window.scrollY >= 500);

  const header = await page.locator(".csx-header").boundingBox();
  const head = await page.locator(".csx-head").boundingBox();
  expect(header).not.toBeNull();
  expect(head).not.toBeNull();
  // The column headers rest directly beneath the sticky card header.
  expect(Math.abs(head!.y - (header!.y + header!.height))).toBeLessThanOrEqual(
    2,
  );
  expect(header!.y).toBeLessThanOrEqual(1);
});
