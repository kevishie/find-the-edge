import type {
  FixtureOddsAvailabilityEvidence,
  FixtureOddsObservation,
  FixtureOddsSnapshotDecision,
  NormalizedFixtureOddsSnapshot,
} from "@find-the-edge/domain";
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  FixtureOddsStateCorruptionError,
  fixtureOddsGroupAvailabilityIdentity,
  isFixtureOddsSnapshotActionable,
  normalizeFixtureOddsObservation,
  transitionFixtureOdds,
  transitionFixtureOddsAvailability,
} from "@find-the-edge/domain";
import { mappingId } from "./event-ingestion";

export interface FixtureOddsBinding {
  readonly providerId: string;
  readonly providerEventId: string;
  readonly leagueKey: string;
}

export interface FixtureOddsIngestInput extends FixtureOddsBinding {
  readonly observation: FixtureOddsObservation;
  readonly expectedStartsAt?: string;
  readonly expectedStatus?: "scheduled";
}

export interface FixtureOddsItem {
  readonly pk: string;
  readonly sk: string;
  readonly value: NormalizedFixtureOddsSnapshot;
}

export interface FixtureOddsConditionCheck {
  readonly key: { readonly pk: string; readonly sk: string };
  readonly expected: Readonly<Record<string, string | number>>;
}

export interface FixtureOddsSnapshotTransaction {
  readonly mapping: FixtureOddsConditionCheck;
  readonly canonicalEvent: FixtureOddsConditionCheck;
  readonly snapshot: FixtureOddsItem;
}

export interface FixtureOddsCurrentWrite {
  readonly item: FixtureOddsItem;
  readonly advanceAfter: {
    readonly observedAt: string;
    readonly snapshotId: string;
  };
}

export type FixtureOddsCancellationCode =
  | "None"
  | "ConditionalCheckFailed"
  | "TransactionConflict"
  | "ProvisionedThroughputExceeded"
  | "ThrottlingError"
  | "ValidationError"
  | "AccessDenied"
  | (string & {});

export class FixtureOddsTransactionCanceledError extends Error {
  override readonly name = "FixtureOddsTransactionCanceledError";
  constructor(
    readonly reasons: readonly {
      readonly code: FixtureOddsCancellationCode;
      readonly message?: string;
    }[],
  ) {
    super("fixture-odds-transaction-canceled");
  }
}

export class FixtureOddsBindingConflictError extends Error {
  override readonly name = "FixtureOddsBindingConflictError";
}

export class FixtureOddsStorageError extends Error {
  override readonly name = "FixtureOddsStorageError";
  constructor(
    message: string,
    readonly sourceError?: unknown,
  ) {
    super(message);
  }
}

export interface FixtureOddsDynamoGateway {
  /** Every read must be a strongly consistent, exact GetItem. */
  getExact(pk: string, sk: string): Promise<FixtureOddsItem | null>;
  transactSnapshot(request: FixtureOddsSnapshotTransaction): Promise<void>;
  putCurrent(request: FixtureOddsCurrentWrite): Promise<void>;
  getAvailability?(
    partitionKey: string,
  ): Promise<FixtureOddsAvailabilityEvidence | null>;
  putAvailability?(value: FixtureOddsAvailabilityEvidence): Promise<void>;
}

export class AwsFixtureOddsGateway implements FixtureOddsDynamoGateway {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}

  async getExact(pk: string, sk: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    return (result.Item as FixtureOddsItem | undefined) ?? null;
  }

  async transactSnapshot(request: FixtureOddsSnapshotTransaction) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            conditionItem(this.tableName, request.mapping),
            conditionItem(this.tableName, request.canonicalEvent),
            {
              Put: {
                TableName: this.tableName,
                Item: request.snapshot,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      throw translateTransactionCancellation(error);
    }
  }

  async putCurrent(request: FixtureOddsCurrentWrite) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: request.item,
          ConditionExpression:
            "attribute_not_exists(pk) OR #value.#observedAt < :observedAt OR (#value.#observedAt = :observedAt AND #value.#snapshotId < :snapshotId)",
          ExpressionAttributeNames: {
            "#value": "value",
            "#observedAt": "observedAt",
            "#snapshotId": "snapshotId",
          },
          ExpressionAttributeValues: {
            ":observedAt": request.advanceAfter.observedAt,
            ":snapshotId": request.advanceAfter.snapshotId,
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        throw new FixtureOddsTransactionCanceledError([
          { code: "ConditionalCheckFailed" },
        ]);
      throw error;
    }
  }

  async getAvailability(partitionKey: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partitionKey, sk: "AVAILABILITY" },
        ConsistentRead: true,
      }),
    );
    return (
      (result.Item?.["value"] as FixtureOddsAvailabilityEvidence | undefined) ??
      null
    );
  }

  async putAvailability(value: FixtureOddsAvailabilityEvidence) {
    const priority = value.state === "active" ? 0 : 1;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: value.identity,
            sk: "AVAILABILITY",
            value,
            availabilityPriority: priority,
          },
          ConditionExpression:
            "attribute_not_exists(pk) OR #v.#observedAt < :observedAt OR (#v.#observedAt = :observedAt AND (attribute_not_exists(#priority) OR #priority < :priority OR (#priority = :priority AND #v.#evidenceId < :evidenceId)))",
          ExpressionAttributeNames: {
            "#v": "value",
            "#observedAt": "observedAt",
            "#evidenceId": "evidenceId",
            "#priority": "availabilityPriority",
          },
          ExpressionAttributeValues: {
            ":observedAt": value.observedAt,
            ":evidenceId": value.evidenceId,
            ":priority": priority,
          },
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

function conditionItem(
  tableName: string,
  condition: FixtureOddsConditionCheck,
) {
  const entries = Object.entries(condition.expected);
  const names: Record<string, string> = { "#value": "value" };
  const values: Record<string, string | number> = {};
  entries.forEach(([field, value], index) => {
    names[`#field${index}`] = field;
    values[`:expected${index}`] = value;
  });
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: condition.key,
      ConditionExpression: entries
        .map(([,], index) => `#value.#field${index} = :expected${index}`)
        .join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

function translateTransactionCancellation(error: unknown): unknown {
  if (
    !(error instanceof Error) ||
    error.name !== "TransactionCanceledException"
  )
    return error;
  const reasons = (
    error as Error & {
      CancellationReasons?: readonly { Code?: string; Message?: string }[];
    }
  ).CancellationReasons;
  if (!reasons) return error;
  return new FixtureOddsTransactionCanceledError(
    reasons.map((reason) => ({
      code: reason.Code ?? "",
      ...(reason.Message === undefined ? {} : { message: reason.Message }),
    })),
  );
}

export interface FixtureOddsPersistResult {
  readonly snapshot: FixtureOddsSnapshotDecision;
  readonly current: "advanced" | "retained";
  readonly value: NormalizedFixtureOddsSnapshot;
}

const sameSnapshot = (
  left: NormalizedFixtureOddsSnapshot,
  right: NormalizedFixtureOddsSnapshot,
) =>
  JSON.stringify(snapshotObservation(left)) ===
    JSON.stringify(snapshotObservation(right)) &&
  left.partitionKey === right.partitionKey &&
  left.snapshotId === right.snapshotId &&
  left.sortKey === right.sortKey;

const snapshotObservation = (
  stored: NormalizedFixtureOddsSnapshot,
): FixtureOddsObservation => ({
  canonicalEventId: stored.canonicalEventId,
  canonicalEventVersion: stored.canonicalEventVersion,
  sportKey: stored.sportKey,
  marketKey: stored.marketKey,
  selectionKey: stored.selectionKey,
  ...(stored.selectionLabel === undefined
    ? {}
    : { selectionLabel: stored.selectionLabel }),
  sportsbookId: stored.sportsbookId,
  ...(stored.sportsbookLabel === undefined
    ? {}
    : { sportsbookLabel: stored.sportsbookLabel }),
  ...(stored.point === undefined ? {} : { point: stored.point }),
  americanOdds: stored.americanOdds,
  observedAt: stored.observedAt,
  retrievedAt: stored.retrievedAt,
  ...(stored.provenance === undefined ? {} : { provenance: stored.provenance }),
});

const conditionalOnlyAt = (
  error: FixtureOddsTransactionCanceledError,
  allowedIndices: readonly number[],
  expectedCount: number,
) => {
  if (error.reasons.length !== expectedCount) return false;
  let sawConditional = false;
  for (const [index, reason] of error.reasons.entries()) {
    if (reason.code === "None") continue;
    if (
      reason.code !== "ConditionalCheckFailed" ||
      !allowedIndices.includes(index)
    )
      return false;
    sawConditional = true;
  }
  return sawConditional;
};

const allConditionalOrNone = (
  error: FixtureOddsTransactionCanceledError,
  expectedCount: number,
) =>
  error.reasons.length === expectedCount &&
  error.reasons.every(
    ({ code }) => code === "None" || code === "ConditionalCheckFailed",
  );

const storageFailure = (error: unknown) =>
  error instanceof FixtureOddsStorageError
    ? error
    : new FixtureOddsStorageError("fixture-odds-storage-failure", error);

function validateStoredSnapshot(
  item: FixtureOddsItem | null,
  expectedPk: string,
  expectedSk: string,
): NormalizedFixtureOddsSnapshot | null {
  if (!item) return null;
  const row = capturePlainData(item, ["pk", "sk", "value"], "stored odds row");
  if (row["pk"] !== expectedPk || row["sk"] !== expectedSk)
    throw new FixtureOddsStateCorruptionError("exact read returned wrong key");
  const storedRecord = capturePlainData(
    row["value"],
    [
      "canonicalEventId",
      "canonicalEventVersion",
      "sportKey",
      "marketKey",
      "selectionKey",
      "sportsbookId",
      "americanOdds",
      "observedAt",
      "retrievedAt",
      "partitionKey",
      "snapshotId",
      "sortKey",
    ],
    "stored odds value",
    ["selectionLabel", "sportsbookLabel", "point", "provenance"],
  );
  let normalized: NormalizedFixtureOddsSnapshot;
  try {
    normalized = normalizeFixtureOddsObservation(
      snapshotObservation(
        storedRecord as unknown as NormalizedFixtureOddsSnapshot,
      ),
    );
  } catch (error) {
    throw new FixtureOddsStateCorruptionError(
      `stored odds row is invalid: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const stored = storedRecord as unknown as NormalizedFixtureOddsSnapshot;
  if (
    normalized.partitionKey !== expectedPk ||
    (expectedSk !== "CURRENT" && normalized.sortKey !== expectedSk) ||
    !sameSnapshot(normalized, stored)
  )
    throw new FixtureOddsStateCorruptionError("stored odds row is forged");
  return normalized;
}

/** Read-side validation for an exact CURRENT item; performs the full A1 replay check. */
export function validateFixtureOddsCurrentItem(
  item: FixtureOddsItem | null,
  expectedPartitionKey: string,
): NormalizedFixtureOddsSnapshot | null {
  return validateStoredSnapshot(item, expectedPartitionKey, "CURRENT");
}

/** Read-side validation for one exact immutable snapshot item. */
export function validateFixtureOddsSnapshotItem(
  item: FixtureOddsItem | null,
  expectedPartitionKey: string,
  expectedSortKey: string,
): NormalizedFixtureOddsSnapshot | null {
  if (expectedSortKey === "CURRENT")
    throw new FixtureOddsStateCorruptionError(
      "immutable snapshot sort key required",
    );
  return validateStoredSnapshot(item, expectedPartitionKey, expectedSortKey);
}

function capturePlainData(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new FixtureOddsStateCorruptionError(
      `${label} must be a plain object`,
    );
  let keys: readonly (string | symbol)[];
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new FixtureOddsStateCorruptionError(
        `${label} must be a plain object`,
      );
    keys = Reflect.ownKeys(value);
  } catch (error) {
    if (error instanceof FixtureOddsStateCorruptionError) throw error;
    throw new FixtureOddsStateCorruptionError(`${label} cannot be inspected`);
  }
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !keys.includes(key))
  )
    throw new FixtureOddsStateCorruptionError(`${label} has an invalid shape`);
  const captured: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    )
      throw new FixtureOddsStateCorruptionError(
        `${label}.${key} is not plain data`,
      );
    captured[key] = descriptor.value;
  }
  return captured;
}

export class DynamoFixtureOddsAdapter {
  constructor(
    readonly gateway: FixtureOddsDynamoGateway,
    private readonly exactSnapshotIndex?: {
      put(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
    },
  ) {}

  async persist(
    input: FixtureOddsIngestInput,
  ): Promise<FixtureOddsPersistResult> {
    const snapshot = normalizeFixtureOddsObservation(input.observation);
    if (
      input.expectedStatus !== undefined &&
      (input.expectedStatus !== "scheduled" ||
        input.expectedStartsAt === undefined ||
        Date.parse(snapshot.observedAt) >= Date.parse(input.expectedStartsAt) ||
        Date.parse(snapshot.retrievedAt) >= Date.parse(input.expectedStartsAt))
    )
      throw new FixtureOddsBindingConflictError(
        "fixture odds observation is not fenced to a scheduled pregame event",
      );
    const mappingKey = mappingId({
      providerId: input.providerId,
      providerEventId: input.providerEventId,
      sportKey: snapshot.sportKey as never,
      leagueKey: input.leagueKey,
    });
    let snapshotDecision: FixtureOddsSnapshotDecision = "created";
    try {
      await this.gateway.transactSnapshot({
        mapping: {
          key: { pk: `MAPPING#${mappingKey}`, sk: "CURRENT" },
          expected: {
            id: mappingKey,
            providerId: input.providerId,
            providerEventId: input.providerEventId,
            canonicalEventId: snapshot.canonicalEventId,
            sportKey: snapshot.sportKey,
            leagueKey: input.leagueKey,
          },
        },
        canonicalEvent: {
          key: { pk: `EVENT#${snapshot.canonicalEventId}`, sk: "CURRENT" },
          expected: {
            id: snapshot.canonicalEventId,
            version: snapshot.canonicalEventVersion,
            sportKey: snapshot.sportKey,
            leagueKey: input.leagueKey,
            ...(input.expectedStatus === undefined
              ? {}
              : {
                  status: input.expectedStatus,
                  startsAt: input.expectedStartsAt!,
                }),
          },
        },
        snapshot: {
          pk: snapshot.partitionKey,
          sk: snapshot.sortKey,
          value: snapshot,
        },
      });
    } catch (error) {
      if (!(error instanceof FixtureOddsTransactionCanceledError))
        throw storageFailure(error);
      if (
        allConditionalOrNone(error, 3) &&
        error.reasons.some(
          (reason, index) =>
            index < 2 && reason.code === "ConditionalCheckFailed",
        )
      )
        throw new FixtureOddsBindingConflictError(
          "fixture odds binding changed before snapshot commit",
        );
      if (!conditionalOnlyAt(error, [2], 3)) throw storageFailure(error);
      let recovered: FixtureOddsItem | null;
      try {
        recovered = await this.gateway.getExact(
          snapshot.partitionKey,
          snapshot.sortKey,
        );
      } catch (readError) {
        throw storageFailure(readError);
      }
      const existing = validateStoredSnapshot(
        recovered,
        snapshot.partitionKey,
        snapshot.sortKey,
      );
      if (!existing)
        throw new FixtureOddsBindingConflictError(
          "snapshot create lost but no committed snapshot is visible",
        );
      if (!sameSnapshot(existing, snapshot))
        throw new FixtureOddsStateCorruptionError(
          "snapshot identity maps to different content",
        );
      snapshotDecision = "existing";
    }

    try {
      await this.exactSnapshotIndex?.put(snapshot);
    } catch (error) {
      if (error instanceof FixtureOddsStateCorruptionError) throw error;
      throw new FixtureOddsStorageError(
        "exact-snapshot-index-write-failed",
        error,
      );
    }
    let current: "advanced" | "retained" = "advanced";
    try {
      await this.gateway.putCurrent({
        item: { pk: snapshot.partitionKey, sk: "CURRENT", value: snapshot },
        advanceAfter: {
          observedAt: snapshot.observedAt,
          snapshotId: snapshot.snapshotId,
        },
      });
    } catch (error) {
      if (
        !(error instanceof FixtureOddsTransactionCanceledError) ||
        !conditionalOnlyAt(error, [0], 1)
      )
        throw storageFailure(error);
      let currentItem: FixtureOddsItem | null;
      try {
        currentItem = await this.gateway.getExact(
          snapshot.partitionKey,
          "CURRENT",
        );
      } catch (readError) {
        throw storageFailure(readError);
      }
      const retained = validateStoredSnapshot(
        currentItem,
        snapshot.partitionKey,
        "CURRENT",
      );
      if (!retained)
        throw new FixtureOddsStorageError(
          "CURRENT condition lost without a winner",
        );
      let retainedSnapshotItem: FixtureOddsItem | null;
      try {
        retainedSnapshotItem = await this.gateway.getExact(
          retained.partitionKey,
          retained.sortKey,
        );
      } catch (readError) {
        throw storageFailure(readError);
      }
      const retainedSnapshot = validateStoredSnapshot(
        retainedSnapshotItem,
        retained.partitionKey,
        retained.sortKey,
      );
      if (!retainedSnapshot || !sameSnapshot(retainedSnapshot, retained))
        throw new FixtureOddsStateCorruptionError(
          "CURRENT does not reference its immutable snapshot",
        );
      const decision = transitionFixtureOdds(
        {
          partition: {
            canonicalEventId: retained.canonicalEventId,
            canonicalEventVersion: retained.canonicalEventVersion,
            sportKey: retained.sportKey,
            marketKey: retained.marketKey,
            selectionKey: retained.selectionKey,
            sportsbookId: retained.sportsbookId,
            key: retained.partitionKey,
          },
          snapshots: { [retained.snapshotId]: retained },
          currentSnapshotId: retained.snapshotId,
        },
        snapshotObservation(snapshot),
      );
      if (decision.current === "advanced")
        throw new FixtureOddsStorageError(
          "CURRENT conditional loss retained a non-winning value",
        );
      current = "retained";
    }
    if (this.gateway.putAvailability) {
      await this.persistAvailability({
        identity: snapshot.partitionKey,
        state: "active",
        observedAt: snapshot.observedAt,
        evidenceId: snapshot.snapshotId,
        reason: "active-price",
      });
    }
    return { snapshot: snapshotDecision, current, value: snapshot };
  }

  async persistAvailability(value: FixtureOddsAvailabilityEvidence) {
    if (!this.gateway.putAvailability)
      throw new Error("odds-availability-store-unavailable");
    const current = await this.gateway.getAvailability?.(value.identity);
    const winner = transitionFixtureOddsAvailability(
      current ?? undefined,
      value,
    );
    await this.gateway.putAvailability(winner);
    return winner;
  }

  async getActionableCurrent(partitionKey: string) {
    try {
      const item = await this.gateway.getExact(partitionKey, "CURRENT");
      const snapshot = validateStoredSnapshot(item, partitionKey, "CURRENT");
      if (!snapshot || !this.gateway.getAvailability) return null;
      const availability = await this.gateway.getAvailability(partitionKey);
      const groupAvailability = await this.gateway.getAvailability(
        fixtureOddsGroupAvailabilityIdentity(snapshot),
      );
      return isFixtureOddsSnapshotActionable(
        snapshot,
        availability ?? undefined,
        groupAvailability ?? undefined,
      )
        ? snapshot
        : null;
    } catch {
      return null;
    }
  }
}
