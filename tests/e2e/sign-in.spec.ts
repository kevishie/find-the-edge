import { anonymousTest as test, expect } from "./session";

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

test("returns a reader to the paywall they were sent from", async ({
  page,
}) => {
  // The paywall is reachable only with a session, so a signed-out visitor is
  // sent to the form — and must come back to the paywall, not to a default
  // board they never asked for. This exact case shipped broken once.
  await page.goto("/subscribe");
  await page.waitForURL(/\/login\?returnUrl=/);
  expect(new URL(page.url()).searchParams.get("returnUrl")).toBe("/subscribe");
});

test("refuses a return address that is not ours", async ({ page }) => {
  // The destination survives a round trip through the URL, so it is exactly
  // the kind of parameter an attacker crafts. Anything off-origin, or any
  // path this app does not serve, falls back to a default we control.
  for (const crafted of [
    "https://evil.example/steal",
    "//evil.example/steal",
    "/admin",
  ]) {
    await page.goto(`/login?returnUrl=${encodeURIComponent(crafted)}`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/returnUrl=%2Fevents/);
  }
});

test("signs in on our own form, lands where it started, survives a reload, and signs out", async ({
  page,
}) => {
  // A product route is not reachable signed out. The reader is sent to our
  // own form on this origin — never a hosted login — carrying where they were
  // headed so signing in resumes the journey.
  await page.goto(explorer);

  await expect(page).toHaveURL(/\/login\?returnUrl=/);
  expect(new URL(page.url()).host).toBe("127.0.0.1:4173");
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
  await expect(page).toHaveURL(/\/login\?returnUrl=/);

  await code.fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();

  // Back exactly where the reader was asked to sign in from.
  await expect(page).toHaveURL(/\/events\?/);
  await expect(page.getByText(/^Signed in …/)).toBeVisible();
  expect(new URL(page.url()).host).toBe("127.0.0.1:4173");

  await page.reload();
  await expect(page.getByText(/^Signed in …/)).toBeVisible();

  // Signing out leaves the product entirely; staying would show a shell whose
  // every request is about to fail. Nothing this app stored survives it.
  await page.evaluate(() => localStorage.setItem("fte.splitsView", "grid"));
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login\?returnUrl=%2F$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(
    page.evaluate(() => ({
      session: localStorage.getItem("fte.session.v1"),
      view: localStorage.getItem("fte.splitsView"),
    })),
  ).resolves.toEqual({ session: null, view: null });
});
