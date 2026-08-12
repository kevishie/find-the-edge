import type {
  BettingSplitRepository,
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
} from "@find-the-edge/database";
import { FixtureOddsBindingConflictError } from "@find-the-edge/database";
import type {
  CanonicalEvent,
  FixtureOddsAvailabilityEvidence,
  IsoTimestamp,
  OddsNormalizationReason,
} from "@find-the-edge/domain";
import {
  FixtureOddsStateCorruptionError,
  fixtureOddsGroupAvailabilityIdentity,
  fixtureOddsPartition,
  participantSelectionKey,
  sha256Hex,
} from "@find-the-edge/domain";
import {
  normalizeSportsbook,
  oddsCollectionPolicyVersion,
  productionOddsCollectionPolicies,
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
  persistAvailability?(
    value: FixtureOddsAvailabilityEvidence,
  ): Promise<unknown>;
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

/**
 * How far the provider's odds-side start time may sit from the authoritative
 * schedule before the listing stops describing a game we can price. Wide
 * enough to absorb a provider rounding a start to the quarter hour; far
 * narrower than a postponement.
 */
export const ODDS_START_DRIFT_TOLERANCE_MS = 15 * 60_000;

const providerEvent = (
  league: SharpApiLeague,
  event: SharpApiOddsPage["events"][number],
  updatedAt: IsoTimestamp,
) => ({
  providerEventId: event.providerEventId,
  sportKey: league.sportKey,
  leagueKey: league.leagueKey,
  participantLabels: [event.awayTeam, event.homeTeam] as [string, string],
  ...(event.awayClubKey && event.homeClubKey
    ? {
        participantIdentityKeys: [event.awayClubKey, event.homeClubKey] as [
          string,
          string,
        ],
      }
    : {}),
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

// The split feed can abbreviate a club the schedule feed spells out, for
// example "Athletics" against "Oakland Athletics". Accept a label whose words
// are all present in the canonical label and whose nickname — the final word,
// which is what distinguishes clubs sharing a city — is identical. Both
// participants must match, and an ambiguous matchup still fails closed on the
// unique-candidate requirement.
const participantLabelMatches = (
  canonicalLabel: string,
  providedLabel: string,
) => {
  const canonicalWords = normalizedParticipant(canonicalLabel).split(" ");
  const providedWords = normalizedParticipant(providedLabel).split(" ");
  if (providedWords.length === 0 || providedWords[0] === "") return false;
  if (canonicalWords.join(" ") === providedWords.join(" ")) return true;
  return (
    canonicalWords.at(-1) === providedWords.at(-1) &&
    providedWords.every((word) => canonicalWords.includes(word))
  );
};

const splitParticipantsMatchCanonical = (
  canonical: CanonicalEvent,
  awayTeam: string,
  homeTeam: string,
) =>
  canonical.participantLabels?.length === 2 &&
  participantLabelMatches(canonical.participantLabels[0]!, awayTeam) &&
  participantLabelMatches(canonical.participantLabels[1]!, homeTeam);

const splitIdentityMatchesCanonical = (
  canonical: CanonicalEvent,
  providerEventId: string,
  awayTeam: string,
  homeTeam: string,
  leagueKey: SharpApiLeague["leagueKey"],
) => {
  if (!splitParticipantsMatchCanonical(canonical, awayTeam, homeTeam))
    return false;
  if (leagueKey !== "mlb") return true;
  const splitDay = providerEventDay(providerEventId);
  // Both provider feeds date an event id by its Eastern day, so this stays an
  // exact comparison. Accepting the UTC day as well would make a split in a
  // multi-game series match both that day's game and the previous day's late
  // game, and the ambiguity would drop evidence that resolves correctly today.
  return splitDay !== undefined && easternDay(canonical.startsAt) === splitDay;
};

const uniqueCanonicalSplitCandidate = (
  candidates: readonly CanonicalEvent[],
) => {
  const distinct = new Map<string, CanonicalEvent>();
  for (const canonical of candidates) {
    const current = distinct.get(canonical.id);
    if (!current || canonical.version > current.version)
      distinct.set(canonical.id, canonical);
  }
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
};

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
  page: Pick<SharpApiOddsPage, "events" | "retrievedAt" | "eventRetrievedAt"> &
    Partial<Pick<SharpApiOddsPage, "rejections">>,
  bookRoles?: Readonly<
    Record<string, "offered" | "comparison" | "collected" | "splits">
  >,
  onPersistenceOutcome?: (outcome: {
    readonly snapshot?: "created" | "existing";
    readonly current?: "advanced" | "retained";
    readonly mirrorFailure?: true;
  }) => void,
  expectedBookMarkets?: Readonly<Record<string, readonly string[]>>,
  acceptedProviderEventIds?: ReadonlySet<string>,
  /**
   * Set when this page came from a secondary catalogue (Leagues Cup). Its
   * rows may only ALIAS onto a canonical event this league already has —
   * never bootstrap one — because the two catalogues describe the same
   * fixtures under different provider ids and different uuids, and minting
   * from the secondary would put every game on the board twice.
   */
  secondaryProviderLeague?: string,
  /** Canonical events already resolved in this run, matched by participants. */
  resolvedThisRun?: readonly {
    readonly canonical: CanonicalEvent;
  }[],
  onSecondaryGap?: (reason: "no-candidate" | "ambiguous") => void,
) {
  const comparableParticipant = (value: string) =>
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/ø/g, "o")
      .replace(/ł/g, "l")
      .replace(/[đð]/g, "d")
      .replace(/þ/g, "th")
      .replace(/æ/g, "ae")
      .replace(/œ/g, "oe")
      .replace(/[^a-z0-9]/g, "");
  const comparableParticipantTokens = (value: string) => {
    const genericClubTokens = new Set([
      "afc",
      "cf",
      "city",
      "club",
      "fc",
      "fk",
      "gnk",
      "pfc",
      "sc",
      "sk",
      "united",
    ]);
    return (
      value
        .normalize("NFKD")
        .toLowerCase()
        .replace(/ø/g, "o")
        .replace(/ł/g, "l")
        .replace(/[đð]/g, "d")
        .replace(/þ/g, "th")
        .replace(/æ/g, "ae")
        .replace(/œ/g, "oe")
        .replace(/[\u0300-\u036f]/g, "")
        .match(/[a-z0-9]+/g)
        ?.filter((token) => !genericClubTokens.has(token)) ?? []
    );
  };
  const credibleParticipantAlias = (left: string, right: string) => {
    const comparableLeft = comparableParticipant(left);
    const comparableRight = comparableParticipant(right);
    const leftTokens = comparableParticipantTokens(left);
    const rightTokens = comparableParticipantTokens(right);
    const sameTokenSet =
      leftTokens.length > 0 &&
      rightTokens.length > 0 &&
      [...new Set(leftTokens)].sort().join(":") ===
        [...new Set(rightTokens)].sort().join(":");
    const sharesDistinctiveToken = leftTokens.some(
      (leftToken) => leftToken.length >= 4 && rightTokens.includes(leftToken),
    );
    return (
      comparableLeft === comparableRight ||
      (Math.min(comparableLeft.length, comparableRight.length) >= 4 &&
        (comparableLeft.includes(comparableRight) ||
          comparableRight.includes(comparableLeft))) ||
      sameTokenSet ||
      sharesDistinctiveToken
    );
  };
  const participantIndexes = (
    raw: SharpApiOddsPage["events"][number],
    canonical: CanonicalEvent,
    requireCompleteMatch = false,
  ) => {
    if (canonical.participantLabels?.length !== 2)
      throw new Error("sharpapi-odds-mapping-participant-mismatch");
    const rawLabels = [raw.awayTeam, raw.homeTeam] as const;
    const candidates = rawLabels.map((rawLabel) =>
      canonical.participantLabels!.flatMap((canonicalLabel, index) =>
        credibleParticipantAlias(rawLabel, canonicalLabel) ? [index] : [],
      ),
    );
    const away = candidates[0]!;
    const home = candidates[1]!;
    // Schedule and odds endpoints can use different aliases for the same
    // exact provider event. One unique participant match safely determines
    // the other side; ambiguous or unrelated pairs fail closed.
    if (away.length === 1 && home.length === 1 && away[0] !== home[0])
      return [away[0]!, home[0]!] as const;
    if (requireCompleteMatch)
      throw new Error("sharpapi-odds-mapping-participant-mismatch");
    if (away.length === 1 && home.length === 0)
      return [away[0]!, 1 - away[0]!] as const;
    if (away.length === 0 && home.length === 1)
      return [1 - home[0]!, home[0]!] as const;
    throw new Error("sharpapi-odds-mapping-participant-mismatch");
  };
  const canonicalOddsEvents: {
    readonly raw: SharpApiOddsPage["events"][number];
    readonly canonical: NonNullable<
      Awaited<ReturnType<EventIngestionStore["resolveExactCanonicalBinding"]>>
    >;
  }[] = [];
  let events = 0;
  let observations = 0;
  const observationsBySportsbook: Record<string, number> = {};
  let snapshotsCreated = 0;
  let snapshotsExisting = 0;
  let currentAdvanced = 0;
  let currentRetained = 0;
  let staleEvidence = 0;
  let partialEvidence = 0;
  let suspendedEvidence = 0;
  const rejectionCounts: Partial<Record<OddsNormalizationReason, number>> = {};
  for (const rejection of page.rejections ?? [])
    rejectionCounts[rejection.reason] =
      (rejectionCounts[rejection.reason] ?? 0) + 1;
  for (const raw of page.events) {
    if (isSharpDerivativeMatchup(raw.awayTeam, raw.homeTeam)) continue;
    // Sharp can expose thin sportsbook derivatives on both its schedule and
    // odds endpoints. When a completed schedule scan is available, MLB odds
    // may only create/persist an event whose exact source ID survived that
    // schedule classifier.
    if (
      league.leagueKey === "mlb" &&
      acceptedProviderEventIds &&
      !acceptedProviderEventIds.has(raw.providerEventId)
    )
      continue;
    const eventRetrievedAt =
      page.eventRetrievedAt?.[raw.providerEventId] ?? page.retrievedAt;
    const event = providerEvent(league, raw, eventRetrievedAt);
    const binding = {
      providerId: SHARP_API_PROVIDER_ID,
      providerEventId: raw.providerEventId,
      sportKey: league.sportKey,
      leagueKey: league.leagueKey,
    } as const;
    const exactMapping = await store.getExactMapping(binding);
    let canonical = exactMapping
      ? await store.resolveExactCanonicalBinding(binding)
      : null;
    // Both catalogues now arrive in ONE response, so the catalogue is a
    // property of the ROW, not of the page. A row whose provider id belongs to
    // a secondary catalogue may only alias; letting it take the normal path
    // would bootstrap a second canonical event per fixture.
    const rowSecondary =
      (league.secondaryOddsProviderLeagues ?? []).find((candidate) =>
        raw.providerEventId
          .toLowerCase()
          .startsWith(`${candidate.toLowerCase()}_`),
      ) ?? secondaryProviderLeague;
    if (!canonical && rowSecondary !== undefined) {
      // Resolve-or-skip. The only identity shared with the primary catalogue
      // is the participant pair, so match on that — the same nickname-anchored
      // comparison split attribution uses — and bind an ALIAS. Failing to
      // match drops the row; it never creates an event.
      const matches = (resolvedThisRun ?? [])
        .map(({ canonical: candidate }) => candidate)
        .filter(
          (candidate) =>
            // Either orientation. The two catalogues are separate renderings
            // of the same fixture and nothing guarantees they agree on which
            // club is home — and a silent drop here is precisely the failure
            // that leaves a board priceless with no error anywhere.
            splitParticipantsMatchCanonical(
              candidate,
              raw.awayTeam,
              raw.homeTeam,
            ) ||
            splitParticipantsMatchCanonical(
              candidate,
              raw.homeTeam,
              raw.awayTeam,
            ),
        );
      const unique = uniqueCanonicalSplitCandidate(matches);
      if (!unique) {
        onSecondaryGap?.(matches.length === 0 ? "no-candidate" : "ambiguous");
        continue;
      }
      const aliased = await store.ingestEvent({
        ...event,
        providerId: SHARP_API_PROVIDER_ID,
        startsAt: unique.startsAt,
        status: unique.status,
        ...(unique.participantLabels === undefined
          ? {}
          : { participantLabels: unique.participantLabels }),
        normalizedIdentity: unique.candidateIdentity,
        mappingKind: "alias",
        observedAt: eventRetrievedAt,
      });
      if (aliased.kind === "unresolved") {
        onSecondaryGap?.("no-candidate");
        continue;
      }
      canonical = await store.resolveExactCanonicalBinding(binding);
      if (!canonical) {
        onSecondaryGap?.("no-candidate");
        continue;
      }
    }
    if (!canonical) {
      let ingested = await store.ingestEvent({
        ...event,
        providerId: SHARP_API_PROVIDER_ID,
        normalizedIdentity: normalizedUpcomingEventIdentity(event),
        observedAt: eventRetrievedAt,
      });
      // Featured odds may legitimately expose an entitled event before it has
      // appeared on the paginated schedule scan. Bootstrap only the exact
      // no-candidate case through the same fenced reconciliation boundary used
      // by schedule ingestion. Ambiguous candidates remain quarantined.
      if (ingested.kind === "unresolved" && ingested.reason === "no-candidate")
        ingested = await reconcileScheduledProviderEvent(
          store,
          SHARP_API_PROVIDER_ID,
          event,
          eventRetrievedAt,
        );
      if (ingested.kind === "unresolved")
        throw new Error(`sharpapi-odds-mapping-${ingested.reason}`);
      canonical = await store.resolveExactCanonicalBinding(binding);
    }
    if (!canonical) throw new Error("sharpapi-event-binding-unavailable");
    const canonicalStartsAt = Date.parse(canonical.startsAt);
    const pageRetrievedAt = Date.parse(eventRetrievedAt);
    if (
      !Number.isFinite(canonicalStartsAt) ||
      !Number.isFinite(pageRetrievedAt)
    )
      throw new Error("sharpapi-odds-mapping-start-mismatch");
    // SharpAPI's featured endpoint can retain a completed game's final
    // pregame board after first pitch/kickoff. The immutable odds adapter is
    // intentionally fenced to scheduled pregame evidence, so omit the whole
    // event once this page was retrieved at or after the authoritative start.
    // A later live-state provider may persist those prices under a live model.
    if (pageRetrievedAt >= canonicalStartsAt) continue;
    const priceRetrievedBeforeStart = (
      price: SharpApiOddsPage["events"][number]["bookmakers"][number]["prices"][number],
    ) => Date.parse(price.retrievedAt ?? eventRetrievedAt) < canonicalStartsAt;
    const startDrift = Math.abs(
      Date.parse(raw.startsAt) - Date.parse(canonical.startsAt),
    );
    // SharpAPI's events endpoint remains authoritative for displayed game
    // time. Its odds endpoint can lag after a delay or postponement, so an
    // exact source event ID plus both matching teams may still contribute
    // prices without rewriting the canonical schedule. An unparseable start
    // proves nothing and is never trusted through.
    const trustedThroughDrift =
      Number.isFinite(startDrift) && exactMapping?.bindingKind === "source";
    // A listing whose start disagrees past the tolerance describes a game we
    // cannot price confidently. That is ONE row's problem, so it is omitted
    // and counted — it must never abort the league's run. Throwing here left
    // MLS replaying the same wedged run for seven hours on 2026-08-12 while
    // its board sat empty: the failure kept the continuation, and the run had
    // committed evidence, which exempts it from the staleness ceiling that
    // would otherwise have abandoned it. One unpriceable fixture is not a
    // reason to stop pricing a league.
    if (
      (!Number.isFinite(startDrift) ||
        startDrift > ODDS_START_DRIFT_TOLERANCE_MS) &&
      !trustedThroughDrift
    ) {
      rejectionCounts["start-time-conflict"] =
        (rejectionCounts["start-time-conflict"] ?? 0) + 1;
      continue;
    }
    canonicalOddsEvents.push({ raw, canonical });
    const providerParticipantIndexes = participantIndexes(
      raw,
      canonical,
      trustedThroughDrift && startDrift > ODDS_START_DRIFT_TOLERANCE_MS,
    );
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
      if (odds.persistAvailability)
        for (const price of book.prices) {
          const state =
            price.isSuspended === true
              ? "suspended"
              : price.isActive === false
                ? "closed"
                : undefined;
          if (
            !state ||
            Date.parse(price.observedAt) >= canonicalStartsAt ||
            !priceRetrievedBeforeStart(price)
          )
            continue;
          if (state === "suspended") suspendedEvidence += 1;
          const providerParticipantIndex =
            price.selectionKey === "away"
              ? 0
              : price.selectionKey === "home"
                ? 1
                : price.participantSide === "away"
                  ? 0
                  : price.participantSide === "home"
                    ? 1
                    : -1;
          let participantIndex = providerParticipantIndex;
          if (providerParticipantIndex >= 0)
            participantIndex =
              providerParticipantIndex === 0
                ? providerParticipantIndexes[0]
                : providerParticipantIndexes[1];
          const participantId =
            participantIndex >= 0
              ? canonical.participantIds[participantIndex]
              : undefined;
          if (participantIndex >= 0 && !participantId) continue;
          const selectionKey = participantId
            ? participantSelectionKey(
                participantId,
                price.marketKey === "team_total"
                  ? (price.selectionKey as "over" | "under")
                  : undefined,
              )
            : price.selectionKey;
          const identity = fixtureOddsPartition({
            canonicalEventId: canonical.id,
            canonicalEventVersion: canonical.version,
            sportKey: canonical.sportKey,
            marketKey: price.marketKey,
            selectionKey,
            sportsbookId: sportsbook.id,
          }).key;
          await odds.persistAvailability({
            identity,
            state,
            observedAt: price.observedAt,
            evidenceId: sha256Hex(
              JSON.stringify([
                SHARP_API_PROVIDER_ID,
                raw.providerEventId,
                identity,
                state,
                price.providerPriceId,
              ]),
            ),
            reason: state,
          });
        }
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
            Date.parse(price.observedAt) < canonicalStartsAt &&
            priceRetrievedBeforeStart(price) &&
            !price.isSuspended,
        ),
        league.leagueKey,
      );
      if (complete.rejected)
        rejectionCounts["incomplete-market"] =
          (rejectionCounts["incomplete-market"] ?? 0) + complete.rejected;
      if (complete.rejected && odds.persistAvailability)
        for (const marketKey of [
          ...new Set(
            book.prices
              .filter(
                (price) =>
                  price.isMainLine &&
                  !price.isAlternateLine &&
                  !price.isPlayerProp,
              )
              .map(({ marketKey }) => marketKey),
          ),
        ].filter(
          (candidate) =>
            completeMainPrices(
              book.prices.filter(
                (price) =>
                  price.marketKey === candidate &&
                  price.isMainLine &&
                  !price.isAlternateLine &&
                  !price.isPlayerProp &&
                  !price.isStalePregamePrice &&
                  Date.parse(price.observedAt) < canonicalStartsAt &&
                  priceRetrievedBeforeStart(price) &&
                  !price.isSuspended,
              ),
              league.leagueKey,
            ).rejected > 0,
        )) {
          const identity = fixtureOddsGroupAvailabilityIdentity({
            canonicalEventId: canonical.id,
            canonicalEventVersion: canonical.version,
            sportKey: canonical.sportKey,
            marketKey,
            sportsbookId: sportsbook.id,
          });
          await odds.persistAvailability({
            identity,
            state: "incomplete",
            observedAt: eventRetrievedAt,
            evidenceId: sha256Hex(
              JSON.stringify([
                SHARP_API_PROVIDER_ID,
                raw.providerEventId,
                identity,
                "incomplete",
              ]),
            ),
            reason: "incomplete-market",
          });
        }
      // One unit represents one rejected/incomplete market group, not a row.
      partialEvidence += complete.rejected;
      const expectedByMarket = new Map<string, number>();
      const persistedByMarket = new Map<string, number>();
      for (const price of complete.prices)
        expectedByMarket.set(
          price.marketKey,
          (expectedByMarket.get(price.marketKey) ?? 0) + 1,
        );
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
        if (providerParticipantIndex >= 0)
          participantIndex =
            providerParticipantIndex === 0
              ? providerParticipantIndexes[0]
              : providerParticipantIndexes[1];
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
              retrievedAt: price.retrievedAt ?? eventRetrievedAt,
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
          // A source event can cross its pregame fence, be rescheduled, or be
          // rebound while a large provider page is being committed. Quarantine
          // that observation without discarding valid sibling games from the
          // same page. The immutable adapter remains the authority: no
          // conflicted snapshot is written.
          if (
            error instanceof FixtureOddsBindingConflictError ||
            error instanceof FixtureOddsStateCorruptionError
          ) {
            rejectionCounts["participant-unavailable"] =
              (rejectionCounts["participant-unavailable"] ?? 0) + 1;
            continue;
          }
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
        observationsBySportsbook[sportsbook.id] =
          (observationsBySportsbook[sportsbook.id] ?? 0) + 1;
        eventObservations += 1;
        persistedByMarket.set(
          price.marketKey,
          (persistedByMarket.get(price.marketKey) ?? 0) + 1,
        );
      }
      if (odds.persistAvailability)
        for (const [marketKey, expected] of expectedByMarket) {
          const persistedCount = persistedByMarket.get(marketKey) ?? 0;
          {
            const identity = fixtureOddsGroupAvailabilityIdentity({
              canonicalEventId: canonical.id,
              canonicalEventVersion: canonical.version,
              sportKey: canonical.sportKey,
              marketKey,
              sportsbookId: sportsbook.id,
            });
            await odds.persistAvailability({
              identity,
              state: persistedCount === expected ? "active" : "incomplete",
              observedAt: eventRetrievedAt,
              evidenceId: sha256Hex(
                JSON.stringify([
                  SHARP_API_PROVIDER_ID,
                  raw.providerEventId,
                  identity,
                  persistedCount === expected ? "active" : "incomplete",
                ]),
              ),
              reason:
                persistedCount === expected
                  ? "complete-market"
                  : "incomplete-market",
            });
          }
        }
    }
    if (odds.persistAvailability && bookRoles && expectedBookMarkets) {
      const observed = new Map<
        string,
        {
          readonly complete: ReadonlySet<string>;
          readonly prices: SharpApiOddsPage["events"][number]["bookmakers"][number]["prices"];
        }
      >();
      for (const book of raw.bookmakers) {
        const normalized = normalizeSportsbook(book.id);
        if (normalized.kind === "rejected") continue;
        const complete = completeMainPrices(
          book.prices.filter(
            (price) =>
              price.isMainLine &&
              !price.isAlternateLine &&
              !price.isPlayerProp &&
              !price.isStalePregamePrice &&
              Date.parse(price.observedAt) < canonicalStartsAt &&
              priceRetrievedBeforeStart(price) &&
              !price.isSuspended &&
              price.isActive !== false,
          ),
          league.leagueKey,
        );
        observed.set(normalized.sportsbook.id, {
          complete: new Set(complete.prices.map(({ marketKey }) => marketKey)),
          prices: book.prices,
        });
      }
      for (const [sportsbookId, expectedMarkets] of Object.entries(
        expectedBookMarkets,
      ))
        for (const expectedMarket of expectedMarkets) {
          if (
            !["moneyline", "spread", "total", "btts", "team_total"].includes(
              expectedMarket,
            )
          )
            continue;
          const marketKey = expectedMarket as
            "moneyline" | "spread" | "total" | "btts" | "team_total";
          const book = observed.get(sportsbookId);
          if (!book?.complete.has(marketKey)) {
            const evidence =
              book?.prices.filter(
                (price) =>
                  price.marketKey === marketKey &&
                  price.isMainLine &&
                  !price.isAlternateLine &&
                  !price.isPlayerProp &&
                  Date.parse(price.observedAt) < canonicalStartsAt &&
                  priceRetrievedBeforeStart(price),
              ) ?? [];
            const state =
              evidence.length === 0
                ? "missing"
                : evidence.every((price) => price.isStalePregamePrice)
                  ? "stale"
                  : evidence.every((price) => price.isSuspended)
                    ? "suspended"
                    : evidence.every((price) => price.isActive === false)
                      ? "closed"
                      : "incomplete";
            const reason =
              state === "missing" ? "provider-market-omitted" : state;
            const identity = fixtureOddsGroupAvailabilityIdentity({
              canonicalEventId: canonical.id,
              canonicalEventVersion: canonical.version,
              sportKey: canonical.sportKey,
              marketKey,
              sportsbookId,
            });
            await odds.persistAvailability({
              identity,
              state,
              observedAt: eventRetrievedAt,
              evidenceId: sha256Hex(
                JSON.stringify([
                  SHARP_API_PROVIDER_ID,
                  raw.providerEventId,
                  identity,
                  state,
                ]),
              ),
              reason,
            });
          }
        }
    }
    if (eventObservations > 0) events += 1;
  }
  return {
    events,
    observations,
    observationsBySportsbook,
    canonicalOddsEvents,
    rejectionCounts,
    snapshotsCreated,
    snapshotsExisting,
    currentAdvanced,
    currentRetained,
    staleEvidence,
    partialEvidence,
    suspendedEvidence,
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
    if (
      canonical &&
      !splitIdentityMatchesCanonical(
        canonical,
        raw.providerEventId,
        raw.awayTeam,
        raw.homeTeam,
        league.leagueKey,
      )
    )
      canonical = null;
    if (!canonical) {
      canonical = uniqueCanonicalSplitCandidate(
        canonicalOddsEvents
          .filter(({ canonical: candidate }) =>
            splitIdentityMatchesCanonical(
              candidate,
              raw.providerEventId,
              raw.awayTeam,
              raw.homeTeam,
              league.leagueKey,
            ),
          )
          .map(({ canonical: candidate }) => candidate),
      );
    }
    if (!canonical) {
      const exactAliasCandidates: CanonicalEvent[] = [];
      for (const providerEventId of splitProviderEventAliases(
        raw.providerEventId,
        league.leagueKey,
      )) {
        const candidate = await store.resolveExactCanonicalBinding({
          providerId: SHARP_API_PROVIDER_ID,
          providerEventId,
          sportKey: league.sportKey,
          leagueKey: league.leagueKey,
        });
        if (
          candidate &&
          splitIdentityMatchesCanonical(
            candidate,
            raw.providerEventId,
            raw.awayTeam,
            raw.homeTeam,
            league.leagueKey,
          )
        )
          exactAliasCandidates.push(candidate);
      }
      canonical = uniqueCanonicalSplitCandidate(exactAliasCandidates);
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
      !splitIdentityMatchesCanonical(
        canonical,
        raw.providerEventId,
        raw.awayTeam,
        raw.homeTeam,
        league.leagueKey,
      )
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
          ...(selection.americanOdds === undefined
            ? {}
            : { americanOdds: selection.americanOdds }),
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
    const collectionPolicy = productionOddsCollectionPolicies.find(
      (candidate) => candidate.leagueKey === league.leagueKey,
    );
    const sharpApiPolicy = collectionPolicy?.providers.find(
      (provider) => provider.providerId === SHARP_API_PROVIDER_ID,
    );
    if (!sharpApiPolicy?.active)
      throw new Error("sharpapi-collection-policy-unavailable");
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
      await reconcileScheduledProviderEvent(
        store,
        SHARP_API_PROVIDER_ID,
        event,
        scheduleResult.retrievedAt,
      );
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
      sharpApiPolicy.books,
      undefined,
      sharpApiPolicy.expectedBooks,
      new Set(
        scheduleResult.events.map(({ providerEventId }) => providerEventId),
      ),
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
