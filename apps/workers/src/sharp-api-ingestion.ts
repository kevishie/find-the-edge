import type {
  BettingSplitRepository,
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
} from "@find-the-edge/database";
import type {
  FixtureOddsObservation,
  IsoTimestamp,
} from "@find-the-edge/domain";
import {
  SHARP_API_PROVIDER_ID,
  fetchSharpApiAccount,
  fetchSharpApiOddsPage,
  fetchSharpApiSplitsPage,
  fixtureBootstrap,
  normalizedUpcomingEventIdentity,
  sharpApiLeagues,
  type SharpApiAccount,
  type SharpApiLeague,
  type SharpApiOddsPage,
  type SharpApiSplitPage,
} from "@find-the-edge/providers";

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

const loadOdds = async (
  league: SharpApiLeague,
  apiKey: string,
  fetchPage: typeof fetchSharpApiOddsPage,
) => {
  const events = new Map<string, SharpApiOddsPage["events"][number]>();
  let cursor: string | undefined;
  let retrievedAt = new Date().toISOString() as IsoTimestamp;
  for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
    const page = await fetchPage(league, apiKey, cursor);
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
        reversedOrientation ||
        startDelta > 120_000
      )
        continue;
      const books = new Map(
        existing.bookmakers.map((book) => [book.id, [...book.prices]]),
      );
      for (const book of event.bookmakers)
        books.set(book.id, [...(books.get(book.id) ?? []), ...book.prices]);
      events.set(event.providerEventId, {
        ...existing,
        bookmakers: [...books].map(([id, prices]) => ({
          id,
          label: id,
          prices,
        })),
      });
    }
    if (!page.hasMore) return { events: [...events.values()], retrievedAt };
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("sharpapi-pagination-invalid");
    cursor = page.nextCursor;
  }
  throw new Error("sharpapi-pagination-limit");
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
) => {
  const groups = new Map<string, typeof prices>();
  for (const price of prices) {
    const line =
      price.marketKey === "spread"
        ? Math.abs(price.point ?? NaN)
        : (price.point ?? "none");
    const key = `${price.marketKey}:${line}`;
    groups.set(key, [...(groups.get(key) ?? []), price]);
  }
  const complete: (typeof prices)[number][] = [];
  for (const group of groups.values()) {
    const marketKey = group[0]?.marketKey;
    const expected =
      marketKey === "total"
        ? ["over", "under"]
        : marketKey === "three_way_moneyline"
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
    )
      throw new Error("sharpapi-main-market-incomplete");
    if (marketKey === "spread" && group.length >= 2) {
      const points = group.map((price) => price.point);
      if (
        points.some((point) => point === undefined) ||
        points.reduce<number>((sum, point) => sum + (point ?? 0), 0) !== 0
      )
        throw new Error("sharpapi-main-market-incomplete");
    }
    complete.push(...group);
  }
  return complete;
};

export async function ingestSharpApi(
  store: EventIngestionStore,
  odds: SharpApiOddsPersister,
  splitRepository: BettingSplitRepository,
  apiKey: string,
  options: {
    readonly fetchAccount?: typeof fetchSharpApiAccount;
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
    const oddsResult = await loadOdds(
      league,
      apiKey,
      options.fetchOddsPage ?? fetchSharpApiOddsPage,
    );
    for (const raw of oddsResult.events) {
      const event = providerEvent(league, raw, oddsResult.retrievedAt);
      const command = {
        ...event,
        providerId: SHARP_API_PROVIDER_ID,
        normalizedIdentity: normalizedUpcomingEventIdentity(event),
        observedAt: oddsResult.retrievedAt,
      };
      let ingested = await store.ingestEvent(command);
      if (
        ingested.kind === "unresolved" &&
        ingested.reason === "no-candidate"
      ) {
        await store.bootstrapCanonicalEvent(
          fixtureBootstrap(event, raw.providerEventId),
          oddsResult.retrievedAt,
        );
        ingested = await store.ingestEvent(command);
      }
      if (ingested.kind === "unresolved")
        throw new Error(`sharpapi-event-mapping-${ingested.reason}`);
      const canonical = await store.resolveExactCanonicalBinding({
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: raw.providerEventId,
        sportKey: league.sportKey,
        leagueKey: league.leagueKey,
      });
      if (!canonical) throw new Error("sharpapi-event-binding-unavailable");
      let eventObservations = 0;
      for (const book of raw.bookmakers) {
        const main = completeMainPrices(
          book.prices.filter(
            (price) =>
              price.isMainLine &&
              !price.isAlternateLine &&
              !price.isPlayerProp &&
              !price.isStalePregamePrice,
          ),
        );
        for (const price of main) {
          const observation: FixtureOddsObservation = {
            canonicalEventId: canonical.id,
            canonicalEventVersion: canonical.version,
            sportKey: canonical.sportKey,
            marketKey: price.marketKey,
            selectionKey: price.selectionKey,
            selectionLabel: price.selectionLabel,
            sportsbookId: book.id,
            sportsbookLabel: book.label,
            ...(price.point === undefined ? {} : { point: price.point }),
            americanOdds: price.americanOdds,
            observedAt: price.observedAt,
            retrievedAt: oddsResult.retrievedAt,
          };
          await odds.persist({
            providerId: SHARP_API_PROVIDER_ID,
            providerEventId: raw.providerEventId,
            leagueKey: league.leagueKey,
            observation,
          });
          observations += 1;
          eventObservations += 1;
        }
      }
      if (eventObservations === 0) continue;
      events += 1;
    }
    if (!splitsEntitled) continue;
    const splitResult = await loadSplits(
      league,
      apiKey,
      options.fetchSplitsPage ?? fetchSharpApiSplitsPage,
    );
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
      const canonical = await store.resolveExactCanonicalBinding({
        providerId: SHARP_API_PROVIDER_ID,
        providerEventId: raw.providerEventId,
        sportKey: league.sportKey,
        leagueKey: league.leagueKey,
      });
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
        canonical.participantLabels?.[0] !== raw.awayTeam ||
        canonical.participantLabels?.[1] !== raw.homeTeam
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
            ...(selection.point === undefined
              ? {}
              : { point: selection.point }),
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
