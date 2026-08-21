import { describe, expect, it } from "vitest";

import {
  assertLiveOddsMaintenanceOwnership,
  boundedLiveOddsInvocationError,
  boundedRetryVisibilitySeconds,
  handler,
  liveOddsErrorRetryDecision,
  liveOddsSqsFailureResponse,
  liveOddsSummaryRetryDecision,
  liveOddsSummaryRetryReason,
  parseLiveOddsInvocation,
  retainLiveOddsSqsRetryOwnership,
  runLiveOddsFastLane,
} from "./live-odds-lambda";
import { SharpApiError } from "@find-the-edge/providers";

describe("live odds Lambda invocation", () => {
  it("accepts staging cadence and manual invocation shapes", () => {
    expect(
      parseLiveOddsInvocation({
        Records: [
          {
            eventSource: "aws:sqs",
            messageId: "scheduled-1",
            attributes: { ApproximateReceiveCount: "1" },
          },
        ],
      }),
    ).toMatchObject({
      forceRefresh: false,
      sqs: { messageId: "scheduled-1", receiveCount: 1 },
    });
    expect(parseLiveOddsInvocation(undefined)).toEqual({ forceRefresh: false });
  });

  it("routes a real staging SQS invocation through normal configuration validation", async () => {
    const originalStage = process.env["FTE_AWS_STAGE"];
    const originalTable = process.env["FTE_EVENT_TABLE"];
    const originalSecret = process.env["FTE_SHARP_API_SECRET_ID"];
    const originalEnabled = process.env["FTE_SHARP_API_ENABLED"];
    try {
      process.env["FTE_AWS_STAGE"] = "staging";
      delete process.env["FTE_EVENT_TABLE"];
      delete process.env["FTE_SHARP_API_SECRET_ID"];
      delete process.env["FTE_SHARP_API_ENABLED"];
      await expect(
        handler({
          Records: [
            {
              eventSource: "aws:sqs",
              messageId: "staging-cadence-1",
              attributes: { ApproximateReceiveCount: "1" },
            },
          ],
        }),
      ).resolves.toEqual({ batchItemFailures: [] });
    } finally {
      if (originalStage === undefined) delete process.env["FTE_AWS_STAGE"];
      else process.env["FTE_AWS_STAGE"] = originalStage;
      if (originalTable === undefined) delete process.env["FTE_EVENT_TABLE"];
      else process.env["FTE_EVENT_TABLE"] = originalTable;
      if (originalSecret === undefined)
        delete process.env["FTE_SHARP_API_SECRET_ID"];
      else process.env["FTE_SHARP_API_SECRET_ID"] = originalSecret;
      if (originalEnabled === undefined)
        delete process.env["FTE_SHARP_API_ENABLED"];
      else process.env["FTE_SHARP_API_ENABLED"] = originalEnabled;
    }
  });

  it("acknowledges deterministic production configuration failures", async () => {
    const originalStage = process.env["FTE_AWS_STAGE"];
    const originalTable = process.env["FTE_EVENT_TABLE"];
    const originalSecret = process.env["FTE_SHARP_API_SECRET_ID"];
    const originalEnabled = process.env["FTE_SHARP_API_ENABLED"];
    try {
      process.env["FTE_AWS_STAGE"] = "prod";
      delete process.env["FTE_EVENT_TABLE"];
      delete process.env["FTE_SHARP_API_SECRET_ID"];
      delete process.env["FTE_SHARP_API_ENABLED"];
      await expect(
        handler({
          Records: [
            {
              eventSource: "aws:sqs",
              messageId: "prod-terminal-1",
              attributes: { ApproximateReceiveCount: "1" },
            },
          ],
        }),
      ).resolves.toEqual({ batchItemFailures: [] });
    } finally {
      if (originalStage === undefined) delete process.env["FTE_AWS_STAGE"];
      else process.env["FTE_AWS_STAGE"] = originalStage;
      if (originalTable === undefined) delete process.env["FTE_EVENT_TABLE"];
      else process.env["FTE_EVENT_TABLE"] = originalTable;
      if (originalSecret === undefined)
        delete process.env["FTE_SHARP_API_SECRET_ID"];
      else process.env["FTE_SHARP_API_SECRET_ID"] = originalSecret;
      if (originalEnabled === undefined)
        delete process.env["FTE_SHARP_API_ENABLED"];
      else process.env["FTE_SHARP_API_ENABLED"] = originalEnabled;
    }
  });

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
        new Error("generic wrapper", {
          cause: new Error("continuation-transition-conflict"),
        }),
      ),
    ).toBe("continuation-transition-conflict");
    const providerFailure = new Error("invalid-response");
    providerFailure.name = "SharpApiError";
    expect(boundedLiveOddsInvocationError(providerFailure)).toBe(
      "sharpapi-invalid-response",
    );
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
    expect(
      boundedLiveOddsInvocationError(
        new Error("live-odds-control-plane-failed", {
          cause: new Error("credential-like value: abc"),
        }),
      ),
    ).toBe("live-odds-control-plane-failed");
    expect(
      boundedLiveOddsInvocationError(
        new Error("live-odds-secret-read-failed", {
          cause: new Error("secret-key-abc"),
        }),
      ),
    ).toBe("live-odds-secret-read-failed");
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
    for (const reason of [
      "storage-throttled",
      "storage-unavailable",
      "storage-transaction-in-progress",
    ]) {
      expect(
        liveOddsSummaryRetryReason({
          nested: { status: "failed", reason },
        }),
      ).toBe(reason);
      expect(
        liveOddsSummaryRetryReason({
          nested: {
            status: "failed",
            reason: `schedule-provider-error-${reason}`,
          },
        }),
      ).toBe(reason);
    }
    for (const reason of [
      "storage-validation",
      "storage-resource-missing",
      "storage-access-denied",
      "storage-transaction-cancelled",
      "schedule-provider-error-storage-validation",
    ])
      expect(
        liveOddsSummaryRetryReason({ status: "failed", reason }),
      ).toBeUndefined();
  });
  it("retains retry ownership through receive five for transient storage errors", () => {
    const throttled = Object.assign(new Error("sensitive storage detail"), {
      name: "ThrottlingException",
    });
    for (const attempt of [1, 2, 3, 4])
      expect(liveOddsErrorRetryDecision(throttled, attempt).action).toBe(
        "retry",
      );
    const exhausted = liveOddsErrorRetryDecision(throttled, 5);
    expect(exhausted.action).toBe("exhausted");
    expect(liveOddsSqsFailureResponse("message-5", exhausted.action)).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-5" }],
    });
    const validation = Object.assign(new Error("deterministic failure"), {
      name: "ValidationException",
    });
    expect(liveOddsErrorRetryDecision(validation, 1).action).toBe("stop");
    expect(liveOddsSqsFailureResponse("message-terminal", "stop")).toEqual({
      batchItemFailures: [],
    });
  });
  it("keeps retry ownership when visibility extension fails terminally", async () => {
    await expect(
      retainLiveOddsSqsRetryOwnership(
        {
          messageId: "message-storage",
          receiveCount: 2,
          receiptHandle: "receipt",
        },
        { action: "retry" },
        () =>
          Promise.reject(
            Object.assign(new Error("sensitive queue detail"), {
              name: "AccessDeniedException",
            }),
          ),
      ),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-storage" }],
    });
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
    const maintenanceToken = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      parseLiveOddsInvocation({ forceRefresh: true, maintenanceToken }),
    ).toEqual({ forceRefresh: true, maintenanceToken });
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
    { forceRefresh: true, maintenanceToken: "not-a-token" },
    [],
  ])("rejects an invalid or expanded invocation payload", (event) => {
    expect(() => parseLiveOddsInvocation(event)).toThrow(
      "live-odds-invocation-invalid",
    );
  });

  it("lets only the active feed-reset lease owner run provider ingestion", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const client = (item?: Record<string, unknown>) =>
      ({
        send: () => Promise.resolve({ ...(item ? { Item: item } : {}) }),
      }) as never;
    await expect(
      assertLiveOddsMaintenanceOwnership(client(), "table", undefined),
    ).resolves.toBeUndefined();
    await expect(
      assertLiveOddsMaintenanceOwnership(client(), "table", token),
    ).rejects.toThrow("maintenance-token-invalid");
    const active = {
      value: { token, expiresAt: "2026-08-05T21:00:00.000Z" },
    };
    await expect(
      assertLiveOddsMaintenanceOwnership(
        client(active),
        "table",
        token,
        new Date("2026-08-05T20:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertLiveOddsMaintenanceOwnership(
        client(active),
        "table",
        undefined,
        new Date("2026-08-05T20:00:00.000Z"),
      ),
    ).rejects.toThrow("maintenance-active");
  });
});

describe("intra-tick fast lane", () => {
  const virtualClock = () => {
    let at = 0;
    return {
      now: () => at,
      sleep: (ms: number) => {
        at += ms;
        return Promise.resolve();
      },
      advance: (ms: number) => {
        at += ms;
      },
    };
  };

  it("stays disabled without an explicit budget", async () => {
    const passes = await runLiveOddsFastLane({
      budgetMs: 0,
      pauseMs: 10_000,
      runPass: () => Promise.reject(new Error("must not run")),
      materialize: () => Promise.reject(new Error("must not run")),
    });
    expect(passes).toBe(0);
  });

  it("re-runs checkpoint-gated passes until the budget is spent and only rebuilds boards after committed pages", async () => {
    const clock = virtualClock();
    const passResults = [
      [{ pages: 2 }],
      [{ pages: 0 }, { pages: 0 }],
      [{ pages: 1 }],
      [{ pages: 0 }],
    ];
    let materialized = 0;
    const passes = await runLiveOddsFastLane({
      budgetMs: 50_000,
      pauseMs: 10_000,
      runPass: () => Promise.resolve(passResults.shift() ?? [{ pages: 0 }]),
      materialize: () => {
        materialized += 1;
        return Promise.resolve();
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    // Five 10s pauses fit a 50s budget.
    expect(passes).toBe(5);
    // Only the two committing passes rebuilt the stored boards.
    expect(materialized).toBe(2);
  });

  it("stops the lane on a pass failure instead of failing the invocation", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const passes = await runLiveOddsFastLane({
      budgetMs: 50_000,
      pauseMs: 10_000,
      runPass: () => {
        attempts += 1;
        return attempts === 2
          ? Promise.reject(new Error("provider-unavailable"))
          : Promise.resolve([{ pages: 0 }]);
      },
      materialize: () => Promise.resolve(),
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(attempts).toBe(2);
    expect(passes).toBe(1);
  });

  it("surfaces retryable storage summaries and thrown failures to the FIFO owner", async () => {
    for (const [runPass, expected] of [
      [
        () =>
          Promise.resolve([
            { pages: 0, status: "failed", reason: "storage-throttled" },
          ]),
        "storage-throttled",
      ],
      [
        () =>
          Promise.reject(
            Object.assign(new Error("sensitive storage detail"), {
              name: "ServiceUnavailable",
            }),
          ),
        "storage-unavailable",
      ],
    ] as const) {
      const clock = virtualClock();
      const decisions: string[] = [];
      const passes = await runLiveOddsFastLane({
        budgetMs: 20_000,
        pauseMs: 10_000,
        runPass,
        materialize: () => Promise.resolve(),
        onRetryableStorageFailure: ({ reason }) => decisions.push(reason),
        sleep: clock.sleep,
        now: clock.now,
      });
      expect(passes).toBe(0);
      expect(decisions).toEqual([expected]);
    }
  });

  it("respects time consumed by the passes themselves", async () => {
    const clock = virtualClock();
    const passes = await runLiveOddsFastLane({
      budgetMs: 50_000,
      pauseMs: 10_000,
      runPass: () => {
        // Each pass burns 15 virtual seconds beyond the pause.
        clock.advance(15_000);
        return Promise.resolve([{ pages: 0 }]);
      },
      materialize: () => Promise.resolve(),
      sleep: clock.sleep,
      now: clock.now,
    });
    // 10s pause + 15s pass per iteration: the third pause would overrun.
    expect(passes).toBe(2);
  });
});
