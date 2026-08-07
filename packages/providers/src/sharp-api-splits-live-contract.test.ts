import { describe, expect, it } from "vitest";
import type { IsoTimestamp } from "@find-the-edge/domain";
import {
  fetchSharpApiSplitHistory,
  fetchSharpApiSplitsPage,
  latestSharpApiSplitHistoryByBook,
  sharpApiLeagueByKey,
} from "./sharp-api";

const apiKey = process.env["SHARP_API_KEY"];
const liveIt =
  process.env["FTE_RUN_SHARP_LIVE_CONTRACTS"] === "1" && apiKey ? it : it.skip;

describe("SharpAPI live splits contract", () => {
  liveIt("returns bounded current DraftKings and Circa history", async () => {
    const now = new Date();
    const current = await fetchSharpApiSplitsPage(
      sharpApiLeagueByKey("mlb"),
      apiKey!,
    );
    const sourceEvent = current.items[0];
    expect(sourceEvent).toBeDefined();
    const history = await fetchSharpApiSplitHistory(
      sourceEvent!,
      new Date(now.getTime() - 30 * 60_000).toISOString() as IsoTimestamp,
      now.toISOString() as IsoTimestamp,
      apiKey!,
    );
    const latest = latestSharpApiSplitHistoryByBook(history.items);
    expect(latest.map(({ sportsbookId }) => sportsbookId)).toEqual([
      "circa",
      "draftkings",
    ]);
    expect(
      latest.every(
        ({ providerTimestamp }) =>
          Date.parse(providerTimestamp) >= now.getTime() - 30 * 60_000,
      ),
    ).toBe(true);
    for (const item of latest) {
      expect(
        item.markets
          .find(({ marketKey }) => marketKey === "spread")
          ?.selections.every(({ point }) => point !== undefined),
      ).toBe(true);
      expect(
        item.markets
          .find(({ marketKey }) => marketKey === "moneyline")
          ?.selections.every(({ americanOdds }) => americanOdds !== undefined),
      ).toBe(true);
    }
  });
});
