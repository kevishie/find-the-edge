import { expect, test } from "@playwright/test";

import { startLocalGamesApi, type LocalGamesApi } from "./local-games-api";

let api: LocalGamesApi;

const jobId = `scout-job:${"a".repeat(64)}`;
const queued = {
  schemaVersion: 1,
  jobId,
  eventId: "event:mlb%3Amlb:2026-regular-boston-new-york-001",
  eventVersion: 1,
  workflowIntent: "fixture-v1",
  status: "queued",
  stateVersion: 1,
  attemptNumber: 1,
  createdAt: "2026-08-07T13:00:00.000Z",
  updatedAt: "2026-08-07T13:00:00.000Z",
};
const corsHeaders = {
  "access-control-allow-origin": "http://127.0.0.1:4173",
  "access-control-expose-headers": "location",
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
          scope:
            "events/events:read events/scouting:read events/scouting:write",
        }),
      ).toString("base64url")}.x`,
    },
  );
});

test("starts scouting and follows authoritative progress without fabricated phases", async ({
  page,
}) => {
  let statusReads = 0;
  let createKey = "";
  await page.route(`${api.apiBase}/events/*/scout`, async (route) => {
    const request = route.request();
    createKey = request.headers()["idempotency-key"] ?? "";
    expect(request.method()).toBe("POST");
    expect(request.postData()).toBe("{}");
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      headers: { ...corsHeaders, location: `/scout-jobs/${jobId}` },
      body: JSON.stringify(queued),
    });
  });
  await page.route(
    `${api.apiBase}/scout-jobs/${encodeURIComponent(jobId)}`,
    async (route) => {
      statusReads += 1;
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify(
          statusReads === 1
            ? queued
            : {
                ...queued,
                status: "completed",
                stateVersion: 3,
                updatedAt: "2026-08-07T13:02:00.000Z",
              },
        ),
      });
    },
  );

  await page.goto("/events?day=2026-08-01&sport=mlb&status=scheduled");
  await expect(
    page.getByRole("heading", { name: "Boston Red Sox vs New York Yankees" }),
  ).toBeVisible();
  // On the table, scouting starts from the event detail reached through the
  // row; cards keep their inline Scout button.
  if (!(await page.locator(".event-explorer-cards").count())) {
    await page
      .getByRole("link", { name: /Open Boston Red Sox vs New York Yankees/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Sportsbook comparison" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Scout" }).first().click();
  await expect(page).toHaveURL(
    new RegExp(`/scout-jobs/${encodeURIComponent(jobId)}`),
  );
  await expect(
    page.getByRole("heading", { name: "Scouting is queued" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Scouting is complete" }),
  ).toBeVisible({ timeout: 8_000 });
  expect(createKey).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  await expect(page.getByRole("link", { name: "View game" })).toBeVisible();
  await expect(
    page.getByText(/collecting|generating|calculating/i),
  ).toHaveCount(0);
  await expect(page.locator("html")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("html").evaluate((element) => element.clientWidth),
  );
});

test("opens a failed job directly and reconciles a fenced retry conflict", async ({
  page,
}) => {
  const failed = {
    ...queued,
    status: "failed_retryable",
    stateVersion: 2,
    updatedAt: "2026-08-07T13:01:00.000Z",
    failure: { code: "workflow-timeout", retryable: true },
  };
  const retried = {
    ...queued,
    stateVersion: 3,
    attemptNumber: 2,
    updatedAt: "2026-08-07T13:02:00.000Z",
  };
  let reads = 0;
  let retryKey = "";
  await page.route(`${api.apiBase}/scout-jobs/**`, async (route) => {
    const request = route.request();
    if (request.url().endsWith("/retry")) {
      retryKey = request.headers()["idempotency-key"] ?? "";
      expect(request.postDataJSON()).toEqual({ expectedStateVersion: 2 });
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: corsHeaders,
        body: JSON.stringify({ error: "conflict" }),
      });
      return;
    }
    reads += 1;
    await route.fulfill({
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify(reads === 1 ? failed : retried),
    });
  });

  await page.goto(`/scout-jobs/${encodeURIComponent(jobId)}`);
  await expect(
    page.getByRole("heading", { name: "Scouting could not finish" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry scouting" }).click();
  await expect(
    page.getByRole("heading", { name: "Scouting is queued" }),
  ).toBeVisible();
  expect(reads).toBe(2);
  expect(retryKey).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Scouting is queued" }),
  ).toBeVisible();
});
