import type {
  BettingSplitRepository,
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
  OddsControlPlaneStore,
  OddsAttemptRecord,
  OddsRunContinuation,
  SealedOddsPage,
} from "@find-the-edge/database";
import { randomUUID } from "node:crypto";
import { reconcileScheduledProviderEvent } from "./schedule-reconciliation";

export interface LiveOddsPersister {
  persist(input: FixtureOddsIngestInput): Promise<FixtureOddsPersistResult>;
}

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
  fetchSharpApiOddsPage,
  fetchSharpApiAccount,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  sharpApiLeagues,
  type SharpApiOddsPage,
  type SharpApiSchedulePage,
} from "@find-the-edge/providers";
import {
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
} from "./sharp-api-ingestion";
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

const digest = (value: unknown) => sha256Hex(JSON.stringify(value));
const capabilityFailure = (error: unknown) => {
  const reason = error instanceof Error ? error.message : "provider-error";
  if (reason.includes("pagination")) return "pagination-invalid";
  if (reason.includes("mapping")) return "mapping-quarantine";
  if (reason.includes("transition-conflict")) return "transition-conflict";
  if (reason === "quota-reserve") return reason;
  if (reason === "provider-request-ambiguous") return reason;
  if (
    [
      "provider-unavailable",
      "rate-limited",
      "unauthorized",
      "not-entitled",
      "invalid-response",
    ].includes(reason)
  )
    return reason;
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
        readonly selectionKey?: string;
        readonly participantSide?: "away" | "home";
        readonly point?: number;
        readonly outcomeStructure?: "two-way" | "three-way";
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
        if (active.length > 0) {
          const groups = new Map<string, typeof active>();
          for (const price of active) {
            const line =
              marketKey === "spread"
                ? Math.abs(price.point ?? Number.NaN)
                : (price.point ?? "none");
            const groupKey = `${price.participantSide ?? "event"}:${line}:${price.outcomeStructure ?? "default"}`;
            groups.set(groupKey, [...(groups.get(groupKey) ?? []), price]);
          }
          const hasCompleteGroup = [...groups.values()].some((group) => {
            const expected =
              marketKey === "total" || marketKey === "team_total"
                ? ["over", "under"]
                : marketKey === "btts"
                  ? ["yes", "no"]
                  : marketKey === "moneyline" &&
                      group[0]?.outcomeStructure === "three-way"
                    ? ["away", "draw", "home"]
                    : ["away", "home"];
            const selections = new Set(
              group.map(({ selectionKey }) => selectionKey),
            );
            return (
              group.length === expected.length &&
              expected.every((selection) => selections.has(selection)) &&
              !(
                (marketKey === "spread" ||
                  marketKey === "total" ||
                  marketKey === "team_total") &&
                group.some(({ point }) => point === undefined)
              ) &&
              !(
                marketKey === "team_total" &&
                group.some(({ participantSide }) => !participantSide)
              )
            );
          });
          if (hasCompleteGroup) continue;
          gaps.push({
            gapId: sha256Hex(
              JSON.stringify([
                runId,
                providerId,
                providerEventId,
                sportsbookId,
                marketKey,
                "incomplete-market",
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
            sourceState: "partial",
            reason: "incomplete-market",
            observedAt,
          });
          continue;
        }
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
const normalizationGaps = (
  runId: string,
  leagueKey: string,
  page: SharpApiOddsPage,
  books: Readonly<Record<string, "offered" | "comparison" | "splits">>,
): OddsEvidenceGap[] =>
  (page.rejections ?? []).flatMap((rejection) => {
    const bookRole = rejection.sportsbookId
      ? books[rejection.sportsbookId]
      : undefined;
    if (!rejection.providerEventId || !rejection.sportsbookId || !bookRole)
      return [];
    return [
      {
        gapId: digest([
          runId,
          rejection.providerEventId,
          rejection.sportsbookId,
          rejection.reason,
          rejection.auditId,
        ]),
        runId,
        leagueKey,
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: rejection.providerEventId,
        sportsbookId: rejection.sportsbookId,
        policyVersion: oddsCollectionPolicyVersion,
        bookRole,
        sourceState: "unsupported",
        reason: rejection.reason,
        observedAt: page.retrievedAt,
      },
    ];
  });
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
  readonly now?: Date;
  readonly forceRefresh?: boolean;
  readonly clock?: () => Date;
  readonly metrics?: OddsControlPlaneMetrics;
  readonly fetchSharpSchedule?: typeof fetchSharpApiSchedulePage;
  readonly fetchSharpOdds?: typeof fetchSharpApiOddsPage;
  readonly fetchSharpAccount?: typeof fetchSharpApiAccount;
  readonly fetchSharpSplits?: typeof fetchSharpApiSplitsPage;
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
  const scheduleFailures = new Map<string, string>();
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
      scheduleFailures.set(sharpLeague.leagueKey, `schedule-${reason}`);
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
  const results = await runDueOddsLeagues(
    productionOddsCollectionPolicies.map((policy) => {
      const sharpLeague = sharpApiLeagues.find(
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
                  policy.providers[0]?.books ?? {},
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
                gaps: [
                  ...evidenceGaps(
                    runId,
                    SHARP_API_PROVIDER_ID,
                    policy.leagueKey,
                    page.events,
                    policy.markets,
                    policy.providers[0]?.books ?? {},
                    page.retrievedAt,
                    [],
                  ),
                  ...normalizationGaps(
                    runId,
                    policy.leagueKey,
                    page,
                    policy.providers[0]?.books ?? {},
                  ),
                ],
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
      ]);
      if (!scheduleReady.has(`${SHARP_API_PROVIDER_ID}:${policy.leagueKey}`))
        providers.delete(SHARP_API_PROVIDER_ID);
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
              const material = item as SharpPageMaterial;
              if (
                providerId !== SHARP_API_PROVIDER_ID ||
                material.kind !== "sharpapi"
              )
                throw new Error("provider-page-material-mismatch");
              const persisted = await persistSharpApiOddsPage(
                input.events,
                input.odds,
                sharpLeague,
                material.page,
                policy.providers[0]?.books,
              );
              input.metrics?.emit(
                "OddsNormalizedObservation",
                persisted.observations,
                { provider: SHARP_API_PROVIDER_ID, league: policy.leagueKey },
              );
              for (const [reason, count] of Object.entries(
                persisted.rejectionCounts,
              ))
                input.metrics?.emit("OddsNormalizationRejected", count, {
                  provider: SHARP_API_PROVIDER_ID,
                  league: policy.leagueKey,
                  reason,
                });
              evidenceCommitted ||= persisted.observations > 0;
            }
            return evidenceCommitted;
          },
        },
        now,
        ...(input.forceRefresh ? { forceRefresh: true } : {}),
        clock: liveNow,
        ...(providers.size > 0
          ? {}
          : {
              dependencyFailure:
                scheduleFailures.get(policy.leagueKey) ??
                "schedule-dependency-failed",
            }),
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
