import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { NormalizedFixtureOddsSnapshot } from "@find-the-edge/domain";
import type { ClosingCandidate } from "./closing-odds-repository.js";

export class DynamoClosingCandidateSource {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async list(input: {
    readonly opening: ClosingCandidate;
    readonly from: string;
    readonly to: string;
    readonly limit: number;
  }) {
    if (!input.opening.partitionKey) return [];
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("closing-candidate-limit-invalid");
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": input.opening.partitionKey,
          ":from": `SNAPSHOT#${input.from}`,
          ":to": `SNAPSHOT#${input.to}#~`,
        },
        Limit: input.limit,
        // Closing-line selection becomes durable performance evidence.
        ConsistentRead: true,
        ScanIndexForward: false,
      }),
    );
    return (response.Items ?? []).map((item): ClosingCandidate => {
      const value = item["value"] as NormalizedFixtureOddsSnapshot;
      if (!value || value.partitionKey !== input.opening.partitionKey)
        throw new Error("closing-candidate-corrupt");
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
          value.provenance?.sourceState === "suspended"
            ? "suspended"
            : "active",
      };
    });
  }
}
