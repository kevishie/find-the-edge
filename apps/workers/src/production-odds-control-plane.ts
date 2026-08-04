import type {
  BettingSplitRepository,
  EventIngestionStore,
  OddsControlPlaneStore,
  OddsAttemptRecord,
  OddsRunContinuation,
  SealedOddsPage,
} from "@find-the-edge/database";
import { randomUUID } from "node:crypto";
import type { LiveOddsPersister } from "./live-odds-ingestion";
import { reconcileScheduledProviderEvent } from "./schedule-reconciliation";

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
const assertAndRenewOwner = async (
  store: OddsControlPlaneStore,
  continuationKey: string,
  runId: string,
  ownerId: string,
  clock: () => Date,
) => {
  const current = await store.getContinuation(continuationKey);
  const now = clock();
  if (current?.ambiguousUntil) throw new Error("provider-request-ambiguous");
  if (
    !current ||
    current.runId !== runId ||
    current.ownerId !== ownerId ||
    !current.leaseUntil ||
    Date.parse(current.leaseUntil) <= now.getTime()
  )
    throw new Error("run-owned");
  await store.putContinuation({
    ...current,
    updatedAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + 300_000).toISOString(),
  });
};
const sealPaidPage = async (
  store: OddsControlPlaneStore,
  page: SealedOddsPage,
  attempt: OddsAttemptRecord,
  continuation: OddsRunContinuation,
) => {
  try {
    await store.sealPage(page);
  } catch {
    await store.completeAttempt({
      ...attempt,
      completedAt: attempt.requestedAt,
      state: "ambiguous",
      quotaCost: page.quotaCost,
      failureReason: "provider-response-unsealed",
    });
    await putContinuationCas(store, {
      ...continuation,
      updatedAt: attempt.requestedAt,
      ambiguousUntil: attempt.leaseUntil ?? attempt.requestedAt,
    });
    throw new Error("provider-response-unsealed");
  }
};
const isAmbiguousTransport = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" ||
    /timeout|timed out|socket|network|econn|ambiguous|run-owned/i.test(
      error.message,
    ));
import {
  oddsCollectionPolicyVersion,
  productionOddsCollectionPolicies,
  productionScheduleDiscoveryPolicies,
} from "@find-the-edge/config";
import {
  sha256Hex,
  type IsoTimestamp,
  type OddsEvidenceGap,
} from "@find-the-edge/domain";
import {
  SHARP_API_PROVIDER_ID,
  THE_ODDS_API_PROVIDER_ID,
  fetchSharpApiOddsPage,
  fetchSharpApiAccount,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  fetchTheOddsApi,
  fetchTheOddsApiEvents,
  sharpApiLeagues,
  theOddsApiLeagues,
  type SharpApiOddsPage,
  type SharpApiSchedulePage,
  type TheOddsApiResult,
} from "@find-the-edge/providers";
import {
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
} from "./sharp-api-ingestion";
import { persistTheOddsApiPage } from "./live-odds-ingestion";
import {
  runDueOddsLeagues,
  withPaidLeaseHeartbeat,
  type ControlPlaneProvider,
  type OddsControlPlaneMetrics,
} from "./odds-control-plane";

interface SharpPageMaterial {
  readonly kind: "sharpapi";
  readonly page: SharpApiOddsPage;
}
interface FallbackPageMaterial {
  readonly kind: "the-odds-api";
  readonly page: TheOddsApiResult;
}
type PageMaterial = SharpPageMaterial | FallbackPageMaterial;

const digest = (value: unknown) => sha256Hex(JSON.stringify(value));
const capabilityFailure = (error: unknown) => {
  const reason = error instanceof Error ? error.message : "provider-error";
  if (reason.includes("pagination")) return "pagination-invalid";
  if (reason.includes("mapping")) return "mapping-quarantine";
  if (reason.includes("transition-conflict")) return "transition-conflict";
  if (reason === "quota-reserve") return reason;
  if (reason === "provider-request-ambiguous") return reason;
  return "provider-error";
};
export const evidenceGaps = (
  runId: string,
  providerId: string,
  leagueKey: string,
  events: readonly {
    readonly providerEventId: string;
    readonly bookmakers: readonly {
      readonly id: string;
      readonly prices: readonly {
        readonly marketKey: string;
        readonly isLive?: boolean;
        readonly isMainLine?: boolean;
        readonly isAlternateLine?: boolean;
        readonly isPlayerProp?: boolean;
        readonly isStalePregamePrice?: boolean;
        readonly isSuspended?: boolean;
        readonly isClosed?: boolean;
        readonly isUnsupported?: boolean;
      }[];
    }[];
  }[],
  markets: readonly string[],
  configuredBooks: Readonly<
    Record<string, "offered" | "comparison" | "splits">
  >,
  observedAt: string,
  expectedProviderEventIds: readonly string[] = [],
): OddsEvidenceGap[] => {
  const gaps: OddsEvidenceGap[] = [];
  const eventById = new Map(
    events.map((event) => [event.providerEventId, event]),
  );
  const expected = new Set([...expectedProviderEventIds, ...eventById.keys()]);
  for (const providerEventId of expected)
    for (const [sportsbookId, bookRole] of Object.entries(configuredBooks))
      for (const marketKey of markets) {
        const event = eventById.get(providerEventId);
        const book = event?.bookmakers.find(({ id }) => id === sportsbookId);
        const prices =
          book?.prices.filter((price) => price.marketKey === marketKey) ?? [];
        const active = prices.filter(
          (price) =>
            price.isLive !== true &&
            price.isAlternateLine !== true &&
            price.isPlayerProp !== true &&
            price.isStalePregamePrice !== true &&
            price.isSuspended !== true &&
            price.isClosed !== true &&
            price.isUnsupported !== true &&
            price.isMainLine !== false,
        );
        if (active.length > 0) continue;
        const state = prices.some((price) => price.isUnsupported === true)
          ? "unsupported"
          : prices.some((price) => price.isClosed === true)
            ? "closed"
            : prices.some((price) => price.isSuspended === true)
              ? "suspended"
              : prices.some((price) => price.isStalePregamePrice === true)
                ? "stale"
                : prices.length > 0
                  ? "partial"
                  : "missing";
        gaps.push({
          gapId: sha256Hex(
            JSON.stringify([
              runId,
              providerId,
              providerEventId,
              sportsbookId,
              marketKey,
              state,
            ]),
          ),
          runId,
          leagueKey,
          providerId,
          providerEventId,
          marketKey,
          sportsbookId,
          policyVersion: oddsCollectionPolicyVersion,
          bookRole,
          sourceState: state,
          reason: state,
          observedAt,
        });
      }
  return gaps;
};
const scheduleEvent = (
  providerId: string,
  league: { readonly sportKey: string; readonly leagueKey: string },
  raw: {
    readonly providerEventId: string;
    readonly awayTeam: string;
    readonly homeTeam: string;
    readonly startsAt: IsoTimestamp;
  },
  observedAt: IsoTimestamp,
) => ({
  providerEventId: raw.providerEventId,
  sportKey: league.sportKey as never,
  leagueKey: league.leagueKey,
  participantLabels: [raw.awayTeam, raw.homeTeam] as [string, string],
  startsAt: raw.startsAt,
  status: "scheduled" as const,
  revision: {
    providerId,
    authorityRank: providerId === SHARP_API_PROVIDER_ID ? 60 : 50,
    updatedAt: observedAt,
    sequence: 0,
    token: observedAt,
  },
});

async function bindScheduleEvent(
  store: EventIngestionStore,
  providerId: string,
  league: { readonly sportKey: string; readonly leagueKey: string },
  raw: Parameters<typeof scheduleEvent>[2],
  observedAt: IsoTimestamp,
) {
  const event = scheduleEvent(providerId, league, raw, observedAt);
  const result = await reconcileScheduledProviderEvent(
    store,
    providerId,
    event,
    observedAt,
  );
  if (result.kind === "unresolved")
    throw new Error("schedule-mapping-unresolved");
}

export async function runProductionOddsControlPlane(input: {
  readonly events: EventIngestionStore;
  readonly odds: LiveOddsPersister;
  readonly control: OddsControlPlaneStore;
  readonly splits: BettingSplitRepository;
  readonly sharpApiKey: string;
  readonly theOddsApiKey: string;
  readonly now?: Date;
  readonly forceRefresh?: boolean;
  readonly clock?: () => Date;
  readonly metrics?: OddsControlPlaneMetrics;
  readonly fetchSharpSchedule?: typeof fetchSharpApiSchedulePage;
  readonly fetchSharpOdds?: typeof fetchSharpApiOddsPage;
  readonly fetchSharpAccount?: typeof fetchSharpApiAccount;
  readonly fetchSharpSplits?: typeof fetchSharpApiSplitsPage;
  readonly fetchFallbackSchedule?: typeof fetchTheOddsApiEvents;
  readonly fetchFallbackOdds?: typeof fetchTheOddsApi;
  readonly heartbeatIntervalMs?: number;
}) {
  const ownerId = randomUUID();
  const now = input.now ?? new Date();
  const liveNow = input.clock ?? (() => new Date());
  const paidCall = <T>(
    continuationKey: string,
    runId: string,
    call: () => Promise<T>,
  ) =>
    withPaidLeaseHeartbeat(
      call,
      () =>
        assertAndRenewOwner(
          input.control,
          continuationKey,
          runId,
          ownerId,
          liveNow,
        ),
      input.heartbeatIntervalMs,
    );
  const clearOwned = async (continuationKey: string, runId: string) => {
    const current = await input.control.getContinuation(continuationKey);
    if (!current) return;
    if (current.runId !== runId || current.ownerId !== ownerId)
      throw new Error("continuation-transition-conflict");
    await input.control.clearContinuation(
      continuationKey,
      runId,
      ownerId,
      current.version,
    );
  };
  const starts = new Map<string, string[]>();
  const expectedProviderEvents = new Map<string, string[]>();
  const sharpScheduleHealthy = new Set<string>();
  const scheduleReady = new Set<string>();
  const storedScheduleReady = new Set<string>();
  for (const sharpLeague of sharpApiLeagues) {
    let activeScheduleRunId: string | undefined;
    let scheduleQuotaCost = 0;
    try {
      const schedulePolicy = productionScheduleDiscoveryPolicies.find(
        ({ providerId }) => providerId === SHARP_API_PROVIDER_ID,
      )!;
      const scheduleHealth = await input.control.getHealth(
        `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`,
      );
      if (
        scheduleHealth?.quotaRemaining !== undefined &&
        scheduleHealth.quotaRemaining <= schedulePolicy.quotaReserve
      )
        throw new Error("quota-reserve");
      const checkpointKey = `schedule:${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`;
      const checkpoint = await input.control.getCheckpoint(checkpointKey);
      if (
        checkpoint?.expectedProviderEvents?.some(
          ({ startsAt }) => Date.parse(startsAt) > now.getTime(),
        )
      )
        storedScheduleReady.add(
          `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
        );
      if (checkpoint?.upcomingStarts)
        starts.set(
          sharpLeague.leagueKey,
          checkpoint.upcomingStarts.filter(
            (start) => Date.parse(start) > now.getTime(),
          ),
        );
      if (checkpoint?.expectedProviderEvents)
        expectedProviderEvents.set(
          `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
          checkpoint.expectedProviderEvents
            .filter(({ startsAt }) => Date.parse(startsAt) > now.getTime())
            .map(({ providerEventId }) => providerEventId),
        );
      const existingContinuation =
        await input.control.getContinuation(checkpointKey);
      if (existingContinuation?.ambiguousUntil)
        throw new Error("provider-request-ambiguous");
      scheduleQuotaCost = existingContinuation?.quotaCost ?? 0;
      if (
        !input.forceRefresh &&
        !existingContinuation &&
        checkpoint &&
        Date.parse(checkpoint.nextDueAt) > now.getTime()
      ) {
        sharpScheduleHealthy.add(sharpLeague.leagueKey);
        scheduleReady.add(`${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`);
        continue;
      }
      const claimNow = liveNow();
      const continuation = await input.control.claimContinuation({
        ...existingContinuation,
        leagueKey: checkpointKey,
        runId:
          existingContinuation?.runId ??
          `schedule:${sharpLeague.leagueKey}:${now.toISOString()}`,
        providerId: SHARP_API_PROVIDER_ID,
        updatedAt: claimNow.toISOString(),
        startedAt: claimNow.toISOString(),
        capability: "schedule",
        evidenceCommitted: false,
        quotaCost: existingContinuation?.quotaCost ?? 0,
        ownerId,
        leaseUntil: new Date(claimNow.getTime() + 300_000).toISOString(),
      });
      if (continuation.ownerId !== ownerId) throw new Error("run-owned");
      const runId = continuation.runId;
      activeScheduleRunId = runId;
      await input.control.putRun({
        ...((await input.control.getRun(runId)) ?? {}),
        runId,
        leagueKey: sharpLeague.leagueKey,
        providerId: SHARP_API_PROVIDER_ID,
        policyVersion: oddsCollectionPolicyVersion,
        status: "running",
        startedAt: continuation?.startedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        evidenceCommitted: continuation?.evidenceCommitted ?? false,
        quotaCost: continuation?.quotaCost ?? 0,
      });
      await putContinuationCas(input.control, {
        leagueKey: checkpointKey,
        runId,
        providerId: SHARP_API_PROVIDER_ID,
        updatedAt: now.toISOString(),
        startedAt: continuation?.startedAt ?? now.toISOString(),
        capability: "schedule",
        evidenceCommitted: continuation?.evidenceCommitted ?? false,
        quotaCost: continuation?.quotaCost ?? 0,
      });
      let offset = 0;
      let scheduleComplete = false;
      for (let guard = 0; guard < 20; guard += 1) {
        const pageToken = String(offset);
        let sealed = await input.control.getPage(runId, pageToken);
        if (!sealed) {
          await assertAndRenewOwner(
            input.control,
            checkpointKey,
            runId,
            ownerId,
            liveNow,
          );
          const attemptId = `${runId}:${pageToken}:${now.toISOString()}:${guard}`;
          if (
            !(await input.control.reserveQuotaAttempt(
              `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`,
              schedulePolicy.quotaReserve,
              schedulePolicy.requestCost,
              {
                attemptId,
                runId,
                pageToken,
                requestedAt: liveNow().toISOString(),
                leaseUntil: new Date(
                  liveNow().getTime() + 300_000,
                ).toISOString(),
                state: "reserved",
                providerId: SHARP_API_PROVIDER_ID,
                leagueKey: sharpLeague.leagueKey,
                capability: "schedule",
              },
            ))
          )
            throw new Error("schedule-attempt-reservation-conflict");
          scheduleQuotaCost += schedulePolicy.requestCost;
          let fetched: SharpApiSchedulePage;
          try {
            fetched = await paidCall(checkpointKey, runId, () =>
              (input.fetchSharpSchedule ?? fetchSharpApiSchedulePage)(
                sharpLeague,
                input.sharpApiKey,
                offset,
              ),
            );
          } catch (error) {
            const ambiguous = isAmbiguousTransport(error);
            await input.control.completeAttempt({
              attemptId,
              runId,
              pageToken,
              requestedAt: liveNow().toISOString(),
              completedAt: now.toISOString(),
              quotaCost: schedulePolicy.requestCost,
              state: ambiguous ? "ambiguous" : "failed",
              failureReason: ambiguous
                ? "provider-request-ambiguous"
                : "provider-unavailable",
            });
            if (ambiguous)
              await putContinuationCas(input.control, {
                ...continuation,
                leagueKey: checkpointKey,
                runId,
                providerId: SHARP_API_PROVIDER_ID,
                updatedAt: now.toISOString(),
                ambiguousUntil: new Date(
                  liveNow().getTime() + 300_000,
                ).toISOString(),
              });
            if (ambiguous) throw new Error("provider-request-ambiguous");
            throw new Error("provider-unavailable");
          }
          sealed = {
            runId,
            pageToken,
            ...(fetched.hasMore && fetched.nextOffset !== undefined
              ? { nextPageToken: String(fetched.nextOffset) }
              : {}),
            responseDigest: digest(fetched),
            normalizedItems: [fetched],
            gaps: [],
            quotaCost: schedulePolicy.requestCost,
            sealedAt: now.toISOString(),
          };
          await assertAndRenewOwner(
            input.control,
            checkpointKey,
            runId,
            ownerId,
            liveNow,
          );
          await sealPaidPage(
            input.control,
            sealed,
            {
              attemptId,
              runId,
              pageToken,
              requestedAt: liveNow().toISOString(),
              leaseUntil: new Date(liveNow().getTime() + 300_000).toISOString(),
            },
            continuation,
          );
          await input.control.completeAttempt({
            attemptId,
            runId,
            pageToken,
            requestedAt: liveNow().toISOString(),
            completedAt: now.toISOString(),
            quotaCost: schedulePolicy.requestCost,
          });
        }
        const page = sealed.normalizedItems[0] as SharpApiSchedulePage;
        for (const event of page.events) {
          await bindScheduleEvent(
            input.events,
            SHARP_API_PROVIDER_ID,
            sharpLeague,
            event,
            page.retrievedAt,
          );
          starts.set(sharpLeague.leagueKey, [
            ...(starts.get(sharpLeague.leagueKey) ?? []),
            event.startsAt,
          ]);
          expectedProviderEvents.set(
            `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
            [
              ...(expectedProviderEvents.get(
                `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
              ) ?? []),
              event.providerEventId,
            ],
          );
        }
        await assertAndRenewOwner(
          input.control,
          checkpointKey,
          runId,
          ownerId,
          liveNow,
        );
        if (!sealed.committedAt)
          await input.control.commitEvidencePage(
            runId,
            pageToken,
            now.toISOString(),
          );
        await putContinuationCas(input.control, {
          leagueKey: checkpointKey,
          runId,
          providerId: SHARP_API_PROVIDER_ID,
          updatedAt: now.toISOString(),
          startedAt: continuation?.startedAt ?? now.toISOString(),
          capability: "schedule",
          evidenceCommitted: true,
          quotaCost: scheduleQuotaCost,
        });
        if (!page.hasMore) {
          scheduleComplete = true;
          break;
        }
        if (page.nextOffset === undefined || page.nextOffset <= offset)
          throw new Error("sharpapi-schedule-pagination-invalid");
        offset = page.nextOffset;
      }
      if (!scheduleComplete)
        throw new Error("sharpapi-schedule-pagination-limit");
      const sharpBindings = (starts.get(sharpLeague.leagueKey) ?? [])
        .map((startsAt, index) => ({
          providerEventId:
            expectedProviderEvents.get(
              `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
            )?.[index] ?? "unknown",
          startsAt,
        }))
        .filter(({ startsAt }) => Date.parse(startsAt) > now.getTime());
      starts.set(
        sharpLeague.leagueKey,
        sharpBindings.map(({ startsAt }) => startsAt),
      );
      expectedProviderEvents.set(
        `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
        sharpBindings.map(({ providerEventId }) => providerEventId),
      );
      await input.control.putCheckpoint({
        ...checkpoint,
        leagueKey: checkpointKey,
        providerId: SHARP_API_PROVIDER_ID,
        completedAt: now.toISOString(),
        nextDueAt: new Date(now.getTime() + 3_600_000).toISOString(),
        runId,
        upcomingStarts: starts.get(sharpLeague.leagueKey) ?? [],
        expectedProviderEventIds:
          expectedProviderEvents.get(
            `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
          ) ?? [],
        expectedProviderEvents: sharpBindings,
      });
      await input.control.putRun({
        ...(await input.control.getRun(runId))!,
        status: "completed",
        updatedAt: now.toISOString(),
        evidenceCommitted: true,
        quotaCost: scheduleQuotaCost,
      });
      const authoritativeScheduleHealth = await input.control.getHealth(
        `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`,
      );
      await input.control.putHealth({
        ...authoritativeScheduleHealth,
        providerId: SHARP_API_PROVIDER_ID,
        healthKey: `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`,
        healthy: true,
        consecutiveSuccesses: (scheduleHealth?.consecutiveSuccesses ?? 0) + 1,
        ...(authoritativeScheduleHealth?.quotaRemaining === undefined
          ? {}
          : {
              quotaRemaining: authoritativeScheduleHealth.quotaRemaining,
            }),
        updatedAt: now.toISOString(),
      });
      sharpScheduleHealthy.add(sharpLeague.leagueKey);
      scheduleReady.add(`${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`);
      await clearOwned(checkpointKey, runId);
    } catch (error) {
      const reason = capabilityFailure(error);
      if (activeScheduleRunId) {
        const run = await input.control.getRun(activeScheduleRunId);
        if (run)
          await input.control.putRun({
            ...run,
            status: "failed",
            updatedAt: now.toISOString(),
            failureReason: reason,
            quotaCost: scheduleQuotaCost,
          });
      }
      input.metrics?.emit("OddsScheduleFailure", 1, {
        league: sharpLeague.leagueKey,
        provider: SHARP_API_PROVIDER_ID,
        reason,
      });
      if (
        storedScheduleReady.has(
          `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
        )
      ) {
        sharpScheduleHealthy.add(sharpLeague.leagueKey);
        scheduleReady.add(`${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`);
      }
    }
  }
  for (const fallbackLeague of theOddsApiLeagues) {
    if (sharpScheduleHealthy.has(fallbackLeague.leagueKey)) continue;
    let activeScheduleRunId: string | undefined;
    let scheduleQuotaCost = 0;
    try {
      const schedulePolicy = productionScheduleDiscoveryPolicies.find(
        ({ providerId }) => providerId === THE_ODDS_API_PROVIDER_ID,
      )!;
      const scheduleHealth = await input.control.getHealth(
        `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}:schedule`,
      );
      if (
        scheduleHealth?.quotaRemaining !== undefined &&
        scheduleHealth.quotaRemaining <= schedulePolicy.quotaReserve
      )
        throw new Error("quota-reserve");
      const checkpointKey = `schedule:${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`;
      const checkpoint = await input.control.getCheckpoint(checkpointKey);
      if (
        checkpoint?.expectedProviderEvents?.some(
          ({ startsAt }) => Date.parse(startsAt) > now.getTime(),
        )
      )
        storedScheduleReady.add(
          `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
        );
      if (checkpoint?.upcomingStarts)
        starts.set(
          fallbackLeague.leagueKey,
          checkpoint.upcomingStarts.filter(
            (start) => Date.parse(start) > now.getTime(),
          ),
        );
      if (checkpoint?.expectedProviderEvents)
        expectedProviderEvents.set(
          `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
          checkpoint.expectedProviderEvents
            .filter(({ startsAt }) => Date.parse(startsAt) > now.getTime())
            .map(({ providerEventId }) => providerEventId),
        );
      const existingContinuation =
        await input.control.getContinuation(checkpointKey);
      if (existingContinuation?.ambiguousUntil)
        throw new Error("provider-request-ambiguous");
      scheduleQuotaCost = existingContinuation?.quotaCost ?? 0;
      if (
        !input.forceRefresh &&
        !existingContinuation &&
        checkpoint &&
        Date.parse(checkpoint.nextDueAt) > now.getTime()
      ) {
        scheduleReady.add(
          `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
        );
        continue;
      }
      const claimNow = liveNow();
      const continuation = await input.control.claimContinuation({
        ...existingContinuation,
        leagueKey: checkpointKey,
        runId:
          existingContinuation?.runId ??
          `schedule:${fallbackLeague.leagueKey}:${now.toISOString()}`,
        providerId: THE_ODDS_API_PROVIDER_ID,
        updatedAt: claimNow.toISOString(),
        startedAt: claimNow.toISOString(),
        capability: "schedule",
        evidenceCommitted: false,
        quotaCost: existingContinuation?.quotaCost ?? 0,
        ownerId,
        leaseUntil: new Date(claimNow.getTime() + 300_000).toISOString(),
      });
      if (continuation.ownerId !== ownerId) throw new Error("run-owned");
      const runId = continuation.runId;
      activeScheduleRunId = runId;
      await input.control.putRun({
        ...((await input.control.getRun(runId)) ?? {}),
        runId,
        leagueKey: fallbackLeague.leagueKey,
        providerId: THE_ODDS_API_PROVIDER_ID,
        policyVersion: oddsCollectionPolicyVersion,
        status: "running",
        startedAt: continuation?.startedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        evidenceCommitted: continuation?.evidenceCommitted ?? false,
        quotaCost: continuation?.quotaCost ?? 0,
      });
      await putContinuationCas(input.control, {
        leagueKey: checkpointKey,
        runId,
        providerId: THE_ODDS_API_PROVIDER_ID,
        updatedAt: now.toISOString(),
        startedAt: continuation?.startedAt ?? now.toISOString(),
        capability: "schedule",
        evidenceCommitted: continuation?.evidenceCommitted ?? false,
        quotaCost: continuation?.quotaCost ?? 0,
      });
      const pageToken = "start";
      let sealed = await input.control.getPage(runId, pageToken);
      if (!sealed) {
        await assertAndRenewOwner(
          input.control,
          checkpointKey,
          runId,
          ownerId,
          liveNow,
        );
        const attemptId = `${runId}:${pageToken}:${now.toISOString()}:0`;
        if (
          !(await input.control.reserveQuotaAttempt(
            `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}:schedule`,
            schedulePolicy.quotaReserve,
            schedulePolicy.requestCost,
            {
              attemptId,
              runId,
              pageToken,
              requestedAt: liveNow().toISOString(),
              leaseUntil: new Date(liveNow().getTime() + 300_000).toISOString(),
              state: "reserved",
              providerId: THE_ODDS_API_PROVIDER_ID,
              leagueKey: fallbackLeague.leagueKey,
              capability: "schedule",
            },
          ))
        )
          throw new Error("schedule-attempt-reservation-conflict");
        scheduleQuotaCost += schedulePolicy.requestCost;
        let fetched: TheOddsApiResult;
        try {
          fetched = await paidCall(checkpointKey, runId, () =>
            (input.fetchFallbackSchedule ?? fetchTheOddsApiEvents)(
              fallbackLeague,
              input.theOddsApiKey,
            ),
          );
          const actualCost = fetched.quota.used ?? schedulePolicy.requestCost;
          await input.control.reconcileQuota(
            `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}:schedule`,
            schedulePolicy.requestCost,
            actualCost,
            fetched.quota.remaining,
            now.toISOString(),
          );
          scheduleQuotaCost += actualCost - schedulePolicy.requestCost;
        } catch (error) {
          const ambiguous = isAmbiguousTransport(error);
          await input.control.completeAttempt({
            attemptId,
            runId,
            pageToken,
            requestedAt: liveNow().toISOString(),
            completedAt: now.toISOString(),
            state: ambiguous ? "ambiguous" : "failed",
            failureReason: ambiguous
              ? "provider-request-ambiguous"
              : "provider-unavailable",
          });
          if (ambiguous)
            await putContinuationCas(input.control, {
              ...continuation,
              leagueKey: checkpointKey,
              runId,
              providerId: THE_ODDS_API_PROVIDER_ID,
              updatedAt: now.toISOString(),
              ambiguousUntil: new Date(
                liveNow().getTime() + 300_000,
              ).toISOString(),
            });
          if (ambiguous) throw new Error("provider-request-ambiguous");
          throw new Error("provider-unavailable");
        }
        sealed = {
          runId,
          pageToken,
          responseDigest: digest(fetched),
          normalizedItems: [fetched],
          gaps: [],
          quotaCost: fetched.quota.used ?? 0,
          sealedAt: now.toISOString(),
        };
        await assertAndRenewOwner(
          input.control,
          checkpointKey,
          runId,
          ownerId,
          liveNow,
        );
        await sealPaidPage(
          input.control,
          sealed,
          {
            attemptId,
            runId,
            pageToken,
            requestedAt: liveNow().toISOString(),
            leaseUntil: new Date(liveNow().getTime() + 300_000).toISOString(),
          },
          continuation,
        );
        await input.control.completeAttempt({
          attemptId,
          runId,
          pageToken,
          requestedAt: liveNow().toISOString(),
          completedAt: now.toISOString(),
          quotaCost: fetched.quota.used ?? 0,
        });
      }
      const page = sealed.normalizedItems[0] as TheOddsApiResult;
      for (const event of page.events)
        await bindScheduleEvent(
          input.events,
          THE_ODDS_API_PROVIDER_ID,
          fallbackLeague,
          event,
          page.retrievedAt,
        );
      const fallbackBindings = page.events
        .map((event) => ({
          providerEventId: event.providerEventId,
          startsAt: event.startsAt,
        }))
        .filter(({ startsAt }) => Date.parse(startsAt) > now.getTime());
      starts.set(
        fallbackLeague.leagueKey,
        fallbackBindings.map(({ startsAt }) => startsAt),
      );
      expectedProviderEvents.set(
        `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
        fallbackBindings.map(({ providerEventId }) => providerEventId),
      );
      await assertAndRenewOwner(
        input.control,
        checkpointKey,
        runId,
        ownerId,
        liveNow,
      );
      if (!sealed.committedAt)
        await input.control.commitPage(runId, pageToken, now.toISOString());
      await putContinuationCas(input.control, {
        leagueKey: checkpointKey,
        runId,
        providerId: THE_ODDS_API_PROVIDER_ID,
        updatedAt: now.toISOString(),
        startedAt: continuation?.startedAt ?? now.toISOString(),
        capability: "schedule",
        evidenceCommitted: true,
        quotaCost: scheduleQuotaCost,
      });
      const authoritativeFallbackHealth = await input.control.getHealth(
        `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}:schedule`,
      );
      await input.control.putHealth({
        ...authoritativeFallbackHealth,
        providerId: THE_ODDS_API_PROVIDER_ID,
        healthKey: `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}:schedule`,
        healthy: true,
        consecutiveSuccesses: (scheduleHealth?.consecutiveSuccesses ?? 0) + 1,
        ...(authoritativeFallbackHealth?.quotaRemaining === undefined
          ? {}
          : { quotaRemaining: authoritativeFallbackHealth.quotaRemaining }),
        updatedAt: now.toISOString(),
      });
      await input.control.putCheckpoint({
        ...checkpoint,
        leagueKey: checkpointKey,
        providerId: THE_ODDS_API_PROVIDER_ID,
        completedAt: now.toISOString(),
        nextDueAt: new Date(now.getTime() + 3_600_000).toISOString(),
        runId,
        upcomingStarts: starts.get(fallbackLeague.leagueKey) ?? [],
        expectedProviderEventIds:
          expectedProviderEvents.get(
            `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
          ) ?? [],
        expectedProviderEvents: fallbackBindings,
      });
      await input.control.putRun({
        ...(await input.control.getRun(runId))!,
        status: "completed",
        updatedAt: now.toISOString(),
        evidenceCommitted: true,
        quotaCost: scheduleQuotaCost,
      });
      scheduleReady.add(
        `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
      );
      await clearOwned(checkpointKey, runId);
    } catch (error) {
      const reason = capabilityFailure(error);
      if (activeScheduleRunId) {
        const run = await input.control.getRun(activeScheduleRunId);
        if (run)
          await input.control.putRun({
            ...run,
            status: "failed",
            updatedAt: now.toISOString(),
            failureReason: reason,
            quotaCost: scheduleQuotaCost,
          });
      }
      input.metrics?.emit("OddsScheduleFailure", 1, {
        league: fallbackLeague.leagueKey,
        provider: THE_ODDS_API_PROVIDER_ID,
        reason,
      });
      if (
        storedScheduleReady.has(
          `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
        )
      )
        scheduleReady.add(
          `${THE_ODDS_API_PROVIDER_ID}:${fallbackLeague.leagueKey}`,
        );
    }
  }

  const results = await runDueOddsLeagues(
    productionOddsCollectionPolicies.map((policy) => {
      const sharpLeague = sharpApiLeagues.find(
        ({ leagueKey }) => leagueKey === policy.leagueKey,
      )!;
      const fallbackLeague = theOddsApiLeagues.find(
        ({ leagueKey }) => leagueKey === policy.leagueKey,
      )!;
      const providers = new Map<string, ControlPlaneProvider>([
        [
          SHARP_API_PROVIDER_ID,
          {
            providerId: SHARP_API_PROVIDER_ID,
            requestCost: 1,
            reconcileMissing: ({ runId, seenProviderEventIds }) =>
              Promise.resolve(
                evidenceGaps(
                  runId,
                  SHARP_API_PROVIDER_ID,
                  policy.leagueKey,
                  [],
                  policy.markets,
                  policy.providers.find(
                    ({ providerId }) => providerId === SHARP_API_PROVIDER_ID,
                  )?.books ?? {},
                  now.toISOString(),
                  (
                    expectedProviderEvents.get(
                      `${SHARP_API_PROVIDER_ID}:${policy.leagueKey}`,
                    ) ?? []
                  ).filter((id) => !seenProviderEventIds.has(id)),
                ),
              ),
            probe: async () => {
              const account = await (
                input.fetchSharpAccount ?? fetchSharpApiAccount
              )(input.sharpApiKey);
              return {
                quotaCost: 1,
                quotaRemaining: Math.max(0, account.requestsPerMinute - 1),
              };
            },
            fetchPage: async ({ runId, pageToken }) => {
              const page = await (
                input.fetchSharpOdds ?? fetchSharpApiOddsPage
              )(
                sharpLeague,
                input.sharpApiKey,
                pageToken === "start" ? undefined : pageToken,
              );
              const material: SharpPageMaterial = { kind: "sharpapi", page };
              return {
                items: [material],
                gaps: evidenceGaps(
                  runId,
                  SHARP_API_PROVIDER_ID,
                  policy.leagueKey,
                  page.events,
                  policy.markets,
                  policy.providers.find(
                    ({ providerId }) => providerId === SHARP_API_PROVIDER_ID,
                  )?.books ?? {},
                  page.retrievedAt,
                  [],
                ),
                quotaCost: 1,
                seenProviderEventIds: page.events.map(
                  ({ providerEventId }) => providerEventId,
                ),
                digest: digest(material),
                ...(page.hasMore && page.nextCursor
                  ? { nextPageToken: page.nextCursor }
                  : {}),
              };
            },
          },
        ],
        [
          THE_ODDS_API_PROVIDER_ID,
          {
            providerId: THE_ODDS_API_PROVIDER_ID,
            requestCost: 3,
            reconcileMissing: ({ runId, seenProviderEventIds }) =>
              Promise.resolve(
                evidenceGaps(
                  runId,
                  THE_ODDS_API_PROVIDER_ID,
                  policy.leagueKey,
                  [],
                  policy.markets,
                  policy.providers.find(
                    ({ providerId }) => providerId === THE_ODDS_API_PROVIDER_ID,
                  )?.books ?? {},
                  now.toISOString(),
                  (
                    expectedProviderEvents.get(
                      `${THE_ODDS_API_PROVIDER_ID}:${policy.leagueKey}`,
                    ) ?? []
                  ).filter((id) => !seenProviderEventIds.has(id)),
                ),
              ),
            fetchPage: async ({ runId, pageToken }) => {
              if (pageToken !== "start")
                throw new Error("fallback-page-invalid");
              const page = await (input.fetchFallbackOdds ?? fetchTheOddsApi)(
                fallbackLeague,
                input.theOddsApiKey,
              );
              const material: FallbackPageMaterial = {
                kind: "the-odds-api",
                page,
              };
              return {
                items: [material],
                gaps: evidenceGaps(
                  runId,
                  THE_ODDS_API_PROVIDER_ID,
                  policy.leagueKey,
                  page.events,
                  policy.markets,
                  policy.providers.find(
                    ({ providerId }) => providerId === THE_ODDS_API_PROVIDER_ID,
                  )?.books ?? {},
                  page.retrievedAt,
                  [],
                ),
                quotaCost: page.quota.used ?? 3,
                seenProviderEventIds: page.events.map(
                  ({ providerEventId }) => providerEventId,
                ),
                ...(page.quota.remaining === undefined
                  ? {}
                  : { quotaRemaining: page.quota.remaining }),
                digest: digest(material),
              };
            },
          },
        ],
      ]);
      for (const providerId of [
        SHARP_API_PROVIDER_ID,
        THE_ODDS_API_PROVIDER_ID,
      ])
        if (!scheduleReady.has(`${providerId}:${policy.leagueKey}`))
          providers.delete(providerId);
      const nextStart = (starts.get(policy.leagueKey) ?? []).sort()[0];
      return {
        policy,
        store: input.control,
        providers,
        committer: {
          commit: async ({
            providerId,
            items,
          }: {
            providerId: string;
            items: readonly unknown[];
          }) => {
            let evidenceCommitted = false;
            for (const item of items) {
              const material = item as PageMaterial;
              if (
                providerId === SHARP_API_PROVIDER_ID &&
                material.kind === "sharpapi"
              ) {
                const persisted = await persistSharpApiOddsPage(
                  input.events,
                  input.odds,
                  sharpLeague,
                  material.page,
                  policy.providers.find(
                    ({ providerId }) => providerId === SHARP_API_PROVIDER_ID,
                  )?.books,
                );
                evidenceCommitted ||= persisted.observations > 0;
              } else if (
                providerId === THE_ODDS_API_PROVIDER_ID &&
                material.kind === "the-odds-api"
              ) {
                const persisted = await persistTheOddsApiPage(
                  input.events,
                  input.odds,
                  fallbackLeague,
                  material.page,
                  policy.providers.find(
                    ({ providerId }) => providerId === THE_ODDS_API_PROVIDER_ID,
                  )?.books,
                );
                evidenceCommitted ||= persisted.observations > 0;
              } else throw new Error("provider-page-material-mismatch");
            }
            return evidenceCommitted;
          },
        },
        now,
        ...(input.forceRefresh ? { forceRefresh: true } : {}),
        clock: liveNow,
        ...(providers.size > 0
          ? {}
          : { dependencyFailure: "schedule-dependency-failed" as const }),
        ...(nextStart === undefined ? {} : { nextStart }),
        ...(input.metrics ? { metrics: input.metrics } : {}),
      };
    }),
  );
  const splitCheckpointKey = "public-betting:sharpapi";
  const splitCheckpoint = await input.control.getCheckpoint(splitCheckpointKey);
  let splitContinuation =
    await input.control.getContinuation(splitCheckpointKey);
  if (splitContinuation?.ambiguousUntil) return results;
  const splitsDue =
    input.forceRefresh === true ||
    splitContinuation !== null ||
    splitCheckpoint === null ||
    Date.parse(splitCheckpoint.nextDueAt) <= now.getTime();
  if (splitsDue) {
    const claimNow = liveNow();
    splitContinuation = await input.control.claimContinuation({
      ...splitContinuation,
      leagueKey: splitCheckpointKey,
      runId: splitContinuation?.runId ?? `splits:sharpapi:${now.toISOString()}`,
      providerId: SHARP_API_PROVIDER_ID,
      updatedAt: claimNow.toISOString(),
      startedAt: claimNow.toISOString(),
      capability: "account",
      evidenceCommitted: false,
      quotaCost: 0,
      ownerId,
      leaseUntil: new Date(claimNow.getTime() + 300_000).toISOString(),
    });
    if (splitContinuation.ownerId !== ownerId) return results;
    const accountRunId = splitContinuation.runId;
    try {
      await input.control.putRun({
        ...((await input.control.getRun(accountRunId)) ?? {}),
        runId: accountRunId,
        leagueKey: "account",
        providerId: SHARP_API_PROVIDER_ID,
        policyVersion: oddsCollectionPolicyVersion,
        status: "running",
        startedAt: splitContinuation?.startedAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        evidenceCommitted: splitContinuation?.evidenceCommitted ?? false,
        quotaCost: splitContinuation?.quotaCost ?? 0,
      });
      await putContinuationCas(input.control, {
        leagueKey: splitCheckpointKey,
        runId: accountRunId,
        providerId: SHARP_API_PROVIDER_ID,
        updatedAt: now.toISOString(),
        startedAt: splitContinuation?.startedAt ?? now.toISOString(),
        capability: "account",
        evidenceCommitted: splitContinuation?.evidenceCommitted ?? false,
        quotaCost: splitContinuation?.quotaCost ?? 0,
      });
      let accountPage = await input.control.getPage(accountRunId, "account");
      if (!accountPage) {
        await assertAndRenewOwner(
          input.control,
          splitCheckpointKey,
          accountRunId,
          ownerId,
          liveNow,
        );
        const accountAttemptId = `${accountRunId}:account:${now.toISOString()}:0`;
        if (
          !(await input.control.reserveQuotaAttempt(
            `${SHARP_API_PROVIDER_ID}:account:account`,
            20,
            1,
            {
              attemptId: accountAttemptId,
              runId: accountRunId,
              pageToken: "account",
              requestedAt: liveNow().toISOString(),
              leaseUntil: new Date(liveNow().getTime() + 300_000).toISOString(),
              state: "reserved",
              providerId: SHARP_API_PROVIDER_ID,
              leagueKey: "account",
              capability: "account",
            },
          ))
        )
          throw new Error("account-attempt-reservation-conflict");
        await putContinuationCas(input.control, {
          leagueKey: splitCheckpointKey,
          runId: accountRunId,
          providerId: SHARP_API_PROVIDER_ID,
          updatedAt: now.toISOString(),
          startedAt: splitContinuation?.startedAt ?? now.toISOString(),
          capability: "account",
          evidenceCommitted: splitContinuation?.evidenceCommitted ?? false,
          quotaCost: (splitContinuation?.quotaCost ?? 0) + 1,
        });
        let account: Awaited<ReturnType<typeof fetchSharpApiAccount>>;
        try {
          account = await paidCall(splitCheckpointKey, accountRunId, () =>
            (input.fetchSharpAccount ?? fetchSharpApiAccount)(
              input.sharpApiKey,
            ),
          );
        } catch (error) {
          const ambiguous = isAmbiguousTransport(error);
          await input.control.completeAttempt({
            attemptId: accountAttemptId,
            runId: accountRunId,
            pageToken: "account",
            requestedAt: liveNow().toISOString(),
            completedAt: now.toISOString(),
            quotaCost: 1,
            state: ambiguous ? "ambiguous" : "failed",
            failureReason: ambiguous
              ? "provider-request-ambiguous"
              : "provider-unavailable",
          });
          if (ambiguous)
            await putContinuationCas(input.control, {
              ...splitContinuation,
              leagueKey: splitCheckpointKey,
              runId: accountRunId,
              providerId: SHARP_API_PROVIDER_ID,
              updatedAt: now.toISOString(),
              ambiguousUntil: new Date(
                liveNow().getTime() + 300_000,
              ).toISOString(),
            });
          if (ambiguous) throw new Error("provider-request-ambiguous");
          throw new Error("provider-unavailable");
        }
        accountPage = {
          runId: accountRunId,
          pageToken: "account",
          responseDigest: digest(account),
          normalizedItems: [account],
          gaps: [],
          quotaCost: 1,
          sealedAt: now.toISOString(),
        };
        await assertAndRenewOwner(
          input.control,
          splitCheckpointKey,
          accountRunId,
          ownerId,
          liveNow,
        );
        await sealPaidPage(
          input.control,
          accountPage,
          {
            attemptId: accountAttemptId,
            runId: accountRunId,
            pageToken: "account",
            requestedAt: liveNow().toISOString(),
            leaseUntil: new Date(liveNow().getTime() + 300_000).toISOString(),
          },
          splitContinuation,
        );
        await input.control.completeAttempt({
          attemptId: accountAttemptId,
          runId: accountRunId,
          pageToken: "account",
          requestedAt: liveNow().toISOString(),
          completedAt: now.toISOString(),
          quotaCost: 1,
        });
      }
      const account = accountPage.normalizedItems[0] as {
        readonly features: readonly string[];
        readonly requestsPerMinute: number;
      };
      await input.control.putHealth({
        ...(await input.control.getHealth(
          `${SHARP_API_PROVIDER_ID}:account:account`,
        )),
        providerId: SHARP_API_PROVIDER_ID,
        healthKey: `${SHARP_API_PROVIDER_ID}:account:account`,
        healthy: true,
        consecutiveSuccesses: 1,
        quotaRemaining: Math.max(0, account.requestsPerMinute - 1),
        updatedAt: now.toISOString(),
      });
      if (!account.features.includes("splits"))
        for (const league of sharpApiLeagues)
          await input.control.putGap({
            gapId: digest([
              accountRunId,
              league.leagueKey,
              "splits-not-entitled",
            ]),
            runId: accountRunId,
            leagueKey: league.leagueKey,
            providerId: SHARP_API_PROVIDER_ID,
            policyVersion: oddsCollectionPolicyVersion,
            bookRole: "splits",
            sourceState: "unsupported",
            reason: "unsupported",
            observedAt: now.toISOString(),
          });
      if (account.features.includes("splits"))
        for (const league of sharpApiLeagues) {
          try {
            const continuationKey = `splits:${league.leagueKey}`;
            const existingContinuation =
              await input.control.getContinuation(continuationKey);
            if (existingContinuation?.ambiguousUntil) continue;
            const claimNow = liveNow();
            const continuation = await input.control.claimContinuation({
              ...existingContinuation,
              leagueKey: continuationKey,
              runId:
                existingContinuation?.runId ??
                `splits:${league.leagueKey}:${now.toISOString()}`,
              providerId: SHARP_API_PROVIDER_ID,
              updatedAt: claimNow.toISOString(),
              startedAt: claimNow.toISOString(),
              capability: "splits",
              evidenceCommitted: false,
              quotaCost: existingContinuation?.quotaCost ?? 0,
              ownerId,
              leaseUntil: new Date(claimNow.getTime() + 300_000).toISOString(),
            });
            if (continuation.ownerId !== ownerId) continue;
            const runId = continuation.runId;
            await input.control.putRun({
              ...((await input.control.getRun(runId)) ?? {}),
              runId,
              leagueKey: league.leagueKey,
              providerId: SHARP_API_PROVIDER_ID,
              policyVersion: oddsCollectionPolicyVersion,
              status: "running",
              startedAt: continuation?.startedAt ?? now.toISOString(),
              updatedAt: now.toISOString(),
              evidenceCommitted: continuation?.evidenceCommitted ?? false,
              quotaCost: continuation?.quotaCost ?? 0,
            });
            await putContinuationCas(input.control, {
              leagueKey: continuationKey,
              runId,
              providerId: SHARP_API_PROVIDER_ID,
              updatedAt: now.toISOString(),
              startedAt: continuation?.startedAt ?? now.toISOString(),
              capability: "splits",
              evidenceCommitted: continuation?.evidenceCommitted ?? false,
              quotaCost: continuation?.quotaCost ?? 0,
            });
            let offset = 0;
            let splitsComplete = false;
            let splitQuotaCost = continuation?.quotaCost ?? 0;
            for (let guard = 0; guard < 20; guard += 1) {
              const pageToken = String(offset);
              let sealed = await input.control.getPage(runId, pageToken);
              if (!sealed) {
                await assertAndRenewOwner(
                  input.control,
                  continuationKey,
                  runId,
                  ownerId,
                  liveNow,
                );
                const attemptId = `${runId}:${pageToken}:${now.toISOString()}:${guard}`;
                if (
                  !(await input.control.reserveQuotaAttempt(
                    `${SHARP_API_PROVIDER_ID}:account:account`,
                    20,
                    1,
                    {
                      attemptId,
                      runId,
                      pageToken,
                      requestedAt: liveNow().toISOString(),
                      leaseUntil: new Date(
                        liveNow().getTime() + 300_000,
                      ).toISOString(),
                      state: "reserved",
                      providerId: SHARP_API_PROVIDER_ID,
                      leagueKey: league.leagueKey,
                      capability: "splits",
                    },
                  ))
                )
                  throw new Error("split-attempt-reservation-conflict");
                splitQuotaCost += 1;
                await putContinuationCas(input.control, {
                  leagueKey: continuationKey,
                  runId,
                  providerId: SHARP_API_PROVIDER_ID,
                  updatedAt: now.toISOString(),
                  startedAt: continuation?.startedAt ?? now.toISOString(),
                  capability: "splits",
                  evidenceCommitted: continuation?.evidenceCommitted ?? false,
                  quotaCost: splitQuotaCost,
                });
                let page: Awaited<ReturnType<typeof fetchSharpApiSplitsPage>>;
                try {
                  page = await paidCall(continuationKey, runId, () =>
                    (input.fetchSharpSplits ?? fetchSharpApiSplitsPage)(
                      league,
                      input.sharpApiKey,
                      offset,
                    ),
                  );
                } catch (error) {
                  const ambiguous = isAmbiguousTransport(error);
                  await input.control.completeAttempt({
                    attemptId,
                    runId,
                    pageToken,
                    requestedAt: liveNow().toISOString(),
                    completedAt: now.toISOString(),
                    quotaCost: 1,
                    state: ambiguous ? "ambiguous" : "failed",
                    failureReason: ambiguous
                      ? "provider-request-ambiguous"
                      : "provider-unavailable",
                  });
                  if (ambiguous)
                    await putContinuationCas(input.control, {
                      ...continuation,
                      leagueKey: continuationKey,
                      runId,
                      providerId: SHARP_API_PROVIDER_ID,
                      updatedAt: now.toISOString(),
                      ambiguousUntil: new Date(
                        liveNow().getTime() + 300_000,
                      ).toISOString(),
                    });
                  if (ambiguous) throw new Error("provider-request-ambiguous");
                  throw new Error("provider-unavailable");
                }
                sealed = {
                  runId,
                  pageToken,
                  ...(page.hasMore && page.nextOffset !== undefined
                    ? { nextPageToken: String(page.nextOffset) }
                    : {}),
                  responseDigest: digest(page),
                  normalizedItems: [page],
                  gaps: [],
                  quotaCost: 1,
                  sealedAt: now.toISOString(),
                };
                await assertAndRenewOwner(
                  input.control,
                  continuationKey,
                  runId,
                  ownerId,
                  liveNow,
                );
                await sealPaidPage(
                  input.control,
                  sealed,
                  {
                    attemptId,
                    runId,
                    pageToken,
                    requestedAt: liveNow().toISOString(),
                    leaseUntil: new Date(
                      liveNow().getTime() + 300_000,
                    ).toISOString(),
                  },
                  continuation,
                );
                await input.control.completeAttempt({
                  attemptId,
                  runId,
                  pageToken,
                  requestedAt: liveNow().toISOString(),
                  completedAt: now.toISOString(),
                  quotaCost: 1,
                });
              }
              await assertAndRenewOwner(
                input.control,
                continuationKey,
                runId,
                ownerId,
                liveNow,
              );
              if (!sealed.committedAt) {
                await persistSharpApiSplitPage(
                  input.events,
                  input.splits,
                  league,
                  sealed.normalizedItems[0] as never,
                  [],
                );
                await input.control.commitPage(
                  runId,
                  pageToken,
                  now.toISOString(),
                );
              }
              await putContinuationCas(input.control, {
                leagueKey: continuationKey,
                runId,
                providerId: SHARP_API_PROVIDER_ID,
                updatedAt: now.toISOString(),
                startedAt: continuation?.startedAt ?? now.toISOString(),
                capability: "splits",
                evidenceCommitted: true,
                quotaCost: splitQuotaCost,
              });
              if (!sealed.nextPageToken) {
                splitsComplete = true;
                break;
              }
              const next = Number(sealed.nextPageToken);
              if (!Number.isSafeInteger(next) || next <= offset)
                throw new Error("sharpapi-splits-pagination-invalid");
              offset = next;
            }
            if (!splitsComplete)
              throw new Error("sharpapi-splits-pagination-limit");
            await input.control.putRun({
              ...(await input.control.getRun(runId))!,
              status: "completed",
              updatedAt: now.toISOString(),
              evidenceCommitted: true,
              quotaCost: splitQuotaCost,
            });
            await clearOwned(continuationKey, runId);
          } catch (error) {
            const reason = capabilityFailure(error);
            input.metrics?.emit("OddsSplitFailure", 1, {
              league: league.leagueKey,
              provider: SHARP_API_PROVIDER_ID,
              reason,
            });
            const continuation = await input.control.getContinuation(
              `splits:${league.leagueKey}`,
            );
            if (continuation) {
              const run = await input.control.getRun(continuation.runId);
              if (run)
                await input.control.putRun({
                  ...run,
                  status: "failed",
                  updatedAt: now.toISOString(),
                  failureReason: reason,
                  quotaCost: continuation.quotaCost ?? run.quotaCost,
                });
            }
          }
        }
      await assertAndRenewOwner(
        input.control,
        splitCheckpointKey,
        accountRunId,
        ownerId,
        liveNow,
      );
      if (!accountPage.committedAt)
        await input.control.commitPage(
          accountRunId,
          "account",
          now.toISOString(),
        );
      await input.control.putRun({
        ...(await input.control.getRun(accountRunId))!,
        status: "completed",
        updatedAt: now.toISOString(),
        evidenceCommitted: true,
        quotaCost: accountPage.quotaCost,
      });
      await input.control.putCheckpoint({
        ...splitCheckpoint,
        leagueKey: splitCheckpointKey,
        providerId: SHARP_API_PROVIDER_ID,
        completedAt: now.toISOString(),
        nextDueAt: new Date(now.getTime() + 900_000).toISOString(),
        runId: accountRunId,
      });
      await clearOwned(splitCheckpointKey, accountRunId);
    } catch (error) {
      const reason = capabilityFailure(error);
      const run = await input.control.getRun(accountRunId);
      if (run)
        await input.control.putRun({
          ...run,
          status: reason === "quota-reserve" ? "skipped" : "failed",
          updatedAt: now.toISOString(),
          ...(reason === "quota-reserve"
            ? { skipReason: reason }
            : { failureReason: reason }),
          quotaCost:
            (await input.control.getContinuation(splitCheckpointKey))
              ?.quotaCost ?? run.quotaCost,
        });
      input.metrics?.emit("OddsAccountFailure", 1, {
        provider: SHARP_API_PROVIDER_ID,
        reason,
      });
    }
  }
  return results;
}
