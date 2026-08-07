export const providerConnectionStates = [
  "healthy",
  "partial",
  "stale",
  "outage",
  "unknown",
] as const;
export type ProviderConnectionState = (typeof providerConnectionStates)[number];
export const providerCapacityStates = [
  "available",
  "low",
  "reserve-protected",
  "exhausted",
  "unknown",
] as const;
export type ProviderCapacityState = (typeof providerCapacityStates)[number];
export type ProviderStatusCapability =
  "account" | "schedule" | "odds" | "splits";
export type ProviderRecommendationImpact = "none" | "limited" | "suppressed";

export interface ProviderStatusScopeDto {
  readonly scopeId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly sportKey: string | null;
  readonly leagueKey: string;
  readonly capability: ProviderStatusCapability;
  readonly purpose: string;
  readonly supportedData: readonly string[];
  readonly connection: ProviderConnectionState;
  readonly safeReason:
    | "none"
    | "partial-data"
    | "stale-data"
    | "provider-unavailable"
    | "telemetry-unavailable";
  readonly lastCheckedAt: string | null;
  readonly lastSuccessfulAt: string | null;
  readonly retryAt: string | null;
  readonly freshness: {
    readonly ageSeconds: number | null;
    readonly expectedSeconds: number;
  };
  readonly capacity: {
    readonly state: ProviderCapacityState;
    readonly limit: number | null;
    readonly remaining: number | null;
    readonly reserve: number;
    readonly resetsAt: string | null;
  };
  readonly recommendationImpact: ProviderRecommendationImpact;
}

export const providerCapacityStateFor = (
  remaining: number,
  reserve: number,
): Exclude<ProviderCapacityState, "unknown"> =>
  remaining === 0
    ? "exhausted"
    : remaining <= reserve
      ? "reserve-protected"
      : remaining <= reserve * 2
        ? "low"
        : "available";

export const providerRecommendationImpactFor = (
  capability: ProviderStatusCapability,
  connection: ProviderConnectionState,
  capacity: ProviderCapacityState,
): ProviderRecommendationImpact => {
  if (capability === "odds") {
    if (["stale", "outage", "unknown"].includes(connection))
      return "suppressed";
    if (connection === "partial") return "limited";
  }
  if (
    (capability === "account" || capability === "schedule") &&
    connection !== "healthy"
  )
    return "limited";
  return ["reserve-protected", "exhausted"].includes(capacity)
    ? "limited"
    : "none";
};
export interface ProviderStatusPageDto {
  readonly schemaVersion: "provider-status-page-v1";
  readonly snapshotAt: string;
  readonly evaluationState: "complete" | "partial";
  readonly summary: {
    readonly total: number;
    readonly healthy: number;
    readonly partial: number;
    readonly stale: number;
    readonly outage: number;
    readonly unknown: number;
    readonly impacted: number;
  };
  readonly items: readonly ProviderStatusScopeDto[];
}

const rec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const txt = (v: unknown, max = 128): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && v.trim() === v;
const iso = (v: unknown): v is string =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const nat = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;

export function normalizeProviderStatusPageDto(
  value: unknown,
): ProviderStatusPageDto {
  if (
    !rec(value) ||
    !exact(value, [
      "schemaVersion",
      "snapshotAt",
      "evaluationState",
      "summary",
      "items",
    ]) ||
    value.schemaVersion !== "provider-status-page-v1" ||
    !iso(value.snapshotAt) ||
    !["complete", "partial"].includes(String(value.evaluationState)) ||
    !rec(value.summary) ||
    !exact(value.summary, [
      "total",
      "healthy",
      "partial",
      "stale",
      "outage",
      "unknown",
      "impacted",
    ]) ||
    !Object.values(value.summary).every(nat) ||
    !Array.isArray(value.items) ||
    value.items.length > 32
  )
    throw new Error("provider-status-page-invalid");
  const snapshot = Date.parse(value.snapshotAt);
  const items = value.items.map((item) => {
    if (
      !rec(item) ||
      !exact(item, [
        "scopeId",
        "providerId",
        "providerName",
        "sportKey",
        "leagueKey",
        "capability",
        "purpose",
        "supportedData",
        "connection",
        "safeReason",
        "lastCheckedAt",
        "lastSuccessfulAt",
        "retryAt",
        "freshness",
        "capacity",
        "recommendationImpact",
      ]) ||
      !txt(item.scopeId) ||
      !txt(item.providerId, 64) ||
      !txt(item.providerName) ||
      (item.sportKey !== null && !txt(item.sportKey, 64)) ||
      !txt(item.leagueKey, 64) ||
      !["account", "schedule", "odds", "splits"].includes(
        String(item.capability),
      ) ||
      !txt(item.purpose, 256) ||
      !Array.isArray(item.supportedData) ||
      item.supportedData.length === 0 ||
      item.supportedData.some((entry) => !txt(entry)) ||
      new Set(item.supportedData).size !== item.supportedData.length ||
      !providerConnectionStates.includes(
        item.connection as ProviderConnectionState,
      ) ||
      ![
        "none",
        "partial-data",
        "stale-data",
        "provider-unavailable",
        "telemetry-unavailable",
      ].includes(String(item.safeReason)) ||
      (item.lastCheckedAt !== null && !iso(item.lastCheckedAt)) ||
      (item.lastSuccessfulAt !== null && !iso(item.lastSuccessfulAt)) ||
      (item.retryAt !== null && !iso(item.retryAt)) ||
      !rec(item.freshness) ||
      !exact(item.freshness, ["ageSeconds", "expectedSeconds"]) ||
      (item.freshness.ageSeconds !== null &&
        (!nat(item.freshness.ageSeconds) ||
          Number(item.freshness.ageSeconds) > 31_536_000)) ||
      !nat(item.freshness.expectedSeconds) ||
      Number(item.freshness.expectedSeconds) === 0 ||
      !rec(item.capacity) ||
      !exact(item.capacity, [
        "state",
        "limit",
        "remaining",
        "reserve",
        "resetsAt",
      ]) ||
      !providerCapacityStates.includes(
        item.capacity.state as ProviderCapacityState,
      ) ||
      (item.capacity.limit !== null &&
        (!nat(item.capacity.limit) || Number(item.capacity.limit) === 0)) ||
      (item.capacity.remaining !== null && !nat(item.capacity.remaining)) ||
      !nat(item.capacity.reserve) ||
      (item.capacity.resetsAt !== null && !iso(item.capacity.resetsAt)) ||
      !["none", "limited", "suppressed"].includes(
        String(item.recommendationImpact),
      )
    )
      throw new Error("provider-status-scope-invalid");
    const capacityKnown =
      item.capacity.limit !== null &&
      item.capacity.remaining !== null &&
      item.capacity.resetsAt !== null;
    const expectedSafeReason =
      item.connection === "partial"
        ? "partial-data"
        : item.connection === "stale"
          ? "stale-data"
          : item.connection === "outage"
            ? "provider-unavailable"
            : item.connection === "unknown"
              ? "telemetry-unavailable"
              : "none";
    const checked = item.lastCheckedAt ? Date.parse(item.lastCheckedAt) : null;
    const successful = item.lastSuccessfulAt
      ? Date.parse(item.lastSuccessfulAt)
      : null;
    const expectedAge =
      successful === null
        ? null
        : Math.min(
            31_536_000,
            Math.max(0, Math.floor((snapshot - successful) / 1_000)),
          );
    const expectedCapacityState = capacityKnown
      ? providerCapacityStateFor(
          Number(item.capacity.remaining),
          Number(item.capacity.reserve),
        )
      : "unknown";
    const expectedImpact = providerRecommendationImpactFor(
      item.capability as ProviderStatusCapability,
      item.connection as ProviderConnectionState,
      item.capacity.state as ProviderCapacityState,
    );
    if (
      (checked !== null && checked > snapshot) ||
      (successful !== null && successful > snapshot) ||
      (successful !== null && (checked === null || successful > checked)) ||
      (item.retryAt !== null && Date.parse(item.retryAt) <= snapshot) ||
      (item.capacity.limit !== null &&
        item.capacity.remaining !== null &&
        Number(item.capacity.remaining) > Number(item.capacity.limit)) ||
      (item.capacity.state === "unknown") === capacityKnown ||
      (capacityKnown &&
        Date.parse(String(item.capacity.resetsAt)) <= snapshot) ||
      item.safeReason !== expectedSafeReason ||
      item.freshness.ageSeconds !== expectedAge ||
      item.capacity.state !== expectedCapacityState ||
      item.recommendationImpact !== expectedImpact
    )
      throw new Error("provider-status-chronology-invalid");
    return Object.freeze({
      ...item,
      supportedData: Object.freeze(item.supportedData.map(String)),
      freshness: Object.freeze({ ...item.freshness }),
      capacity: Object.freeze({ ...item.capacity }),
    }) as ProviderStatusScopeDto;
  });
  if (
    new Set(items.map(({ scopeId }) => scopeId)).size !== items.length ||
    items.some(
      (item, index) => index > 0 && items[index - 1]!.scopeId >= item.scopeId,
    )
  )
    throw new Error("provider-status-order-invalid");
  const counts = Object.fromEntries(
    providerConnectionStates.map((state) => [
      state,
      items.filter((item) => item.connection === state).length,
    ]),
  ) as Record<ProviderConnectionState, number>;
  const summary = value.summary;
  const hasUnknown = items.some((item) => item.connection === "unknown");
  if (
    summary["total"] !== items.length ||
    providerConnectionStates.some(
      (state) => summary[state] !== counts[state],
    ) ||
    summary["impacted"] !==
      items.filter((item) => item.recommendationImpact !== "none").length ||
    (value.evaluationState === "partial") !== hasUnknown
  )
    throw new Error("provider-status-summary-invalid");
  return Object.freeze({
    schemaVersion: "provider-status-page-v1",
    snapshotAt: value.snapshotAt,
    evaluationState:
      value.evaluationState === "complete" ? "complete" : "partial",
    summary: Object.freeze({
      total: Number(summary["total"]),
      healthy: Number(summary["healthy"]),
      partial: Number(summary["partial"]),
      stale: Number(summary["stale"]),
      outage: Number(summary["outage"]),
      unknown: Number(summary["unknown"]),
      impacted: Number(summary["impacted"]),
    }),
    items: Object.freeze(items),
  });
}
