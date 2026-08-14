import { expect, test } from "./session";

import { startLocalGamesApi, type LocalGamesApi } from "./local-games-api";

let api: LocalGamesApi;

const eventId = "event:mlb%3Amlb:2026-regular-boston-new-york-001";
const matchup = "Boston Red Sox vs New York Yankees";

const corsHeaders = {
  "access-control-allow-origin": "http://127.0.0.1:4173",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
};

interface WatchlistEntry {
  readonly schemaVersion: "watchlist-entry-v1";
  readonly eventId: string;
  readonly eventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly startsAt: string;
  readonly addedAt: string;
}

const entryFor = (id: string): WatchlistEntry => ({
  schemaVersion: "watchlist-entry-v1",
  eventId: id,
  eventVersion: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  startsAt: "2026-08-01T23:05:00.000Z",
  addedAt: "2026-07-30T12:00:00.000Z",
});

const requestedEventId = (body: string | null): string => {
  if (body === null) return "";
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" &&
    parsed !== null &&
    "eventId" in parsed &&
    typeof parsed.eventId === "string"
    ? parsed.eventId
    : "";
};

test.beforeAll(async () => {
  api = await startLocalGamesApi();
});

test.afterAll(async () => {
  await api.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ apiBase, accessToken }) => {
      Object.defineProperty(window, "__FTE_RUNTIME_CONFIG__", {
        value: {
          schemaVersion: 1,
          apiBase,
          tokenProviderKey: "e2eSession",
          cognitoIssuer: "https://issuer.example.test",
          cognitoClientId: "e2e-client",
          cognitoDomain: "https://auth.example.test",
          cognitoScopes: Object.freeze([
            "events/events:read",
            "events/scouting:read",
            "events/scouting:write",
          ]),
          callbackUrl: "https://app.example.test/auth/callback",
          logoutUrl: "https://app.example.test",
        },
      });
      Object.defineProperty(window, "__FTE_TOKEN_PROVIDERS__", {
        configurable: true,
        value: { e2eSession: () => Promise.resolve(accessToken) },
      });
    },
    {
      apiBase: api.apiBase,
      accessToken: `x.${Buffer.from(
        JSON.stringify({
          iss: "https://issuer.example.test",
          client_id: "e2e-client",
          token_use: "access",
          exp: Math.floor(Date.now() / 1000) + 3_600,
          // The watchlist authorises on the token subject alone.
          scope: "events/events:read",
        }),
      ).toString("base64url")}.x`,
    },
  );
});

test("adds an event from the explorer, reads it on the watchlist, and removes it", async ({
  page,
}) => {
  let watched: readonly WatchlistEntry[] = [];

  await page.route(`${api.apiBase}/watchlist`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify({
          schemaVersion: "watchlist-page-v1",
          items: watched,
        }),
      });
      return;
    }
    const requested = requestedEventId(request.postData());
    const existing = watched.find((entry) => entry.eventId === requested);
    const entry = existing ?? entryFor(requested);
    if (!existing) watched = [...watched, entry];
    await route.fulfill({
      status: existing ? 200 : 201,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify(entry),
    });
  });

  await page.route(`${api.apiBase}/watchlist/*`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const removed = decodeURIComponent(
      new URL(request.url()).pathname.slice("/watchlist/".length),
    );
    watched = watched.filter((entry) => entry.eventId !== removed);
    await route.fulfill({ status: 204, headers: corsHeaders });
  });

  await page.goto("/events?day=2026-08-01&sport=mlb&status=scheduled");
  const add = page.getByRole("button", {
    name: `Add ${matchup} to watchlist`,
  });
  await expect(add).toBeVisible();
  await add.click();

  await expect(
    page.getByRole("button", { name: `Remove ${matchup} from watchlist` }),
  ).toBeVisible();
  // The whole row is a link; the toggle must never follow it.
  await expect(page).toHaveURL(/\/events\?/);

  await page.goto("/watchlist");
  await expect(page.getByRole("heading", { name: matchup })).toBeVisible();
  await expect(page.locator(`[data-event-id="${eventId}"]`)).toHaveCount(1);
  // Report status and lineups are labelled, never fabricated.
  await expect(page.getByText("Not connected")).toHaveCount(2);
  await expect(
    page.getByText("No lineup provider is connected."),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("html").evaluate((element) => element.clientWidth),
  );

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removed from your watchlist.")).toBeVisible();

  // The removal is authoritative, not just local: a reload still shows none.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Nothing is on your watchlist yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Browse events" }),
  ).toHaveAttribute("href", "/events");
});
