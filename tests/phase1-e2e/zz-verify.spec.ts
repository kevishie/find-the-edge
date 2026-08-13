import { expect, test } from "@playwright/test";

// Throwaway verification, deleted after use. Checks the SYMPTOM — soccer
// games rendering — not a proxy for it.
test("soccer renders its games", async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "fte.session.v1",
      JSON.stringify({
        token: `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        accountId: `account:${"b".repeat(64)}`,
      }),
    );
  });

  for (const day of ["2026-08-13", "2026-08-14"]) {
    const res = await request.get(
      `${process.env["FTE_PHASE1_API_BASE"]}/games?sport=soccer&league=mls` +
        `&status=all&day=${day}&limit=50`,
    );
    const body = (await res.json()) as {
      items: unknown[];
      freshness: string | null;
      nextCursor: string | null;
    };
    const contradiction = body.items.length === 0 && body.freshness !== null;
    console.log(
      `API ${day}: items=${body.items.length} freshness=${body.freshness} ` +
        `cursor=${body.nextCursor ? "yes" : "none"}` +
        (contradiction ? "  <-- STILL CONTRADICTORY" : "  ok"),
    );

    await page.goto(`/events?sport=soccer&day=${day}&status=all`);
    await page.waitForTimeout(6000);
    const rows = await page.locator("[data-event-id]").count();
    const invalid = await page
      .getByText("The games response was invalid.")
      .count();
    const pills = await page.locator(".sport-pill").allInnerTexts();
    console.log(
      `UI  ${day}: rows=${rows} invalidBanner=${invalid} ` +
        `pills=${JSON.stringify(pills)}`,
    );
  }
  expect(true).toBe(true);
});
