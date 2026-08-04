import { describe, expect, it } from "vitest";
import { buildOddsComparisonViewModel } from "./odds-comparison";

describe("odds comparison view model", () => {
  it("orders the target first and excludes blocked prices from best", () => {
    const model = buildOddsComparisonViewModel({
      oddsComparison: {
        targetSportsbookId: "hardrock",
        targetQualified: false,
        generatedAt: "2026-08-04T12:00:00.000Z",
        sportsbooks: [
          { id: "draftkings", label: "DraftKings", target: false },
          { id: "hardrock", label: "Hard Rock Bet", target: true },
        ],
        markets: [
          {
            marketKey: "moneyline",
            selections: [
              {
                selectionKey: "away",
                selectionLabel: "Away",
                cells: {
                  hardrock: {
                    state: "suspended",
                    eligible: false,
                    reason: "market-suspended",
                    evidenceAt: "2026-08-04T12:00:00.000Z",
                    americanOdds: 150,
                    observedAt: "2026-08-04T11:00:00.000Z",
                    retrievedAt: "2026-08-04T11:00:01.000Z",
                  },
                  draftkings: {
                    state: "active",
                    eligible: true,
                    americanOdds: 120,
                    observedAt: "2026-08-04T12:00:00.000Z",
                    retrievedAt: "2026-08-04T12:00:01.000Z",
                  },
                },
              },
            ],
          },
        ],
      },
    } as never);
    expect(model.books.map(({ id }) => id)).toEqual(["hardrock", "draftkings"]);
    expect(
      model.markets[0]!.selections[0]!.cells.map(({ best }) => best),
    ).toEqual([false, true]);
  });

  it.each([
    [
      "spread",
      "participant:away",
      { point: 1.5, americanOdds: 120 },
      { point: 2.5, americanOdds: -110 },
      "second",
    ],
    [
      "total",
      "over",
      { point: 9, americanOdds: 120 },
      { point: 8.5, americanOdds: -110 },
      "second",
    ],
    [
      "total",
      "under",
      { point: 8.5, americanOdds: 120 },
      { point: 9, americanOdds: -110 },
      "second",
    ],
    [
      "spread",
      "participant:away",
      { point: 1.5, americanOdds: -110 },
      { point: 1.5, americanOdds: 105 },
      "second",
    ],
  ] as const)(
    "ranks %s point quality before price",
    (marketKey, selectionKey, first, second, winner) => {
      const active = (value: typeof first | typeof second) => ({
        state: "active" as const,
        eligible: true as const,
        ...value,
        observedAt: "2026-08-04T12:00:00.000Z",
        retrievedAt: "2026-08-04T12:00:01.000Z",
      });
      const model = buildOddsComparisonViewModel({
        oddsComparison: {
          targetSportsbookId: "hardrock",
          targetQualified: true,
          generatedAt: "2026-08-04T12:00:00.000Z",
          sportsbooks: [
            { id: "hardrock", label: "Hard Rock", target: true },
            { id: "draftkings", label: "DraftKings", target: false },
          ],
          markets: [
            {
              marketKey,
              selections: [
                {
                  selectionKey,
                  selectionLabel: "Selection",
                  cells: {
                    hardrock: active(first),
                    draftkings: active(second),
                  },
                },
              ],
            },
          ],
        },
      } as never);
      expect(
        model.markets[0]!.selections[0]!.cells.map(({ best }) => best),
      ).toEqual(winner === "second" ? [false, true] : [true, false]);
    },
  );
});
