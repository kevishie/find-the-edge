import { describe, expect, it } from "vitest";
import {
  MemoryStrategyExperimentRepository,
  type EventRepository,
} from "@find-the-edge/database";
import { createEventHandler } from "./handler.js";

const events: EventRepository = {
  async list() {
    await Promise.resolve();
    return {
      items: [],
      nextCursor: null,
      projectionState: "ready",
      evaluationState: "complete",
      hasMoreUnknown: false,
      snapshotAt: null,
      freshness: null,
    };
  },
  async detail() {
    await Promise.resolve();
    return { projectionState: "ready", item: null };
  },
};
describe("strategy experiment API mutation boundary", () => {
  const handler = createEventHandler(
    events,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new MemoryStrategyExperimentRepository(),
  );
  const base = {
    route: "experiment-approve" as const,
    eventId: `strategy-experiment:${"a".repeat(64)}`,
    method: "POST" as const,
    contentType: "application/json",
    subject: "human",
    scopes: ["strategies:promote"],
    strategyPromoterAuthorized: true,
  };
  it("rejects null and array mutation bodies", async () => {
    expect((await handler({ ...base, body: "null" })).statusCode).toBe(400);
    expect((await handler({ ...base, body: "[]" })).statusCode).toBe(400);
  });
  it("does not confuse retrospective reviewers with strategy promoters", async () => {
    expect(
      (
        await handler({
          ...base,
          body: "{}",
          strategyPromoterAuthorized: false,
          reviewerAuthorized: true,
        })
      ).statusCode,
    ).toBe(403);
  });
});
