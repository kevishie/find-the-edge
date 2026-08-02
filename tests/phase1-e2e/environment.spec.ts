import { expect, test } from "@playwright/test";

const accessToken = process.env["FTE_PHASE1_ACCESS_TOKEN"];
const expectedApiBase = process.env["FTE_PHASE1_API_BASE"];
if (!accessToken) throw new Error("FTE_PHASE1_ACCESS_TOKEN is required");
if (!expectedApiBase) throw new Error("FTE_PHASE1_API_BASE is required");

test.beforeEach(async ({ page }) => {
  await page.addInitScript((token) => {
    Object.defineProperty(window, "__FTE_TOKEN_PROVIDERS__", {
      value: Object.freeze({ hostSession: () => Promise.resolve(token) }),
    });
  }, accessToken);
});

test("real hosted bundle loads MLB, MLS, another day, and empty state", async ({
  page,
}) => {
  await page.goto("/games");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = window as unknown as Record<string, unknown>;
        const config = host["__FTE_RUNTIME_CONFIG__"] as
          { apiBase?: unknown } | undefined;
        return config?.apiBase;
      }),
    )
    .toBe(expectedApiBase.replace(/\/$/, ""));
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
  await page.getByRole("button", { name: "MLS" }).click();
  await expect(
    page.getByRole("heading", { name: "Miami vs Atlanta" }),
  ).toBeVisible();
  await expect(page.getByText("+145")).toBeVisible();
  await page.getByRole("button", { name: "MLB" }).click();
  await page.getByLabel("Eastern calendar day").fill("2026-08-02");
  await expect(
    page.getByRole("heading", { name: "Chicago vs Detroit" }),
  ).toBeVisible();
  await expect(page.getByText("-105").first()).toBeVisible();
  await page.getByLabel("Eastern calendar day").fill("2026-08-03");
  await expect(
    page.getByText("No MLB games are scheduled for this day."),
  ).toBeVisible();
});
