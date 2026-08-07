import { expect, test } from "@playwright/test";

const opportunity = (suffix: string, expectedValue: number) => ({
  schemaVersion: "ranked-opportunity-dto-v1",
  opportunityId: `opportunity:${suffix.repeat(64)}`,
  sportKey: "mlb",
  event: {
    id: `event-${suffix}`,
    version: 1,
    competitionKey: "mlb",
    participants: [
      { id: `team-${suffix}-away`, label: `Away ${suffix.toUpperCase()}` },
      { id: `team-${suffix}-home`, label: `Home ${suffix.toUpperCase()}` },
    ],
    startsAt: "2099-08-08T00:00:00.000Z",
    eastern: {
      timeZone: "America/New_York",
      calendarDay: "2099-08-07",
      display: "Aug 7, 2099, 8:00 PM",
    },
    status: "scheduled",
  },
  market: {
    key: "moneyline",
    selectionKey: `team-${suffix}-away`,
    point: null,
  },
  target: {
    sportsbookId: "hardrock",
    americanOdds: 130,
    impliedProbability: 1 / 2.3,
    observedAt: "2099-08-07T11:55:00.000Z",
    retrievedAt: "2099-08-07T11:56:00.000Z",
  },
  bestComparison: {
    sportsbookId: "draftkings",
    americanOdds: 110,
    observedAt: "2099-08-07T11:55:00.000Z",
    retrievedAt: "2099-08-07T11:56:00.000Z",
  },
  consensus: { probability: 0.48, fairAmericanOdds: 108 },
  expectedValue,
  confidence: {
    score: 82,
    bucket: "high",
    weakestComponent: "coverage",
    components: { freshness: 95, coverage: 82, agreement: 88 },
  },
  dataQuality: { score: 82, bucket: "high", weakestComponent: "coverage" },
  contributingBooks: ["draftkings", "fanduel", "betmgm"],
  warningCodes: suffix === "a" ? ["market-disagreement-warning"] : [],
  liveFreshness: {
    scoredAt: "2099-08-07T12:00:00.000Z",
    oldestRequiredEvidenceAt: "2099-08-07T11:55:00.000Z",
    ageMinutes: 5,
    maximumAgeMinutes: 15,
    expiresAt: "2099-08-07T12:10:00.001Z",
  },
  versions: {
    ranking: { id: "find-the-edge-opportunity-ranking", version: "1.0.0" },
    evaluationPolicy: { id: "evaluation", version: "1.0.0" },
    strategy: { id: "strategy", version: "1.0.0" },
    sportModule: { id: "mlb", version: "1.0.0" },
    calculation: { id: "opportunity-qualification", version: "1.0.0" },
  },
});

test("renders the ranked evidence dashboard without horizontal overflow", async ({
  page,
}, testInfo) => {
  const items = [opportunity("a", 0.14), opportunity("b", 0.08)];
  await page.route("**/runtime-config.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.__FTE_RUNTIME_CONFIG__ = Object.freeze({ schemaVersion: 1, apiBase: 'https://api.example.test' });",
    }),
  );
  await page.route("**/sports/mlb/opportunities?limit=20", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "ranked-opportunity-page-v1",
        rankingPolicy: {
          id: "find-the-edge-opportunity-ranking",
          version: "1.0.0",
        },
        items,
        nextCursor: null,
        snapshotAt: "2099-08-07T12:00:00.000Z",
        evaluationState: "complete",
        hasMoreUnknown: false,
        evaluatedCount: 2,
        filteredCount: 0,
        staleCount: 0,
        joinFailureCount: 0,
      }),
    }),
  );
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Where is the edge right now?" }),
  ).toBeVisible();
  const cards = page.locator("[data-opportunity-id]");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute(
    "data-opportunity-id",
    items[0]!.opportunityId,
  );
  await expect(cards.nth(1)).toHaveAttribute(
    "data-opportunity-id",
    items[1]!.opportunityId,
  );
  await expect(cards.nth(0).getByText("Hard Rock Bet")).toBeVisible();
  await expect(
    cards.nth(0).getByText("Estimated fair probability 48.00%"),
  ).toBeVisible();
  await expect(
    cards.nth(0).getByText("Market disagreement warning"),
  ).toBeVisible();
  await expect(
    cards.nth(0).getByRole("button", { name: "Add Bet" }),
  ).toBeDisabled();
  await expect(
    cards.nth(0).getByRole("link", { name: /Open event/ }),
  ).toHaveAttribute("href", /\/games\/event-a/);
  if (testInfo.project.name.includes("mobile")) {
    await expect(
      page.getByRole("navigation", { name: "Compact product navigation" }),
    ).toBeVisible();
  }
  await expect(page.locator("html")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("html").evaluate((element) => element.clientWidth),
  );
});
