import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const expectedApiBase = process.env["FTE_PHASE1_API_BASE"];
const expectedWebOrigin = process.env["FTE_WEB_ORIGIN"];
if (!expectedApiBase) throw new Error("FTE_PHASE1_API_BASE is required");
if (!expectedWebOrigin) throw new Error("FTE_WEB_ORIGIN is required");
const apiBase = expectedApiBase.replace(/\/$/, "");
const webOrigin = new URL(expectedWebOrigin).origin;
const fixtureSession = {
  token: `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`,
  accountId: `account:${"b".repeat(64)}`,
};

const easternDay = (offset: number) => {
  const date = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

type Game = {
  id: string;
  participants: { label: string }[];
  odds: {
    state: "available" | "unavailable";
    selections?: { sportsbookLabel: string }[];
  };
};

/**
 * The board the UI actually renders.
 *
 * The API serves a pre-materialized board when the request key matches one
 * (route + sport + league + status + day + limit) and otherwise falls through
 * to the live projection — and only the materialized path runs the
 * withdrawn-listing filter. A day-finding query missing `league` therefore
 * reads a DIFFERENT, unfiltered board from the one the page will render, and
 * on 2026-08-13 those differed by 2 rows for soccer and 4 for MLB. When the
 * divergence reaches the whole slate the smoke fails on the release under
 * test, which is not where the fault is.
 */
const boardQuery = (sport: "mlb" | "soccer", day: string) =>
  `${apiBase}/games?sport=${sport}&league=${sport === "mlb" ? "mlb" : "mls"}` +
  `&status=scheduled&day=${day}&limit=50`;

async function findProviderGame(
  request: APIRequestContext,
  sport: "mlb" | "soccer",
  requireOdds: boolean,
) {
  for (let offset = 0; offset <= 21; offset += 1) {
    const day = easternDay(offset);
    const response = await request.get(boardQuery(sport, day));
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { items?: Game[] };
    const game = body.items?.find(
      (candidate) =>
        !candidate.id.includes("2026-regular-") &&
        (!requireOdds || candidate.odds.state === "available"),
    );
    if (game) return { day, game };
  }
  // Ingestion is owned by the scheduled worker, so an empty calendar is a
  // statement about provider evidence, not about the release under test.
  return null;
}

async function findEmptyDay(
  request: APIRequestContext,
  sport: "mlb" | "soccer",
) {
  for (let offset = 30; offset <= 365; offset += 15) {
    const day = easternDay(offset);
    // Same board the page renders, for the same reason as above. The stored
    // board is a subset of the live projection, so this cannot turn an empty
    // day into a populated one — but reading one board throughout is what
    // makes the assertion mean what it says.
    const response = await request.get(boardQuery(sport, day));
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { items?: Game[] };
    if ((body.items?.length ?? 0) === 0) return day;
  }
  return null;
}

async function openEntitledExplorer(page: Page) {
  // This hosted-data smoke is not an identity lifecycle test: it supplies a
  // synthetic, client-only session and an explicit entitlement decision so
  // the protected bundle can exercise real staging API data. The API's
  // product-access flag remains off during this migration, and the separate
  // signed-out test below still proves the live login boundary.
  let entitlementChecks = 0;
  await page.route(`${apiBase}/billing/entitlement`, async (route) => {
    const corsHeaders = {
      "access-control-allow-origin": webOrigin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "authorization",
      "cache-control": "no-store",
      vary: "origin",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (route.request().method() !== "GET") {
      await route.fulfill({ status: 405, headers: corsHeaders });
      return;
    }
    if (
      route.request().headers()["authorization"] !==
      `Bearer ${fixtureSession.token}`
    ) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify({ error: "unauthorized" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify({
        schemaVersion: "billing-entitlement-v1",
        state: "active",
        accessUntil: null,
        hasAccess: true,
      }),
    });
    entitlementChecks += 1;
  });
  await page.addInitScript(({ token, accountId }) => {
    sessionStorage.removeItem("fte.oauth.session");
    sessionStorage.removeItem("fte.oauth.state");
    sessionStorage.removeItem("fte.oauth.verifier");
    localStorage.setItem(
      "fte.session.v1",
      JSON.stringify({
        token,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        accountId,
      }),
    );
  }, fixtureSession);
  await page.goto("/events");
  // The explorer fills its default search parameters, so the path is a prefix.
  await page.waitForURL(/\/events(\?|$)/);
  // A stale pre-guard bundle could otherwise render against the still-open
  // migration API and falsely pass without exercising entitlement at all.
  await expect.poll(() => entitlementChecks).toBeGreaterThan(0);
}

test("real hosted bundle loads provider MLB and MLS games by day", async ({
  page,
  request,
}) => {
  await openEntitledExplorer(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = window as unknown as Record<string, unknown>;
        const config = host["__FTE_RUNTIME_CONFIG__"] as
          { apiBase?: unknown } | undefined;
        return config?.apiBase;
      }),
    )
    .toBe(apiBase);
  const mlb = await findProviderGame(request, "mlb", true);
  test.skip(mlb === null, "no provider-backed MLB evidence is ingested yet");
  await page.getByLabel("Eastern calendar day").fill(mlb!.day);
  // The board refreshes every ingest tick, so the exact game fetched a moment
  // ago may lawfully differ from the page's board during a deploy window.
  // Assert the property under test: the hosted bundle renders provider games
  // with prices for the fetched day.
  const row = page.locator("[data-event-id]").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/[+-]\d{2,4}/);

  // Lines-only listings: soccer earns a pill (and rows) only when a priced
  // slate exists, so the check navigates directly to a day known to have one.
  //
  // Say so when it does NOT run. This leg silently did nothing whenever no
  // priced soccer day was found, which is why a client bug that blanked the
  // entire soccer board surfaced as an intermittent failure for weeks instead
  // of a standing one: half the runs skipped the only check that could see
  // it. A check that quietly does nothing cannot be told from a check that
  // passed.
  const mls = await findProviderGame(request, "soccer", true);
  if (mls) {
    await page.goto(`/events?sport=soccer&day=${mls.day}&status=all`);
    await expect(page.locator("[data-event-id]").first()).toBeVisible();
    test.info().annotations.push({
      type: "soccer-leg",
      description: `ran against ${mls.day}`,
    });
  } else {
    const note =
      "SOCCER LEG SKIPPED: no priced soccer day on the board in the next 21 " +
      "days, so soccer rendering was NOT verified by this run.";
    console.warn(note);
    test.info().annotations.push({ type: "soccer-leg", description: note });
  }

  const emptyDay = await findEmptyDay(request, "mlb");
  if (emptyDay) {
    await page.getByRole("button", { name: "MLB" }).click();
    await page.getByLabel("Eastern calendar day").fill(emptyDay);
    // The explorer defaults to every lifecycle, so its empty state names the
    // lifecycle selection rather than the scheduled status.
    await expect(
      page.getByText(
        /No MLB (games are scheduled for this day|events exist for this day and lifecycle selection)\./,
      ),
    ).toBeVisible();
  }
});

test("hosted event drill-in resolves a provider game through the gateway", async ({
  page,
  request,
}) => {
  await openEntitledExplorer(page);
  const mlb = await findProviderGame(request, "mlb", true);
  test.skip(mlb === null, "no provider-backed MLB evidence is ingested yet");
  // The gateway's path-parameter decoding has corrupted percent-embedded
  // event ids before; this drill-in guards the whole hosted chain.
  await page.goto(
    `/events/${encodeURIComponent(mlb!.game.id)}?sport=mlb&day=${mlb!.day}`,
  );
  await expect(page.getByText("This game was not found.")).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(
    page.getByRole("heading", { name: "Sportsbook comparison" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("a signed-out visitor reaches our own form, never a hosted login", async ({
  page,
  context,
}) => {
  // The product is no longer browsable anonymously. What this proves on the
  // real hosted bundle is where a signed-out visitor ends up: our own route,
  // on our own origin, with no OAuth material stored on the way.
  await context.clearCookies();
  await page.addInitScript(() => localStorage.removeItem("fte.session.v1"));
  await page.goto("/splits");

  await page.waitForURL(/\/login(\?|$)/, { timeout: 20_000 });
  expect(new URL(page.url()).origin).toBe(webOrigin);
  // The destination survived the trip, so signing in resumes the journey.
  expect(new URL(page.url()).searchParams.get("returnUrl")).toBe("/splits");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      session: sessionStorage.getItem("fte.oauth.session"),
      state: sessionStorage.getItem("fte.oauth.state"),
      verifier: sessionStorage.getItem("fte.oauth.verifier"),
    })),
  ).toEqual({ session: null, state: null, verifier: null });
});
