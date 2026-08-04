import {
  defaultFeedCoveragePolicies,
  feedCoverageCatalogVersion,
} from "@find-the-edge/config";
import type {
  FeedCapability,
  FeedCoverageRegistration,
  FeedCoverageReport,
  FeedCoverageRequest,
  FeedCoverageResolution,
  FeedUnsupportedReason,
  LeagueAllowlistState,
  SportKey,
} from "@find-the-edge/domain";
import type { LoggerPort } from "@find-the-edge/observability";

import type { ProviderDescriptor } from "./index";

export class CoverageRegistryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid feed coverage registry: ${message}`);
    this.name = "CoverageRegistryValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;
const feedCapabilities = ["schedule", "odds", "results"] as const;
const allowlistStates = ["enabled", "planned", "disabled"] as const;
const maturities = ["development", "production"] as const;
const cadenceModes = ["interval", "manual"] as const;
const reasons = [
  "league-planned",
  "league-disabled",
  "capability-unavailable",
] as const;
const providerCapabilities = [
  "odds",
  "schedule",
  "stats",
  "injury",
  "lineup",
  "weather",
  "public-betting",
  "results",
] as const;
const qualityTiers = ["unknown", "development", "standard", "premium"] as const;

function asRecord(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoverageRegistryValidationError(`${field} must be an object`);
  }
  return value as UnknownRecord;
}

function asCanonicalString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new CoverageRegistryValidationError(
      `${field} must be a trimmed nonblank string`,
    );
  }
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CoverageRegistryValidationError(
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CoverageRegistryValidationError(`${field} must be boolean`);
  }
  return value;
}

function asInteger(value: unknown, field: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new CoverageRegistryValidationError(
      `${field} must be a safe integer >= ${minimum}`,
    );
  }
  return value;
}

function asStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new CoverageRegistryValidationError(`${field} must be an array`);
  }
  const result = value.map((item, index) =>
    asCanonicalString(item, `${field}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new CoverageRegistryValidationError(`${field} must be unique`);
  }
  return result;
}

function validatePolicy(input: unknown): FeedCoverageRegistration {
  const policy = asRecord(input, "policy");
  asCanonicalString(policy["sportKey"], "policy.sportKey");
  asCanonicalString(policy["leagueKey"], "policy.leagueKey");
  asCanonicalString(policy["leagueName"], "policy.leagueName");
  const capability = asEnum(
    policy["capability"],
    feedCapabilities,
    "policy.capability",
  );
  const state = asEnum(
    policy["allowlistState"],
    allowlistStates,
    "policy.allowlistState",
  );
  const active = asBoolean(policy["active"], "policy.active");
  const markets = asStrings(
    policy["supportedMarketKeys"],
    "policy.supportedMarketKeys",
  );
  if (!active) {
    if (state === "enabled") {
      throw new CoverageRegistryValidationError(
        "An explicitly enabled policy must be active",
      );
    }
    if (markets.length > 0) {
      throw new CoverageRegistryValidationError(
        "Inactive coverage cannot declare markets",
      );
    }
    for (const field of [
      "providerId",
      "maturity",
      "cadence",
      "quotaEstimate",
    ]) {
      if (policy[field] !== undefined) {
        throw new CoverageRegistryValidationError(
          `Inactive coverage cannot declare ${field}`,
        );
      }
    }
    const reason = asEnum(
      policy["unsupportedReason"],
      reasons,
      "policy.unsupportedReason",
    );
    const expected =
      state === "planned"
        ? "league-planned"
        : state === "disabled"
          ? "league-disabled"
          : "capability-unavailable";
    if (reason !== expected) {
      throw new CoverageRegistryValidationError(
        `${state} coverage requires ${expected}`,
      );
    }
    return input as FeedCoverageRegistration;
  }
  if (state !== "enabled") {
    throw new CoverageRegistryValidationError(
      "Active coverage must be enabled",
    );
  }
  if (policy["unsupportedReason"] !== undefined) {
    throw new CoverageRegistryValidationError(
      "Active coverage cannot declare unsupportedReason",
    );
  }
  asCanonicalString(policy["providerId"], "policy.providerId");
  asEnum(policy["maturity"], maturities, "policy.maturity");
  const cadence = asRecord(policy["cadence"], "policy.cadence");
  const mode = asEnum(cadence["mode"], cadenceModes, "policy.cadence.mode");
  if (mode === "interval") {
    asInteger(cadence["seconds"], "policy.cadence.seconds", 1);
  } else if (cadence["seconds"] !== undefined) {
    throw new CoverageRegistryValidationError(
      "Manual cadence cannot specify seconds",
    );
  }
  const quota = asRecord(policy["quotaEstimate"], "policy.quotaEstimate");
  asInteger(quota["requestsPerRun"], "policy.quotaEstimate.requestsPerRun", 0);
  asInteger(quota["requestsPerDay"], "policy.quotaEstimate.requestsPerDay", 0);
  if (capability === "odds" && markets.length === 0) {
    throw new CoverageRegistryValidationError(
      "Active odds coverage requires markets",
    );
  }
  if (capability !== "odds" && markets.length > 0) {
    throw new CoverageRegistryValidationError(
      "Non-odds coverage cannot declare markets",
    );
  }
  return input as FeedCoverageRegistration;
}

function validateDescriptor(input: unknown): ProviderDescriptor {
  const descriptor = asRecord(input, "provider");
  asCanonicalString(descriptor["id"], "provider.id");
  asCanonicalString(descriptor["displayName"], "provider.displayName");
  if (
    !Array.isArray(descriptor["capabilities"]) ||
    descriptor["capabilities"].length === 0
  ) {
    throw new CoverageRegistryValidationError(
      "provider.capabilities must be a nonempty array",
    );
  }
  const capabilities = descriptor["capabilities"].map((item, index) =>
    asEnum(item, providerCapabilities, `provider.capabilities[${index}]`),
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new CoverageRegistryValidationError(
      "provider.capabilities must be unique",
    );
  }
  asEnum(descriptor["qualityTier"], qualityTiers, "provider.qualityTier");
  asInteger(
    descriptor["expectedFreshnessSeconds"],
    "provider.expectedFreshnessSeconds",
    1,
  );
  if (descriptor["rateLimit"] !== undefined) {
    const rate = asRecord(descriptor["rateLimit"], "provider.rateLimit");
    asInteger(rate["requests"], "provider.rateLimit.requests", 1);
    asInteger(rate["windowSeconds"], "provider.rateLimit.windowSeconds", 1);
  }
  const coverage = asRecord(descriptor["coverage"], "provider.coverage");
  if (!Array.isArray(coverage["leagues"]) || coverage["leagues"].length === 0) {
    throw new CoverageRegistryValidationError(
      "provider.coverage.leagues must be a nonempty array",
    );
  }
  const pairs = new Map<string, Set<string>>();
  const pairCapabilityUnion = new Set<string>();
  for (const [index, item] of coverage["leagues"].entries()) {
    const pair = asRecord(item, `provider.coverage.leagues[${index}]`);
    const sportKey = asCanonicalString(
      pair["sportKey"],
      `provider.coverage.leagues[${index}].sportKey`,
    );
    const leagueKey = asCanonicalString(
      pair["leagueKey"],
      `provider.coverage.leagues[${index}].leagueKey`,
    );
    const markets = asStrings(
      pair["marketKeys"],
      `provider.coverage.leagues[${index}].marketKeys`,
    );
    if (
      !Array.isArray(pair["capabilities"]) ||
      pair["capabilities"].length === 0
    ) {
      throw new CoverageRegistryValidationError(
        `provider.coverage.leagues[${index}].capabilities must be a nonempty array`,
      );
    }
    const pairCapabilities = pair["capabilities"].map((item, itemIndex) =>
      asEnum(
        item,
        providerCapabilities,
        `provider.coverage.leagues[${index}].capabilities[${itemIndex}]`,
      ),
    );
    if (new Set(pairCapabilities).size !== pairCapabilities.length) {
      throw new CoverageRegistryValidationError(
        `provider.coverage.leagues[${index}].capabilities must be unique`,
      );
    }
    for (const capability of pairCapabilities) {
      pairCapabilityUnion.add(capability);
    }
    if (pairCapabilities.includes("odds") && markets.length === 0) {
      throw new CoverageRegistryValidationError(
        "Each odds provider league requires market coverage",
      );
    }
    if (!pairCapabilities.includes("odds") && markets.length > 0) {
      throw new CoverageRegistryValidationError(
        "Provider pairs without odds cannot declare markets",
      );
    }
    let leagues = pairs.get(sportKey);
    if (!leagues) {
      leagues = new Set();
      pairs.set(sportKey, leagues);
    }
    if (leagues.has(leagueKey)) {
      throw new CoverageRegistryValidationError(
        `Duplicate provider coverage pair: ${sportKey}/${leagueKey}`,
      );
    }
    leagues.add(leagueKey);
  }
  const declaredCapabilities = new Set(capabilities);
  if (
    declaredCapabilities.size !== pairCapabilityUnion.size ||
    [...declaredCapabilities].some(
      (capability) => !pairCapabilityUnion.has(capability),
    )
  ) {
    throw new CoverageRegistryValidationError(
      "provider.capabilities must equal the union of league-pair capabilities",
    );
  }
  return input as ProviderDescriptor;
}

function validateRequest(input: unknown): FeedCoverageRequest {
  const request = asRecord(input, "request");
  asCanonicalString(request["sportKey"], "request.sportKey");
  asCanonicalString(request["leagueKey"], "request.leagueKey");
  const capability = asEnum(
    request["capability"],
    feedCapabilities,
    "request.capability",
  );
  const markets =
    request["marketKeys"] === undefined
      ? undefined
      : asStrings(request["marketKeys"], "request.marketKeys");
  if (capability !== "odds" && (markets?.length ?? 0) > 0) {
    throw new CoverageRegistryValidationError(
      "Non-odds requests cannot include market filters",
    );
  }
  const sportKey = request["sportKey"] as SportKey;
  const canonicalMarkets = markets
    ? [
        ...new Set(
          markets.map((market) =>
            sportKey === ("mlb" as SportKey) && market === "run_line"
              ? "spread"
              : sportKey === ("soccer" as SportKey) &&
                  market === "three_way_moneyline"
                ? "moneyline"
                : market,
          ),
        ),
      ]
    : undefined;
  return {
    sportKey,
    leagueKey: request["leagueKey"] as string,
    capability,
    ...(canonicalMarkets ? { marketKeys: canonicalMarkets } : {}),
  };
}

function clonePolicy(
  policy: FeedCoverageRegistration,
): FeedCoverageRegistration {
  return {
    ...policy,
    supportedMarketKeys: [...policy.supportedMarketKeys],
    ...(policy.active
      ? {
          cadence: { ...policy.cadence },
          quotaEstimate: { ...policy.quotaEstimate },
        }
      : {}),
  } as FeedCoverageRegistration;
}

function cloneDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return {
    ...descriptor,
    capabilities: [...descriptor.capabilities],
    coverage: {
      leagues: descriptor.coverage.leagues.map((pair) => ({
        ...pair,
        capabilities: [...pair.capabilities],
        marketKeys: [...pair.marketKeys],
      })),
    },
    ...(descriptor.rateLimit ? { rateLimit: { ...descriptor.rateLimit } } : {}),
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface LeagueMetadata {
  leagueName: string;
  allowlistState: LeagueAllowlistState;
}

export class FeedCoverageRegistry {
  readonly #version: string;
  readonly #policies: readonly FeedCoverageRegistration[];
  readonly #index = new Map<
    SportKey,
    Map<string, Map<FeedCapability, FeedCoverageRegistration>>
  >();
  readonly #metadata = new Map<SportKey, Map<string, LeagueMetadata>>();
  readonly #logger: LoggerPort | undefined;

  constructor(
    version: string,
    policies: readonly FeedCoverageRegistration[],
    descriptors: readonly ProviderDescriptor[],
    logger?: LoggerPort,
  ) {
    this.#version = asCanonicalString(version, "version");
    if (!Array.isArray(policies) || !Array.isArray(descriptors)) {
      throw new CoverageRegistryValidationError(
        "policies and descriptors must be arrays",
      );
    }
    const providers = new Map<string, ProviderDescriptor>();
    for (const input of descriptors as readonly unknown[]) {
      const descriptor = cloneDescriptor(validateDescriptor(input));
      if (providers.has(descriptor.id)) {
        throw new CoverageRegistryValidationError(
          `Duplicate provider descriptor: ${descriptor.id}`,
        );
      }
      providers.set(descriptor.id, descriptor);
    }
    const snapshots: FeedCoverageRegistration[] = [];
    for (const input of policies as readonly unknown[]) {
      const policy = clonePolicy(validatePolicy(input));
      if (policy.active) {
        const provider = providers.get(policy.providerId);
        if (!provider) {
          throw new CoverageRegistryValidationError(
            `Provider is not registered: ${policy.providerId}`,
          );
        }
        const pair = provider.coverage.leagues.find(
          (item) =>
            item.sportKey === policy.sportKey &&
            item.leagueKey === policy.leagueKey,
        );
        if (!pair) {
          throw new CoverageRegistryValidationError(
            `Provider does not cover exact pair ${policy.sportKey}/${policy.leagueKey}`,
          );
        }
        if (!pair.capabilities.includes(policy.capability)) {
          throw new CoverageRegistryValidationError(
            `Provider pair does not support capability ${policy.capability}`,
          );
        }
        for (const market of policy.supportedMarketKeys) {
          if (!pair.marketKeys.includes(market)) {
            throw new CoverageRegistryValidationError(
              `Provider pair does not cover market ${market}`,
            );
          }
        }
      }
      let leagues = this.#index.get(policy.sportKey);
      if (!leagues) {
        leagues = new Map();
        this.#index.set(policy.sportKey, leagues);
      }
      let capabilities = leagues.get(policy.leagueKey);
      if (!capabilities) {
        capabilities = new Map();
        leagues.set(policy.leagueKey, capabilities);
      }
      if (capabilities.has(policy.capability)) {
        throw new CoverageRegistryValidationError(
          `Duplicate coverage policy: ${policy.sportKey}/${policy.leagueKey}/${policy.capability}`,
        );
      }
      capabilities.set(policy.capability, policy);

      let sportMetadata = this.#metadata.get(policy.sportKey);
      if (!sportMetadata) {
        sportMetadata = new Map();
        this.#metadata.set(policy.sportKey, sportMetadata);
      }
      const existing = sportMetadata.get(policy.leagueKey);
      if (existing && existing.leagueName !== policy.leagueName) {
        throw new CoverageRegistryValidationError("Inconsistent league name");
      }
      if (existing && existing.allowlistState !== policy.allowlistState) {
        throw new CoverageRegistryValidationError(
          "Inconsistent allowlist state",
        );
      }
      if (!existing) {
        sportMetadata.set(policy.leagueKey, {
          leagueName: policy.leagueName,
          allowlistState: policy.allowlistState,
        });
      }
      snapshots.push(policy);
    }
    this.#policies = snapshots;
    this.#logger = logger;
  }

  resolve(input: FeedCoverageRequest): FeedCoverageResolution {
    const request = validateRequest(input);
    const league = this.#index.get(request.sportKey)?.get(request.leagueKey);
    const policy = league?.get(request.capability);
    let result: FeedCoverageResolution;
    if (
      policy?.active &&
      (request.marketKeys ?? []).every((market) =>
        (policy.supportedMarketKeys as readonly string[]).includes(market),
      )
    ) {
      result = deepFreeze({
        supported: true,
        sportKey: policy.sportKey,
        leagueKey: policy.leagueKey,
        capability: policy.capability,
        providerId: policy.providerId,
        maturity: policy.maturity,
        cadence: { ...policy.cadence },
        supportedMarketKeys: [...policy.supportedMarketKeys],
        quotaEstimate: { ...policy.quotaEstimate },
      });
    } else {
      const reason: FeedUnsupportedReason = !league
        ? "league-unregistered"
        : policy?.active
          ? "market-unsupported"
          : (policy?.unsupportedReason ?? "capability-unavailable");
      result = deepFreeze({
        supported: false,
        sportKey: request.sportKey,
        leagueKey: request.leagueKey,
        capability: request.capability,
        reason,
        ...(league
          ? {
              allowlistState: this.#metadata
                .get(request.sportKey)!
                .get(request.leagueKey)!.allowlistState,
            }
          : {}),
      });
    }
    try {
      this.#logger?.info("Feed coverage resolved", {
        correlationId: `coverage:${JSON.stringify([
          request.sportKey,
          request.leagueKey,
          request.capability,
        ])}`,
        sportKey: request.sportKey,
        leagueKey: request.leagueKey,
        capability: request.capability,
        ...(result.supported
          ? { providerId: result.providerId }
          : { reason: result.reason }),
      });
    } catch {
      // Telemetry cannot affect deterministic resolution.
    }
    return result;
  }

  report(): FeedCoverageReport {
    const entries = this.#policies
      .map((policy) => ({
        sportKey: policy.sportKey,
        leagueKey: policy.leagueKey,
        leagueName: policy.leagueName,
        capability: policy.capability,
        allowlistState: policy.allowlistState,
        supported: policy.active,
        supportedMarketKeys: [...policy.supportedMarketKeys].sort(compareText),
        ...(policy.active
          ? {
              providerId: policy.providerId,
              maturity: policy.maturity,
              cadence: { ...policy.cadence },
              quotaEstimate: { ...policy.quotaEstimate },
            }
          : { reason: policy.unsupportedReason }),
      }))
      .sort((left, right) => {
        for (const [a, b] of [
          [left.sportKey, right.sportKey],
          [left.leagueKey, right.leagueKey],
          [left.capability, right.capability],
        ] as const) {
          const result = compareText(a, b);
          if (result !== 0) return result;
        }
        return 0;
      });
    return deepFreeze({ version: this.#version, entries });
  }
}

export const fixtureDevelopmentProvider: ProviderDescriptor = deepFreeze({
  id: "fixture-development",
  displayName: "Fixture Development Provider",
  capabilities: ["schedule", "odds", "results"],
  coverage: {
    leagues: [
      {
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        capabilities: ["schedule", "odds", "results"],
        marketKeys: ["moneyline", "spread"],
      },
      {
        sportKey: "soccer" as SportKey,
        leagueKey: "mls",
        capabilities: ["schedule", "odds", "results"],
        marketKeys: ["moneyline", "spread"],
      },
    ],
  },
  rateLimit: { requests: 1000, windowSeconds: 86400 },
  expectedFreshnessSeconds: 900,
  qualityTier: "development",
});

export const defaultFeedCoverageRegistry = new FeedCoverageRegistry(
  feedCoverageCatalogVersion,
  defaultFeedCoveragePolicies,
  [fixtureDevelopmentProvider],
);
