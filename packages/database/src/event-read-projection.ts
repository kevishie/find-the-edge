import type {
  CanonicalEvent,
  EventDisplayDto,
  EventStatus,
} from "@find-the-edge/domain";
import type { DynamoItem } from "./dynamodb-event-ingestion";
import { EventStorageError } from "./event-errors";
export const EVENT_READ_SCHEMA = 1;
export const EVENT_TIME_ZONE = "America/New_York";
export const EVENT_STATUSES: readonly EventStatus[] = [
  "scheduled",
  "postponed",
  "cancelled",
  "started",
  "completed",
  "unknown",
];
const identifier = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
export const assertIdentifier = (value: string, name: string): void => {
  if (!identifier.test(value)) throw new Error(`invalid-${name}`);
};
export const easternDay = (instant: string): string => {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== instant)
    throw new EventStorageError("invalid-event-time");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};
export const sportPartition = (
  sport: string,
  status: EventStatus,
  day: string,
): string => `EVENTS#SPORT#${sport}#STATUS#${status}#DAY#${day}`;
export const leaguePartition = (
  sport: string,
  league: string,
  status: EventStatus,
  day: string,
): string =>
  `EVENTS#SPORT#${sport}#LEAGUE#${league}#STATUS#${status}#DAY#${day}`;
export const projectionSk = (
  startsAt: string,
  id: string,
  version: number,
): string => `${startsAt}#${id}#${String(version).padStart(16, "0")}`;
export interface EventProjectionValue {
  readonly schemaVersion: 1;
  readonly family: "sport" | "league";
  readonly eventId: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly day: string;
  readonly status: EventStatus;
  readonly participantIds: readonly string[];
  readonly participantLabels: readonly string[];
  readonly startsAt: string;
  readonly canonicalFreshness: string;
  readonly materialVersion: number;
  readonly visibleFrom: string;
  readonly visibleUntil: string | null;
}
export interface EventDetailPointer {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly materialVersion: number;
  readonly sportPk: string;
  readonly sportSk: string;
  readonly leaguePk: string;
  readonly leagueSk: string;
}
export const projectionItems = (
  event: CanonicalEvent,
  materializedAt = event.updatedAt,
) => {
  if (!event.participantLabels)
    throw new EventStorageError("missing-participant-labels");
  const day = easternDay(event.startsAt),
    sportPk = sportPartition(event.sportKey, event.status, day),
    leaguePk = leaguePartition(
      event.sportKey,
      event.leagueKey,
      event.status,
      day,
    ),
    sk = projectionSk(event.startsAt, event.id, event.version);
  const base = {
    schemaVersion: EVENT_READ_SCHEMA,
    eventId: event.id,
    sportKey: event.sportKey,
    leagueKey: event.leagueKey,
    day,
    status: event.status,
    participantIds: [...event.participantIds],
    participantLabels: [...event.participantLabels],
    startsAt: event.startsAt,
    canonicalFreshness: event.updatedAt,
    materialVersion: event.version,
    visibleFrom: materializedAt,
    visibleUntil: null,
  };
  return {
    pointer: {
      pk: `EVENT_DETAIL#${event.id}`,
      sk: "CURRENT",
      value: {
        schemaVersion: EVENT_READ_SCHEMA,
        eventId: event.id,
        materialVersion: event.version,
        sportPk,
        sportSk: sk,
        leaguePk,
        leagueSk: sk,
      },
    },
    sport: { pk: sportPk, sk, value: { ...base, family: "sport" } },
    league: { pk: leaguePk, sk, value: { ...base, family: "league" } },
  };
};
export const closeProjection = (
  item: DynamoItem,
  visibleUntil: string,
): DynamoItem => ({
  ...item,
  value: { ...(item.value as Readonly<Record<string, unknown>>), visibleUntil },
  expiresAt: Math.ceil(Date.parse(visibleUntil) / 1000) + 7 * 86_400,
});
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
export const validateProjection = (
  item: DynamoItem,
  family: "sport" | "league",
  now: string,
): EventProjectionValue => {
  void now;
  if (
    !item.value ||
    typeof item.value !== "object" ||
    Array.isArray(item.value)
  )
    throw new EventStorageError("invalid-projection");
  const value = item.value as Readonly<Record<string, unknown>>;
  const keys = [
    "schemaVersion",
    "family",
    "eventId",
    "sportKey",
    "leagueKey",
    "day",
    "status",
    "participantIds",
    "participantLabels",
    "startsAt",
    "canonicalFreshness",
    "materialVersion",
    "visibleFrom",
    "visibleUntil",
  ];
  if (
    !exact(value, keys) ||
    value["schemaVersion"] !== 1 ||
    value["family"] !== family ||
    !EVENT_STATUSES.includes(value["status"] as EventStatus) ||
    !Array.isArray(value["participantIds"]) ||
    !Array.isArray(value["participantLabels"]) ||
    value["participantIds"].length < 2 ||
    value["participantIds"].length > 16 ||
    new Set(value["participantIds"]).size !== value["participantIds"].length ||
    value["participantIds"].length !== value["participantLabels"].length ||
    !Number.isSafeInteger(value["materialVersion"]) ||
    (value["materialVersion"] as number) < 1
  )
    throw new EventStorageError("invalid-projection");
  for (const id of [
    value["eventId"],
    value["sportKey"],
    value["leagueKey"],
    ...(value["participantIds"] as unknown[]),
  ])
    if (typeof id !== "string" || !identifier.test(id))
      throw new EventStorageError("invalid-projection");
  for (const label of value["participantLabels"])
    if (
      typeof label !== "string" ||
      label !== label.trim() ||
      label.length < 1 ||
      label.length > 120
    )
      throw new EventStorageError("invalid-projection");
  for (const instant of [
    value["startsAt"],
    value["canonicalFreshness"],
    value["visibleFrom"],
    ...(value["visibleUntil"] ? [value["visibleUntil"]] : []),
  ])
    if (
      typeof instant !== "string" ||
      new Date(instant).toISOString() !== instant
    )
      throw new EventStorageError("invalid-projection");
  const typed = value as unknown as EventProjectionValue;
  if (
    typed.canonicalFreshness > typed.visibleFrom ||
    (typed.visibleUntil !== null && typed.visibleUntil <= typed.visibleFrom) ||
    (typed.visibleUntil === null && item.expiresAt !== undefined) ||
    (typed.visibleUntil !== null &&
      (!Number.isSafeInteger(item.expiresAt) ||
        (item.expiresAt as number) <
          Math.ceil(Date.parse(typed.visibleUntil) / 1000) + 900))
  )
    throw new EventStorageError("invalid-projection");
  const expectedPk =
    family === "sport"
      ? sportPartition(typed.sportKey, typed.status, typed.day)
      : leaguePartition(
          typed.sportKey,
          typed.leagueKey,
          typed.status,
          typed.day,
        );
  if (
    item.pk !== expectedPk ||
    item.sk !==
      projectionSk(typed.startsAt, typed.eventId, typed.materialVersion) ||
    easternDay(typed.startsAt) !== typed.day
  )
    throw new EventStorageError("projection-key-mismatch");
  return typed;
};
export const toEventDisplayDto = (
  value: EventProjectionValue,
): EventDisplayDto => ({
  id: value.eventId,
  sportKey: value.sportKey,
  leagueKey: value.leagueKey,
  competition: { key: value.leagueKey, state: "provisional" },
  participants: value.participantIds.map((id: string, index: number) => ({
    id,
    label: value.participantLabels[index]!,
  })),
  startsAt: value.startsAt,
  eastern: {
    timeZone: EVENT_TIME_ZONE,
    calendarDay: easternDay(value.startsAt),
    display: new Intl.DateTimeFormat("en-US", {
      timeZone: EVENT_TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value.startsAt)),
  },
  status: value.status,
  freshness: value.canonicalFreshness,
});
