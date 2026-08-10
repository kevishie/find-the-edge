import type {
  BettingSplitRepository,
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
  OddsControlPlaneStore,
  OddsAttemptRecord,
  OddsProviderHealth,
  OddsRunContinuation,
  SealedOddsPage,
} from "@find-the-edge/database";
import { randomUUID } from "node:crypto";
import {
  reconcileScheduledProviderEvent,
  isScheduleEventConflictReason,
  ScheduleEventConflictError,
  type ScheduleEventConflictReason,
} from "./schedule-reconciliation";

const sharpOddsFailureCosts = new WeakMap<object, 1 | 2>();

export const sharpOddsFailureRequestCost = (error: unknown) =>
  typeof error === "object" && error !== null
    ? sharpOddsFailureCosts.get(error)
    : undefined;

const throwSharpOddsFailure = (error: unknown, quotaCost: 1 | 2): never => {
  if (typeof error === "object" && error !== null)
    sharpOddsFailureCosts.set(error, quotaCost);
  throw error;
};

export async function fetchSharpOddsPageWithRetry(
  fetchPage: () => Promise<SharpApiOddsPage>,
  onRetry: () => void = () => undefined,
): Promise<{ readonly page: SharpApiOddsPage; readonly quotaCost: 1 | 2 }> {
  try {
    return { page: await fetchPage(), quotaCost: 1 };
  } catch (error) {
    if (!(error instanceof SharpApiError) || error.code !== "invalid-response")
      return throwSharpOddsFailure(error, 1);
    onRetry();
    try {
      return { page: await fetchPage(), quotaCost: 2 };
    } catch (retryError) {
      return throwSharpOddsFailure(retryError, 2);
    }
  }
}

const nonEmptyRateWindow = <
  T extends {
    readonly limit?: number;
    readonly remaining?: number;
    readonly resetsAt?: string;
  },
>(
  value: T | undefined,
): T | undefined =>
  value && Object.keys(value).length > 0 ? value : undefined;

export interface LiveOddsPersister {
  persist(input: FixtureOddsIngestInput): Promise<FixtureOddsPersistResult>;
  persistAvailability?(
    value: import("@find-the-edge/domain").FixtureOddsAvailabilityEvidence,
  ): Promise<unknown>;
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
        ...(current?.ambiguousUntil && value.ambiguousUntil
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
const resumeExpiredAmbiguousContinuation = (
  continuation: OddsRunContinuation | null,
  now: Date,
): {
  readonly blocked: boolean;
  readonly continuation: OddsRunContinuation | null;
} => {
  if (!continuation?.ambiguousUntil) return { blocked: false, continuation };
  const ambiguousUntil = Date.parse(continuation.ambiguousUntil);
  if (!Number.isFinite(ambiguousUntil) || ambiguousUntil > now.getTime())
    return { blocked: true, continuation };
  const { ambiguousUntil: expired, ...resumable } = continuation;
  void expired;
  return { blocked: false, continuation: resumable };
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
  fixtureOddsGroupAvailabilityIdentity,
  sha256Hex,
  type IsoTimestamp,
  type OddsEvidenceGap,
} from "@find-the-edge/domain";
import {
  SHARP_API_PROVIDER_ID,
  SharpApiError,
  type SharpApiNormalizationRejection,
  fetchSharpApiFeaturedOdds,
  fetchSharpApiOddsPage,
  fetchSharpApiEventOdds,
  fetchSharpApiAccount,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  fetchSharpApiSplitHistory,
  latestSharpApiSplitHistoryByBook,
  sharpApiLeagues,
  type SharpApiOddsPage,
  type SharpApiSchedulePage,
  type SharpApiSplitEvent,
} from "@find-the-edge/providers";
import {
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
} from "./sharp-api-ingestion";
import {
  decideOddsRetry,
  healthyOddsProviderState,
  runDueOddsLeagues,
  unhealthyOddsProviderState,
  withPaidLeaseHeartbeat,
  type ControlPlaneProvider,
  type OddsControlPlaneMetrics,
} from "./odds-control-plane";

interface SharpPageMaterial {
  readonly kind: "sharpapi";
  readonly page: SharpApiOddsPage;
}

type CanonicalSharpOddsEvents = Awaited<
  ReturnType<typeof persistSharpApiOddsPage>
>["canonicalOddsEvents"];

const digest = (value: unknown) => sha256Hex(JSON.stringify(value));

const splitHistoryWindow = (
  runId: string,
  leagueKey: string,
  fallback: Date,
) => {
  const prefix = `splits:${leagueKey}:`;
  const encoded = runId.startsWith(prefix) ? runId.slice(prefix.length) : "";
  const parsed = Date.parse(encoded);
  const end = Number.isFinite(parsed) ? new Date(parsed) : fallback;
  return {
    startTime: new Date(
      end.getTime() - 30 * 60_000,
    ).toISOString() as IsoTimestamp,
    endTime: end.toISOString() as IsoTimestamp,
  };
};

const checkpointScheduleBindings = (
  checkpoint: Awaited<ReturnType<OddsControlPlaneStore["getCheckpoint"]>>,
) => {
  if (!checkpoint) return [];
  if (checkpoint.expectedProviderEvents)
    return [...checkpoint.expectedProviderEvents];
  const ids = checkpoint.expectedProviderEventIds;
  const starts = checkpoint.upcomingStarts;
  if (!ids || !starts || ids.length !== starts.length) return [];
  return ids.map((providerEventId, index) => ({
    providerEventId,
    startsAt: starts[index]!,
  }));
};

export interface FocusedSharpOddsRequest {
  readonly leagueKey: (typeof sharpApiLeagues)[number]["leagueKey"];
  readonly providerEventId: string;
  readonly pollingWindowSeconds?: number;
}

export const sharpOddsRequestIdentity = (input: {
  readonly leagueKey: string;
  readonly endpointMode: "featured" | "focused";
  readonly providerEventId?: string;
  readonly marketSet: readonly string[];
  readonly now: Date;
  readonly pollingWindowSeconds: number;
}) => {
  const window = Math.floor(
    input.now.getTime() / (input.pollingWindowSeconds * 1_000),
  );
  return sha256Hex(
    JSON.stringify([
      SHARP_API_PROVIDER_ID,
      input.leagueKey,
      input.endpointMode,
      input.providerEventId ?? null,
      [...input.marketSet].sort(),
      input.pollingWindowSeconds,
      window,
    ]),
  );
};
const boundedOddsMappingFailures = new Set([
  "mapping-canonical-missing",
  "mapping-canonical-scope-mismatch",
  "mapping-scope-mismatch",
  "sharpapi-odds-mapping-no-candidate",
  "sharpapi-odds-mapping-ambiguous-candidates",
  "sharpapi-odds-mapping-participant-mismatch",
  "sharpapi-odds-mapping-start-mismatch",
]);

export const capabilityFailure = (error: unknown) => {
  const reason = error instanceof Error ? error.message : "provider-error";
  if (reason === "run-owned") return "provider-recovering";
  if (reason === "schedule-attempt-reservation-conflict")
    return "transition-conflict";
  if (reason.includes("pagination")) return "pagination-invalid";
  if (boundedOddsMappingFailures.has(reason)) return reason;
  if (reason.includes("mapping")) return "mapping-quarantine";
  if (reason.includes("transition-conflict")) return "transition-conflict";
  if (reason === "quota-reserve") return reason;
  if (reason === "provider-request-ambiguous") return reason;
  if (reason === "schedule-stored-event-conflict")
    return "stored-event-conflict";
  if (reason === "schedule-conflict-metric-pending")
    return "conflict-metric-pending";
  if (
    [
      "provider-unavailable",
      "rate-limited",
      "unauthorized",
      "not-entitled",
      "invalid-response",
      "provider-rejected",
    ].includes(reason)
  )
    return reason;
  return "provider-error";
};

const boundedScheduleInternalFailures = new Set([
  "invalid-event-reconciliation-lock",
  "event-reconciliation-lock-timeout",
  "event-reconciliation-ownership-lost",
  "dynamo-transaction-conflict",
  "dynamo-conditional-conflict",
  "identity-snapshot-unstable",
  "dangling-identity-aggregate",
  "stale-identity-aggregate",
  "mapping-canonical-missing",
  "mapping-canonical-scope-mismatch",
  "event-projection-pointer-missing",
  "event-projection-pointer-corrupt",
  "event-projection-active-missing",
  "event-projection-active-corrupt",
  "bootstrap-stale",
  "identity-register-conflict",
  "identity-snapshot-mismatch",
  "canonical-revision-provider-limit",
  "mapped-canonical-participants-missing",
  "near-canonical-participants-missing",
  "multiple-current-event-projections",
  "near-canonical-projection-stale",
  "mapping-scope-mismatch",
  "bootstrap-identity-already-exists",
  "bootstrap-identity-snapshot-mismatch",
  "identity-conflict-count-exhausted",
  "invalid-scheduled-reconciliation",
  "reconciliation-participants-required",
  "invalid-provider-event-mapping",
  "invalid-provider-revision",
  "invalid-provider-revision-row",
  "provider-revision-scope-mismatch",
  "invalid-canonical-event",
  "invalid-identity-claim",
  "identity-version-exhausted",
  "version-exhausted",
  "bootstrap-response-conflict",
  "bootstrap-failed",
  "event-reconciliation-acquisition-failed",
  "event-reconciliation-execution-failed",
  "event-reconciliation-renewal-failed",
  "event-reconciliation-cleanup-failed",
]);
for (const phase of ["acquisition", "execution", "renewal", "cleanup"])
  for (const storageClass of [
    "storage-validation",
    "storage-resource-missing",
    "storage-access-denied",
    "storage-transaction-cancelled",
    "storage-unavailable",
  ])
    boundedScheduleInternalFailures.add(
      `event-reconciliation-${phase}-${storageClass}`,
    );

const boundedScheduleStorageExceptions = new Map<string, string>([
  ["ValidationException", "storage-validation"],
  ["ResourceNotFoundException", "storage-resource-missing"],
  ["ProvisionedThroughputExceededException", "storage-throttled"],
  ["ThrottlingException", "storage-throttled"],
  ["RequestLimitExceeded", "storage-throttled"],
  ["TransactionCanceledException", "storage-transaction-cancelled"],
  ["TransactionInProgressException", "storage-transaction-in-progress"],
  ["InternalServerError", "storage-unavailable"],
  ["ServiceUnavailable", "storage-unavailable"],
]);

const scheduleFailureStages = [
  "initialize",
  "health-read",
  "checkpoint-read",
  "ownership-claim",
  "run-start",
  "schedule-fetch",
  "event-reconcile",
  "schedule-page-commit",
  "conflict-page-seal",
  "conflict-page-commit",
  "schedule-metrics",
  "conflict-metrics",
  "conflict-checkpoint",
  "checkpoint-write",
  "health-write",
  "ownership-clear",
] as const;
type ScheduleFailureStage = (typeof scheduleFailureStages)[number];
const boundedScheduleFailureStages = new Set<string>(scheduleFailureStages);

const boundedScheduleCapabilityAliases = new Map<string, string>([
  ["run-owned", "provider-recovering"],
  ["schedule-attempt-reservation-conflict", "transition-conflict"],
  ["schedule-stored-event-conflict", "stored-event-conflict"],
  ["schedule-conflict-metric-pending", "conflict-metric-pending"],
]);

const boundedScheduleCapabilityFailures = new Set([
  "provider-unavailable",
  "rate-limited",
  "unauthorized",
  "not-entitled",
  "invalid-response",
  "provider-rejected",
  "quota-reserve",
  "provider-request-ambiguous",
  "mapping-quarantine",
  "pagination-invalid",
  "transition-conflict",
]);

export const scheduleCapabilityFailure = (
  error: unknown,
  stage: ScheduleFailureStage,
) => {
  const message = error instanceof Error ? error.message : "";
  if (
    stage === "event-reconcile" &&
    boundedScheduleInternalFailures.has(message)
  )
    return `provider-error-${message}`;
  const storageReason =
    stage === "event-reconcile" && error instanceof Error
      ? boundedScheduleStorageExceptions.get(error.name)
      : undefined;
  if (storageReason) return `provider-error-${storageReason}`;
  const alias = boundedScheduleCapabilityAliases.get(message);
  if (alias) return alias;
  if (boundedScheduleCapabilityFailures.has(message)) return message;
  return `provider-error-${
    boundedScheduleFailureStages.has(stage) ? stage : "initialize"
  }`;
};

/** Closed classifier for deterministic content conflicts scoped to one
 * provider event. Storage, lease, ownership, pagination, and unknown failures
 * deliberately remain fatal to the league run. */
export const scheduleEventConflictReason = (
  error: unknown,
): ScheduleEventConflictReason | null =>
  error instanceof ScheduleEventConflictError ? error.reason : null;
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
    Record<string, "offered" | "comparison" | "collected" | "splits">
  >,
  observedAt: string,
  expectedProviderEventIds: readonly string[] = [],
  expectedBookMarkets?: Readonly<Record<string, readonly string[]>>,
): OddsEvidenceGap[] => {
  const gaps: OddsEvidenceGap[] = [];
  const eventById = new Map(
    events.map((event) => [event.providerEventId, event]),
  );
  const expected = new Set([...expectedProviderEventIds, ...eventById.keys()]);
  for (const providerEventId of expected)
    for (const [sportsbookId, bookRole] of Object.entries(configuredBooks))
      for (const marketKey of expectedBookMarkets
        ? (expectedBookMarkets[sportsbookId] ?? [])
        : markets) {
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

const mergeSharpOddsPages = (
  pages: readonly SharpApiOddsPage[],
): SharpApiOddsPage => {
  const events = new Map<string, SharpApiOddsPage["events"][number]>();
  const eventRetrievedAt = new Map<string, IsoTimestamp>();
  const participantConflicts: SharpApiNormalizationRejection[] = [];
  const withRetrievalBoundary = (
    event: SharpApiOddsPage["events"][number],
    pageRetrievedAt: IsoTimestamp,
  ) => ({
    ...event,
    bookmakers: event.bookmakers.map((book) => ({
      ...book,
      prices: book.prices.map((price) => ({
        ...price,
        retrievedAt: price.retrievedAt ?? pageRetrievedAt,
      })),
    })),
  });
  const priceIdentitySignature = (
    price: SharpApiOddsPage["events"][number]["bookmakers"][number]["prices"][number],
  ) =>
    JSON.stringify([
      price.providerPriceId,
      price.marketKey,
      price.providerMarketType,
      price.providerMarketId,
      price.selectionKey,
      price.participantSide,
      price.outcomeStructure,
      price.providerSelectionId,
    ]);
  const retrievedAt = pages
    .map((page) => page.retrievedAt)
    .sort()
    .at(-1);
  for (const page of pages)
    for (const rawCandidate of page.events) {
      const candidate = withRetrievalBoundary(rawCandidate, page.retrievedAt);
      const priorEventRetrievedAt = eventRetrievedAt.get(
        candidate.providerEventId,
      );
      if (
        !priorEventRetrievedAt ||
        Date.parse(page.retrievedAt) < Date.parse(priorEventRetrievedAt)
      )
        eventRetrievedAt.set(candidate.providerEventId, page.retrievedAt);
      const current = events.get(candidate.providerEventId);
      if (!current) {
        events.set(candidate.providerEventId, candidate);
        continue;
      }
      const reversed =
        current.awayTeam === candidate.homeTeam &&
        current.homeTeam === candidate.awayTeam;
      if (current.providerEventUuid !== candidate.providerEventUuid)
        throw new SharpApiError(
          "invalid-response",
          false,
          undefined,
          "odds:cross-page-event-uuid",
        );
      if (
        !reversed &&
        (current.awayTeam !== candidate.awayTeam ||
          current.homeTeam !== candidate.homeTeam)
      ) {
        // The provider's prediction-exchange rows drift participant labels
        // for the same event identity (empty away teams, per-book naming).
        // A drifted candidate must neither corrupt the merged event nor
        // fail the whole league run — its rows are set aside as rejections
        // and the first-seen participants stand.
        participantConflicts.push({
          providerId: SHARP_API_PROVIDER_ID,
          reason: "participant-conflict",
          auditId: candidate.providerEventId.slice(0, 64),
          providerEventId: candidate.providerEventId,
        });
        continue;
      }
      // Schedule reconciliation owns canonical start time. Odds pages for the
      // same exact provider event UUID can disagree after a delay or
      // postponement, so retain the first normalized start and merge books.
      const bookmakers = new Map(
        current.bookmakers.map((book) => [book.id, book]),
      );
      for (const candidateBook of candidate.bookmakers) {
        const incoming = reversed
          ? {
              ...candidateBook,
              prices: candidateBook.prices.map((price) => ({
                ...price,
                selectionKey:
                  price.selectionKey === "away"
                    ? ("home" as const)
                    : price.selectionKey === "home"
                      ? ("away" as const)
                      : price.selectionKey,
                ...(price.participantSide === "away"
                  ? { participantSide: "home" as const }
                  : price.participantSide === "home"
                    ? { participantSide: "away" as const }
                    : {}),
              })),
            }
          : candidateBook;
        const existing = bookmakers.get(incoming.id);
        if (!existing) {
          bookmakers.set(incoming.id, incoming);
          continue;
        }
        const prices = new Map(
          existing.prices.map((price) => [
            price.providerPriceId,
            { price, identity: priceIdentitySignature(price) },
          ]),
        );
        for (const price of incoming.prices) {
          const prior = prices.get(price.providerPriceId);
          const identity = priceIdentitySignature(price);
          if (prior && prior.identity !== identity)
            throw new SharpApiError(
              "invalid-response",
              false,
              undefined,
              "odds:cross-page-price-conflict",
            );
          if (
            !prior ||
            Date.parse(price.observedAt) >= Date.parse(prior.price.observedAt)
          )
            prices.set(price.providerPriceId, { price, identity });
        }
        bookmakers.set(incoming.id, {
          ...existing,
          prices: [...prices.values()].map(({ price }) => price),
        });
      }
      events.set(candidate.providerEventId, {
        ...current,
        bookmakers: [...bookmakers.values()],
      });
    }
  return {
    events: [...events.values()],
    rejections: [
      ...pages.flatMap((page) => page.rejections ?? []),
      ...participantConflicts,
    ],
    hasMore: false,
    retrievedAt: (retrievedAt ?? new Date(0).toISOString()) as IsoTimestamp,
    eventRetrievedAt: Object.fromEntries(eventRetrievedAt),
  };
};

export const reconstructSharpOddsRun = async (
  control: OddsControlPlaneStore,
  runId: string,
) => {
  const pages: SharpApiOddsPage[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined = "start";
  for (let guard = 0; guard < 100; guard += 1) {
    if (!token) return mergeSharpOddsPages(pages);
    if (seenTokens.has(token))
      throw new SharpApiError(
        "invalid-response",
        false,
        undefined,
        "odds:sealed-page-cycle",
      );
    seenTokens.add(token);
    const sealed = await control.getPage(runId, token);
    if (!sealed)
      throw new SharpApiError(
        "invalid-response",
        false,
        undefined,
        "odds:sealed-page-missing",
      );
    for (const item of sealed.normalizedItems) {
      const material = item as SharpPageMaterial;
      if (material.kind !== "sharpapi")
        throw new Error("provider-page-material-mismatch");
      pages.push(material.page);
    }
    token = sealed.nextPageToken;
  }
  throw new SharpApiError(
    "invalid-response",
    false,
    undefined,
    "odds:sealed-page-limit",
  );
};
const normalizationGaps = (
  runId: string,
  leagueKey: string,
  page: SharpApiOddsPage,
  books: Readonly<
    Record<string, "offered" | "comparison" | "collected" | "splits">
  >,
): OddsEvidenceGap[] =>
  (page.rejections ?? []).flatMap((rejection) => {
    const bookRole = rejection.sportsbookId
      ? books[rejection.sportsbookId]
      : undefined;
    const boundaryReason = rejection.participantBoundaryReason;
    if (
      !rejection.providerEventId ||
      (!boundaryReason && (!rejection.sportsbookId || !bookRole))
    )
      return [];
    return [
      {
        gapId: digest([
          runId,
          rejection.providerEventId,
          rejection.sportsbookId,
          boundaryReason ?? rejection.reason,
          rejection.auditId,
        ]),
        runId,
        leagueKey,
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: rejection.providerEventId,
        ...(rejection.sportsbookId
          ? { sportsbookId: rejection.sportsbookId }
          : {}),
        policyVersion: oddsCollectionPolicyVersion,
        bookRole: bookRole ?? "comparison",
        sourceState:
          rejection.reason === "missing-provider-timestamp"
            ? "missing"
            : "unsupported",
        reason: boundaryReason ?? rejection.reason,
        observedAt: page.retrievedAt,
      },
    ];
  });
const scheduleEvent = (
  providerId: string,
  league: { readonly sportKey: string; readonly leagueKey: string },
  raw: {
    readonly providerEventId: string;
    readonly providerEventUuid?: string;
    readonly awayTeam: string;
    readonly homeTeam: string;
    readonly awayClubKey?: string;
    readonly homeClubKey?: string;
    readonly startsAt: IsoTimestamp;
  },
  observedAt: IsoTimestamp,
) => ({
  providerEventId: raw.providerEventId,
  ...(raw.providerEventUuid
    ? { providerEventUuid: raw.providerEventUuid }
    : {}),
  sportKey: league.sportKey as never,
  leagueKey: league.leagueKey,
  participantLabels: [raw.awayTeam, raw.homeTeam] as [string, string],
  ...(raw.awayClubKey && raw.homeClubKey
    ? {
        participantIdentityKeys: [raw.awayClubKey, raw.homeClubKey] as [
          string,
          string,
        ],
      }
    : {}),
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

const scheduleExclusionGaps = (
  runId: string,
  leagueKey: string,
  page: SharpApiSchedulePage,
): OddsEvidenceGap[] =>
  (page.exclusions ?? []).map((exclusion) => ({
    gapId: digest([
      runId,
      exclusion.providerEventId,
      exclusion.reason,
      exclusion.auditId,
    ]),
    runId,
    leagueKey,
    providerId: SHARP_API_PROVIDER_ID,
    providerEventId: exclusion.providerEventId,
    policyVersion: oddsCollectionPolicyVersion,
    bookRole: "comparison",
    sourceState: "unsupported",
    reason: exclusion.reason,
    observedAt: page.retrievedAt,
  }));

const scheduleConflictGap = (
  runId: string,
  leagueKey: string,
  providerEventId: string,
  reason: ScheduleEventConflictReason,
  observedAt: IsoTimestamp,
): OddsEvidenceGap => ({
  // Per-run occurrence and bounded category are immutable audit identity.
  gapId: digest([
    "schedule-event-conflict",
    runId,
    SHARP_API_PROVIDER_ID,
    leagueKey,
    providerEventId,
    reason,
  ]),
  runId,
  leagueKey,
  providerId: SHARP_API_PROVIDER_ID,
  policyVersion: oddsCollectionPolicyVersion,
  bookRole: "comparison",
  sourceState: "unsupported",
  reason,
  observedAt,
});

interface ScheduleRowDisposition {
  readonly eventIdentityHash: string;
  readonly status: "accepted" | "conflict";
  readonly reason?: ScheduleEventConflictReason;
}

const scheduleEventIdentityHash = (
  leagueKey: string,
  providerEventId: string,
) => digest([SHARP_API_PROVIDER_ID, leagueKey, providerEventId]);

const persistedScheduleDispositions = (
  page: SealedOddsPage,
  leagueKey: string,
  events: SharpApiSchedulePage["events"],
): readonly ScheduleRowDisposition[] => {
  const value = page.normalizedItems[0];
  if (!Array.isArray(value) || value.length !== events.length)
    throw new Error("schedule-conflict-disposition-invalid");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("schedule-conflict-disposition-invalid");
    const candidate = item as Partial<ScheduleRowDisposition>;
    const expectedHash = scheduleEventIdentityHash(
      leagueKey,
      events[index]!.providerEventId,
    );
    if (
      candidate.eventIdentityHash !== expectedHash ||
      !["accepted", "conflict"].includes(candidate.status ?? "") ||
      (candidate.status === "conflict" &&
        !isScheduleEventConflictReason(candidate.reason)) ||
      (candidate.status === "accepted" && candidate.reason !== undefined)
    )
      throw new Error("schedule-conflict-disposition-invalid");
    return candidate as ScheduleRowDisposition;
  });
};

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
  return result;
}

/** A quota-safe single-event refresh. The deterministic attempt identity is the
 * durable deduplication boundary shared by scheduler and manual triggers. */
export async function runFocusedSharpOddsIngestion(input: {
  readonly events: EventIngestionStore;
  readonly odds: LiveOddsPersister;
  readonly control: OddsControlPlaneStore;
  readonly sharpApiKey: string;
  readonly request: FocusedSharpOddsRequest;
  readonly now?: Date;
  readonly fetchFocused?: typeof fetchSharpApiEventOdds;
  readonly metrics?: OddsControlPlaneMetrics;
}) {
  const now = input.now ?? new Date();
  const sharpLeague = sharpApiLeagues.find(
    ({ leagueKey }) => leagueKey === input.request.leagueKey,
  );
  if (!sharpLeague || !input.request.providerEventId.trim())
    throw new Error("focused-request-invalid");
  const policy = productionOddsCollectionPolicies.find(
    ({ leagueKey }) => leagueKey === sharpLeague.leagueKey,
  );
  if (!policy) throw new Error("coverage-missing");
  const pollingWindowSeconds = input.request.pollingWindowSeconds ?? 300;
  if (!Number.isSafeInteger(pollingWindowSeconds) || pollingWindowSeconds < 60)
    throw new Error("focused-request-invalid");
  const identity = sharpOddsRequestIdentity({
    leagueKey: sharpLeague.leagueKey,
    endpointMode: "focused",
    providerEventId: input.request.providerEventId,
    marketSet: ["main"],
    now,
    pollingWindowSeconds,
  });
  const runId = `focused:${sharpLeague.leagueKey}:${identity}`;
  const binding = await input.events.resolveExactCanonicalBinding({
    providerId: SHARP_API_PROVIDER_ID,
    providerEventId: input.request.providerEventId,
    sportKey: sharpLeague.sportKey,
    leagueKey: sharpLeague.leagueKey,
  });
  if (!binding) throw new Error("focused-event-binding-unavailable");
  const attempt = {
    attemptId: identity,
    runId,
    pageToken: input.request.providerEventId,
    requestedAt: now.toISOString(),
    providerId: SHARP_API_PROVIDER_ID,
    leagueKey: sharpLeague.leagueKey,
    capability: "odds" as const,
  };
  const dimensions = {
    provider: SHARP_API_PROVIDER_ID,
    league: sharpLeague.leagueKey,
    endpoint: "focused",
    markets: "main",
  };
  const healthKey = `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:odds`;
  const health = await input.control.getHealth(healthKey);
  const cooldownMs = health?.cooldownUntil
    ? Date.parse(health.cooldownUntil)
    : undefined;
  const malformedCooldown =
    health?.healthy === false &&
    health.cooldownUntil !== undefined &&
    !Number.isFinite(cooldownMs);
  const rateRemaining = health?.rateWindow?.remaining;
  const rateResetMs = health?.rateWindow?.resetsAt
    ? Date.parse(health.rateWindow.resetsAt)
    : undefined;
  const rateWindowExpired =
    rateResetMs !== undefined &&
    Number.isFinite(rateResetMs) &&
    rateResetMs <= now.getTime();
  if (
    malformedCooldown ||
    (cooldownMs !== undefined && cooldownMs > now.getTime()) ||
    (health?.rateWindow !== undefined &&
      rateRemaining === undefined &&
      !rateWindowExpired) ||
    (health?.rateWindow !== undefined &&
      !rateWindowExpired &&
      rateRemaining !== undefined &&
      rateRemaining - 1 < (policy.providers[0]?.quotaReserve ?? 100)) ||
    (health?.rateWindow === undefined &&
      health?.quotaRemaining !== undefined &&
      health.quotaRemaining - 1 < (policy.providers[0]?.quotaReserve ?? 100))
  ) {
    input.metrics?.emit("OddsQuotaBlocked", 1, dimensions);
    input.metrics?.emit("OddsRateWindowBlocked", 1, dimensions);
    return {
      status: "retryable" as const,
      reason:
        malformedCooldown || cooldownMs !== undefined
          ? "rate-limited"
          : "quota-reserve",
      ...(!malformedCooldown && health?.cooldownUntil
        ? { retryAt: health.cooldownUntil }
        : {}),
    };
  }
  const reserved = await input.control.reserveQuotaAttempt(
    healthKey,
    policy.providers[0]?.quotaReserve ?? 100,
    1,
    attempt,
  );
  if (!reserved) {
    const existingAttempt = await input.control.getAttempt(identity);
    if (existingAttempt) {
      input.metrics?.emit("OddsRequestDeduplicated", 1, dimensions);
      return { status: "deduplicated" as const, requestIdentity: identity };
    }
    input.metrics?.emit("OddsRateWindowBlocked", 1, dimensions);
    return { status: "retryable" as const, reason: "quota-reserve" };
  }
  input.metrics?.emit("OddsProviderRequest", 1, dimensions);
  try {
    const operation = await (input.fetchFocused ?? fetchSharpApiEventOdds)(
      sharpLeague,
      input.request.providerEventId,
      input.sharpApiKey,
    );
    const persisted = await persistSharpApiOddsPage(
      input.events,
      input.odds,
      sharpLeague,
      operation.page,
      policy.providers[0]?.books,
      undefined,
      policy.providers[0]?.expectedBooks,
    );
    const gaps = [
      ...evidenceGaps(
        runId,
        SHARP_API_PROVIDER_ID,
        sharpLeague.leagueKey,
        operation.page.events,
        policy.markets,
        policy.providers[0]?.books ?? {},
        operation.page.retrievedAt,
        [input.request.providerEventId],
        policy.providers[0]?.expectedBooks,
      ),
      ...normalizationGaps(
        runId,
        sharpLeague.leagueKey,
        operation.page,
        policy.providers[0]?.books ?? {},
      ),
    ];
    for (const gap of gaps) await input.control.putGap(gap);
    await input.control.completeAttempt({
      ...attempt,
      state: "succeeded",
      quotaCost: 1,
      completedAt: now.toISOString(),
    });
    const responseRateWindow = nonEmptyRateWindow(
      operation.page.responseMetadata?.rateWindow,
    );
    await input.control.reconcileQuota(
      healthKey,
      1,
      1,
      responseRateWindow?.remaining,
      now.toISOString(),
    );
    await input.control.putHealth({
      ...healthyOddsProviderState(await input.control.getHealth(healthKey), {
        providerId: SHARP_API_PROVIDER_ID,
        healthKey,
        updatedAt: now.toISOString(),
        consecutiveSuccesses: (health?.consecutiveSuccesses ?? 0) + 1,
      }),
      partialEvidenceCount: persisted.partialEvidence + gaps.length,
      ...(responseRateWindow ? { rateWindow: responseRateWindow } : {}),
    });
    for (const [name, value] of [
      ["OddsSnapshotCreated", persisted.snapshotsCreated],
      ["OddsSnapshotDuplicate", persisted.snapshotsExisting],
      ["OddsCurrentAdvanced", persisted.currentAdvanced],
      ["OddsCurrentRetained", persisted.currentRetained],
      ["OddsPartialEvidence", persisted.partialEvidence + gaps.length],
      ["OddsMarketSuspended", persisted.suspendedEvidence],
    ] as const)
      input.metrics?.emit(name, value, dimensions);
    for (const [reason, count] of Object.entries(persisted.rejectionCounts))
      input.metrics?.emit("OddsNormalizationRejected", count, {
        ...dimensions,
        reason,
      });
    input.metrics?.emit("OddsNormalizedObservation", persisted.observations, {
      ...dimensions,
      partial: gaps.length > 0 ? "true" : "false",
    });
    for (const [sportsbook, count] of Object.entries(
      persisted.observationsBySportsbook,
    ))
      input.metrics?.emit("OddsNormalizedObservationBySportsbook", count, {
        ...dimensions,
        sportsbook,
      });
    return {
      status: "completed" as const,
      requestIdentity: identity,
      observations: persisted.observations,
      gaps: gaps.length,
    };
  } catch (error) {
    const reason = capabilityFailure(error);
    const failureStage =
      error instanceof SharpApiError ? error.stage : undefined;
    await input.control.completeAttempt({
      ...attempt,
      state: "failed",
      quotaCost: 1,
      completedAt: now.toISOString(),
      failureReason: reason,
      ...(failureStage ? { failureStage } : {}),
    });
    input.metrics?.emit("OddsProviderFailure", 1, {
      ...dimensions,
      reason,
      ...(failureStage ? { failureStage } : {}),
    });
    const decision = decideOddsRetry({
      error,
      attempt: 1,
      now,
      ...(error instanceof SharpApiError && error.retryAt
        ? { providerRetryAt: error.retryAt }
        : {}),
      jitter: () => 0,
    });
    await input.control.putHealth(
      unhealthyOddsProviderState(await input.control.getHealth(healthKey), {
        providerId: SHARP_API_PROVIDER_ID,
        healthKey,
        now,
        decision,
        cooldownSeconds: policy.providers[0]?.cooldownSeconds ?? 1_800,
        ...(failureStage ? { failureStage } : {}),
      }),
    );
    throw error;
  }
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
  readonly fetchSharpFeatured?: typeof fetchSharpApiFeaturedOdds;
  readonly fetchSharpAccount?: typeof fetchSharpApiAccount;
  readonly fetchSharpSplits?: typeof fetchSharpApiSplitsPage;
  readonly fetchSharpSplitHistory?: typeof fetchSharpApiSplitHistory;
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
  const canonicalOddsEventsByLeague = new Map<
    string,
    CanonicalSharpOddsEvents
  >();
  const seenScheduleEvents = new Set<string>();
  const sharpScheduleHealthy = new Set<string>();
  const scheduleReady = new Set<string>();
  const storedScheduleReady = new Set<string>();
  const scheduleFailures = new Map<string, string>();
  for (const sharpLeague of sharpApiLeagues) {
    let scheduleStage: ScheduleFailureStage = "initialize";
    let activeScheduleRunId: string | undefined;
    let scheduleQuotaCost = 0;
    let acceptedFutureScheduleEvents = 0;
    let quarantinedScheduleEvents = 0;
    let contradictoryCommittedScheduleEvidence = false;
    let pendingConflictMetricDelivery = false;
    let latestScheduleRateWindow: OddsProviderHealth["rateWindow"];
    const currentScheduleStarts: string[] = [];
    const currentExpectedProviderEventIds: string[] = [];
    const schedulePolicy = productionScheduleDiscoveryPolicies.find(
      ({ providerId }) => providerId === SHARP_API_PROVIDER_ID,
    )!;
    try {
      scheduleStage = "health-read";
      const scheduleHealth = await input.control.getHealth(
        `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`,
      );
      if (
        scheduleHealth?.quotaRemaining !== undefined &&
        scheduleHealth.quotaRemaining <= schedulePolicy.quotaReserve
      )
        throw new Error("quota-reserve");
      const checkpointKey = `schedule:${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`;
      scheduleStage = "checkpoint-read";
      const checkpoint = await input.control.getCheckpoint(checkpointKey);
      const priorScheduleBindings = checkpointScheduleBindings(
        checkpoint,
      ).filter(({ startsAt }) => Date.parse(startsAt) > now.getTime());
      if (priorScheduleBindings.length > 0)
        storedScheduleReady.add(
          `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
        );
      if (priorScheduleBindings.length > 0)
        starts.set(
          sharpLeague.leagueKey,
          priorScheduleBindings.map(({ startsAt }) => startsAt),
        );
      if (priorScheduleBindings.length > 0)
        expectedProviderEvents.set(
          `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
          priorScheduleBindings.map(({ providerEventId }) => providerEventId),
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
        if (checkpoint.unavailableReason === "stored-event-conflict")
          scheduleFailures.set(
            sharpLeague.leagueKey,
            "schedule-stored-event-conflict",
          );
        else if (
          storedScheduleReady.has(
            `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
          )
        ) {
          sharpScheduleHealthy.add(sharpLeague.leagueKey);
          scheduleReady.add(
            `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
          );
        } else
          scheduleFailures.set(
            sharpLeague.leagueKey,
            "schedule-dependency-failed",
          );
        continue;
      }
      const claimNow = liveNow();
      scheduleStage = "ownership-claim";
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
      scheduleStage = "run-start";
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
          scheduleStage = "schedule-fetch";
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
            const failureStage =
              error instanceof SharpApiError ? error.stage : undefined;
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
                : capabilityFailure(error),
              ...(failureStage ? { failureStage } : {}),
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
            throw error;
          }
          sealed = {
            runId,
            pageToken,
            ...(fetched.hasMore && fetched.nextOffset !== undefined
              ? { nextPageToken: String(fetched.nextOffset) }
              : {}),
            responseDigest: digest(fetched),
            normalizedItems: [fetched],
            gaps: scheduleExclusionGaps(runId, sharpLeague.leagueKey, fetched),
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
        latestScheduleRateWindow =
          nonEmptyRateWindow(page.responseMetadata?.rateWindow) ??
          latestScheduleRateWindow;
        scheduleStage = "event-reconcile";
        const conflictPageToken = `${pageToken}:schedule-conflicts`;
        const existingConflictPage = await input.control.getPage(
          runId,
          conflictPageToken,
        );
        const pageDispositions: ScheduleRowDisposition[] = existingConflictPage
          ? [
              ...persistedScheduleDispositions(
                existingConflictPage,
                sharpLeague.leagueKey,
                page.events,
              ),
            ]
          : [];
        const pageConflictGaps: OddsEvidenceGap[] = existingConflictPage
          ? [...existingConflictPage.gaps]
          : [];
        for (const [eventIndex, event] of page.events.entries()) {
          const scheduleIdentity = `${sharpLeague.leagueKey}:${event.providerEventId}`;
          if (seenScheduleEvents.has(scheduleIdentity)) {
            if (!existingConflictPage)
              pageDispositions.push({
                eventIdentityHash: scheduleEventIdentityHash(
                  sharpLeague.leagueKey,
                  event.providerEventId,
                ),
                status: "accepted",
              });
            continue;
          }
          seenScheduleEvents.add(scheduleIdentity);
          const persistedDisposition = existingConflictPage
            ? pageDispositions[eventIndex]!
            : undefined;
          if (persistedDisposition?.status === "conflict") {
            quarantinedScheduleEvents += 1;
            continue;
          }
          if (!persistedDisposition)
            try {
              await bindScheduleEvent(
                input.events,
                SHARP_API_PROVIDER_ID,
                sharpLeague,
                event,
                page.retrievedAt,
              );
              pageDispositions.push({
                eventIdentityHash: scheduleEventIdentityHash(
                  sharpLeague.leagueKey,
                  event.providerEventId,
                ),
                status: "accepted",
              });
            } catch (error) {
              const conflictReason = scheduleEventConflictReason(error);
              if (!conflictReason) throw error;
              quarantinedScheduleEvents += 1;
              pageDispositions.push({
                eventIdentityHash: scheduleEventIdentityHash(
                  sharpLeague.leagueKey,
                  event.providerEventId,
                ),
                status: "conflict",
                reason: conflictReason,
              });
              pageConflictGaps.push(
                scheduleConflictGap(
                  runId,
                  sharpLeague.leagueKey,
                  event.providerEventId,
                  conflictReason,
                  page.retrievedAt,
                ),
              );
              continue;
            }
          currentScheduleStarts.push(event.startsAt);
          currentExpectedProviderEventIds.push(event.providerEventId);
          if (Date.parse(event.startsAt) > now.getTime())
            acceptedFutureScheduleEvents += 1;
        }
        await assertAndRenewOwner(
          input.control,
          checkpointKey,
          runId,
          ownerId,
          liveNow,
        );
        if (!sealed.committedAt) scheduleStage = "schedule-page-commit";
        if (!sealed.committedAt)
          await input.control.commitEvidencePage(
            runId,
            pageToken,
            now.toISOString(),
          );
        const committedPage = await input.control.getPage(runId, pageToken);
        if (!committedPage?.committedAt)
          throw new Error("schedule-page-commit-missing");
        for (const gap of committedPage.gaps) await input.control.putGap(gap);

        if (!existingConflictPage) {
          scheduleStage = "conflict-page-seal";
          const conflictEvidencePage: SealedOddsPage = {
            runId,
            pageToken: conflictPageToken,
            responseDigest: digest({ pageDispositions, pageConflictGaps }),
            normalizedItems: [pageDispositions],
            gaps: pageConflictGaps,
            quotaCost: 0,
            sealedAt: now.toISOString(),
          };
          await assertAndRenewOwner(
            input.control,
            checkpointKey,
            runId,
            ownerId,
            liveNow,
          );
          await input.control.sealPage(conflictEvidencePage);
        }
        let committedConflictPage =
          existingConflictPage ??
          (await input.control.getPage(runId, conflictPageToken));
        if (!committedConflictPage?.committedAt) {
          scheduleStage = "conflict-page-commit";
          await input.control.commitEvidencePage(
            runId,
            conflictPageToken,
            now.toISOString(),
          );
          committedConflictPage = await input.control.getPage(
            runId,
            conflictPageToken,
          );
        }
        if (!committedConflictPage?.committedAt)
          throw new Error("schedule-conflict-page-commit-missing");
        await assertAndRenewOwner(
          input.control,
          checkpointKey,
          runId,
          ownerId,
          liveNow,
        );
        for (const gap of committedConflictPage.gaps)
          await input.control.putGap(gap);

        if (!committedPage?.metricDeliveredAt) {
          scheduleStage = "schedule-metrics";
          for (const reason of [
            "participant-out-of-scope",
            "same-club-matchup",
            "catalogue-derivative",
          ] as const) {
            const count =
              page.exclusions?.filter((item) => item.reason === reason)
                .length ?? 0;
            if (count > 0)
              input.metrics?.emit("OddsScheduleExcluded", count, {
                provider: SHARP_API_PROVIDER_ID,
                league: sharpLeague.leagueKey,
                reason,
              });
          }
          await input.control.markPageMetricDelivered(
            runId,
            pageToken,
            now.toISOString(),
          );
        }
        if (!committedConflictPage.metricDeliveredAt) {
          scheduleStage = "conflict-metrics";
          const persistedConflictCounts = new Map<
            ScheduleEventConflictReason,
            number
          >();
          for (const gap of committedConflictPage.gaps) {
            if (!isScheduleEventConflictReason(gap.reason))
              throw new Error("schedule-conflict-gap-invalid");
            persistedConflictCounts.set(
              gap.reason,
              (persistedConflictCounts.get(gap.reason) ?? 0) + 1,
            );
          }
          if (persistedConflictCounts.size > 0 && !input.metrics) {
            pendingConflictMetricDelivery = true;
            throw new Error("schedule-conflict-metric-pending");
          }
          for (const [reason, count] of persistedConflictCounts)
            input.metrics?.emit("OddsScheduleEventConflict", count, {
              provider: SHARP_API_PROVIDER_ID,
              league: sharpLeague.leagueKey,
              reason,
            });
          // The dedicated evidence page is the durable delivery marker. A
          // sink crash after emit but before this write can redeliver once;
          // downstream aggregation must therefore remain idempotent-aware.
          await input.control.markPageMetricDelivered(
            runId,
            conflictPageToken,
            now.toISOString(),
          );
        }
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
      if (quarantinedScheduleEvents > 0 && acceptedFutureScheduleEvents === 0) {
        scheduleStage = "conflict-checkpoint";
        contradictoryCommittedScheduleEvidence = true;
        await input.control.putCheckpoint({
          ...(checkpoint?.version === undefined
            ? {}
            : { version: checkpoint.version }),
          leagueKey: checkpointKey,
          providerId: SHARP_API_PROVIDER_ID,
          completedAt: now.toISOString(),
          nextDueAt: new Date(now.getTime() + 3_600_000).toISOString(),
          runId,
          upcomingStarts: [],
          expectedProviderEventIds: [],
          expectedProviderEvents: [],
          unavailableReason: "stored-event-conflict",
        });
      }
      if (quarantinedScheduleEvents > 0 && acceptedFutureScheduleEvents === 0)
        throw new Error("schedule-stored-event-conflict");
      const sharpBindings = currentScheduleStarts
        .map((startsAt, index) => ({
          providerEventId: currentExpectedProviderEventIds[index] ?? "unknown",
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
      scheduleStage = "checkpoint-write";
      await input.control.putCheckpoint({
        ...(checkpoint?.version === undefined
          ? {}
          : { version: checkpoint.version }),
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
      scheduleStage = "health-write";
      await input.control.putHealth({
        ...healthyOddsProviderState(authoritativeScheduleHealth, {
          providerId: SHARP_API_PROVIDER_ID,
          healthKey: `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`,
          updatedAt: now.toISOString(),
          consecutiveSuccesses: (scheduleHealth?.consecutiveSuccesses ?? 0) + 1,
        }),
        ...(quarantinedScheduleEvents > 0
          ? {
              degraded: true,
              status: "degraded" as const,
              degradedReason: "stored-event-conflict" as const,
              degradedCount: quarantinedScheduleEvents,
            }
          : {}),
        ...(authoritativeScheduleHealth?.quotaRemaining === undefined
          ? {}
          : {
              quotaRemaining: authoritativeScheduleHealth.quotaRemaining,
            }),
        ...(latestScheduleRateWindow
          ? { rateWindow: latestScheduleRateWindow }
          : {}),
      });
      scheduleStage = "ownership-clear";
      await clearOwned(checkpointKey, runId);
      sharpScheduleHealthy.add(sharpLeague.leagueKey);
      scheduleReady.add(`${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`);
    } catch (error) {
      const reason = scheduleCapabilityFailure(error, scheduleStage);
      const failureStage =
        error instanceof SharpApiError ? error.stage : undefined;
      const scheduleHealthKey = `${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}:schedule`;
      // Another healthy worker owning this league is coordination, not a
      // provider outage. Recording it as unhealthy can race the real owner's
      // successful health write and manufacture a 30-minute SharpAPI cooldown.
      if (reason !== "provider-recovering")
        await input.control.putHealth(
          unhealthyOddsProviderState(
            await input.control.getHealth(scheduleHealthKey),
            {
              providerId: SHARP_API_PROVIDER_ID,
              healthKey: scheduleHealthKey,
              now,
              decision: decideOddsRetry({
                error:
                  reason === "stored-event-conflict"
                    ? new Error(reason)
                    : error,
                attempt: 1,
                now,
                ...(error instanceof SharpApiError && error.retryAt
                  ? { providerRetryAt: error.retryAt }
                  : {}),
                jitter: () => 0,
              }),
              cooldownSeconds: 1_800,
              ...(failureStage ? { failureStage } : {}),
            },
          ),
        );
      scheduleFailures.set(sharpLeague.leagueKey, `schedule-${reason}`);
      if (activeScheduleRunId) {
        const run = await input.control.getRun(activeScheduleRunId);
        if (run)
          await input.control.putRun({
            ...run,
            status: "failed",
            updatedAt: now.toISOString(),
            failureReason: reason,
            ...(failureStage ? { failureStage } : {}),
            quotaCost: scheduleQuotaCost,
          });
      }
      if (reason === "stored-event-conflict" && activeScheduleRunId)
        await clearOwned(
          `schedule:${SHARP_API_PROVIDER_ID}:${sharpLeague.leagueKey}`,
          activeScheduleRunId,
        );
      input.metrics?.emit("OddsScheduleFailure", 1, {
        league: sharpLeague.leagueKey,
        provider: SHARP_API_PROVIDER_ID,
        reason,
        ...(failureStage ? { failureStage } : {}),
      });
      if (
        reason !== "stored-event-conflict" &&
        !pendingConflictMetricDelivery &&
        !contradictoryCommittedScheduleEvidence &&
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
            // One structurally invalid 200 response is eligible for one
            // identical refetch. Reserve the worst case up front and reconcile
            // back to one on the common first-call success path.
            requestCost: 2,
            probeRequestCost: 1,
            restartTerminalCursorRun: true,
            failureRequestCost: sharpOddsFailureRequestCost,
            reconcileMissing: async ({ runId, seenProviderEventIds }) => {
              const expectedEvents =
                expectedProviderEvents.get(
                  `${SHARP_API_PROVIDER_ID}:${policy.leagueKey}`,
                ) ?? [];
              const merged = await reconstructSharpOddsRun(
                input.control,
                runId,
              );
              const expectedBooks = policy.providers[0]?.expectedBooks;
              const persisted = await persistSharpApiOddsPage(
                input.events,
                input.odds,
                sharpLeague,
                merged,
                policy.providers[0]?.books,
                (outcome) => {
                  const dimensions = {
                    provider: SHARP_API_PROVIDER_ID,
                    league: policy.leagueKey,
                    endpoint: "featured",
                    markets: "main",
                  };
                  if (outcome.snapshot)
                    input.metrics?.emit(
                      outcome.snapshot === "created"
                        ? "OddsSnapshotCreated"
                        : "OddsSnapshotDuplicate",
                      1,
                      dimensions,
                    );
                  if (outcome.current)
                    input.metrics?.emit(
                      outcome.current === "advanced"
                        ? "OddsCurrentAdvanced"
                        : "OddsCurrentRetained",
                      1,
                      dimensions,
                    );
                  if (outcome.mirrorFailure)
                    input.metrics?.emit(
                      "OddsExactSnapshotMirrorFailure",
                      1,
                      dimensions,
                    );
                },
                expectedBooks,
                new Set(expectedEvents),
              );
              input.metrics?.emit(
                "OddsNormalizedObservation",
                persisted.observations,
                { provider: SHARP_API_PROVIDER_ID, league: policy.leagueKey },
              );
              for (const [sportsbook, count] of Object.entries(
                persisted.observationsBySportsbook,
              ))
                input.metrics?.emit(
                  "OddsNormalizedObservationBySportsbook",
                  count,
                  {
                    provider: SHARP_API_PROVIDER_ID,
                    league: policy.leagueKey,
                    sportsbook,
                  },
                );
              for (const [name, value] of [
                ["OddsStaleEvidence", persisted.staleEvidence],
                ["OddsPartialEvidence", persisted.partialEvidence],
                ["OddsMarketSuspended", persisted.suspendedEvidence],
                [
                  "OddsMissingProviderTimestamp",
                  persisted.rejectionCounts["missing-provider-timestamp"] ?? 0,
                ],
              ] as const)
                input.metrics?.emit(name, value, {
                  provider: SHARP_API_PROVIDER_ID,
                  league: policy.leagueKey,
                });
              for (const [reason, count] of Object.entries(
                persisted.rejectionCounts,
              ))
                input.metrics?.emit("OddsNormalizationRejected", count, {
                  provider: SHARP_API_PROVIDER_ID,
                  league: policy.leagueKey,
                  reason,
                });
              const persistedBooks = Object.entries(
                persisted.observationsBySportsbook,
              ).filter(([, count]) => count > 0);
              const observedBooks = new Set(
                merged.events.flatMap((event) =>
                  event.bookmakers
                    .map(({ id }) => id)
                    .filter((id) => policy.providers[0]?.books[id]),
                ),
              );
              input.metrics?.emit(
                "OddsRunDistinctApprovedBooksObserved",
                observedBooks.size,
                {
                  provider: SHARP_API_PROVIDER_ID,
                  league: policy.leagueKey,
                },
              );
              input.metrics?.emit(
                "OddsRunDistinctApprovedBooksPersisted",
                persistedBooks.length,
                {
                  provider: SHARP_API_PROVIDER_ID,
                  league: policy.leagueKey,
                },
              );
              input.metrics?.emit("OddsRunPinnacleCoverage", 1, {
                provider: SHARP_API_PROVIDER_ID,
                league: policy.leagueKey,
                status: observedBooks.has("pinnacle")
                  ? "observed"
                  : "coverage-unverified",
              });
              const omitted = expectedEvents.filter(
                (providerEventId) => !seenProviderEventIds.has(providerEventId),
              );
              if (expectedBooks && input.odds.persistAvailability)
                for (const providerEventId of omitted) {
                  const canonical =
                    await input.events.resolveExactCanonicalBinding({
                      providerId: SHARP_API_PROVIDER_ID,
                      providerEventId,
                      sportKey: sharpLeague.sportKey,
                      leagueKey: sharpLeague.leagueKey,
                    });
                  if (!canonical)
                    throw new Error("sharpapi-event-binding-unavailable");
                  for (const [sportsbookId, marketKeys] of Object.entries(
                    expectedBooks,
                  ))
                    for (const marketKey of marketKeys) {
                      const identity = fixtureOddsGroupAvailabilityIdentity({
                        canonicalEventId: canonical.id,
                        canonicalEventVersion: canonical.version,
                        sportKey: canonical.sportKey,
                        marketKey,
                        sportsbookId,
                      });
                      await input.odds.persistAvailability({
                        identity,
                        state: "missing",
                        observedAt: now.toISOString(),
                        evidenceId: sha256Hex(
                          JSON.stringify([
                            SHARP_API_PROVIDER_ID,
                            providerEventId,
                            identity,
                            "missing",
                            runId,
                          ]),
                        ),
                        reason: "provider-market-omitted",
                      });
                    }
                }
              const gaps = evidenceGaps(
                runId,
                SHARP_API_PROVIDER_ID,
                policy.leagueKey,
                merged.events,
                policy.markets,
                policy.providers[0]?.books ?? {},
                merged.retrievedAt,
                omitted,
                expectedBooks,
              );
              canonicalOddsEventsByLeague.set(
                policy.leagueKey,
                persisted.canonicalOddsEvents,
              );
              return gaps;
            },
            probe: async () => {
              const account = await (
                input.fetchSharpAccount ?? fetchSharpApiAccount
              )(input.sharpApiKey);
              const accountRateWindow = nonEmptyRateWindow(
                account.responseMetadata?.rateWindow,
              );
              input.metrics?.emit("OddsAccountBookCapacity", account.maxBooks, {
                provider: SHARP_API_PROVIDER_ID,
              });
              return {
                quotaCost: 1,
                ...(accountRateWindow ? { rateWindow: accountRateWindow } : {}),
              };
            },
            fetchPage: async ({ runId, pageToken }) => {
              input.metrics?.emit("OddsProviderRequest", 1, {
                provider: SHARP_API_PROVIDER_ID,
                league: policy.leagueKey,
                endpoint: "featured",
                markets: "main",
                quota: "reserved",
              });
              const cursor = pageToken === "start" ? undefined : pageToken;
              const fetchPage = () =>
                (input.fetchSharpOdds
                  ? input.fetchSharpOdds(sharpLeague, input.sharpApiKey, cursor)
                  : (input.fetchSharpFeatured ?? fetchSharpApiFeaturedOdds)(
                      sharpLeague,
                      input.sharpApiKey,
                      cursor,
                    ).then(({ page }) => page)
                ).catch((error): SharpApiOddsPage => {
                  // The odds feed refreshes roughly every fifteen seconds
                  // and its cursors encode positions in that moving sort; a
                  // multi-page run can outlive its cursor, which the
                  // provider rejects with a 4xx. That is the feed moving,
                  // not a provider fault: the pages already committed stand
                  // and the next cadence pass refetches from the top.
                  // Failing the run instead poisoned the continuation with
                  // the dead cursor and cooled the league down for minutes.
                  if (
                    cursor !== undefined &&
                    error instanceof SharpApiError &&
                    error.code === "provider-rejected"
                  ) {
                    input.metrics?.emit("OddsCursorExpired", 1, {
                      provider: SHARP_API_PROVIDER_ID,
                      league: policy.leagueKey,
                    });
                    return {
                      events: [],
                      hasMore: false,
                      retrievedAt: liveNow().toISOString() as IsoTimestamp,
                    };
                  }
                  throw error;
                });
              const fetched = await fetchSharpOddsPageWithRetry(fetchPage, () =>
                input.metrics?.emit("OddsProviderInvalidResponseRetry", 1, {
                  provider: SHARP_API_PROVIDER_ID,
                  league: policy.leagueKey,
                  endpoint: "featured",
                }),
              );
              const { page } = fetched;
              const material: SharpPageMaterial = { kind: "sharpapi", page };
              const pageRateWindow = nonEmptyRateWindow(
                page.responseMetadata?.rateWindow,
              );
              return {
                items: [material],
                gaps: [
                  ...normalizationGaps(
                    runId,
                    policy.leagueKey,
                    page,
                    policy.providers[0]?.books ?? {},
                  ),
                ],
                quotaCost: fetched.quotaCost,
                ...(pageRateWindow
                  ? {
                      rateWindow: pageRateWindow,
                      ...(pageRateWindow.remaining === undefined
                        ? {}
                        : {
                            quotaRemaining: pageRateWindow.remaining,
                          }),
                    }
                  : {}),
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
          commit: ({
            providerId,
            items,
          }: {
            providerId: string;
            items: readonly unknown[];
          }) => {
            for (const item of items) {
              const material = item as SharpPageMaterial;
              if (
                providerId !== SHARP_API_PROVIDER_ID ||
                material.kind !== "sharpapi"
              )
                throw new Error("provider-page-material-mismatch");
            }
            // A market can be split across provider pages. Page commits only
            // validate and durably acknowledge the sealed material; the
            // complete reconstructed run is persisted once during final
            // reconciliation so line history never gains synthetic replay
            // observations with a later page retrieval timestamp.
            return Promise.resolve(false);
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
  const splitAmbiguity = resumeExpiredAmbiguousContinuation(
    splitContinuation,
    liveNow(),
  );
  if (splitAmbiguity.blocked) return results;
  splitContinuation = splitAmbiguity.continuation;
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
          const failureStage =
            error instanceof SharpApiError ? error.stage : undefined;
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
              : capabilityFailure(error),
            ...(failureStage ? { failureStage } : {}),
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
          throw error;
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
        readonly maxBooks: number;
        readonly responseMetadata?: {
          readonly rateWindow: OddsProviderHealth["rateWindow"];
        };
      };
      const accountRateWindow = nonEmptyRateWindow(
        account.responseMetadata?.rateWindow,
      );
      if (!Number.isSafeInteger(account.maxBooks) || account.maxBooks < 0)
        throw new Error("account-capacity-invalid");
      input.metrics?.emit("OddsAccountBookCapacity", account.maxBooks, {
        provider: SHARP_API_PROVIDER_ID,
      });
      const accountHealthKey = `${SHARP_API_PROVIDER_ID}:account:account`;
      await input.control.putHealth({
        ...healthyOddsProviderState(
          await input.control.getHealth(accountHealthKey),
          {
            providerId: SHARP_API_PROVIDER_ID,
            healthKey: accountHealthKey,
            consecutiveSuccesses: 1,
            updatedAt: now.toISOString(),
          },
        ),
        ...(accountRateWindow ? { rateWindow: accountRateWindow } : {}),
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
            const claimNow = liveNow();
            const ambiguity = resumeExpiredAmbiguousContinuation(
              await input.control.getContinuation(continuationKey),
              claimNow,
            );
            if (ambiguity.blocked) continue;
            const existingContinuation = ambiguity.continuation;
            // The runId encodes the split-history window. A failing run keeps
            // its continuation, so resuming an aged runId re-requests the same
            // stale window forever while the quota ratchet climbs — the
            // poisoning that blanked the splits board on 2026-08-10. Splits
            // runs are offset-paginated and restartable, so an aged run is
            // abandoned for a fresh window with a reset quota.
            const encodedRunStart = existingContinuation?.runId?.startsWith(
              `splits:${league.leagueKey}:`,
            )
              ? Date.parse(
                  existingContinuation.runId.slice(
                    `splits:${league.leagueKey}:`.length,
                  ),
                )
              : Number.NaN;
            const staleRun =
              !Number.isFinite(encodedRunStart) ||
              claimNow.getTime() - encodedRunStart > 45 * 60_000;
            const continuation = await input.control.claimContinuation({
              ...existingContinuation,
              leagueKey: continuationKey,
              runId:
                existingContinuation?.runId && !staleRun
                  ? existingContinuation.runId
                  : `splits:${league.leagueKey}:${now.toISOString()}`,
              providerId: SHARP_API_PROVIDER_ID,
              updatedAt: claimNow.toISOString(),
              startedAt: claimNow.toISOString(),
              capability: "splits",
              evidenceCommitted: false,
              quotaCost: staleRun ? 0 : (existingContinuation?.quotaCost ?? 0),
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
            let latestSplitRateWindow: OddsProviderHealth["rateWindow"];
            const currentSplitEvents = new Map<string, SharpApiSplitEvent>();
            const currentSplitBooks = new Map<string, Set<string>>();
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
                  const failureStage =
                    error instanceof SharpApiError ? error.stage : undefined;
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
                      : capabilityFailure(error),
                    ...(failureStage ? { failureStage } : {}),
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
                  throw error;
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
              const splitPage = sealed.normalizedItems[0] as Awaited<
                ReturnType<typeof fetchSharpApiSplitsPage>
              >;
              latestSplitRateWindow =
                nonEmptyRateWindow(splitPage.responseMetadata?.rateWindow) ??
                latestSplitRateWindow;
              for (const item of splitPage.items) {
                const prior = currentSplitEvents.get(item.providerEventId);
                if (
                  !prior ||
                  Date.parse(item.providerTimestamp) >
                    Date.parse(prior.providerTimestamp)
                )
                  currentSplitEvents.set(item.providerEventId, item);
                const books =
                  currentSplitBooks.get(item.providerEventId) ?? new Set();
                books.add(item.sportsbookId.toLowerCase());
                currentSplitBooks.set(item.providerEventId, books);
              }
              if (!sealed.committedAt) {
                await persistSharpApiSplitPage(
                  input.events,
                  input.splits,
                  league,
                  splitPage,
                  canonicalOddsEventsByLeague.get(league.leagueKey) ?? [],
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
            const historyWindow = splitHistoryWindow(
              runId,
              league.leagueKey,
              now,
            );
            for (const sourceEvent of currentSplitEvents.values()) {
              const presentBooks =
                currentSplitBooks.get(sourceEvent.providerEventId) ?? new Set();
              const missingBooks = ["draftkings", "circa"].filter(
                (book) => !presentBooks.has(book),
              );
              if (missingBooks.length === 0) continue;
              const pageToken = `history:${digest([
                sourceEvent.providerEventId,
                historyWindow.startTime,
                historyWindow.endTime,
              ]).slice(0, 32)}`;
              let sealed = await input.control.getPage(runId, pageToken);
              if (!sealed) {
                await assertAndRenewOwner(
                  input.control,
                  continuationKey,
                  runId,
                  ownerId,
                  liveNow,
                );
                const attemptId = `${runId}:${pageToken}:${now.toISOString()}`;
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
                  throw new Error("split-history-attempt-reservation-conflict");
                splitQuotaCost += 1;
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
                let page: Awaited<ReturnType<typeof fetchSharpApiSplitHistory>>;
                try {
                  page = await paidCall(continuationKey, runId, () =>
                    (input.fetchSharpSplitHistory ?? fetchSharpApiSplitHistory)(
                      sourceEvent,
                      historyWindow.startTime,
                      historyWindow.endTime,
                      input.sharpApiKey,
                    ),
                  );
                } catch (error) {
                  const ambiguous = isAmbiguousTransport(error);
                  const failureStage =
                    error instanceof SharpApiError ? error.stage : undefined;
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
                      : capabilityFailure(error),
                    ...(failureStage ? { failureStage } : {}),
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
                  throw error;
                }
                sealed = {
                  runId,
                  pageToken,
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
              const historyPage = sealed.normalizedItems[0] as Awaited<
                ReturnType<typeof fetchSharpApiSplitHistory>
              >;
              latestSplitRateWindow =
                nonEmptyRateWindow(historyPage.responseMetadata?.rateWindow) ??
                latestSplitRateWindow;
              if (!sealed.committedAt) {
                const latest = latestSharpApiSplitHistoryByBook(
                  historyPage.items,
                  missingBooks,
                );
                await persistSharpApiSplitPage(
                  input.events,
                  input.splits,
                  league,
                  { items: latest, retrievedAt: historyPage.retrievedAt },
                  canonicalOddsEventsByLeague.get(league.leagueKey) ?? [],
                );
                input.metrics?.emit("OddsSplitHistoryFallback", 1, {
                  league: league.leagueKey,
                  provider: SHARP_API_PROVIDER_ID,
                });
                input.metrics?.emit(
                  "OddsSplitHistoryBooksRecovered",
                  latest.length,
                  {
                    league: league.leagueKey,
                    provider: SHARP_API_PROVIDER_ID,
                  },
                );
                if (latest.length < missingBooks.length)
                  input.metrics?.emit(
                    "OddsSplitHistoryBooksMissing",
                    missingBooks.length - latest.length,
                    {
                      league: league.leagueKey,
                      provider: SHARP_API_PROVIDER_ID,
                    },
                  );
                await input.control.commitPage(
                  runId,
                  pageToken,
                  now.toISOString(),
                );
              }
            }
            await input.control.putRun({
              ...(await input.control.getRun(runId))!,
              status: "completed",
              updatedAt: now.toISOString(),
              evidenceCommitted: true,
              quotaCost: splitQuotaCost,
            });
            const splitHealthKey = `${SHARP_API_PROVIDER_ID}:${league.leagueKey}:splits`;
            const splitHealth = await input.control.getHealth(splitHealthKey);
            await input.control.putHealth({
              ...healthyOddsProviderState(splitHealth, {
                providerId: SHARP_API_PROVIDER_ID,
                healthKey: splitHealthKey,
                consecutiveSuccesses:
                  (splitHealth?.consecutiveSuccesses ?? 0) + 1,
                updatedAt: now.toISOString(),
              }),
              ...(latestSplitRateWindow
                ? { rateWindow: latestSplitRateWindow }
                : {}),
            });
            await clearOwned(continuationKey, runId);
          } catch (error) {
            const reason = capabilityFailure(error);
            const failureStage =
              error instanceof SharpApiError ? error.stage : undefined;
            const splitHealthKey = `${SHARP_API_PROVIDER_ID}:${league.leagueKey}:splits`;
            await input.control.putHealth(
              unhealthyOddsProviderState(
                await input.control.getHealth(splitHealthKey),
                {
                  providerId: SHARP_API_PROVIDER_ID,
                  healthKey: splitHealthKey,
                  now,
                  decision: decideOddsRetry({
                    error,
                    attempt: 1,
                    now,
                    ...(error instanceof SharpApiError && error.retryAt
                      ? { providerRetryAt: error.retryAt }
                      : {}),
                    jitter: () => 0,
                  }),
                  cooldownSeconds: 1_800,
                  ...(failureStage ? { failureStage } : {}),
                },
              ),
            );
            input.metrics?.emit("OddsSplitFailure", 1, {
              league: league.leagueKey,
              provider: SHARP_API_PROVIDER_ID,
              reason,
              ...(failureStage ? { failureStage } : {}),
            });
            input.metrics?.emit("OddsSplitFailure", 1, {});
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
                  ...(failureStage ? { failureStage } : {}),
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
        nextDueAt: new Date(now.getTime() + 300_000).toISOString(),
        runId: accountRunId,
      });
      await clearOwned(splitCheckpointKey, accountRunId);
    } catch (error) {
      const reason = capabilityFailure(error);
      const failureStage =
        error instanceof SharpApiError ? error.stage : undefined;
      const accountHealthKey = `${SHARP_API_PROVIDER_ID}:account:account`;
      await input.control.putHealth(
        unhealthyOddsProviderState(
          await input.control.getHealth(accountHealthKey),
          {
            providerId: SHARP_API_PROVIDER_ID,
            healthKey: accountHealthKey,
            now,
            decision: decideOddsRetry({
              error,
              attempt: 1,
              now,
              ...(error instanceof SharpApiError && error.retryAt
                ? { providerRetryAt: error.retryAt }
                : {}),
              jitter: () => 0,
            }),
            cooldownSeconds: 1_800,
            ...(failureStage ? { failureStage } : {}),
          },
        ),
      );
      const run = await input.control.getRun(accountRunId);
      if (run)
        await input.control.putRun({
          ...run,
          status: reason === "quota-reserve" ? "skipped" : "failed",
          updatedAt: now.toISOString(),
          ...(reason === "quota-reserve"
            ? { skipReason: reason }
            : { failureReason: reason }),
          ...(failureStage ? { failureStage } : {}),
          quotaCost:
            (await input.control.getContinuation(splitCheckpointKey))
              ?.quotaCost ?? run.quotaCost,
        });
      input.metrics?.emit("OddsAccountFailure", 1, {
        provider: SHARP_API_PROVIDER_ID,
        reason,
        ...(failureStage ? { failureStage } : {}),
      });
    }
  }
  return results;
}
