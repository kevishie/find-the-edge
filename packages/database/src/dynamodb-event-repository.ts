import { EventInputError, EventStorageError } from "./event-errors";
import type { DynamoGateway, DynamoItem } from "./dynamodb-event-ingestion";
import {
  filterPartition,
  type EventCursorCodec,
  type EventListFilter,
  type EventPage,
  type EventRepository,
} from "./event-repository";
import { toEventDisplayDto, validateProjection } from "./event-read-projection";
const pointerKeys = [
  "schemaVersion",
  "eventId",
  "materialVersion",
  "sportPk",
  "sportSk",
  "leaguePk",
  "leagueSk",
];
type ReadGateway = {
  queryPage(
    pk: string,
    startSk: string | undefined,
    limit: number,
  ): ReturnType<DynamoGateway["queryPage"]>;
  transactGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ): ReturnType<DynamoGateway["transactGet"]>;
};
interface ValidPointer {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly materialVersion: number;
  readonly sportPk: string;
  readonly sportSk: string;
  readonly leaguePk: string;
  readonly leagueSk: string;
}
const validatePointer = (item: DynamoItem, eventId: string): ValidPointer => {
  if (
    item.pk !== `EVENT_DETAIL#${eventId}` ||
    item.sk !== "CURRENT" ||
    item.expiresAt !== undefined ||
    !item.value ||
    typeof item.value !== "object" ||
    Array.isArray(item.value) ||
    Object.keys(item.value).sort().join("|") !==
      [...pointerKeys].sort().join("|")
  )
    throw new EventStorageError("invalid-detail-pointer");
  const value = item.value as Readonly<Record<string, unknown>>;
  if (
    value["schemaVersion"] !== 1 ||
    value["eventId"] !== eventId ||
    !Number.isSafeInteger(value["materialVersion"]) ||
    (value["materialVersion"] as number) < 1 ||
    !["sportPk", "sportSk", "leaguePk", "leagueSk"].every(
      (key) => typeof value[key] === "string",
    )
  )
    throw new EventStorageError("invalid-detail-pointer");
  return value as unknown as ValidPointer;
};
export class DynamoEventRepository implements EventRepository {
  constructor(
    readonly gateway: ReadGateway,
    readonly cursor: EventCursorCodec,
    readonly ready: () => Promise<boolean>,
    readonly now: () => Date = () => new Date(),
  ) {}
  async list(
    filter: EventListFilter,
    limit: number,
    token?: string,
  ): Promise<EventPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new EventInputError("invalid-event-limit");
    const pk = filterPartition(filter),
      decoded =
        token !== undefined
          ? this.cursor.decode(token, pk, this.now())
          : undefined;
    if (!(await this.ready()))
      return {
        items: [],
        nextCursor: null,
        projectionState: "uninitialized",
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: null,
        freshness: null,
      };
    const asOf = decoded?.asOf ?? this.now().toISOString(),
      accepted = [];
    let startSk = decoded?.lastSk,
      lastPhysicalSk = startSk,
      hasPhysicalMore = false,
      evaluated = 0;
    while (accepted.length < limit && evaluated < 200) {
      const result = await this.gateway.queryPage(
        pk,
        startSk,
        Math.min(50, 200 - evaluated),
      );
      if (!result.items.length) {
        hasPhysicalMore = false;
        break;
      }
      for (let index = 0; index < result.items.length; index++) {
        const item = result.items[index]!;
        evaluated++;
        lastPhysicalSk = item.sk;
        const row = validateProjection(
          item,
          filter.leagueKey ? "league" : "sport",
          asOf,
        );
        if (
          row.visibleFrom <= asOf &&
          (row.visibleUntil === null || asOf < row.visibleUntil)
        )
          accepted.push(row);
        if (accepted.length === limit) {
          hasPhysicalMore = index + 1 < result.items.length;
          break;
        }
      }
      if (accepted.length === limit) {
        if (!hasPhysicalMore && result.lastEvaluatedSk && evaluated < 200) {
          const probe = await this.gateway.queryPage(
            pk,
            result.lastEvaluatedSk,
            1,
          );
          evaluated += probe.items.length;
          hasPhysicalMore = probe.items.length > 0;
        } else if (!hasPhysicalMore && result.lastEvaluatedSk) {
          hasPhysicalMore = true;
        }
        break;
      }
      hasPhysicalMore = result.lastEvaluatedSk !== undefined;
      if (!result.lastEvaluatedSk) break;
      startSk = result.lastEvaluatedSk;
    }
    const seen = new Set();
    for (const row of accepted) {
      if (seen.has(row.eventId))
        throw new EventStorageError("overlapping-event-page");
      seen.add(row.eventId);
    }
    const capped = evaluated >= 200 && hasPhysicalMore;
    return {
      items: accepted.map(toEventDisplayDto),
      nextCursor:
        hasPhysicalMore && lastPhysicalSk
          ? this.cursor.encode(pk, lastPhysicalSk, asOf, this.now())
          : null,
      projectionState: "ready",
      evaluationState: capped ? "partial" : "complete",
      hasMoreUnknown: capped,
      snapshotAt: asOf,
      freshness: accepted.length
        ? accepted.reduce(
            (oldest, row) =>
              row.canonicalFreshness < oldest ? row.canonicalFreshness : oldest,
            accepted[0]!.canonicalFreshness,
          )
        : null,
    };
  }
  async detail(
    eventId: string,
  ): Promise<import("./event-repository").EventDetailResult> {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,63})$/.test(eventId))
      throw new EventInputError("invalid-event-id");
    if (!(await this.ready()))
      return { projectionState: "uninitialized", item: null };
    const key = { pk: `EVENT_DETAIL#${eventId}`, sk: "CURRENT" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await this.gateway.transactGet([key]);
      if (!first[0]) return { projectionState: "ready", item: null };
      const pointer = validatePointer(first[0], eventId),
        snapshot = await this.gateway.transactGet([
          key,
          { pk: pointer.sportPk, sk: pointer.sportSk },
          { pk: pointer.leaguePk, sk: pointer.leagueSk },
        ]);
      if (!snapshot[0] || !snapshot[1] || !snapshot[2]) continue;
      if (
        JSON.stringify(validatePointer(snapshot[0], eventId)) !==
        JSON.stringify(pointer)
      )
        continue;
      const sport = validateProjection(
          snapshot[1],
          "sport",
          this.now().toISOString(),
        ),
        league = validateProjection(
          snapshot[2],
          "league",
          this.now().toISOString(),
        );
      const material = (row: typeof sport) =>
        JSON.stringify({
          eventId: row.eventId,
          sportKey: row.sportKey,
          leagueKey: row.leagueKey,
          day: row.day,
          status: row.status,
          participantIds: row.participantIds,
          participantLabels: row.participantLabels,
          startsAt: row.startsAt,
          canonicalFreshness: row.canonicalFreshness,
          materialVersion: row.materialVersion,
          visibleFrom: row.visibleFrom,
          visibleUntil: row.visibleUntil,
        });
      if (
        sport.eventId !== eventId ||
        sport.materialVersion !== pointer.materialVersion ||
        sport.visibleUntil !== null ||
        league.visibleUntil !== null ||
        sport.visibleFrom > this.now().toISOString() ||
        league.visibleFrom > this.now().toISOString() ||
        snapshot[1].pk !== pointer.sportPk ||
        snapshot[1].sk !== pointer.sportSk ||
        snapshot[2].pk !== pointer.leaguePk ||
        snapshot[2].sk !== pointer.leagueSk ||
        material(sport) !== material(league)
      )
        throw new EventStorageError("detail-material-mismatch");
      return {
        projectionState: "ready",
        item: toEventDisplayDto(sport),
      };
    }
    throw new EventStorageError("event-detail-snapshot-unstable");
  }
}
