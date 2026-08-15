import {
  type AccountRateCoordinationStore,
  PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION,
  PROVIDER_LANDING_SCHEMA_VERSION,
  providerLandingPositionHash,
  type OddsProviderHealth,
  type ProviderLandingCheckpoint,
  type ProviderLandingEventPartition,
  type ProviderLandingPositionClaimStore,
  type ProviderLandingRecord,
  type ProviderLandingStream,
} from "@find-the-edge/database";
import {
  SharpApiError,
  SharpApiCatalogSnapshot,
  SharpApiLandingQuarantine,
  SharpApiResponseMetadata,
  SharpApiUniversalEvent,
  SharpApiUniversalOddsRecord,
  SharpApiUniversalPage,
} from "@find-the-edge/providers";
import { createHash } from "node:crypto";

export interface ProviderLandingSource {
  fetchCatalog(): Promise<SharpApiCatalogSnapshot>;
  fetchEvents(
    filter: ProviderLandingEventPartition,
    offset: number,
  ): Promise<SharpApiUniversalPage<SharpApiUniversalEvent>>;
  fetchOdds(
    cursor?: string,
  ): Promise<SharpApiUniversalPage<SharpApiUniversalOddsRecord>>;
}

export interface ProviderLandingStore extends ProviderLandingPositionClaimStore {
  getCheckpoint(
    stream: ProviderLandingStream,
  ): Promise<ProviderLandingCheckpoint | null>;
  putRecords(records: readonly ProviderLandingRecord[]): Promise<{
    readonly crossPageDuplicateCount: number;
    readonly crossPageDuplicateRecordIds: readonly string[];
  }>;
  putCheckpoint(
    checkpoint: ProviderLandingCheckpoint,
    expectedVersion: number | null,
  ): Promise<void>;
}

export interface ProviderLandingMetricSink {
  emit(
    metric:
      | "ProviderLandingPage"
      | "ProviderLandingRows"
      | "ProviderLandingSweep"
      | "ProviderLandingFailure"
      | "ProviderLandingTerminalFailure"
      | "ProviderLandingRecovery"
      | "ProviderLandingCompletionAgeSeconds"
      | "ProviderLandingRunAgeSeconds",
    value: number,
    dimensions: Readonly<Record<string, string>>,
  ): void;
}

export interface ProviderLandingAccountRateAdmission {
  readonly admitted: boolean;
  readonly resumeAfter?: string;
  readonly reason?:
    | "account-health-unavailable"
    | "account-provider-unhealthy"
    | "account-rate-reserve";
}

export interface ProviderLandingAccountRateCoordinator {
  reserve(
    cost: number,
    requestedAt: Date,
  ): Promise<ProviderLandingAccountRateAdmission>;
  reconcile(
    reservedCost: number,
    metadata: SharpApiResponseMetadata | undefined,
    completedAt: Date,
  ): Promise<void>;
  rateLimited(retryAt: string, failedAt: Date): Promise<void>;
  terminal(
    reason: "configuration" | "not-entitled" | "unauthorized",
    failedAt: Date,
  ): Promise<void>;
}

export interface SharedSharpApiAccountRateCoordinatorOptions {
  /**
   * The live odds and landing control planes elect exactly one new-window
   * probe through the shared health row. The recovery callback either observes
   * the winner or publishes provider truth before admission retries.
   */
  readonly recoverWindow?: () => Promise<void>;
  readonly now?: () => Date;
  readonly canRecoverWindow?: () => boolean;
  readonly canDispatch?: () => boolean;
}

export interface ProviderLandingRunInput {
  readonly source: ProviderLandingSource;
  readonly store: ProviderLandingStore;
  readonly accountRate?: ProviderLandingAccountRateCoordinator;
  readonly metrics?: ProviderLandingMetricSink;
  readonly now?: () => Date;
  readonly catalogRefreshMs?: number;
  readonly streamRefreshMs?: number;
  readonly eventPageBudget?: number;
  readonly oddsPageBudget?: number;
  readonly shouldContinue?: () => boolean;
}

export interface ProviderLandingRunSummary {
  readonly catalog?: ProviderLandingCheckpoint;
  readonly events?: ProviderLandingCheckpoint;
  readonly odds?: ProviderLandingCheckpoint;
}

const INITIAL_CURSOR = "__initial__";
const DEFAULT_CATALOG_REFRESH_MS = 15 * 60 * 1_000;
const DEFAULT_STREAM_REFRESH_MS = 10 * 60 * 1_000;
const DEFAULT_RATE_PAUSE_MS = 60 * 1_000;
const ACCOUNT_RATE_RESET_GUARD_MS = 10 * 1_000;
const NON_RETRYABLE_PAUSE_MS = 24 * 60 * 60 * 1_000;
const SHARP_API_ACCOUNT_HEALTH_KEY = "sharpapi:account:account";
const MINIMUM_LANDING_ACCOUNT_RESERVE = 250;
const LANDING_ACCOUNT_RESERVE_FRACTION = 0.5;
const MAX_VISITED_POSITION_HASHES = 4_096;
const CATALOG_WRITE_CHUNK_SIZE = 25;
const MAX_EVENT_PARTITION_EXPECTED_ROWS = 3_000;
const MAX_EVENT_PARTITION_LEAGUES = 50;
const MAX_EVENT_PARTITION_QUERY_LENGTH = 3_800;
const MAX_ACCESSIBLE_EVENT_PARTITION_ROWS = 5_200;
const SAFE_FAILURE_REASONS = new Set([
  "unauthorized",
  "not-entitled",
  "rate-limited",
  "provider-request-ambiguous",
  "provider-unavailable",
  "provider-rejected",
  "invalid-response",
  "provider-landing-reconciliation-failed",
  "provider-landing-pagination-invalid",
  "provider-landing-pagination-cycle",
  "provider-landing-total-mismatch",
  "provider-landing-total-missing",
  "provider-landing-page-replay-drift",
  "provider-landing-catalog-empty",
  "provider-landing-write-exhausted",
  "provider-landing-account-terminal",
  "provider-landing-event-partition-too-large",
]);

/** Build a deterministic request plan from SharpAPI's complete reference
 * catalog. Every partition is sport-scoped; large sports are additionally
 * narrowed by exact league slugs. This prevents same-slug leagues in different
 * sports from colliding and lets a sport-level request safely cover any
 * provider league ID that cannot be represented in a comma-separated filter.
 * No sport or league allowlist participates in this plan. */
export const buildSharpApiEventPartitions = (
  snapshot: Pick<SharpApiCatalogSnapshot, "sports" | "leagues">,
) => {
  const leagues = new Map(
    snapshot.leagues.map((league) => [
      `${league.providerSportId}\u0000${league.providerLeagueId}`,
      league,
    ]),
  );
  const sports = new Map(
    snapshot.sports.map((sport) => [sport.providerSportId, sport] as const),
  );
  const leagueIdsBySport = new Map<string, Set<string>>();
  for (const league of snapshot.leagues) {
    const ids = leagueIdsBySport.get(league.providerSportId) ?? new Set();
    ids.add(league.providerLeagueId);
    leagueIdsBySport.set(league.providerSportId, ids);
  }
  const sportIds = new Set([...sports.keys(), ...leagueIdsBySport.keys()]);
  const partitions: ProviderLandingEventPartition[] = [];
  const queryLength = (sport: string, members: readonly string[]) => {
    const query = new URLSearchParams({ sport });
    if (members.length > 0) query.set("league", members.join(","));
    return query.toString().length;
  };
  for (const sportId of [...sportIds].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const sport = sports.get(sportId);
    const catalogLeagueIds = new Set([
      ...(sport?.providerLeagueIds ?? []),
      ...(leagueIdsBySport.get(sportId) ?? []),
    ]);
    const sportLeagues = [...catalogLeagueIds].map((leagueId) =>
      leagues.get(`${sportId}\u0000${leagueId}`),
    );
    const missingLeague = sportLeagues.some((league) => !league);
    const available = sportLeagues.filter(
      (league): league is NonNullable<typeof league> => !!league,
    );
    if (
      (sport?.eventCount ??
        available.reduce((total, league) => total + league.eventCount, 0)) <=
        MAX_EVENT_PARTITION_EXPECTED_ROWS ||
      missingLeague ||
      available.length === 0
    ) {
      partitions.push({ sport: sportId });
      continue;
    }
    let current: string[] = [];
    let expectedRows = 0;
    const flush = () => {
      if (current.length > 0)
        partitions.push({ sport: sportId, leagues: current });
      current = [];
      expectedRows = 0;
    };
    for (const league of available.sort((left, right) =>
      left.providerLeagueId.localeCompare(right.providerLeagueId),
    )) {
      const candidate = [...current, league.providerLeagueId];
      if (
        current.length > 0 &&
        (candidate.length > MAX_EVENT_PARTITION_LEAGUES ||
          expectedRows + league.eventCount >
            MAX_EVENT_PARTITION_EXPECTED_ROWS ||
          queryLength(sportId, candidate) > MAX_EVENT_PARTITION_QUERY_LENGTH)
      )
        flush();
      current.push(league.providerLeagueId);
      expectedRows += league.eventCount;
    }
    flush();
  }
  return partitions;
};

type TerminalSharpApiCode = "configuration" | "not-entitled" | "unauthorized";
const TERMINAL_SHARP_API_CODES = new Set<TerminalSharpApiCode>([
  "configuration",
  "not-entitled",
  "unauthorized",
]);
const terminalSharpApiCode = (
  code: SharpApiError["code"],
): code is TerminalSharpApiCode =>
  TERMINAL_SHARP_API_CODES.has(code as TerminalSharpApiCode);
const accountGlobalProviderFailure = (error: unknown) =>
  (error instanceof SharpApiError && terminalSharpApiCode(error.code)) ||
  (error instanceof Error &&
    error.message === "provider-landing-account-terminal");

const futureBoundary = (
  now: Date,
  ...candidates: readonly (string | undefined)[]
) => {
  const latest = candidates
    .filter(
      (candidate): candidate is string =>
        !!candidate && Date.parse(candidate) > now.getTime(),
    )
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return (
    latest ?? new Date(now.getTime() + DEFAULT_RATE_PAUSE_MS).toISOString()
  );
};

const accountHealthIsTerminal = (health: OddsProviderHealth) =>
  health.failureClass === "terminal" ||
  ["configuration", "unauthorized", "not-entitled"].includes(
    health.failureReason ?? "",
  );
const accountHealthCanRecover = (health: OddsProviderHealth, now: Date) =>
  health.failureClass === "transient" &&
  [health.cooldownUntil, health.retryAt, health.rateWindow?.resetsAt].every(
    (candidate) => !candidate || Date.parse(candidate) <= now.getTime(),
  );

/**
 * Low-priority account admission for universal acquisition. Live odds and
 * landing share one durable probe lease, while landing spends only after the
 * elected winner establishes an authoritative account window.
 */
export class SharedSharpApiAccountRateCoordinator implements ProviderLandingAccountRateCoordinator {
  private readonly attemptedRecoveryKeys = new Set<string>();
  private refreshDispatchBlocked = false;

  constructor(
    private readonly store: AccountRateCoordinationStore,
    private readonly options: SharedSharpApiAccountRateCoordinatorOptions = {},
  ) {}

  private unavailable(
    requestedAt: Date,
    health?: OddsProviderHealth | null,
  ): ProviderLandingAccountRateAdmission {
    return {
      admitted: false,
      reason: "account-health-unavailable",
      resumeAfter: futureBoundary(
        requestedAt,
        health?.cooldownUntil,
        health?.retryAt,
        health?.rateWindow?.resetsAt,
      ),
    };
  }

  private async reserveOnce(
    cost: number,
    requestedAt: Date,
  ): Promise<ProviderLandingAccountRateAdmission> {
    let health = await this.store.getHealth(SHARP_API_ACCOUNT_HEALTH_KEY);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptAt = this.options.now?.() ?? requestedAt;
      if (!health) return this.unavailable(attemptAt);
      if (accountHealthIsTerminal(health))
        throw new Error("provider-landing-account-terminal");
      if (!health.healthy && accountHealthCanRecover(health, attemptAt))
        return this.unavailable(attemptAt, health);
      if (!health.healthy)
        return {
          admitted: false,
          reason: "account-provider-unhealthy",
          resumeAfter: futureBoundary(
            attemptAt,
            health.cooldownUntil,
            health.retryAt,
            health.rateWindow?.resetsAt,
          ),
        };
      const remaining = health.rateWindow?.remaining ?? health.quotaRemaining;
      if (remaining === undefined) return this.unavailable(attemptAt, health);
      const resetsAt = health.rateWindow?.resetsAt;
      if (
        resetsAt &&
        Date.parse(resetsAt) <=
          attemptAt.getTime() + ACCOUNT_RATE_RESET_GUARD_MS
      )
        return this.unavailable(attemptAt, health);
      if (this.options.canDispatch?.() === false) {
        this.refreshDispatchBlocked = true;
        return this.unavailable(attemptAt, health);
      }
      const limit = health.rateWindow?.limit;
      const reserve = Math.max(
        MINIMUM_LANDING_ACCOUNT_RESERVE,
        limit === undefined
          ? 0
          : Math.ceil(limit * LANDING_ACCOUNT_RESERVE_FRACTION),
      );
      const admitted = await this.store.reserveAccountRate(
        SHARP_API_ACCOUNT_HEALTH_KEY,
        reserve,
        cost,
        attemptAt.toISOString(),
        {
          ...(health.version === undefined ? {} : { version: health.version }),
          ...(limit === undefined ? {} : { limit }),
          ...(resetsAt === undefined ? {} : { resetsAt }),
        },
      );
      if (admitted) {
        const dispatchAt = this.options.now?.() ?? attemptAt;
        if (this.options.canDispatch?.() === false) {
          this.refreshDispatchBlocked = true;
          return this.unavailable(dispatchAt, health);
        }
        if (
          resetsAt !== undefined &&
          Date.parse(resetsAt) <=
            dispatchAt.getTime() + ACCOUNT_RATE_RESET_GUARD_MS
        )
          return this.unavailable(dispatchAt, health);
        return { admitted: true };
      }
      const current =
        (await this.store.getHealth(SHARP_API_ACCOUNT_HEALTH_KEY)) ?? health;
      if (accountHealthIsTerminal(current))
        throw new Error("provider-landing-account-terminal");
      if (!current.healthy && accountHealthCanRecover(current, attemptAt))
        return this.unavailable(attemptAt, current);
      if (!current.healthy)
        return {
          admitted: false,
          reason: "account-provider-unhealthy",
          resumeAfter: futureBoundary(
            attemptAt,
            current.cooldownUntil,
            current.retryAt,
            current.rateWindow?.resetsAt,
          ),
        };
      const currentRemaining =
        current.rateWindow?.remaining ?? current.quotaRemaining;
      if (currentRemaining === undefined)
        return this.unavailable(attemptAt, current);
      const currentReset = current.rateWindow?.resetsAt;
      if (
        currentReset &&
        Date.parse(currentReset) <=
          attemptAt.getTime() + ACCOUNT_RATE_RESET_GUARD_MS
      )
        return this.unavailable(attemptAt, current);
      const currentLimit = current.rateWindow?.limit;
      const currentReserve = Math.max(
        MINIMUM_LANDING_ACCOUNT_RESERVE,
        currentLimit === undefined
          ? 0
          : Math.ceil(currentLimit * LANDING_ACCOUNT_RESERVE_FRACTION),
      );
      if (attempt === 0 && currentRemaining - cost >= currentReserve) {
        health = current;
        continue;
      }
      return {
        admitted: false,
        reason: "account-rate-reserve",
        resumeAfter: futureBoundary(
          attemptAt,
          current.cooldownUntil,
          current.retryAt,
          current.rateWindow?.resetsAt,
        ),
      };
    }
    throw new Error("provider-landing-account-reserve-unreachable");
  }

  async reserve(
    cost: number,
    requestedAt: Date,
  ): Promise<ProviderLandingAccountRateAdmission> {
    if (!Number.isSafeInteger(cost) || cost <= 0 || cost > 2)
      throw new Error("provider-landing-account-cost-invalid");
    const firstAttemptAt = this.options.now?.() ?? requestedAt;
    if (this.refreshDispatchBlocked) return this.unavailable(firstAttemptAt);
    const first = await this.reserveOnce(cost, firstAttemptAt);
    if (
      first.admitted ||
      first.reason !== "account-health-unavailable" ||
      !this.options.recoverWindow ||
      this.options.canRecoverWindow?.() === false
    )
      return first;
    const health = await this.store.getHealth(SHARP_API_ACCOUNT_HEALTH_KEY);
    const recoveryKey =
      health?.rateWindow?.resetsAt ?? health?.updatedAt ?? "missing";
    if (this.attemptedRecoveryKeys.has(recoveryKey)) return first;
    if (this.attemptedRecoveryKeys.size >= 32) {
      const oldest = this.attemptedRecoveryKeys.values().next().value;
      if (oldest !== undefined) this.attemptedRecoveryKeys.delete(oldest);
    }
    this.attemptedRecoveryKeys.add(recoveryKey);
    await this.options.recoverWindow();
    if (this.options.canDispatch?.() === false) {
      this.refreshDispatchBlocked = true;
      return first;
    }
    const second = await this.reserveOnce(
      cost,
      this.options.now?.() ?? new Date(),
    );
    if (!second.admitted && second.reason === "account-health-unavailable") {
      const unresolved = await this.store.getHealth(
        SHARP_API_ACCOUNT_HEALTH_KEY,
      );
      const unresolvedKey =
        unresolved?.rateWindow?.probeUntil ??
        unresolved?.rateWindow?.resetsAt ??
        unresolved?.updatedAt ??
        "missing";
      this.attemptedRecoveryKeys.add(unresolvedKey);
    }
    return second;
  }

  reconcile(
    reservedCost: number,
    metadata: SharpApiResponseMetadata | undefined,
    completedAt: Date,
  ) {
    return this.store.reconcileAccountRateWindow(
      SHARP_API_ACCOUNT_HEALTH_KEY,
      reservedCost,
      reservedCost,
      metadata?.rateWindow,
      completedAt.toISOString(),
    );
  }

  rateLimited(retryAt: string, failedAt: Date) {
    return this.store.blockAccountRateWindow(
      SHARP_API_ACCOUNT_HEALTH_KEY,
      retryAt,
      failedAt.toISOString(),
    );
  }

  terminal(
    reason: "configuration" | "not-entitled" | "unauthorized",
    failedAt: Date,
  ) {
    return this.store.blockAccountTerminal(
      SHARP_API_ACCOUNT_HEALTH_KEY,
      reason,
      failedAt.toISOString(),
    );
  }
}

const asValue = <T extends object>(
  value: T,
): Readonly<Record<string, unknown>> =>
  value as unknown as Readonly<Record<string, unknown>>;

const sweepId = (stream: ProviderLandingStream, now: Date) =>
  `${stream}:${now.toISOString()}`;

const recoverySweepId = (
  stream: ProviderLandingStream,
  version: number,
  now: Date,
) => `${stream}:recovery-${version}:${now.toISOString()}`;

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const positionHash = (checkpoint: ProviderLandingCheckpoint) =>
  providerLandingPositionHash(checkpoint, 64);

const advancePositionHistory = (
  history: readonly string[],
  nextPositionHash: string,
) => {
  if (history.includes(nextPositionHash)) return history;
  return [...history, nextPositionHash].slice(-MAX_VISITED_POSITION_HASHES);
};

const pageHash = (
  page: SharpApiUniversalPage<
    SharpApiUniversalEvent | SharpApiUniversalOddsRecord
  >,
) =>
  digest({
    records: page.records,
    quarantines: page.quarantines,
    sourceRows: page.sourceRows,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset ?? null,
    nextCursor: page.nextCursor ?? null,
    providerTotal: page.providerTotal ?? null,
  });

const zeroCounts = () => ({
  pages: 0,
  sourceRows: 0,
  landedRows: 0,
  quarantinedRows: 0,
  warningRows: 0,
});

const withoutTransientPageState = (checkpoint: ProviderLandingCheckpoint) => {
  const committed = { ...checkpoint };
  delete committed.pendingPage;
  delete committed.resumeAfter;
  delete committed.pauseScope;
  return committed;
};

const withCurrentPageMetadata = (
  checkpoint: ProviderLandingCheckpoint,
  page: SharpApiUniversalPage<
    SharpApiUniversalEvent | SharpApiUniversalOddsRecord
  >,
) => {
  const current = { ...checkpoint };
  // SharpAPI's updated_at describes the mutable provider view observed by the
  // current request, not an immutable pagination snapshot. Likewise, some
  // cursor feeds (notably /odds) legitimately omit total. Keep the latest
  // bounded evidence when supplied without turning either optional field into
  // a liveness prerequisite for a cursor/offset-complete sweep.
  delete current.providerUpdatedAt;
  delete current.providerTotal;
  if (page.providerUpdatedAt)
    current.providerUpdatedAt = page.providerUpdatedAt;
  if (page.providerTotal !== undefined)
    current.providerTotal = page.providerTotal;
  return current;
};

const warningRows = (
  records: readonly (SharpApiUniversalEvent | SharpApiUniversalOddsRecord)[],
) =>
  records.filter((record) => (record.sourceWarnings?.length ?? 0) > 0).length;

const emitRows = (
  metrics: ProviderLandingMetricSink | undefined,
  stream: ProviderLandingStream,
  landed: number,
  quarantined: number,
  warnings: number,
  persistedPages = 1,
) => {
  metrics?.emit("ProviderLandingPage", persistedPages, {
    stream,
    outcome: "persisted",
  });
  if (landed > 0)
    metrics?.emit("ProviderLandingRows", landed, {
      stream,
      outcome: "landed",
    });
  if (quarantined > 0)
    metrics?.emit("ProviderLandingRows", quarantined, {
      stream,
      outcome: "quarantined",
    });
  if (warnings > 0)
    metrics?.emit("ProviderLandingRows", warnings, {
      stream,
      outcome: "warning",
    });
};

const createRateGate = (now: () => Date) => {
  let resumeAfter: string | undefined;
  const observe = (metadata: SharpApiResponseMetadata | undefined) => {
    const { limit, remaining, resetsAt } = metadata?.rateWindow ?? {};
    if (limit === undefined || remaining === undefined) return;
    const reserve = Math.max(25, Math.ceil(limit * 0.2));
    if (remaining > reserve) return;
    const candidate =
      resetsAt && Date.parse(resetsAt) > now().getTime()
        ? resetsAt
        : new Date(now().getTime() + DEFAULT_RATE_PAUSE_MS).toISOString();
    if (!resumeAfter || Date.parse(candidate) > Date.parse(resumeAfter))
      resumeAfter = candidate;
  };
  return {
    observe,
    deferUntil: (candidate: string | undefined) => {
      if (
        candidate &&
        Date.parse(candidate) > now().getTime() &&
        (!resumeAfter || Date.parse(candidate) > Date.parse(resumeAfter))
      )
        resumeAfter = candidate;
    },
    canRequest: () =>
      !resumeAfter || now().getTime() >= Date.parse(resumeAfter),
    resumeAfter: () => resumeAfter,
  };
};

const startCheckpoint = async (
  store: ProviderLandingStore,
  stream: ProviderLandingStream,
  prior: ProviderLandingCheckpoint | null,
  now: Date,
  eventPartitions?: readonly ProviderLandingEventPartition[],
) => {
  if (prior?.status === "running") return prior;
  const position =
    stream === "events"
      ? { partition: 0, offset: 0 }
      : stream === "odds"
        ? { cursor: INITIAL_CURSOR }
        : null;
  const checkpoint: ProviderLandingCheckpoint = {
    schemaVersion: PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION,
    providerId: "sharpapi",
    stream,
    version: (prior?.version ?? -1) + 1,
    status: "running",
    sweepId: sweepId(stream, now),
    slot: prior ? (prior.slot === 0 ? 1 : 0) : 0,
    position,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    counts: zeroCounts(),
    ...(stream === "events" && eventPartitions
      ? { eventPartitions, eventPartitionSourceRows: 0 }
      : {}),
    ...(position
      ? {
          visitedPositionHashes: [
            providerLandingPositionHash({ stream, position }),
          ],
        }
      : {}),
    ...(prior?.lastCompletedAt
      ? { lastCompletedAt: prior.lastCompletedAt }
      : {}),
    ...(prior?.lastCompletedSlot !== undefined
      ? { lastCompletedSlot: prior.lastCompletedSlot }
      : {}),
    ...(prior?.lastCompletedSweepId
      ? { lastCompletedSweepId: prior.lastCompletedSweepId }
      : {}),
    ...(prior?.lastCompletedCounts
      ? { lastCompletedCounts: prior.lastCompletedCounts }
      : {}),
  };
  await store.putCheckpoint(checkpoint, prior?.version ?? null);
  return checkpoint;
};

const restartCheckpointAfterDrift = async (
  store: ProviderLandingStore,
  checkpoint: ProviderLandingCheckpoint,
  now: Date,
  metrics: ProviderLandingMetricSink | undefined,
  reason:
    | "provider-landing-page-replay-drift"
    | "provider-landing-pagination-cycle"
    | "provider-landing-total-missing"
    | "provider-landing-total-mismatch"
    | "provider-landing-event-plan-migrated"
    | "provider-landing-cursor-rejected"
    | "provider-landing-event-partition-split",
  eventPartitions = checkpoint.eventPartitions,
) => {
  const position =
    checkpoint.stream === "events"
      ? { partition: 0, offset: 0 }
      : checkpoint.stream === "odds"
        ? { cursor: INITIAL_CURSOR }
        : null;
  const priorVersion = checkpoint.version;
  const restarted: ProviderLandingCheckpoint = {
    schemaVersion: PROVIDER_LANDING_CHECKPOINT_SCHEMA_VERSION,
    providerId: "sharpapi",
    stream: checkpoint.stream,
    version: priorVersion + 1,
    status: "running",
    sweepId: recoverySweepId(checkpoint.stream, priorVersion + 1, now),
    slot: checkpoint.slot,
    position,
    startedAt: checkpoint.startedAt,
    updatedAt: now.toISOString(),
    counts: zeroCounts(),
    ...(checkpoint.stream === "events" && eventPartitions
      ? { eventPartitions, eventPartitionSourceRows: 0 }
      : {}),
    ...(position
      ? {
          visitedPositionHashes: [
            providerLandingPositionHash({
              stream: checkpoint.stream,
              position,
            }),
          ],
        }
      : {}),
    ...(checkpoint.lastCompletedSlot !== undefined
      ? { lastCompletedSlot: checkpoint.lastCompletedSlot }
      : {}),
    ...(checkpoint.lastCompletedSweepId
      ? { lastCompletedSweepId: checkpoint.lastCompletedSweepId }
      : {}),
    ...(checkpoint.lastCompletedAt
      ? { lastCompletedAt: checkpoint.lastCompletedAt }
      : {}),
    ...(checkpoint.lastCompletedCounts
      ? { lastCompletedCounts: checkpoint.lastCompletedCounts }
      : {}),
  };
  await store.putCheckpoint(restarted, priorVersion);
  metrics?.emit("ProviderLandingFailure", 1, {
    stream: checkpoint.stream,
    reason,
  });
  metrics?.emit("ProviderLandingRecovery", 1, {
    stream: checkpoint.stream,
    outcome: "restart",
  });
  return restarted;
};

const reservePaidRequest = async (input: {
  accountRate?: ProviderLandingAccountRateCoordinator;
  store: ProviderLandingStore;
  checkpoint: ProviderLandingCheckpoint;
  stream: ProviderLandingStream;
  cost: number;
  now: () => Date;
  metrics?: ProviderLandingMetricSink;
}) => {
  if (!input.accountRate)
    return { admitted: true as const, checkpoint: input.checkpoint };
  const admission = await input.accountRate.reserve(input.cost, input.now());
  if (admission.admitted)
    return { admitted: true as const, checkpoint: input.checkpoint };
  const priorVersion = input.checkpoint.version;
  const checkpoint = {
    ...input.checkpoint,
    version: priorVersion + 1,
    updatedAt: input.now().toISOString(),
    resumeAfter: admission.resumeAfter ?? futureBoundary(input.now()),
    pauseScope: "account" as const,
  };
  await input.store.putCheckpoint(checkpoint, priorVersion);
  input.metrics?.emit("ProviderLandingFailure", 1, {
    stream: input.stream,
    reason: admission.reason ?? "account-rate-reserve",
  });
  return { admitted: false as const, checkpoint };
};

const pauseCheckpointAfterNonRetryable = async (
  store: ProviderLandingStore,
  checkpoint: ProviderLandingCheckpoint,
  now: Date,
) => {
  const priorVersion = checkpoint.version;
  const paused = {
    ...checkpoint,
    version: priorVersion + 1,
    updatedAt: now.toISOString(),
    resumeAfter: new Date(now.getTime() + NON_RETRYABLE_PAUSE_MS).toISOString(),
    pauseScope: "stream" as const,
  };
  await store.putCheckpoint(paused, priorVersion);
  return paused;
};

const quarantineRecord = (
  quarantine: SharpApiLandingQuarantine,
  checkpoint: ProviderLandingCheckpoint,
  pageNumber: number,
  retrievedAt: string,
): ProviderLandingRecord => ({
  schemaVersion: PROVIDER_LANDING_SCHEMA_VERSION,
  providerId: "sharpapi",
  recordType: "quarantine",
  recordId: `${checkpoint.sweepId}:${quarantine.endpoint}:${pageNumber}:${quarantine.rowIndex}`,
  endpoint: quarantine.endpoint,
  pageNumber,
  sweepId: checkpoint.sweepId,
  slot: checkpoint.slot,
  retrievedAt,
  value: asValue({
    reason: quarantine.reason,
    rowIndex: quarantine.rowIndex,
    ...(quarantine.providerRecordId
      ? { providerRecordId: quarantine.providerRecordId }
      : {}),
    sourceFields: quarantine.sourceFields,
    sourceFieldCount: quarantine.sourceFieldCount,
    ...(quarantine.sourceFieldsTruncated
      ? { sourceFieldsTruncated: true }
      : {}),
    sourceSchemaHash: quarantine.sourceSchemaHash,
  }),
});

const catalogDue = (
  checkpoint: ProviderLandingCheckpoint | null,
  now: Date,
  refreshMs: number,
) =>
  checkpoint?.status === "running" ||
  !checkpoint?.eventPartitions ||
  !checkpoint?.lastCompletedAt ||
  now.getTime() - Date.parse(checkpoint.lastCompletedAt) >= refreshMs;

const runCatalog = async (input: {
  source: ProviderLandingSource;
  store: ProviderLandingStore;
  accountRate?: ProviderLandingAccountRateCoordinator;
  prior: ProviderLandingCheckpoint | null;
  now: () => Date;
  refreshMs: number;
  shouldContinue: () => boolean;
  rateGate: ReturnType<typeof createRateGate>;
  metrics?: ProviderLandingMetricSink;
}) => {
  if (!catalogDue(input.prior, input.now(), input.refreshMs))
    return input.prior!;
  let checkpoint = await startCheckpoint(
    input.store,
    "catalog",
    input.prior,
    input.now(),
  );
  if (
    checkpoint.resumeAfter &&
    input.now().getTime() < Date.parse(checkpoint.resumeAfter)
  )
    return checkpoint;
  if (!input.shouldContinue()) return checkpoint;
  if (!input.rateGate.canRequest()) return checkpoint;
  const reservation = await reservePaidRequest({
    ...(input.accountRate ? { accountRate: input.accountRate } : {}),
    store: input.store,
    checkpoint,
    stream: "catalog",
    // The catalog snapshot is two ordered provider calls: sports, then
    // leagues. The second response carries the conservative account window.
    cost: 2,
    now: input.now,
    ...(input.metrics ? { metrics: input.metrics } : {}),
  });
  checkpoint = reservation.checkpoint;
  if (!reservation.admitted) return checkpoint;
  let snapshot: SharpApiCatalogSnapshot;
  try {
    snapshot = await input.source.fetchCatalog();
  } catch (error) {
    if (error instanceof SharpApiError && terminalSharpApiCode(error.code))
      await input.accountRate?.terminal(error.code, input.now());
    if (
      error instanceof SharpApiError &&
      !error.retryable &&
      !["rate-limited", "provider-request-ambiguous"].includes(error.code) &&
      !terminalSharpApiCode(error.code)
    ) {
      checkpoint = await pauseCheckpointAfterNonRetryable(
        input.store,
        checkpoint,
        input.now(),
      );
      throw error;
    }
    if (
      error instanceof SharpApiError &&
      ["rate-limited", "provider-request-ambiguous"].includes(error.code)
    ) {
      const priorVersion = checkpoint.version;
      const accountWidePause = error.code === "rate-limited";
      const resumeAfter =
        error.retryAt ??
        new Date(
          input.now().getTime() +
            (error.code === "rate-limited"
              ? DEFAULT_RATE_PAUSE_MS
              : input.refreshMs),
        ).toISOString();
      if (accountWidePause) {
        input.rateGate.deferUntil(resumeAfter);
        await input.accountRate?.rateLimited(resumeAfter, input.now());
      }
      checkpoint = {
        ...checkpoint,
        version: priorVersion + 1,
        updatedAt: input.now().toISOString(),
        resumeAfter,
        pauseScope: accountWidePause ? "account" : "stream",
      };
      await input.store.putCheckpoint(checkpoint, priorVersion);
      input.metrics?.emit("ProviderLandingFailure", 1, {
        stream: "catalog",
        reason: error.code,
      });
      return checkpoint;
    }
    throw error;
  }
  await input.accountRate?.reconcile(2, snapshot.responseMetadata, input.now());
  input.rateGate.observe(snapshot.responseMetadata);
  const eventPartitions = buildSharpApiEventPartitions(snapshot);
  const sealedPage = {
    positionHash: providerLandingPositionHash(
      { stream: "catalog", position: null },
      64,
    ),
    pageHash: digest({
      sports: snapshot.sports,
      leagues: snapshot.leagues,
      quarantines: snapshot.quarantines,
      sourceRows: snapshot.sourceRows,
      providerUpdatedAt: snapshot.providerUpdatedAt ?? null,
      ...(eventPartitions.length > 0 ? { eventPartitions } : {}),
    }),
  };
  if (checkpoint.pendingPage) {
    if (
      checkpoint.pendingPage.positionHash !== sealedPage.positionHash ||
      checkpoint.pendingPage.pageHash !== sealedPage.pageHash
    )
      return restartCheckpointAfterDrift(
        input.store,
        checkpoint,
        input.now(),
        input.metrics,
        "provider-landing-page-replay-drift",
      );
  } else {
    const priorVersion = checkpoint.version;
    checkpoint = {
      ...checkpoint,
      version: priorVersion + 1,
      updatedAt: input.now().toISOString(),
      pendingPage: sealedPage,
      ...(snapshot.providerUpdatedAt
        ? { providerUpdatedAt: snapshot.providerUpdatedAt }
        : {}),
      eventPartitions,
    };
    await input.store.putCheckpoint(checkpoint, priorVersion);
  }
  const records: ProviderLandingRecord[] = [
    ...snapshot.sports.map((sport): ProviderLandingRecord => ({
      schemaVersion: PROVIDER_LANDING_SCHEMA_VERSION,
      providerId: "sharpapi",
      recordType: "catalog-sport",
      recordId: sport.providerSportId,
      sport: sport.providerSportId,
      pageNumber: 1,
      sweepId: checkpoint.sweepId,
      slot: checkpoint.slot,
      retrievedAt: snapshot.retrievedAt,
      value: asValue(sport),
    })),
    ...snapshot.leagues.map((league): ProviderLandingRecord => ({
      schemaVersion: PROVIDER_LANDING_SCHEMA_VERSION,
      providerId: "sharpapi",
      recordType: "catalog-league",
      recordId: league.providerLeagueId,
      sport: league.providerSportId,
      pageNumber: 1,
      sweepId: checkpoint.sweepId,
      slot: checkpoint.slot,
      retrievedAt: snapshot.retrievedAt,
      value: asValue(league),
    })),
    ...snapshot.quarantines.map((quarantine) =>
      quarantineRecord(quarantine, checkpoint, 1, snapshot.retrievedAt),
    ),
  ];
  if (records.length !== snapshot.sourceRows)
    throw new Error("provider-landing-reconciliation-failed");
  let writtenRows = checkpoint.counts.sourceRows;
  const persistedPrefix = records.slice(0, writtenRows);
  const persistedLandedRows = persistedPrefix.filter(
    ({ recordType }) => recordType !== "quarantine",
  ).length;
  const persistedQuarantinedRows = writtenRows - persistedLandedRows;
  if (
    writtenRows > records.length ||
    (writtenRows < records.length &&
      writtenRows % CATALOG_WRITE_CHUNK_SIZE !== 0) ||
    checkpoint.counts.landedRows !== persistedLandedRows ||
    checkpoint.counts.quarantinedRows !== persistedQuarantinedRows
  )
    throw new Error("provider-landing-reconciliation-failed");
  while (writtenRows < records.length && input.shouldContinue()) {
    const chunk = records.slice(
      writtenRows,
      writtenRows + CATALOG_WRITE_CHUNK_SIZE,
    );
    const write = await input.store.putRecords(chunk);
    if (write.crossPageDuplicateCount > 0)
      throw new Error("provider-landing-reconciliation-failed");
    const landedRows = chunk.filter(
      ({ recordType }) => recordType !== "quarantine",
    ).length;
    const quarantinedRows = chunk.length - landedRows;
    const priorVersion = checkpoint.version;
    const counts = {
      pages: 0,
      sourceRows: checkpoint.counts.sourceRows + chunk.length,
      landedRows: checkpoint.counts.landedRows + landedRows,
      quarantinedRows: checkpoint.counts.quarantinedRows + quarantinedRows,
      warningRows: 0,
    };
    checkpoint = {
      ...checkpoint,
      version: priorVersion + 1,
      updatedAt: input.now().toISOString(),
      counts,
    };
    await input.store.putCheckpoint(checkpoint, priorVersion);
    writtenRows += chunk.length;
    if (landedRows > 0)
      input.metrics?.emit("ProviderLandingRows", landedRows, {
        stream: "catalog",
        outcome: "landed",
      });
    if (quarantinedRows > 0)
      input.metrics?.emit("ProviderLandingRows", quarantinedRows, {
        stream: "catalog",
        outcome: "quarantined",
      });
  }
  if (writtenRows < records.length) return checkpoint;
  if (snapshot.sports.length === 0 || snapshot.leagues.length === 0)
    throw new Error("provider-landing-catalog-empty");
  const completedAt = input.now().toISOString();
  const catalogResumeAfter = input.rateGate.canRequest()
    ? undefined
    : input.rateGate.resumeAfter();
  const counts = {
    pages: 2,
    sourceRows: snapshot.sourceRows,
    landedRows: snapshot.sports.length + snapshot.leagues.length,
    quarantinedRows: snapshot.quarantines.length,
    warningRows: 0,
  };
  const committed = withoutTransientPageState(checkpoint);
  checkpoint = {
    ...committed,
    version: checkpoint.version + 1,
    status: "complete",
    position: null,
    updatedAt: completedAt,
    counts,
    lastCompletedSlot: checkpoint.slot,
    lastCompletedSweepId: checkpoint.sweepId,
    lastCompletedAt: completedAt,
    lastCompletedCounts: counts,
    eventPartitions,
    ...(catalogResumeAfter
      ? { resumeAfter: catalogResumeAfter, pauseScope: "account" as const }
      : {}),
  };
  await input.store.putCheckpoint(checkpoint, checkpoint.version - 1);
  input.metrics?.emit("ProviderLandingPage", counts.pages, {
    stream: "catalog",
    outcome: "persisted",
  });
  input.metrics?.emit("ProviderLandingSweep", 1, {
    stream: "catalog",
    outcome: "complete",
  });
  return checkpoint;
};

const recordsForPage = (
  stream: Extract<ProviderLandingStream, "events" | "odds">,
  page:
    | SharpApiUniversalPage<SharpApiUniversalEvent>
    | SharpApiUniversalPage<SharpApiUniversalOddsRecord>,
  checkpoint: ProviderLandingCheckpoint,
  pageNumber: number,
) => [
  ...page.records.map((record): ProviderLandingRecord => ({
    schemaVersion: PROVIDER_LANDING_SCHEMA_VERSION,
    providerId: "sharpapi",
    recordType: stream === "events" ? "event" : "odds",
    recordId:
      stream === "events"
        ? (record as SharpApiUniversalEvent).providerEventId
        : (record as SharpApiUniversalOddsRecord).providerPriceId,
    sport: record.sport,
    pageNumber,
    sweepId: checkpoint.sweepId,
    slot: checkpoint.slot,
    retrievedAt: page.retrievedAt,
    value: asValue(record),
  })),
  ...page.quarantines.map((quarantine) =>
    quarantineRecord(quarantine, checkpoint, pageNumber, page.retrievedAt),
  ),
];

const streamDue = (
  checkpoint: ProviderLandingCheckpoint | null,
  now: Date,
  refreshMs: number,
) =>
  checkpoint?.status === "running" ||
  !checkpoint?.lastCompletedAt ||
  now.getTime() - Date.parse(checkpoint.lastCompletedAt) >= refreshMs;

const runPagedStream = async (input: {
  stream: Extract<ProviderLandingStream, "events" | "odds">;
  source: ProviderLandingSource;
  store: ProviderLandingStore;
  accountRate?: ProviderLandingAccountRateCoordinator;
  prior: ProviderLandingCheckpoint | null;
  now: () => Date;
  refreshMs: number;
  pageBudget: number;
  shouldContinue: () => boolean;
  rateGate: ReturnType<typeof createRateGate>;
  metrics?: ProviderLandingMetricSink;
  eventPartitions?: readonly ProviderLandingEventPartition[];
}) => {
  if (!streamDue(input.prior, input.now(), input.refreshMs))
    return input.prior!;
  let checkpoint = await startCheckpoint(
    input.store,
    input.stream,
    input.prior,
    input.now(),
    input.eventPartitions,
  );
  if (
    input.stream === "events" &&
    input.eventPartitions &&
    (checkpoint.eventPartitions === undefined ||
      !checkpoint.position ||
      !("partition" in checkpoint.position) ||
      (checkpoint.pauseScope === "stream" &&
        JSON.stringify(checkpoint.eventPartitions) !==
          JSON.stringify(input.eventPartitions)))
  )
    checkpoint = await restartCheckpointAfterDrift(
      input.store,
      checkpoint,
      input.now(),
      input.metrics,
      "provider-landing-event-plan-migrated",
      input.eventPartitions,
    );
  if (
    input.stream === "odds" &&
    checkpoint.status === "running" &&
    checkpoint.pauseScope === "stream" &&
    checkpoint.position &&
    "cursor" in checkpoint.position &&
    checkpoint.position.cursor !== INITIAL_CURSOR
  )
    checkpoint = await restartCheckpointAfterDrift(
      input.store,
      checkpoint,
      input.now(),
      input.metrics,
      "provider-landing-cursor-rejected",
    );
  if (
    checkpoint.resumeAfter &&
    input.now().getTime() < Date.parse(checkpoint.resumeAfter)
  )
    return checkpoint;
  let pagesThisInvocation = 0;
  while (
    pagesThisInvocation < input.pageBudget &&
    input.shouldContinue() &&
    input.rateGate.canRequest()
  ) {
    const claim = await input.store.claimPosition({
      stream: input.stream,
      sweepId: checkpoint.sweepId,
      slot: checkpoint.slot,
      positionHash: positionHash(checkpoint).slice(0, 32),
      pageNumber: checkpoint.counts.pages + 1,
      claimedAt: input.now().toISOString(),
    });
    if (claim === "cycle")
      return restartCheckpointAfterDrift(
        input.store,
        checkpoint,
        input.now(),
        input.metrics,
        "provider-landing-pagination-cycle",
      );
    const reservation = await reservePaidRequest({
      ...(input.accountRate ? { accountRate: input.accountRate } : {}),
      store: input.store,
      checkpoint,
      stream: input.stream,
      cost: 1,
      now: input.now,
      ...(input.metrics ? { metrics: input.metrics } : {}),
    });
    checkpoint = reservation.checkpoint;
    if (!reservation.admitted) return checkpoint;
    let page:
      | SharpApiUniversalPage<SharpApiUniversalEvent>
      | SharpApiUniversalPage<SharpApiUniversalOddsRecord>;
    try {
      page =
        input.stream === "events"
          ? await input.source.fetchEvents(
              checkpoint.eventPartitions![
                checkpoint.position && "partition" in checkpoint.position
                  ? checkpoint.position.partition
                  : 0
              ]!,
              checkpoint.position && "offset" in checkpoint.position
                ? checkpoint.position.offset
                : 0,
            )
          : await input.source.fetchOdds(
              checkpoint.position && "cursor" in checkpoint.position
                ? checkpoint.position.cursor === INITIAL_CURSOR
                  ? undefined
                  : checkpoint.position.cursor
                : undefined,
            );
    } catch (error) {
      if (error instanceof SharpApiError && terminalSharpApiCode(error.code))
        await input.accountRate?.terminal(error.code, input.now());
      if (
        input.stream === "odds" &&
        error instanceof SharpApiError &&
        error.code === "provider-rejected" &&
        checkpoint.position &&
        "cursor" in checkpoint.position &&
        checkpoint.position.cursor !== INITIAL_CURSOR
      )
        return restartCheckpointAfterDrift(
          input.store,
          checkpoint,
          input.now(),
          input.metrics,
          "provider-landing-cursor-rejected",
        );
      if (
        error instanceof SharpApiError &&
        !error.retryable &&
        !["rate-limited", "provider-request-ambiguous"].includes(error.code) &&
        !terminalSharpApiCode(error.code)
      ) {
        checkpoint = await pauseCheckpointAfterNonRetryable(
          input.store,
          checkpoint,
          input.now(),
        );
        throw error;
      }
      if (
        error instanceof SharpApiError &&
        ["rate-limited", "provider-request-ambiguous"].includes(error.code)
      ) {
        const priorVersion = checkpoint.version;
        const accountWidePause = error.code === "rate-limited";
        const resumeAfter =
          error.retryAt ??
          new Date(
            input.now().getTime() +
              (error.code === "rate-limited"
                ? DEFAULT_RATE_PAUSE_MS
                : input.refreshMs),
          ).toISOString();
        if (accountWidePause) {
          input.rateGate.deferUntil(resumeAfter);
          await input.accountRate?.rateLimited(resumeAfter, input.now());
        }
        checkpoint = {
          ...checkpoint,
          version: priorVersion + 1,
          updatedAt: input.now().toISOString(),
          resumeAfter,
          pauseScope: accountWidePause ? "account" : "stream",
        };
        await input.store.putCheckpoint(checkpoint, priorVersion);
        input.metrics?.emit("ProviderLandingFailure", 1, {
          stream: input.stream,
          reason: error.code,
        });
        return checkpoint;
      }
      throw error;
    }
    await input.accountRate?.reconcile(1, page.responseMetadata, input.now());
    input.rateGate.observe(page.responseMetadata);
    if (input.stream === "events" && page.providerTotal === undefined)
      return restartCheckpointAfterDrift(
        input.store,
        checkpoint,
        input.now(),
        input.metrics,
        "provider-landing-total-missing",
      );
    if (
      input.stream === "events" &&
      page.providerTotal! > MAX_ACCESSIBLE_EVENT_PARTITION_ROWS
    ) {
      const partitionIndex =
        checkpoint.position && "partition" in checkpoint.position
          ? checkpoint.position.partition
          : 0;
      const partition = checkpoint.eventPartitions![partitionIndex]!;
      const members = partition.leagues;
      if (!members || members.length === 1)
        throw new Error("provider-landing-event-partition-too-large");
      const midpoint = Math.ceil(members.length / 2);
      const replacement = [
        { ...partition, leagues: members.slice(0, midpoint) },
        { ...partition, leagues: members.slice(midpoint) },
      ];
      const eventPartitions = checkpoint.eventPartitions!.flatMap(
        (filter, index) => (index === partitionIndex ? replacement : [filter]),
      );
      return restartCheckpointAfterDrift(
        input.store,
        checkpoint,
        input.now(),
        input.metrics,
        "provider-landing-event-partition-split",
        eventPartitions,
      );
    }
    const currentPositionHash = positionHash(checkpoint);
    const sealedPage = {
      positionHash: currentPositionHash,
      pageHash: pageHash(page),
    };
    if (checkpoint.pendingPage) {
      if (
        checkpoint.pendingPage.positionHash !== sealedPage.positionHash ||
        checkpoint.pendingPage.pageHash !== sealedPage.pageHash
      )
        return restartCheckpointAfterDrift(
          input.store,
          checkpoint,
          input.now(),
          input.metrics,
          "provider-landing-page-replay-drift",
        );
    } else {
      const priorVersion = checkpoint.version;
      checkpoint = {
        ...withCurrentPageMetadata(checkpoint, page),
        version: priorVersion + 1,
        updatedAt: input.now().toISOString(),
        pendingPage: sealedPage,
      };
      await input.store.putCheckpoint(checkpoint, priorVersion);
    }
    const pageNumber = checkpoint.counts.pages + 1;
    const eventPartitionSourceRows =
      (checkpoint.eventPartitionSourceRows ?? 0) + page.sourceRows;
    if (
      page.providerTotal !== undefined &&
      (input.stream === "events"
        ? eventPartitionSourceRows
        : checkpoint.counts.sourceRows + page.sourceRows) > page.providerTotal
    )
      return restartCheckpointAfterDrift(
        input.store,
        checkpoint,
        input.now(),
        input.metrics,
        "provider-landing-total-mismatch",
      );
    const write = await input.store.putRecords(
      recordsForPage(input.stream, page, checkpoint, pageNumber),
    );
    const warnings = warningRows(page.records);
    const counts = {
      pages: pageNumber,
      sourceRows: checkpoint.counts.sourceRows + page.sourceRows,
      landedRows:
        checkpoint.counts.landedRows +
        page.records.length -
        write.crossPageDuplicateCount,
      quarantinedRows:
        checkpoint.counts.quarantinedRows +
        page.quarantines.length +
        write.crossPageDuplicateCount,
      warningRows: (checkpoint.counts.warningRows ?? 0) + warnings,
    };
    if (counts.sourceRows !== counts.landedRows + counts.quarantinedRows)
      throw new Error("provider-landing-reconciliation-failed");
    const updatedAt = input.now().toISOString();
    const priorVersion = checkpoint.version;
    const effectiveTotal = page.providerTotal;
    const committed = withCurrentPageMetadata(
      withoutTransientPageState(checkpoint),
      page,
    );
    if (!page.hasMore) {
      if (
        effectiveTotal !== undefined &&
        (input.stream === "events"
          ? eventPartitionSourceRows
          : counts.sourceRows) !== effectiveTotal
      )
        return restartCheckpointAfterDrift(
          input.store,
          checkpoint,
          input.now(),
          input.metrics,
          "provider-landing-total-mismatch",
        );
      const currentPartition =
        checkpoint.position && "partition" in checkpoint.position
          ? checkpoint.position.partition
          : 0;
      if (
        input.stream === "events" &&
        currentPartition + 1 < checkpoint.eventPartitions!.length
      ) {
        const position = { partition: currentPartition + 1, offset: 0 };
        const nextPositionHash = providerLandingPositionHash({
          stream: input.stream,
          position,
        });
        const nextCheckpoint = {
          ...committed,
          version: priorVersion + 1,
          status: "running" as const,
          position,
          updatedAt,
          counts,
          eventPartitionSourceRows: 0,
          visitedPositionHashes: advancePositionHistory(
            checkpoint.visitedPositionHashes ?? [],
            nextPositionHash,
          ),
        };
        delete nextCheckpoint.providerTotal;
        checkpoint = nextCheckpoint;
      } else {
        const completedCheckpoint = {
          ...committed,
          version: priorVersion + 1,
          status: "complete" as const,
          position: null,
          updatedAt,
          counts,
          ...(effectiveTotal === undefined
            ? {}
            : { providerTotal: effectiveTotal }),
          lastCompletedSlot: checkpoint.slot,
          lastCompletedSweepId: checkpoint.sweepId,
          lastCompletedAt: updatedAt,
          lastCompletedCounts: counts,
        };
        // Event partitions each have their own exact denominator. Retaining
        // only the last partition's total beside all-partition counts would
        // falsely present it as a provider-wide total. Equality for every
        // partition has already been enforced before reaching this commit.
        if (input.stream === "events") delete completedCheckpoint.providerTotal;
        delete completedCheckpoint.eventPartitionSourceRows;
        checkpoint = completedCheckpoint;
      }
    } else {
      const position =
        input.stream === "events"
          ? page.nextOffset === undefined
            ? null
            : {
                partition:
                  checkpoint.position && "partition" in checkpoint.position
                    ? checkpoint.position.partition
                    : 0,
                offset: page.nextOffset,
              }
          : page.nextCursor === undefined
            ? null
            : { cursor: page.nextCursor };
      if (!position) throw new Error("provider-landing-pagination-invalid");
      if (
        input.stream === "events" &&
        checkpoint.position &&
        "offset" in checkpoint.position &&
        "offset" in position &&
        position.offset !== checkpoint.position.offset + 200
      )
        throw new Error("provider-landing-pagination-invalid");
      const nextPositionHash = providerLandingPositionHash({
        stream: input.stream,
        position,
      });
      const visited = checkpoint.visitedPositionHashes ?? [];
      const resumeAfter = input.rateGate.canRequest()
        ? undefined
        : input.rateGate.resumeAfter();
      checkpoint = {
        ...committed,
        version: priorVersion + 1,
        status: "running",
        position,
        updatedAt,
        counts,
        ...(input.stream === "events" ? { eventPartitionSourceRows } : {}),
        visitedPositionHashes: advancePositionHistory(
          visited,
          nextPositionHash,
        ),
        ...(effectiveTotal === undefined
          ? {}
          : { providerTotal: effectiveTotal }),
        ...(resumeAfter ? { resumeAfter } : {}),
        ...(resumeAfter ? { pauseScope: "account" as const } : {}),
      };
    }
    await input.store.putCheckpoint(checkpoint, priorVersion);
    pagesThisInvocation += 1;
    emitRows(
      input.metrics,
      input.stream,
      page.records.length - write.crossPageDuplicateCount,
      page.quarantines.length + write.crossPageDuplicateCount,
      warnings,
    );
    if (checkpoint.status === "complete") {
      input.metrics?.emit("ProviderLandingSweep", 1, {
        stream: input.stream,
        outcome: "complete",
      });
      return checkpoint;
    }
  }
  const gatedResumeAfter = input.rateGate.canRequest()
    ? undefined
    : input.rateGate.resumeAfter();
  if (
    checkpoint.status === "running" &&
    gatedResumeAfter &&
    checkpoint.resumeAfter !== gatedResumeAfter
  ) {
    const priorVersion = checkpoint.version;
    checkpoint = {
      ...checkpoint,
      version: priorVersion + 1,
      updatedAt: input.now().toISOString(),
      resumeAfter: gatedResumeAfter,
      pauseScope: "account",
    };
    await input.store.putCheckpoint(checkpoint, priorVersion);
  }
  return checkpoint;
};

const emitCheckpointAges = (
  metrics: ProviderLandingMetricSink | undefined,
  now: Date,
  checkpoints: readonly (ProviderLandingCheckpoint | null | undefined)[],
) => {
  for (const checkpoint of checkpoints) {
    if (!checkpoint) continue;
    const completionBoundary =
      checkpoint.lastCompletedAt ?? checkpoint.startedAt;
    metrics?.emit(
      "ProviderLandingCompletionAgeSeconds",
      Math.max(0, (now.getTime() - Date.parse(completionBoundary)) / 1_000),
      { stream: checkpoint.stream, outcome: "observed" },
    );
    metrics?.emit(
      "ProviderLandingRunAgeSeconds",
      checkpoint.status === "running"
        ? Math.max(
            0,
            (now.getTime() - Date.parse(checkpoint.startedAt)) / 1_000,
          )
        : 0,
      { stream: checkpoint.stream, outcome: checkpoint.status },
    );
  }
};

const emitCheckpointQualityEvidence = (
  metrics: ProviderLandingMetricSink | undefined,
  checkpoints: readonly (ProviderLandingCheckpoint | null)[],
) => {
  for (const checkpoint of checkpoints) {
    if (!checkpoint) continue;
    if (checkpoint.counts.quarantinedRows > 0)
      metrics?.emit("ProviderLandingRows", checkpoint.counts.quarantinedRows, {
        stream: checkpoint.stream,
        outcome: "quarantined",
      });
    const warnings = checkpoint.counts.warningRows ?? 0;
    if (warnings > 0)
      metrics?.emit("ProviderLandingRows", warnings, {
        stream: checkpoint.stream,
        outcome: "warning",
      });
  }
};

export const runProviderLanding = async (
  input: ProviderLandingRunInput,
): Promise<ProviderLandingRunSummary> => {
  const now = input.now ?? (() => new Date());
  const [catalogPrior, eventsPrior, oddsPrior] = await Promise.all([
    input.store.getCheckpoint("catalog"),
    input.store.getCheckpoint("events"),
    input.store.getCheckpoint("odds"),
  ]);
  emitCheckpointQualityEvidence(input.metrics, [
    catalogPrior,
    eventsPrior,
    oddsPrior,
  ]);
  const summary: {
    catalog?: ProviderLandingCheckpoint;
    events?: ProviderLandingCheckpoint;
    odds?: ProviderLandingCheckpoint;
  } = {};
  const failures: { stream: ProviderLandingStream; error: unknown }[] = [];
  const rateGate = createRateGate(now);
  for (const checkpoint of [catalogPrior, eventsPrior, oddsPrior])
    if (checkpoint?.pauseScope === "account")
      rateGate.deferUntil(checkpoint.resumeAfter);
  try {
    summary.catalog = await runCatalog({
      source: input.source,
      store: input.store,
      ...(input.accountRate ? { accountRate: input.accountRate } : {}),
      prior: catalogPrior,
      now,
      refreshMs: input.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS,
      shouldContinue: input.shouldContinue ?? (() => true),
      rateGate,
      ...(input.metrics ? { metrics: input.metrics } : {}),
    });
  } catch (error) {
    failures.push({ stream: "catalog", error });
  }
  const catalogFailure = failures[0]?.error;
  if (accountGlobalProviderFailure(catalogFailure)) {
    input.metrics?.emit("ProviderLandingFailure", 1, {
      stream: "catalog",
      reason:
        catalogFailure instanceof SharpApiError
          ? catalogFailure.code
          : catalogFailure instanceof Error
            ? catalogFailure.message
            : "unexpected",
    });
    emitCheckpointAges(input.metrics, now(), [
      catalogPrior,
      eventsPrior,
      oddsPrior,
    ]);
    throw catalogFailure;
  }
  const shouldContinue = input.shouldContinue ?? (() => true);
  const completedCatalog =
    summary.catalog?.status === "complete"
      ? summary.catalog
      : catalogPrior?.status === "complete"
        ? catalogPrior
        : null;
  const eventPartitions =
    completedCatalog?.eventPartitions ??
    (eventsPrior?.status === "running"
      ? eventsPrior.eventPartitions
      : undefined);
  const states: Record<
    Extract<ProviderLandingStream, "events" | "odds">,
    ProviderLandingCheckpoint | null
  > = { events: eventsPrior, odds: oddsPrior };
  const remaining = {
    events: input.eventPageBudget ?? 200,
    odds: input.oddsPageBudget ?? 800,
  };
  const inactive = new Set<Extract<ProviderLandingStream, "events" | "odds">>();
  if (!eventPartitions) inactive.add("events");
  while (
    shouldContinue() &&
    rateGate.canRequest() &&
    [...Object.values(remaining)].some((value) => value > 0) &&
    inactive.size < 2
  ) {
    let progressed = false;
    for (const stream of ["events", "odds"] as const) {
      if (
        inactive.has(stream) ||
        remaining[stream] <= 0 ||
        !shouldContinue() ||
        !rateGate.canRequest()
      )
        continue;
      const prior = states[stream];
      try {
        const checkpoint = await runPagedStream({
          stream,
          source: input.source,
          store: input.store,
          ...(input.accountRate ? { accountRate: input.accountRate } : {}),
          prior,
          now,
          refreshMs: input.streamRefreshMs ?? DEFAULT_STREAM_REFRESH_MS,
          pageBudget: 1,
          shouldContinue,
          rateGate,
          ...(stream === "events" && eventPartitions
            ? { eventPartitions }
            : {}),
          ...(input.metrics ? { metrics: input.metrics } : {}),
        });
        states[stream] = checkpoint;
        summary[stream] = checkpoint;
        const pageAdvanced =
          checkpoint.sweepId === prior?.sweepId
            ? checkpoint.counts.pages > (prior?.counts.pages ?? 0)
            : checkpoint.counts.pages > 0;
        if (pageAdvanced) {
          remaining[stream] -= 1;
          progressed = true;
        }
        if (
          !pageAdvanced ||
          checkpoint.status === "complete" ||
          (checkpoint.resumeAfter !== undefined &&
            now().getTime() < Date.parse(checkpoint.resumeAfter))
        )
          inactive.add(stream);
      } catch (error) {
        failures.push({ stream, error });
        inactive.add(stream);
        if (accountGlobalProviderFailure(error)) {
          inactive.add("events");
          inactive.add("odds");
          break;
        }
      }
    }
    if (!progressed) break;
  }
  for (const failure of failures)
    input.metrics?.emit("ProviderLandingFailure", 1, {
      stream: failure.stream,
      reason:
        failure.error instanceof Error &&
        SAFE_FAILURE_REASONS.has(failure.error.message)
          ? failure.error.message
          : "unexpected",
    });
  emitCheckpointAges(input.metrics, now(), [
    summary.catalog ?? catalogPrior,
    summary.events ?? eventsPrior,
    summary.odds ?? oddsPrior,
  ]);
  if (failures.length > 0) throw failures[0]!.error;
  return summary;
};
