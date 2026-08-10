import type {
  FixtureOddsAvailabilityEvidence,
  FixtureOddsObservation,
  FixtureOddsSnapshotDecision,
  FixtureOddsSnapshotRecordRead,
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
  readFixtureOddsSnapshotRecord,
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

/** Byte-for-byte equality, including `retrievedAt`. Used where both sides are
 * expected to be the same committed row round-tripped through normalization. */
const sameSnapshot = (
  left: NormalizedFixtureOddsSnapshot,
  right: NormalizedFixtureOddsSnapshot,
) =>
  JSON.stringify(snapshotObservation(left)) ===
    JSON.stringify(snapshotObservation(right)) &&
  left.partitionKey === right.partitionKey &&
  left.snapshotId === right.snapshotId &&
  left.sortKey === right.sortKey;

const withoutRetrievedAt = (observation: FixtureOddsObservation) => {
  const { retrievedAt, ...observedState } = observation;
  void retrievedAt;
  return observedState;
};

/**
 * Compares two independently derived snapshots by the OBSERVED MARKET STATE and
 * the derived keys, tolerating a differing `retrievedAt`.
 *
 * `retrievedAt` is our fetch clock and is deliberately excluded from snapshot
 * identity, so re-observing an unchanged price legitimately produces the same
 * snapshotId/sortKey with a later `retrievedAt`. Everything that DOES define the
 * observation — price, point, labels, provider observedAt, provenance — plus the
 * partition key, snapshot id, and sort key must still match exactly, so a
 * genuine content mismatch under one identity is still detected.
 */
/**
 * The quoted market state: what a book is actually offering, with BOTH clocks
 * removed. The provider stamps its feed with its own poll time, so two
 * consecutive observations of an unmoved price differ in `observedAt` (theirs)
 * and `retrievedAt` (ours) while quoting the identical price. Only a change to
 * one of these fields is a new price.
 */
const sameQuotedPrice = (
  left: NormalizedFixtureOddsSnapshot,
  right: NormalizedFixtureOddsSnapshot,
) =>
  left.partitionKey === right.partitionKey &&
  left.americanOdds === right.americanOdds &&
  (left.point ?? null) === (right.point ?? null) &&
  left.selectionLabel === right.selectionLabel &&
  left.sportsbookLabel === right.sportsbookLabel &&
  JSON.stringify(left.provenance ?? null) ===
    JSON.stringify(right.provenance ?? null);

const sameSnapshotIdentity = (
  left: NormalizedFixtureOddsSnapshot,
  right: NormalizedFixtureOddsSnapshot,
) =>
  JSON.stringify(withoutRetrievedAt(snapshotObservation(left))) ===
    JSON.stringify(withoutRetrievedAt(snapshotObservation(right))) &&
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
  ...(stored.provenance === undefined
    ? {}
    : {
        // DynamoDB maps are unordered. Rebuild provenance in canonical field
        // order before comparing normalized snapshot content.
        provenance: {
          providerId: stored.provenance.providerId,
          policyVersion: stored.provenance.policyVersion,
          bookRole: stored.provenance.bookRole,
          sourceState: stored.provenance.sourceState,
        },
      }),
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
  const stored = storedRecord as unknown as NormalizedFixtureOddsSnapshot;
  let authenticated: FixtureOddsSnapshotRecordRead | null;
  try {
    // Accepts the current identity, and — for verification only — rows committed
    // under the frozen legacy hash that included `retrievedAt`. Both must
    // reproduce the claimed snapshotId AND sortKey; nothing else is accepted.
    authenticated = readFixtureOddsSnapshotRecord(snapshotObservation(stored), {
      snapshotId: storedRecord["snapshotId"],
      sortKey: storedRecord["sortKey"],
    });
  } catch (error) {
    throw new FixtureOddsStateCorruptionError(
      `stored odds row is invalid: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const normalized = authenticated?.snapshot;
  if (
    normalized === undefined ||
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
      prepare?(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
      commitHistory?(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
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
    // Cost + correctness short-circuit. Snapshot identity is the observed market
    // state, so re-observing an unchanged price re-derives the same
    // snapshotId/sortKey and every write below becomes a no-op — but a
    // conditional Put that loses is still billed, and TransactWrite is billed at
    // double write capacity, so the transaction must not be issued at all rather
    // than relying on the conditional-loss recovery path to absorb it.
    //
    // The mapping and canonical-event ConditionChecks are deliberately not
    // evaluated here. They exist to stop us WRITING evidence under a stale event
    // binding; this path writes no evidence, and the row it returns was already
    // fenced when it was first committed. They also cannot be evaluated outside
    // a TransactWrite, which is precisely the cost being avoided. The local
    // pregame fence above still runs on every call.
    //
    // Any failure to read or validate CURRENT falls through to the full, fully
    // fenced write path — a persist must never fail because of an optimization.
    let publishedCurrent: NormalizedFixtureOddsSnapshot | null = null;
    try {
      publishedCurrent = validateFixtureOddsCurrentItem(
        await this.gateway.getExact(snapshot.partitionKey, "CURRENT"),
        snapshot.partitionKey,
      );
    } catch {
      publishedCurrent = null;
    }
    if (publishedCurrent && sameQuotedPrice(publishedCurrent, snapshot)) {
      // The published price is unchanged, so this observation records nothing
      // new. Identity still carries the provider's `observedAt`, and the
      // provider stamps every poll with a fresh one, so comparing identities
      // here would never match and the immutable log would grow a row per poll
      // per book forever. The comparison that matters is the quote itself.
      //
      // History keeps its meaning: a price that moves away and later returns
      // still writes a row each time, because each observation is compared
      // against what is published at that moment, not against all history.
      // The exact-id and event-history mirrors are still reconciled. They are
      // conditional, idempotent, and are the ONLY repair path for a persist that
      // was interrupted after CURRENT advanced; skipping them here would make
      // such a gap permanent until the price next moves. They are reconciled
      // from the COMMITTED row so a mirror can never disagree with the primary.
      await this.prepareExactSnapshot(publishedCurrent);
      await this.commitExactSnapshotHistory(publishedCurrent);
      // `retrievedAt` stays at the first observation of this price on purpose:
      // that is when this price was actually first seen.
      return {
        snapshot: "existing",
        current: "retained",
        value: publishedCurrent,
      };
    }
    const mappingKey = mappingId({
      providerId: input.providerId,
      providerEventId: input.providerEventId,
      sportKey: snapshot.sportKey as never,
      leagueKey: input.leagueKey,
    });
    let snapshotDecision: FixtureOddsSnapshotDecision = "created";
    // The row that actually holds this identity in the immutable log. On a lost
    // create race we adopt the winner's row rather than our own in-memory copy,
    // so CURRENT, the mirrors, and the returned value stay byte-identical to the
    // committed evidence and `retrievedAt` always means "first seen".
    let committed = snapshot;
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
      // A concurrent writer may have committed this exact observation with its
      // own fetch clock; that is a replay, not a collision. Content under the
      // same identity must still match exactly.
      if (!sameSnapshotIdentity(existing, snapshot))
        throw new FixtureOddsStateCorruptionError(
          "snapshot identity maps to different content",
        );
      snapshotDecision = "existing";
      committed = existing;
    }

    // Establish the immutable snapshot-id identity before publication so an
    // identity conflict can never be discovered after CURRENT advances.
    await this.prepareExactSnapshot(committed);

    let current: "advanced" | "retained" = "advanced";
    try {
      await this.gateway.putCurrent({
        item: { pk: committed.partitionKey, sk: "CURRENT", value: committed },
        advanceAfter: {
          observedAt: committed.observedAt,
          snapshotId: committed.snapshotId,
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
      // Strict: every CURRENT writer publishes a byte-for-byte copy of the
      // committed immutable row (see `committed` above), so CURRENT can never
      // legitimately disagree with the row it references — not even on
      // `retrievedAt`.
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
        snapshotObservation(committed),
      );
      if (decision.current === "advanced")
        throw new FixtureOddsStorageError(
          "CURRENT conditional loss retained a non-winning value",
        );
      current = "retained";
    }
    if (this.gateway.putAvailability) {
      await this.persistAvailability({
        identity: committed.partitionKey,
        state: "active",
        observedAt: committed.observedAt,
        evidenceId: committed.snapshotId,
        reason: "active-price",
      });
    }
    // The event-scoped history row is a repairable mirror. Advance the live
    // projection first so a history outage cannot hold CURRENT back; a retry
    // revalidates the primary identity and repairs this mirror idempotently.
    await this.commitExactSnapshotHistory(committed);
    return { snapshot: snapshotDecision, current, value: committed };
  }

  private async prepareExactSnapshot(snapshot: NormalizedFixtureOddsSnapshot) {
    try {
      if (this.exactSnapshotIndex?.prepare)
        await this.exactSnapshotIndex.prepare(snapshot);
      else await this.exactSnapshotIndex?.put(snapshot);
    } catch (error) {
      if (error instanceof FixtureOddsStateCorruptionError) throw error;
      throw new FixtureOddsStorageError(
        "exact-snapshot-index-write-failed",
        error,
      );
    }
  }

  private async commitExactSnapshotHistory(
    snapshot: NormalizedFixtureOddsSnapshot,
  ) {
    try {
      await this.exactSnapshotIndex?.commitHistory?.(snapshot);
    } catch (error) {
      if (error instanceof FixtureOddsStateCorruptionError) throw error;
      throw new FixtureOddsStorageError(
        "exact-snapshot-index-write-failed",
        error,
      );
    }
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
