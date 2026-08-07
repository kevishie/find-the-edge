import { createHash } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  canonicalMvpMarketKeys,
  OPPORTUNITY_RANK_INDEX,
  isOpportunityLifecycleHeadActive,
  normalizeRankedOpportunityProjection,
  opportunityRankPartition,
  toRankedOpportunityDto,
  type EventDisplayDto,
  type OpportunityCandidate,
  type OpportunityLifecycleHead,
  type OpportunityRankingPolicyContract,
  type OpportunityWarningCode,
  type RankedOpportunityDto,
  type RankedOpportunityProjection,
} from "@find-the-edge/domain";
import { EventCursorError, EventInputError } from "../event-errors";
import type { EventCursorCodec, EventRepository } from "../event-repository";
import type { OpportunityCandidateRepository } from "../opportunity-candidate-repository";
import type { OpportunityLifecycleEventEvidenceSource } from "./opportunity-lifecycle-event-evidence";
import type { OpportunityLifecycleRepository } from "./opportunity-lifecycle-repository";

export interface RankedOpportunityFilter {
  readonly sportKey: string;
  readonly marketKey?: string;
  readonly targetSportsbookId?: string;
  readonly competitionKey?: string;
  readonly warningCode?: OpportunityWarningCode;
  readonly kickoffFrom?: string;
  readonly kickoffTo?: string;
  readonly minimumExpectedValue?: number;
  readonly minimumBooks?: number;
  readonly maximumAgeMinutes?: number;
}
export interface RankedOpportunityListInput extends RankedOpportunityFilter {
  readonly limit: number;
  readonly cursor?: string;
}
export interface RankedOpportunityPage {
  readonly schemaVersion: "ranked-opportunity-page-v1";
  readonly rankingPolicy: { readonly id: string; readonly version: string };
  readonly items: readonly RankedOpportunityDto[];
  readonly nextCursor: string | null;
  readonly snapshotAt: string;
  readonly evaluationState: "complete" | "partial";
  readonly hasMoreUnknown: boolean;
  readonly evaluatedCount: number;
  readonly filteredCount: number;
  readonly staleCount: number;
  readonly joinFailureCount: number;
}
export interface RankedOpportunityReconciliationPage {
  readonly discoveredCount: number;
  readonly projectedCount: number;
  readonly inactiveCount: number;
  readonly conflictCount: number;
  readonly failureCount: number;
  readonly nextCursor: string | null;
}
export interface RankedOpportunityRepository {
  list(input: RankedOpportunityListInput): Promise<RankedOpportunityPage>;
  detail(
    sportKey: string,
    opportunityId: string,
  ): Promise<RankedOpportunityDto | null>;
  reconcileActive(input: {
    readonly sportKey: string;
    readonly asOf: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<RankedOpportunityReconciliationPage>;
}

export class RankedOpportunityUnavailableError extends Error {
  override readonly name = "RankedOpportunityUnavailableError";
}

const rankItemKey = (logicalOpportunityId: string) => ({
  pk: `OPPORTUNITY_RANK#${logicalOpportunityId}`,
  sk: "CURRENT",
});
const cursorPhysicalKey = (
  raw: Record<string, unknown>,
): Record<string, unknown> | null =>
  ["pk", "sk", "rankPk", "rankSk"].every(
    (field) => typeof raw[field] === "string",
  )
    ? {
        pk: raw["pk"],
        sk: raw["sk"],
        rankPk: raw["rankPk"],
        rankSk: raw["rankSk"],
      }
    : null;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const binding = (
  policy: OpportunityRankingPolicyContract,
  filter: RankedOpportunityFilter,
) =>
  `OPPORTUNITY#${createHash("sha256")
    .update(
      canonical({ policy: { id: policy.id, version: policy.version }, filter }),
    )
    .digest("hex")}`;
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const iso = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validateFilter = (
  filter: RankedOpportunityFilter,
  policy: OpportunityRankingPolicyContract,
) => {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(filter.sportKey) ||
    (filter.marketKey !== undefined &&
      !canonicalMvpMarketKeys.includes(filter.marketKey as never)) ||
    (filter.targetSportsbookId !== undefined &&
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(filter.targetSportsbookId)) ||
    (filter.competitionKey !== undefined &&
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(filter.competitionKey)) ||
    (filter.kickoffFrom !== undefined && !iso(filter.kickoffFrom)) ||
    (filter.kickoffTo !== undefined && !iso(filter.kickoffTo)) ||
    (filter.kickoffFrom !== undefined &&
      filter.kickoffTo !== undefined &&
      (Date.parse(filter.kickoffFrom) > Date.parse(filter.kickoffTo) ||
        Date.parse(filter.kickoffTo) - Date.parse(filter.kickoffFrom) >
          31 * 24 * 60 * 60 * 1_000)) ||
    (filter.minimumExpectedValue !== undefined &&
      (!Number.isFinite(filter.minimumExpectedValue) ||
        filter.minimumExpectedValue < 0)) ||
    (filter.minimumBooks !== undefined &&
      (!Number.isSafeInteger(filter.minimumBooks) ||
        filter.minimumBooks < 1 ||
        filter.minimumBooks > 100)) ||
    (filter.maximumAgeMinutes !== undefined &&
      (!Number.isFinite(filter.maximumAgeMinutes) ||
        filter.maximumAgeMinutes < 0 ||
        filter.maximumAgeMinutes > policy.maximumFilterAgeMinutes))
  )
    throw new EventInputError("ranked-opportunity-filter-invalid");
};

export class OpportunityCursorCodec {
  constructor(private readonly cursor: EventCursorCodec) {}
  encode(
    policy: OpportunityRankingPolicyContract,
    filter: RankedOpportunityFilter,
    physicalKey: Record<string, unknown>,
    asOf: string,
    now: Date,
  ) {
    return this.cursor.encode(
      binding(policy, filter),
      canonical(physicalKey),
      asOf,
      now,
    );
  }
  decode(
    token: string,
    policy: OpportunityRankingPolicyContract,
    filter: RankedOpportunityFilter,
    now: Date,
  ) {
    const decoded = this.cursor.decode(token, binding(policy, filter), now);
    let key: unknown;
    try {
      key = JSON.parse(decoded.lastSk);
    } catch {
      throw new EventCursorError("invalid-cursor");
    }
    if (
      !record(key) ||
      !exact(key, ["pk", "sk", "rankPk", "rankSk"]) ||
      !Object.values(key).every((value) => typeof value === "string")
    )
      throw new EventCursorError("invalid-cursor");
    return { key, asOf: decoded.asOf };
  }
}

type Joined = {
  readonly projection: RankedOpportunityProjection;
  readonly candidate: OpportunityCandidate;
  readonly head: OpportunityLifecycleHead;
  readonly event: EventDisplayDto;
};

const matches = (dto: RankedOpportunityDto, filter: RankedOpportunityFilter) =>
  (filter.marketKey === undefined || dto.market.key === filter.marketKey) &&
  (filter.targetSportsbookId === undefined ||
    dto.target.sportsbookId === filter.targetSportsbookId) &&
  (filter.competitionKey === undefined ||
    dto.event.competitionKey === filter.competitionKey) &&
  (filter.warningCode === undefined ||
    dto.warningCodes.includes(filter.warningCode)) &&
  (filter.kickoffFrom === undefined ||
    Date.parse(dto.event.startsAt) >= Date.parse(filter.kickoffFrom)) &&
  (filter.kickoffTo === undefined ||
    Date.parse(dto.event.startsAt) <= Date.parse(filter.kickoffTo)) &&
  (filter.minimumExpectedValue === undefined ||
    dto.expectedValue >= filter.minimumExpectedValue) &&
  (filter.minimumBooks === undefined ||
    dto.contributingBooks.length >= filter.minimumBooks) &&
  (filter.maximumAgeMinutes === undefined ||
    dto.liveFreshness.ageMinutes <= filter.maximumAgeMinutes);

export class DynamoRankedOpportunityRepository implements RankedOpportunityRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly policy: OpportunityRankingPolicyContract & {
      readonly maximumPhysicalRows: number;
    },
    private readonly cursors: OpportunityCursorCodec,
    private readonly candidates: OpportunityCandidateRepository,
    private readonly lifecycle: OpportunityLifecycleRepository,
    private readonly events: EventRepository,
    private readonly lifecycleEvents: OpportunityLifecycleEventEvidenceSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async strongProjection(
    raw: Record<string, unknown>,
  ): Promise<RankedOpportunityProjection | null> {
    if (
      !exact(raw, ["pk", "sk", "rankPk", "rankSk"]) ||
      typeof raw["pk"] !== "string" ||
      typeof raw["sk"] !== "string" ||
      typeof raw["rankPk"] !== "string" ||
      typeof raw["rankSk"] !== "string" ||
      raw["sk"] !== "CURRENT"
    )
      return null;
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: raw["pk"], sk: raw["sk"] },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (
      !record(item) ||
      !exact(item, ["pk", "sk", "rankPk", "rankSk", "value"]) ||
      item["pk"] !== raw["pk"] ||
      item["sk"] !== raw["sk"] ||
      item["rankPk"] !== raw["rankPk"] ||
      item["rankSk"] !== raw["rankSk"]
    )
      return null;
    try {
      const projection = normalizeRankedOpportunityProjection(
        item["value"] as RankedOpportunityProjection,
      );
      return projection.rankPartition === raw["rankPk"] &&
        projection.rankKey === raw["rankSk"] &&
        rankItemKey(projection.logicalOpportunityId).pk === raw["pk"]
        ? projection
        : null;
    } catch {
      return null;
    }
  }

  private async join(
    projection: RankedOpportunityProjection,
    currentTime: string,
  ): Promise<Joined | null> {
    const [head, candidate, eventResult] = await Promise.all([
      this.lifecycle.get(projection.logicalOpportunityId),
      this.candidates.get(projection.candidateOccurrenceId),
      this.events.detail(projection.canonicalEventId),
    ]);
    if (eventResult.projectionState !== "ready")
      throw new RankedOpportunityUnavailableError(
        "ranked-opportunity-event-projection-unavailable",
      );
    const event = eventResult.item;
    if (
      !head ||
      !candidate ||
      !event ||
      !isOpportunityLifecycleHeadActive(head, currentTime) ||
      head.stateVersion !== projection.lifecycleStateVersion ||
      head.latestCandidateOccurrenceId !== projection.candidateOccurrenceId ||
      candidate.logicalOpportunityId !== projection.logicalOpportunityId ||
      candidate.status !== "qualified" ||
      event.id !== projection.canonicalEventId ||
      event.version !== projection.canonicalEventVersion ||
      event.sportKey !== projection.sportKey ||
      event.status !== "scheduled"
    )
      return null;
    return { projection, candidate, head, event };
  }

  async list(
    input: RankedOpportunityListInput,
  ): Promise<RankedOpportunityPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw new EventInputError("ranked-opportunity-limit-invalid");
    const filter: RankedOpportunityFilter = {
      sportKey: input.sportKey,
      ...(input.marketKey ? { marketKey: input.marketKey } : {}),
      ...(input.targetSportsbookId
        ? { targetSportsbookId: input.targetSportsbookId }
        : {}),
      ...(input.competitionKey ? { competitionKey: input.competitionKey } : {}),
      ...(input.warningCode ? { warningCode: input.warningCode } : {}),
      ...(input.kickoffFrom ? { kickoffFrom: input.kickoffFrom } : {}),
      ...(input.kickoffTo ? { kickoffTo: input.kickoffTo } : {}),
      ...(input.minimumExpectedValue !== undefined
        ? { minimumExpectedValue: input.minimumExpectedValue }
        : {}),
      ...(input.minimumBooks !== undefined
        ? { minimumBooks: input.minimumBooks }
        : {}),
      ...(input.maximumAgeMinutes !== undefined
        ? { maximumAgeMinutes: input.maximumAgeMinutes }
        : {}),
    };
    validateFilter(filter, this.policy);
    const requestNow = this.now();
    const decoded = input.cursor
      ? this.cursors.decode(input.cursor, this.policy, filter, requestNow)
      : undefined;
    const snapshotAt = decoded?.asOf ?? requestNow.toISOString();
    const rankPk = opportunityRankPartition(this.policy, input.sportKey);
    let cursor = decoded?.key;
    let lastPhysicalKey: Record<string, unknown> | null = null;
    let hasMore = false;
    let evaluatedCount = 0;
    let filteredCount = 0;
    let staleCount = 0;
    let joinFailureCount = 0;
    const items: RankedOpportunityDto[] = [];
    while (
      items.length < input.limit &&
      evaluatedCount < this.policy.maximumPhysicalRows
    ) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: OPPORTUNITY_RANK_INDEX,
          KeyConditionExpression: "rankPk = :rankPk",
          ExpressionAttributeValues: { ":rankPk": rankPk },
          ScanIndexForward: true,
          Limit: Math.min(50, this.policy.maximumPhysicalRows - evaluatedCount),
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      const physical = (result.Items ?? []) as Record<string, unknown>[];
      if (!physical.length) {
        hasMore = false;
        break;
      }
      const evaluated = await Promise.all(
        physical.map(async (raw) => {
          const physicalKey = cursorPhysicalKey(raw);
          const projection = await this.strongProjection(raw);
          if (!projection || projection.scoredAt > snapshotAt)
            return { outcome: "stale" as const, physicalKey };
          try {
            const joined = await this.join(
              projection,
              this.now().toISOString(),
            );
            return joined
              ? { outcome: "joined" as const, physicalKey, joined }
              : { outcome: "stale" as const, physicalKey };
          } catch (error) {
            if (error instanceof RankedOpportunityUnavailableError) throw error;
            return { outcome: "join-failure" as const, physicalKey };
          }
        }),
      );
      for (let index = 0; index < evaluated.length; index += 1) {
        const row = evaluated[index]!;
        evaluatedCount += 1;
        if (row.physicalKey) lastPhysicalKey = row.physicalKey;
        if (row.outcome === "stale") {
          staleCount += 1;
          continue;
        }
        if (row.outcome === "join-failure") {
          joinFailureCount += 1;
          continue;
        }
        let dto: RankedOpportunityDto;
        try {
          dto = toRankedOpportunityDto(
            row.joined.projection,
            row.joined.candidate,
            row.joined.event,
            snapshotAt,
          );
        } catch {
          joinFailureCount += 1;
          continue;
        }
        if (!matches(dto, filter)) {
          filteredCount += 1;
          continue;
        }
        items.push(dto);
        if (items.length === input.limit) {
          hasMore = index + 1 < physical.length || !!result.LastEvaluatedKey;
          break;
        }
      }
      if (items.length === input.limit) break;
      hasMore = !!result.LastEvaluatedKey;
      if (!result.LastEvaluatedKey) break;
      cursor = result.LastEvaluatedKey;
    }
    const capped = evaluatedCount >= this.policy.maximumPhysicalRows && hasMore;
    const incomplete = capped || joinFailureCount > 0;
    return Object.freeze({
      schemaVersion: "ranked-opportunity-page-v1" as const,
      rankingPolicy: Object.freeze({
        id: this.policy.id,
        version: this.policy.version,
      }),
      items: Object.freeze(items),
      nextCursor:
        hasMore && lastPhysicalKey
          ? this.cursors.encode(
              this.policy,
              filter,
              lastPhysicalKey,
              snapshotAt,
              requestNow,
            )
          : null,
      snapshotAt,
      evaluationState: incomplete ? "partial" : "complete",
      hasMoreUnknown: incomplete,
      evaluatedCount,
      filteredCount,
      staleCount,
      joinFailureCount,
    });
  }

  async detail(sportKey: string, opportunityId: string) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sportKey) ||
      !/^opportunity:[a-f0-9]{64}$/.test(opportunityId)
    )
      throw new EventInputError("ranked-opportunity-detail-invalid");
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: rankItemKey(opportunityId),
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (
      !record(item) ||
      !exact(item, ["pk", "sk", "rankPk", "rankSk", "value"]) ||
      item["pk"] !== rankItemKey(opportunityId).pk ||
      item["sk"] !== "CURRENT"
    )
      return null;
    let projection: RankedOpportunityProjection;
    try {
      projection = normalizeRankedOpportunityProjection(
        item["value"] as RankedOpportunityProjection,
      );
    } catch {
      return null;
    }
    if (
      projection.sportKey !== sportKey ||
      projection.logicalOpportunityId !== opportunityId ||
      projection.rankPartition !==
        opportunityRankPartition(this.policy, sportKey) ||
      item["rankPk"] !== projection.rankPartition ||
      item["rankSk"] !== projection.rankKey
    )
      return null;
    const now = this.now().toISOString();
    const joined = await this.join(projection, now);
    return joined
      ? toRankedOpportunityDto(
          joined.projection,
          joined.candidate,
          joined.event,
          now,
        )
      : null;
  }

  async reconcileActive(input: {
    readonly sportKey: string;
    readonly asOf: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<RankedOpportunityReconciliationPage> {
    if (!iso(input.asOf))
      throw new Error("ranked-opportunity-reconciliation-invalid");
    const page = await this.lifecycle.discoverActive(input);
    let projectedCount = 0;
    let inactiveCount = 0;
    let conflictCount = 0;
    let failureCount = page.discoveryFailureCount;
    for (const head of page.items) {
      try {
        const candidate = await this.candidates.get(
          head.latestCandidateOccurrenceId,
        );
        if (
          !candidate ||
          candidate.logicalOpportunityId !== head.logicalOpportunityId
        ) {
          failureCount += 1;
          continue;
        }
        const currentEvent = await this.lifecycleEvents.read(
          head.canonicalEventId,
          input.asOf,
        );
        const outcome = await this.lifecycle.reconcileRankProjection({
          head,
          candidate,
          fence: currentEvent.fence,
          rankingPolicy: this.policy,
        });
        if (outcome === "projected") projectedCount += 1;
        else if (outcome === "inactive") inactiveCount += 1;
        else conflictCount += 1;
      } catch {
        failureCount += 1;
      }
    }
    return {
      discoveredCount: page.items.length,
      projectedCount,
      inactiveCount,
      conflictCount,
      failureCount,
      nextCursor: page.nextCursor,
    };
  }
}

export class MemoryRankedOpportunityRepository implements RankedOpportunityRepository {
  private readonly records = new Map<
    string,
    {
      projection: RankedOpportunityProjection;
      candidate: OpportunityCandidate;
      head: OpportunityLifecycleHead;
      event: EventDisplayDto;
    }
  >();
  constructor(
    private readonly policy: OpportunityRankingPolicyContract,
    private readonly now: () => Date = () => new Date(),
  ) {}
  put(value: {
    projection: RankedOpportunityProjection;
    candidate: OpportunityCandidate;
    head: OpportunityLifecycleHead;
    event: EventDisplayDto;
  }) {
    this.records.set(
      value.projection.logicalOpportunityId,
      structuredClone(value),
    );
  }
  remove(opportunityId: string) {
    this.records.delete(opportunityId);
  }
  list(input: RankedOpportunityListInput): Promise<RankedOpportunityPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw new EventInputError("ranked-opportunity-limit-invalid");
    validateFilter(input, this.policy);
    const snapshotAt = this.now().toISOString();
    const all = [...this.records.values()]
      .filter(({ projection }) => projection.sportKey === input.sportKey)
      .sort((left, right) =>
        left.projection.rankKey.localeCompare(right.projection.rankKey),
      );
    const start = input.cursor
      ? (() => {
          const found = all.findIndex(
            ({ projection }) => projection.rankKey > input.cursor!,
          );
          return found < 0 ? all.length : found;
        })()
      : 0;
    const accepted: RankedOpportunityDto[] = [];
    let evaluated = 0;
    let filtered = 0;
    let lastPhysicalRankKey: string | undefined;
    for (const value of all.slice(start)) {
      if (evaluated >= 200 || accepted.length >= input.limit) break;
      evaluated += 1;
      lastPhysicalRankKey = value.projection.rankKey;
      if (!isOpportunityLifecycleHeadActive(value.head, snapshotAt)) continue;
      const dto = toRankedOpportunityDto(
        value.projection,
        value.candidate,
        value.event,
        snapshotAt,
      );
      if (!matches(dto, input)) {
        filtered += 1;
        continue;
      }
      accepted.push(dto);
    }
    const capped = evaluated >= 200 && all.length > start + evaluated;
    return Promise.resolve({
      schemaVersion: "ranked-opportunity-page-v1",
      rankingPolicy: { id: this.policy.id, version: this.policy.version },
      items: accepted,
      nextCursor:
        lastPhysicalRankKey && all.length > start + evaluated
          ? lastPhysicalRankKey
          : null,
      snapshotAt,
      evaluationState: capped ? "partial" : "complete",
      hasMoreUnknown: capped,
      evaluatedCount: evaluated,
      filteredCount: filtered,
      staleCount: 0,
      joinFailureCount: 0,
    });
  }
  detail(sportKey: string, opportunityId: string) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sportKey) ||
      !/^opportunity:[a-f0-9]{64}$/.test(opportunityId)
    )
      throw new EventInputError("ranked-opportunity-detail-invalid");
    const value = this.records.get(opportunityId);
    const now = this.now().toISOString();
    if (
      !value ||
      value.projection.sportKey !== sportKey ||
      !isOpportunityLifecycleHeadActive(value.head, now)
    )
      return Promise.resolve(null);
    return Promise.resolve(
      toRankedOpportunityDto(
        value.projection,
        value.candidate,
        value.event,
        now,
      ),
    );
  }
  reconcileActive(): Promise<RankedOpportunityReconciliationPage> {
    return Promise.resolve({
      discoveredCount: 0,
      projectedCount: 0,
      inactiveCount: 0,
      conflictCount: 0,
      failureCount: 0,
      nextCursor: null,
    });
  }
}
