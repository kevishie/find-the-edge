import type {
  GameDisplayDto,
  GameOddsSelectionDto,
} from "@find-the-edge/domain";

import type {
  Result,
  RuntimeBootstrap,
  RuntimeConfigError,
  TokenError,
} from "./runtime-config";

export type GamesSport = "mlb" | "soccer";

export interface GamesFilter {
  readonly sport: GamesSport;
  readonly day: string;
}

export interface GamesPageDto {
  readonly items: readonly GameDisplayDto[];
  readonly nextCursor: null;
  readonly projectionState: "ready" | "uninitialized";
  readonly evaluationState: "complete";
  readonly hasMoreUnknown: false;
  readonly snapshotAt: string | null;
  readonly freshness: string | null;
}

export interface GamesClient {
  list(filter: GamesFilter, signal: AbortSignal): Promise<GamesPageDto>;
}

export type GamesClientErrorCode =
  | "configuration"
  | "authentication"
  | "unauthorized"
  | "forbidden"
  | "request-failed"
  | "invalid-response";

export class GamesClientError extends Error {
  override readonly name = "GamesClientError";
  constructor(
    readonly code: GamesClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const exact = (value: object, keys: readonly string[]) =>
  Reflect.ownKeys(value).every((key) => typeof key === "string") &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

const plain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const boundedString = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const iso = (value: unknown): value is string =>
  boundedString(value, 40) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const easternDay = (value: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const validSelection = (value: unknown): value is GameOddsSelectionDto => {
  if (!plain(value)) return false;
  const required = [
    "marketKey",
    "selectionKey",
    "sportsbookId",
    "americanOdds",
    "observedAt",
    "retrievedAt",
  ];
  const optional = ["selectionLabel", "sportsbookLabel"].filter(
    (key) => key in value,
  );
  if (!exact(value, [...required, ...optional])) return false;
  return (
    boundedString(value["marketKey"], 64) &&
    boundedString(value["selectionKey"], 64) &&
    boundedString(value["sportsbookId"], 128) &&
    (value["selectionLabel"] === undefined ||
      boundedString(value["selectionLabel"], 160)) &&
    (value["sportsbookLabel"] === undefined ||
      boundedString(value["sportsbookLabel"], 160)) &&
    Number.isInteger(value["americanOdds"]) &&
    Math.abs(value["americanOdds"] as number) >= 100 &&
    Math.abs(value["americanOdds"] as number) <= 100_000 &&
    iso(value["observedAt"]) &&
    iso(value["retrievedAt"])
  );
};

const validGame = (
  value: unknown,
  filter: GamesFilter,
): value is GameDisplayDto => {
  if (!plain(value)) return false;
  if (
    !exact(value, [
      "id",
      "version",
      "sportKey",
      "leagueKey",
      "competition",
      "participants",
      "startsAt",
      "eastern",
      "status",
      "freshness",
      "odds",
    ]) ||
    !boundedString(value["id"], 512) ||
    !Number.isSafeInteger(value["version"]) ||
    (value["version"] as number) < 1 ||
    value["sportKey"] !== filter.sport ||
    value["leagueKey"] !== (filter.sport === "mlb" ? "mlb" : "mls") ||
    value["status"] !== "scheduled" ||
    !iso(value["startsAt"]) ||
    easternDay(value["startsAt"]) !== filter.day ||
    (value["freshness"] !== null && !iso(value["freshness"]))
  )
    return false;
  const competition = value["competition"];
  if (
    !plain(competition) ||
    !exact(competition, ["key", "state"]) ||
    !boundedString(competition["key"], 128) ||
    competition["state"] !== "provisional"
  )
    return false;
  const eastern = value["eastern"];
  if (
    !plain(eastern) ||
    !exact(eastern, ["timeZone", "calendarDay", "display"]) ||
    eastern["timeZone"] !== "America/New_York" ||
    eastern["calendarDay"] !== filter.day ||
    !boundedString(eastern["display"], 160)
  )
    return false;
  const participants = value["participants"];
  if (
    !Array.isArray(participants) ||
    participants.length < 2 ||
    participants.length > 8
  )
    return false;
  const participantIds = new Set<string>();
  let awayLabel: string | undefined;
  for (const participant of participants) {
    if (
      !plain(participant) ||
      !exact(participant, ["id", "label"]) ||
      !boundedString(participant["id"], 512) ||
      !boundedString(participant["label"], 160) ||
      participantIds.has(participant["id"])
    )
      return false;
    if (participantIds.size === 0) awayLabel = participant["label"];
    participantIds.add(participant["id"]);
  }
  if (!awayLabel) return false;
  const odds = value["odds"];
  if (!plain(odds) || !boundedString(odds["state"], 16)) return false;
  if (odds["state"] === "unavailable") return exact(odds, ["state"]);
  if (
    odds["state"] !== "available" ||
    !exact(odds, ["state", "selections"]) ||
    !Array.isArray(odds["selections"]) ||
    odds["selections"].length !== 1 ||
    !odds["selections"].every(validSelection)
  )
    return false;
  const selection = odds["selections"][0]!;
  const expectedMarket =
    filter.sport === "mlb" ? "moneyline" : "three_way_moneyline";
  return (
    selection.marketKey === expectedMarket &&
    selection.selectionKey === "away" &&
    selection.sportsbookId === "fixture-book" &&
    selection.selectionLabel === awayLabel &&
    selection.observedAt <= selection.retrievedAt
  );
};

function parsePage(value: unknown, filter: GamesFilter): GamesPageDto {
  if (
    !plain(value) ||
    !exact(value, [
      "items",
      "nextCursor",
      "projectionState",
      "evaluationState",
      "hasMoreUnknown",
      "snapshotAt",
      "freshness",
    ]) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > 50 ||
    value["nextCursor"] !== null ||
    !["ready", "uninitialized"].includes(String(value["projectionState"])) ||
    value["evaluationState"] !== "complete" ||
    value["hasMoreUnknown"] !== false ||
    (value["snapshotAt"] !== null && !iso(value["snapshotAt"])) ||
    (value["freshness"] !== null && !iso(value["freshness"])) ||
    !value["items"].every((game) => validGame(game, filter))
  )
    throw new GamesClientError(
      "invalid-response",
      "The games response was invalid.",
    );
  const items = value["items"];
  const ids = new Set(items.map(({ id }) => id));
  if (
    ids.size !== items.length ||
    items.some(
      (game, index) => index > 0 && game.startsAt < items[index - 1]!.startsAt,
    )
  )
    throw new GamesClientError(
      "invalid-response",
      "The games response was invalid.",
    );
  return value as unknown as GamesPageDto;
}

function bootstrapFailure(
  failure: RuntimeConfigError | TokenError,
): GamesClientError {
  return new GamesClientError(
    failure.kind === "runtime-config-error"
      ? "configuration"
      : "authentication",
    failure.message,
  );
}

export function createGamesClient(
  bootstrap: Result<RuntimeBootstrap, RuntimeConfigError>,
  fetcher: typeof fetch = fetch,
): Result<GamesClient, GamesClientError> {
  if (!bootstrap.ok)
    return { ok: false, error: bootstrapFailure(bootstrap.error) };
  return {
    ok: true,
    value: {
      async list(filter, signal) {
        const token = await bootstrap.value.acquireAccessToken({ signal });
        if (!token.ok) throw bootstrapFailure(token.error);
        const query = new URLSearchParams({
          sport: filter.sport,
          league: filter.sport === "mlb" ? "mlb" : "mls",
          status: "scheduled",
          day: filter.day,
          limit: "50",
        });
        let response: Response;
        try {
          response = await fetcher(
            `${bootstrap.value.config.apiBase}/games?${query}`,
            {
              signal,
              headers: { authorization: `Bearer ${token.value}` },
            },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new GamesClientError(
            "request-failed",
            "Games are temporarily unavailable.",
          );
        }
        if (response.status === 401)
          throw new GamesClientError(
            "unauthorized",
            "Your session is not authorized.",
          );
        if (response.status === 403)
          throw new GamesClientError(
            "forbidden",
            "Your session cannot read games.",
          );
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            "Games are temporarily unavailable.",
          );
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new GamesClientError(
            "invalid-response",
            "The games response was invalid.",
          );
        }
        return parsePage(payload, filter);
      },
    },
  };
}
