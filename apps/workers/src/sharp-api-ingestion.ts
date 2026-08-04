import type {
  BettingSplitRepository,
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
} from "@find-the-edge/database";
import type {
  IsoTimestamp,
  OddsNormalizationReason,
} from "@find-the-edge/domain";
import { participantSelectionKey } from "@find-the-edge/domain";
import {
  normalizeSportsbook,
  oddsCollectionPolicyVersion,
} from "@find-the-edge/config";
import {
  SHARP_API_PROVIDER_ID,
  fetchSharpApiAccount,
  fetchSharpApiOddsPage,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  normalizedUpcomingEventIdentity,
  isSharpDerivativeMatchup,
  sharpApiLeagues,
  type SharpApiAccount,
  type SharpApiLeague,
  type SharpApiOddsPage,
  type SharpApiSchedulePage,
  type SharpApiSplitPage,
} from "@find-the-edge/providers";
import { reconcileScheduledProviderEvent } from "./schedule-reconciliation";

export interface SharpApiOddsPersister {
  persist(input: FixtureOddsIngestInput): Promise<FixtureOddsPersistResult>;
}

export interface SharpApiIngestionSummary {
  readonly account: SharpApiAccount;
  readonly leagues: number;
  readonly events: number;
  readonly observations: number;
  readonly splits: number;
  readonly splitsEntitled: boolean;
  readonly skippedLeagues: number;
}

const providerEvent = (
  league: SharpApiLeague,
  event: SharpApiOddsPage["events"][number],
  updatedAt: IsoTimestamp,
) => ({
  providerEventId: event.providerEventId,
  sportKey: league.sportKey,
  leagueKey: league.leagueKey,
  participantLabels: [event.awayTeam, event.homeTeam] as [string, string],
  startsAt: event.startsAt,
  status: "scheduled" as const,
  revision: {
    providerId: SHARP_API_PROVIDER_ID,
    authorityRank: 60,
    updatedAt,
    sequence: 0,
    token: updatedAt,
  },
});

const providerEventDay = (providerEventId: string) =>
  providerEventId.match(/(?:^|_)(\d{4}-\d{2}-\d{2})(?:_|$)/)?.[1];

const easternDay = (instant: IsoTimestamp) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));

const normalizedParticipant = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const splitProviderEventAliases = (
  providerEventId: string,
  leagueKey: SharpApiLeague["leagueKey"],
) => {
  if (leagueKey !== "mlb" || !/(?:^|_)\d{4}-\d{2}-\d{2}$/.test(providerEventId))
    return [];
  // SharpAPI's consensus split feed can omit the schedule/odds binding suffix
  // (for example `_b3`). Probe the finite provider suffix namespace rather
  // than dropping otherwise attributable evidence.
  return Array.from(
    { length: 10 },
    (_, suffix) => `${providerEventId}_b${suffix}`,
  );
};

const loadOdds = async (
  league: SharpApiLeague,
  apiKey: string,
  fetchPage: typeof fetchSharpApiOddsPage,
) => {
  const events = new Map<string, SharpApiOddsPage["events"][number]>();
  const rejections: NonNullable<SharpApiOddsPage["rejections"]>[number][] = [];
  let cursor: string | undefined;
  let retrievedAt = new Date().toISOString() as IsoTimestamp;
  for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
    const page = await fetchPage(league, apiKey, cursor);
    rejections.push(...(page.rejections ?? []));
    retrievedAt = page.retrievedAt;
    for (const event of page.events) {
      const existing = events.get(event.providerEventId);
      if (!existing) {
        events.set(event.providerEventId, event);
        continue;
      }
      const sameOrientation =
        existing.awayTeam === event.awayTeam &&
        existing.homeTeam === event.homeTeam;
      const reversedOrientation =
        existing.awayTeam === event.homeTeam &&
        existing.homeTeam === event.awayTeam;
      const startDelta = Math.abs(
        Date.parse(existing.startsAt) - Date.parse(event.startsAt),
      );
      if (
        existing.providerEventUuid !== event.providerEventUuid ||
        (!sameOrientation && !reversedOrientation) ||
        startDelta > 120_000
      ) {
        rejections.push({
          providerId: SHARP_API_PROVIDER_ID,
          reason: "participant-unavailable",
          auditId: "event-orientation",
          providerEventId: event.providerEventId,
        });
        continue;
      }
      const books = new Map(
        existing.bookmakers.map((book) => [book.id, [...book.prices]]),
      );
      for (const book of event.bookmakers) {
        const prices = reversedOrientation
          ? book.prices.map((price) => ({
              ...price,
              selectionKey:
                price.selectionKey === "away"
                  ? ("home" as const)
                  : price.selectionKey === "home"
                    ? ("away" as const)
                    : price.selectionKey,
              ...(price.participantSide
                ? {
                    participantSide:
                      price.participantSide === "away"
                        ? ("home" as const)
                        : ("away" as const),
                  }
                : {}),
            }))
          : book.prices;
        books.set(book.id, [...(books.get(book.id) ?? []), ...prices]);
      }
      events.set(event.providerEventId, {
        ...existing,
        bookmakers: [...books].map(([id, prices]) => ({
          id,
          label: id,
          prices,
        })),
      });
    }
    if (!page.hasMore)
      return { events: [...events.values()], rejections, retrievedAt };
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("sharpapi-pagination-invalid");
    cursor = page.nextCursor;
  }
  throw new Error("sharpapi-pagination-limit");
};

const loadSchedule = async (
  league: SharpApiLeague,
  apiKey: string,
  fetchPage: typeof fetchSharpApiSchedulePage,
) => {
  const events: SharpApiSchedulePage["events"][number][] = [];
  let offset = 0;
  let retrievedAt = new Date().toISOString() as IsoTimestamp;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await fetchPage(league, apiKey, offset);
    retrievedAt = page.retrievedAt;
    events.push(...page.events);
    if (!page.hasMore) return { events, retrievedAt };
    if (page.nextOffset === undefined || page.nextOffset <= offset)
      throw new Error("sharpapi-schedule-pagination-invalid");
    offset = page.nextOffset;
  }
  throw new Error("sharpapi-schedule-pagination-limit");
};

const loadSplits = async (
  league: SharpApiLeague,
  apiKey: string,
  fetchPage: typeof fetchSharpApiSplitsPage,
) => {
  const items: SharpApiSplitPage["items"][number][] = [];
  let offset = 0;
  let retrievedAt = new Date().toISOString() as IsoTimestamp;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await fetchPage(league, apiKey, offset);
    retrievedAt = page.retrievedAt;
    items.push(...page.items);
    if (!page.hasMore) return { items, retrievedAt };
    if (page.nextOffset === undefined || page.nextOffset <= offset)
      throw new Error("sharpapi-splits-pagination-invalid");
    offset = page.nextOffset;
  }
  throw new Error("sharpapi-splits-pagination-limit");
};

const completeMainPrices = (
  prices: readonly SharpApiOddsPage["events"][number]["bookmakers"][number]["prices"][number][],
  leagueKey: SharpApiLeague["leagueKey"],
): { readonly prices: typeof prices; readonly rejected: number } => {
  void leagueKey;
  const groups = new Map<string, typeof prices>();
  let rejected = 0;
  for (const price of prices) {
    if (
      ((price.marketKey === "spread" ||
        price.marketKey === "total" ||
        price.marketKey === "team_total") &&
        price.point === undefined) ||
      (price.marketKey === "team_total" && !price.participantSide)
    ) {
      rejected += 1;
      continue;
    }
    const line =
      price.marketKey === "spread"
        ? Math.abs(price.point ?? NaN)
        : (price.point ?? "none");
    const key = `${price.marketKey}:${price.participantSide ?? "event"}:${line}:${price.outcomeStructure ?? "default"}`;
    groups.set(key, [...(groups.get(key) ?? []), price]);
  }
  const complete: (typeof prices)[number][] = [];
  for (const group of groups.values()) {
    const marketKey = group[0]?.marketKey;
    const expected =
      marketKey === "total"
        ? ["over", "under"]
        : marketKey === "btts"
          ? ["yes", "no"]
          : marketKey === "team_total"
            ? ["over", "under"]
            : marketKey === "moneyline" &&
                group[0]?.outcomeStructure === "three-way"
              ? ["away", "draw", "home"]
              : ["away", "home"];
    const actual = new Set(group.map((price) => price.selectionKey));
    if (
      group.length !== expected.length ||
      actual.size !== group.length ||
      expected.some(
        (selection) =>
          !actual.has(selection as (typeof group)[number]["selectionKey"]),
      )
    ) {
      rejected += 1;
      continue;
    }
    if (marketKey === "spread" && group.length >= 2) {
      const points = group.map((price) => price.point);
      if (
        points.some((point) => point === undefined) ||
        points.reduce<number>((sum, point) => sum + (point ?? 0), 0) !== 0
      ) {
        rejected += 1;
        continue;
      }
    }
    complete.push(...group);
  }
  return { prices: complete, rejected };
};

export async function persistSharpApiOddsPage(
  store: EventIngestionStore,
  odds: SharpApiOddsPersister,
  league: SharpApiLeague,
  page: Pick<SharpApiOddsPage, "events" | "retrievedAt"> &
    Partial<Pick<SharpApiOddsPage, "rejections">>,
  bookRoles?: Readonly<Record<string, "offered" | "comparison" | "splits">>,
  onPersistenceOutcome?: (outcome: {
    readonly snapshot?: "created" | "existing";
    readonly current?: "advanced" | "retained";
    readonly mirrorFailure?: true;
  }) => void,
) {
  const comparableParticipant = (value: string) =>
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const canonicalOddsEvents: {
    readonly raw: SharpApiOddsPage["events"][number];
    readonly canonical: NonNullable<
      Awaited<ReturnType<EventIngestionStore["resolveExactCanonicalBinding"]>>
    >;
  }[] = [];
  let events = 0;
  let observations = 0;
  let snapshotsCreated = 0;
  let snapshotsExisting = 0;
  let currentAdvanced = 0;
  let currentRetained = 0;
  let staleEvidence = 0;
  let partialEvidence = 0;
  const rejectionCounts: Partial<Record<OddsNormalizationReason, number>> = {};
  for (const rejection of page.rejections ?? [])
    rejectionCounts[rejection.reason] =
      (rejectionCounts[rejection.reason] ?? 0) + 1;
  for (const raw of page.events) {
    if (isSharpDerivativeMatchup(raw.awayTeam, raw.homeTeam)) continue;
    const event = providerEvent(league, raw, page.retrievedAt);
    const ingested = await store.ingestEvent({
      ...event,
      providerId: SHARP_API_PROVIDER_ID,
      normalizedIdentity: normalizedUpcomingEventIdentity(event),
      observedAt: page.retrievedAt,
    });
    if (ingested.kind === "unresolved")
      throw new Error(`sharpapi-odds-mapping-${ingested.reason}`);
    const canonical = await store.resolveExactCanonicalBinding({
      providerId: SHARP_API_PROVIDER_ID,
      providerEventId: raw.providerEventId,
      sportKey: league.sportKey,
      leagueKey: league.leagueKey,
    });
    if (!canonical) throw new Error("sharpapi-event-binding-unavailable");
    canonicalOddsEvents.push({ raw, canonical });
    let eventObservations = 0;
    for (const book of raw.bookmakers) {
      const normalizedBook = normalizeSportsbook(book.id);
      if (normalizedBook.kind === "rejected") {
        rejectionCounts[normalizedBook.reason] =
          (rejectionCounts[normalizedBook.reason] ?? 0) + 1;
        continue;
      }
      const sportsbook = normalizedBook.sportsbook;
      const bookRole = bookRoles
        ? bookRoles[sportsbook.id]
        : sportsbook.productionRole;
      if (!bookRole) continue;
      staleEvidence += book.prices.filter(
        (price) =>
          price.isMainLine &&
          !price.isAlternateLine &&
          !price.isPlayerProp &&
          price.isStalePregamePrice,
      ).length;
      const complete = completeMainPrices(
        book.prices.filter(
          (price) =>
            price.isMainLine &&
            !price.isAlternateLine &&
            !price.isPlayerProp &&
            !price.isStalePregamePrice &&
            !price.isSuspended,
        ),
        league.leagueKey,
      );
      if (complete.rejected)
        rejectionCounts["incomplete-market"] =
          (rejectionCounts["incomplete-market"] ?? 0) + complete.rejected;
      // One unit represents one rejected/incomplete market group, not a row.
      partialEvidence += complete.rejected;
      for (const price of complete.prices) {
        const providerParticipantIndex =
          price.marketKey === "team_total"
            ? price.participantSide === "away"
              ? 0
              : price.participantSide === "home"
                ? 1
                : -1
            : price.selectionKey === "away"
              ? 0
              : price.selectionKey === "home"
                ? 1
                : -1;
        let participantIndex = providerParticipantIndex;
        if (providerParticipantIndex >= 0 && canonical.participantLabels) {
          const providerLabel =
            providerParticipantIndex === 0 ? raw.awayTeam : raw.homeTeam;
          participantIndex = canonical.participantLabels.findIndex(
            (label) =>
              comparableParticipant(label) ===
              comparableParticipant(providerLabel),
          );
          if (participantIndex < 0) {
            rejectionCounts["participant-unavailable"] =
              (rejectionCounts["participant-unavailable"] ?? 0) + 1;
            continue;
          }
        }
        const participantId =
          participantIndex >= 0
            ? canonical.participantIds[participantIndex]
            : undefined;
        if (participantIndex >= 0 && !participantId) {
          rejectionCounts["participant-unavailable"] =
            (rejectionCounts["participant-unavailable"] ?? 0) + 1;
          continue;
        }
        const selectionKey = participantId
          ? participantSelectionKey(
              participantId,
              price.marketKey === "team_total"
                ? (price.selectionKey as "over" | "under")
                : undefined,
            )
          : price.selectionKey;
        const canonicalSelectionLabel =
          participantIndex >= 0
            ? canonical.participantLabels?.[participantIndex]
            : undefined;
        let persisted: FixtureOddsPersistResult;
        try {
          persisted = await odds.persist({
            providerId: SHARP_API_PROVIDER_ID,
            providerEventId: raw.providerEventId,
            leagueKey: league.leagueKey,
            expectedStartsAt: canonical.startsAt,
            expectedStatus: "scheduled",
            observation: {
              canonicalEventId: canonical.id,
              canonicalEventVersion: canonical.version,
              sportKey: canonical.sportKey,
              marketKey: price.marketKey,
              selectionKey,
              selectionLabel: canonicalSelectionLabel ?? price.selectionLabel,
              sportsbookId: sportsbook.id,
              sportsbookLabel: sportsbook.name,
              ...(price.point === undefined ? {} : { point: price.point }),
              americanOdds: price.americanOdds,
              observedAt: price.observedAt,
              retrievedAt: page.retrievedAt,
              provenance: {
                providerId: SHARP_API_PROVIDER_ID,
                policyVersion: oddsCollectionPolicyVersion,
                bookRole: bookRole ?? "offered",
                sourceState: "active",
              },
            },
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "exact-snapshot-index-write-failed"
          )
            onPersistenceOutcome?.({ mirrorFailure: true });
          throw error;
        }
        onPersistenceOutcome?.({
          snapshot: persisted.snapshot,
          current: persisted.current,
        });
        if (persisted.snapshot === "created") snapshotsCreated += 1;
        else snapshotsExisting += 1;
        if (persisted.current === "advanced") currentAdvanced += 1;
        else currentRetained += 1;
        observations += 1;
        eventObservations += 1;
      }
    }
    if (eventObservations > 0) events += 1;
  }
  return {
    events,
    observations,
    canonicalOddsEvents,
    rejectionCounts,
    snapshotsCreated,
    snapshotsExisting,
    currentAdvanced,
    currentRetained,
    staleEvidence,
    partialEvidence,
  };
}

export async function persistSharpApiSplitPage(
  store: EventIngestionStore,
  splitRepository: BettingSplitRepository,
  league: SharpApiLeague,
  splitResult: Pick<SharpApiSplitPage, "items" | "retrievedAt">,
  canonicalOddsEvents: Awaited<
    ReturnType<typeof persistSharpApiOddsPage>
  >["canonicalOddsEvents"] = [],
) {
  let splits = 0;
  for (const raw of splitResult.items) {
    const expectedSport = league.leagueKey === "mlb" ? "baseball" : "soccer";
    if (
      raw.league.toLowerCase() !== league.leagueKey ||
      raw.sport.toLowerCase() !== expectedSport
    ) {
      await splitRepository.persistGap({
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: raw.providerEventId,
        sportKey: league.sportKey,
        leagueKey: league.leagueKey,
        reason: "identity-mismatch",
        retrievedAt: splitResult.retrievedAt,
      });
      continue;
    }
    let canonical = await store.resolveExactCanonicalBinding({
      providerId: SHARP_API_PROVIDER_ID,
      providerEventId: raw.providerEventId,
      sportKey: league.sportKey,
      leagueKey: league.leagueKey,
    });
    if (!canonical)
      for (const providerEventId of splitProviderEventAliases(
        raw.providerEventId,
        league.leagueKey,
      )) {
        canonical = await store.resolveExactCanonicalBinding({
          providerId: SHARP_API_PROVIDER_ID,
          providerEventId,
          sportKey: league.sportKey,
          leagueKey: league.leagueKey,
        });
        if (canonical) break;
      }
    if (!canonical) {
      const splitDay = providerEventDay(raw.providerEventId);
      const candidates = canonicalOddsEvents.filter(
        ({ raw: oddsEvent }) =>
          oddsEvent.awayTeam === raw.awayTeam &&
          oddsEvent.homeTeam === raw.homeTeam &&
          splitDay !== undefined &&
          easternDay(oddsEvent.startsAt) === splitDay,
      );
      if (candidates.length === 1) canonical = candidates[0]!.canonical;
    }
    if (!canonical) {
      await splitRepository.persistGap({
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: raw.providerEventId,
        sportKey: league.sportKey,
        leagueKey: league.leagueKey,
        reason: "event-unmapped",
        retrievedAt: splitResult.retrievedAt,
      });
      continue;
    }
    if (
      canonical.participantLabels?.length !== 2 ||
      normalizedParticipant(canonical.participantLabels[0]!) !==
        normalizedParticipant(raw.awayTeam) ||
      normalizedParticipant(canonical.participantLabels[1]!) !==
        normalizedParticipant(raw.homeTeam)
    ) {
      await splitRepository.persistGap({
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: raw.providerEventId,
        sportKey: league.sportKey,
        leagueKey: league.leagueKey,
        reason: "participant-mismatch",
        retrievedAt: splitResult.retrievedAt,
      });
      continue;
    }
    for (const market of raw.markets)
      for (const selection of market.selections) {
        await splitRepository.persist({
          providerId: SHARP_API_PROVIDER_ID,
          providerEventId: raw.providerEventId,
          canonicalEventId: canonical.id,
          canonicalEventVersion: canonical.version,
          sportKey: canonical.sportKey,
          leagueKey: league.leagueKey,
          marketKey: market.marketKey,
          selectionKey: selection.selectionKey,
          ...(selection.point === undefined ? {} : { point: selection.point }),
          ...(selection.betPercent === undefined
            ? {}
            : { betPercent: selection.betPercent }),
          ...(selection.moneyPercent === undefined
            ? {}
            : { moneyPercent: selection.moneyPercent }),
          providerTimestamp: raw.providerTimestamp,
          retrievedAt: splitResult.retrievedAt,
          scope: raw.sportsbookId,
        });
        splits += 1;
      }
  }
  return splits;
}

export async function ingestSharpApi(
  store: EventIngestionStore,
  odds: SharpApiOddsPersister,
  splitRepository: BettingSplitRepository,
  apiKey: string,
  options: {
    readonly fetchAccount?: typeof fetchSharpApiAccount;
    readonly fetchSchedulePage?: typeof fetchSharpApiSchedulePage;
    readonly fetchOddsPage?: typeof fetchSharpApiOddsPage;
    readonly fetchSplitsPage?: typeof fetchSharpApiSplitsPage;
  } = {},
): Promise<SharpApiIngestionSummary> {
  const account = await (options.fetchAccount ?? fetchSharpApiAccount)(apiKey);
  const splitsEntitled = account.features.includes("splits");
  let events = 0;
  let observations = 0;
  let splits = 0;
  for (const league of sharpApiLeagues) {
    const scheduleResult = await loadSchedule(
      league,
      apiKey,
      options.fetchSchedulePage ?? fetchSharpApiSchedulePage,
    );
    for (const raw of scheduleResult.events) {
      const event = providerEvent(
        league,
        {
          ...raw,
          providerEventUuid: raw.providerEventId,
          bookmakers: [],
        },
        scheduleResult.retrievedAt,
      );
      const ingested = await reconcileScheduledProviderEvent(
        store,
        SHARP_API_PROVIDER_ID,
        event,
        scheduleResult.retrievedAt,
      );
      if (ingested.kind === "unresolved")
        throw new Error(`sharpapi-schedule-mapping-${ingested.reason}`);
    }
    const oddsResult = await loadOdds(
      league,
      apiKey,
      options.fetchOddsPage ?? fetchSharpApiOddsPage,
    );
    const persisted = await persistSharpApiOddsPage(
      store,
      odds,
      league,
      oddsResult,
    );
    const { canonicalOddsEvents } = persisted;
    events += persisted.events;
    observations += persisted.observations;
    if (!splitsEntitled) continue;
    const splitResult = await loadSplits(
      league,
      apiKey,
      options.fetchSplitsPage ?? fetchSharpApiSplitsPage,
    );
    splits += await persistSharpApiSplitPage(
      store,
      splitRepository,
      league,
      splitResult,
      canonicalOddsEvents,
    );
  }
  return {
    account,
    leagues: sharpApiLeagues.length,
    events,
    observations,
    splits,
    splitsEntitled,
    skippedLeagues: 0,
  };
}
