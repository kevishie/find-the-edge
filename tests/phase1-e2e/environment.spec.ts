import { expect, test } from "@playwright/test";

const expectedApiBase = process.env["FTE_PHASE1_API_BASE"];
const username = process.env["FTE_PHASE1_USERNAME"];
const password = process.env["FTE_PHASE1_PASSWORD"];
const expectedWebOrigin = process.env["FTE_WEB_ORIGIN"];
if (!expectedApiBase) throw new Error("FTE_PHASE1_API_BASE is required");
if (!username || !password)
  throw new Error("Private browser credentials are required");
if (!expectedWebOrigin) throw new Error("FTE_WEB_ORIGIN is required");

test.beforeEach(async ({ page }) => {
  await page.goto("/games");
  await page
    .locator('input[name="username"]:visible, input[type="email"]:visible')
    .first()
    .fill(username);
  await page
    .locator('input[name="password"]:visible, input[type="password"]:visible')
    .first()
    .fill(password);
  await page
    .locator('button:visible, input[type="submit"][value="Sign in"]:visible')
    .first()
    .click();
  await page.waitForURL(/\/games$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("fte.oauth.session");
        if (!raw) return false;
        const session = JSON.parse(raw) as Record<string, unknown>;
        return typeof session["accessToken"] === "string";
      }),
    )
    .toBe(true);
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

test("real Cognito session survives reload, refreshes, and logout requires re-auth", async ({
  page,
}) => {
  const readSession = () =>
    page.evaluate(() => {
      const value = JSON.parse(
        sessionStorage.getItem("fte.oauth.session") ?? "null",
      ) as unknown;
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      return {
        accessToken:
          typeof record["accessToken"] === "string"
            ? record["accessToken"]
            : undefined,
        refreshToken:
          typeof record["refreshToken"] === "string"
            ? record["refreshToken"]
            : undefined,
      };
    });
  const initial = await readSession();
  expect(initial?.accessToken).toBeTruthy();
  expect(initial?.refreshToken).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Boston vs New York" }),
  ).toBeVisible();
  const restored = await readSession();
  expect(restored?.refreshToken).toBe(initial?.refreshToken);

  const expiredPayload = Buffer.from(
    JSON.stringify({ exp: 1, token_use: "access" }),
  ).toString("base64url");
  const expiredToken = `expired.${expiredPayload}.token`;
  await page.evaluate(
    ({ token }) => {
      const parsed = JSON.parse(
        sessionStorage.getItem("fte.oauth.session") ?? "null",
      ) as unknown;
      if (!parsed || typeof parsed !== "object")
        throw new Error("missing real Cognito session");
      const session = parsed as Record<string, unknown>;
      session.accessToken = token;
      sessionStorage.setItem("fte.oauth.session", JSON.stringify(session));
    },
    { token: expiredToken },
  );
  await page.reload();
  await expect
    .poll(() => readSession().then((session) => session?.accessToken))
    .not.toBe(expiredToken);
  const refreshed = await readSession();
  expect(refreshed?.refreshToken).toBe(initial?.refreshToken);

  await page.evaluate(() => {
    const host = window as unknown as { __FTE_LOGOUT__?: () => void };
    host.__FTE_LOGOUT__?.();
  });
  await page.waitForURL(`${expectedWebOrigin}/`);
  expect(
    await page.evaluate(() => ({
      session: sessionStorage.getItem("fte.oauth.session"),
      state: sessionStorage.getItem("fte.oauth.state"),
      verifier: sessionStorage.getItem("fte.oauth.verifier"),
    })),
  ).toEqual({ session: null, state: null, verifier: null });
  await page.goto("/games");
  await page.waitForURL(/\/(?:oauth2\/authorize|login)\?/);
  const authorize = new URL(page.url());
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${expectedWebOrigin}/auth/callback`,
  );
  await expect(
    page
      .locator('input[name="username"]:visible, input[type="email"]:visible')
      .first(),
  ).toBeVisible();
});
