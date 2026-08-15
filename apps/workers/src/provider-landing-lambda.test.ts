import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryOddsControlPlaneStore } from "@find-the-edge/database";
import { SharpApiError } from "@find-the-edge/providers";

import {
  createProviderLandingMetricSink,
  parseProviderLandingSecret,
  providerLandingTerminalReason,
  recoverProviderLandingAccountWindow,
  settleProviderLandingTerminalFailure,
} from "./provider-landing-lambda";
import { SharedSharpApiAccountRateCoordinator } from "./provider-landing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider landing Lambda boundary", () => {
  it("accepts the existing plain and JSON SharpAPI secret shapes", () => {
    expect(parseProviderLandingSecret("server-key")).toBe("server-key");
    expect(parseProviderLandingSecret('{"apiKey":"server-key"}')).toBe(
      "server-key",
    );
  });

  it.each([
    undefined,
    "",
    " server-key",
    '{"apiKey":""}',
    '{"apiKey":" server-key"}',
  ])(
    "rejects an absent or malformed secret without exposing it: %s",
    (value) => {
      expect(() => parseProviderLandingSecret(value)).toThrow(
        /provider-landing-secret/,
      );
    },
  );

  it("emits exact low-cardinality EMF with seconds for age metrics", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    createProviderLandingMetricSink("staging").emit(
      "ProviderLandingCompletionAgeSeconds",
      42,
      { stream: "odds", outcome: "observed" },
    );
    const envelope = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      _aws: {
        CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[];
      };
      Stage: string;
      Stream: string;
      Outcome: string;
      ProviderLandingCompletionAgeSeconds: number;
    };
    expect(envelope).toMatchObject({
      Stage: "staging",
      Stream: "odds",
      Outcome: "observed",
      ProviderLandingCompletionAgeSeconds: 42,
    });
    expect(envelope._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: "ProviderLandingCompletionAgeSeconds", Unit: "Seconds" },
    ]);
  });

  it.each([
    [new SharpApiError("configuration"), "configuration"],
    [new SharpApiError("not-entitled"), "not-entitled"],
    [new SharpApiError("unauthorized"), "unauthorized"],
    [new SharpApiError("provider-rejected", false), "provider-rejected"],
    [new Error("provider-landing-account-terminal"), "account-terminal"],
    [new Error("provider-landing-configuration-invalid"), "configuration"],
    [new Error("provider-landing-secret-missing"), "configuration"],
    [new Error("provider-landing-secret-invalid"), "configuration"],
  ])("classifies one-shot terminal failures", (error, reason) => {
    expect(providerLandingTerminalReason(error)).toBe(reason);
  });

  it("classifies a missing bound secret as deterministic configuration", () => {
    const error = new Error("not exposed");
    error.name = "ResourceNotFoundException";
    expect(providerLandingTerminalReason(error)).toBe("configuration");
  });

  it("keeps transient and unexpected failures on the retry path", () => {
    expect(
      providerLandingTerminalReason(new SharpApiError("rate-limited")),
    ).toBe(null);
    expect(providerLandingTerminalReason(new Error("storage-outage"))).toBe(
      null,
    );
    expect(
      providerLandingTerminalReason(
        new SharpApiError("provider-rejected", true),
      ),
    ).toBe(null);
  });

  it("settles a malformed secret when shared account health is absent", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const accountRate = new SharedSharpApiAccountRateCoordinator(store);
    const emit = vi.fn();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let malformedSecret: unknown;
    try {
      parseProviderLandingSecret('{"apiKey":""}');
    } catch (error) {
      malformedSecret = error;
    }
    await expect(
      settleProviderLandingTerminalFailure(
        malformedSecret,
        accountRate,
        { emit },
        new Date("2026-08-15T00:00:00.000Z"),
      ),
    ).resolves.toEqual({ terminal: true, reason: "configuration" });
    expect(await store.getHealth("sharpapi:account:account")).toMatchObject({
      healthy: false,
      status: "unhealthy",
      failureClass: "terminal",
      failureReason: "configuration",
      updatedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(emit).toHaveBeenCalledWith("ProviderLandingTerminalFailure", 1, {
      stream: "account",
      outcome: "terminal",
    });
  });

  it("elects and publishes an authoritative account window for landing", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-15T00:00:00.000Z",
      },
      updatedAt: "2026-08-14T23:59:30.000Z",
    });
    const fetchAccount = vi.fn(() =>
      Promise.resolve({
        responseMetadata: {
          rateWindow: {
            limit: 1_000,
            remaining: 999,
            resetsAt: "2026-08-15T00:01:00.000Z",
          },
        },
      } as never),
    );
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount,
        now: () => new Date("2026-08-15T00:00:05.000Z"),
      }),
    ).resolves.toBe("recovered");
    expect(fetchAccount).toHaveBeenCalledOnce();
    expect((await store.getHealth(key))?.rateWindow).toMatchObject({
      limit: 1_000,
      remaining: 999,
      resetsAt: "2026-08-15T00:01:00.000Z",
    });
  });

  it("does not dispatch after the elected probe crosses the checkpoint deadline", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-15T00:00:00.000Z",
      },
      updatedAt: "2026-08-14T23:59:30.000Z",
    });
    const fetchAccount = vi.fn();
    const shouldContinue = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount,
        shouldContinue,
        now: () => new Date("2026-08-15T00:00:05.000Z"),
      }),
    ).resolves.toBe("unavailable");
    expect(fetchAccount).not.toHaveBeenCalled();
    expect((await store.getHealth(key))?.rateWindow?.probeUntil).toBe(
      "2026-08-15T00:01:05.000Z",
    );
  });

  it("keeps a missing-metadata probe lease from duplicating the paid check", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-15T00:00:00.000Z",
      },
      updatedAt: "2026-08-14T23:59:30.000Z",
    });
    const firstFetch = vi.fn(() => Promise.resolve({} as never));
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount: firstFetch,
        now: () => new Date("2026-08-15T00:00:05.000Z"),
      }),
    ).resolves.toBe("unavailable");
    const duplicateFetch = vi.fn();
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount: duplicateFetch,
        pause: () => Promise.resolve(),
        now: () => new Date("2026-08-15T00:00:06.000Z"),
      }),
    ).resolves.toBe("unavailable");
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(duplicateFetch).not.toHaveBeenCalled();
  });

  it("durably terminalizes a nonretryable account probe rejection", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-15T00:00:00.000Z",
      },
      updatedAt: "2026-08-14T23:59:30.000Z",
    });
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount: () =>
          Promise.reject(new SharpApiError("provider-rejected", false)),
        now: () => new Date("2026-08-15T00:00:05.000Z"),
      }),
    ).rejects.toThrow("provider-rejected");
    expect(await store.getHealth(key)).toMatchObject({
      healthy: false,
      status: "unhealthy",
      failureClass: "terminal",
      failureReason: "provider-rejected",
    });
  });

  it("observes another probe winner without sending a duplicate paid request", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        probeUntil: "2026-08-15T00:01:00.000Z",
      },
      updatedAt: "2026-08-15T00:00:00.000Z",
    });
    const fetchAccount = vi.fn();
    const pause = vi.fn(async () => {
      await store.reconcileAccountRateWindow(
        key,
        1,
        1,
        {
          limit: 1_000,
          remaining: 998,
          resetsAt: "2026-08-15T00:01:00.000Z",
        },
        "2026-08-15T00:00:05.000Z",
      );
    });
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount,
        pause,
        now: () => new Date("2026-08-15T00:00:05.000Z"),
      }),
    ).resolves.toBe("observed");
    expect(pause).toHaveBeenCalledOnce();
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  it("shares an elected recovery probe rate limit with every account consumer", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const key = "sharpapi:account:account";
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: key,
      healthy: true,
      consecutiveSuccesses: 1,
      rateWindow: {
        limit: 1_000,
        remaining: 900,
        resetsAt: "2026-08-15T00:00:00.000Z",
      },
      updatedAt: "2026-08-14T23:59:30.000Z",
    });
    await expect(
      recoverProviderLandingAccountWindow({
        control: store,
        fetchAccount: () =>
          Promise.reject(
            new SharpApiError(
              "rate-limited",
              true,
              "2026-08-15T00:01:00.000Z" as never,
            ),
          ),
        now: () => new Date("2026-08-15T00:00:05.000Z"),
      }),
    ).rejects.toThrow("rate-limited");
    expect(await store.getHealth(key)).toMatchObject({
      healthy: false,
      status: "unhealthy",
      failureClass: "transient",
      failureReason: "rate-limited",
      retryAt: "2026-08-15T00:01:00.000Z",
      rateWindow: {
        remaining: 0,
        resetsAt: "2026-08-15T00:01:00.000Z",
      },
    });
  });
});
