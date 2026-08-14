import { describe, expect, it } from "vitest";
import type { EventRepository } from "@find-the-edge/database";
import { createEventHandler } from "./handler";

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
      unavailableReason: null,
    };
  },
  async detail() {
    await Promise.resolve();
    return { projectionState: "ready", item: null, unavailableReason: null };
  },
};

describe("owned session capabilities API", () => {
  const handler = createEventHandler(events, undefined, () => undefined);

  it("returns the verified account and no default capabilities", async () => {
    const result = await handler({
      route: "auth-session-capabilities",
      method: "GET",
      subject: `account:${"ab12cd34".repeat(8)}`,
      scopes: [
        "events/events:read",
        "events/scouting:read",
        "events/scouting:write",
      ],
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
    expect(result).toEqual({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        schemaVersion: "owned-session-capabilities-v1",
        accountId: `account:${"ab12cd34".repeat(8)}`,
        capabilities: [],
      }),
    });
  });

  it("returns full elevated capabilities in canonical order", async () => {
    const result = await handler({
      route: "auth-session-capabilities",
      method: "GET",
      subject: `account:${"ab12cd34".repeat(8)}`,
      scopes: [
        "events/events:read",
        "events/strategies:promote",
        "events/retrospectives:approve",
      ],
      reviewerAuthorized: true,
      strategyPromoterAuthorized: true,
    });
    expect(JSON.parse(result.body)).toEqual({
      schemaVersion: "owned-session-capabilities-v1",
      accountId: `account:${"ab12cd34".repeat(8)}`,
      capabilities: [
        "events/retrospectives:approve",
        "events/strategies:promote",
      ],
    });
  });

  it("requires both the role projection and its matching full scope", async () => {
    const result = await handler({
      route: "auth-session-capabilities",
      method: "GET",
      subject: `account:${"ab12cd34".repeat(8)}`,
      scopes: ["retrospectives:approve", "events/strategies:promote"],
      reviewerAuthorized: true,
      strategyPromoterAuthorized: false,
    });
    expect(result.body).toBe(
      JSON.stringify({
        schemaVersion: "owned-session-capabilities-v1",
        accountId: `account:${"ab12cd34".repeat(8)}`,
        capabilities: [],
      }),
    );
  });

  it("refuses an unverified caller and rejects request-shape smuggling", async () => {
    const unauthorized = await handler({
      route: "auth-session-capabilities",
      method: "GET",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");

    const malformed = await handler({
      route: "auth-session-capabilities",
      method: "GET",
      subject: `account:${"ab12cd34".repeat(8)}`,
      query: { role: "strategy-promoter" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["cache-control"]).toBe("no-store");
  });
});
