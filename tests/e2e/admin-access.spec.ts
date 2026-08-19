import type { Page } from "@playwright/test";
import { expect, test, OWNED_ACCOUNT_ID, OWNED_SESSION_TOKEN } from "./session";

const authorization = `Bearer ${OWNED_SESSION_TOKEN}`;
const directoryId = `directory:${"c".repeat(32)}`;
const pendingDirectoryId = `directory:${"d".repeat(32)}`;
const now = "2099-08-07T12:00:00.000Z";

const user = (manual = true) => ({
  schemaVersion: "admin-user-v1",
  directoryId,
  accountId: `account:${"e".repeat(64)}`,
  phoneHint: "**21",
  displayReference: "User ending 21",
  lifecycle: "active",
  createdAt: now,
  updatedAt: now,
  manualGrant: { active: manual, version: manual ? 1 : 2 },
  access: {
    superAdmin: false,
    stripe: "inactive",
    effective: manual ? "granted" : "denied",
    sources: manual ? ["manual"] : [],
  },
});

const routeRuntime = async (page: Page) => {
  await page.route("**/runtime-config.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.__FTE_RUNTIME_CONFIG__ = Object.freeze({ schemaVersion: 1, apiBase: 'https://api.example.test' });",
    }),
  );
};

test("super admin lists users, grants pending access, and revokes only manual access", async ({
  page,
}) => {
  await routeRuntime(page);
  await page.route("**/auth/session/capabilities", async (route) => {
    expect(route.request().headers()["authorization"]).toBe(authorization);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "owned-session-capabilities-v1",
        accountId: OWNED_ACCOUNT_ID,
        capabilities: ["accounts/access:manage"],
      }),
    });
  });
  await page.route("**/admin/users?limit=25", async (route) => {
    expect(route.request().headers()["authorization"]).toBe(authorization);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "admin-user-directory-page-v1",
        items: [user()],
        cursor: null,
      }),
    });
  });
  await page.route("**/admin/users/grants", async (route) => {
    expect(route.request().headers()["authorization"]).toBe(authorization);
    expect(route.request().headers()["idempotency-key"]).toMatch(/^grant:/);
    expect(route.request().postDataJSON()).toEqual({
      phoneNumber: "+15557654322",
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "admin-manual-access-result-v1",
        user: {
          ...user(),
          directoryId: pendingDirectoryId,
          accountId: null,
          phoneHint: "**22",
          displayReference: "Pending user ending 22",
          lifecycle: "pending",
        },
      }),
    });
  });
  await page.route("**/admin/users/*/manual-grant?version=1", async (route) => {
    expect(decodeURIComponent(new URL(route.request().url()).pathname)).toBe(
      `/admin/users/${directoryId}/manual-grant`,
    );
    expect(route.request().headers()["authorization"]).toBe(authorization);
    expect(route.request().headers()["idempotency-key"]).toMatch(/^revoke:/);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "admin-manual-access-result-v1",
        user: user(false),
      }),
    });
  });

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "User access" }),
  ).toBeVisible();
  await expect(page.getByText("User ending 21")).toBeVisible();

  await page.getByLabel("Grant access by phone number").fill("+15557654322");
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(
    page.getByText("Pending user ending 22", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("pending", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "Revoke manual access for User ending 21" })
    .click();
  await expect(page.getByText("Manual off")).toBeVisible();
  await expect(page.getByText("No access")).toBeVisible();
});

test("ordinary subscriber cannot open the admin route directly", async ({
  page,
}) => {
  await routeRuntime(page);
  await page.route("**/auth/session/capabilities", async (route) => {
    expect(route.request().headers()["authorization"]).toBe(authorization);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "owned-session-capabilities-v1",
        accountId: OWNED_ACCOUNT_ID,
        capabilities: [],
      }),
    });
  });
  await page.route("**/sports/mlb/opportunities?limit=20", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/sports/mlb/arbitrage?limit=20", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/providers/status", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );

  await page.goto("/admin/users");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "User access" })).toHaveCount(
    0,
  );
});
