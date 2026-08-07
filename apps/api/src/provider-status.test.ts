import { describe, expect, it } from "vitest";
import type { ProductionProviderStatusScope } from "@find-the-edge/config";
import { MemoryOddsControlPlaneStore } from "@find-the-edge/database";
import { buildProviderStatusPage } from "./provider-status";

const catalog: readonly ProductionProviderStatusScope[] = [
  {
    scopeId: "sharpapi:mlb:odds",
    healthKey: "sharpapi:mlb:odds",
    providerId: "sharpapi",
    providerName: "SharpAPI",
    sportKey: "mlb",
    leagueKey: "mlb",
    capability: "odds",
    purpose: "Prices",
    supportedData: ["moneyline"],
    expectedFreshnessSeconds: 60,
    reserve: 100,
  },
];
const now = new Date("2026-08-07T12:00:00.000Z");

describe("provider status projection", () => {
  it("keeps connection independent from an exhausted authoritative window", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      healthKey: "sharpapi:mlb:odds",
      providerId: "sharpapi",
      healthy: true,
      status: "healthy",
      consecutiveSuccesses: 2,
      lastSuccessfulAt: "2026-08-07T11:59:50.000Z",
      updatedAt: "2026-08-07T11:59:50.000Z",
      rateWindow: {
        limit: 1000,
        remaining: 0,
        resetsAt: "2026-08-07T12:05:00.000Z",
      },
      quotaRemaining: 999_999,
    });
    const page = await buildProviderStatusPage(catalog, store, now);
    expect(page.items[0]).toMatchObject({
      connection: "healthy",
      capacity: { state: "exhausted", remaining: 0 },
      lastSuccessfulAt: "2026-08-07T11:59:50.000Z",
      recommendationImpact: "limited",
    });
    expect(JSON.stringify(page)).not.toContain("quotaRemaining");
  });

  it.each([
    [
      "partial",
      {
        healthy: true,
        status: "healthy",
        partialEvidenceCount: 2,
        lastSuccessfulAt: "2026-08-07T11:59:50.000Z",
        updatedAt: "2026-08-07T11:59:50.000Z",
      },
    ],
    [
      "stale",
      {
        healthy: true,
        status: "healthy",
        lastSuccessfulAt: "2026-08-07T11:58:00.000Z",
        updatedAt: "2026-08-07T11:58:00.000Z",
      },
    ],
    [
      "outage",
      {
        healthy: false,
        status: "unhealthy",
        failureReason: "api-key=secret",
        updatedAt: "2026-08-07T11:59:50.000Z",
      },
    ],
  ] as const)(
    "derives %s without exposing internal failure data",
    async (expected, override) => {
      const store = new MemoryOddsControlPlaneStore();
      await store.putHealth({
        providerId: "sharpapi",
        healthKey: "sharpapi:mlb:odds",
        consecutiveSuccesses: 0,
        ...override,
      });
      const page = await buildProviderStatusPage(catalog, store, now);
      expect(page.items[0]?.connection).toBe(expected);
      expect(JSON.stringify(page)).not.toContain("api-key");
    },
  );

  it("returns explicit unknown partial coverage for a missing exact key", async () => {
    const page = await buildProviderStatusPage(
      catalog,
      new MemoryOddsControlPlaneStore(),
      now,
    );
    expect(page).toMatchObject({
      evaluationState: "partial",
      summary: { unknown: 1, impacted: 1 },
      items: [{ connection: "unknown", capacity: { state: "unknown" } }],
    });
  });

  it("uses durable success freshness, clamps ancient age, and makes stale override partial", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      healthKey: "sharpapi:mlb:odds",
      providerId: "sharpapi",
      healthy: true,
      status: "degraded",
      degraded: true,
      partialEvidenceCount: 3,
      consecutiveSuccesses: 1,
      lastSuccessfulAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2026-08-07T11:59:59.000Z",
    });
    const page = await buildProviderStatusPage(catalog, store, now);
    expect(page).toMatchObject({
      evaluationState: "complete",
      items: [
        {
          connection: "stale",
          safeReason: "stale-data",
          freshness: { ageSeconds: 31_536_000 },
          recommendationImpact: "suppressed",
        },
      ],
    });
  });

  it.each([
    ["wrong health key", { healthKey: "sharpapi:nfl:odds" }],
    ["wrong provider", { providerId: "other" }],
  ])("fails closed for %s", async (_label, mismatch) => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      healthKey: "sharpapi:mlb:odds",
      providerId: "sharpapi",
      healthy: true,
      status: "healthy",
      consecutiveSuccesses: 1,
      lastSuccessfulAt: "2026-08-07T11:59:50.000Z",
      updatedAt: "2026-08-07T11:59:50.000Z",
      ...mismatch,
    });
    const page = await buildProviderStatusPage(catalog, store, now);
    expect(page).toMatchObject({
      evaluationState: "partial",
      items: [{ connection: "unknown", lastSuccessfulAt: null }],
    });
  });

  it.each(["healthy", "degraded"] as const)(
    "fails closed for a legacy %s row without durable success",
    async (status) => {
      const store = new MemoryOddsControlPlaneStore();
      await store.putHealth({
        healthKey: "sharpapi:mlb:odds",
        providerId: "sharpapi",
        healthy: true,
        status,
        ...(status === "degraded" ? { degraded: true } : {}),
        consecutiveSuccesses: 1,
        updatedAt: "2026-08-07T11:59:50.000Z",
      });
      const page = await buildProviderStatusPage(catalog, store, now);
      expect(page).toMatchObject({
        evaluationState: "partial",
        items: [{ connection: "unknown", lastSuccessfulAt: null }],
      });
    },
  );

  it("publishes only a future sanitized retry timestamp", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      healthKey: "sharpapi:mlb:odds",
      providerId: "sharpapi",
      healthy: false,
      status: "unhealthy",
      consecutiveSuccesses: 0,
      lastSuccessfulAt: "2026-08-07T11:58:00.000Z",
      updatedAt: "2026-08-07T11:59:50.000Z",
      retryAt: "2026-08-07T12:05:00.000Z",
      failureReason: "api-key=secret",
    });
    const page = await buildProviderStatusPage(catalog, store, now);
    expect(page.items[0]).toMatchObject({
      retryAt: "2026-08-07T12:05:00.000Z",
      connection: "outage",
    });
    expect(JSON.stringify(page)).not.toContain("api-key");
  });

  it("falls back to exact sibling reads when a batch read cannot complete", async () => {
    const healthy = {
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      status: "healthy" as const,
      consecutiveSuccesses: 1,
      lastSuccessfulAt: "2026-08-07T11:59:50.000Z",
      updatedAt: "2026-08-07T11:59:50.000Z",
    };
    const store = {
      getHealthMany: () => Promise.reject(new Error("health-read-partial")),
      getHealth: (key: string) =>
        Promise.resolve(key === "sharpapi:mlb:odds" ? healthy : null),
    };
    const page = await buildProviderStatusPage(catalog, store, now);
    expect(page).toMatchObject({
      evaluationState: "complete",
      summary: { healthy: 1 },
      items: [{ connection: "healthy" }],
    });
  });
});
