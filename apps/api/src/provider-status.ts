import type { ProductionProviderStatusScope } from "@find-the-edge/config";
import type {
  OddsControlPlaneStore,
  OddsProviderHealth,
} from "@find-the-edge/database";
import {
  normalizeProviderStatusPageDto,
  providerCapacityStateFor,
  providerConnectionStates,
  providerRecommendationImpactFor,
  type ProviderConnectionState,
  type ProviderStatusPageDto,
  type ProviderStatusScopeDto,
} from "@find-the-edge/domain";

const connectionState = (
  record: OddsProviderHealth | null,
  scope: ProductionProviderStatusScope,
  now: Date,
): ProviderConnectionState => {
  if (!record) return "unknown";
  if (!record.healthy || record.status === "unhealthy") return "outage";
  if (!record.lastSuccessfulAt) return "unknown";
  if (
    now.getTime() - Date.parse(record.lastSuccessfulAt) >
    scope.expectedFreshnessSeconds * 1_000
  )
    return "stale";
  if (
    record.degraded ||
    record.status === "degraded" ||
    (record.partialEvidenceCount ?? 0) > 0
  )
    return "partial";
  return "healthy";
};

const capacity = (
  record: OddsProviderHealth | null,
  scope: ProductionProviderStatusScope,
  now: Date,
): ProviderStatusScopeDto["capacity"] => {
  const window = record?.rateWindow;
  const resets = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (
    !window ||
    !Number.isSafeInteger(window.limit) ||
    Number(window.limit) <= 0 ||
    !Number.isSafeInteger(window.remaining) ||
    Number(window.remaining) < 0 ||
    Number(window.remaining) > Number(window.limit) ||
    !Number.isFinite(resets) ||
    resets <= now.getTime()
  )
    return Object.freeze({
      state: "unknown",
      limit: null,
      remaining: null,
      reserve: scope.reserve,
      resetsAt: null,
    });
  const remaining = Number(window.remaining);
  const state = providerCapacityStateFor(remaining, scope.reserve);
  return Object.freeze({
    state,
    limit: Number(window.limit),
    remaining,
    reserve: scope.reserve,
    resetsAt: window.resetsAt!,
  });
};

export async function buildProviderStatusPage(
  catalog: readonly ProductionProviderStatusScope[],
  store: Pick<OddsControlPlaneStore, "getHealth" | "getHealthMany">,
  now = new Date(),
): Promise<ProviderStatusPageDto> {
  if (
    catalog.length === 0 ||
    catalog.length > 32 ||
    new Set(catalog.map(({ healthKey }) => healthKey)).size !== catalog.length
  )
    throw new Error("provider-status-catalog-invalid");
  let reads: readonly PromiseSettledResult<OddsProviderHealth | null>[];
  try {
    const records = await store.getHealthMany(
      catalog.map(({ healthKey }) => healthKey),
    );
    if (records.length !== catalog.length)
      throw new Error("provider-status-health-count-invalid");
    reads = records.map((value) => ({ status: "fulfilled", value }));
  } catch {
    reads = await Promise.allSettled(
      catalog.map(({ healthKey }) => store.getHealth(healthKey)),
    );
  }
  const items = catalog
    .map((scope, index) => {
      const result = reads[index]!;
      const candidate = result.status === "fulfilled" ? result.value : null;
      const checked = candidate ? Date.parse(candidate.updatedAt) : Number.NaN;
      const successful = candidate?.lastSuccessfulAt
        ? Date.parse(candidate.lastSuccessfulAt)
        : null;
      const record =
        candidate &&
        candidate.healthKey === scope.healthKey &&
        candidate.providerId === scope.providerId &&
        Number.isFinite(checked) &&
        checked <= now.getTime() &&
        (successful === null ||
          (Number.isFinite(successful) &&
            successful <= checked &&
            successful <= now.getTime()))
          ? candidate
          : null;
      const connection = connectionState(record, scope, now);
      const requestCapacity = capacity(record, scope, now);
      const age = record?.lastSuccessfulAt
        ? Math.min(
            31_536_000,
            Math.max(
              0,
              Math.floor(
                (now.getTime() - Date.parse(record.lastSuccessfulAt)) / 1_000,
              ),
            ),
          )
        : null;
      const retryAt =
        record?.retryAt &&
        Number.isFinite(Date.parse(record.retryAt)) &&
        Date.parse(record.retryAt) > now.getTime()
          ? record.retryAt
          : null;
      const safeReason =
        connection === "partial"
          ? "partial-data"
          : connection === "stale"
            ? "stale-data"
            : connection === "outage"
              ? "provider-unavailable"
              : connection === "unknown"
                ? "telemetry-unavailable"
                : "none";
      return {
        scopeId: scope.scopeId,
        providerId: scope.providerId,
        providerName: scope.providerName,
        sportKey: scope.sportKey,
        leagueKey: scope.leagueKey,
        capability: scope.capability,
        purpose: scope.purpose,
        supportedData: scope.supportedData,
        connection,
        safeReason,
        lastCheckedAt: record?.updatedAt ?? null,
        lastSuccessfulAt: record?.lastSuccessfulAt ?? null,
        retryAt,
        freshness: {
          ageSeconds: age,
          expectedSeconds: scope.expectedFreshnessSeconds,
        },
        capacity: requestCapacity,
        recommendationImpact: providerRecommendationImpactFor(
          scope.capability,
          connection,
          requestCapacity.state,
        ),
      } satisfies ProviderStatusScopeDto;
    })
    .sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  const summary = {
    total: items.length,
    ...Object.fromEntries(
      providerConnectionStates.map((state) => [
        state,
        items.filter((item) => item.connection === state).length,
      ]),
    ),
    impacted: items.filter((item) => item.recommendationImpact !== "none")
      .length,
  } as ProviderStatusPageDto["summary"];
  return normalizeProviderStatusPageDto({
    schemaVersion: "provider-status-page-v1",
    snapshotAt: now.toISOString(),
    evaluationState: items.some((item) => item.connection === "unknown")
      ? "partial"
      : "complete",
    summary,
    items,
  });
}
