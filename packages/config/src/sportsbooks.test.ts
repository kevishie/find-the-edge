import { describe, expect, it } from "vitest";
import {
  approvedSportsbookCollection,
  normalizeSportsbook,
  productionSportsbookRoles,
  sportsbookRegistry,
} from "./sportsbooks";

describe("sportsbook registry", () => {
  it.each([
    ["Hard Rock Bet", "hardrock", "offered"],
    ["hardrockbet", "hardrock", "offered"],
    ["DK", "draftkings", "comparison"],
    ["Fan Duel", "fanduel", "comparison"],
    ["MGM", "betmgm", "comparison"],
    ["William Hill", "caesars", "comparison"],
    ["Pinnacle Sports", "pinnacle", undefined],
    ["PINNACLE-SPORTS", "pinnacle", undefined],
    ["BetOnline.ag", "betonline", undefined],
  ])("normalizes %s", (alias, id, role) => {
    const result = normalizeSportsbook(alias);
    expect(result).toMatchObject({
      kind: "normalized",
      sportsbook: { id },
    });
    if (result.kind === "normalized")
      expect(result.sportsbook.productionRole).toBe(role);
  });

  it("rejects unknown books with bounded audit metadata", () => {
    expect(normalizeSportsbook("Mystery Book !!!")).toEqual({
      kind: "rejected",
      reason: "unknown-bookmaker",
      auditId: "mysterybook",
    });
    expect(Object.keys(productionSportsbookRoles).sort()).toEqual([
      "betmgm",
      "caesars",
      "draftkings",
      "fanduel",
      "hardrock",
    ]);
  });

  it("keeps collection approval distinct from evaluation participation", () => {
    expect(approvedSportsbookCollection.pinnacle).toBe("collected");
    expect(productionSportsbookRoles).not.toHaveProperty("pinnacle");
    expect(
      sportsbookRegistry.filter((book) => book.productionRole === "offered"),
    ).toHaveLength(1);
    expect(new Set(sportsbookRegistry.map(({ id }) => id)).size).toBe(
      sportsbookRegistry.length,
    );
  });
});
