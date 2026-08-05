import { describe, expect, it } from "vitest";

import {
  boundedLiveOddsInvocationError,
  boundedRetryVisibilitySeconds,
  liveOddsErrorRetryDecision,
  liveOddsSummaryRetryDecision,
  liveOddsSummaryRetryReason,
  parseLiveOddsInvocation,
} from "./live-odds-lambda";
import { SharpApiError } from "@find-the-edge/providers";

describe("live odds Lambda invocation", () => {
  it("preserves closed diagnostics and bounds unexpected runtime failures", () => {
    expect(
      boundedLiveOddsInvocationError(
        new Error("event-reconciliation-ownership-lost"),
      ),
    ).toBe("event-reconciliation-ownership-lost");
    expect(
      boundedLiveOddsInvocationError(
        new Error("continuation-transition-conflict"),
      ),
    ).toBe("continuation-transition-conflict");
    expect(
      boundedLiveOddsInvocationError(
        new Error("near-canonical-projection-stale"),
      ),
    ).toBe("near-canonical-projection-stale");
    expect(
      boundedLiveOddsInvocationError(
        new TypeError("Cannot read properties of a licensed response"),
      ),
    ).toBe("live-odds-runtime-type-error");
    expect(
      boundedLiveOddsInvocationError(new Error("credential-like value: abc")),
    ).toBe("live-odds-runtime-error");
    expect(boundedLiveOddsInvocationError(new Error("secret-key-abc"))).toBe(
      "live-odds-runtime-error",
    );
    expect(boundedLiveOddsInvocationError(null)).toBe(
      "live-odds-runtime-error",
    );
  });
  it("retains SQS retry ownership for transient summaries but acknowledges terminal work", () => {
    expect(
      liveOddsSummaryRetryReason({
        focused: { status: "retryable", reason: "quota-reserve" },
      }),
    ).toBe("quota-reserve");
    expect(
      liveOddsSummaryRetryReason([
        { status: "failed", reason: "schedule-rate-limited" },
      ]),
    ).toBe("rate-limited");
    expect(
      liveOddsSummaryRetryReason([
        { status: "failed", reason: "not-entitled" },
      ]),
    ).toBeUndefined();
  });
  it("bounds provider-directed visibility without retrying early", () => {
    expect(
      boundedRetryVisibilitySeconds(
        "2026-08-03T14:00:00.000Z",
        new Date("2026-08-03T12:00:00.000Z"),
      ),
    ).toBe(7_200);
    expect(
      boundedRetryVisibilitySeconds(
        "2026-08-04T12:00:01.000Z",
        new Date("2026-08-03T12:00:00.000Z"),
      ),
    ).toBe(43_200);
    expect(
      boundedRetryVisibilitySeconds(
        "2026-08-03T11:59:00.000Z",
        new Date("2026-08-03T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });
  it("keeps retryAt associated with its own retryable record and honors top-level provider timing", () => {
    expect(
      liveOddsSummaryRetryDecision({
        unrelated: { retryAt: "2026-08-03T13:00:00.000Z" },
        focused: {
          status: "retryable",
          reason: "rate-limited",
          retryAt: "2026-08-03T12:20:00.000Z",
        },
      }),
    ).toEqual({
      reason: "rate-limited",
      retryAt: "2026-08-03T12:20:00.000Z",
    });
    expect(
      liveOddsErrorRetryDecision(
        new SharpApiError(
          "rate-limited",
          true,
          "2026-08-03T12:20:00.000Z" as never,
        ),
        2,
        new Date("2026-08-03T12:00:00.000Z"),
      ).retryAt,
    ).toBe("2026-08-03T12:20:00.000Z");
  });
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
        mode: "focused",
        leagueKey: "epl",
        providerEventId: "provider-event-1",
      }),
    ).toEqual({
      forceRefresh: false,
      focused: { leagueKey: "epl", providerEventId: "provider-event-1" },
    });
    expect(
      parseLiveOddsInvocation({
        Records: [
          {
            eventSource: "aws:sqs",
            body: "{}",
            messageId: "message-1",
            attributes: { ApproximateReceiveCount: "3" },
          },
        ],
      }),
    ).toEqual({
      forceRefresh: false,
      sqs: { messageId: "message-1", receiveCount: 3 },
    });
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
