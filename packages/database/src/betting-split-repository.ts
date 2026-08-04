import { createHash } from "node:crypto";
import type { BettingSplitObservation } from "@find-the-edge/domain";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

export class BettingSplitValidationError extends Error {
  override readonly name = "BettingSplitValidationError";
}
export class BettingSplitReplayConflictError extends Error {
  override readonly name = "BettingSplitReplayConflictError";
}

const canonical = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim();
const iso = (value: unknown): value is string =>
  canonical(value, 40) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function normalizeBettingSplitObservation(
  input: Omit<BettingSplitObservation, "id"> & { readonly id?: string },
): BettingSplitObservation {
  for (const value of [
    input.providerId,
    input.providerEventId,
    input.canonicalEventId,
    input.sportKey,
    input.leagueKey,
    input.marketKey,
    input.selectionKey,
  ])
    if (!canonical(value))
      throw new BettingSplitValidationError("betting-split-identity-invalid");
  if (
    !Number.isSafeInteger(input.canonicalEventVersion) ||
    input.canonicalEventVersion < 1
  )
    throw new BettingSplitValidationError("betting-split-version-invalid");
  if (!iso(input.providerTimestamp) || !iso(input.retrievedAt))
    throw new BettingSplitValidationError("betting-split-timestamp-invalid");
  if (Date.parse(input.providerTimestamp) > Date.parse(input.retrievedAt))
    throw new BettingSplitValidationError("betting-split-time-order-invalid");
  if (input.betPercent === undefined && input.moneyPercent === undefined)
    throw new BettingSplitValidationError("betting-split-percentages-missing");
  for (const value of [input.betPercent, input.moneyPercent])
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value < 0 || value > 100)
    )
      throw new BettingSplitValidationError("betting-split-percentage-invalid");
  if (input.point !== undefined && !Number.isFinite(input.point))
    throw new BettingSplitValidationError("betting-split-point-invalid");
  for (const value of [input.betCount, input.moneyAmount])
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new BettingSplitValidationError("betting-split-sample-invalid");
  if (input.scope !== undefined && !canonical(input.scope))
    throw new BettingSplitValidationError("betting-split-scope-invalid");
  const material = JSON.stringify([
    input.providerId,
    input.providerEventId,
    input.canonicalEventId,
    input.canonicalEventVersion,
    input.sportKey,
    input.leagueKey,
    input.marketKey,
    input.selectionKey,
    input.point ?? null,
    input.betPercent ?? null,
    input.moneyPercent ?? null,
    input.betCount ?? null,
    input.moneyAmount ?? null,
    input.providerTimestamp,
    input.scope ?? null,
  ]);
  const id = `split:${createHash("sha256").update(material).digest("hex")}`;
  if (input.id !== undefined && input.id !== id)
    throw new BettingSplitValidationError("betting-split-id-invalid");
  return { ...input, id };
}

export interface BettingSplitPersistResult {
  readonly history: "inserted" | "duplicate";
  readonly current: "advanced" | "retained";
  readonly observation: BettingSplitObservation;
}
export interface BettingSplitRepository {
  persist(
    input: Omit<BettingSplitObservation, "id"> & { readonly id?: string },
  ): Promise<BettingSplitPersistResult>;
  current(key: {
    providerId: string;
    canonicalEventId: string;
    canonicalEventVersion: number;
    marketKey: string;
    selectionKey: string;
    point?: number;
    scope?: string;
  }): Promise<BettingSplitObservation | null>;
  listCurrent(
    canonicalEventId: string,
    canonicalEventVersion?: number,
  ): Promise<readonly BettingSplitObservation[]>;
  persistGap(input: {
    providerId: string;
    providerEventId: string;
    sportKey: string;
    leagueKey: string;
    reason: string;
    retrievedAt: string;
  }): Promise<void>;
}

const currentKey = (value: BettingSplitObservation) =>
  JSON.stringify([
    value.providerId,
    value.canonicalEventId,
    value.canonicalEventVersion,
    value.marketKey,
    value.selectionKey,
    value.point ?? null,
    value.scope ?? null,
  ]);
const authority = (value: BettingSplitObservation) =>
  `${value.providerTimestamp}\u0000${value.retrievedAt}\u0000${value.id}`;
const logicalCurrentKey = (value: BettingSplitObservation) =>
  JSON.stringify([
    value.providerId,
    value.marketKey,
    value.selectionKey,
    value.point ?? null,
    value.scope ?? null,
  ]);
const latestLogicalCurrent = (
  values: readonly BettingSplitObservation[],
  canonicalEventVersion?: number,
) => {
  const latest = new Map<string, BettingSplitObservation>();
  for (const value of values) {
    if (
      canonicalEventVersion !== undefined &&
      value.canonicalEventVersion !== canonicalEventVersion
    )
      continue;
    const key = logicalCurrentKey(value);
    const existing = latest.get(key);
    if (!existing || authority(value) > authority(existing))
      latest.set(key, value);
  }
  return [...latest.values()].sort((left, right) =>
    logicalCurrentKey(left).localeCompare(logicalCurrentKey(right)),
  );
};
const replayValue = (value: BettingSplitObservation) => {
  const { retrievedAt, ...stable } = value;
  void retrievedAt;
  return JSON.stringify(stable);
};

export class MemoryBettingSplitRepository implements BettingSplitRepository {
  readonly #history = new Map<string, BettingSplitObservation>();
  readonly #current = new Map<string, BettingSplitObservation>();
  readonly gaps: unknown[] = [];
  persist(
    input: Omit<BettingSplitObservation, "id"> & { readonly id?: string },
  ) {
    const observation = normalizeBettingSplitObservation(input);
    const existing = this.#history.get(observation.id);
    if (existing && replayValue(existing) !== replayValue(observation))
      throw new BettingSplitReplayConflictError(
        "betting-split-replay-conflict",
      );
    const key = currentKey(observation);
    const current = this.#current.get(key);
    const advance =
      !existing && (!current || authority(observation) > authority(current));
    if (!existing)
      this.#history.set(observation.id, structuredClone(observation));
    if (advance) this.#current.set(key, structuredClone(observation));
    return Promise.resolve({
      history: existing ? ("duplicate" as const) : ("inserted" as const),
      current: advance ? ("advanced" as const) : ("retained" as const),
      observation: structuredClone(observation),
    });
  }
  current(key: {
    providerId: string;
    canonicalEventId: string;
    canonicalEventVersion: number;
    marketKey: string;
    selectionKey: string;
    point?: number;
    scope?: string;
  }) {
    const value = this.#current.get(
      JSON.stringify([
        key.providerId,
        key.canonicalEventId,
        key.canonicalEventVersion,
        key.marketKey,
        key.selectionKey,
        key.point ?? null,
        key.scope ?? null,
      ]),
    );
    return Promise.resolve(value ? structuredClone(value) : null);
  }
  listCurrent(canonicalEventId: string, canonicalEventVersion?: number) {
    return Promise.resolve(
      latestLogicalCurrent(
        [...this.#current.values()].filter(
          (value) => value.canonicalEventId === canonicalEventId,
        ),
        canonicalEventVersion,
      ).map((value) => structuredClone(value)),
    );
  }
  persistGap(input: Parameters<BettingSplitRepository["persistGap"]>[0]) {
    this.gaps.push(structuredClone(input));
    return Promise.resolve();
  }
}

const splitPk = (canonicalEventId: string) =>
  `BETTING_SPLIT#${canonicalEventId}`;
const splitCurrentSk = (value: BettingSplitObservation) =>
  `CURRENT#${value.providerId}#V${value.canonicalEventVersion}#${value.marketKey}#${value.selectionKey}#${value.point ?? "none"}#${value.scope ?? "none"}`;
const splitHistorySk = (value: BettingSplitObservation) =>
  `HISTORY#${value.providerTimestamp}#${value.id}`;

export class DynamoBettingSplitRepository implements BettingSplitRepository {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}

  async persist(
    input: Omit<BettingSplitObservation, "id"> & { readonly id?: string },
  ) {
    const observation = normalizeBettingSplitObservation(input);
    const pk = splitPk(observation.canonicalEventId);
    const historySk = splitHistorySk(observation);
    let currentObservation = observation;
    let history: BettingSplitPersistResult["history"] = "inserted";
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk, sk: historySk, value: observation },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
      const existing = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: historySk },
          ConsistentRead: true,
        }),
      );
      if (
        !existing.Item?.["value"] ||
        replayValue(existing.Item["value"] as BettingSplitObservation) !==
          replayValue(observation)
      )
        throw new BettingSplitReplayConflictError(
          "betting-split-replay-conflict",
        );
      currentObservation = normalizeBettingSplitObservation(
        existing.Item["value"] as BettingSplitObservation,
      );
      history = "duplicate";
    }
    let current: BettingSplitPersistResult["current"] = "advanced";
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk,
            sk: splitCurrentSk(currentObservation),
            value: currentObservation,
          },
          ConditionExpression:
            "attribute_not_exists(pk) OR #value.#providerTimestamp < :providerTimestamp OR (#value.#providerTimestamp = :providerTimestamp AND #value.#retrievedAt < :retrievedAt) OR (#value.#providerTimestamp = :providerTimestamp AND #value.#retrievedAt = :retrievedAt AND #value.#id < :id)",
          ExpressionAttributeNames: {
            "#value": "value",
            "#providerTimestamp": "providerTimestamp",
            "#retrievedAt": "retrievedAt",
            "#id": "id",
          },
          ExpressionAttributeValues: {
            ":providerTimestamp": currentObservation.providerTimestamp,
            ":retrievedAt": currentObservation.retrievedAt,
            ":id": currentObservation.id,
          },
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
      current = "retained";
    }
    return { history, current, observation };
  }

  async current(key: {
    providerId: string;
    canonicalEventId: string;
    canonicalEventVersion: number;
    marketKey: string;
    selectionKey: string;
    point?: number;
    scope?: string;
  }) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: splitPk(key.canonicalEventId),
          sk: `CURRENT#${key.providerId}#V${key.canonicalEventVersion}#${key.marketKey}#${key.selectionKey}#${key.point ?? "none"}#${key.scope ?? "none"}`,
        },
        ConsistentRead: true,
      }),
    );
    const value = result.Item?.["value"] as BettingSplitObservation | undefined;
    if (!value || value.canonicalEventVersion !== key.canonicalEventVersion)
      return null;
    return normalizeBettingSplitObservation(value);
  }

  async listCurrent(canonicalEventId: string, canonicalEventVersion?: number) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :current)",
        ExpressionAttributeValues: {
          ":pk": splitPk(canonicalEventId),
          ":current": "CURRENT#",
        },
        ConsistentRead: true,
      }),
    );
    return latestLogicalCurrent(
      (result.Items ?? []).map((item) =>
        normalizeBettingSplitObservation(
          item["value"] as BettingSplitObservation,
        ),
      ),
      canonicalEventVersion,
    );
  }

  async persistGap(input: Parameters<BettingSplitRepository["persistGap"]>[0]) {
    const digest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `BETTING_SPLIT_GAP#${input.providerId}#${input.providerEventId}`,
            sk: `${input.retrievedAt}#${digest}`,
            value: input,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
    }
  }
}
