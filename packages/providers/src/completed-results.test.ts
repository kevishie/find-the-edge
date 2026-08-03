import { describe, expect, it } from "vitest";
import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import {
  validateCompletedResultPage,
  type CompletedResultPageRequest,
} from "./completed-results";
const at = (v: string) => v as IsoTimestamp;
const request: CompletedResultPageRequest = {
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  windowStart: at("2026-08-03T00:00:00.000Z"),
  windowEnd: at("2026-08-04T00:00:00.000Z"),
  limit: 10,
};
const item = () => ({
  providerEventId: "e",
  sportKey: request.sportKey,
  leagueKey: "mlb",
  state: "final",
  scoreScope: "regulation",
  scores: [
    { providerParticipantId: "a", score: 1 },
    { providerParticipantId: "b", score: 2 },
  ],
  providerTimestamp: at("2026-08-03T20:00:00.000Z"),
  revision: {
    providerId: "fixture-development",
    authorityRank: 1,
    updatedAt: at("2026-08-03T20:00:00.000Z"),
    sequence: 1,
    token: "r",
  },
});
const page = (result: unknown) => ({
  results: [result],
  retrievedAt: at("2026-08-03T20:01:00.000Z"),
  providerRequests: 1,
  quotaUsed: 0,
});
describe("completed result page validation", () => {
  it("accepts a strict page", () =>
    expect(
      validateCompletedResultPage(page(item()), request, "fixture-development")
        .results,
    ).toHaveLength(1));
  it("rejects out-of-window results, provider mismatch, duplicate participants and unbounded detail", () => {
    for (const changed of [
      { ...item(), providerTimestamp: at("2026-08-04T00:00:00.000Z") },
      { ...item(), revision: { ...item().revision, providerId: "other" } },
      { ...item(), revision: { ...item().revision, unexpected: true } },
      {
        ...item(),
        revision: {
          ...item().revision,
          updatedAt: at("2026-08-03T20:02:00.000Z"),
        },
      },
      { ...item(), unexpected: true },
      {
        ...item(),
        state: "cancelled",
        scoreScope: "regulation",
        scores: undefined,
      },
      {
        ...item(),
        scores: [{ ...item().scores[0], unexpected: true }, item().scores[1]],
      },
      {
        ...item(),
        scores: [
          { providerParticipantId: "a", score: 1 },
          { providerParticipantId: "a", score: 2 },
        ],
      },
      {
        ...item(),
        detail: {
          schemaId: "mlb.result.official",
          schemaVersion: "1",
          value: "x".repeat(66_000),
        },
      },
      {
        ...item(),
        detail: {
          schemaId: "mlb.result.official",
          schemaVersion: "1",
          value: "x".repeat(33_000),
        },
      },
    ])
      expect(() =>
        validateCompletedResultPage(
          page(changed),
          request,
          "fixture-development",
        ),
      ).toThrow();
  });
  it("rejects retrieved timestamps beyond the injected clock skew", () => {
    expect(() =>
      validateCompletedResultPage(
        { ...page(item()), retrievedAt: at("2026-08-03T20:10:01.000Z") },
        request,
        "fixture-development",
        () => Date.parse("2026-08-03T20:05:00.000Z"),
      ),
    ).toThrow("invalid-result-page");
  });
  it("redacts undefined and non-serializable detail values as invalid-result", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    for (const value of [undefined, circular])
      expect(() =>
        validateCompletedResultPage(
          page({
            ...item(),
            detail: { schemaId: "mlb.result.test", schemaVersion: "1", value },
          }),
          request,
          "fixture-development",
        ),
      ).toThrow("invalid-result");
  });
});
