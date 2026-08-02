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
