import { describe, expect, it } from "vitest";
import {
  createCompletedResultHandler,
  handler,
  validateCompletedResultInvocation,
} from "./completed-result-lambda";
const valid = {
  attemptId: "x",
  sportKey: "mlb",
  leagueKey: "mlb",
  windowStart: "2026-08-03T00:00:00.000Z",
  windowEnd: "2026-08-04T00:00:00.000Z",
  pageLimit: 10,
  maxPages: 2,
};
describe("completed result command boundary", () => {
  it("validates every manual command", () => {
    expect(
      validateCompletedResultInvocation({ commands: [valid] }),
    ).toHaveLength(1);
    for (const value of [null, {}, 42, { ...valid, pageLimit: 0 }])
      expect(() =>
        validateCompletedResultInvocation({ commands: [value] }),
      ).toThrow("invalid-result-invocation");
    for (const commands of [[], Array.from({ length: 13 }, () => valid)])
      expect(() => validateCompletedResultInvocation({ commands })).toThrow(
        "invalid-result-invocation",
      );
    for (const time of ["not-a-date", "2026-08-03T00:00:00.000Zx"])
      expect(() => validateCompletedResultInvocation({ time })).toThrow(
        "invalid-result-invocation",
      );
    expect(() =>
      validateCompletedResultInvocation({
        commands: [{ ...valid, mode: "scheduled" }],
      }),
    ).toThrow("invalid-result-invocation");
    expect(() =>
      validateCompletedResultInvocation({ commands: [valid], extra: true }),
    ).toThrow("invalid-result-invocation");
    expect(() =>
      validateCompletedResultInvocation(
        { time: "2026-08-03T00:00:00.000Z" },
        () => Date.parse("2026-08-03T00:00:00.000Z"),
      ),
    ).toThrow("invalid-result-invocation");
  });
  it("accepts only an exact fresh trusted EventBridge scheduled event", () => {
    const time = "2026-08-03T20:00:00.000Z";
    const scheduled = {
      version: "0",
      id: "event-id",
      "detail-type": "Scheduled Event",
      source: "aws.events",
      account: "123456789012",
      time,
      region: "us-east-1",
      resources: ["arn:aws:events:us-east-1:123456789012:rule/results"],
      detail: {},
    };
    expect(
      validateCompletedResultInvocation(scheduled, () => Date.parse(time)),
    ).toHaveLength(2);
    for (const changed of [
      { ...scheduled, source: "custom" },
      { ...scheduled, extra: true },
      { ...scheduled, time: "2026-08-03T19:50:00.000Z" },
      { ...scheduled, detail: { mode: "scheduled" } },
    ])
      expect(() =>
        validateCompletedResultInvocation(changed, () => Date.parse(time)),
      ).toThrow("invalid-result-invocation");
  });
  it("fails closed in the deployed fixture-only runtime", async () => {
    await expect(handler({ commands: [] })).rejects.toThrow(
      "completed-results-runtime-not-configured",
    );
  });
  it("finishes independent commands then signals failed runs", async () => {
    const seen: string[] = [];
    const handler = createCompletedResultHandler({
      execute: (command: { attemptId: string }) => {
        seen.push(command.attemptId);
        return Promise.resolve({
          attemptId: command.attemptId,
          sportKey: "mlb",
          leagueKey: "mlb",
          status: command.attemptId === "bad" ? "failed" : "succeeded",
          counters: {},
        } as never);
      },
    } as never);
    await expect(
      handler({
        commands: [
          { ...valid, attemptId: "bad" },
          { ...valid, attemptId: "good" },
        ],
      }),
    ).rejects.toThrow("completed-result-run-failed");
    expect(seen).toEqual(["bad", "good"]);
  });
});
