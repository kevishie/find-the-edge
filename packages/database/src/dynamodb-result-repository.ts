import {
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type {
  CompletedEventResultObservation,
  UnresolvedResultObservation,
} from "@find-the-edge/domain";
import {
  compareResultAuthority,
  compareProviderAuthorityTuple,
  normalizeCompletedResult,
  normalizeUnresolvedResult,
  resultPageCursor,
  resultAuthoritySortKey,
  stableResultValue,
  stableResolvedReplay,
  validateResultPageRequest,
  ResultReplayConflictError,
  type ResultPage,
  type ResultPersistOutcome,
  type ResultRepository,
  type ResultRunRecord,
} from "./result-repository";
const pk = (id: string) => `RESULT#${id}`;
const conditional = (e: unknown) =>
  e instanceof Error && e.name === "ConditionalCheckFailedException";
const stableObservation = (value: { readonly retrievedAt: string }) => {
  const material: Record<string, unknown> = { ...value };
  delete material["retrievedAt"];
  return stableResultValue(material);
};
export class DynamoResultRepository implements ResultRepository {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}
  async persist(
    input: Omit<CompletedEventResultObservation, "id"> & {
      readonly id?: string;
    },
  ): Promise<ResultPersistOutcome> {
    const o = normalizeCompletedResult(input),
      key = { pk: pk(o.canonicalEventId), sk: "CURRENT" },
      currentFound = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }),
      ),
      current = currentFound.Item?.["value"] as
        CompletedEventResultObservation | undefined,
      historyKey = {
        pk: pk(o.canonicalEventId),
        sk: `HISTORY#${resultAuthoritySortKey(o)}`,
      };
    if (
      current &&
      compareProviderAuthorityTuple(o, current) === 0 &&
      current.id !== o.id
    )
      throw new ResultReplayConflictError("result-authority-conflict");
    let history: "inserted" | "duplicate" = "inserted";
    let observation = o;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...historyKey, value: o },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (e) {
      if (!conditional(e)) throw e;
      const found = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: historyKey,
          ConsistentRead: true,
        }),
      );
      const existing = found.Item?.["value"] as
        CompletedEventResultObservation | undefined;
      if (
        !existing ||
        stableResolvedReplay(existing) !== stableResolvedReplay(o)
      )
        throw new ResultReplayConflictError("result-replay-conflict");
      history = "duplicate";
      observation = existing;
    }
    const exactKey = {
      pk: `RESULT_EXACT#${observation.canonicalEventId}`,
      sk: observation.id,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...exactKey, value: observation },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (e) {
      if (!conditional(e)) throw e;
      const found = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: exactKey,
          ConsistentRead: true,
        }),
      );
      const existing = found.Item?.["value"] as
        CompletedEventResultObservation | undefined;
      if (
        !existing ||
        stableResolvedReplay(existing) !== stableResolvedReplay(observation)
      )
        throw new ResultReplayConflictError("result-exact-index-conflict");
      observation = existing;
    }
    if (current && compareResultAuthority(observation, current) <= 0)
      return { history, current: "stale", observation };
    try {
      const written = await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...key,
            value: observation,
            authorityRank: o.providerRevision.authorityRank,
            authorityUpdatedAt: o.providerRevision.updatedAt,
            authoritySequence: o.providerRevision.sequence,
            authorityToken: o.providerRevision.token,
            authorityTimestamp: o.providerTimestamp,
            authorityId: o.id,
          },
          ConditionExpression:
            "attribute_not_exists(pk) OR authorityRank < :rank OR (authorityRank = :rank AND authorityUpdatedAt < :updated) OR (authorityRank = :rank AND authorityUpdatedAt = :updated AND authoritySequence < :sequence) OR (authorityRank = :rank AND authorityUpdatedAt = :updated AND authoritySequence = :sequence AND authorityToken < :token) OR (authorityRank = :rank AND authorityUpdatedAt = :updated AND authoritySequence = :sequence AND authorityToken = :token AND authorityTimestamp < :timestamp)",
          ExpressionAttributeValues: {
            ":rank": o.providerRevision.authorityRank,
            ":updated": o.providerRevision.updatedAt,
            ":sequence": o.providerRevision.sequence,
            ":token": o.providerRevision.token,
            ":timestamp": o.providerTimestamp,
          },
          ReturnValues: "ALL_OLD",
        }),
      );
      const replaced = written.Attributes?.["value"] as
        CompletedEventResultObservation | undefined;
      return {
        history,
        current: replaced ? "corrected" : "finalized",
        observation: o,
      };
    } catch (e) {
      if (!conditional(e)) throw e;
      const reread = await this.current(o.canonicalEventId);
      if (reread?.id === o.id)
        return {
          history,
          current: current ? "corrected" : "finalized",
          observation,
        };
      if (
        reread &&
        compareProviderAuthorityTuple(reread, observation) === 0 &&
        reread.id !== observation.id
      )
        throw new ResultReplayConflictError("result-authority-conflict");
      return { history, current: "stale", observation };
    }
  }
  async current(eventId: string) {
    const v = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: pk(eventId), sk: "CURRENT" },
        ConsistentRead: true,
      }),
    );
    return (
      (v.Item?.["value"] as CompletedEventResultObservation | undefined) ?? null
    );
  }
  async exact(eventId: string, resultObservationId: string) {
    if (!/^result:[a-f0-9]{64}$/.test(resultObservationId))
      throw new ResultReplayConflictError("result-id-invalid");
    const found = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `RESULT_EXACT#${eventId}`,
          sk: resultObservationId,
        },
        ConsistentRead: true,
      }),
    );
    const value = found.Item?.["value"] as
      CompletedEventResultObservation | undefined;
    if (!value) return null;
    const normalized = normalizeCompletedResult(value);
    if (
      normalized.id !== resultObservationId ||
      normalized.canonicalEventId !== eventId
    )
      throw new ResultReplayConflictError("result-exact-index-conflict");
    return normalized;
  }
  async historyPage(
    eventId: string,
    limit: number,
    next?: string,
  ): Promise<ResultPage<CompletedEventResultObservation>> {
    const decoded = validateResultPageRequest(limit, "history", eventId, next);
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": pk(eventId),
          ":prefix": "HISTORY#",
        },
        Limit: limit,
        ...(decoded
          ? { ExclusiveStartKey: { pk: pk(eventId), sk: decoded } }
          : {}),
        ConsistentRead: true,
      }),
    );
    const nextCursor =
      typeof r.LastEvaluatedKey?.["sk"] === "string"
        ? resultPageCursor("history", eventId, r.LastEvaluatedKey["sk"])
        : undefined;
    return {
      items: (r.Items ?? [])
        .map((i) => i["value"] as CompletedEventResultObservation)
        .sort(compareResultAuthority),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
  async persistUnresolved(
    input: Omit<UnresolvedResultObservation, "id"> & { readonly id?: string },
  ) {
    const v = normalizeUnresolvedResult(input),
      key = { pk: `UNRESOLVED_RESULT#${v.providerId}`, sk: `ITEM#${v.id}` };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, value: v },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (e) {
      if (!conditional(e)) throw e;
      const found = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      const existing = found.Item?.["value"] as
        UnresolvedResultObservation | undefined;
      if (!existing || stableObservation(existing) !== stableObservation(v))
        throw new ResultReplayConflictError(
          "unresolved-result-replay-conflict",
        );
      return existing;
    }
    return v;
  }
  async unresolvedPage(
    providerId: string,
    limit: number,
    next?: string,
  ): Promise<ResultPage<UnresolvedResultObservation>> {
    const decoded = validateResultPageRequest(
      limit,
      "unresolved",
      providerId,
      next,
    );
    const p = `UNRESOLVED_RESULT#${providerId}`,
      r = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": p, ":prefix": "ITEM#" },
          Limit: limit,
          ...(decoded ? { ExclusiveStartKey: { pk: p, sk: decoded } } : {}),
        }),
      );
    const nextCursor =
      typeof r.LastEvaluatedKey?.["sk"] === "string"
        ? resultPageCursor("unresolved", providerId, r.LastEvaluatedKey["sk"])
        : undefined;
    return {
      items: (r.Items ?? []).map(
        (i) => i["value"] as UnresolvedResultObservation,
      ),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
  async checkpoint(key: string) {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `RESULT_CHECKPOINT#${key}`, sk: "CURRENT" },
        ConsistentRead: true,
      }),
    );
    return r.Item?.["cursor"] as string | undefined;
  }
  async saveCheckpoint(key: string, value?: string) {
    const k = { pk: `RESULT_CHECKPOINT#${key}`, sk: "CURRENT" };
    if (value === undefined) {
      await this.client.send(
        new DeleteCommand({ TableName: this.tableName, Key: k }),
      );
      return;
    }
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...k, cursor: value },
      }),
    );
  }
  async saveRun(run: ResultRunRecord) {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `RESULT_RUN#${run.sportKey}#${run.leagueKey}`,
          sk: `${run.updatedAt}#${run.id}`,
          value: run,
        },
      }),
    );
  }
}
