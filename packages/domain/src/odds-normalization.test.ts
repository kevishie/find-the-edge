import { describe, expect, it } from "vitest";
import { canonicalMvpMarketKeys, participantSelectionKey } from "./index";

describe("canonical odds identities", () => {
  it("publishes the complete MVP market set", () => {
    expect(canonicalMvpMarketKeys).toEqual([
      "moneyline",
      "spread",
      "total",
      "btts",
      "team_total",
    ]);
  });

  it("binds team outcomes to stable participant identity", () => {
    expect(() => participantSelectionKey("" as never)).toThrow(
      "participant-id-invalid",
    );
    expect(participantSelectionKey("club:42" as never)).toBe(
      "participant:club%3A42",
    );
    expect(participantSelectionKey("club-42" as never, "over")).toBe(
      "participant:club-42:over",
    );
  });
});
