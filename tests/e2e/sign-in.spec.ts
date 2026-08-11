import { expect, test } from "@playwright/test";

import { startLocalGamesApi, type LocalGamesApi } from "./local-games-api";

let api: LocalGamesApi;

const corsHeaders = {
  "access-control-allow-origin": "http://127.0.0.1:4173",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const token = `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`;
const accountId = `account:${"b".repeat(64)}`;
const explorer = "/events?day=2026-08-01&sport=mlb&status=scheduled";

test.beforeAll(async () => {
  api = await startLocalGamesApi();
});

test.afterAll(async () => {
  await api.close();
});

test.beforeEach(async ({ page }) => {
  // No provider configuration at all: sign-in is ours, so nothing here points
  // at a hosted login.
  await page.addInitScript((apiBase) => {
    Object.defineProperty(window, "__FTE_RUNTIME_CONFIG__", {
      value: { schemaVersion: 1, apiBase },
    });
  }, api.apiBase);

  let requested = 0;
  await page.route(`${api.apiBase}/auth/otp/request`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    requested += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        schemaVersion: "auth-otp-request-v1",
        status: "accepted",
        expiresInSeconds: 300,
        resendAfterSeconds: 2,
      }),
    });
  });

  await page.route(`${api.apiBase}/auth/otp/verify`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const body: unknown = JSON.parse(route.request().postData() ?? "null");
    const code =
      typeof body === "object" && body !== null && "code" in body
        ? String(body.code)
        : "";
    // Only a code that was actually asked for and typed correctly verifies.
    if (requested === 0 || code !== "123456") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify({ error: "invalid-credentials" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        schemaVersion: "auth-session-v1",
        token,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        accountId,
      }),
    });
  });

  await page.route(`${api.apiBase}/auth/session/refresh`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        schemaVersion: "auth-session-v1",
        token,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        accountId,
      }),
    });
  });
});

test("signs in on our own form, lands where it started, survives a reload, and signs out", async ({
  page,
}) => {
  await page.goto(explorer);

  const signIn = page.getByRole("link", { name: "Sign in" });
  await expect(signIn).toBeVisible();
  // The affordance is a route on this origin, never a hosted login.
  await expect(signIn).toHaveAttribute("href", /^\/sign-in\?/);
  await signIn.click();

  await expect(page).toHaveURL(/\/sign-in\?from=/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("html")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("html").evaluate((element) => element.clientWidth),
  );

  await page.getByLabel("Mobile number").fill("(555) 123-4567");
  await expect(page.getByText("We will text +1 (555) 123-4567.")).toBeVisible();
  await page.getByRole("button", { name: "Send code" }).click();

  const code = page.getByLabel("6-digit code");
  await expect(code).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Resend code in / }),
  ).toBeDisabled();

  // A wrong code says one neutral thing and keeps the reader on the form.
  await code.fill("000000");
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(page.getByRole("alert")).toHaveText("That code did not work.");
  await expect(page).toHaveURL(/\/sign-in\?from=/);

  await code.fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();

  // Back exactly where the reader was asked to sign in from.
  await expect(page).toHaveURL(/\/events\?/);
  await expect(page.getByText(/^Signed in …/)).toBeVisible();
  expect(new URL(page.url()).host).toBe("127.0.0.1:4173");

  await page.reload();
  await expect(page.getByText(/^Signed in …/)).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(
    page.evaluate(() => window.localStorage.getItem("fte.session.v1")),
  ).resolves.toBeNull();
});
