import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { NormalizedFixtureOddsSnapshot } from "@find-the-edge/domain";
import type { ClosingCandidate } from "./closing-odds-repository.js";

export interface ExactOddsSnapshotIndex {
  put(snapshot: NormalizedFixtureOddsSnapshot): Promise<void>;
  get(snapshotId: string): Promise<ClosingCandidate | null>;
}

/** Immutable snapshot-id index for future writes. Missing legacy rows are explicitly unavailable. */
export class DynamoExactOddsSnapshotRepository implements ExactOddsSnapshotIndex {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async put(snapshot: NormalizedFixtureOddsSnapshot) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: "ODDS_SNAPSHOTS_BY_ID",
            sk: snapshot.snapshotId,
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
          Key: { pk: "ODDS_SNAPSHOTS_BY_ID", sk: snapshot.snapshotId },
          ConsistentRead: true,
        }),
      );
      if (JSON.stringify(existing.Item?.["value"]) !== JSON.stringify(snapshot))
        throw new Error("snapshot-index-conflict");
    }
  }
  async get(snapshotId: string): Promise<ClosingCandidate | null> {
    if (!/^[a-f0-9]{64}$/.test(snapshotId))
      throw new Error("snapshot-id-invalid");
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "ODDS_SNAPSHOTS_BY_ID", sk: snapshotId },
        ConsistentRead: true,
      }),
    );
    const value = response.Item?.["value"] as
      NormalizedFixtureOddsSnapshot | undefined;
    if (!value) return null;
    if (value.snapshotId !== snapshotId)
      throw new Error("snapshot-index-corrupt");
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
        value.provenance?.sourceState === "suspended" ? "suspended" : "active",
    };
  }
}
