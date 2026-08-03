import type {
  GameDisplayDto,
  GameOddsSelectionDto,
} from "@find-the-edge/domain";

import type {
  Result,
  RuntimeBootstrap,
  RuntimeConfigError,
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
  const optional = ["selectionLabel", "sportsbookLabel", "point"].filter(
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
    (value["point"] === undefined ||
      (typeof value["point"] === "number" &&
        Number.isFinite(value["point"]) &&
        Math.abs(value["point"]) <= 10_000)) &&
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
  if (!Array.isArray(participants) || participants.length !== 2) return false;
  const participantIds = new Set<string>();
  let awayLabel: string | undefined;
  let homeLabel: string | undefined;
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
    if (participantIds.size === 1) homeLabel = participant["label"];
    participantIds.add(participant["id"]);
  }
  if (!awayLabel || !homeLabel) return false;
  const odds = value["odds"];
  if (!plain(odds) || !boundedString(odds["state"], 16)) return false;
  if (odds["state"] === "unavailable") return exact(odds, ["state"]);
  if (
    odds["state"] !== "available" ||
    !exact(odds, ["state", "selections"]) ||
    !Array.isArray(odds["selections"]) ||
    odds["selections"].length < (filter.sport === "mlb" ? 2 : 3) ||
    odds["selections"].length > (filter.sport === "mlb" ? 6 : 7) ||
    !odds["selections"].every(validSelection)
  )
    return false;
  const expectedMarket =
    filter.sport === "mlb" ? "moneyline" : "three_way_moneyline";
  const expectedSelections =
    filter.sport === "mlb"
      ? ([
          ["away", awayLabel],
          ["home", homeLabel],
        ] as const)
      : ([
          ["away", awayLabel],
          ["draw", "Draw"],
          ["home", homeLabel],
        ] as const);
  const selections = odds["selections"];
  const sportsbookId = selections[0]?.sportsbookId;
  const observedAt = selections[0]?.observedAt;
  const retrievedAt = selections[0]?.retrievedAt;
  if (
    typeof sportsbookId !== "string" ||
    !selections.every(
      (selection) =>
        selection.sportsbookId === sportsbookId &&
        selection.observedAt === observedAt &&
        selection.retrievedAt === retrievedAt &&
        selection.observedAt <= selection.retrievedAt,
    )
  )
    return false;
  const grouped = new Map<string, GameOddsSelectionDto[]>();
  for (const selection of selections) {
    const group = grouped.get(selection.marketKey) ?? [];
    if (
      group.some(({ selectionKey }) => selectionKey === selection.selectionKey)
    )
      return false;
    group.push(selection);
    grouped.set(selection.marketKey, group);
  }
  if (
    [...grouped.keys()].some(
      (key) => ![expectedMarket, "spread", "total"].includes(key),
    )
  )
    return false;
  const moneyline = grouped.get(expectedMarket);
  if (
    !moneyline ||
    moneyline.length !== expectedSelections.length ||
    !moneyline.every(
      (selection, index) =>
        selection.selectionKey === expectedSelections[index]![0] &&
        selection.selectionLabel === expectedSelections[index]![1] &&
        selection.point === undefined,
    )
  )
    return false;
  const spread = grouped.get("spread");
  if (
    spread &&
    (spread.length !== 2 ||
      !spread.every(
        (selection, index) =>
          selection.selectionKey === ["away", "home"][index] &&
          selection.selectionLabel === [awayLabel, homeLabel][index] &&
          selection.point !== undefined,
      ))
  )
    return false;
  if (spread && spread[0]!.point !== -spread[1]!.point!) return false;
  const total = grouped.get("total");
  return !(
    total &&
    (total.length !== 2 ||
      !total.every(
        (selection, index) =>
          selection.selectionKey === ["over", "under"][index] &&
          selection.selectionLabel === ["Over", "Under"][index] &&
          selection.point !== undefined,
      ) ||
      total[0]!.point !== total[1]!.point ||
      total[0]!.point! < 0)
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

function bootstrapFailure(failure: RuntimeConfigError): GamesClientError {
  return new GamesClientError("configuration", failure.message);
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
            { signal },
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
            "Games are temporarily unavailable.",
          );
        if (response.status === 403)
          throw new GamesClientError(
            "forbidden",
            "Games are temporarily unavailable.",
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
