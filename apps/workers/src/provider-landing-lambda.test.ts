import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryOddsControlPlaneStore } from "@find-the-edge/database";
import { SharpApiError } from "@find-the-edge/providers";

import {
  createProviderLandingMetricSink,
  parseProviderLandingSecret,
  providerLandingTerminalReason,
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
});
