import type {
  NormalizedFixtureOddsSnapshot,
  OddsHistoryObservationDto,
  OddsHistoryPageDto,
  OddsHistorySeriesDto,
} from "@find-the-edge/domain";
import { FixtureOddsStateCorruptionError } from "@find-the-edge/domain";
import { EventCursorError } from "./event-errors";
import { EventCursorCodec } from "./event-repository";
import { isCanonicalEntityId } from "./event-read-projection";
import { validateFixtureOddsSnapshotItem } from "./fixture-odds-adapter";

const MAIN_MARKETS = new Set(["moneyline", "spread", "total"]);
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;
export const ODDS_HISTORY_MAX_PAGE_SIZE = 200;

export type OddsHistoryPoint = OddsHistoryObservationDto;
export type OddsHistorySeries = OddsHistorySeriesDto;
export type OddsHistoryPage = OddsHistoryPageDto;

export interface OddsHistoryQuery {
  readonly eventId: string;
  readonly canonicalEventVersion: number;
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly marketKey?: string;
  readonly selectionKey?: string;
  readonly sportsbookIds?: readonly string[];
}

export interface OddsHistoryRepository {
  validateSportsbookIds(sportsbookIds?: readonly string[]): void;
  list(query: OddsHistoryQuery): Promise<OddsHistoryPage>;
}

export type OddsHistoryProbabilityProjector = (americanOdds: number) => number;

export interface OddsHistoryStoredRow {
  readonly pk: string;
  readonly sk: string;
  readonly value: unknown;
}

export interface OddsHistoryReadGateway {
  query(input: {
    readonly pk: string;
    readonly fromSk: string;
    readonly toSk: string;
    readonly startSk?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly OddsHistoryStoredRow[];
    readonly hasMore: boolean;
  }>;
}

export class OddsHistoryInputError extends Error {
  override readonly name = "OddsHistoryInputError";
}

export class OddsHistoryStorageError extends Error {
  override readonly name = "OddsHistoryStorageError";
}

export const oddsHistoryPartition = (eventId: string) =>
  `ODDS_HISTORY#${eventId}`;

const canonicalTimestamp = (value: string) => {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};

const validMarketOrBook = (value: string) =>
  /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
const validSelection = (value: string) =>
  value.length <= 128 &&
  /^[A-Za-z0-9._:-](?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*$/.test(value);

const validated = (query: OddsHistoryQuery) => {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (
    !isCanonicalEntityId(query.eventId) ||
    !Number.isSafeInteger(query.canonicalEventVersion) ||
    query.canonicalEventVersion < 1 ||
    (query.marketKey !== undefined && !MAIN_MARKETS.has(query.marketKey)) ||
    !canonicalTimestamp(query.from) ||
    !canonicalTimestamp(query.to) ||
    from > to ||
    to - from > MAX_RANGE_MS ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > ODDS_HISTORY_MAX_PAGE_SIZE ||
    (query.marketKey !== undefined && !validMarketOrBook(query.marketKey)) ||
    (query.selectionKey !== undefined && !validSelection(query.selectionKey)) ||
    (query.sportsbookIds !== undefined &&
      (query.sportsbookIds.length < 1 ||
        query.sportsbookIds.length > 64 ||
        new Set(query.sportsbookIds).size !== query.sportsbookIds.length ||
        query.sportsbookIds.some((id) => !validMarketOrBook(id)))) ||
    (query.cursor !== undefined &&
      (query.cursor.length < 1 || query.cursor.length > 4096))
  )
    throw new OddsHistoryInputError("odds-history-query-invalid");
  return query;
};

const cursorScope = (query: OddsHistoryQuery) =>
  JSON.stringify([
    oddsHistoryPartition(query.eventId),
    query.from,
    query.to,
    query.marketKey ?? null,
    query.selectionKey ?? null,
    query.sportsbookIds ? [...query.sportsbookIds].sort() : null,
  ]);

const rowSnapshot = (
  row: OddsHistoryStoredRow,
  expectedPk: string,
  expectedEventId: string,
): NormalizedFixtureOddsSnapshot => {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Reflect.getPrototypeOf(row) !== Object.prototype ||
    Object.keys(row).sort().join("|") !== "pk|sk|value" ||
    row.pk !== expectedPk ||
    !row.sk.startsWith("SNAPSHOT#") ||
    !row.value ||
    typeof row.value !== "object" ||
    Array.isArray(row.value)
  )
    throw new OddsHistoryStorageError("odds-history-row-invalid");
  const value = row.value as NormalizedFixtureOddsSnapshot;
  try {
    const snapshot = validateFixtureOddsSnapshotItem(
      { pk: value.partitionKey, sk: row.sk, value },
      value.partitionKey,
      row.sk,
    );
    if (!snapshot || snapshot.canonicalEventId !== expectedEventId)
      throw new Error("event-mismatch");
    return snapshot;
  } catch (error) {
    if (error instanceof OddsHistoryStorageError) throw error;
    throw new OddsHistoryStorageError("odds-history-snapshot-invalid", {
      cause: error,
    });
  }
};

const seriesKey = (snapshot: NormalizedFixtureOddsSnapshot) =>
  JSON.stringify([
    snapshot.marketKey,
    snapshot.selectionKey,
    snapshot.sportsbookId,
  ]);

export class JoinedOddsHistoryRepository implements OddsHistoryRepository {
  constructor(
    readonly gateway: OddsHistoryReadGateway,
    readonly cursor: EventCursorCodec,
    readonly approvedSportsbooks: Readonly<Record<string, string>>,
    readonly projectImpliedProbability: OddsHistoryProbabilityProjector,
    readonly now: () => Date = () => new Date(),
  ) {
    if (
      !Object.keys(approvedSportsbooks).length ||
      Object.entries(approvedSportsbooks).some(
        ([id, label]) => !id || !label || id === "consensus",
      )
    )
      throw new OddsHistoryInputError("approved-sportsbook-roster-invalid");
  }

  validateSportsbookIds(sportsbookIds?: readonly string[]): void {
    if (
      sportsbookIds?.some(
        (sportsbookId) =>
          !Object.hasOwn(this.approvedSportsbooks, sportsbookId),
      )
    )
      throw new OddsHistoryInputError("odds-history-sportsbook-invalid");
  }

  async list(rawQuery: OddsHistoryQuery): Promise<OddsHistoryPage> {
    const query = validated(rawQuery);
    this.validateSportsbookIds(query.sportsbookIds);
    const pk = oddsHistoryPartition(query.eventId);
    const requestNow = this.now();
    let paginationAsOf = requestNow.toISOString();
    let startSk: string | undefined;
    if (query.cursor)
      try {
        const decoded = this.cursor.decode(
          query.cursor,
          cursorScope(query),
          requestNow,
        );
        startSk = decoded.lastSk;
        paginationAsOf = decoded.asOf;
      } catch (error) {
        if (error instanceof EventCursorError)
          throw new OddsHistoryInputError("odds-history-cursor-invalid");
        throw error;
      }
    let result;
    try {
      result = await this.gateway.query({
        pk,
        fromSk: `SNAPSHOT#${query.from}`,
        toSk: `SNAPSHOT#${query.to}#\uffff`,
        ...(startSk ? { startSk } : {}),
        limit: query.limit + 1,
      });
    } catch (error) {
      if (error instanceof OddsHistoryInputError) throw error;
      throw new OddsHistoryStorageError("odds-history-read-failed", {
        cause: error,
      });
    }
    if (result.items.length > query.limit + 1)
      throw new OddsHistoryStorageError("odds-history-page-oversized");
    const consumedRows = result.items.slice(0, query.limit);
    const snapshots = consumedRows
      .map((row) => rowSnapshot(row, pk, query.eventId))
      .filter((snapshot) => snapshot.retrievedAt <= paginationAsOf);
    for (let index = 1; index < consumedRows.length; index++)
      if (consumedRows[index - 1]!.sk >= consumedRows[index]!.sk)
        throw new OddsHistoryStorageError("odds-history-order-invalid");
    const bySeries = new Map<string, OddsHistorySeries>();
    const newestLabelEvidence = new Map<string, string>();
    const seenEvidence = new Set<string>();
    for (const snapshot of snapshots) {
      const sportsbookLabel = this.approvedSportsbooks[snapshot.sportsbookId];
      if (
        !sportsbookLabel ||
        snapshot.provenance?.providerId !== "sharpapi" ||
        !MAIN_MARKETS.has(snapshot.marketKey) ||
        (query.marketKey !== undefined &&
          snapshot.marketKey !== query.marketKey) ||
        (query.selectionKey !== undefined &&
          snapshot.selectionKey !== query.selectionKey) ||
        (query.sportsbookIds !== undefined &&
          !query.sportsbookIds.includes(snapshot.sportsbookId))
      )
        continue;
      const requiresPoint =
        snapshot.marketKey === "spread" || snapshot.marketKey === "total";
      if (requiresPoint !== (snapshot.point !== undefined))
        throw new OddsHistoryStorageError("odds-history-point-invalid");
      const evidenceIdentity = JSON.stringify([
        snapshot.marketKey,
        snapshot.selectionKey,
        snapshot.sportsbookId,
        snapshot.point ?? null,
        snapshot.americanOdds,
        snapshot.observedAt,
        snapshot.retrievedAt,
        snapshot.provenance.providerId,
        snapshot.provenance.policyVersion,
        snapshot.provenance.bookRole,
        snapshot.provenance.sourceState,
      ]);
      if (seenEvidence.has(evidenceIdentity)) continue;
      seenEvidence.add(evidenceIdentity);
      const key = seriesKey(snapshot);
      const point: OddsHistoryPoint = {
        observationId: snapshot.snapshotId,
        state:
          snapshot.provenance?.sourceState === "suspended"
            ? "suspended"
            : snapshot.provenance.sourceState === "active"
              ? "active"
              : "unavailable",
        ...(snapshot.point === undefined ? {} : { point: snapshot.point }),
        americanOdds: snapshot.americanOdds,
        impliedProbability: this.projectImpliedProbability(
          snapshot.americanOdds,
        ),
        observedAt: snapshot.observedAt,
        retrievedAt: snapshot.retrievedAt,
        isOpening: false,
        isCurrent: false,
      };
      const existing = bySeries.get(key);
      const labelEvidence = `${snapshot.observedAt}|${snapshot.retrievedAt}|${snapshot.snapshotId}`;
      const useLabel =
        !newestLabelEvidence.has(key) ||
        labelEvidence >= newestLabelEvidence.get(key)!;
      if (useLabel) newestLabelEvidence.set(key, labelEvidence);
      if (existing)
        bySeries.set(key, {
          ...existing,
          selectionLabel: useLabel
            ? (snapshot.selectionLabel ?? snapshot.selectionKey)
            : existing.selectionLabel,
          points: [...existing.points, point],
        });
      else
        bySeries.set(key, {
          marketKey: snapshot.marketKey,
          selectionKey: snapshot.selectionKey,
          selectionLabel: snapshot.selectionLabel ?? snapshot.selectionKey,
          sportsbookId: snapshot.sportsbookId,
          sportsbookLabel,
          points: [point],
        });
    }
    const hasMore = result.hasMore || result.items.length > query.limit;
    const last = consumedRows.at(-1);
    const generatedAt = paginationAsOf;
    const series = [...bySeries.values()]
      .map((item) => {
        const points = [...item.points].sort(
          (left, right) =>
            left.observedAt.localeCompare(right.observedAt) ||
            left.retrievedAt.localeCompare(right.retrievedAt) ||
            left.observationId.localeCompare(right.observationId),
        );
        const activeIndexes = points.flatMap((point, index) =>
          point.state === "active" ? [index] : [],
        );
        const openingIndex = activeIndexes[0];
        const currentIndex = activeIndexes.at(-1);
        return {
          ...item,
          points: points.map((point, index) => ({
            ...point,
            isOpening: index === openingIndex,
            isCurrent: index === currentIndex,
          })),
        };
      })
      .sort(
        (left, right) =>
          left.marketKey.localeCompare(right.marketKey) ||
          left.selectionKey.localeCompare(right.selectionKey) ||
          left.sportsbookId.localeCompare(right.sportsbookId),
      );
    const requestedSportsbooks = query.sportsbookIds
      ? query.sportsbookIds.map(
          (sportsbookId) =>
            [sportsbookId, this.approvedSportsbooks[sportsbookId]!] as const,
        )
      : Object.entries(this.approvedSportsbooks);
    const observedSportsbooks = new Set(
      series.map(({ sportsbookId }) => sportsbookId),
    );
    return {
      eventId: query.eventId,
      generatedAt,
      markerScope: "page",
      series,
      coverage: requestedSportsbooks.map(([sportsbookId, sportsbookLabel]) => ({
        sportsbookId,
        sportsbookLabel,
        status: observedSportsbooks.has(sportsbookId)
          ? "available"
          : "unavailable",
      })),
      nextCursor:
        hasMore && last
          ? this.cursor.encode(
              cursorScope(query),
              last.sk,
              generatedAt,
              requestNow,
            )
          : null,
    };
  }
}

export class MemoryOddsHistoryRepository extends JoinedOddsHistoryRepository {
  constructor(
    snapshots: readonly NormalizedFixtureOddsSnapshot[],
    cursor: EventCursorCodec,
    approvedSportsbooks: Readonly<Record<string, string>>,
    projectImpliedProbability: OddsHistoryProbabilityProjector,
    now: () => Date = () => new Date(),
  ) {
    const rows = new Map<string, OddsHistoryStoredRow>();
    for (const snapshot of snapshots) {
      const pk = oddsHistoryPartition(snapshot.canonicalEventId);
      const identity = `${pk}|${snapshot.sortKey}`;
      const row = { pk, sk: snapshot.sortKey, value: snapshot };
      const existing = rows.get(identity);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row))
        throw new FixtureOddsStateCorruptionError(
          "odds-history-index-conflict",
        );
      rows.set(identity, row);
    }
    super(
      {
        query: async (input) => {
          await Promise.resolve();
          const matching = [...rows.values()]
            .filter(
              (row) =>
                row.pk === input.pk &&
                row.sk >= input.fromSk &&
                row.sk <= input.toSk &&
                (!input.startSk || row.sk > input.startSk),
            )
            .sort((left, right) => left.sk.localeCompare(right.sk));
          return {
            items: matching.slice(0, input.limit),
            hasMore: matching.length > input.limit,
          };
        },
      },
      cursor,
      approvedSportsbooks,
      projectImpliedProbability,
      now,
    );
  }
}
