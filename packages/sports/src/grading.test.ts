import { describe, expect, it } from "vitest";
import { mlbPaperGradingAdapter } from "./mlb/grading";
const result = {
  id: "result:x",
  providerId: "p",
  providerEventId: "pe",
  canonicalEventId: "e",
  canonicalEventVersion: 2,
  sportKey: "mlb",
  leagueKey: "mlb",
  state: "final",
  scoreScope: "extra-innings",
  scores: [
    { participantId: "away", score: 5 },
    { participantId: "home", score: 4 },
  ],
  providerRevision: {
    providerId: "p",
    updatedAt: "2026-08-04T00:00:00.000Z",
    authorityRank: 1,
    sequence: 1,
    token: "1",
  },
  providerTimestamp: "2026-08-04T00:00:00.000Z",
  retrievedAt: "2026-08-04T00:00:00.000Z",
  sourceProvenance: "fixture",
} as const;
describe("sport grading", () => {
  it("grades MLB full-event in participant order", () =>
    expect(
      mlbPaperGradingAdapter.grade({
        eventId: "e",
        terms: {
          schemaVersion: "1",
          canonicalEventVersion: 2,
          participants: ["away", "home"],
          market: {
            kind: "moneyline",
            outcomeCount: 2,
            resultScope: "full-event",
          },
        },
        selectionKey: "away",
        americanOdds: 120,
        result,
      } as never).outcome,
    ).toBe("won"));
  it("does not infer regulation scope", () =>
    expect(
      mlbPaperGradingAdapter.grade({
        eventId: "e",
        terms: {
          schemaVersion: "1",
          canonicalEventVersion: 2,
          participants: ["away", "home"],
          market: {
            kind: "moneyline",
            outcomeCount: 2,
            resultScope: "regulation",
          },
        },
        selectionKey: "away",
        americanOdds: 120,
        result,
      } as never).outcome,
    ).toBe("unresolved"));
  it.each([
    [{ ...result, canonicalEventId: "other" }, "event-mismatch"],
    [
      {
        ...result,
        scores: [
          { participantId: "away", score: -1 },
          { participantId: "home", score: 4 },
        ],
      },
      "participant-mismatch",
    ],
    [
      {
        ...result,
        scores: [
          { participantId: "away", score: 1.5 },
          { participantId: "home", score: 4 },
        ],
      },
      "participant-mismatch",
    ],
  ] as const)(
    "rejects mismatched events and invalid scores",
    (invalid, reason) =>
      expect(
        mlbPaperGradingAdapter.grade({
          eventId: "e",
          terms: {
            schemaVersion: "1",
            canonicalEventVersion: 2,
            participants: ["away", "home"],
            market: {
              kind: "moneyline",
              outcomeCount: 2,
              resultScope: "full-event",
            },
          },
          selectionKey: "away",
          americanOdds: 120,
          result: invalid,
        } as never).reason,
      ).toBe(reason),
  );
});
