import { describe, expect, it } from "vitest";
import {
  selectClosingOdds,
  type ClosingCandidate,
} from "./closing-odds-repository.js";
const base: ClosingCandidate = {
  snapshotId: "open",
  eventId: "e",
  eventVersion: 1,
  sportKey: "mlb",
  marketKey: "spread",
  selectionKey: "a",
  sportsbookId: "dk",
  point: -1.5,
  americanOdds: -110,
  observedAt: "2026-08-01T18:00:00.000Z",
  state: "active",
};
describe("closing odds", () => {
  it("selects same-line price", () =>
    expect(
      selectClosingOdds({
        scheduledStart: "2026-08-01T20:00:00.000Z",
        opening: base,
        candidates: [
          {
            ...base,
            snapshotId: "close",
            observedAt: "2026-08-01T19:50:00.000Z",
          },
        ],
      }).snapshot?.snapshotId,
    ).toBe("close"));
  it("returns legacy reason", () =>
    expect(selectClosingOdds({ opening: base, candidates: [] })).toEqual({
      snapshot: null,
      unavailableReason: "legacy-scheduled-start-missing",
    }));
});
