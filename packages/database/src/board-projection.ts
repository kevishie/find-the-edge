import type { GamesPage, GamesRepository } from "./games-repository";
import type { BettingSplitRepository } from "./betting-split-repository";

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
      // freshest logical split per market/selection across versions.
      splits: publishedSplitScopes(await listCurrent(game.id)),
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
      // scheduled-only by contract.
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
      {
        route: "splits" as const,
        sportKey,
        leagueKey,
        status: "scheduled",
        day,
        limit: 50,
      },
    ]),
  );
};

export interface BoardMaterializationResult {
  readonly stored: number;
  readonly skipped: number;
}

/**
 * Builds and stores every default board. A board whose page overflows into a
 * cursor is skipped: its cursor could not be resumed outside the API, and no
 * real slate reaches fifty games.
 */
export const materializeBoards = async (input: {
  readonly games: GamesRepository;
  readonly splits: BettingSplitRepository;
  readonly put: (item: {
    readonly pk: string;
    readonly sk: "CURRENT";
    readonly value: StoredBoard;
  }) => Promise<void>;
  readonly now: Date;
}): Promise<BoardMaterializationResult> => {
  let stored = 0;
  let skipped = 0;
  for (const key of materializationTargets(input.now)) {
    const page = await input.games.list(
      {
        sportKey: key.sportKey,
        leagueKey: key.leagueKey,
        status: key.status as "scheduled" | "all",
        day: key.day,
      },
      key.limit,
    );
    if (page.nextCursor !== null || page.projectionState !== "ready") {
      skipped += 1;
      continue;
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
  return { stored, skipped };
};
