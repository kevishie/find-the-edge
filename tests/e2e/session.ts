import {
  expect,
  test as base,
  type Page,
  type Request,
} from "@playwright/test";

export { expect };

export const OWNED_SESSION_TOKEN = `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`;
export const OWNED_ACCOUNT_ID = `account:${"b".repeat(64)}`;
const OWNED_AUTHORIZATION = `Bearer ${OWNED_SESSION_TOKEN}`;

const isOwnedProductRequest = (request: Request): boolean => {
  if (!["fetch", "xhr"].includes(request.resourceType())) return false;
  const path = new URL(request.url()).pathname;
  if (
    (request.method() === "GET" &&
      (path === "/events" ||
        /^\/scout-jobs\/[^/]+(?:\/report)?$/u.test(path) ||
        /^\/scout-reports\/[^/]+\/versions(?:\/\d+)?$/u.test(path) ||
        path === "/watchlist")) ||
    (request.method() === "POST" &&
      (/^\/events\/[^/]+\/scout$/u.test(path) ||
        /^\/scout-jobs\/[^/]+\/retry$/u.test(path) ||
        path === "/watchlist")) ||
    (request.method() === "DELETE" && /^\/watchlist\/[^/]+$/u.test(path))
  )
    return true;
  if (request.method() !== "GET") return false;
  return (
    /^\/sports\/[^/]+\/(opportunities|arbitrage|clv)$/u.test(path) ||
    path === "/strategy-experiments" ||
    /^\/strategy-experiments\/[^/]+$/u.test(path) ||
    path === "/games" ||
    /^\/events\/[^/]+$/u.test(path) ||
    /^\/games\/[^/]+\/odds-history$/u.test(path) ||
    path === "/splits" ||
    path === "/performance/reports" ||
    path === "/retrospectives" ||
    /^\/retrospectives\/[^/]+(?:\/versions)?$/u.test(path)
  );
};

/**
 * Assert the browser-owned bearer on every ordinary product request while
 * leaving public, billing, OTP, and elevated Cognito mutations alone.
 */
export const observeOwnedProductAuthority = (page: Page): (() => void) => {
  const failures: string[] = [];
  const inspect = (request: Request) => {
    if (
      isOwnedProductRequest(request) &&
      request.headers()["authorization"] !== OWNED_AUTHORIZATION
    )
      failures.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on("request", inspect);
  return () => {
    page.off("request", inspect);
    expect(
      failures,
      "owned product requests missing the exact fte1 bearer",
    ).toEqual([]);
  };
};

/** Resolve the real entitlement route without manufacturing browser access. */
export const routeOwnedEntitlement = async (page: Page): Promise<void> => {
  await page.route("**/billing/entitlement", async (route) => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": "http://127.0.0.1:4173",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    expect(request.headers()["authorization"]).toBe(OWNED_AUTHORIZATION);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers,
      body: JSON.stringify({
        schemaVersion: "billing-entitlement-v1",
        state: "active",
        accessUntil: "2099-08-01T00:00:00.000Z",
        hasAccess: true,
      }),
    });
  });
};

/**
 * Product scenarios arrive with an explicit owned session and resolve access
 * through the same server entitlement call used by production.
 */
export const seedEntitledSession = async (page: Page): Promise<void> => {
  await page.addInitScript(
    ({ token, accountId }) => {
      window.localStorage.setItem(
        "fte.session.v1",
        JSON.stringify({
          token,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          accountId,
        }),
      );
    },
    { token: OWNED_SESSION_TOKEN, accountId: OWNED_ACCOUNT_ID },
  );
  await routeOwnedEntitlement(page);
};

/** Default test fixture for protected product scenarios. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await seedEntitledSession(page);
    const verifyAuthority = observeOwnedProductAuthority(page);
    await use(page);
    verifyAuthority();
  },
});

/** Anonymous-first fixture for explicit sign-in and sign-out lifecycle tests. */
export const anonymousTest = base.extend({
  page: async ({ page }, use) => {
    await routeOwnedEntitlement(page);
    const verifyAuthority = observeOwnedProductAuthority(page);
    await use(page);
    verifyAuthority();
  },
});
