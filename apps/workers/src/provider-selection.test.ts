import { describe, expect, it } from "vitest";
import { comparisonBookKey, selectOddsProvider } from "./provider-selection";

const policy = [
  {
    providerId: "the-odds-api",
    mode: "primary" as const,
    enabled: true,
    failoverEligible: true,
    quotaReserve: 50,
    cooldownSeconds: 900,
    recoverySuccesses: 2,
  },
  {
    providerId: "sharpapi",
    mode: "secondary" as const,
    enabled: true,
    failoverEligible: true,
    quotaReserve: 100,
    cooldownSeconds: 900,
    recoverySuccesses: 2,
  },
];
const state = (primaryHealthy: boolean) => [
  {
    providerId: "the-odds-api",
    healthy: primaryHealthy,
    quotaRemaining: 500,
    consecutiveSuccesses: 2,
    coverageAvailable: true,
  },
  {
    providerId: "sharpapi",
    healthy: true,
    quotaRemaining: 500,
    consecutiveSuccesses: 2,
    coverageAvailable: true,
  },
];

describe("provider selection", () => {
  it("uses the healthy primary without double collection", () => {
    expect(
      selectOddsProvider(policy, state(true), new Date("2026-08-03T12:00:00Z")),
    ).toMatchObject({
      attemptedProviders: ["the-odds-api"],
      selectedProviderId: "the-odds-api",
      reason: "primary",
    });
  });
  it("fails over explicitly and records both attempts", () => {
    expect(
      selectOddsProvider(
        policy,
        state(false),
        new Date("2026-08-03T12:00:00Z"),
      ),
    ).toMatchObject({
      attemptedProviders: ["the-odds-api", "sharpapi"],
      selectedProviderId: "sharpapi",
      reason: "primary-unavailable",
    });
  });
  it("honors cooldown, quota reserve, and failback health threshold", () => {
    const states = state(true).map((item, index) =>
      index
        ? item
        : {
            ...item,
            consecutiveSuccesses: 1,
            cooldownUntil: "2026-08-03T12:30:00.000Z",
          },
    );
    expect(
      selectOddsProvider(policy, states, new Date("2026-08-03T12:00:00Z"))
        .selectedProviderId,
    ).toBe("sharpapi");
  });
  it("deduplicates shared books independently of aggregator", () => {
    expect(
      comparisonBookKey({
        sportsbookId: "hardrockbet",
        marketKey: "moneyline",
        selectionKey: "team:home",
      }),
    ).toBe(
      comparisonBookKey({
        sportsbookId: "hardrockbet",
        marketKey: "moneyline",
        selectionKey: "team:home",
      }),
    );
  });
});
