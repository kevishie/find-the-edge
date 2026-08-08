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
