import { expect, test } from "@playwright/test";

const expectedApiBase = process.env["FTE_PHASE1_API_BASE"];
const expectedWebOrigin = process.env["FTE_WEB_ORIGIN"];
if (!expectedApiBase) throw new Error("FTE_PHASE1_API_BASE is required");
if (!expectedWebOrigin) throw new Error("FTE_WEB_ORIGIN is required");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.removeItem("fte.oauth.session");
    sessionStorage.removeItem("fte.oauth.state");
    sessionStorage.removeItem("fte.oauth.verifier");
  });
  await page.goto("/games");
  await page.waitForURL(/\/games$/);
});

test("real hosted bundle loads MLB, MLS, another day, and empty state", async ({
  page,
}) => {
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
  await expect(page.getByText("-135")).toBeVisible();
  await page.getByRole("button", { name: "MLS" }).click();
  await expect(
    page.getByRole("heading", { name: "Miami vs Atlanta" }),
  ).toBeVisible();
  await expect(page.getByText("+145")).toBeVisible();
  await expect(page.getByText("+220")).toBeVisible();
  await expect(page.getByText("+175")).toBeVisible();
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

test("anonymous session survives reload without Cognito state or redirects", async ({
  page,
}) => {
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Boston vs New York" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      session: sessionStorage.getItem("fte.oauth.session"),
      state: sessionStorage.getItem("fte.oauth.state"),
      verifier: sessionStorage.getItem("fte.oauth.verifier"),
      logoutInstalled:
        typeof (window as unknown as { __FTE_LOGOUT__?: unknown })
          .__FTE_LOGOUT__ === "function",
    })),
  ).toEqual({
    session: null,
    state: null,
    verifier: null,
    logoutInstalled: false,
  });
  expect(new URL(page.url()).origin).toBe(expectedWebOrigin);
});
