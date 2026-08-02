import type {
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
} from "@find-the-edge/database";
import type {
  FixtureOddsObservation,
  IsoTimestamp,
} from "@find-the-edge/domain";
import {
  THE_ODDS_API_PROVIDER_ID,
  fetchTheOddsApi,
  fetchTheOddsApiEvents,
  fixtureBootstrap,
  normalizedUpcomingEventIdentity,
  theOddsApiLeagues,
  type TheOddsApiLeague,
  type TheOddsApiResult,
} from "@find-the-edge/providers";

export interface LiveOddsPersister {
  persist(input: FixtureOddsIngestInput): Promise<FixtureOddsPersistResult>;
}
export interface LiveOddsState {
  readonly lastOddsRefreshAt?: string;
  readonly lastOddsAttemptAt?: string;
  readonly lastDiscoveryAt?: string;
  readonly upcomingStartsAt?: readonly string[];
  readonly quotaRemaining?: number;
}
export interface LiveOddsStateStore {
  read(leagueKey: string): Promise<LiveOddsState | null>;
  write(leagueKey: string, value: LiveOddsState): Promise<void>;
}
export interface LiveOddsSummary {
  readonly leagues: number;
  readonly events: number;
  readonly observations: number;
  readonly skippedLeagues: number;
  readonly quotaRemaining?: number;
}

export const LIVE_ODDS_MONTHLY_RESERVE = 50;
const sameUtcMonth = (left: string | undefined, right: Date): boolean => {
  if (!left) return false;
  const parsed = new Date(left);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === right.getUTCFullYear() &&
    parsed.getUTCMonth() === right.getUTCMonth()
  );
};
const effectiveQuota = (state: LiveOddsState | null, now: Date) =>
  sameUtcMonth(state?.lastOddsRefreshAt, now)
    ? state?.quotaRemaining
    : undefined;
export function liveOddsRefreshIntervalMinutes(
  leagueKey: string,
  minutesToNextStart: number,
): number {
  if (leagueKey === "mlb")
    return minutesToNextStart >= 0 && minutesToNextStart <= 90 ? 15 : 60;
  if (leagueKey === "mls")
    return minutesToNextStart >= 0 && minutesToNextStart <= 90 ? 30 : 60;
  return 360;
}
export function liveOddsRefreshDue(input: {
  readonly now: Date;
  readonly leagueKey: string;
  readonly startsAt: readonly string[];
  readonly state: LiveOddsState | null;
}): boolean {
  if (
    (effectiveQuota(input.state, input.now) ?? LIVE_ODDS_MONTHLY_RESERVE + 1) <=
    LIVE_ODDS_MONTHLY_RESERVE
  )
    return false;
  if (
    input.state?.lastOddsAttemptAt &&
    input.now.getTime() - Date.parse(input.state.lastOddsAttemptAt) <
      10 * 60_000
  )
    return false;
  if (!input.state?.lastOddsRefreshAt) return true;
  const upcoming = input.startsAt
    .map(Date.parse)
    .filter((value) => Number.isFinite(value) && value >= input.now.getTime());
  const minutes = upcoming.length
    ? (Math.min(...upcoming) - input.now.getTime()) / 60000
    : Number.POSITIVE_INFINITY;
  return (
    input.now.getTime() - Date.parse(input.state.lastOddsRefreshAt) >=
    liveOddsRefreshIntervalMinutes(input.leagueKey, minutes) * 60000
  );
}

const providerEvent = (
  league: TheOddsApiLeague,
  event: TheOddsApiResult["events"][number],
  updatedAt: IsoTimestamp,
) => ({
  providerEventId: event.providerEventId,
  sportKey: league.sportKey,
  leagueKey: league.leagueKey,
  participantLabels: [event.awayTeam, event.homeTeam] as [string, string],
  startsAt: event.startsAt,
  status: "scheduled" as const,
  revision: {
    providerId: THE_ODDS_API_PROVIDER_ID,
    authorityRank: 50,
    updatedAt,
    sequence: 0,
    token: updatedAt,
  },
});

export async function ingestLiveOdds(
  store: EventIngestionStore,
  odds: LiveOddsPersister,
  stateStore: LiveOddsStateStore,
  apiKey: string,
  options: {
    readonly now?: Date;
    readonly leagues?: readonly TheOddsApiLeague[];
    readonly discoverLeague?: typeof fetchTheOddsApiEvents;
    readonly fetchLeague?: typeof fetchTheOddsApi;
  } = {},
): Promise<LiveOddsSummary> {
  const now = options.now ?? new Date();
  const observedAt = now.toISOString() as IsoTimestamp;
  let events = 0,
    observations = 0,
    skippedLeagues = 0,
    quotaRemaining: number | undefined;
  for (const league of options.leagues ?? theOddsApiLeagues) {
    const previous = await stateStore.read(league.leagueKey);
    const discoveryDue =
      !previous?.lastDiscoveryAt ||
      now.getTime() - Date.parse(previous.lastDiscoveryAt) >= 60 * 60_000;
    const discovery = discoveryDue
      ? await (options.discoverLeague ?? fetchTheOddsApiEvents)(league, apiKey)
      : null;
    const discoveredStarts =
      discovery?.events.map(({ startsAt }) => startsAt) ??
      previous?.upcomingStartsAt ??
      [];
    const remaining =
      quotaRemaining ??
      discovery?.quota.remaining ??
      effectiveQuota(previous, now);
    const due = liveOddsRefreshDue({
      now,
      leagueKey: league.leagueKey,
      startsAt: discoveredStarts,
      state:
        remaining === undefined
          ? previous
          : { ...previous, quotaRemaining: remaining },
    });
    const paidDue =
      due && remaining !== undefined && remaining > LIVE_ODDS_MONTHLY_RESERVE;
    if (paidDue) {
      // Reserve one request before the network call. Together with Lambda's
      // single concurrency this makes retries fail closed against the quota.
      await stateStore.write(league.leagueKey, {
        ...previous,
        lastOddsAttemptAt: observedAt,
        quotaRemaining: remaining - 1,
        ...(discoveryDue ? { lastDiscoveryAt: observedAt } : {}),
        upcomingStartsAt: discoveredStarts,
      });
    }
    const response = paidDue
      ? await (options.fetchLeague ?? fetchTheOddsApi)(league, apiKey)
      : null;
    const scheduleEvents = new Map(
      [...(discovery?.events ?? []), ...(response?.events ?? [])].map(
        (event) => [event.providerEventId, event],
      ),
    );
    // Canonical schedule and mappings are always durable before any price observation.
    for (const raw of scheduleEvents.values()) {
      const event = providerEvent(
        league,
        raw,
        discovery?.retrievedAt ?? response?.retrievedAt ?? observedAt,
      );
      await store.bootstrapCanonicalEvent(
        fixtureBootstrap(event, raw.providerEventId),
        observedAt,
      );
      const ingested = await store.ingestEvent({
        ...event,
        providerId: THE_ODDS_API_PROVIDER_ID,
        normalizedIdentity: normalizedUpcomingEventIdentity(event),
        observedAt,
      });
      if (ingested.kind === "unresolved")
        throw new Error("live-event-mapping-unresolved");
    }
    if (!paidDue || !response) {
      skippedLeagues += 1;
      if (discoveryDue)
        await stateStore.write(league.leagueKey, {
          ...previous,
          lastDiscoveryAt: observedAt,
          upcomingStartsAt: discoveredStarts,
          ...(remaining === undefined ? {} : { quotaRemaining: remaining }),
        });
      events += scheduleEvents.size;
      continue;
    }
    for (const raw of response.events) {
      const canonical = await store.resolveExactCanonicalBinding({
        providerId: THE_ODDS_API_PROVIDER_ID,
        providerEventId: raw.providerEventId,
        sportKey: league.sportKey,
        leagueKey: league.leagueKey,
      });
      if (!canonical) throw new Error("live-event-binding-unavailable");
      for (const book of raw.bookmakers)
        for (const price of book.prices) {
          const observation: FixtureOddsObservation = {
            canonicalEventId: canonical.id,
            canonicalEventVersion: canonical.version,
            sportKey: canonical.sportKey,
            marketKey: league.marketKey,
            selectionKey: price.selectionKey,
            selectionLabel: price.selectionLabel,
            sportsbookId: book.id,
            sportsbookLabel: book.label,
            americanOdds: price.americanOdds,
            observedAt: book.updatedAt,
            retrievedAt: response.retrievedAt,
          };
          await odds.persist({
            providerId: THE_ODDS_API_PROVIDER_ID,
            providerEventId: raw.providerEventId,
            leagueKey: league.leagueKey,
            observation,
          });
          observations += 1;
        }
    }
    events += scheduleEvents.size;
    quotaRemaining = response.quota.remaining ?? quotaRemaining;
    await stateStore.write(league.leagueKey, {
      lastOddsRefreshAt: observedAt,
      lastOddsAttemptAt: observedAt,
      ...(discoveryDue ? { lastDiscoveryAt: observedAt } : {}),
      upcomingStartsAt: discoveredStarts,
      ...(response.quota.remaining === undefined
        ? {}
        : { quotaRemaining: response.quota.remaining }),
    });
  }
  return {
    leagues: (options.leagues ?? theOddsApiLeagues).length,
    events,
    observations,
    skippedLeagues,
    ...(quotaRemaining === undefined ? {} : { quotaRemaining }),
  };
}
