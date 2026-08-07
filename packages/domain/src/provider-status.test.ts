import { describe, expect, it } from "vitest";
import {
  normalizeProviderStatusPageDto,
  providerCapacityStateFor,
  providerRecommendationImpactFor,
} from "./provider-status";

const scope = {
  scopeId: "sharpapi:mlb:odds",
  providerId: "sharpapi",
  providerName: "SharpAPI",
  sportKey: "mlb",
  leagueKey: "mlb",
  capability: "odds",
  purpose: "Prices",
  supportedData: ["moneyline"],
  connection: "healthy",
  safeReason: "none",
  lastCheckedAt: "2026-08-07T12:00:00.000Z",
  lastSuccessfulAt: "2026-08-07T12:00:00.000Z",
  retryAt: null,
  freshness: { ageSeconds: 0, expectedSeconds: 900 },
  capacity: {
    state: "available",
    limit: 1000,
    remaining: 900,
    reserve: 100,
    resetsAt: "2026-08-07T12:10:00.000Z",
  },
  recommendationImpact: "none",
};
const page = (item: unknown = scope) => ({
  schemaVersion: "provider-status-page-v1",
  snapshotAt: "2026-08-07T12:00:00.000Z",
  evaluationState: "complete",
  summary: {
    total: 1,
    healthy: 1,
    partial: 0,
    stale: 0,
    outage: 0,
    unknown: 0,
    impacted: 0,
  },
  items: [item],
});

describe("provider status public contract", () => {
  it("normalizes and deeply freezes a consistent page", () => {
    const result = normalizeProviderStatusPageDto(page());
    expect(result.items[0]).toMatchObject({ connection: "healthy" });
    expect(Object.isFrozen(result.items[0]?.capacity)).toBe(true);
  });

  it.each([
    { ...page(), leakedKey: "ODDS_CONTROL#HEALTH" },
    page({ ...scope, capacity: { ...scope.capacity, remaining: 1001 } }),
    page({
      ...scope,
      capacity: { ...scope.capacity, resetsAt: "2026-08-07T11:59:00.000Z" },
    }),
    { ...page(), summary: { ...page().summary, healthy: 0 } },
  ])("rejects hostile or contradictory pages", (value) => {
    expect(() => normalizeProviderStatusPageDto(value)).toThrow();
  });

  it.each([
    [0, "exhausted"],
    [100, "reserve-protected"],
    [101, "low"],
    [200, "low"],
    [201, "available"],
  ] as const)("derives capacity %s as %s", (remaining, expected) => {
    expect(providerCapacityStateFor(remaining, 100)).toBe(expected);
  });

  it("derives recommendation impact entirely on the server contract", () => {
    expect(
      providerRecommendationImpactFor("schedule", "stale", "available"),
    ).toBe("limited");
    expect(
      providerRecommendationImpactFor("account", "unknown", "unknown"),
    ).toBe("limited");
    expect(providerRecommendationImpactFor("odds", "stale", "available")).toBe(
      "suppressed",
    );
    expect(
      providerRecommendationImpactFor("odds", "partial", "available"),
    ).toBe("limited");
    expect(
      providerRecommendationImpactFor("splits", "healthy", "exhausted"),
    ).toBe("limited");
  });

  it.each([
    ["safe reason", { ...scope, safeReason: "stale-data" }],
    ["recommendation impact", { ...scope, recommendationImpact: "limited" }],
    [
      "capacity threshold",
      {
        ...scope,
        capacity: { ...scope.capacity, state: "available", remaining: 150 },
      },
    ],
    [
      "success chronology",
      {
        ...scope,
        lastCheckedAt: "2026-08-07T11:59:00.000Z",
        lastSuccessfulAt: "2026-08-07T12:00:00.000Z",
      },
    ],
    [
      "freshness age",
      { ...scope, freshness: { ...scope.freshness, ageSeconds: 1 } },
    ],
  ])("rejects inconsistent %s", (_label, item) => {
    expect(() => normalizeProviderStatusPageDto(page(item))).toThrow();
  });

  it("requires partial evaluation exactly when an unknown scope exists", () => {
    expect(() =>
      normalizeProviderStatusPageDto({ ...page(), evaluationState: "partial" }),
    ).toThrow();
    const unknown = {
      ...scope,
      connection: "unknown",
      safeReason: "telemetry-unavailable",
      lastCheckedAt: null,
      lastSuccessfulAt: null,
      freshness: { ageSeconds: null, expectedSeconds: 900 },
      capacity: {
        state: "unknown",
        limit: null,
        remaining: null,
        reserve: 100,
        resetsAt: null,
      },
      recommendationImpact: "suppressed",
    };
    expect(() =>
      normalizeProviderStatusPageDto({
        ...page(unknown),
        summary: {
          total: 1,
          healthy: 0,
          partial: 0,
          stale: 0,
          outage: 0,
          unknown: 1,
          impacted: 1,
        },
      }),
    ).toThrow();
  });

  it("accepts the bounded age for ancient successful evidence", () => {
    const stale = {
      ...scope,
      connection: "stale",
      safeReason: "stale-data",
      lastSuccessfulAt: "2024-01-01T00:00:00.000Z",
      freshness: { ageSeconds: 31_536_000, expectedSeconds: 900 },
      recommendationImpact: "suppressed",
    };
    expect(
      normalizeProviderStatusPageDto({
        ...page(stale),
        summary: {
          total: 1,
          healthy: 0,
          partial: 0,
          stale: 1,
          outage: 0,
          unknown: 0,
          impacted: 1,
        },
      }).items[0]?.freshness.ageSeconds,
    ).toBe(31_536_000);
  });
});
