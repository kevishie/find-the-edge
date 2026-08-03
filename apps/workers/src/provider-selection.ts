export type OddsProviderMode = "primary" | "secondary" | "shadow";
export interface OddsProviderPolicyEntry {
  readonly providerId: string;
  readonly mode: OddsProviderMode;
  readonly enabled: boolean;
  readonly failoverEligible: boolean;
  readonly quotaReserve: number;
  readonly cooldownSeconds: number;
  readonly recoverySuccesses: number;
}
export interface OddsProviderRuntimeState {
  readonly providerId: string;
  readonly healthy: boolean;
  readonly quotaRemaining?: number;
  readonly cooldownUntil?: string;
  readonly consecutiveSuccesses: number;
  readonly coverageAvailable: boolean;
}
export interface OddsProviderSelection {
  readonly attemptedProviders: readonly string[];
  readonly selectedProviderId?: string;
  readonly reason:
    | "primary"
    | "primary-unavailable"
    | "primary-cooldown"
    | "primary-quota"
    | "coverage-missing"
    | "unavailable";
  readonly shadowProviderIds: readonly string[];
}

export function selectOddsProvider(
  policy: readonly OddsProviderPolicyEntry[],
  state: readonly OddsProviderRuntimeState[],
  now: Date,
): OddsProviderSelection {
  const enabled = policy.filter(({ enabled }) => enabled);
  const primaries = enabled.filter(({ mode }) => mode === "primary");
  if (
    primaries.length !== 1 ||
    new Set(enabled.map(({ providerId }) => providerId)).size !== enabled.length
  )
    throw new Error("provider-policy-invalid");
  const byId = new Map(state.map((item) => [item.providerId, item]));
  const attempted: string[] = [];
  let failure: OddsProviderSelection["reason"] = "unavailable";
  const candidates = [
    primaries[0]!,
    ...enabled.filter(
      ({ mode, failoverEligible }) => mode === "secondary" && failoverEligible,
    ),
  ];
  for (const candidate of candidates) {
    attempted.push(candidate.providerId);
    const current = byId.get(candidate.providerId);
    if (!current?.coverageAvailable) {
      failure = "coverage-missing";
      continue;
    }
    if (
      current.cooldownUntil &&
      Date.parse(current.cooldownUntil) > now.getTime()
    ) {
      failure = candidate.mode === "primary" ? "primary-cooldown" : failure;
      continue;
    }
    if (
      current.quotaRemaining !== undefined &&
      current.quotaRemaining <= candidate.quotaReserve
    ) {
      failure = candidate.mode === "primary" ? "primary-quota" : failure;
      continue;
    }
    if (!current.healthy) {
      failure = candidate.mode === "primary" ? "primary-unavailable" : failure;
      continue;
    }
    if (
      candidate.mode === "primary" &&
      current.consecutiveSuccesses < candidate.recoverySuccesses
    ) {
      failure = "primary-unavailable";
      continue;
    }
    return {
      attemptedProviders: attempted,
      selectedProviderId: candidate.providerId,
      reason: candidate.mode === "primary" ? "primary" : failure,
      shadowProviderIds: enabled
        .filter(({ mode }) => mode === "shadow")
        .map(({ providerId }) => providerId),
    };
  }
  return {
    attemptedProviders: attempted,
    reason: failure,
    shadowProviderIds: enabled
      .filter(({ mode }) => mode === "shadow")
      .map(({ providerId }) => providerId),
  };
}

export function comparisonBookKey(input: {
  readonly sportsbookId: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly point?: number;
}) {
  return JSON.stringify([
    input.sportsbookId,
    input.marketKey,
    input.selectionKey,
    input.point ?? null,
  ]);
}
