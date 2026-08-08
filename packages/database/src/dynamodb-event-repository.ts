import {
  EventCursorError,
  EventInputError,
  EventStorageError,
} from "./event-errors";
import type { DynamoGateway, DynamoItem } from "./dynamodb-event-ingestion";
import {
  filterPartition,
  type EventCursorCodec,
  type EventListFilter,
  type EventPage,
  type EventRepository,
} from "./event-repository";
import {
  EVENT_STATUSES,
  isCanonicalEntityId,
  toEventDisplayDto,
  validateProjection,
} from "./event-read-projection";
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
    options?: { readonly consistentRead?: boolean },
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
    if (filter.status === "all")
      return this.listAllStatuses(filter, limit, token);
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
        unavailableReason: "projection-uninitialized",
      };
    const asOf = decoded?.asOf ?? this.now().toISOString(),
      accepted = [];
    let startSk = decoded?.lastSk,
      lastPhysicalSk = startSk,
      hasPhysicalMore = false,
      evaluated = 0;
    while (accepted.length < limit && evaluated < 200) {
      // Projection rows change on the ingest cadence, so the list view reads
      // eventually consistent.
      const result = await this.gateway.queryPage(
        pk,
        startSk,
        Math.min(50, 200 - evaluated),
        { consistentRead: false },
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
            { consistentRead: false },
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
      items: accepted.map((row) => toEventDisplayDto(row, asOf)),
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
      unavailableReason: null,
    };
  }
  /**
   * One request for every lifecycle. Each status partition is collected under
   * a single asOf, merged chronologically, and paginated with a composite
   * cursor that records the furthest consumed sort key per status.
   */
  private async listAllStatuses(
    filter: EventListFilter,
    limit: number,
    token?: string,
  ): Promise<EventPage> {
    const family = filter.leagueKey ? ("league" as const) : ("sport" as const);
    const partitions = EVENT_STATUSES.map((status) => ({
      status,
      pk: filterPartition({ ...filter, status }),
    }));
    // The synthetic partition exists only inside cursor signatures, so a
    // token minted for one status can never resume the merged view.
    const pkAll = `ALL#${partitions[0]!.pk}`;
    const decoded =
      token !== undefined
        ? this.cursor.decode(token, pkAll, this.now())
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
        unavailableReason: "projection-uninitialized",
      };
    const asOf = decoded?.asOf ?? this.now().toISOString();
    const startSks: Partial<Record<string, string>> = {};
    if (decoded) {
      try {
        const parsed: unknown = JSON.parse(decoded.lastSk);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("shape");
        for (const [status, sk] of Object.entries(parsed)) {
          if (
            !EVENT_STATUSES.includes(
              status as (typeof EVENT_STATUSES)[number],
            ) ||
            typeof sk !== "string" ||
            !sk
          )
            throw new Error("shape");
          startSks[status] = sk;
        }
      } catch {
        throw new EventCursorError("invalid-cursor");
      }
    }
    const collected = await Promise.all(
      partitions.map(async ({ status, pk }) => ({
        status,
        ...(await this.collectVisible(
          pk,
          startSks[status],
          asOf,
          limit,
          family,
        )),
      })),
    );
    const entries = collected.flatMap(({ status, accepted }) =>
      accepted.map((entry) => ({ status, sk: entry.sk, row: entry.row })),
    );
    entries.sort((left, right) =>
      left.row.startsAt < right.row.startsAt
        ? -1
        : left.row.startsAt > right.row.startsAt
          ? 1
          : left.row.eventId < right.row.eventId
            ? -1
            : left.row.eventId > right.row.eventId
              ? 1
              : 0,
    );
    const taken = entries.slice(0, limit);
    const seen = new Set<string>();
    for (const { row } of taken) {
      if (seen.has(row.eventId))
        throw new EventStorageError("overlapping-event-page");
      seen.add(row.eventId);
    }
    // Sort keys within a status rise with start time, so the last consumed
    // entry per status in merge order is that status's resume point. A status
    // fully drained of visible rows resumes past its evaluated tail instead,
    // so invisible rows cannot pin the cursor in place.
    const consumed: Record<string, string> = { ...startSks } as Record<
      string,
      string
    >;
    for (const entry of taken) consumed[entry.status] = entry.sk;
    const leftoverStatuses = new Set(
      entries.slice(limit).map(({ status }) => status),
    );
    for (const partition of collected) {
      if (
        !leftoverStatuses.has(partition.status) &&
        partition.lastPhysicalSk !== undefined
      )
        consumed[partition.status] = partition.lastPhysicalSk;
    }
    const hasMore =
      entries.length > taken.length ||
      collected.some(({ hasPhysicalMore }) => hasPhysicalMore);
    const capped = collected.some((partition) => partition.capped);
    return {
      items: taken.map(({ row }) => toEventDisplayDto(row, asOf)),
      nextCursor:
        hasMore || capped
          ? this.cursor.encode(
              pkAll,
              JSON.stringify(consumed),
              asOf,
              this.now(),
            )
          : null,
      projectionState: "ready",
      evaluationState: capped ? "partial" : "complete",
      hasMoreUnknown: capped,
      snapshotAt: asOf,
      freshness: taken.length
        ? taken.reduce(
            (oldest, { row }) =>
              row.canonicalFreshness < oldest ? row.canonicalFreshness : oldest,
            taken[0]!.row.canonicalFreshness,
          )
        : null,
      unavailableReason: null,
    };
  }
  /** The single-partition visibility walk, returning rows with their keys. */
  private async collectVisible(
    pk: string,
    initialSk: string | undefined,
    asOf: string,
    limit: number,
    family: "sport" | "league",
  ) {
    const accepted: {
      readonly sk: string;
      readonly row: ReturnType<typeof validateProjection>;
    }[] = [];
    let startSk = initialSk,
      lastPhysicalSk: string | undefined,
      hasPhysicalMore = false,
      evaluated = 0;
    while (accepted.length < limit && evaluated < 200) {
      const result = await this.gateway.queryPage(
        pk,
        startSk,
        Math.min(50, 200 - evaluated),
        { consistentRead: false },
      );
      if (!result.items.length) {
        hasPhysicalMore = false;
        break;
      }
      for (const item of result.items) {
        evaluated++;
        lastPhysicalSk = item.sk;
        const row = validateProjection(item, family, asOf);
        if (
          row.visibleFrom <= asOf &&
          (row.visibleUntil === null || asOf < row.visibleUntil)
        )
          accepted.push({ sk: item.sk, row });
        if (accepted.length === limit) break;
      }
      if (accepted.length === limit) {
        hasPhysicalMore =
          result.lastEvaluatedSk !== undefined ||
          result.items[result.items.length - 1]!.sk !== lastPhysicalSk;
        break;
      }
      hasPhysicalMore = result.lastEvaluatedSk !== undefined;
      if (!result.lastEvaluatedSk) break;
      startSk = result.lastEvaluatedSk;
    }
    return {
      accepted,
      lastPhysicalSk,
      hasPhysicalMore,
      capped: evaluated >= 200 && hasPhysicalMore,
    };
  }
  async detail(
    eventId: string,
  ): Promise<import("./event-repository").EventDetailResult> {
    if (!isCanonicalEntityId(eventId))
      throw new EventInputError("invalid-event-id");
    if (!(await this.ready()))
      return {
        projectionState: "uninitialized",
        item: null,
        unavailableReason: "projection-uninitialized",
      };
    const evaluatedAt = this.now().toISOString();
    const key = { pk: `EVENT_DETAIL#${eventId}`, sk: "CURRENT" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await this.gateway.transactGet([key]);
      if (!first[0])
        return {
          projectionState: "ready",
          item: null,
          unavailableReason: null,
        };
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
      const sport = validateProjection(snapshot[1], "sport", evaluatedAt),
        league = validateProjection(snapshot[2], "league", evaluatedAt);
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
        sport.visibleFrom > evaluatedAt ||
        league.visibleFrom > evaluatedAt ||
        snapshot[1].pk !== pointer.sportPk ||
        snapshot[1].sk !== pointer.sportSk ||
        snapshot[2].pk !== pointer.leaguePk ||
        snapshot[2].sk !== pointer.leagueSk ||
        material(sport) !== material(league)
      )
        throw new EventStorageError("detail-material-mismatch");
      return {
        projectionState: "ready",
        item: toEventDisplayDto(sport, evaluatedAt),
        unavailableReason: null,
      };
    }
    throw new EventStorageError("event-detail-snapshot-unstable");
  }
}
