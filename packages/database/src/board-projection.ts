import type { GamesPage, GamesRepository } from "./games-repository";
import type { BettingSplitRepository } from "./betting-split-repository";

// Provider event ids churn between schedule runs — both the listing suffix
// and the base wording — so ids cannot identify a game across feeds. The
// stable identity is the participant pair plus the start instant. Labels vary
// in form ("Athletics" against "Oakland Athletics"), so matching is anchored
// on the club nickname, mirroring split attribution.
const normalizedParticipant = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const participantLabelMatches = (left: string, right: string) => {
  const a = normalizedParticipant(left).split(" ");
  const b = normalizedParticipant(right).split(" ");
  if (a[0] === "" || b[0] === "") return false;
  if (a.join(" ") === b.join(" ")) return true;
  if (a.at(-1) !== b.at(-1)) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.every((word) => longer.includes(word));
};

export interface ScheduleListing {
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly startsAt: string;
}

/** Start instants may shift by seconds between feeds; hours never do. */
const START_TOLERANCE_MS = 15 * 60_000;

/** How early the provider may flip a listing to in-play before first pitch. */
const PRE_START_IN_PLAY_GRACE_MS = 15 * 60_000;
/**
 * How old the newest split observation may be and still count as evidence.
 * Splits ingest on a fifteen-minute cadence, so this tolerates several missed
 * passes while still refusing the twenty-hour freeze of 2026-08-12.
 */
const SPLIT_WITNESS_MAX_AGE_MS = 90 * 60_000;

const listingMatchesGame = (
  listing: ScheduleListing,
  game: {
    readonly startsAt: string;
    readonly participants: readonly { readonly label: string }[];
  },
) => {
  if (
    Math.abs(Date.parse(listing.startsAt) - Date.parse(game.startsAt)) >
    START_TOLERANCE_MS
  )
    return false;
  const away = game.participants[0]?.label ?? "";
  const home = game.participants[1]?.label ?? "";
  if (!away || !home) return false;
  return (
    (participantLabelMatches(listing.awayTeam, away) &&
      participantLabelMatches(listing.homeTeam, home)) ||
    (participantLabelMatches(listing.awayTeam, home) &&
      participantLabelMatches(listing.homeTeam, away))
  );
};

/** Same two participants in either order — the identity a duplicate shares
 * with the real listing of the same game. */
const participantIdentity = (game: {
  readonly participants: readonly { readonly label: string }[];
}) =>
  game.participants
    .slice(0, 2)
    .map(({ label }) => label.trim().toLowerCase())
    .sort()
    .join("\u0000");

export const usableScheduleListings = (
  events: readonly {
    readonly awayTeam?: string;
    readonly homeTeam?: string;
    readonly startsAt: string;
  }[],
): readonly ScheduleListing[] =>
  events.flatMap((event) =>
    event.awayTeam && event.homeTeam
      ? [
          {
            awayTeam: event.awayTeam,
            homeTeam: event.homeTeam,
            startsAt: event.startsAt,
          },
        ]
      : [],
  );

/**
 * A provider occasionally publishes a listing, lets a book quote it, and then
 * withdraws it — so odds evidence alone cannot prove a scheduled game is
 * real. The provider's current schedule can, but it excludes games already in
 * play, so a past-start absentee needs a second witness: in a league whose
 * games always carry betting splits, a real game has them and a withdrawn
 * listing does not. The filter fails open (a null schedule filters nothing)
 * and self-heals on the next run.
 */
export const withoutWithdrawnListings = async <
  T extends {
    readonly id: string;
    readonly status: string;
    readonly startsAt: string;
    readonly freshness: string | null;
    readonly participants: readonly { readonly label: string }[];
  },
>(
  page: { readonly items: readonly T[]; readonly freshness: string | null },
  options: {
    readonly schedule: readonly ScheduleListing[] | null;
    readonly now: Date;
    /** Whether every real game in this league carries split observations. */
    readonly splitsExpected: boolean;
    /**
     * Newest split observation for an event, or null if it has none. A
     * timestamp rather than a boolean because "this game has no splits" and
     * "the splits feed stopped" are different facts and only the first is
     * evidence about the game.
     */
    readonly splitWitnessAt: (
      canonicalEventId: string,
    ) => Promise<string | null>;
  },
) => {
  if (!options.schedule) return page;
  const schedule = options.schedule;
  // Provider ids embed a time bucket, so a corrected start time mints a NEW
  // id and we bootstrap a second canonical event for one real game. The
  // orphan keeps the placeholder kickoff and whatever odds it collected, and
  // the splits witness cannot reject it — consensus splits get attributed to
  // it too, because it has the right teams on the right day.
  //
  // What separates it from a real game is the provider's own schedule: a
  // doubleheader has BOTH games listed, while an orphan has a sibling with
  // the same participants that the provider currently vouches for and no
  // listing of its own. That pairing is the discriminator, and it is narrow
  // on purpose — without a vouched-for sibling the older rules still decide.
  const vouchedParticipants = new Set(
    page.items
      .filter((game) =>
        schedule.some((listing) => listingMatchesGame(listing, game)),
      )
      .map(participantIdentity),
  );
  // The witness can only condemn a game if the witness is actually speaking.
  // On 2026-08-12 production's MLB splits feed froze for nearly twenty hours
  // while every stored observation sat there looking like evidence: splits
  // are never expired and `listCurrent` returns whatever was last persisted,
  // so a dead feed is indistinguishable from a quiet game unless the age is
  // read. Liveness is therefore judged across the whole board — if ANY game
  // on it carries a fresh observation the feed is up, and a game that is
  // silent against that backdrop is genuinely silent. If nothing on the board
  // is fresh the feed is down, and a down feed has no opinion about anyone.
  const witnessCache = new Map<string, number | null>();
  const witnessAt = async (id: string) => {
    if (!witnessCache.has(id)) {
      const at = await options.splitWitnessAt(id).catch(() => null);
      const parsed = at === null ? null : Date.parse(at);
      witnessCache.set(
        id,
        parsed === null || Number.isNaN(parsed) ? null : parsed,
      );
    }
    return witnessCache.get(id) ?? null;
  };
  const isFresh = (at: number | null) =>
    at !== null && options.now.getTime() - at <= SPLIT_WITNESS_MAX_AGE_MS;

  let witnessUsable = false;
  if (options.splitsExpected) {
    for (const game of page.items) {
      if (isFresh(await witnessAt(game.id))) {
        witnessUsable = true;
        break;
      }
    }
  }

  const items: T[] = [];
  for (const game of page.items) {
    if (game.status !== "scheduled") {
      items.push(game);
      continue;
    }
    if (schedule.some((listing) => listingMatchesGame(listing, game))) {
      items.push(game);
      continue;
    }
    if (vouchedParticipants.has(participantIdentity(game))) continue;
    // The provider flips a listing to in-play minutes before first pitch, so
    // a game inside the pre-start window is judged like a started game — by
    // its splits witness — rather than as a withdrawn future listing.
    const startsInFuture =
      Date.parse(game.startsAt) >
      options.now.getTime() + PRE_START_IN_PLAY_GRACE_MS;
    // A future absentee used to be dropped here outright, on no evidence at
    // all. That rule has hidden real games twice: 9b98b3f caught it three
    // minutes before first pitch and bought a fifteen-minute grace window,
    // and on 2026-08-12 it deleted both 22:10 Eastern games more than three
    // hours out. The grace window was sized to a symptom. The cause is that
    // the provider rotates full-game rows out of its /events catalogue at
    // arbitrary lead times and leaves the props and binaries behind, so
    // absence from that catalogue is not evidence of withdrawal — and odds
    // cannot arbitrate, because they are collected from the same catalogue
    // and freeze with it. The splits feed is separate and kept publishing for
    // both games on the same pass as every retained game, so where a witness
    // exists a future absentee is judged by it, exactly like a started one.
    // Leagues without split coverage have no witness and are unchanged.
    if (startsInFuture && !options.splitsExpected) continue;
    if (!options.splitsExpected) {
      // In-play games leave the schedule feed; without a splits witness this
      // league cannot distinguish them from a withdrawn listing, so keep.
      items.push(game);
      continue;
    }
    if (!witnessUsable) {
      // The feed is down, not the game. An absent witness is an absent
      // opinion, and a board must never shrink because a provider went quiet.
      items.push(game);
      continue;
    }
    if (isFresh(await witnessAt(game.id))) items.push(game);
  }
  if (items.length === page.items.length) return page;
  return {
    ...page,
    items,
    // Page freshness is defined as the oldest item freshness, so dropping an
    // item must recompute it or the response would fail its own contract.
    freshness: items.reduce<string | null>(
      (oldest, game) =>
        game.freshness === null
          ? oldest
          : oldest === null || game.freshness < oldest
            ? game.freshness
            : oldest,
      null,
    ),
  };
};

/**
 * A board — the games or splits page for one sport and Eastern day — is
 * identical for every anonymous caller and only changes when the five-minute
 * ingest runs. Rebuilding it per request means every reader pays the full
 * projection cost. Instead the worker materializes the exact response body
 * right after it ingests, and the API serves the stored body with a single
 * read, falling back to the live projection whenever a stored board is
 * missing, stale, or malformed.
 */
export interface BoardKey {
  readonly route: "games" | "splits";
  readonly sportKey: "mlb" | "soccer";
  readonly leagueKey: string;
  readonly status: string;
  readonly day: string;
  readonly limit: number;
}

export interface BoardCounts {
  readonly stale: number;
  readonly partial: number;
  readonly unavailable: number;
}

export interface StoredBoard {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly body: string;
  readonly counts: BoardCounts;
}

/** Two ingest cycles: beyond this the live projection is the honest answer. */
export const BOARD_MAX_AGE_MS = 10 * 60_000;

const BOARD_BODY_LIMIT_BYTES = 380_000;

export const boardPartition = (key: BoardKey) =>
  `BOARD#${key.route}#${key.sportKey}#${key.leagueKey}#${key.status}#${key.day}#${String(key.limit)}`;

const finiteCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const validateStoredBoard = (
  value: unknown,
  now: Date,
): StoredBoard | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const counts = record["counts"] as Record<string, unknown> | undefined;
  if (
    record["schemaVersion"] !== 1 ||
    typeof record["generatedAt"] !== "string" ||
    !Number.isFinite(Date.parse(record["generatedAt"])) ||
    typeof record["body"] !== "string" ||
    record["body"].length === 0 ||
    record["body"].length > BOARD_BODY_LIMIT_BYTES ||
    !counts ||
    typeof counts !== "object" ||
    !finiteCount(counts["stale"]) ||
    !finiteCount(counts["partial"]) ||
    !finiteCount(counts["unavailable"])
  )
    return null;
  const age = now.getTime() - Date.parse(record["generatedAt"]);
  // A future timestamp is as untrustworthy as a stale one.
  if (age < -60_000 || age > BOARD_MAX_AGE_MS) return null;
  return value as StoredBoard;
};

// SharpAPI's consensus scope already aggregates DraftKings and Circa, so
// publishing those two beside it repeats every game once per member book.
// Books the consensus does not cover stand alone and stay published.
const consensusMemberScopes = new Set(["draftkings", "circa"]);

export const publishedSplitScopes = <T extends { readonly scope?: string }>(
  splits: readonly T[],
) => {
  const scopes = new Set(splits.map(({ scope }) => scope?.toLowerCase()));
  return scopes.has("consensus")
    ? splits.filter(
        ({ scope }) => !consensusMemberScopes.has(scope?.toLowerCase() ?? ""),
      )
    : splits;
};

export const boardCounts = (page: {
  readonly projectionState: GamesPage["projectionState"];
  readonly items: readonly {
    readonly metadata: {
      readonly freshness: { readonly state: string };
      readonly availability: string;
    };
  }[];
}): BoardCounts => {
  const counts = page.items.reduce(
    (accumulated, item) => ({
      stale:
        accumulated.stale + (item.metadata.freshness.state === "stale" ? 1 : 0),
      partial:
        accumulated.partial +
        (item.metadata.availability === "partial" ? 1 : 0),
      unavailable:
        accumulated.unavailable +
        (item.metadata.availability === "unavailable" ? 1 : 0),
    }),
    { stale: 0, partial: 0, unavailable: 0 },
  );
  return page.projectionState === "uninitialized"
    ? { ...counts, unavailable: 1 }
    : counts;
};

export const attachSplits = async (
  page: GamesPage,
  splits: BettingSplitRepository,
  listCurrent: (
    eventId: string,
  ) => ReturnType<BettingSplitRepository["listCurrent"]> = (eventId) =>
    splits.listCurrent(eventId),
) => ({
  ...page,
  items: await Promise.all(
    page.items.map(async (game) => ({
      ...game,
      // Schedule refreshes may advance the canonical event version even when
      // the event identity and split evidence are unchanged. Return the
      // freshest logical split per market/selection across versions — but
      // never evidence recorded against a HIGHER version than the event
      // carries now (a rebuilt catalog restarts versions at one while
      // retained split rows remember the old lineage; clients rightly
      // refuse splits from the future).
      splits: publishedSplitScopes(
        (await listCurrent(game.id)).filter(
          (split) => split.canonicalEventVersion <= game.version,
        ),
      ),
    })),
  ),
});

const easternDay = (instant: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);

export const materializationTargets = (now: Date): readonly BoardKey[] => {
  const days = [
    easternDay(now),
    easternDay(new Date(now.getTime() + 86_400_000)),
  ];
  const sports: readonly (readonly ["mlb" | "soccer", string])[] = [
    ["mlb", "mlb"],
    ["soccer", "mls"],
  ];
  return sports.flatMap(([sportKey, leagueKey]) =>
    days.flatMap((day) => [
      // The games screen requests every lifecycle merged; splits is
      // scheduled-only by contract and MLB-only by provider coverage.
      {
        route: "games" as const,
        sportKey,
        leagueKey,
        status: "all",
        day,
        limit: 50,
      },
      {
        route: "games" as const,
        sportKey,
        leagueKey,
        status: "scheduled",
        day,
        limit: 50,
      },
      ...(sportKey === "mlb"
        ? [
            {
              route: "splits" as const,
              sportKey,
              leagueKey,
              status: "scheduled",
              day,
              limit: 50,
            },
          ]
        : []),
    ]),
  );
};

export interface BoardMaterializationResult {
  readonly stored: number;
  readonly skipped: number;
  /** Age of the newest priced evidence across every scheduled board that has
   * priced upcoming games, worst league first; null when no such board
   * exists (an empty slate is not staleness). Provider health alone has
   * twice proven blind to frozen persistence — this measures the data. */
  readonly scheduledOddsAgeSeconds: number | null;
  /**
   * How many listings the withdrawn-listing filter removed across all boards.
   * Zero is ambiguous on its own — it means either "nothing to remove" or
   * "the filter never ran" — so it is read alongside the sweep's own log,
   * which names the reason whenever the schedule was unavailable.
   */
  readonly withdrawnDropped: number;
  /**
   * Per sport, how many upcoming scheduled games carry a price and how many
   * do not. A sport where every upcoming game is priceless is the shape both
   * of the 2026-08-11 soccer faults took — a latched ambiguity marker and a
   * feed published under a league we do not collect — and both ran for eleven
   * hours behind green provider health. Board freshness could not see them:
   * there was no price to be stale.
   */
  readonly pricedBySport: Readonly<
    Record<string, { readonly upcoming: number; readonly priced: number }>
  >;
}

export const materializeBoards = async (input: {
  readonly games: GamesRepository;
  readonly splits: BettingSplitRepository;
  readonly put: (item: {
    readonly pk: string;
    readonly sk: "CURRENT";
    readonly value: StoredBoard;
  }) => Promise<void>;
  readonly now: Date;
  /** Current schedule listings per sport; null disables the filter. */
  readonly scheduleListings?: (
    sportKey: "mlb" | "soccer",
  ) => Promise<readonly ScheduleListing[] | null>;
}): Promise<BoardMaterializationResult> => {
  let stored = 0;
  let skipped = 0;
  let scheduledOddsAgeSeconds: number | null = null;
  let withdrawnDropped = 0;
  const pricedBySport: Record<string, { upcoming: number; priced: number }> =
    {};
  const scheduleCache = new Map<string, readonly ScheduleListing[] | null>();
  const scheduleFor = async (sportKey: "mlb" | "soccer") => {
    if (!input.scheduleListings) return null;
    if (!scheduleCache.has(sportKey))
      scheduleCache.set(
        sportKey,
        await input.scheduleListings(sportKey).catch(() => null),
      );
    return scheduleCache.get(sportKey) ?? null;
  };
  const splitEvidence = new Map<string, string | null>();
  const splitWitnessAt = async (canonicalEventId: string) => {
    if (!splitEvidence.has(canonicalEventId))
      splitEvidence.set(
        canonicalEventId,
        await input.splits
          .listCurrent(canonicalEventId)
          .then((observations) =>
            observations.reduce<string | null>(
              (newest, observation) =>
                newest === null || observation.providerTimestamp > newest
                  ? observation.providerTimestamp
                  : newest,
              null,
            ),
          )
          .catch(() => null),
      );
    return splitEvidence.get(canonicalEventId) ?? null;
  };
  for (const key of materializationTargets(input.now)) {
    const rawPage = await input.games.list(
      {
        sportKey: key.sportKey,
        leagueKey: key.leagueKey,
        status: key.status as "scheduled" | "all",
        day: key.day,
      },
      key.limit,
    );
    const page = (await withoutWithdrawnListings(rawPage, {
      schedule: await scheduleFor(key.sportKey),
      now: input.now,
      // Verified against the live feed: the provider publishes splits for
      // every real MLB game and for no soccer game.
      splitsExpected: key.sportKey === "mlb",
      splitWitnessAt,
    })) as typeof rawPage;
    withdrawnDropped += rawPage.items.length - page.items.length;
    if (page.nextCursor !== null || page.projectionState !== "ready") {
      skipped += 1;
      continue;
    }
    if (key.route === "games" && key.status === "scheduled") {
      const newestRetrieved = Math.max(
        ...page.items
          .filter(
            (game) =>
              game.status === "scheduled" &&
              Date.parse(game.startsAt) > input.now.getTime() &&
              game.odds.state === "available",
          )
          .flatMap((game) =>
            game.odds.state === "available"
              ? game.odds.selections.map(({ retrievedAt }) =>
                  Date.parse(retrievedAt),
                )
              : [],
          ),
      );
      if (Number.isFinite(newestRetrieved)) {
        const age = Math.max(
          0,
          (input.now.getTime() - newestRetrieved) / 1_000,
        );
        scheduledOddsAgeSeconds = Math.max(scheduledOddsAgeSeconds ?? 0, age);
      }
      const upcoming = page.items.filter(
        (game) =>
          game.status === "scheduled" &&
          Date.parse(game.startsAt) > input.now.getTime(),
      );
      const tally = (pricedBySport[key.sportKey] ??= {
        upcoming: 0,
        priced: 0,
      });
      tally.upcoming += upcoming.length;
      tally.priced += upcoming.filter(
        (game) => game.odds.state === "available",
      ).length;
    }
    const body = JSON.stringify(
      key.route === "splits" ? await attachSplits(page, input.splits) : page,
    );
    if (body.length > BOARD_BODY_LIMIT_BYTES) {
      skipped += 1;
      continue;
    }
    await input.put({
      pk: boardPartition(key),
      sk: "CURRENT",
      value: {
        schemaVersion: 1,
        generatedAt: input.now.toISOString(),
        body,
        counts: boardCounts(page),
      },
    });
    stored += 1;
  }
  return {
    stored,
    skipped,
    scheduledOddsAgeSeconds,
    withdrawnDropped,
    pricedBySport,
  };
};
