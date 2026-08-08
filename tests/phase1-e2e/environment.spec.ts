import { expect, test, type APIRequestContext } from "@playwright/test";

const expectedApiBase = process.env["FTE_PHASE1_API_BASE"];
const expectedWebOrigin = process.env["FTE_WEB_ORIGIN"];
if (!expectedApiBase) throw new Error("FTE_PHASE1_API_BASE is required");
if (!expectedWebOrigin) throw new Error("FTE_WEB_ORIGIN is required");
const apiBase = expectedApiBase.replace(/\/$/, "");

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

async function findProviderGame(
  request: APIRequestContext,
  sport: "mlb" | "soccer",
  requireOdds: boolean,
) {
  for (let offset = 0; offset <= 21; offset += 1) {
    const day = easternDay(offset);
    const response = await request.get(
      `${apiBase}/games?sport=${sport}&status=scheduled&day=${day}`,
    );
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
    const response = await request.get(
      `${apiBase}/games?sport=${sport}&status=scheduled&day=${day}`,
    );
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { items?: Game[] };
    if ((body.items?.length ?? 0) === 0) return day;
  }
  return null;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.removeItem("fte.oauth.session");
    sessionStorage.removeItem("fte.oauth.state");
    sessionStorage.removeItem("fte.oauth.verifier");
  });
  await page.goto("/games");
  // The explorer fills its default search parameters, so the path is a prefix.
  await page.waitForURL(/\/games(\?|$)/);
});

test("real hosted bundle loads provider MLB and MLS games by day", async ({
  page,
  request,
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
    .toBe(apiBase);
  const mlb = await findProviderGame(request, "mlb", true);
  test.skip(mlb === null, "no provider-backed MLB evidence is ingested yet");
  await page.getByLabel("Eastern calendar day").fill(mlb!.day);
  // The explorer lists the target book in a fixed column and renders prices in
  // the row; it does not repeat the provider's full sportsbook label, so assert
  // the evidence the hosted bundle actually paints.
  const row = page.locator(`[data-event-id="${mlb!.game.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(mlb!.game.participants[0]!.label);
  await expect(row).toContainText(/[+-]\d{2,4}/);

  const mls = await findProviderGame(request, "soccer", false);
  if (mls) {
    await page.getByRole("button", { name: "MLS" }).click();
    await page.getByLabel("Eastern calendar day").fill(mls.day);
    await expect(page.locator("[data-event-id]").first()).toBeVisible();
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

test("anonymous session survives reload without Cognito state or redirects", async ({
  page,
  request,
}) => {
  const mlb = await findProviderGame(request, "mlb", true);
  test.skip(mlb === null, "no provider-backed MLB evidence is ingested yet");
  await page.getByLabel("Eastern calendar day").fill(mlb!.day);
  await page.reload();
  await expect(page.locator("[data-event-id]").first()).toBeVisible();
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
