import type { Page } from "@playwright/test";

/**
 * Product routes require a session (FTE-073's client guard), so a spec that
 * exercises a product screen has to arrive holding one. The token is a
 * well-formed fixture, never a real credential: these specs run against a
 * local API that does not verify it, and the guard only asks whether a live
 * session exists.
 */
export const seedSession = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "fte.session.v1",
      JSON.stringify({
        token: `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        accountId: `account:${"b".repeat(64)}`,
      }),
    );
  });
};
