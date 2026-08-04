import { describe, expect, it } from "vitest";

import { parseLiveOddsInvocation } from "./live-odds-lambda";

describe("live odds Lambda invocation", () => {
  it("defaults scheduled invocations and allows the guarded release refresh", () => {
    expect(parseLiveOddsInvocation(undefined)).toEqual({ forceRefresh: false });
    expect(parseLiveOddsInvocation({})).toEqual({ forceRefresh: false });
    expect(
      parseLiveOddsInvocation({
        source: "aws.events",
        detail: {},
        "detail-type": "Scheduled Event",
      }),
    ).toEqual({ forceRefresh: false });
    expect(parseLiveOddsInvocation({ forceRefresh: true })).toEqual({
      forceRefresh: true,
    });
    expect(
      parseLiveOddsInvocation({
        Records: [{ eventSource: "aws:sqs", body: "{}" }],
      }),
    ).toEqual({ forceRefresh: false });
  });

  it.each([
    { forceRefresh: false },
    { forceRefresh: "true" },
    { forceRefresh: true, extra: true },
    [],
  ])("rejects an invalid or expanded invocation payload", (event) => {
    expect(() => parseLiveOddsInvocation(event)).toThrow(
      "live-odds-invocation-invalid",
    );
  });
});
