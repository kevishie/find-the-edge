import type { LeagueOddsCollectionPolicy } from "@find-the-edge/config";
import { randomUUID } from "node:crypto";
import { oddsCollectionPolicyVersion } from "@find-the-edge/config";
import type { OddsEvidenceGap } from "@find-the-edge/domain";
import type {
  OddsControlPlaneStore,
  OddsProviderHealth,
  OddsRunContinuation,
  OddsRunRecord,
} from "@find-the-edge/database";

const putContinuationCas = async (
  store: OddsControlPlaneStore,
  value: OddsRunContinuation,
) => {
  for (let retry = 0; retry < 8; retry += 1) {
    const current = await store.getContinuation(value.leagueKey);
    if (current && current.runId !== value.runId)
      throw new Error("continuation-transition-conflict");
    if (
      value.ambiguousUntil &&
      (!current || !value.ownerId || current.ownerId !== value.ownerId)
    )
      throw new Error("continuation-transition-conflict");
    const { version: staleVersion, ...patch } = value;
    void staleVersion;
    try {
      await store.putContinuation({
        ...current,
        ...patch,
        ...(current?.ambiguousUntil
          ? { ambiguousUntil: current.ambiguousUntil }
          : {}),
        ...(current?.version === undefined ? {} : { version: current.version }),
      });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/continuation-transition-conflict/.test(error.message)
      )
        throw error;
    }
  }
  throw new Error("continuation-transition-conflict");
};

const clearOwnedContinuation = async (
  store: OddsControlPlaneStore,
  leagueKey: string,
  runId: string,
  ownerId: string,
) => {
  const current = await store.getContinuation(leagueKey);
  if (!current) return;
  if (current.runId !== runId || current.ownerId !== ownerId)
    throw new Error("continuation-transition-conflict");
  await store.clearContinuation(leagueKey, runId, ownerId, current.version);
};

export interface NormalizedOddsPage {
  readonly items: readonly unknown[];
  readonly gaps: readonly OddsEvidenceGap[];
  readonly nextPageToken?: string;
  readonly quotaCost: number;
  readonly quotaRemaining?: number;
  readonly rateWindow?: {
    readonly limit?: number;
    readonly remaining?: number;
    readonly resetsAt?: string;
  };
  readonly digest: string;
  readonly seenProviderEventIds?: readonly string[];
}
export async function withPaidLeaseHeartbeat<T>(
  call: () => Promise<T>,
  heartbeat: () => Promise<void>,
  intervalMs = 30_000,
): Promise<T> {
  let leaseFailure: unknown;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    if (leaseFailure) return;
    renewal = renewal.then(async () => {
      if (leaseFailure) return;
      try {
        await heartbeat();
      } catch (error) {
        leaseFailure = error;
      }
    });
  }, intervalMs);
  try {
    const response = await call();
    clearInterval(timer);
    await renewal;
    if (leaseFailure) throw new Error("run-owned");
    return response;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}
export interface ControlPlaneProvider {
  readonly providerId: string;
  readonly requestCost?: number;
  fetchPage(input: {
    readonly runId: string;
    readonly leagueKey: string;
    readonly pageToken: string;
  }): Promise<NormalizedOddsPage>;
  probe?(): Promise<{
    readonly quotaCost: number;
    readonly quotaRemaining?: number;
    readonly rateWindow?: NormalizedOddsPage["rateWindow"];
  }>;
  reconcileMissing?(input: {
    readonly runId: string;
    readonly seenProviderEventIds: ReadonlySet<string>;
  }): Promise<readonly OddsEvidenceGap[]>;
}
export interface OddsPageCommitter {
  /** Must enforce exact mapping, canonical version, status and pregame start fences. */
  commit(input: {
    readonly runId: string;
    readonly providerId: string;
    readonly leagueKey: string;
    readonly items: readonly unknown[];
  }): Promise<boolean | void>;
}
export interface OddsControlPlaneMetrics {
  emit(
    name: string,
    value: number,
    dimensions: Readonly<Record<string, string>>,
  ): void;
}
export const embeddedOddsControlPlaneMetrics: OddsControlPlaneMetrics = {
  emit(name, value, dimensions) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) || !Number.isFinite(value))
      throw new Error("odds-metric-invalid");
    const bounded = Object.fromEntries(
      Object.entries(dimensions)
        .filter(
          ([key, item]) =>
            /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key) &&
            item.length > 0 &&
            item.length <= 128,
        )
        .slice(0, 8),
    );
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/OddsControlPlane",
              Dimensions: [Object.keys(bounded)],
              Metrics: [{ Name: name, Unit: "Count" }],
            },
          ],
        },
        ...bounded,
        [name]: value,
      })}\n`,
    );
  },
};
export interface OddsLeagueRunResult {
  readonly leagueKey: string;
  readonly status: "completed" | "skipped" | "failed";
  readonly providerId?: string;
  readonly reason?: string;
  readonly pages: number;
  readonly quotaCost: number;
}

export function deduplicateProviderBookEvidence<
  T extends {
    readonly providerId: string;
    readonly sportsbookId: string;
    readonly marketKey: string;
    readonly selectionKey: string;
    readonly point?: number;
  },
>(items: readonly T[], providerPriority: readonly string[]): readonly T[] {
  const rank = new Map(providerPriority.map((id, index) => [id, index]));
  const selected = new Map<string, T>();
  for (const item of items) {
    const identity = JSON.stringify([
      item.sportsbookId,
      item.marketKey,
      item.selectionKey,
      item.point ?? null,
    ]);
    const current = selected.get(identity);
    if (
      !current ||
      (rank.get(item.providerId) ?? Number.MAX_SAFE_INTEGER) <
        (rank.get(current.providerId) ?? Number.MAX_SAFE_INTEGER)
    )
      selected.set(identity, item);
  }
  return [...selected.values()];
}

const iso = (d: Date) => d.toISOString();
const attemptLeaseUntil = (d: Date) =>
  new Date(d.getTime() + 5 * 60_000).toISOString();
export const oddsHealthKey = (
  providerId: string,
  leagueKey: string,
  capability = "odds",
) => `${providerId}:${leagueKey}:${capability}`;
const dueAt = (
  policy: LeagueOddsCollectionPolicy,
  now: Date,
  nextStart?: string,
) => {
  const near =
    nextStart !== undefined &&
    Date.parse(nextStart) > now.getTime() &&
    Date.parse(nextStart) - now.getTime() <=
      policy.nearStart.windowSeconds * 1000;
  return new Date(
    now.getTime() +
      (near ? policy.nearStart.cadenceSeconds : policy.baseCadenceSeconds) *
        1000,
  ).toISOString();
};
const SAFE_FAILURES = [
  "provider-unavailable",
  "rate-limited",
  "not-entitled",
  "coverage-missing",
  "unauthorized",
  "invalid-response",
  "configuration",
  "page-limit-exceeded",
  "provider-page-material-mismatch",
  "provider-request-ambiguous",
  "provider-response-unsealed",
  "quota-reserve",
  "provider-cooldown",
  "provider-recovering",
  "schedule-dependency-failed",
  "mapping-quarantine",
  "pagination-invalid",
  "transition-conflict",
  "stored-event-conflict",
  "conflict-metric-pending",
  "storage-validation",
  "storage-resource-missing",
  "storage-access-denied",
  "storage-throttled",
  "storage-transaction-cancelled",
  "storage-transaction-in-progress",
  "storage-unavailable",
  "sharpapi-odds-mapping-no-candidate",
  "sharpapi-odds-mapping-ambiguous-candidates",
  "sharpapi-event-binding-unavailable",
] as const;
const SAFE_STORAGE_FAILURES = new Map<string, string>([
  ["ValidationException", "storage-validation"],
  ["ResourceNotFoundException", "storage-resource-missing"],
  ["AccessDeniedException", "storage-access-denied"],
  ["ProvisionedThroughputExceededException", "storage-throttled"],
  ["ThrottlingException", "storage-throttled"],
  ["RequestLimitExceeded", "storage-throttled"],
  ["TransactionCanceledException", "storage-transaction-cancelled"],
  ["TransactionInProgressException", "storage-transaction-in-progress"],
  ["InternalServerError", "storage-unavailable"],
  ["ServiceUnavailable", "storage-unavailable"],
]);
export const classifyOddsControlPlaneFailure = (error: unknown) => {
  if (!(error instanceof Error)) return "internal-failure";
  const storageFailure = SAFE_STORAGE_FAILURES.get(error.name);
  if (storageFailure) return storageFailure;
  if (error.message === "run-owned") return "provider-recovering";
  if (error.message === "page-limit-exceeded") return "pagination-invalid";
  if (error.message === "sealed-page-conflict")
    return "provider-response-unsealed";
  if (SAFE_FAILURES.includes(error.message as never)) return error.message;
  if (error.message.includes("transition-conflict"))
    return "transition-conflict";
  if (error.message.includes("pagination")) return "pagination-invalid";
  if (error.message.includes("mapping")) return "mapping-quarantine";
  if (error.message.includes("provider")) return "provider-error";
  return "internal-failure";
};
const ambiguousTransport = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" ||
    /timeout|timed out|socket|network|econn|ambiguous|run-owned/i.test(
      error.message,
    ));
export type OddsFailureClass = "transient" | "terminal" | "ambiguous";
export interface OddsRetryDecision {
  readonly class: OddsFailureClass;
  readonly action: "retry" | "stop" | "reconcile" | "exhausted";
  readonly retryAt?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: string;
}

const TRANSIENT_FAILURES = new Set([
  "provider-unavailable",
  "rate-limited",
  "provider-cooldown",
  "quota-reserve",
  "conflict-metric-pending",
]);
const TERMINAL_FAILURES = new Set([
  "unauthorized",
  "not-entitled",
  "configuration",
  "invalid-response",
  "coverage-missing",
  "mapping-quarantine",
  "pagination-invalid",
  "stored-event-conflict",
]);

/** One retry policy for every SharpAPI operation. Delay is bounded even when
 * the provider sends a pathological value; jitter is injectable for tests. */
export const decideOddsRetry = (input: {
  readonly error: unknown;
  readonly attempt: number;
  readonly now: Date;
  readonly providerRetryAt?: string;
  readonly maxAttempts?: number;
  readonly jitter?: () => number;
}): OddsRetryDecision => {
  const maxAttempts = Math.max(1, Math.min(5, input.maxAttempts ?? 5));
  const reason = classifyOddsControlPlaneFailure(input.error);
  if (
    ambiguousTransport(input.error) ||
    reason === "provider-request-ambiguous"
  )
    return {
      class: "ambiguous",
      action: input.attempt >= maxAttempts ? "exhausted" : "reconcile",
      attempt: input.attempt,
      maxAttempts,
      reason: "provider-request-ambiguous",
    };
  if (TERMINAL_FAILURES.has(reason) || !TRANSIENT_FAILURES.has(reason))
    return {
      class: "terminal",
      action: "stop",
      attempt: input.attempt,
      maxAttempts,
      reason,
    };
  if (input.attempt >= maxAttempts)
    return {
      class: "transient",
      action: "exhausted",
      attempt: input.attempt,
      maxAttempts,
      reason,
    };
  const providerMs = input.providerRetryAt
    ? Date.parse(input.providerRetryAt)
    : Number.NaN;
  const exponentialMs = Math.min(60_000, 1_000 * 2 ** (input.attempt - 1));
  const jitterMs = Math.floor(
    Math.max(0, Math.min(1, input.jitter?.() ?? Math.random())) * 1_000,
  );
  const retryMs = Math.min(
    input.now.getTime() + 15 * 60_000,
    Math.max(
      input.now.getTime() + exponentialMs + jitterMs,
      Number.isFinite(providerMs) ? providerMs : 0,
    ),
  );
  return {
    class: "transient",
    action: "retry",
    retryAt: new Date(retryMs).toISOString(),
    attempt: input.attempt,
    maxAttempts,
    reason,
  };
};

export const healthyOddsProviderState = (
  current: OddsProviderHealth | null,
  input: {
    readonly providerId: string;
    readonly healthKey: string;
    readonly updatedAt: string;
    readonly consecutiveSuccesses: number;
  },
) => {
  const retained: {
    -readonly [K in keyof OddsProviderHealth]?: OddsProviderHealth[K];
  } = { ...(current ?? {}) };
  delete retained.failureClass;
  delete retained.failureReason;
  delete retained.retryAt;
  delete retained.expiresAt;
  delete retained.cooldownUntil;
  delete retained.degraded;
  delete retained.degradedReason;
  delete retained.degradedCount;
  return {
    ...retained,
    ...input,
    healthy: true as const,
    status: "healthy" as const,
  };
};

export const unhealthyOddsProviderState = (
  current: OddsProviderHealth | null,
  input: {
    readonly providerId: string;
    readonly healthKey: string;
    readonly now: Date;
    readonly decision: OddsRetryDecision;
    readonly cooldownSeconds: number;
  },
) => {
  const fallbackRetryAt = new Date(
    input.now.getTime() + input.cooldownSeconds * 1_000,
  ).toISOString();
  const retryAt =
    input.decision.class === "transient"
      ? (input.decision.retryAt ?? fallbackRetryAt)
      : undefined;
  const retained: {
    -readonly [K in keyof OddsProviderHealth]?: OddsProviderHealth[K];
  } = { ...(current ?? {}) };
  delete retained.expiresAt;
  delete retained.retryAt;
  delete retained.cooldownUntil;
  delete retained.degraded;
  delete retained.degradedReason;
  delete retained.degradedCount;
  return {
    ...retained,
    providerId: input.providerId,
    healthKey: input.healthKey,
    healthy: false as const,
    status: "unhealthy" as const,
    consecutiveSuccesses: 0,
    failureClass: input.decision.class,
    failureReason: input.decision.reason,
    ...(retryAt
      ? {
          retryAt,
          cooldownUntil: retryAt,
          expiresAt: Math.floor(Date.parse(retryAt) / 1_000) + 3_600,
        }
      : {}),
    updatedAt: input.now.toISOString(),
  };
};

const retryable = (error: unknown) =>
  decideOddsRetry({ error, attempt: 1, now: new Date(0), jitter: () => 0 })
    .class === "transient";

export async function runOddsLeague(input: {
  readonly policy: LeagueOddsCollectionPolicy;
  readonly store: OddsControlPlaneStore;
  readonly providers: ReadonlyMap<string, ControlPlaneProvider>;
  readonly committer: OddsPageCommitter;
  readonly now: Date;
  readonly forceRefresh?: boolean;
  readonly clock?: () => Date;
  readonly heartbeatIntervalMs?: number;
  readonly nextStart?: string;
  readonly dependencyFailure?: string;
  readonly metrics?: OddsControlPlaneMetrics;
}): Promise<OddsLeagueRunResult> {
  const { policy, store, now } = input;
  const clock = input.clock ?? (() => now);
  if (input.dependencyFailure) {
    const ownershipOverlap =
      input.dependencyFailure === "schedule-provider-recovering";
    const runId = `${policy.leagueKey}:odds:${now.toISOString()}`;
    await store.putRun({
      runId,
      leagueKey: policy.leagueKey,
      providerId: "none",
      policyVersion: oddsCollectionPolicyVersion,
      status: ownershipOverlap ? "skipped" : "failed",
      startedAt: iso(now),
      updatedAt: iso(now),
      ...(ownershipOverlap
        ? { skipReason: input.dependencyFailure }
        : { failureReason: input.dependencyFailure }),
      evidenceCommitted: false,
      quotaCost: 0,
    });
    return {
      leagueKey: policy.leagueKey,
      status: ownershipOverlap ? "skipped" : "failed",
      reason: input.dependencyFailure,
      pages: 0,
      quotaCost: 0,
    };
  }
  const continuation = await store.getContinuation(policy.leagueKey);
  if (continuation) {
    const durableRun = await store.getRun(continuation.runId);
    if (durableRun && !durableRun.evidenceCommitted) {
      let token: string | undefined = "start";
      let foundIntent = false;
      for (let guard = 0; token && guard < 100; guard += 1) {
        const page = await store.getPage(continuation.runId, token);
        if (!page) break;
        foundIntent ||= page.evidenceIntentAt !== undefined;
        token = page.nextPageToken;
      }
      if (foundIntent)
        await store.putRun({
          ...durableRun,
          evidenceCommitted: true,
          updatedAt: iso(clock()),
        });
    }
  }
  if (continuation?.ambiguousUntil)
    return {
      leagueKey: policy.leagueKey,
      status: "failed",
      reason: "provider-request-ambiguous",
      pages: 0,
      quotaCost: continuation.quotaCost ?? 0,
    };
  const checkpoint = await store.getCheckpoint(policy.leagueKey);
  if (checkpoint)
    input.metrics?.emit(
      "OddsCadenceLagSeconds",
      Math.max(0, (now.getTime() - Date.parse(checkpoint.nextDueAt)) / 1_000),
      { league: policy.leagueKey },
    );
  if (
    !input.forceRefresh &&
    !continuation &&
    checkpoint &&
    Date.parse(checkpoint.nextDueAt) > now.getTime()
  ) {
    const runId = `${policy.leagueKey}:skip:${now.toISOString()}`;
    await store.putRun({
      runId,
      leagueKey: policy.leagueKey,
      providerId: "none",
      policyVersion: oddsCollectionPolicyVersion,
      status: "skipped",
      startedAt: iso(now),
      updatedAt: iso(now),
      skipReason: "cadence-not-due",
      evidenceCommitted: false,
      quotaCost: 0,
    });
    input.metrics?.emit("OddsCadenceSkip", 1, { league: policy.leagueKey });
    return {
      leagueKey: policy.leagueKey,
      status: "skipped",
      reason: "cadence-not-due",
      pages: 0,
      quotaCost: 0,
    };
  }
  const candidates = [...policy.providers]
    .sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : 0))
    .filter((p) => p.active);
  let lastReason = "provider-unavailable";
  const ownerId = randomUUID();
  for (const candidate of candidates) {
    if (continuation && continuation.providerId !== candidate.providerId)
      continue;
    const provider = input.providers.get(candidate.providerId);
    if (!provider) {
      if (lastReason === "provider-unavailable")
        lastReason = "coverage-missing";
      continue;
    }
    const healthKey = oddsHealthKey(candidate.providerId, policy.leagueKey);
    const health =
      (await store.getHealth(healthKey)) ??
      (await store.getHealth(candidate.providerId));
    const accountHealth = await store.getHealth(
      `${candidate.providerId}:account:account`,
    );
    const cooldownMs = health?.cooldownUntil
      ? Date.parse(health.cooldownUntil)
      : undefined;
    const effectiveQuotaRemaining = [
      health?.rateWindow ? health.rateWindow.remaining : health?.quotaRemaining,
      accountHealth?.rateWindow
        ? accountHealth.rateWindow.remaining
        : accountHealth?.quotaRemaining,
    ].filter((value): value is number => value !== undefined);
    if (
      cooldownMs !== undefined &&
      Number.isFinite(cooldownMs) &&
      cooldownMs > now.getTime()
    ) {
      lastReason = "provider-cooldown";
      continue;
    }
    if (
      health?.healthy === false &&
      (health.cooldownUntil === undefined ||
        !Number.isFinite(cooldownMs) ||
        (cooldownMs !== undefined && cooldownMs <= now.getTime())) &&
      health.consecutiveSuccesses < candidate.failbackSuccesses
    ) {
      if (provider.probe) {
        const probeNow = clock();
        const probeKey = `probe:${candidate.providerId}:${policy.leagueKey}:odds`;
        const existingProbe = await store.getContinuation(probeKey);
        if (existingProbe?.ambiguousUntil) {
          lastReason = "provider-request-ambiguous";
          continue;
        }
        const probeOwner = await store.claimContinuation({
          ...existingProbe,
          leagueKey: probeKey,
          runId:
            existingProbe?.runId ??
            `probe:${policy.leagueKey}:${candidate.providerId}`,
          providerId: candidate.providerId,
          updatedAt: iso(probeNow),
          startedAt: existingProbe?.startedAt ?? iso(probeNow),
          capability: "odds",
          evidenceCommitted: false,
          quotaCost: existingProbe?.quotaCost ?? 0,
          ownerId,
          leaseUntil: attemptLeaseUntil(probeNow),
        });
        if (probeOwner.ownerId !== ownerId) {
          lastReason = "provider-recovering";
          continue;
        }
        const attemptId = `${policy.leagueKey}:${candidate.providerId}:probe:${iso(probeNow)}`;
        const probeReserved = await store.reserveQuotaAttempt(
          healthKey,
          candidate.quotaReserve,
          provider.requestCost ?? 1,
          {
            attemptId,
            runId: `probe:${policy.leagueKey}:${candidate.providerId}`,
            pageToken: "probe",
            requestedAt: iso(probeNow),
            leaseUntil: attemptLeaseUntil(probeNow),
            state: "reserved",
            providerId: candidate.providerId,
            leagueKey: policy.leagueKey,
            capability: "odds",
          },
        );
        if (probeReserved)
          try {
            const liveProbeNow = clock();
            const activeProbe = await store.getContinuation(probeKey);
            if (
              activeProbe?.ownerId !== ownerId ||
              !activeProbe.leaseUntil ||
              Date.parse(activeProbe.leaseUntil) <= liveProbeNow.getTime()
            )
              throw new Error("run-owned");
            await putContinuationCas(store, {
              ...activeProbe,
              updatedAt: iso(liveProbeNow),
              leaseUntil: attemptLeaseUntil(liveProbeNow),
            });
            const probe = await withPaidLeaseHeartbeat(
              () => provider.probe!(),
              async () => {
                const heartbeatNow = clock();
                const current = await store.getContinuation(probeKey);
                if (
                  current?.ownerId !== ownerId ||
                  !current.leaseUntil ||
                  Date.parse(current.leaseUntil) <= heartbeatNow.getTime()
                )
                  throw new Error("run-owned");
                await putContinuationCas(store, {
                  ...current,
                  updatedAt: iso(heartbeatNow),
                  leaseUntil: attemptLeaseUntil(heartbeatNow),
                });
              },
              input.heartbeatIntervalMs,
            );
            const successes = health.consecutiveSuccesses + 1;
            await store.completeAttempt({
              attemptId,
              runId: `probe:${policy.leagueKey}:${candidate.providerId}`,
              pageToken: "probe",
              requestedAt: iso(probeNow),
              completedAt: iso(now),
              quotaCost: probe.quotaCost,
            });
            await store.putHealth({
              ...healthyOddsProviderState(await store.getHealth(healthKey), {
                providerId: candidate.providerId,
                healthKey,
                updatedAt: iso(now),
                consecutiveSuccesses: successes,
              }),
              healthy: successes >= candidate.failbackSuccesses,
              ...(probe.quotaRemaining === undefined
                ? {}
                : { quotaRemaining: probe.quotaRemaining }),
              ...(probe.rateWindow ? { rateWindow: probe.rateWindow } : {}),
            });
            await clearOwnedContinuation(
              store,
              probeKey,
              probeOwner.runId,
              ownerId,
            );
          } catch (error) {
            const ambiguous = ambiguousTransport(error);
            await store.completeAttempt({
              attemptId,
              runId: `probe:${policy.leagueKey}:${candidate.providerId}`,
              pageToken: "probe",
              requestedAt: iso(probeNow),
              completedAt: iso(now),
              state: ambiguous ? "ambiguous" : "failed",
              failureReason: ambiguous
                ? "provider-request-ambiguous"
                : classifyOddsControlPlaneFailure(error),
            });
            await store.putHealth(
              unhealthyOddsProviderState(await store.getHealth(healthKey), {
                providerId: candidate.providerId,
                healthKey,
                now,
                decision: decideOddsRetry({
                  error: ambiguous
                    ? new Error("provider-request-ambiguous")
                    : error,
                  attempt: 1,
                  now,
                  jitter: () => 0,
                }),
                cooldownSeconds: candidate.cooldownSeconds,
              }),
            );
            if (ambiguous)
              await putContinuationCas(store, {
                ...probeOwner,
                updatedAt: iso(clock()),
                ambiguousUntil: attemptLeaseUntil(clock()),
              });
            else
              await clearOwnedContinuation(
                store,
                probeKey,
                probeOwner.runId,
                ownerId,
              );
          }
        else
          await clearOwnedContinuation(
            store,
            probeKey,
            probeOwner.runId,
            ownerId,
          );
      }
      lastReason = "provider-recovering";
      continue;
    }
    if (
      effectiveQuotaRemaining.length > 0 &&
      Math.min(...effectiveQuotaRemaining) <= candidate.quotaReserve
    ) {
      const runId = `${policy.leagueKey}:${candidate.providerId}:${now.toISOString()}`;
      await store.putRun({
        runId,
        leagueKey: policy.leagueKey,
        providerId: candidate.providerId,
        policyVersion: oddsCollectionPolicyVersion,
        status: "skipped",
        startedAt: iso(now),
        updatedAt: iso(now),
        skipReason: "quota-reserve",
        evidenceCommitted: false,
        quotaCost: 0,
      });
      input.metrics?.emit("OddsQuotaReserveSkip", 1, {
        league: policy.leagueKey,
        provider: candidate.providerId,
      });
      input.metrics?.emit("OddsRateWindowBlocked", 1, {
        league: policy.leagueKey,
        provider: candidate.providerId,
      });
      lastReason = "quota-reserve";
      continue;
    }
    const claimNow = clock();
    const owner = await store.claimContinuation({
      ...continuation,
      leagueKey: policy.leagueKey,
      runId:
        continuation?.runId ??
        `${policy.leagueKey}:${candidate.providerId}:${now.toISOString()}`,
      providerId: candidate.providerId,
      updatedAt: iso(claimNow),
      startedAt: continuation?.startedAt ?? iso(claimNow),
      capability: "odds",
      evidenceCommitted: continuation?.evidenceCommitted ?? false,
      quotaCost: continuation?.quotaCost ?? 0,
      ownerId,
      leaseUntil: attemptLeaseUntil(claimNow),
    });
    if (owner.providerId !== candidate.providerId || owner.ownerId !== ownerId)
      return {
        leagueKey: policy.leagueKey,
        status: owner.ambiguousUntil ? "failed" : "skipped",
        reason: owner.ambiguousUntil
          ? "provider-request-ambiguous"
          : "provider-recovering",
        pages: 0,
        quotaCost: owner.quotaCost ?? 0,
      };
    const runId = owner.runId;
    const durableRun = await store.getRun(runId);
    let run: OddsRunRecord = {
      ...((await store.getRun(runId)) ?? {}),
      runId,
      leagueKey: policy.leagueKey,
      providerId: candidate.providerId,
      policyVersion: oddsCollectionPolicyVersion,
      status: "running",
      startedAt: owner.startedAt ?? iso(now),
      updatedAt: iso(now),
      evidenceCommitted:
        durableRun?.evidenceCommitted ?? owner.evidenceCommitted ?? false,
      quotaCost: durableRun?.quotaCost ?? owner.quotaCost ?? 0,
    };
    await store.putRun(run);
    await putContinuationCas(store, {
      leagueKey: policy.leagueKey,
      runId,
      providerId: candidate.providerId,
      updatedAt: iso(now),
      startedAt: run.startedAt,
      capability: "odds",
      evidenceCommitted: run.evidenceCommitted,
      quotaCost: run.quotaCost,
    });
    let pageToken = "start",
      pages = 0,
      quotaCost = run.quotaCost;
    let evidenceCommitted = run.evidenceCommitted;
    const seenProviderEventIds = new Set<string>();
    for (
      let token: string | undefined = "start", guard = 0;
      token && guard < 100;
      guard += 1
    ) {
      const durablePage = await store.getPage(runId, token);
      if (!durablePage) break;
      for (const eventId of durablePage.seenProviderEventIds ?? [])
        seenProviderEventIds.add(eventId);
      token = durablePage.nextPageToken;
    }
    let commitAmbiguous = false;
    try {
      for (let guard = 0; guard < 100; guard += 1) {
        const pageNow = clock();
        const activeOwner = await store.getContinuation(policy.leagueKey);
        if (
          activeOwner?.ownerId !== ownerId ||
          !activeOwner.leaseUntil ||
          Date.parse(activeOwner.leaseUntil) <= pageNow.getTime()
        )
          throw new Error("run-owned");
        await putContinuationCas(store, {
          ...activeOwner,
          updatedAt: iso(pageNow),
          leaseUntil: attemptLeaseUntil(pageNow),
        });
        let sealed = await store.getPage(runId, pageToken);
        if (!sealed) {
          const requestCost = provider.requestCost ?? 1;
          const quotaKey =
            accountHealth?.quotaRemaining === undefined
              ? healthKey
              : `${candidate.providerId}:account:account`;
          const attemptId = `${runId}:${pageToken}:${iso(pageNow)}:${guard}`;
          const reserved = await store.reserveQuotaAttempt(
            quotaKey,
            candidate.quotaReserve,
            requestCost,
            {
              attemptId,
              runId,
              pageToken,
              requestedAt: iso(pageNow),
              leaseUntil: attemptLeaseUntil(pageNow),
              state: "reserved",
              providerId: candidate.providerId,
              leagueKey: policy.leagueKey,
              capability: "odds",
            },
          );
          if (!reserved) throw new Error("quota-reserve");
          quotaCost += requestCost;
          let response: NormalizedOddsPage | undefined;
          try {
            response = await withPaidLeaseHeartbeat(
              () =>
                provider.fetchPage({
                  runId,
                  leagueKey: policy.leagueKey,
                  pageToken,
                }),
              async () => {
                const heartbeatNow = clock();
                const heartbeatOwner = await store.getContinuation(
                  policy.leagueKey,
                );
                if (
                  heartbeatOwner?.ownerId !== ownerId ||
                  !heartbeatOwner.leaseUntil ||
                  Date.parse(heartbeatOwner.leaseUntil) <=
                    heartbeatNow.getTime()
                )
                  throw new Error("run-owned");
                await putContinuationCas(store, {
                  ...heartbeatOwner,
                  updatedAt: iso(heartbeatNow),
                  leaseUntil: attemptLeaseUntil(heartbeatNow),
                });
              },
              input.heartbeatIntervalMs,
            );
            const postFetchNow = clock();
            const postFetchOwner = await store.getContinuation(
              policy.leagueKey,
            );
            if (
              postFetchOwner?.ownerId !== ownerId ||
              !postFetchOwner.leaseUntil ||
              Date.parse(postFetchOwner.leaseUntil) <= postFetchNow.getTime()
            )
              throw new Error("run-owned");
            await putContinuationCas(store, {
              ...postFetchOwner,
              updatedAt: iso(postFetchNow),
              leaseUntil: attemptLeaseUntil(postFetchNow),
            });
            await store.reconcileQuota(
              quotaKey,
              requestCost,
              response.quotaCost,
              response.quotaRemaining,
              iso(now),
            );
            const quotaDelta = response.quotaCost - requestCost;
            quotaCost = Math.max(0, quotaCost + quotaDelta);
            sealed = {
              runId,
              pageToken,
              ...(response.nextPageToken
                ? { nextPageToken: response.nextPageToken }
                : {}),
              responseDigest: response.digest,
              normalizedItems: response.items,
              ...(response.seenProviderEventIds
                ? { seenProviderEventIds: response.seenProviderEventIds }
                : {}),
              gaps: response.gaps,
              quotaCost: response.quotaCost,
              sealedAt: iso(now),
            };
            await store.sealPage(sealed);
            await store.completeAttempt({
              attemptId,
              runId,
              pageToken,
              requestedAt: iso(now),
              completedAt: iso(now),
              quotaCost: response.quotaCost,
            });
            input.metrics?.emit("OddsProviderRequest", 1, {
              league: policy.leagueKey,
              provider: candidate.providerId,
            });
            input.metrics?.emit("OddsQuotaCost", response.quotaCost, {
              league: policy.leagueKey,
              provider: candidate.providerId,
            });
            if (response.quotaRemaining !== undefined)
              await store.putHealth({
                ...healthyOddsProviderState(await store.getHealth(healthKey), {
                  providerId: candidate.providerId,
                  healthKey,
                  updatedAt: iso(now),
                  consecutiveSuccesses: (health?.consecutiveSuccesses ?? 0) + 1,
                }),
                quotaRemaining: response.quotaRemaining,
                ...(response.rateWindow
                  ? { rateWindow: response.rateWindow }
                  : {}),
              });
            else if (response.rateWindow)
              await store.putHealth({
                ...healthyOddsProviderState(await store.getHealth(healthKey), {
                  providerId: candidate.providerId,
                  healthKey,
                  updatedAt: iso(now),
                  consecutiveSuccesses: (health?.consecutiveSuccesses ?? 0) + 1,
                }),
                rateWindow: response.rateWindow,
              });
          } catch (error) {
            const durablePage = await store.getPage(runId, pageToken);
            if (durablePage) {
              sealed = durablePage;
              await store.completeAttempt({
                attemptId,
                runId,
                pageToken,
                requestedAt: iso(now),
                completedAt: iso(clock()),
                quotaCost: durablePage.quotaCost,
              });
            } else {
              const ambiguous =
                response !== undefined || ambiguousTransport(error);
              await store.completeAttempt({
                attemptId,
                runId,
                pageToken,
                requestedAt: iso(now),
                completedAt: iso(clock()),
                state: ambiguous ? "ambiguous" : "failed",
                quotaCost: response?.quotaCost ?? requestCost,
                failureReason: response
                  ? "provider-response-unsealed"
                  : ambiguous
                    ? "provider-request-ambiguous"
                    : classifyOddsControlPlaneFailure(error),
              });
              if (ambiguous)
                await putContinuationCas(store, {
                  leagueKey: policy.leagueKey,
                  runId,
                  providerId: candidate.providerId,
                  updatedAt: iso(clock()),
                  startedAt: run.startedAt,
                  capability: "odds",
                  evidenceCommitted,
                  quotaCost,
                  ownerId,
                  ambiguousUntil: attemptLeaseUntil(clock()),
                });
              if (ambiguous) throw new Error("provider-request-ambiguous");
              throw error;
            }
          }
        }
        for (const eventId of sealed.seenProviderEventIds ?? [])
          seenProviderEventIds.add(eventId);
        if (!sealed.committedAt) {
          try {
            const commitNow = clock();
            const commitOwner = await store.getContinuation(policy.leagueKey);
            if (
              commitOwner?.ownerId !== ownerId ||
              !commitOwner.leaseUntil ||
              Date.parse(commitOwner.leaseUntil) <= commitNow.getTime()
            )
              throw new Error("run-owned");
            if (
              !sealed.evidenceIntentAt &&
              (sealed.normalizedItems.length > 0 || sealed.gaps.length > 0)
            ) {
              await store.markEvidenceIntent(runId, pageToken, iso(commitNow));
              evidenceCommitted = true;
            }
            const committed = await input.committer.commit({
              runId,
              providerId: candidate.providerId,
              leagueKey: policy.leagueKey,
              items: sealed.normalizedItems,
            });
            for (const gap of sealed.gaps) await store.putGap(gap);
            const pageCommittedEvidence =
              committed !== false || sealed.gaps.length > 0;
            if (pageCommittedEvidence)
              await store.commitEvidencePage(runId, pageToken, iso(now));
            else await store.commitPage(runId, pageToken, iso(now));
            evidenceCommitted ||= pageCommittedEvidence;
          } catch (error) {
            commitAmbiguous = true;
            throw error;
          }
          input.metrics?.emit("OddsPageCommitted", 1, {
            league: policy.leagueKey,
            provider: candidate.providerId,
          });
        }
        pages += 1;
        await putContinuationCas(store, {
          leagueKey: policy.leagueKey,
          runId,
          providerId: candidate.providerId,
          updatedAt: iso(now),
          startedAt: run.startedAt,
          capability: "odds",
          evidenceCommitted,
          quotaCost,
        });
        if (!sealed.nextPageToken) break;
        pageToken = sealed.nextPageToken;
        if (guard === 99) throw new Error("page-limit-exceeded");
      }
      if (provider.reconcileMissing) {
        const gaps = await provider.reconcileMissing({
          runId,
          seenProviderEventIds,
        });
        for (const gap of gaps) await store.putGap(gap);
        evidenceCommitted ||= gaps.length > 0;
      }
      run = {
        ...run,
        ...((await store.getRun(runId)) ?? {}),
        status: "completed",
        updatedAt: iso(now),
        evidenceCommitted,
        quotaCost,
      };
      await store.putRun(run);
      await store.putCheckpoint({
        ...checkpoint,
        leagueKey: policy.leagueKey,
        providerId: candidate.providerId,
        completedAt: iso(now),
        nextDueAt: dueAt(policy, now, input.nextStart),
        runId,
      });
      const completedHealth = await store.getHealth(healthKey);
      await store.putHealth({
        ...healthyOddsProviderState(await store.getHealth(healthKey), {
          providerId: candidate.providerId,
          healthKey,
          updatedAt: iso(now),
          consecutiveSuccesses:
            completedHealth?.consecutiveSuccesses ??
            (health?.consecutiveSuccesses ?? 0) + 1,
        }),
        ...(completedHealth?.quotaRemaining === undefined
          ? {}
          : { quotaRemaining: completedHealth.quotaRemaining }),
      });
      await clearOwnedContinuation(store, policy.leagueKey, runId, ownerId);
      input.metrics?.emit("OddsLeagueCompleted", 1, {
        league: policy.leagueKey,
        provider: candidate.providerId,
      });
      return {
        leagueKey: policy.leagueKey,
        status: "completed",
        providerId: candidate.providerId,
        pages,
        quotaCost,
      };
    } catch (error) {
      const reason = classifyOddsControlPlaneFailure(error);
      lastReason = reason;
      const safelySkipped =
        !evidenceCommitted &&
        ["quota-reserve", "provider-recovering"].includes(reason);
      await store.putRun({
        ...run,
        ...((await store.getRun(runId)) ?? {}),
        status: safelySkipped ? "skipped" : "failed",
        updatedAt: iso(now),
        ...(safelySkipped ? { skipReason: reason } : { failureReason: reason }),
        evidenceCommitted,
        quotaCost,
      });
      if (safelySkipped) {
        if (reason === "quota-reserve")
          await clearOwnedContinuation(store, policy.leagueKey, runId, ownerId);
        return {
          leagueKey: policy.leagueKey,
          status: "skipped",
          providerId: candidate.providerId,
          reason,
          pages,
          quotaCost,
        };
      }
      const retryDecision = decideOddsRetry({
        error,
        attempt: 1,
        now,
        jitter: () => 0,
      });
      if (
        [
          "provider-unavailable",
          "rate-limited",
          "unauthorized",
          "not-entitled",
          "configuration",
          "invalid-response",
          "coverage-missing",
          "provider-request-ambiguous",
        ].includes(retryDecision.reason)
      )
        await store.putHealth(
          unhealthyOddsProviderState(await store.getHealth(healthKey), {
            providerId: candidate.providerId,
            healthKey,
            now,
            decision: retryDecision,
            cooldownSeconds: candidate.cooldownSeconds,
          }),
        );
      if (retryDecision.reason !== "quota-reserve")
        input.metrics?.emit("OddsProviderHealthUnavailable", 1, {
          league: policy.leagueKey,
          provider: candidate.providerId,
          reason: retryDecision.reason,
        });
      input.metrics?.emit("OddsLeagueFailure", 1, {
        league: policy.leagueKey,
        provider: candidate.providerId,
        reason,
      });
      if (
        !evidenceCommitted &&
        !commitAmbiguous &&
        retryable(error) &&
        candidates.some(
          (other) =>
            other.providerId !== candidate.providerId &&
            input.providers.has(other.providerId),
        )
      )
        await clearOwnedContinuation(store, policy.leagueKey, runId, ownerId);
      if (evidenceCommitted || commitAmbiguous || !retryable(error)) break;
    }
  }
  return {
    leagueKey: policy.leagueKey,
    status: "failed",
    reason: lastReason,
    pages: 0,
    quotaCost: 0,
  };
}

export async function runDueOddsLeagues(
  inputs: readonly Parameters<typeof runOddsLeague>[0][],
): Promise<readonly OddsLeagueRunResult[]> {
  return Promise.all(
    inputs.map(async (input) => {
      try {
        return await runOddsLeague(input);
      } catch (error) {
        return {
          leagueKey: input.policy.leagueKey,
          status: "failed" as const,
          reason: classifyOddsControlPlaneFailure(error),
          pages: 0,
          quotaCost: 0,
        };
      }
    }),
  );
}
