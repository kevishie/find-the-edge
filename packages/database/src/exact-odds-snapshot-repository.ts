import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { NormalizedFixtureOddsSnapshot } from "@find-the-edge/domain";
import { FixtureOddsStateCorruptionError } from "@find-the-edge/domain";
import type { ClosingCandidate } from "./closing-odds-repository.js";
import { validateFixtureOddsSnapshotItem } from "./fixture-odds-adapter.js";
import { oddsHistoryPartition } from "./odds-history-repository.js";

const validateIndexedSnapshot = (
  value: unknown,
): NormalizedFixtureOddsSnapshot => {
  const candidate = value as NormalizedFixtureOddsSnapshot | undefined;
  if (!candidate)
    throw new FixtureOddsStateCorruptionError("snapshot-index-corrupt");
  const validated = validateFixtureOddsSnapshotItem(
    { pk: candidate.partitionKey, sk: candidate.sortKey, value: candidate },
    candidate.partitionKey,
    candidate.sortKey,
  );
  if (!validated)
    throw new FixtureOddsStateCorruptionError("snapshot-index-corrupt");
  return validated;
};

export interface ExactOddsSnapshotIndex {
  put(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
  prepare?(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
  commitHistory?(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
  get(snapshotId: string): Promise<ClosingCandidate | null>;
}

/** Immutable snapshot-id index for future writes. Missing legacy rows are explicitly unavailable. */
export class DynamoExactOddsSnapshotRepository implements ExactOddsSnapshotIndex {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async put(snapshot: NormalizedFixtureOddsSnapshot) {
    await this.prepare(snapshot);
    await this.commitHistory(snapshot);
  }
  async prepare(snapshot: NormalizedFixtureOddsSnapshot) {
    await this.putImmutable(
      "ODDS_SNAPSHOTS_BY_ID",
      snapshot.snapshotId,
      snapshot,
    );
  }
  async commitHistory(snapshot: NormalizedFixtureOddsSnapshot) {
    await this.putImmutable(
      oddsHistoryPartition(snapshot.canonicalEventId),
      snapshot.sortKey,
      snapshot,
    );
  }
  private async putImmutable(
    pk: string,
    sk: string,
    snapshot: NormalizedFixtureOddsSnapshot,
  ) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk,
            sk,
            value: snapshot,
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
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
          Key: { pk, sk },
          // Immutable snapshot replay must verify the winning stored record.
          ConsistentRead: true,
        }),
      );
      let validated: NormalizedFixtureOddsSnapshot;
      try {
        validated = validateIndexedSnapshot(existing.Item?.["value"]);
      } catch {
        throw new FixtureOddsStateCorruptionError("snapshot-index-conflict");
      }
      if (validated.snapshotId !== snapshot.snapshotId)
        throw new FixtureOddsStateCorruptionError("snapshot-index-conflict");
    }
  }
  async get(snapshotId: string): Promise<ClosingCandidate | null> {
    if (!/^[a-f0-9]{64}$/.test(snapshotId))
      throw new Error("snapshot-id-invalid");
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "ODDS_SNAPSHOTS_BY_ID", sk: snapshotId },
        // Closing evidence must resolve the exact authoritative snapshot.
        ConsistentRead: true,
      }),
    );
    if (!response.Item?.["value"]) return null;
    const value = validateIndexedSnapshot(response.Item["value"]);
    if (value.snapshotId !== snapshotId)
      throw new FixtureOddsStateCorruptionError("snapshot-index-corrupt");
    return {
      partitionKey: value.partitionKey,
      snapshotId: value.snapshotId,
      eventId: value.canonicalEventId,
      eventVersion: value.canonicalEventVersion,
      sportKey: value.sportKey,
      marketKey: value.marketKey,
      selectionKey: value.selectionKey,
      sportsbookId: value.sportsbookId,
      ...(value.point === undefined ? {} : { point: value.point }),
      americanOdds: value.americanOdds,
      observedAt: value.observedAt,
      state:
        value.provenance?.sourceState === "active" ? "active" : "suspended",
    };
  }
}
