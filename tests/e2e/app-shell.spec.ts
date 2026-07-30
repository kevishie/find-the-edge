import { expect, test } from "@playwright/test";

test("keeps the Edge Lab usable", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "PRICE THE BET. DON'T PICK THE TEAM.",
    }),
  ).toBeVisible();
  await expect(page.getByText("QUALIFIED PLAY")).toBeVisible();
  await expect(page.locator("html")).toHaveJSProperty(
    "scrollWidth",
    await page.locator("html").evaluate((element) => element.clientWidth),
  );
});

test("withholds recommendations for planned modules", async ({ page }) => {
  await page.goto("/sports/tennis/events");

  await expect(
    page.getByRole("heading", { name: "Tennis Matches" }),
  ).toBeVisible();
  await expect(page.getByText("No recommendation published")).toBeVisible();
  await expect(page.getByText("Not published")).toBeVisible();
});
