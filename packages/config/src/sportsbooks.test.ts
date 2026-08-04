import { describe, expect, it } from "vitest";
import { normalizeSportsbook, productionSportsbookRoles } from "./sportsbooks";

describe("sportsbook registry", () => {
  it.each([
    ["Hard Rock Bet", "hardrock", "offered"],
    ["hardrockbet", "hardrock", "offered"],
    ["DK", "draftkings", "comparison"],
    ["Fan Duel", "fanduel", "comparison"],
    ["MGM", "betmgm", "comparison"],
    ["William Hill", "caesars", "comparison"],
  ])("normalizes %s", (alias, id, role) => {
    const result = normalizeSportsbook(alias);
    expect(result).toMatchObject({
      kind: "normalized",
      sportsbook: { id, productionRole: role },
    });
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
});
